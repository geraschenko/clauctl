# Spec: TUI keybindings registry

> Status: **draft.** First of three planned commits (registry; then ctrl+g
> external editor; then ctrl+c clear-input) growing out of
> `docs/thoughts/open-editor.md`.

## SPEC (stable requirements)

### Problem

The TUI hard-codes key chords at every dispatch site
(`matchesKey(data, "ctrl+o")` in `interactive-mode.ts`'s `handleGlobalKey`,
plain chords in `tree-selector.ts`). There is no single place to see what
bindings exist, no way for a user to remap them, and upcoming features
(external editor, clear-input) would add more hard-coded chords.

pi has already solved this: pi-tui exports `KeybindingsManager` — a registry
mapping semantic action ids (`"app.editor.external"`) to default keys with
user overrides — and pi-tui's own `Editor` and `SelectList` consult the
global `getKeybindings()` manager for their `tui.editor.*` / `tui.input.*` /
`tui.select.*` bindings. Adopt that system, with clauctl's own action set and
a clauctl config file using pi's override schema (consistent user
experience).

### Success criteria

1. Every key the clauctl TUI dispatches on is declared in one definitions
   map (`CLAUCTL_KEYBINDINGS`) with an action id, default key(s), and
   description.
2. A user can remap any action — including pi-tui's built-in editor and
   select-list keys — by editing `keybindings.json` in the clauctl config
   dir; the file uses pi's schema (flat `actionId → key | key[]`).
3. `/keybindings` opens that file in `$VISUAL`/`$EDITOR` (TUI suspended) and
   applies it on exit; `/reload-keybindings` re-reads it in place. Both
   appear in slash-command autocomplete.
4. Config problems (unparseable file, malformed entries, key conflicts,
   edits inside `default_bindings`) surface as transcript banners — never
   silently ignored, never fatal.
5. Default behavior is unchanged except one accepted change: **ctrl+c now
   cancels an open tree or model selector** (via `tui.select.cancel`, whose
   pi default is `["escape", "ctrl+c"]`). This requires `handleGlobalKey`
   to defer its ctrl+c handling while a selector is open (the same guard
   escape already has) — the global listener runs before the focused
   component and would otherwise consume the key. Consequence: ctrl+c
   cannot detach while a selector is open (escape closes it first).

### Config file

Location: `<configDir>/keybindings.json` where
`configDir = process.env.CLAUCTL_CONFIG_DIR ?? envPaths("clauctl", { suffix: "" }).config`.
This is clauctl's first *config* dir — distinct from the `CLAUCTL_DIR` data
dir (`registry.ts`).

Schema: pi's — a flat JSON object, action id → key string or array of key
strings. User keys **replace** the action's defaults entirely (pi semantics,
no merge). Unknown action ids are ignored by the manager; entries whose
value is not a string/string-array are dropped with a warning.

One clauctl extension: a `default_bindings` field, ignored on read
(stripped from the returned bindings, never passed to the manager),
auto-(re)written by `/keybindings` before the editor opens. It documents
every available action and its current default (JSON has no comments, so
discoverability lives in this field):

```json
{
  "app.tools.expand": "ctrl+e",

  "default_bindings": {
    "//": "Defaults for every action. To override one, move it to the top level and edit it there; edits inside default_bindings are ignored.",
    "app.interrupt": "escape",
    "app.clear": "ctrl+c",
    "tui.editor.undo": "ctrl+-",
    "...": "..."
  }
}
```

Hazard mitigation: an entry inside `default_bindings` that differs from the
actual default is a user edit in the wrong place — it does nothing and the
next `/keybindings` would overwrite it. Reading warns about such entries
("edit inside default_bindings is ignored — move it to the top level").

`/keybindings` rewrites the file (parse → replace `default_bindings` →
stringify, 2-space indent), so user formatting is normalized; top-level user
entries are preserved verbatim as values. A missing file is created as
`{ "default_bindings": { ... } }`.

### Command surface

Two new locally intercepted slash commands (exact-match on the first token,
like `/tree`), both added to `LOCAL_COMMANDS` in `autocomplete.ts`:

- **`/keybindings`** — ensure the config dir and file exist, rewrite
  `default_bindings`, suspend the TUI, open the file in
  `$VISUAL ?? $EDITOR`, resume, and reload the bindings. If neither env var
  is set: hint banner ("set $EDITOR to edit keybindings"), no file changes.
  If the editor exits nonzero: no reload (banner notes it).
- **`/reload-keybindings`** — re-read the file and apply via
  `setUserBindings` on the existing manager instance (pi-tui components
  hold the same reference, so they see the change). Banner: warnings if
  any, else "keybindings reloaded".

### Action set

