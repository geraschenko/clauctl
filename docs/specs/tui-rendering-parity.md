# TUI rendering parity

Successor to `docs/specs/tui-parity.md` (which delivered the capture
harness). This spec implements the rendering changes themselves.

# SPEC

## Problem statement

The clauctl attach TUI (`src/tui/`) renders transcripts very differently
from native claude: raw JSON tool calls, full inline thinking, raw
`<command-name>`/`<bash-input>` tags, no message gutters. The differences
are cataloged and triaged in `docs/derisk/tui-parity/diff-catalog.md`
(side-by-side examples: `diff-catalog.html`).

Implement the catalog entries triaged **match** and **differ (decided)**,
under the maintenance philosophy of `src/tui/AGENTS.md`: borrow
implementation from pi (import > verbatim port > pi-inspired rewiring >
custom), target claude's look without forking pi components to match it
pixel-exactly.

## Requirements

The normative WHAT lives in the catalog — one requirement per entry:

- Group B (match): thinking-collapse, tool-call-header,
  tool-result-collapse, readonly-tool-folding, edit-diff-view,
  subagent-summary, tool-error-summary.
- Group A (match): user-gutter, user-verbatim, assistant-gutter,
  block-spacing.
- Group C (match): code-fence-stripping, heading-style (structure now,
  color in the ANSI pass), link-render. inline-style is ANSI-pass only.
- Group D: slash-command (match), bash-passthrough (match + fix the
  entity double-escaping bug), ide-selection (match), compact-boundary
  (differ, decided: full summary, markdown-rendered). turn-duration is
  skipped.
- Group E (differ, decided): footer per the design below; welcome banner
  stays absent.

Two enabling deliverables precede the rendering work:

1. **Render-from-file instrumentation**: render a session jsonl through
   the real TUI components without spawn/attach/tmux, so capture/diff of
   the clauctl side is instant and unit tests can carve per-message
   fixtures from session files.
2. **Tool-schema capture + generated types**: adapt the muninn
   claude-tools approach (`~/git/muninn/ccc/codegen/src/claude_tools/`,
   see its README) to capture the bundled claude's tool schemas and
   generate TypeScript input types, so per-tool rendering code breaks at
   compile time when an SDK bump changes a tool's schema.

## Success criteria

- For each implemented catalog entry, the corresponding hunks in the
  harness diffs (`scripts/tui-parity/out/*.diff`) close — or, for decided
  differences, the remaining diff is the documented intentional one.
- Each entry lands with a unit test rendering the relevant message
  fixture(s) through `TranscriptRenderer` and asserting the produced
  lines (footer entries test `FooterComponent.render` directly;
  environment-dependent behavior like OSC 8 is asserted per capability
  mode).
- `capture.ts --direct` produces the clauctl side without spawning a
  daemon, and its output matches the transcript region of what attach
  renders for the same session (verified once against a tmux capture,
  then relied upon).
- `scripts/claude-tools/generate.ts --check` (wired into presubmit)
  fails when `src/tui/tool-views/generated.ts` is stale relative to the
  checked-in `tool-schemas.json`.
- Presubmit stays green throughout; one coherent change per catalog entry
  (or tightly-related group), each reviewable on its own.

## Concrete examples

From the catalog (see `diff-catalog.html` for the full set). Target
rendering, claude-style:

```
❯ Create a file named notes.txt containing the line 'hello parity', then
  read it back. Reply with one sentence.

  Thought for 1s (ctrl+t to show)

● Write(~/notes.txt)
  ⎿  Error writing file

  Thought for 4s, read 1 file (ctrl+o to expand)

● The file notes.txt was successfully created and verified to contain the
  line "hello parity".
```

replacing today's bare tool name + raw JSON args + raw
`<tool_use_error>` output + full inline thinking.

## Type design

Approved 2026-07-18, including the critique-round and TDC-round
amendments (see WORK LOG). New/changed symbols only; phases are ordered.

### Phase 0 — pi version alignment (approved 2026-07-18)

Adding `@earendil-works/pi-coding-agent` forces a version bump:
pi-coding-agent@0.80.10 requires `pi-tui ^0.80.9` (clauctl pins 0.80.3)
and Node `>=22.19.0` (clauctl declares `>=22.18`). Before any rendering
work:

