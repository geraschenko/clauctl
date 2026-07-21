# Spec: TUI keybindings registry

> Status: **draft.** First of three planned phases (registry; then ctrl+g
> external editor; then ctrl+c clear-input) growing out of
> `docs/thoughts/open-editor.md`. Phasing is for review scoping only —
> the user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

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
a clauctl config file whose override entries use pi's schema (consistent
user experience).

### Success criteria

1. Every command chord the clauctl TUI dispatches on is declared in one
   definitions map (`CLAUCTL_KEYBINDINGS`) with an action id, default
   key(s), and description. (Text input into the tree selector's search —
   printable characters and backspace — is editing, not a command chord,
   and stays hard-coded.)
2. A user can remap any action — including pi-tui's built-in editor and
   select-list keys — by editing `keybindings.json` in the clauctl config
   dir; override entries use pi's schema (flat `actionId → key | key[]`).
3. `/keybindings` opens that file in `$VISUAL`/`$EDITOR` (TUI suspended) and
   applies it on exit; `/reload-keybindings` re-reads it in place. Both
   appear in slash-command autocomplete.
4. Config problems (unparseable file, malformed entries, unknown action
   ids, key conflicts among user overrides, `default_bindings` drift)
   surface as transcript banners — never silently ignored, never fatal to
   the TUI.
5. Key hints shown in the UI (the detach hint's "press ctrl+c again", the
   selectors' "esc to cancel", …) render the _resolved_ keys via
   `manager.getKeys()`, so they stay correct under remaps.
6. Default behavior is unchanged except one accepted change: **ctrl+c now
   acts as cancel in an open tree or model selector** (via
   `tui.select.cancel`, whose pi default is `["escape", "ctrl+c"]`).
   Cancel keeps the tree selector's existing two-stage semantics: clear a
   nonempty search first, close on the next press (ctrl+c and escape behave
   identically). This requires `handleGlobalKey` to defer its ctrl+c
   handling while a selector is open (the same guard escape already has) —
   the global listener runs before the focused component and would
   otherwise consume the key. Consequence: ctrl+c cannot detach while a
   selector is open (escape/ctrl+c closes it first).

### Config file

Location: `<configDir>/keybindings.json` where
`configDir = process.env.CLAUCTL_CONFIG_DIR ?? envPaths("clauctl", { suffix: "" }).config`.
This is clauctl's first _config_ dir — distinct from the `CLAUCTL_DIR` data
dir (`registry.ts`).

Override entries: pi's schema — action id → key string or array of key
strings. User keys **replace** the action's defaults entirely (pi
semantics, no merge); `[]` unbinds an action. Validation classes:

