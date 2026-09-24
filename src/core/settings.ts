/**
 * clauctl's persisted settings: `<configDir>/settings.json`, a JSON object
 * read once per process (TUI startup, `format tree`). Component settings
 * are nested objects (`tree`). Unlike keybindings.json there is no in-TUI
 * editing surface yet (a `/settings` command is a planned follow-up —
 * docs/specs/tui-fullscreen.md, Non-goals), so this module is read-only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clauctlConfigDir } from "./config-dir.ts";

const TUI_MODES = ["regular", "fullscreen"] as const;
export type TuiMode = (typeof TUI_MODES)[number];

export interface TreeSettings {
  /** Right-align each row's approximate size in `format tree` and `/tree`. */
  showSizes: boolean;
}

export interface ClauctlSettings {
  tuiMode: TuiMode;
  /** Draw a rule between the transcript's resolved and pending parts (a
   *  debugging aid for the merge; see transcript.ts). */
  showResolvedBoundary: boolean;
  tree: TreeSettings;
}

const DEFAULT_SETTINGS: ClauctlSettings = {
  tuiMode: "fullscreen",
  showResolvedBoundary: false,
  tree: { showSizes: true },
};

function defaults(): ClauctlSettings {
  return { ...DEFAULT_SETTINGS, tree: { ...DEFAULT_SETTINGS.tree } };
}

/** <clauctlConfigDir()>/settings.json */
export function settingsPath(): string {
  return join(clauctlConfigDir(), "settings.json");
}

/**
 * Read + parse the settings file. Never throws; a missing file yields the
 * defaults silently, and every recoverable problem (unreadable/unparseable
 * file, non-object root, unknown key, bad value) yields the default for the
 * affected field(s) plus a warning — settings must never prevent startup.
 */
export function readSettings(path: string): {
  settings: ClauctlSettings;
  warnings: string[];
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: defaults(), warnings: [] };
    }
    return {
      settings: defaults(),
      warnings: [`cannot read ${path}: ${String(error)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      settings: defaults(),
      warnings: [`cannot parse ${path}: ${String(error)}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      settings: defaults(),
      warnings: [`${path}: root must be a JSON object`],
    };
  }
  const settings = defaults();
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "tuiMode") {
      if (TUI_MODES.includes(value as TuiMode)) {
        settings.tuiMode = value as TuiMode;
      } else {
        warnings.push(
          `"tuiMode": expected ${TUI_MODES.map((mode) => `"${mode}"`).join(" or ")} ` +
            `(got ${JSON.stringify(value)}; using "${DEFAULT_SETTINGS.tuiMode}")`,
        );
      }
    } else if (key === "showResolvedBoundary") {
      if (typeof value === "boolean") {
        settings.showResolvedBoundary = value;
      } else {
        warnings.push(
          `"showResolvedBoundary": expected a boolean (got ${JSON.stringify(value)}; ` +
            `using ${DEFAULT_SETTINGS.showResolvedBoundary})`,
        );
      }
    } else if (key === "tree") {
      const tree = readTreeSettings(value, warnings);
      settings.tree = tree;
    } else {
      warnings.push(`unknown setting "${key}" (ignored)`);
    }
  }
  return { settings, warnings };
}

function readTreeSettings(value: unknown, warnings: string[]): TreeSettings {
  const tree: TreeSettings = { ...DEFAULT_SETTINGS.tree };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push(`"tree": expected an object (got ${JSON.stringify(value)})`);
    return tree;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "showSizes") {
      if (typeof field === "boolean") {
        tree.showSizes = field;
      } else {
        warnings.push(
          `"tree.showSizes": expected a boolean (got ${JSON.stringify(field)}; ` +
            `using ${DEFAULT_SETTINGS.tree.showSizes})`,
        );
      }
    } else {
      warnings.push(`unknown setting "tree.${key}" (ignored)`);
    }
  }
  return tree;
}
