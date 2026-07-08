# Spec: TUI input features — slash commands, completion, @-files, permission mode

> Status: **draft**. Builds on `docs/specs/tui.md` (phase 3): the TUI is a pure
> `sdk.sock` client. This phase adds the input-side affordances: a completion
> popup for slash commands (including skills) and `@` file insertion, local
> `/model` and `/context` commands, and permission-mode display + cycling.

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
- Our local commands `/model` and `/context` appear in the popup too,
  shadowing same-named entries from the SDK list.
- Submitting any slash command other than the locally intercepted `/model` and
  `/context` sends it to the agent as ordinary query text — the claude CLI
  processes slash commands in user input. The daemon's existing `/compact`
  special-case is unchanged.
- Output of local CLI commands arrives as `system/local_command_output`
  messages; the TUI renders their `content` in the transcript.

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
  fetched fresh on each open. Selecting sends a `set-model` request; Esc
  cancels. The footer model indicator updates via the resulting
  `controlApplied` event (no optimistic local update).
- Submitting `/model <arg>` sends `set-model` with `<arg>` directly (claude
  parity), no menu.
- The menu takes keyboard focus while open and returns it to the editor on
  select/cancel.

**`/context` and `/context all`**

- Submitting `/context` renders the agent's context usage into the transcript,
  styled after `claude`'s `/context`: the colored square grid (from the
  response's pre-computed `gridRows`), the per-category token table, totals and
  percentage. `/context all` additionally lists the detailed sections (memory
  files, MCP tools, system tools/prompt sections, skills, agents, message
  breakdown) when present in the response.
- Data comes from the existing `get-context-usage` read. A failed read shows an
  error banner. Any other `/context <arg>` shows a usage hint banner and sends
  nothing.

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
  event.
- The TUI also updates the mode from `system/status` messages carrying
  `permissionMode` (mode changes not initiated over sdk.sock, e.g. plan-mode
  transitions).

**Protocol: snapshot extension**

- `StateSnapshot` gains `model`, `permissionMode`, `observedPermissionModes`,
  and `cwd` (all optional), so an attaching TUI is seeded without extra reads
  and stays close to stateless. The daemon tracks them from the stream and its
  own mutations:
  - `model`: `system/init` `model`; overwritten by `set-model` mutations
    (`undefined` model → the daemon records the mode as unset; the TUI
    displays "default").
  - `permissionMode`: `system/init` `permissionMode`, `system/status`
    `permissionMode`, and `set-permission-mode` mutations.
  - `observedPermissionModes`: every value `permissionMode` has taken, in
    first-observed order.
  - `cwd`: the registry record's cwd, overwritten from each `system/init`
    (inits recur on respawn; the stream is the source of truth even though the
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
  constructor(cwd: string, fdPath: string | null, onAtWithoutFd: () => void);
  setCommands(commands: SlashCommand[]): void; // merges local /model, /context
  // getSuggestions / applyCompletion / shouldTriggerFileCompletion /
  // triggerCharacters delegate to an inner CombinedAutocompleteProvider
  // (recreated by setCommands). getSuggestions additionally calls
  // onAtWithoutFd (once) when an @-prefix is requested with fdPath null.
}
```

(`AutocompleteProvider`, `CombinedAutocompleteProvider`, `SlashCommand` are
pi-tui exports; the SDK's `SlashCommand` — `name`, `description`,
`argumentHint` — maps field-for-field onto pi-tui's.)

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

**`src/tui/context-usage.ts`** (new):

```ts
export function formatContextUsage(
  usage: SDKControlGetContextUsageResponse,
  all: boolean,
): string;
```

Pure formatter; `interactive-mode.ts` renders the result as a transcript
`Text`.

**`src/tui/interactive-mode.ts`** — no new exports. Startup
`initialization-result` read; `submit()` interception for `/model` and
`/context`; new `system` subcases (`local_command_output`, `status`,
`commands_changed`); shift+tab in `handleGlobalKey`; model-selector focus
handling; autocomplete provider wiring (`editor.setAutocompleteProvider`).

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
- `/context` output matches `claude`'s layout for the same session (grid +
  category table); `/context all` shows the detail sections.
- The footer always shows the permission mode; shift+tab cycles through the
  canonical trio plus observed modes, and the change is visible to other
  subscribers (`clauctl tail` shows `controlApplied`).
- Attaching to a running agent seeds model/mode/cwd from the snapshot with no
  extra socket reads.
- `npm run presubmit` passes; new pure logic (`formatContextUsage`, provider
  command-merging) has unit tests.

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
- **Trigger characters**: pi-tui's Editor default is `["@", "#"]`; the
  provider's `triggerCharacters` should be `["@"]` for us (`#` is a pi
  memory-file convention with no clauctl meaning).
- **`getContextUsage` response**: `categories` (name/tokens/color),
  `totalTokens`, `maxTokens`, `percentage`, `gridRows` (pre-computed colored
  grid), `memoryFiles`, `mcpTools`, `systemTools?`, `systemPromptSections?`,
  `agents`, `skills?`, `slashCommands?`, `messageBreakdown?`, `apiUsage`.
  Colors arrive as names/hex from the SDK; map through our theme only if they
  clash with the dark palette (start by using them as-is via pi-tui color
  utilities).
- **Shadowing local commands**: merge = SDK list minus entries named
  `model`/`context`, plus our two local `SlashCommand` entries with our
  descriptions (`/model` — "select the agent's model interactively",
  `/context [all]` — "show context usage").
- **Interception parsing**: first whitespace-delimited token of the submitted
  text, exact match against `/model` / `/context`.
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

Tasks:

- [ ] StateSnapshot extension + daemon tracked state (+ tests)
- [ ] `src/tui/autocomplete.ts` (findFd, TuiAutocompleteProvider) (+ merge
      tests)
- [ ] `src/tui/components/model-selector.ts`
- [ ] `src/tui/context-usage.ts` (+ format tests)
- [ ] interactive-mode wiring (startup read, interception, new system
      subcases, shift+tab, focus)
- [ ] footer unconditional mode display
- [ ] presubmit green
