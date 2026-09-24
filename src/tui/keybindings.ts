/**
 * The clauctl keybinding registry: pi-tui's `KeybindingsManager` fed with
 * clauctl's action definitions and user overrides from
 * `<configDir>/keybindings.json` (pi's flat `actionId → key | key[]` schema,
 * so pi users feel at home). This module owns the definitions, the config
 * file's read/rewrite logic, and warning formatting; wiring the manager into
 * the TUI lives in interactive-mode.ts.
 *
 * The config file carries two metadata fields, both stripped from the
 * bindings on read: `default_bindings` (documents every action and its
 * default — JSON has no comments, so discoverability lives here) and
 * `replaced_default_bindings` (preservation area for drifted
 * `default_bindings` entries displaced by a `/keybindings` refresh).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clauctlConfigDir } from "../core/config-dir.ts";
import {
  TUI_KEYBINDINGS,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeybindingsManager,
  type KeyId,
} from "@earendil-works/pi-tui";

/**
 * Every app.* id clauctl dispatches on. All but `app.permissionMode.cycle`
 * (clauctl-specific: pi's shift+tab cycles thinking level instead) are also
 * declared by pi-coding-agent's identical Keybindings augmentation, but
 * that one reaches the typecheck only through whichever pi-coding-agent
 * import chain happens to be in the program — declaring them here keeps
 * this module self-sufficient.
 */
declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "app.interrupt": true;
    "app.clear": true;
    "app.detach": true;
    "app.tools.expand": true;
    "app.thinking.toggle": true;
    "app.permissionMode.cycle": true;
    "app.editor.external": true;
  }
}

/**
 * Definitions for every action the clauctl TUI dispatches on. Spreading
 * TUI_KEYBINDINGS is required: pi-tui's Editor and SelectList resolve their
 * `tui.*` ids against the global manager, and a definitions map missing them
 * would silently unbind every editor key.
 */
export const CLAUCTL_KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": {
    defaultKeys: "escape",
    description: "Interrupt the running agent",
  },
  "app.clear": {
    defaultKeys: "ctrl+c",
    description: "Clear the editor input",
  },
  "app.detach": {
    defaultKeys: "ctrl+]",
    description: "Detach from the agent (it keeps running)",
  },
  "app.tools.expand": {
    defaultKeys: "ctrl+o",
    description: "Toggle expanded tool output",
  },
  "app.thinking.toggle": {
    defaultKeys: "ctrl+t",
    description: "Toggle thinking blocks",
  },
  "app.permissionMode.cycle": {
    defaultKeys: "shift+tab",
    description: "Cycle permission mode",
  },
  "app.editor.external": {
    defaultKeys: "ctrl+g",
    description: "Edit the prompt in an external editor",
  },
} satisfies KeybindingDefinitions;

/** <clauctlConfigDir()>/keybindings.json */
export function keybindingsPath(): string {
  return join(clauctlConfigDir(), "keybindings.json");
}

const DEFAULT_BINDINGS_FIELD = "default_bindings";
const REPLACED_FIELD = "replaced_default_bindings";
const NOTE_KEY = "//";
const NOTE_TEXT =
  "Defaults for every action. To override one, move it to the top level " +
  "and edit it there; edits inside default_bindings are ignored.";

/**
 * Canonical id → default-keys map as written into default_bindings (single
 * key as string, multiple as array). Shared by writeDefaultBindings /
 * promoteEditedDefaults (serialization) and readKeybindingsConfig (drift
 * comparison).
 */
export function defaultBindings(
  definitions: KeybindingDefinitions,
): KeybindingsConfig {
  const result: KeybindingsConfig = {};
  for (const [id, definition] of Object.entries(definitions)) {
    const keys = definition.defaultKeys;
    result[id] = Array.isArray(keys) && keys.length === 1 ? keys[0]! : keys;
  }
  return result;
}