- **Recoverable** (warn, apply the rest): entry value of the wrong shape
  (not a string / all-string array); unknown action id (typo detection —
  deviates from pi's silent ignore); key string that does not parse as a
  key id.
- **Fatal** (the file yields no bindings): unreadable file other than
  ENOENT, JSON parse failure, non-object root (`null`, array, string,
  number). At startup, fatal falls back to defaults with a banner. On
  reload, fatal keeps the current live bindings with a banner — a
  temporary syntax error must not strip a working configuration.
- A missing file is an empty config (no warning).

Two clauctl extensions on top of pi's schema, both ignored on read
(stripped from the returned bindings, never passed to the manager): a
`default_bindings` metadata field documenting every available action and
its current default (JSON has no comments, so discoverability lives in
this field), and `replaced_default_bindings`, the preservation area for
displaced drifted entries (see below):

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

**Drift handling is timing-aware.** An entry inside `default_bindings` that
differs from the actual default is ambiguous in general: a user edit in the
wrong place, or a stale snapshot from an older clauctl whose defaults have
since changed. The `/keybindings` flow disambiguates by construction:

- **`/keybindings`** rewrites `default_bindings` from the current defaults
  _before_ opening the editor. Pre-existing drifted entries are never
  destroyed: they move into a second reserved metadata field,
  `replaced_default_bindings` — an append-only list of single-entry
  snapshots (`[{ "app.foo": "ctrl+x" }, { "app.foo": "ctrl+o" }]`), so
  repeated displacements of the same id never overwrite each other;
  identical (id, value) pairs are deduplicated. The preserved values are
  visible in the very editor session the user is about to enter — move
  them to the top level if they were edits, delete the field if they were
  stale. After the editor closes, any drift
  inside `default_bindings` can only be an edit the user just made —
  defaults cannot change mid-session (absent concurrent writers;
  cross-process coordination is a non-goal) — so those entries are
  **promoted** to top-level overrides. If the id already has a top-level
  entry, the top-level one wins (it is the deliberate override) and the
  inner edit is dropped with a warning. Promotion runs **only when the
  pre-editor refresh succeeded** — without that baseline, drift is not
  attributable to this session. Every fatal existing-file state (JSON
  parse failure, non-object root, unreadable file) skips the refresh and
  therefore disables promotion for that invocation.
- **Startup / `/reload-keybindings`** (file edited out-of-band): drift is
  presumed stale; no promotion, and the nudge banner must not imply
  self-healing: "default_bindings differs from the current defaults. If
  you edited entries there, move them to the top level — /keybindings
  replaces everything inside default_bindings. If you upgraded clauctl,
  run /keybindings to refresh." A non-empty `replaced_default_bindings`
  also warns on every read until the user removes it.

File rewrites (defaults refresh, promotion) are **atomic** (write to a temp
file in the same directory, rename over) and go through
parse → modify → stringify (2-space indent), so user formatting is
normalized; top-level user entries are preserved as JSON values. A missing
file is created as `{ "default_bindings": { ... } }`. An unparseable file
is never rewritten — clobbering data we cannot parse is forbidden.

### Command surface

Two new locally intercepted slash commands (matched on the first
whitespace-delimited token, like `/tree`; arguments are ignored), both
added to `LOCAL_COMMANDS` in `autocomplete.ts`:

- **`/keybindings`** — ensure the config dir and file exist and refresh
  `default_bindings`, displacing drifted entries into
  `replaced_default_bindings` (the refresh is skipped with a banner when
  the existing file is unparseable — the editor still opens, since
  `/keybindings` is also the repair tool); suspend the TUI; open the file
  in `$VISUAL ?? $EDITOR`; resume; promote post-editor drift (only if the
  refresh succeeded); reload. If neither env var is set: hint banner
  ("set $EDITOR to edit keybindings"), nothing else. If the editor exits
  nonzero: banner, no promotion, no reload (the defaults refresh already
  on disk is harmless). If the saved file is unparseable: banner, live
  bindings unchanged.
- **`/reload-keybindings`** — re-read the file and apply via
  `setUserBindings` on the existing manager instance (pi-tui components
  hold the same reference, so they see the change). Banner: warnings if
  any, else "keybindings reloaded". Fatal read: banner, live bindings
  unchanged.

### Action set

`CLAUCTL_KEYBINDINGS` = spread of pi-tui's `TUI_KEYBINDINGS` (required — a
definitions map missing `tui.*` ids would silently break every editor key)
plus:

| Action id                  | Default     | Bound now to                                                             |
| -------------------------- | ----------- | ------------------------------------------------------------------------ |
| `app.interrupt`            | `escape`    | interrupt (existing)                                                     |
| `app.clear`                | `ctrl+c`    | detach double-press (existing; the clear-input half is phase 3) |
| `app.tools.expand`         | `ctrl+o`    | toggle tool output (existing)                                            |
| `app.thinking.toggle`      | `ctrl+t`    | toggle thinking blocks (existing)                                        |
| `app.permissionMode.cycle` | `shift+tab` | cycle permission mode (existing)                                         |
| `app.editor.external`      | `ctrl+g`    | _declared, not handled until phase 2_                                   |

Ids reuse pi's names where the meaning matches (portable user configs);
`app.permissionMode.cycle` is clauctl-specific (pi's shift+tab means
thinking-level cycle — different semantics, different id). `app.clear` in
pi means "clear editor (double press: exit)"; in this phase it carries
only the detach double-press, and phase 3 adds the clear-input
half, converging on pi's meaning — a deliberate one-phase transition, not
a semantic fork. Only `app.permissionMode.cycle` needs a `declare module`
augmentation of pi-tui's `Keybindings` interface; the other `app.*` ids are
already merged in by pi-coding-agent, which clauctl compiles against.

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

