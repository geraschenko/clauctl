# Spec: TUI input features — slash commands, completion, @-files, permission mode

> Status: **implemented.** Builds on `docs/specs/tui.md` (phase 3): the TUI is a pure
> `sdk.sock` client. This phase adds the input-side affordances: a completion
> popup for slash commands (including skills) and `@` file insertion, a local
> `/model` command, and permission-mode display + cycling.

## SPEC (stable requirements)

### Problem statement

The phase-3 TUI has a bare editor: no way to discover or complete the agent's
slash commands and skills, no way to insert file paths, no way to see or change
the permission mode or model interactively, and no context-usage view. Bring
the input experience to parity with `claude` for these features.

### Requirements

**Slash-command completion**

- Typing `/` at the start of the input opens a completion popup listing the
  agent's commands (the SDK's `supportedCommands()` — includes skills), each
  showing name, argument hint, and description, fuzzy-filtered as the user
  types. Arrow keys navigate; Tab applies; Enter applies and submits; Esc
  cancels. (All popup mechanics come from pi-tui's `Editor` +
  `CombinedAutocompleteProvider`.)
- The command list is fetched once at TUI startup via the existing
  `initialization-result` read, and **replaced** whenever a
  `system/commands_changed` message arrives (the SDK never updates the
  initialize-time list in place).
- Our local command `/model` appears in the popup too, shadowing a same-named
  entry from the SDK list. SDK command `aliases` are ignored for completion
  (pi-tui's `SlashCommand` has no alias concept; a typed alias still works —
  the CLI resolves it, and local interception happens at submit time
  regardless of the completion list).
- Submitting any slash command other than the locally intercepted `/model`
  sends it to the agent as ordinary query text — the claude CLI processes
  slash commands in user input. In particular `/context` needs no local
  implementation: the CLI executes it and its own rendering comes back (see
  next bullet); verified out of the box. The daemon's existing `/compact`
  special-case is unchanged.
- Output of local CLI commands arrives as `system/local_command_output`
  messages; the TUI renders their `content` in the transcript as plain `Text`
  (no markdown; any embedded ANSI passes through).

**`@` file insertion**

- Typing `@` opens a file-completion popup over the **agent's cwd** (not the
  TUI process's cwd): fd enumerates files/dirs (respecting .gitignore), results
  are ranked, selection inserts `@path/to/file` (quoted when the path contains
  spaces; directories insert without a trailing space so completion can
  continue). All of this is pi-tui's `CombinedAutocompleteProvider` behavior.
- fd is located by PATH lookup only — `fd`, then `fdfind` (Debian). **No
  auto-download.** If fd is absent and the user triggers `@` completion, show a
  one-time advisory hint on the existing hint line (e.g. "install fd for @ file
  completion"); otherwise `@` simply produces no popup.

**`/model`**

- Submitting `/model` (bare) opens an interactive menu built on pi-tui's
  `SelectList`, listing `supported-models` (display name + description),
  fetched fresh on each open. Selecting sends
  `{ type: "set-model", model: selected.value }` (the `ModelInfo.value` API
  identifier, not the display name); Esc cancels. The footer model indicator
  updates via the resulting `controlApplied` event (no optimistic local
  update).
- Submitting `/model <arg>` sends `set-model` with `<arg>` — the trimmed
  remainder after the command token, verbatim — directly (claude parity), no
  menu.
- The menu takes keyboard focus while open and returns it to the editor on
  select/cancel.
- A failed `supported-models` read or `set-model` request shows an error
  banner and restores editor focus; the footer is never updated optimistically.

**Permission mode: display and shift+tab cycling**

- The footer shows the current permission mode **unconditionally** (including
  `default`), on the right side of the existing footer line.
- shift+tab cycles the mode through
  `dedupe([default, acceptEdits, plan, ...observedPermissionModes])` — the
  canonical trio first, then any other mode observed: the snapshot's
  `observedPermissionModes` seed the set, and the TUI appends modes it sees
  live (`controlApplied`, `status`, `init`). Observed modes include any mode
  this daemon has ever been in
  (e.g. a settings `defaultMode` of `auto`, or a mode set earlier via
  `clauctl set-permission-mode`), in first-observed order. Cycling from the
  current mode (treated as `default` when unknown) sends a
  `set-permission-mode` request; the footer updates via the `controlApplied`
  event (no optimistic update). A failed request (e.g. `bypassPermissions`
  without the dangerous-skip capability) shows an error banner and leaves the
  footer unchanged.
- The TUI also updates the mode from `system/status` messages carrying
  `permissionMode` (mode changes not initiated over sdk.sock, e.g. plan-mode
  transitions).

**Protocol: snapshot extension**

- `StateSnapshot` gains `model`, `permissionMode`, `observedPermissionModes`,
  and `cwd` (all optional), so an attaching TUI is seeded without extra reads
  and stays close to stateless. The daemon tracks them in a local state record
  (separate from the persisted agent record — nothing here feeds back into
  `agent.json` or session-path derivation), updated from the stream and its
  own mutations:
  - `model`: `system/init` `model`; overwritten by `set-model` mutations
    (`undefined` model → the daemon records the model as unset; the TUI
    displays "default").
  - `permissionMode`: `system/init` `permissionMode`, `system/status`
    `permissionMode`, and `set-permission-mode` mutations.
  - `observedPermissionModes`: every value `permissionMode` has taken, in
    first-observed order — **daemon-process lifetime only**, not persisted
    across daemon restarts (a restarted daemon re-observes its starting mode
    from `init`).
  - `cwd`: seeded from the registry record's cwd at daemon start (so the
    snapshot always carries it), overwritten from each `system/init` (inits
    recur on respawn; the stream is the source of truth even though the
    values should always agree).