- bump `@earendil-works/pi-tui` to 0.80.10 and add
  `@earendil-works/pi-coding-agent` 0.80.10 (kept version-locked);
- `scripts/update-ports.sh v0.80.2-fork.2 v0.80.10` to bring the three
  existing ports up to the matching upstream, resolving any `.rej`;
- bump `engines.node` to `>=22.19`;
- call `initTheme("dark")` once in the TUI entrypoint AND in
  `render-session.ts` / component-test setup (anything that can reach
  `renderDiff` or other theme-reading pi code).

### Phase 1 — render-from-file instrumentation

`src/tui/transcript.ts` (new): the transcript dispatch extracted from
`interactive-mode.ts` so attach and file-render share it exactly (single
source of truth for transcript rendering). Attach has two render paths —
live SDK messages and replayed path nodes (`renderPathNode`) — so the
renderer exposes both:

```ts
export class TranscriptRenderer {
  constructor(container: Container);
  /** Fold one SDK message into transcript components: stream events drive
   *  the streaming component; a finalized assistant message replaces it;
   *  user messages only resolve tool results (unknown toolCallId →
   *  dropped; parent_tool_use_id-routed results render nested under the
   *  owning component — today's rules). Live user PROMPT text does NOT
   *  render here (it is echoed at dequeue via appendUserTurn). */
  append(message: SDKMessage): void;
  /** Render a user turn's visible content (userTurnViews). Called by
   *  replay (user path nodes) and by InteractiveMode's dequeue echo, so
   *  live and replayed prompts share one rendering. */
  appendUserTurn(message: SDKUserMessage): void;
  /** Replay one history node: compact_boundary → banner, compact summary
   *  (entry.isCompactSummary) → markdown summary block, user →
   *  appendUserTurn (visible content) THEN append (tool-result
   *  resolution; result-only messages have no visible views), assistant
   *  → append. Session-entry metadata that
   *  entryToSessionMessage drops (isCompactSummary, timestamps for
   *  thinking durations, cwd) is read from the entry here. */
  appendPathNode(node: TreeNode): void;
  /** cwd for headerArg path abbreviation; InteractiveMode feeds it from
   *  AgentState.cwd, appendPathNode from entry.cwd. */
  setCwd(cwd: string | undefined): void;
  setToolsExpanded(expanded: boolean): void; // fans out to ToolExecutionComponents
  setShowThinking(show: boolean): void; // fans out to AssistantMessageComponents
  // internally owns: toolComponents: Map<string, ToolExecutionComponent>
  // and the streaming-message state (StreamingMessage fold + component)
}
```

`TranscriptRenderer` owns all transcript content, including the
streaming fold (`stream_event` and finalizing assistant messages both
arrive through `append`). `InteractiveMode` keeps pending/status/queue
handling and the replay dedupe bookkeeping (`replayedUuids`,
`replayedBoundaryUuids`); its dequeue echo retains the queued
`SDKUserMessage` (not just its text) so it can call `appendUserTurn`.

`scripts/tui-parity/render-session.ts` (new):

```ts
export function renderSessionFile(sessionFilePath: string, width: number): string[];
```

Pipeline (the daemon's actual seeding path, cf.
`request-handlers.ts`): `readSessionEntries` → `buildTree` +
`effectiveTreeNodeChain` (leaf = chain tail) → `pathToLeaf` →
`TranscriptRenderer.appendPathNode` per node. Invalid entries go to the
chain's `onInvalid` callback → stderr warning. `pathUpToBoundary` does
not apply (there is no live stream; the whole path renders).

The output is the transcript container only — no footer, editor, status
or pending area — rendered at `width`. `capture.ts --direct` writes the
same pair as the tmux path: `.ansi` (raw styled component output) and
`.txt` (ANSI codes stripped, harness-normalized plain text);
attach-match validation compares the transcript region of a tmux attach
capture (footer/editor lines excluded) against it. The claude side is
unchanged (tmux).

### Phase 2 — tool schema capture + generated types