// pi-tui has no runtime key-id validator to reuse: its key set exists only
// in the compile-time KeyId union, and its internal parseKeyId accepts any
// base key (a typo like "ctrl+oo" parses and just never matches), so typo
// detection needs this well-formedness check of our own.
const BASE_KEYS = new Set<string>([
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  ..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
  ...["escape", "esc", "enter", "return", "tab", "space", "backspace"],
  ...["delete", "insert", "clear", "home", "end", "pageUp", "pageDown"],
  ...["up", "down", "left", "right"],
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

const MODIFIER_PREFIX = /^(ctrl|shift|alt|super)\+/;

/**
 * Conservative well-formedness check for a key string: zero or more known
 * modifiers followed by a known base key. Catches typos like "ctrl+oo";
 * full parse fidelity belongs to pi-tui's matchesKey.
 */
function isWellFormedKey(key: string): key is KeyId {
  let rest = key;
  while (true) {
    const match = MODIFIER_PREFIX.exec(rest);
    if (match === null) {
      break;
    }
    rest = rest.slice(match[0].length);
    if (rest === "") {
      return false;
    }
  }
  return BASE_KEYS.has(rest);
}

function isKeyList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Single-key-vs-array looseness: compare bindings as normalized key lists. */
function sameKeys(a: unknown, b: unknown): boolean {
  const listA = Array.isArray(a) ? a : [a];
  const listB = Array.isArray(b) ? b : [b];
  return (
    listA.length === listB.length &&
    listA.every((key, index) => key === listB[index])
  );
}

/**
 * default_bindings entries (note key exempt) that differ from the current
 * defaults — or ids the defaults no longer contain. Returns the drifted ids.
 */
function driftedDefaultIds(
  field: Record<string, unknown>,
  defaults: KeybindingsConfig,
): string[] {
  return Object.entries(field)
    .filter(
      ([id, value]) =>
        id !== NOTE_KEY &&
        (!(id in defaults) || !sameKeys(value, defaults[id])),
    )
    .map(([id]) => id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fatal = the file yields no bindings (parse failure, non-object root,
 *  unreadable). Recoverable problems are warnings on the ok side. */
export type KeybindingsRead =
  | { ok: true; bindings: KeybindingsConfig; warnings: string[] }
  | { ok: false; error: string };

/**
 * Read + parse user overrides. Never throws; a missing file is
 * `{ ok: true, bindings: {}, warnings: [] }`. Strips default_bindings
 * (drift there becomes a nudge warning — out-of-band drift is presumed a
 * stale snapshot, so the nudge must not imply self-healing) and
 * replaced_default_bindings (warns while non-empty).
 */
export function readKeybindingsConfig(
  path: string,
  definitions: KeybindingDefinitions,
): KeybindingsRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, bindings: {}, warnings: [] };
    }
    return { ok: false, error: `cannot read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `cannot parse ${path}: ${String(error)}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${path}: root must be a JSON object` };
  }
  const warnings: string[] = [];
  const bindings: KeybindingsConfig = {};
  const defaults = defaultBindings(definitions);
  for (const [id, value] of Object.entries(parsed)) {
    if (id === DEFAULT_BINDINGS_FIELD) {
      if (!isPlainObject(value)) {
        warnings.push(
          `${DEFAULT_BINDINGS_FIELD}: expected an object (ignored)`,
        );
      } else if (driftedDefaultIds(value, defaults).length > 0) {
        warnings.push(
          `${DEFAULT_BINDINGS_FIELD} differs from the current defaults. ` +
            "If you edited entries there, move them to the top level — " +
            "/keybindings replaces everything inside default_bindings. " +
            "If you upgraded clauctl, run /keybindings to refresh.",
        );
      }
      continue;
    }
    if (id === REPLACED_FIELD) {
      const empty = Array.isArray(value) && value.length === 0;
      if (!empty) {
        warnings.push(
          `${REPLACED_FIELD} holds entries displaced from ` +
            `${DEFAULT_BINDINGS_FIELD} by /keybindings; move any you meant ` +
            "as overrides to the top level, then delete the field",
        );
      }
      continue;
    }
    if (!(id in definitions)) {
      warnings.push(`unknown action id "${id}" (ignored)`);
      continue;
    }
    const keys =
      typeof value === "string" ? [value] : isKeyList(value) ? value : null;
    if (keys === null) {
      warnings.push(
        `"${id}": expected a key string or array of key strings (ignored)`,
      );
      continue;
    }
    const badKeys = keys.filter((key) => !isWellFormedKey(key));
    if (badKeys.length > 0) {
      warnings.push(
        `"${id}": unrecognized key ${badKeys
          .map((key) => `"${key}"`)
          .join(", ")} (ignored)`,
      );
      continue;
    }
    bindings[id] = value as KeyId | KeyId[];
  }
  return { ok: true, bindings, warnings };
}

/**
 * Read a JSON-object file for a rewrite. A missing file is an empty object;
 * anything else that does not parse to a plain object throws — clobbering
 * data we cannot parse is forbidden, so rewrites refuse to proceed.
 * (Generic in shape, but kept local: the closest relative, registry.ts's
 * agent.json I/O, is async and fsyncs for daemon durability — a shared
 * json-file helper is a follow-up once a third consumer exists.)
 */
function readJsonObjectFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${path}: root must be a JSON object`);
  }
  return parsed;
}