### Type design (approved)

**`src/core/sdk-socket.ts`** — extend the existing interface:

```ts
export interface StateSnapshot {
  assistantState: AssistantState;
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  observedPermissionModes?: PermissionMode[];
  cwd?: string;
}
```

**`src/core/daemon.ts`** — no exported symbols; a local mutable tracked-state
record in `runDaemon`, updated at the existing `init` handling site, a new
`status` message case, and inside the `controlApplied` helper for
`set-model` / `set-permission-mode`. The `subscribe` handler spreads it into
the snapshot.

**`src/tui/autocomplete.ts`** (new):

```ts
export function findFd(): string | null; // PATH lookup: fd, then fdfind

export class TuiAutocompleteProvider implements AutocompleteProvider {
  // cwd null (snapshot from a pre-extension daemon) disables @ completion
  // the same way a missing fd does, minus the hint.
  constructor(
    cwd: string | null,
    fdPath: string | null,
    onAtWithoutFd: () => void,
  );
  setCommands(commands: SlashCommand[]): void; // merges local /model, /context
  // getSuggestions / applyCompletion / shouldTriggerFileCompletion /
  // triggerCharacters delegate to an inner CombinedAutocompleteProvider
  // (recreated by setCommands). getSuggestions additionally calls
  // onAtWithoutFd (once) when an @-prefix is requested with fdPath null.
}
```

(`AutocompleteProvider`, `CombinedAutocompleteProvider`, `SlashCommand` are
pi-tui exports; the SDK's `SlashCommand` fields we use — `name`,
`description`, `argumentHint` — map onto pi-tui's shape. SDK `aliases` are
ignored as specified above.)

**`src/tui/components/model-selector.ts`** (new), built on pi-tui `SelectList`:

```ts
export class ModelSelectorComponent extends Container implements Focusable {
  focused: boolean; // pi-tui Focusable
  constructor(
    models: ModelInfo[],
    onSelect: (model: ModelInfo) => void,
    onCancel: () => void,
  );
  handleInput(data: string): void; // Component input hook; delegates to SelectList
}
```

**`src/tui/interactive-mode.ts`** — no new exports. Startup
`initialization-result` read; `submit()` interception for `/model`; new
`system` subcases (`local_command_output`, `status`, `commands_changed`);
shift+tab in `handleGlobalKey`; model-selector focus handling; autocomplete
provider wiring (`editor.setAutocompleteProvider`).

**`src/tui/components/footer.ts`** — render change only: permission mode shown
unconditionally.

### Success criteria

- Typing `/` in the TUI shows the agent's commands (including skills) with
  descriptions and argument hints; completing + submitting a command (e.g.
  `/usage`) round-trips through the agent and its output appears in the
  transcript.