- `scripts/claude-tools/capture.ts` — mitmdump orchestration (muninn's
  two-phase flow: discovery prompt captures immediate tools + deferred
  roster from the system-reminder; ToolSearch prompt loads deferred
  schemas). Uses the bundled claude, an isolated `CLAUDE_CONFIG_DIR`
  seeded like the parity harness's (OAuth creds; API-key fallback if
  OAuth won't traverse the MITM proxy — verified empirically as this
  phase's first step). Writes checked-in
  `scripts/claude-tools/tool-schemas.json`. Drift/completeness checks as
  in muninn (schema drift fatal, roster completeness validated).
- `scripts/claude-tools/capture-addon.py` — the mitmdump addon (adapted
  from muninn's `capture_tool_schemas.py`).
- `scripts/claude-tools/generate.ts` — `json-schema-to-typescript` (new
  dev dependency) over the schemas → `src/tui/tool-views/generated.ts`: one input interface
  per tool (`WriteInput`, `BashInput`, …), `export type ToolName = …`
  union, `export const TOOL_NAMES: readonly ToolName[]`, and
  `export interface ToolInputMap { Write: WriteInput; … }` (the
  `InputFor<K>` used by phase 3 is `ToolInputMap[K]`). `--check` mode
  regenerates and diffs (presubmit, same pattern as
  `sync-from-pictl.mjs --check`).
- Provenance: `tool-schemas.json` records the claude version it was
  captured from; `generate.ts --check` also compares that recorded
  version against the bundled claude's version and fails on mismatch —
  so an SDK bump turns presubmit red until the capture is rerun (the
  `--check` itself needs no network).

### Phase 3 — per-tool views (Group B)

`src/tui/tool-views/tool-view.ts` (new):

```ts
export interface ToolView<A> {
  /** Rendered header name where it differs from the tool name:
   *  Edit → "Update", Task → "Agent". Undefined → the tool name. */
  displayName?: string;
  /** Header arg, e.g. "~/notes.txt" for Write; undefined → bare name. */
  headerArg(args: A, cwd: string | undefined): string | undefined;
  /** Collapsed ⎿ summary; undefined → generic first-line + "… +N lines". */
  resultSummary(args: A, result: RenderToolResult): string | undefined;
  /** Folds into the "Thought for Ns, read 1 file" line. */
  readOnly: boolean;
  /** Fold-line contribution, e.g. (2) => "read 2 files". */
  foldLabel(count: number): string;
}
export const toolViews: { [K in ToolName]?: ToolView<ToolInputMap[K]> };
export function toolViewFor(name: string): ToolView<unknown> | undefined;
```

`toolViewFor` is the single type-erasure point (one internal cast of
`toolViews` to `Record<string, ToolView<unknown>>`); views must treat
runtime args defensively — generated types describe the schema, but the
wire payload is untrusted (never crash on unexpected shapes).

`RenderToolResult` gains `structured?: unknown`: the SDK user message's
`tool_use_result` (structured per-tool result data), attached by
`toolResultsOf` when the message carries exactly one tool_result block.
The Task view's `Done (N tool uses · Xk tokens · Ns)` summary reads it
(text-content fallback when absent/unrecognized).

Views co-located per tool under `src/tui/tool-views/` (write.ts, edit.ts,
bash.ts, read.ts, task.ts, glob.ts, grep.ts, …). Unknown/MCP tools use
the generic fallback (current rendering, claude does the same).

Diff rendering is imported, not ported (decided 2026-07-18):
`@earendil-works/pi-coding-agent` becomes a dependency (version-locked to
`@earendil-works/pi-tui`), providing `renderDiff` and
`generateDiffString` directly. `renderDiff` reads pi's global theme
singleton, so the TUI entrypoint calls `initTheme("dark")` once at
startup (built-in palette, no config lookup, no watcher; matches the
palette `theme.ts` already mimics).

The Edit view feeds `old_string`/`new_string` through
`generateDiffString` → `renderDiff`.

`ToolExecutionComponent` reworked to claude layout: `● Name(headerArg)` +
`⎿ summary`; expanded shows the current rendering (pretty-printed args +
full result text; the Edit view's expanded form is the diff). Decided
(Anton, 2026-07-18): this rework takes `tool-execution.ts` out of the
verbatim-port set — reclassify it as pi-inspired (drop from
`update-ports.sh` `PORTS`, header documents lineage). Delineation
principle: pi-derived code is clearly marked for update on pi version
bumps; claude-derived code (the tool views over generated schemas, under
`src/tui/tool-views/`) is clearly marked for update on claude version
bumps.

Folding (in `TranscriptRenderer`): our own rule, not a
reverse-engineering of claude's classifier (approved divergence):

- A fold run is a maximal consecutive sequence of _finalized_ thinking
  blocks and readOnly tool calls whose results have arrived and are not
  errors. Assistant text blocks, non-readOnly tools, error results, and
  _visible_ user turns end the run — tool-result carrier messages do
  not (every tool result arrives in an SDK user message; a successful
  readOnly result completes its call and may retro-fold it). Bash never
  folds (readOnly: false), even though claude sometimes folds
  read-only-looking bash commands.
- The run renders as one line — `Thought for Ns, read 2 files, searched
  for 1 pattern` — thinking duration from session-entry timestamp deltas
  when available, else omitted. A streaming component never folds; it may
  retro-fold once finalized (its result arrives non-error).
- Fold lines exist only while BOTH toggles are collapsed; either
  `setToolsExpanded(true)` (ctrl+o) or `setShowThinking(true)` (ctrl+t)
  disbands folds into individual components (a fold line can contain
  hidden thinking, so showing thinking must disband it too; with only
  thinking shown, readOnly tools render individually collapsed).
  Re-collapsing both re-folds. Defaults: tools collapsed, thinking
  collapsed (replayed and live components alike).

Keybindings in `InteractiveMode`: `ctrl+o` toggles tool output expanded,
`ctrl+t` toggles thinking shown (decided; claude uses ctrl+o for both,
so our collapsed-thinking hint text says `ctrl+t` where claude's says
`ctrl+o` — a decided divergence, noted in the catalog).

### Phase 4 — chrome + markdown (Groups A, C)

- `UserMessageComponent`: verbatim text (no Markdown rendering), `❯`
  gutter, 2-space continuation indent, one-blank-line block spacing.
- `AssistantMessageComponent`: `●` gutter on text blocks (documented
  intentional diff in the port header); spacing fixes.
- `theme.ts` markdown palette adjustments. Two empirical checks decide
  the approach (see IMPLEMENTATION IDEAS): fence-stripping via theme vs
  triaged divergence; OSC 8 link enablement.

### Phase 5 — special user messages (Group D)

In `sdk-render.ts`, replacing `userText` at transcript render sites
(`userText` remains for queue previews):

```ts
export type UserTurnView =
  | { kind: "prompt"; text: string }
  | { kind: "slashCommand"; command: string; args: string }
  | { kind: "commandOutput"; text: string } // "No response requested" suppressed
  | { kind: "bashInput"; command: string }
  | { kind: "bashOutput"; stdout: string; stderr: string }
  | { kind: "contextTag"; tag: string; text: string }; // ide_selection etc.
export function userTurnViews(message: SDKUserMessage): UserTurnView[];
```

HTML-entity unescaping happens here (fixes the double-escaping bug):
one pass, applied only to the extracted contents of the known tags
(`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, command tags), for
exactly the entities the CLI escapes (enumerated empirically during
implementation). Malformed or unknown tags fall back to `prompt` with
the text verbatim.

Compact summaries render in full through `Markdown` (decided) — via
`appendPathNode` (`entry.isCompactSummary`; the SDK message form does
not carry the flag).

`TranscriptRenderer` maps each view kind to a component: prompt/
contextTag → `❯` blocks; slashCommand → `❯ /name args`; a
`commandOutput` or `bashOutput` view correlates with the immediately
preceding slashCommand/bashInput component and renders as its
`⎿ output` (collapsed); standalone output views render as their own
block. The `system/local_command_output` message (steered `!` output)
moves into the `append` dispatch with the same rendering as
`bashOutput`.

### Phase 6 — footer

```ts
// src/tui/components/footer.ts becomes pi-layout-shaped:
export class FooterComponent {
  constructor(dataProvider: ReadonlyFooterDataProvider | undefined);
  setState(state: AgentState): void;
  render(width: number): string[];
  // line 1: cwd (branch)
  // line 2: permission mode left (claude's per-mode colors) …
  //         context usage • model • thinking level right
}
```

Git branch data: pi's `FooterDataProvider` class is not importable (the
entrypoint exports only the `ReadonlyFooterDataProvider` type, and the
`exports` map blocks deep imports), so `core/footer-data-provider.ts`
(388 lines, almost entirely git-branch watching: HEAD/reftable watchers,
WSL polling) is verbatim-ported to `src/tui/footer-data-provider.ts`
together with its sole internal dependency `utils/fs-watch.ts` →
`src/tui/fs-watch.ts` (~30 lines); both registered in `PORTS`. The
footer types against the _imported_ `ReadonlyFooterDataProvider`
(exact pi call-site shape: `getGitBranch`, `onBranchChange`). The
extension-status surface goes unused.

Context usage from the existing `AgentState.lastUsage`
(`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
≈ current context size); pi's cumulative session counters and cost are
skipped (decided). Shown as `NNk` plus a percentage; the window size
comes from a small model→window map, with unknown models assuming 200k
(so a percentage always shows).

Thinking level (decided, Anton, 2026-07-18: make it observable via
`AgentState`): new field `AgentState.effortLevel?: "low" | "medium" |
"high" | "xhigh"`. Initial value comes from the AgentState seed the same
way model/permissionMode already do: `settingsSeed` (src/core/
options.ts) runs the SDK's `resolveSettings` cascade — extend its return
with `resolved.effective.effortLevel`, with explicitly-set spawn
settings taking precedence over the settings tier (the seed's existing
"what will the NEXT query use" precedence). Live changes fold from the
existing `controlApplied { type: "apply-flag-settings" }` event when its
settings carry `effortLevel` (null reverts to unset). The footer omits
the segment only when genuinely unresolved.

Permission mode: the footer maps every SDK `PermissionMode` value
(`default`/`acceptEdits`/`plan`/`bypassPermissions`/`dontAsk`/`auto`)
to a label + color. Captured so far: `auto` = 256-color 220 (gold),
`default` (claude's "manual") grey 246; the remaining labels/colors are
captured during implementation. Narrow widths follow pi's
`FooterComponent` truncation behavior.

Lifecycle: `InteractiveMode` owns the `FooterDataProvider` — creates it
from `AgentState.cwd`, recreates it when cwd changes, subscribes
`onBranchChange` to request a rerender, and disposes it on detach.

### Phase order

0 → 1 → 2 → 3 → 4/5 (independent of each other) → 6.

Port maintenance is an explicit deliverable of every phase that touches
a ported file: intentional-differences headers updated, and new verbatim
ports (`footer-data-provider.ts`, `fs-watch.ts`) registered in
`scripts/update-ports.sh` `PORTS`. (Importing was checked first per
AGENTS.md — pi-coding-agent exports neither implementation, only the
`ReadonlyFooterDataProvider` type.)

## Edge cases

- Tool results: unknown `toolCallId` → dropped;
  `parent_tool_use_id`-routed results render nested under the owning
  component (both are today's behavior, kept).
- Streaming partials: `foldStreamEvent` continues to drive the streaming
  component; collapse/summarization applies to finalized components.
  Folding only groups finalized messages.
- Sessions without timestamps (or non-monotonic ones): omit the
  "for Ns" duration.
- MCP/unknown tools: generic fallback view; never crash on unexpected
  args shapes (generated types describe known tools only; `toolViewFor`
  returns undefined for the rest).
- Compaction summary entries render as markdown even though claude may
  collapse them (decided difference).
- Bash passthrough on resume (decided, Anton, 2026-07-18): render
  `❯ ! cmd` + collapsed output (claude's live rendering) regardless of
  whether claude's resumed scrollback drops such turns (unverified;
  decided divergence either way).

## Non-goals

- Full ANSI/coloration parity (separate later pass; only entries whose
  triage explicitly includes styling are in scope).
- The ctrl+o full-screen transcript viewer and the broader keyboard
  shortcut inventory (follow-up specs; only the two toggles above are in
  scope).
- Live-rendering parity niceties (turn-duration lines, spinner
  aesthetics).
- Welcome banner, input-box look, user-configurable footer.
- Cumulative token/cost counters in the footer.
- Matching claude's readonly-folding classifier exactly.

# IMPLEMENTATION IDEAS

- pi component reuse verdicts and per-entry mapping: see the
  "pi component reuse" section of `diff-catalog.md`. pi source:
  `$PI_REPO` (default `~/git/earendil-works/pi`), pinned by tag for
  ports; npm tarballs ship compiled `dist/` only, so ports copy from the
  git checkout.
- Empirical check (phase 4): can pi-tui `Markdown` fence rendering be
  elided via theme (`codeBlockBorder` returning empty / `codeBlockIndent`)
  or does fence-stripping require a divergence? If a divergence, record
  it in the catalog triage rather than forking `Markdown`.
- Empirical check (phase 4): pi-tui `Markdown` already emits OSC 8
  hyperlinks "when supported" — find the capability gate and whether the
  tmux/harness environment can enable it; otherwise `text (url)` remains
  and link-render becomes theme-only.
- Empirical check (phase 2): OAuth credentials through
  `HTTPS_PROXY`+mitmdump — muninn used `ANTHROPIC_API_KEY`; verify the
  OAuth token flow (`.credentials.json` copy in the isolated config dir)
  survives MITM before building the rest.
- Empirical check (phase 3): thinking duration from session-entry
  timestamp deltas — validate against claude's displayed "Thought for
  Ns" on the tools scenario before adopting.
- Empirical check (phase 3): with pi's theme singleton initialized
  anyway, importing pi's `theme` + `getMarkdownTheme` everywhere and
  deleting our `theme.ts` shim would remove the "theme comes from
  ../theme.ts" intentional diff from every ported component. Verify
  `EditorTheme` coverage and that pi's `Theme` doesn't drag in
  interactive-mode machinery before adopting. Also newly importable from
  pi-coding-agent for later phases: `truncateToVisualLines`, `keyHint`.
  NOT importable (verified): `formatTokens`/`formatCwdForFooter` are
  exported by pi's `footer.ts` but not re-exported through the package
  entrypoint, and the `exports` map blocks deep imports — copy those two
  helpers into our footer (pi-inspired) instead.
- Dependency-weight note (phase 0): pi-coding-agent pulls
  pi-agent-core/pi-ai plus ~15 runtime deps (photon-node, undici,
  highlight.js, …). Accepted for two exports + future component reuse;
  if install weight becomes a problem, the fallback is verbatim-porting
  `diff.ts`/`edit-diff.ts` after all.
- Muninn gotchas to carry over: `HTTPS_PROXY` forward proxy (NOT
  `ANTHROPIC_BASE_URL` reverse proxy — different tool surface),
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, `DISABLE_AUTOUPDATER=1`, schema
  drift = fatal, `tool_schemas.json` is an input artifact.
- Fixture-carving for unit tests: take real session jsonl entries
  (scenario workdirs or imported sessions), reduce to the minimal
  `SDKMessage` JSON, and commit as fixtures — small excerpts, not whole
  sessions (consistent with the never-commit-sessions decision).
- `capture.ts --direct` validation: one-time comparison of direct render
  vs tmux attach capture for the same session establishes the
  instrumentation is faithful; after that the tmux clauctl path is only
  needed when testing attach-specific behavior (streaming, footer
  interaction).
- Folding vs streaming: the simplest correct rule is to fold only
  contiguous already-finalized (message-complete) runs; a streaming tool
  call always renders unfolded and may retro-fold when its result
  arrives.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

## 2026-07-18 — spec written

Derisk round (approved): phases and full type design as in SPEC; ctrl+o
(tools) / ctrl+t (thinking) toggles; OAuth creds for capture; our own
readonly-folding rule; render-from-file as phase 1.

Decision (Anton): import `renderDiff`/`generateDiffString` from a new
`@earendil-works/pi-coding-agent` dependency instead of verbatim-porting
`diff.ts`/`edit-diff.ts`; pin pi's theme singleton with
`initTheme("dark")` at TUI startup. Theme-adoption follow-on recorded as
a phase-3 empirical check.

## 2026-07-18 — critique round (reviewer 52a4be43 + fact-checks)

A fresh-context reviewer critiqued the spec; every factual claim was
verified against the sources before adoption. Corrections folded in:

- Phase 1: `appendPathNode` added to `TranscriptRenderer` (attach has
  two render paths; `entryToSessionMessage` drops `isCompactSummary`,
  timestamps, and boundary entries, so replay must go through the
  entry). Pipeline corrected to `buildTree` + `effectiveTreeNodeChain` +
  `pathToLeaf`; direct-render output and attach-match comparison defined
  (transcript region only).
- Phase 2: `ToolInputMap` generated (defines `InputFor`); schema
  provenance check ties `tool-schemas.json` to the bundled claude
  version.
- Phase 3: `ToolView.displayName` (Edit→"Update", Task→"Agent");
  `RenderToolResult.structured` carries the SDK's `tool_use_result` for
  the Task summary; single erasure point in `toolViewFor`; folding
  contract spelled out (run boundaries, errors, retro-fold, defaults
  collapsed); ctrl+t-vs-claude's-ctrl+o hint divergence recorded.
- Phase 5: output-pairing rules, `local_command_output` absorbed into
  the dispatch, unescaping scoped to known tags/entities.
- Phase 6: context formula fixed; mode mapping over all PermissionMode
  values; `GitBranchWatcher` lifecycle owned by `InteractiveMode`.
- New phase 0: version alignment (pi-tui 0.80.3 → 0.80.10, ports
  0.80.2-fork.2 → 0.80.10, Node >=22.19, `initTheme` in all entry
  paths) — pi-coding-agent@0.80.10 requires pi-tui ^0.80.9.
- Correction: `formatTokens`/`formatCwdForFooter` are NOT importable
  (entrypoint doesn't re-export them; deep imports blocked) — copy them.

All four OPEN items resolved by Anton (2026-07-18):

- Phase 0 approved.
- `tool-execution.ts` leaves the verbatim-port set (delineation
  principle: pi-derived code updates on pi bumps, claude-derived code —
  tool schemas/views — updates on claude bumps).
- Thinking level made observable: `AgentState.effortLevel` folded from
  `controlApplied(apply-flag-settings)`; no initial value from the SDK,
  footer omits until observed.
- Bash passthrough: render `❯ ! cmd` + output on resume (decided
  divergence; claude's resumed behavior left unverified).

Reviewer round 2 (same reviewer, on the revised spec) — adopted:
`appendUserTurn` (live prompts echo at dequeue, replay shares the same
rendering; `append(user)` only resolves tool results);
`TranscriptRenderer` owns the streaming fold; either toggle disbands
fold lines (folds exist only while both are collapsed); `setCwd` feeds
headerArg (AgentState.cwd live, entry.cwd on replay); catalog updated
for the bash-resume and Bash-never-folds divergences; `v`-prefixed
update-ports tags; unknown-toolCallId rule stated (dropped, as today);
context %% always shown (unknown models assume 200k);
`json-schema-to-typescript` named a dev dependency; `.txt`/`.ansi`
terminology fixed.

TDC round (Anton, c499693): initial `effortLevel` now seeded via
`settingsSeed`'s `resolveSettings` cascade (like model/permissionMode),
not left unset until a clauctl control. Git branch: pi exports only the
`ReadonlyFooterDataProvider` type, not the class, so no import is
possible — replaced the bespoke `GitBranchWatcher` subset with verbatim
ports of `footer-data-provider.ts` + `fs-watch.ts` (both in `PORTS`),
footer typed against the imported `ReadonlyFooterDataProvider`.

Reviewer round 3: two final contradictions fixed (replayed user nodes
run appendUserTurn THEN append so historical tool results resolve;
fold runs end at _visible_ user turns, not tool-result carrier
messages). Reviewer approved for implementation — no remaining blocker.

2026-07-18: Anton approved the amended type design (critique + TDC
rounds). Spec final; implementation may begin.

- [ ] Phase 0: version alignment + port update + `initTheme`
- [ ] Phase 1: `TranscriptRenderer` extraction + `render-session.ts` +
      `capture.ts --direct` + first unit-test fixtures
- [ ] Phase 2: mitm capture + addon + `generate.ts` + presubmit `--check`
- [ ] Phase 3: tool views + diff ports + `ToolExecutionComponent` rework +
      folding + keybindings
- [ ] Phase 4: user/assistant gutters, verbatim user text, spacing,
      markdown empirical checks
- [ ] Phase 5: `userTurnViews` + special-message components + escaping
      bugfix + compact summary markdown
- [ ] Phase 6: footer + `FooterDataProvider`/`fs-watch` ports +
      `effortLevel` seed/fold + mode colors capture
- [ ] Close the loop: rerun harness captures, verify catalog entries'
      hunks closed, update `diff-catalog.md` statuses