/** Atomic write: temp file in the same directory, rename over. */
function writeJsonFileAtomic(
  path: string,
  root: Record<string, unknown>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(root, null, 2)}\n`);
  renameSync(tempPath, path);
}

/**
 * Append `snapshots` to the replaced_default_bindings list, deduplicating
 * identical (id, value) snapshots by JSON identity. A malformed existing
 * field (non-array) is preserved as the list's first element rather than
 * destroyed.
 */
function appendReplacedSnapshots(
  root: Record<string, unknown>,
  snapshots: Record<string, unknown>[],
): void {
  if (snapshots.length === 0) {
    return;
  }
  const existing = root[REPLACED_FIELD];
  const list = Array.isArray(existing)
    ? [...existing]
    : existing === undefined
      ? []
      : [existing];
  const seen = new Set(list.map((item) => JSON.stringify(item)));
  for (const snapshot of snapshots) {
    const key = JSON.stringify(snapshot);
    if (!seen.has(key)) {
      seen.add(key);
      list.push(snapshot);
    }
  }
  if (list.length > 0) {
    root[REPLACED_FIELD] = list;
  }
}

/**
 * Atomically rewrite path's default_bindings field from `definitions`
 * (creating the file and parent dirs if missing), preserving top-level
 * entries and displacing drifted default_bindings entries into
 * replaced_default_bindings (append-only single-entry snapshots).
 * Throws on I/O errors and on an unparseable existing file (the caller
 * banners and still opens the editor — /keybindings is also the repair
 * tool).
 */
export function writeDefaultBindings(
  path: string,
  definitions: KeybindingDefinitions,
): void {
  const root = readJsonObjectFile(path);
  const defaults = defaultBindings(definitions);
  const existing = root[DEFAULT_BINDINGS_FIELD];
  if (isPlainObject(existing)) {
    appendReplacedSnapshots(
      root,
      driftedDefaultIds(existing, defaults).map((id) => ({
        [id]: existing[id],
      })),
    );
  }
  root[DEFAULT_BINDINGS_FIELD] = { [NOTE_KEY]: NOTE_TEXT, ...defaults };
  writeJsonFileAtomic(path, root);
}

/**
 * Post-editor pass: atomically move default_bindings entries that differ
 * from the current defaults to top-level overrides — after
 * writeDefaultBindings ran in the same /keybindings invocation, such drift
 * can only be a user edit (absent concurrent writers). Only called when
 * that refresh succeeded. Ids that already have a top-level entry keep it
 * (the deliberate override wins); the inner edit is dropped with a warning.
 * Throws on I/O errors and an unparseable file (caller banners, no reload).
 */
export function promoteEditedDefaults(
  path: string,
  definitions: KeybindingDefinitions,
): { warnings: string[] } {
  const root = readJsonObjectFile(path);
  const field = root[DEFAULT_BINDINGS_FIELD];
  if (!isPlainObject(field)) {
    return { warnings: [] };
  }
  const defaults = defaultBindings(definitions);
  const warnings: string[] = [];
  let changed = false;
  for (const id of driftedDefaultIds(field, defaults)) {
    const edited = field[id];
    // Restore the canonical default (or drop an id the defaults no longer
    // contain) so the drift does not re-trigger the stale-defaults nudge.
    if (id in defaults) {
      field[id] = defaults[id];
    } else {
      delete field[id];
    }
    changed = true;
    if (id in root) {
      warnings.push(
        `edit to "${id}" inside ${DEFAULT_BINDINGS_FIELD} dropped: the ` +
          "top-level entry wins",
      );
    } else {
      root[id] = edited;
      warnings.push(`"${id}" moved to a top-level override`);
    }
  }
  if (changed) {
    writeJsonFileAtomic(path, root);
  }
  return { warnings };
}

/** Format manager.getConflicts() as banner-ready warning strings. */
export function conflictWarnings(manager: KeybindingsManager): string[] {
  return manager
    .getConflicts()
    .map(
      (conflict) =>
        `key "${conflict.key}" is bound to multiple actions: ` +
        conflict.keybindings.join(", "),
    );
}