- Typing `@` completes file paths relative to the agent's cwd; with fd absent,
  the advisory hint appears instead (once).
- `/model` opens a menu of real models; selecting one updates the footer and
  persists (visible in `agent.json` per DECISION-5).
- `/context` (and `/context all`) submitted as text renders the CLI's own
  output in the transcript via `local_command_output` — no local
  implementation.
- The footer always shows the permission mode; shift+tab cycles through the
  canonical trio plus observed modes, and the change is visible to other
  subscribers (`clauctl tail` shows `controlApplied`).
- Attaching to a running agent seeds model/mode/cwd from the snapshot alone
  (the startup `initialization-result` read serves only the command list).
- `npm run presubmit` passes; new pure logic (provider
  command-merging/shadowing, `/model` interception parsing) has unit tests.

### Non-goals

- Interactive permission prompting (still future work, per tui.md).
- History replay (transcript still starts blank on attach).
- Auto-downloading fd (pi's ~370-line unverified-binary downloader is
  deliberately not mirrored).
- Argument completion for SDK-provided commands (pi's
  `getArgumentCompletions`) — the SDK gives only a static `argumentHint`
  string, which we display.
- Observing mid-session cwd changes: the SDK's message stream does not
  broadcast them (only a `CwdChanged` hook exists, and the daemon registers no
  hooks); the snapshot's cwd is as fresh as the last `init`.
- Porting pi's `ModelSelectorComponent` (fuzzy model search UI); ours is a
  plain `SelectList`.

## IMPLEMENTATION IDEAS

- **Startup ordering**: the `initialization-result` read can race the first
  render; the provider starts with only the local commands and gains the SDK
  list when the read resolves. No gating needed — completion before the read
  resolves just shows the local commands.
- **Focus management**: pi-tui `TUI.setFocus`; the model selector is appended
  near the editor (statusContainer region), focused, and removed on
  select/cancel with focus returned to the editor. pi's own dialogs follow
  this pattern.
- **fd flags** (what `CombinedAutocompleteProvider` runs):
  `fd --base-directory <cwd> --max-results 100 --type f --type d --follow
--hidden --exclude .git <pattern>`, `--full-path` when the query contains
  `/`; results re-ranked (exact filename 100 / prefix 80 / name-substring 50 /
  path-substring 30 / +10 dir), top 20 shown.
- **Trigger characters**: pi-tui's Editor keeps its default `["@", "#"]`
  triggers regardless of the provider (provider triggers are additive, not
  replacing). `#` simply yields no popup because
  `CombinedAutocompleteProvider` has no `#` handling and returns null.
- **Shadowing the local command**: merge = SDK list minus any entry named
  `model`, plus our local `SlashCommand` entry with our description
  (`/model` — "select the agent's model interactively").
- **Interception parsing**: first whitespace-delimited token of the submitted
  text, exact (case-sensitive) match against `/model`; the argument is the
  trimmed remainder.
- **Daemon `status` handling**: `handleMessage` currently ignores `status`;
  the tracked-state update must not disturb the assistant-state fold (which
  also sees the message via the EventBus).
- **Version-skew reminder**: `clauctl` installed via `dist/` must be rebuilt to
  test TUI changes (the footer "bug" that kicked off the permission-mode work
  was exactly this).

## WORK LOG

**Instructions**: Update this section during each work session. Add new tasks,
mark completed ones with [x], document decisions and problems encountered.

### 2026-07-08 — derisking (pre-spec)

Findings that shaped the SPEC section:

- sdk.sock already exposes everything needed (`supported-commands`,
  `supported-models`, `get-context-usage`, `set-model`,
  `set-permission-mode`, `initialization-result`); the only protocol change is
  the `StateSnapshot` extension.
- pi-tui ships the entire completion stack as exports
  (`Editor.setAutocompleteProvider`, `CombinedAutocompleteProvider`,
  `SelectList`) — nothing to port.
- The claude CLI executes slash commands arriving as user text; local commands
  bypass the model loop and emit `system/local_command_output`. So non-local
  commands need no dispatch machinery.
- `getContextUsage()` returns claude's full `/context` breakdown including the
  pre-computed grid.