`CLAUCTL_KEYBINDINGS` = spread of pi-tui's `TUI_KEYBINDINGS` (required — a
definitions map missing `tui.*` ids would silently break every editor key)
plus:

| Action id                  | Default     | Bound now to                          |
| -------------------------- | ----------- | ------------------------------------- |
| `app.interrupt`            | `escape`    | interrupt (existing)                  |
| `app.clear`                | `ctrl+c`    | detach double-press (existing; the clear-input half is the third commit) |
| `app.tools.expand`         | `ctrl+o`    | toggle tool output (existing)         |
| `app.thinking.toggle`      | `ctrl+t`    | toggle thinking blocks (existing)     |
| `app.permissionMode.cycle` | `shift+tab` | cycle permission mode (existing)      |
| `app.editor.external`      | `ctrl+g`    | *defined but unbound* (second commit) |

Ids reuse pi's names where the meaning matches (portable user configs);
`app.permissionMode.cycle` is clauctl-specific (pi's shift+tab means
thinking-level cycle — different semantics, different id). Only
`app.permissionMode.cycle` needs a `declare module` augmentation of pi-tui's
`Keybindings` interface; the other `app.*` ids are already merged in by
pi-coding-agent, which clauctl compiles against.

### Type design

New module `src/tui/keybindings.ts`:

```ts
import type {
  KeybindingDefinitions,
  KeybindingsConfig,
  KeybindingsManager,
} from "@earendil-works/pi-tui";

declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "app.permissionMode.cycle": true;
  }
}

/** Definitions for every action the clauctl TUI dispatches on. */
export const CLAUCTL_KEYBINDINGS: KeybindingDefinitions; // literal, spreads TUI_KEYBINDINGS

/** $CLAUCTL_CONFIG_DIR ?? envPaths("clauctl", { suffix: "" }).config */
export function clauctlConfigDir(): string;

/** <clauctlConfigDir()>/keybindings.json */
export function keybindingsPath(): string;

/**
 * Read + parse user overrides. Never throws: a missing file is `{}`; parse
 * errors, malformed entries, and default_bindings drift come back as
 * warnings. `definitions` supplies the defaults for drift detection.
 */
export function readKeybindingsConfig(
  path: string,
  definitions: KeybindingDefinitions,
): { bindings: KeybindingsConfig; warnings: string[] };

/**
 * Rewrite path's default_bindings field from `definitions` (creating the
 * file and parent dirs if missing), preserving top-level user entries.
 * Throws on I/O errors and on an unparseable existing file (the caller
 * banners; overwriting a file we cannot parse would destroy user data).
 */
export function writeDefaultBindings(
  path: string,
  definitions: KeybindingDefinitions,
): void;

/** Format manager.getConflicts() as banner-ready warning strings. */
export function conflictWarnings(manager: KeybindingsManager): string[];
```

New module `src/tui/external-editor.ts` (shared with the ctrl+g commit):

```ts
import type { TUI } from "@earendil-works/pi-tui";

/** $VISUAL ?? $EDITOR; undefined when neither is set. */
export function externalEditorCommand(): string | undefined;

/**
 * Suspend the TUI, run the editor on filePath (command split on spaces to
 * support "code --wait"; async spawn, stdio inherit), resume and force a
 * full re-render (editors use the alternate screen). Returns true when the
 * editor exited 0.
 */
export function editFileInExternalEditor(
  ui: TUI,
  editorCommand: string,
  filePath: string,
): Promise<boolean>;
```

`interactive-mode.ts`:

```ts
// runInteractive, before constructing InteractiveMode:
//   readKeybindingsConfig → new KeybindingsManager(CLAUCTL_KEYBINDINGS, bindings)
//   → setKeybindings(manager); warnings + conflictWarnings passed to the ctor.
class InteractiveMode {
  private readonly keybindings: KeybindingsManager; // getKeybindings() in ctor
  constructor(/* existing args */, keybindingWarnings: string[]); // banners them
  private openKeybindingsEditor(): Promise<void>; // /keybindings
  private reloadKeybindings(): void; // /reload-keybindings; also called by openKeybindingsEditor
}
```

`handleGlobalKey` switches each `matchesKey(data, "<chord>")` to
`this.keybindings.matches(data, "<action id>")`, and its `app.clear`
(ctrl+c) branch gains the no-open-selector guard that the `app.interrupt`
(escape) branch already has, so `tui.select.cancel` can reach a focused
selector. `submit()` gains the two
exact-match command intercepts. `tree-selector.ts` routes
up/down/pageUp/pageDown/enter/escape through `tui.select.*` ids via
`getKeybindings()`; `backspace` (search editing) keeps `matchesKey` — no
`tui.*` id exists for it.