/** Fatal = the file yields no bindings (parse failure, non-object root,
 *  unreadable). Recoverable problems are warnings on the ok side. */
export type KeybindingsRead =
  | { ok: true; bindings: KeybindingsConfig; warnings: string[] }
  | { ok: false; error: string };

/**
 * Read + parse user overrides. Never throws; a missing file is
 * `{ ok: true, bindings: {}, warnings: [] }`. Strips default_bindings
 * (drift there becomes a nudge warning) and replaced_default_bindings
 * (warns while non-empty). `definitions` supplies the defaults for drift
 * detection and the id set for unknown-id warnings.
 */
export function readKeybindingsConfig(
  path: string,
  definitions: KeybindingDefinitions,
): KeybindingsRead;

/**
 * Atomically rewrite path's default_bindings field from `definitions`
 * (creating the file and parent dirs if missing), preserving top-level
 * entries and displacing drifted default_bindings entries into
 * replaced_default_bindings (append-only single-entry snapshots;
 * identical (id, value) pairs deduplicated).
 * Throws on I/O errors and on an unparseable existing file (clobbering
 * data we cannot parse is forbidden; the caller banners and still opens
 * the editor).
 */
export function writeDefaultBindings(
  path: string,
  definitions: KeybindingDefinitions,
): void;

/**
 * Post-editor pass: atomically move default_bindings entries that differ
 * from the current defaults to top-level overrides — after
 * writeDefaultBindings ran in the same /keybindings invocation, such
 * drift can only be a user edit (absent concurrent writers). Only called
 * when that refresh succeeded. Ids that already have a top-level entry
 * keep it (deliberate override wins); the inner edit is dropped with a
 * warning. Throws on I/O errors and an unparseable file (caller banners,
 * no reload).
 */
export function promoteEditedDefaults(
  path: string,
  definitions: KeybindingDefinitions,
): { warnings: string[] };

/**
 * Canonical id → default-keys map as written into default_bindings (single
 * key as string, multiple as array). Shared by writeDefaultBindings /
 * promoteEditedDefaults (serialization) and readKeybindingsConfig (drift
 * comparison).
 */
export function defaultBindings(
  definitions: KeybindingDefinitions,
): KeybindingsConfig;

/** Format manager.getConflicts() as banner-ready warning strings. */
export function conflictWarnings(manager: KeybindingsManager): string[];
```

New module `src/tui/external-editor.ts` (shared with the ctrl+g phase):

```ts
import type { TUI } from "@earendil-works/pi-tui";

/** $VISUAL ?? $EDITOR; undefined when neither is set. */
export function externalEditorCommand(): string | undefined;