- Without fd, `@` completion yields nothing (empty suggestions, no popup) —
  hence the advisory-hint requirement. fd does substring/regex matching
  (gitignore-aware) + heuristic re-ranking; true fuzzy matching is only used
  for command names.
- cwd can change mid-session (`CwdChanged` hook exists) but the message stream
  never broadcasts it; only `init` carries cwd. Decision: snapshot cwd,
  refreshed from each init.
- Permission-mode footer display was verified working end-to-end in the
  current tree (live daemon experiment + isolated `FooterComponent` render);
  the reported blank footer was version skew (stale `dist/`).
- Decision: observed permission modes accumulate **daemon-side** (snapshot
  field), so a freshly attached TUI can cycle back to modes set before it
  connected; keeps the TUI closer to stateless.
- Decision: fd by PATH lookup only (`fd`, `fdfind`); no auto-download.
- pi-tui verification (critique pass): `matchesKey` recognizes `"shift+tab"`
  (ESC`[Z`); TUI input listeners run **before** the focused component, so the
  global shift+tab handler works while the editor is focused; `Focusable` is
  just `{ focused: boolean }` and `handleInput` is an optional `Component`
  method (pi's own ModelSelectorComponent uses exactly this shape); pi-tui has
  hex→RGB color handling internally (terminal-colors.ts) for the /context
  grid colors.

Open questions, resolved at review (2026-07-08):

- [x] `/model <arg>`: claude parity — sends `set-model` with the argument
      directly. Added to SPEC.
- [x] shift+tab cycle computation stays inline in `interactive-mode.ts`; the
      dedupe is trivial enough not to warrant an exported helper.

### 2026-07-08 — fresh-context review (pictl reviewer)

A read-only reviewer agent reviewed the spec pre-implementation. Accepted and
applied:

- SDK `SlashCommand.aliases` has no pi-tui counterpart → aliases ignored for
  completion; interception at submit time makes alias collisions moot (SPEC).
- "records the mode as unset" typo → "model" (SPEC).
- Failure behavior specified for `supported-models`/`set-model`/
  `set-permission-mode`: error banner, focus restored, no optimistic footer
  update (SPEC).
- `/model` selection payload pinned to `ModelInfo.value` (SPEC).
- Snapshot `cwd` guaranteed present from new daemons (seeded from the registry
  record at daemon start); provider takes `cwd: string | null` for
  pre-extension daemons, null disabling `@` completion (SPEC + type design).
- Daemon tracked state clarified as separate from the persisted agent record;
  `observedPermissionModes` scoped to daemon-process lifetime (SPEC).
- Trigger-character note corrected: pi-tui keeps `@`/`#` defaults; `#` yields
  no popup because the provider returns null (IMPLEMENTATION IDEAS).
- Interception parsing pinned: case-sensitive first token, trimmed remainder,
  `/context` arg must be exactly `all` (IMPLEMENTATION IDEAS).
- `local_command_output` rendered as plain `Text`, ANSI passes through (SPEC).
- Success criteria: `/context` scoped to best-effort layout approximation;
  "no extra reads" claim scoped to model/mode/cwd; parsing unit tests added.

Declined: golden-output parity for `/context` (churn for no benefit); an
exported permission-cycle helper (already resolved — stays inline).

### 2026-07-08 — `/context` dropped from local commands

Empirically verified (by the user): submitting `/context` as query text
already produces claude's own rendering via `local_command_output` —
"looks great" out of the box. So the entire local `/context` implementation
(`src/tui/context-usage.ts`, `formatContextUsage`, the `get-context-usage`
read from the TUI, arg parsing) was removed from the SPEC before
implementation started. Only `/model` needs local interception (its claude
counterpart is interactive, which cannot ride the text path). The prior
review notes referencing `/context` interception reflect the pre-drop spec.

Tasks:

- [x] StateSnapshot extension + daemon tracked state (+ tests)
- [x] `src/tui/autocomplete.ts` (findFd, TuiAutocompleteProvider) (+ merge
      tests)
- [x] `src/tui/components/model-selector.ts`
- [x] interactive-mode wiring (startup read, /model interception, new system
      subcases, shift+tab, focus)
- [x] footer unconditional mode display
- [x] presubmit green

### 2026-07-08 — implementation

All tasks implemented; presubmit green (88 tests). Live check (isolated
CLAUCTL_DIR, no query sent so no API spend): spawn → `set-permission-mode
plan` → `set-permission-mode acceptEdits` → tail snapshot shows
`permissionMode: "acceptEdits"`,
`observedPermissionModes: ["plan", "acceptEdits"]` (first-observed order),
and `cwd` seeded from the registry record; `model` correctly absent before
the first init. Interactive TUI behaviors (popup, `/model` menu, shift+tab)
still need a hands-on check — remember the `dist/` rebuild if testing via
the installed `clauctl`.

New files:
`src/tui/autocomplete.ts`, `src/tui/components/model-selector.ts`, plus tests
`src/tui/autocomplete.test.ts` and `src/tui/interactive-mode.test.ts`.
Modified: `sdk-socket.ts` (StateSnapshot), `daemon.ts` (tracked state),
`interactive-mode.ts` (wiring), `footer.ts` (unconditional mode).

### 2026-07-08 — post-implementation review (pictl reviewer)

A fresh read-only reviewer reviewed the implementation diff against the SPEC
section, coding standards, and for clarity. Two high-confidence findings,
both accepted and fixed:

- Footer blank when model/mode unknown (pre-init, or pre-extension daemon)
  despite "shown unconditionally": the TUI now seeds
  `model ?? "default"` / `permissionMode ?? "default"` from the snapshot —
  the same unknown→`default` convention the shift+tab cycle uses; the first
  init corrects both. (Display convention in the TUI, not daemon state: the
  daemon cannot know a settings `defaultMode` pre-init.)
- `/model` double-submit race: two bare `/model` submits before
  `supported-models` resolved could open two selectors; a
  `modelSelectorPending` flag now guards the window.

Declined (reviewer concurred, approved): shift+tab guard while the menu is
open (global shortcut by design), quoted-`@"` hint detection (one-shot hint
fires on the first bare `@`), `SDK_SOCKET_VERSION` bump (additive optional
fields only), `get(...)!` hardening and a variable rename (locally-evident).

### 2026-07-08 — review comment: handleGlobalKey return value

Resolved: the return value is pi-tui's input-listener contract —
`TUI.handleInput` runs listeners before the focused component and
`{consume: true}` stops dispatch (that's what keeps escape/shift+tab/ctrl+c
global instead of becoming editor input); pi-tui doesn't export its
`InputListenerResult` type, hence the structural signature. Documented in a
doc comment on `handleGlobalKey`; TDC removed.

## Implementation-Time Decisions

- **`parseModelCommand` exported from `interactive-mode.ts`** — the type
  design said "no new exports" there, but the success criteria require unit
  tests for the `/model` interception parsing; a non-exported function cannot
  be tested. Exported as a pure function, tested in
  `interactive-mode.test.ts`. (Deviation from the approved type design —
  flagged for user review.)
- **Merge/shadowing tested through `getSuggestions`** — no exported merge
  helper; the tests drive `TuiAutocompleteProvider` the way the Editor does
  (a `/` prefix at the cursor), which also exercises the delegation to
  `CombinedAutocompleteProvider`.
- **Daemon tracked state has no direct unit test** — it is private to
  `runDaemon` with no exported surface, and the repo has no daemon
  integration harness. The success criteria's testing requirement names only
  the two pure-logic pieces (merge/shadowing, parsing), both covered.
  Verification of the snapshot fields is a live-check item.
- **`initialization-result` fetch failure shows a banner** — the spec pins
  failure behavior only for `supported-models`/`set-model`/
  `set-permission-mode`; silently losing the command list seemed worse than a
  dim "command list fetch failed" banner.
- **Escape with the model menu open never interrupts** — the global
  escape-while-busy → interrupt handler skips when the selector is open, so
  escape always means "cancel the menu" there (menu takes focus; global
  listeners run first, so without the guard a busy assistant would swallow
  the cancel).
- **fd hint fires on `@` whenever fd is missing, regardless of cwd** — per
  the type-design comment ("when an @-prefix is requested with fdPath
  null"); the cwd-null-no-hint clause covers the fd-present case.