### Data flow

- **Startup**: `runInteractive` reads the config file once →
  `KeybindingsManager` → `setKeybindings` global → pi-tui `Editor` /
  `SelectList` and clauctl dispatch sites all consult the same instance.
  Load warnings + conflicts flow into the `InteractiveMode` constructor and
  render as banners once the transcript exists.
- **`/keybindings`**: `submit()` → `openKeybindingsEditor` →
  `writeDefaultBindings` → `editFileInExternalEditor` (TUI suspended) → on
  exit 0, `reloadKeybindings`.
- **`/reload-keybindings`**: `submit()` → `reloadKeybindings` →
  `readKeybindingsConfig` → `manager.setUserBindings` (same instance
  mutated; no re-`setKeybindings` needed) → banners.

### Edge cases

- Malformed `keybindings.json` at startup or reload: bindings fall back to
  defaults, banner explains. `/keybindings` on an unparseable file: banner,
  file untouched (never clobber unparseable user data).
- Key conflicts among user bindings: banner listing key + claimant actions
  (manager behavior is pi's: all claimants keep the key; first match in
  dispatch order wins).
- `/keybindings` with no `$VISUAL`/`$EDITOR`: hint banner, nothing else.
- Editor exits nonzero: banner, no reload.
- Managed (shared-renderer) mode: `/keybindings` works like any other
  editor-in-terminal — all attachers see it, consistent with the shared
  input box.
- `data` matching multiple actions after a user remap: dispatch order in
  `handleGlobalKey` decides, same as today with hard-coded chords.

### Non-goals

- No file watching; reload is explicit (`/keybindings`, `/reload-keybindings`).
- No keybindings UI/help screen (the `default_bindings` field is the
  discoverability surface for now).
- No legacy-name migration (pi has one; clauctl has no legacy users).
- ctrl+g external-editor action and ctrl+c clear-input behavior: defined in
  the action set, implemented in the two follow-up commits.

## IMPLEMENTATION IDEAS

- Verified empirically: pi-coding-agent's `Keybindings` declaration merge
  reaches clauctl's typecheck through the existing pi-coding-agent import
  (`matches(data, "app.editor.external")` compiles today; `tsc --noEmit`
  exit 0 with a scratch file). Only `app.permissionMode.cycle` needs our
  own augmentation.
- pi reference points: `pi-tui/dist/keybindings.js` (manager, global,
  `TUI_KEYBINDINGS`), `pi-coding-agent/dist/core/keybindings.js` (app-level
  definitions, config-file subclass — we take the pattern, not the class:
  its `AppKeybindings` set and `getAgentDir()` config path are pi's),
  `pi-coding-agent` `interactive-mode.js` `openExternalEditor()` (the
  suspend/spawn/resume shape for `editFileInExternalEditor`, including the
  no-spawnSync-on-Windows rationale).
- `KeybindingsManager.rebuild` already ignores config keys not in
  definitions, so `default_bindings` needs no manager-level special case —
  only `readKeybindingsConfig`'s warning pass treats it specially (skip the
  unknown-shape warning, run drift detection instead; the `"//"` note key
  inside it is exempt from drift detection).
- `readKeybindingsConfig` shape validation mirrors pi's
  `toKeybindingsConfig` (string or all-string array) but warns instead of
  silently dropping.
- Drift detection compares normalized key lists (pi's single-key-vs-array
  looseness): `[...defaultKeys]` vs entry value, order-sensitive is fine
  since `/keybindings` writes them canonically.
- `writeDefaultBindings` serializes single-key defaults as strings,
  multi-key as arrays (matching `TUI_KEYBINDINGS` literal shapes), with the
  `"//"` note first, then action ids in definitions order.
- Local-command interception in `submit()` follows the `/tree` pattern
  (`/^\/keybindings(\s|$)/` etc. on trimmed text); both ignore arguments.
- Tests (vitest, colocated `.test.ts` per repo convention):
  `readKeybindingsConfig` (missing file, parse error, malformed entry,
  drift warning, valid overrides), `writeDefaultBindings` (fresh file,
  preserves user entries, throws on unparseable), `conflictWarnings`,
  `parse`-level intercept tests for the two commands if
  `interactive-mode.test.ts` has precedent.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [ ] `src/tui/keybindings.ts` (+ tests)
- [ ] `src/tui/external-editor.ts`
- [ ] Wire manager in `runInteractive`; banner warnings
- [ ] `handleGlobalKey` → action ids
- [ ] `tree-selector.ts` → `tui.select.*`
- [ ] `/keybindings`, `/reload-keybindings` + autocomplete entries
- [ ] typecheck, tests, manual TUI verification