/**
 * Suspend the TUI, run the editor on filePath (async spawn, stdio
 * inherit), resume and force a full re-render (editors use the alternate
 * screen) — resume runs in a finally, including on spawn errors. The
 * command is split on spaces (supports "code --wait"; quoted arguments and
 * paths with spaces are deliberately unsupported, matching pi). Returns
 * true when the editor exited 0.
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
selector. `submit()` gains the two command intercepts. Hint strings that
name keys are built from `this.keybindings.getKeys(id)` instead of
literals. `tree-selector.ts` routes up/down/pageUp/pageDown/enter through
`tui.select.up/down/pageUp/pageDown/confirm` and the escape branch through
`tui.select.cancel` (keeping its two-stage clear-search-then-close
behavior) via `getKeybindings()`; `backspace` (search editing) keeps
`matchesKey` — it is text editing, not a command chord.

### Data flow

- **Startup**: `runInteractive` reads the config file once →
  `KeybindingsManager` → `setKeybindings` global → pi-tui `Editor` /
  `SelectList` and clauctl dispatch sites all consult the same instance.
  Load warnings + conflicts flow into the `InteractiveMode` constructor and
  render as banners once the transcript exists.
- **`/keybindings`**: `submit()` → `openKeybindingsEditor` →
  `writeDefaultBindings` (skipped + banner if it throws on an unparseable
  file) → `editFileInExternalEditor` (TUI suspended) → on exit 0,
  `promoteEditedDefaults` (only if the refresh succeeded) →
  `reloadKeybindings`.
- **`/reload-keybindings`**: `submit()` → `reloadKeybindings` →
  `readKeybindingsConfig` → on ok, `manager.setUserBindings` (same instance
  mutated; no re-`setKeybindings` needed); on fatal, live bindings
  unchanged → banners.

### Edge cases

- Malformed `keybindings.json`: startup falls back to defaults; reload
  keeps the live bindings; `/keybindings` skips the defaults refresh but
  still opens the editor; nothing ever rewrites an unparseable file. All
  four banner.
- Key conflicts among user overrides: banner listing key + claimant
  actions (pi's manager semantics: all claimants keep the key). This check
  covers user-vs-user claims only; a user key colliding with another
  action's _default_ is not detected — cross-action collisions can be
  legitimate (escape serves both `app.interrupt` and `tui.select.cancel`
  in different contexts), so which binding fires is decided by the same
  dispatch order that governs today's hard-coded chords.
- `/keybindings` with no `$VISUAL`/`$EDITOR`: hint banner, nothing else.
- Editor exits nonzero or fails to spawn: banner, no promotion, no reload;
  the TUI always resumes (finally).
- Managed (shared-renderer) mode: the editor runs inside the daemon-owned
  pty with the daemon process's environment (`$EDITOR`, config path), and
  every attacher sees — and can type into — it, while the shared TUI is
  suspended for all of them. Accepted: consistent with the shared input
  box. Reloads apply per-TUI-process (the managed renderer is one
  process; a separately attached `_tui` has its own manager).
- `data` matching multiple actions after a user remap: dispatch order
  decides (global listener before focused component, branch order within
  each), same as today with hard-coded chords.

### Non-goals

- No file watching; reload is explicit (`/keybindings`, `/reload-keybindings`).
- No keybindings UI/help screen (the `default_bindings` field is the
  discoverability surface for now; it carries ids and keys, not
  descriptions).
- No cross-process coordination: concurrent clauctl TUIs share the file
  last-writer-wins, and one process's reload does not affect others.
- No legacy-name migration (pi has one; clauctl has no legacy users).
- ctrl+g external-editor action and ctrl+c clear-input behavior: defined in
  the action set, implemented in the two follow-up phases.
- Adopting more of pi's action set (model cycling, message copy, follow-up
  queueing, …): follow-up work — audit pi's `app.*` actions once the
  registry is in place.

## IMPLEMENTATION IDEAS

- Verified empirically: pi-coding-agent's `Keybindings` declaration merge
  reaches clauctl's typecheck through the existing pi-coding-agent import
  (`matches(data, "app.editor.external")` compiles today; `tsc --noEmit`
  exit 0 with a scratch file). Only `app.permissionMode.cycle` needs our
  own augmentation. Robustness option: have `keybindings.ts` import a type
  from pi-coding-agent itself so the augmentation dependency is local
  rather than riding on interactive-mode.ts's `initTheme` import.
- Ordering matters: `getKeybindings()` lazily caches a
  TUI_KEYBINDINGS-only fallback manager if called before
  `setKeybindings()` — so `runInteractive` must `setKeybindings` before
  constructing `InteractiveMode` (whose `Editor` consults the global at
  input time, and whose ctor reads `getKeybindings()`).
- pi reference points: `pi-tui/dist/keybindings.js` (manager, global,
  `TUI_KEYBINDINGS`), `pi-coding-agent/dist/core/keybindings.js` (app-level
  definitions, config-file subclass — we take the pattern, not the class:
  its `AppKeybindings` set and `getAgentDir()` config path are pi's),
  `pi-coding-agent` `interactive-mode.js` `openExternalEditor()` (the
  suspend/spawn/resume shape for `editFileInExternalEditor`, including the
  no-spawnSync-on-Windows rationale).
- `KeybindingsManager.rebuild` already ignores config keys not in
  definitions, so `default_bindings` needs no manager-level special case —
  only `readKeybindingsConfig` treats it specially (strip + drift nudge;
  the `"//"` note key inside it is exempt). Unknown-id warnings likewise
  live in `readKeybindingsConfig`, not the manager.
- Key-string validation: pi-tui's `keys.ts` is the reference for what
  parses; if it exports no standalone validator, a conservative
  well-formedness check (known modifiers + known key names) is enough —
  the goal is catching typos like `ctrl+oo`, not full fidelity.
- Drift detection compares normalized key lists (pi's single-key-vs-array
  looseness): `[...defaultKeys]` vs entry value, order-sensitive is fine
  since `/keybindings` writes them canonically.
- `writeDefaultBindings` writes the `"//"` note first, then
  `defaultBindings(definitions)` entries in definitions order. Atomic
  writes: `writeFileSync` to `<path>.tmp-<pid>` in the same directory,
  then `renameSync`.
- Key hints: `manager.getKeys(id)` returns the resolved chords;
  pi-coding-agent exports `keyHint`/`keyText` formatters worth inspecting
  before hand-rolling display strings.
- Config-dir resolution stays local (`clauctlConfigDir()`). A unified
  `clauctlPaths(): { data, config }` folding both `CLAUCTL_DIR` (registry.ts)
  and `CLAUCTL_CONFIG_DIR` is a possible follow-up refactor once a second
  config consumer exists; pulling registry.ts into this phase would expand
  scope.
- Local-command interception in `submit()` follows the `/tree` pattern
  (`/^\/keybindings(\s|$)/` etc. on trimmed text); both ignore arguments.
- Tests should reset the global manager (`setKeybindings`) between cases —
  it is process-global state.
- Tests (`node --test` + `node:assert/strict`, colocated `.test.ts` per
  repo convention — see `autocomplete.test.ts`; run via `npm test`,
  full gate via `npm run presubmit`):
  `readKeybindingsConfig` (missing file, parse error, non-object root,
  malformed entry, unknown id, bad key string, drift nudge, valid
  overrides, `[]` unbind, replaced_default_bindings warning),
  `writeDefaultBindings` (fresh file, preserves user entries, displaces
  drift into replaced_default_bindings with merge, throws on unparseable,
  atomicity by inspection), `promoteEditedDefaults` (promotes edits,
  top-level wins with warning, stale-defaults scenario handled by the
  preceding refresh),
  `conflictWarnings`, command-intercept parse tests if
  `interactive-mode.test.ts` has precedent.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-21: reviewer pass (agent 0b5d9a86) on the draft; accepted:
  malformed-file repair path, last-known-good on fatal reload, fatal vs
  recoverable read classes, atomic writes, two-stage cancel for the tree
  selector, resolved-key hints, unknown-id/bad-key warnings, language
  fixes, managed-mode expansion. Rejected: `app.detach` rename (app.clear
  converges on pi's meaning by phase 3), separate search-clear action,
  disabling /keybindings in managed mode, cross-process coordination.
  Promotion ambiguity resolved by timing (Anton): /keybindings refreshes
  defaults before the editor opens, so post-editor drift is always a user
  edit; out-of-band drift is presumed stale, nudge only.
- 2026-07-21: reviewer round 2: promotion gated on successful baseline
  refresh; pre-editor drift preserved in `replaced_default_bindings`
  (reviewer's variant — avoids both the misplaced-edit loss path and the
  upgrade-refresh deadlock of skip-refresh-on-drift); nudge wording no
  longer implies self-healing; concurrent-writer qualifier added.
- 2026-07-21: reviewer round 3: replaced_default_bindings specified as
  append-only single-entry snapshots with (id, value) dedupe (object merge
  would collide on repeated displacement of one id); all fatal file states
  skip refresh → disable promotion. Reviewer approved; archived.
- [ ] `src/tui/keybindings.ts` (+ tests)
- [ ] `src/tui/external-editor.ts`
- [ ] Wire manager in `runInteractive`; banner warnings
- [ ] `handleGlobalKey` → action ids; hints via `getKeys`
- [ ] `tree-selector.ts` → `tui.select.*`
- [ ] `/keybindings`, `/reload-keybindings` + autocomplete entries
- [ ] typecheck, tests, manual TUI verification
- [ ] (phase 2, when ctrl+g lands) move `docs/thoughts/open-editor.md` to
      `docs/thoughts/old/`
