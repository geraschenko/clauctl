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
- `capture.ts` produces the clauctl side directly (its default; no
  daemon spawned), and its output matches the transcript region of what
  attach renders for the same session (verified once against a tmux
  capture via `--clauctl-in-tmux`, then relied upon).
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
or pending area — rendered at `width`. `capture.ts` (direct by
default) writes the same pair as the tmux path: `.ansi` (raw styled
component output) and `.txt` (ANSI codes stripped, harness-normalized
plain text); attach-match validation compares the transcript region of
a tmux attach capture (footer/editor lines excluded) against it. The
claude side stays tmux, cached across runs by session-content hash
(`--recapture-claude` forces a fresh capture).

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
  /** Absolute path the header arg refers to (Edit/Read/Write:
   *  file_path); rendered as an OSC 8 file:// link when the terminal
   *  supports hyperlinks AND the arg fits untouched, escape-free, on a
   *  single header line (the header wrap/truncation math assumes no
   *  escape bytes). Absent/undefined/non-absolute → plain text.
   *  (Approved 2026-07-18, amending the original type design, which
   *  had no link target — headerArg returns the abbreviated display
   *  string.) */
  headerLink?(args: A): string | undefined;
  /** Collapsed ⎿ summary; undefined → generic first-line + "… +N lines". */
  resultSummary(args: A, result: RenderToolResult): string | undefined;
  /** Extra block rendered beneath the ⎿ summary in BOTH toggle states
   *  (claude renders it identically collapsed and expanded). Exists
   *  specifically for the Edit view, whose result rendering is the
   *  line-numbered diff — no other view implements it. (Approved
   *  2026-07-20, replacing the earlier `expandedBody` amendment: the
   *  diff is part of claude's default rendering, not an expanded-only
   *  form — see the WORK LOG correction of that finding.) */
  resultBody?(args: A, result: RenderToolResult): string | undefined;
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

Diff rendering is custom, claude-layout (decided 2026-07-20, reversing
the 2026-07-18 import decision — see the WORK LOG entry): a formatter in
`edit.ts` (claude-derived, like the rest of the tool views) renders
`toolUseResult.structuredPatch` directly. pi's `renderDiff` was
evaluated and rejected: pi anchors line numbers by diffing the whole
file, which the transcript does not hold; feeding it structuredPatch
data would mean synthesizing `generateDiffString`'s undocumented
intermediate text format — an unowned parser contract that fails
silently (all-context grey) on upstream format changes, while the hunk
walk it would wrap is the same ~40 lines written either way.

Format (from the edit-scenario and session-44a0b993 captures):

- removed lines carry old-file line numbers, added and context lines
  new-file line numbers; numbers right-aligned per block;
- gutter `-`/`+`/space between number and content; within a change run,
  `-` lines grouped before `+` lines (structuredPatch's unified order);
- multiple hunks in one block, separated by a grey `...` line;
- no length truncation (claude's replay rendering shows full diffs;
  its live truncation is a live-rendering nicety, out of scope);
- colors approximate claude via `claudeStyle` (dim numbers/context,
  red/green change lines); claude's syntax highlighting, background
  bands, and intra-line word highlights are ANSI-pass territory
  (non-goal) — plain-text layout parity is what the harness compares.

When `structuredPatch` is absent or malformed (untrusted wire), the
view renders the counts summary only, no diff — snippet-relative
numbers from `old_string`/`new_string` would be wrong, and the case
does not occur on real sessions.

pi-coding-agent remains a dependency (`initTheme`,
`truncateToVisualLines`); `renderDiff`/`generateDiffString` go unused.

`ToolExecutionComponent` reworked to claude layout: `● Name(headerArg)` +
`⎿ summary` (+ `resultBody` where a view provides one — the Edit diff —
rendered in both toggle states); expanded shows the current rendering
(pretty-printed args + full result text). Decided
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

2026-07-18: Phase 0 implemented: pi-tui 0.80.10 + pi-coding-agent
0.80.10, engines.node >=22.19, `update-ports.sh v0.80.2-fork.2 v0.80.10`
(user-message updated clean; assistant-message had one `.rej` — the
`outputPad` field declaration, rejected only because our port's context
line differs (`RenderAssistant` vs `AssistantMessage`), applied by hand;
tool-execution unchanged upstream). `initTheme("dark")` wired at the top
of `runInteractive`; the render-session.ts/test-setup call sites land
with phases 1/3 when theme-reading pi code first appears there.
Presubmit green.

2026-07-18: Phase 1 implemented. `src/tui/transcript.ts` extracted per
the approved API; `InteractiveMode` keeps dedupe bookkeeping (its
`renderPathNode` wrapper re-derives the rendered uuid via
`entryToSessionMessage` — pure, run twice — so the renderer stays free
of attach-only state), retains queued `SDKUserMessage`s by id
(`queuedById`) for the dequeue echo, recreates the renderer on
`reloadHistory`, and feeds `setCwd` from the fold in `syncActivity`.
The two attach-only system effects (`commands_changed` → autocomplete,
one-shot boundary-banner dedupe) stay in `handleSdkMessage`; everything
else dispatches to `append`. `render-session.ts` + `capture.ts
--direct` render the clauctl side from the session file (validated on
the markdown scenario); direct output is transcript-only, so
footer/editor chrome shows in `--direct` diffs until phase 6.
`transcript.test.ts` added (11 tests, carved minimal fixtures).
Phase-1 defaults preserve current behavior (thinking shown); phase 3
flips defaults to collapsed. Also: `update-ports.sh` now updates a
port's `@ version` header even when upstream content is unchanged
(tool-execution.ts's header had been left stale).

2026-07-18: Phase 2 implemented. Empirical check first: OAuth
credentials DO survive `HTTPS_PROXY`+mitmdump (token refresh, profile,
MCP, and `/v1/messages` all intercepted with `Bearer sk-ant-oat01-…`,
all 200) — no API-key fallback needed. Two findings vs muninn's recipe,
both absorbed into `capture-addon.py`:

- claude 2.1.211 delivers the deferred roster as a `role:"system"`
  message (intro line ending in ":", one name per line, blank-line
  terminated) with no `<system-reminder>` wrapper — the parser targets
  this format.
- The addon records the raw capture faithfully (including a
  `drift_detected` flag it always writes, so a mid-run drift can't leave
  a stale-but-clean file); validation and post-processing live in
  `capture.ts`.

Implementation-time decisions:

- Account-level `mcp__*` tools are filtered from `tool-schemas.json`
  (and from the ToolSearch loading + roster-completeness check): they
  vary with the capturing account's connectors, and the provenance check
  requires the file to be a function of the claude version alone. Phase
  3 renders MCP tools via the generic fallback anyway.
- Provenance records both `claudeVersion` (binary, human-facing) and
  `sdkVersion`; `--check` compares `sdkVersion` against the installed
  `@anthropic-ai/claude-agent-sdk` package.json (pure file read — no
  claude spawn in presubmit).
- `generate.ts` formats its output with the repo's prettier so treefmt
  is a no-op on `generated.ts` and `--check` can compare bytes.
- In 2.1.211 the subagent tool is named `Agent`, not `Task` (the spec's
  Task view maps to it in phase 3); the surface also includes a
  `DeferredToolPlaceholder` no-op tool, kept as captured.

Capture run: 26 built-in tools (10 immediate + 16 deferred), roster
completeness validated. `generate.ts --check` wired into presubmit;
presubmit green.

2026-07-18: Phase 3 groundwork (empirical checks + format extraction;
code not started beyond `RenderToolResult.structured`):

- Thinking-duration check PASSED on the tools scenario: a thinking
  entry's duration = its timestamp minus the previous entry's (1.884→
  "1s", 3.63→"3s", 1.906→"1s"), and a fold line sums the run's thinking
  durations before flooring (2.21+2.67→"4s"). Rule adopted.
- Claude 2.1.211 collapsed formats (from the captures): Edit →
  `● Update(path)` + `⎿  Added N lines[, removed M lines]`, NO diff when
  collapsed (the catalog's line-numbered diff is the expanded form);
  Write success → bare `⎿`, error → `⎿  Error writing file`; Agent →
  `⎿  Done (N tool uses · X.Xk tokens · Ns)` (fields = toolUseResult's
  totalToolUseCount/totalTokens/totalDurationMs); Bash → generic
  first-3-VISUAL-lines + `… +N lines (ctrl+o to expand)` (use pi's
  importable `truncateToVisualLines`); Bash header wraps to max 2 lines
  ending `…)`. Fold lines: 2-space indent, grey 246, bold numbers,
  capitalized when thinking-less (`Read 1 file (ctrl+o to expand)`).
  ANSI: tool `●` = 256-color 114 success / 211 error; assistant text `●`
  231; `⎿` grey 246 + nbsp; error summaries 211; header name bold,
  paths as OSC 8 file links (phase 4).
- The 2.1.211 surface has NO Glob/Grep/TodoWrite (verified: scenario
  sessions use only Agent/Bash/Edit/Read/Skill/ToolSearch/Write); legacy
  sessions containing Grep etc. fall back to the generic view (claude
  still renders them specially — accepted gap, revisit if diffs demand).
- `tool_use_result` replay path: session entries carry it as
  `toolUseResult`; `entryToSessionMessage`/`SessionMessageOnWire` must
  pass it through (`tool_use_result`) for `toolResultsOf` to attach
  `structured` on replay.
- RESOLVED (Anton, 2026-07-18): the approved `ToolView` interface could
  not express the spec's "Edit's expanded form is the diff" (no
  expanded-rendering hook). Approved amendment: optional
  `expandedBody?(args, result): string | undefined` on `ToolView` —
  generic expanded rendering when absent; implemented ONLY by the Edit
  view. Folded into the type design above.

2026-07-18 (later): Phase 3 implemented — presubmit green (337 tests).
Pieces landed:

- `structured` plumbing: `SessionMessageOnWire` gained
  `tool_use_result?: unknown`, `entryToSessionMessage` passes the entry's
  `toolUseResult` through, and `toolResultsOf` attaches it when the
  message carries exactly one tool_result block.
- `src/tui/tool-views/`: `tool-view.ts` (approved interface + registry +
  `toolViewFor` erasure point) and views agent/bash/edit/read/write;
  `args.ts` holds the shared `stringArg`/`abbreviatePath` helpers —
  split out of tool-view.ts so views need no runtime import from the
  registry that imports them (the cycle made module evaluation
  order-dependent; type-only imports are erased and safe).
- `src/tui/claude-style.ts`: claude's exact 256-color SGR palette
  (114/211/246, bold, dim) for the claude-layout pieces, separate from
  the pi-shaped theme.ts.
- `ToolExecutionComponent` rewritten pi-inspired (removed from
  `update-ports.sh` PORTS): `● Name(arg)` header word-wrapped to ≤2
  lines ending `…)` (6-space continuation), `⎿`+nbsp summary block
  (5-space continuation), generic first-3-visual-lines +
  `… +N lines (ctrl+o to expand)` via pi's `truncateToVisualLines`,
  error summaries colored 211, expanded = pretty args + full result (or
  `expandedBody`). Subagent children hide behind a grey
  `(ctrl+o to expand)` hint line while collapsed (matches claude's Agent
  rendering) and render indented when expanded.
- Folding in `TranscriptRenderer`: top-level content is an ordered item
  list; container children are rebuilt from it on every change, folding
  maximal runs per the spec rule while both toggles are collapsed.
  Durations use the validated timestamp rule; live messages carry no
  timestamp, so arrival time (same wall clock the CLI stamps entries
  with) stands in — durations are therefore available live and replayed.
  A run whose thinking has no usable duration renders "Thought" without
  one; a run of only empty (toolCall-only) assistant messages renders
  nothing. InteractiveMode banners now route through
  `TranscriptRenderer.addBanner` so they keep their position across
  rebuilds.
- Keybindings: `ctrl+o` (tools) / `ctrl+t` (thinking) global toggles in
  InteractiveMode, reapplied to renderers recreated by reloadHistory;
  defaults flipped to collapsed/collapsed everywhere (render-session.ts
  inherits them, so parity captures render the claude-default state).
- The unfolded collapsed-thinking line reuses the ported component's
  hidden-label slot (`Thought for Ns (ctrl+t to show)`), which renders
  italic at 1-space indent — a minor styling divergence from claude's
  grey line, only visible in the tools-expanded/thinking-collapsed
  state (not captured by the harness). Revisit if diffs demand.
- Not yet done (next session): theme-adoption empirical check (import
  pi's theme + getMarkdownTheme, delete the theme.ts shim), harness
  rerun + catalog status updates (part of "close the loop").

2026-07-18 (later still): Phase 4 implemented — presubmit green (338
tests). Harness recaptured before and after (catalog Status section
updated); after phase 4, the thinking scenario's transcript body matches
claude byte-for-byte in the normalized diff, markdown differs only by
the kept fence lines, tools only by the decided Bash-never-folds
divergence, subagent by the `--direct` sidechain gap, slash-command by
phase 5's tag rendering. Pieces landed:

- `UserMessageComponent` rewritten custom (removed from `update-ports.sh`
  PORTS): verbatim text (no Markdown), `❯` gutter fg 239, text fg 231,
  bg 237 band over content cells only, 2-space continuation indent,
  word-wrap via the exported `wrapHeaderArg`, one leading blank line
  (every transcript block leads with one — closes block-spacing's
  double-blank after user messages). OSC 133 zone markers kept.
- `AssistantMessageComponent` port: documented intentional diffs —
  `withClaudeLayout` (bottom of file) overlays a fg-231 `●` gutter on
  text blocks' first line AND renders markdown 2 wider with the trailing
  pad stripped, because pi's `Markdown` reserves paddingX on both sides
  while claude wraps to the right edge (content width 98 at width 100,
  verified against the thinking capture); `outputPad` default 1 → 2
  (claude's continuation/thinking/error indent).
- theme.ts: `codeBlockIndent: ""` — claude keeps code-block content at
  the block indent.
- Empirical check RESULT (fence-stripping): pi-tui `Markdown` pushes
  fence lines unconditionally; an empty `codeBlockBorder` leaves blank
  lines, so eliding fences would mean forking `Markdown`. Per the spec
  instruction the entry is now a recorded divergence in the catalog
  (fences kept).
- Empirical check RESULT (OSC 8, markdown links): pi-tui already emits
  claude-style OSC 8 (text only, URL hidden) when
  `getCapabilities().hyperlinks` — auto-detected, tmux
  client_termfeatures-aware. Nothing to implement; the harness tmux has
  no hyperlink termfeature, so captures show our `text (url)` fallback.
- Empirical check RESULT (theme adoption): pi's `getMarkdownTheme` IS
  importable and byte-identical to our shim's palette after
  `initTheme("dark")`, but the `theme` singleton the ported components
  call (`theme.fg/bg/...`) is NOT re-exported through the package
  entrypoint (same trap as `formatTokens`; deep imports blocked). The
  theme.ts shim stays.
- RESOLVED (Anton approved 2026-07-18, implemented 2026-07-19): claude
  renders tool-header paths as OSC 8 `file://` links (visible in
  tools.claude.ansi). Type amendment: optional
  `headerLink?(args): string | undefined` on `ToolView` returning the
  absolute path; Edit/Read/Write implement it via
  `stringArg(args, "file_path")`. `ToolExecutionComponent.headerLines`
  wraps the header arg in pi-tui's `hyperlink` (URL via `pathToFileURL`)
  only when `getCapabilities().hyperlinks` is on AND the arg fits
  untouched on a single line — `wrapHeaderArg`'s width math and the
  `…)` truncation slice assume no escape bytes. Capability-mode tests
  in `tool-execution.test.ts` via pi-tui `setCapabilities`.

2026-07-18 (later still): Phase 5 implemented — presubmit green (348
tests). After recapture, the slash-command scenario's transcript body
matches claude byte-for-byte. Pieces landed:

- `sdk-render.ts`: `UserTurnView` + `userTurnViews` per the approved
  design, plus one implementation-time amendment (flag for review):
  exported `userTurnViewsFromText(text)` — the same parser on a bare
  string — because slash commands and their stdout ALSO live in
  `system`/`local_command` session entries (empirical: /login and
  /context are system entries; /spec, /keybindings, /compact are user
  messages), which `entryToSessionMessage` drops; `appendPathNode`
  parses those entries' `content` directly. `userTurnViews(message)` =
  the parser over `userText(message)`.
- Empirical tag findings (fixtures in the tests): command tags appear in
  BOTH orders (name-first and message-first) with whitespace between;
  bash output is one message `<bash-stdout>…</bash-stdout>
  <bash-stderr>…</bash-stderr>`; the CLI escapes exactly `<` and `>`
  (raw `&` appears unescaped in captured output), so unescaping is the
  single pass `&lt;`/`&gt;` on extracted tag contents;
  `<local-command-caveat>` renders nothing; context tags: only
  `ide_selection` observed → the known-tag list. Malformed known tags
  fall back to one verbatim prompt view.
- `UserCommandComponent` (new, custom): `❯ /name args` / `❯ ! cmd`
  command line on the user band, output as a `⎿` block sharing the tool
  components' collapse/expand formatting (helpers `collapsedOutputLines`
  / `resultBlockLines` extracted from tool-execution.ts); participates
  in ctrl+o. Standalone outputs render as bare `⎿` blocks.
- Renderer mapping in `TranscriptRenderer`: prompt/contextTag → `❯`
  blocks; slashCommand/bashInput → command items; commandOutput/
  bashOutput attach to the immediately preceding command item (else
  standalone). `system/local_command_output` (steered `!` output) now
  routes through the same attach path instead of a plain Text.
- Two observed suppressions, both claude behavior on the captures:
  /compact's transient stdout ("Not enough messages to compact.") is
  hidden — the success path renders our boundary banner + full summary
  instead; and the CLI-synthesized assistant "No response requested." is
  normalized to an empty message (renders nothing). The spec placed the
  latter in commandOutput, but empirically it is an assistant message.
- Compact summaries: `appendPathNode` renders `entry.isCompactSummary`
  entries as a full markdown block (decided divergence) instead of a `❯`
  prompt; live summaries carry no flag (accepted, replay-only).

- [x] Phase 0: version alignment + port update + `initTheme`
- [x] Phase 1: `TranscriptRenderer` extraction + `render-session.ts` +
      `capture.ts --direct` + first unit-test fixtures
- [x] Phase 2: mitm capture + addon + `generate.ts` + presubmit `--check`
- [x] Phase 3: tool views + diff ports + `ToolExecutionComponent` rework +
      folding + keybindings (theme-adoption check deferred to phase 4's
      markdown work)
- [x] Phase 4: user/assistant gutters, verbatim user text, spacing,
      markdown empirical checks (header-path OSC 8 links landed
      2026-07-19 via the approved `ToolView.headerLink` amendment)
      2026-07-19: Phase 6 implemented — presubmit green (360 tests). Pieces:

- Ports: `core/footer-data-provider.ts` → `src/tui/footer-data-provider.ts`
  and `utils/fs-watch.ts` → `src/tui/fs-watch.ts` @ 0.80.10, both in
  `PORTS`. Intentional diffs (headers): fs-watch none;
  footer-data-provider imports the co-ported fs-watch, node:-prefixed
  builtins, and drops the trailing `ReadonlyFooterDataProvider` alias
  (that type IS exported by pi's entrypoint; consumers import it).
- `FooterComponent` rewritten to the approved shape
  (`constructor(dataProvider | undefined)`, `setState`, `render`); pi's
  `formatTokens`/`formatCwdForFooter` copied in (attributed). Context =
  lastUsage input+cache_read+cache_creation as `NNk (P%)`; window map is
  just the `[1m]` model-id suffix → 1M, else 200k. Right side keeps the
  old footer's `model ?? "default"` convention; context/effort segments
  are omitted when unresolved. The previous footer's activity/queued/
  session segments are gone (activity shows via the Loader; per the
  spec's decided format).
- Mode indicators captured 2026-07-19 via targeted tmux captures on the
  isolated harness config (throwaway script; one claude launch per mode,
  no prompts sent): default `⏸ manual mode on` 246, plan
  `⏸ plan mode on` 73, acceptEdits `⏵⏵ accept edits on` 147, dontAsk
  `⏵⏵ don't ask on` 211, auto `⏵⏵ auto mode on` 220. bypassPermissions
  was NOT spawned (standing constraint); its label and `error` color
  pairing come from the mode table embedded in the claude binary
  (strings dump), and error is already 211 in our captured palette.
  New `claudeStyle` entries: planMode 73, autoAccept 147, warning 220.
- `AgentState.effortLevel` per the approved design: seeded via
  `settingsSeed` (returns `resolved.effective.effortLevel`) with
  spawn-settings precedence applied in the daemon
  (`effortLevelOf(persisted.effort)` — `Options.effort` is the SDK's
  `EffortLevel`, whose `max` has no Settings representation, so an
  explicit `--effort max` leaves the field unset rather than letting
  the settings tier show through); folded from
  `controlApplied apply-flag-settings` (null unsets, absent key keeps).
- Lifecycle amendment (flag for review): the spec said InteractiveMode
  "recreates" the provider on cwd change; the port's own `setCwd()`
  re-runs findGitPaths + watcher setup, so InteractiveMode calls that
  instead of recreating. Provider is created in the constructor from the
  seed cwd (daemon always seeds it; a theoretical cwd-less seed just
  never shows a branch), branch changes request a rerender, and a new
  `InteractiveMode.dispose()` (called from runInteractive's finally)
  disposes it on detach.

2026-07-19 (review round): pictl reviewer 52a4be43 re-reviewed the
headerLink + phase 6 changes. Outcomes:

- headerLink hardened per review (implemented): linking now also
  requires an absolute `headerLink` path and no control bytes
  (`[\u0000-\u001f\u007f-\u009f]`) in the displayed arg — the wire payload is
  untrusted, and an escape-carrying path would otherwise pass the
  single-line equality guard and land inside the OSC 8 link text. A
  second round extended the range to C1 controls (U+0080-U+009F: raw
  CSI/OSC forms terminals may interpret).
  Adversarial tests added (control-byte path, relative path). The
  reviewer's wide-Unicode width point is real but pre-existing: the
  whole header wrap uses char counts (ported claude behavior), and
  linking does not widen anything — not link-specific, left as is.
- Spec type design updated (implemented): `headerLink?` added to the
  Phase 3 `ToolView` interface with its eligibility contract.
- effortLevel fidelity gaps (recorded, NOT implemented — flagged for
  Anton): the reviewer notes two consequences of the spec's accepted
  settingsSeed gap ("the `Options.settings` flag tier has no
  resolveSettings input"): (a) a live `apply-flag-settings` effortLevel
  persists into `PersistedOptions.settings`, which the seed does not
  read, so a daemon restart drops it from AgentState (the query still
  uses it); (b) the approved "null reverts to unset" fold differs from
  the CLI, where clearing the flag tier falls back to lower-tier
  settings. Both follow from the approved design; fixing them means
  parsing `Options.settings` ourselves (a design change). The footer
  shows nothing rather than something wrong in case (a), and case (b)
  self-corrects at the next daemon restart's reseed.

- [x] Phase 5: `userTurnViews` + special-message components + escaping
      bugfix + compact summary markdown
- [x] Phase 6: footer + `FooterDataProvider`/`fs-watch` ports +
      `effortLevel` seed/fold + mode colors capture
- [x] Close the loop: rerun harness captures, verify catalog entries'
      hunks closed, update `diff-catalog.md` statuses (2026-07-19: all
      remaining diff lines are Group E chrome, the recorded fence and
      Bash-fold divergences, and the `--direct` sidechain artifact)

2026-07-19: Anton's review round (TDC comments in ec2f4e1). Implemented:

- `RenderToolResult.structured` renamed `toolUseResult` (camelCase of
  the wire's `tool_use_result`); its doc now points at the per-tool
  *Output types in the SDK's sdk-tools.d.ts
  (`@anthropic-ai/claude-agent-sdk/sdk-tools.js`, types-only subpath).
- `AgentState.effortLevel` is now the SDK's `EffortLevel` union, so a
  spawn `--effort max` is representable; `effortLevelOf` deleted and
  the daemon seed reduced to
  `record.persistedOptions.effort ?? settings.effortLevel`. The
  null-unset fold question (resolve the post-clear effective value
  instead of unsetting) is answered in review discussion but NOT
  implemented — it needs the daemon to resolve settings at
  controlApplied emission (an event-contract design change), Anton's
  call; his TDC stays in agent-state.ts until decided.
- Footer fallbacks: unobserved permissionMode → "? unset mode" in
  warning color; unobserved model → "unset model" (was "default").
- Refusal banners now append the refusal category, explanation, and
  (fallback case) the fallback model to the CLI's content line.
- Compact summary now matches claude: collapsed
  "Compacted (ctrl+o to see full summary)" line, markdown summary when
  expanded; `TranscriptRenderer.setCompactSummaryExpanded` added and
  ctrl+o sets it together with toolsExpanded (compact-boundary catalog
  entry flipped from decided-differ to match).
- Parity capture harness reworked per TDC: `captureClaude` /
  `captureClauctl` split; the clauctl side renders direct by default
  (`--clauctl-in-tmux` for the full end-to-end path, replacing
  `--direct`); the claude side is cached in out/ keyed by a
  session-content hash sidecar (`<name>.claude.meta.json`) and only
  recaptured on content change or `--recapture-claude`; per-subject
  logging names which side was tmux/cached/direct. Iterating on clauctl
  rendering now skips every tmux settle (~0.5s per subject vs tens of
  seconds).
- Fixed a bug from the review commit itself: claude-style.ts's
  rewritten `dontAsk`/`bypassPermissions` colors were missing the SGR
  terminator (`38;5;211` without the trailing `m`), leaking the escape
  prefix into the footer text.
- claude-tools capture.ts header now documents that the built-in tool
  roster is server-gated (statsig `tengu_*` gates consulted by per-tool
  `isEnabled()`), so recaptures on the same pinned binary can add or
  drop tools — the cause of the 26→30 tool growth Anton observed.

2026-07-19 (later): Anton's four follow-up decisions from the review round,
all implemented:

- capture.ts gating doc: the header now says explicitly that gate state
  depends on the capturing account's experiment-group membership — some
  tools exist in the binary but are enabled only for accounts in the
  right group, so a recapture can change tool-schemas.json even when the
  claude version has not changed. Forcing all gates on was investigated
  and dropped: the gates are server-evaluated per account and the binary
  exposes no override mechanism, so the capture tracks the account's
  real tool surface (Anton: acceptable).
- Typed tool outputs: the tool-view narrowing helpers now cast
  `toolUseResult` to the SDK's own output types from the types-only
  subpath `@anthropic-ai/claude-agent-sdk/sdk-tools.js` —
  `FileReadOutput` ("text" variant) in read.ts, `FileEditOutput` in
  edit.ts, `AgentOutput` ("completed" variant) in agent.ts. The casts
  are `Partial<...>` and every field read stays runtime-checked: the
  wire payload is untrusted, so the SDK types name the shape without
  asserting it.
- EffortLevel unification: options.ts's settingsSeed return type uses
  the SDK `EffortLevel` directly (was `AgentState["effortLevel"]`,
  itself already EffortLevel), and EFFORT_LEVELS gained
  `satisfies readonly EffortLevel[]` as a tripwire against SDK union
  drift. Noted: the SDK's own `Settings.effortLevel` is
  'low'|'medium'|'high'|'xhigh' — settings files cannot express "max";
  only the spawn `--effort` flag can.
- Null-unset resolution (the last open TDC): the daemon now resolves an
  apply-flag-settings `effortLevel: null` at controlApplied emission —
  `appliedRequest` in request-handlers.ts emits the concrete post-clear
  level with the same precedence as the AgentState seed (spawn
  `--effort` wins, else the settings cascade), and null survives only
  when neither tier specifies a level. New wire type
  `SdkControlApplied` in sdk-socket.ts (the mutation as broadcast;
  effortLevel widened to full EffortLevel because the flag admits
  "max"); the pure client fold keeps its simple null→unset branch, now
  documented as the "no tier specifies one" case. Two new
  request-handlers tests cover both resolution outcomes (362 total).
  The related restart gap stands (recorded in settingsSeed's doc): a
  live apply-flag-settings persists into `Options.settings`, which
  settingsSeed does not read, so a flag-tier effortLevel is not
  re-seeded after daemon restart.

## 2026-07-20 — Edit diff correction (spec amendment approved by Anton)

Anton reported that Update blocks show only the counts summary where
claude shows the line-numbered diff. Root cause: the phase-3 work-log
claim "NO diff when collapsed (the catalog's line-numbered diff is the
expanded form)" was WRONG — the catalog had it right all along — and the
harness could not catch the divergence because no scenario in the corpus
exercised Edit (the tools scenario uses Write/Read/Bash only), so
edit-diff-view's "hunks closed" held vacuously.

New `edit` scenario added to scenarios.ts; ground truth from its
captures, an import of real session 44a0b993, and a manual ctrl+o tmux
probe (claude 2.1.211):

- The diff renders by default; ctrl+o's verbose view shows the SAME
  diff (only the header path unabbreviates). No Edit-specific expanded
  form exists.
- Replay/resume renders full diffs — no truncation even at 68 lines.
  The truncation Anton saw live is live-rendering-only (a non-goal);
  additionally his session's edits sat behind a compact boundary, which
  resume does not render past.
- Layout: dual file-anchored numbering (old numbers on `-`, new on `+`
  and context), `-` runs grouped before `+` runs, multi-hunk blocks
  separated by a grey `...` line.
- Styling: syntax-highlighted context, red/green background bands,
  intra-line word highlights — all left to the ANSI pass.

Decisions (Anton, 2026-07-20):

- Diffs render by default, matching claude; `expandedBody` replaced by
  `resultBody` (rendered in both toggle states).
- Custom claude-layout formatter from `structuredPatch` instead of pi's
  `renderDiff` — reversing the 2026-07-18 import decision. pi anchors
  numbers by diffing the whole file (unavailable here); using it would
  mean synthesizing `generateDiffString`'s undocumented intermediate
  format, a silent-failure parser coupling, for no substance: the hunk
  walk is ours either way, and 0.80.10's intra-line highlighting did
  not trigger in testing anyway. Custom keeps edit-diff-view a "match"
  (pi layout would put a permanent decided-differ in every capture
  containing an edit) and sits in the claude-derived tool-view layer
  per the delineation principle.
- `structuredPatch` absent/malformed → counts summary only, no diff
  (snippet-relative fallback numbers would be wrong).

Harness notes: scenario regeneration reuses the per-scenario workdir, so
a stale calc.py made prompts no-op (the model pre-implements or declines
edits that are already applied) — the edit workdir was wiped manually
before the final generation; scenario prompts were tightened so each
edit has real work to do. Multi-hunk splitting needs unchanged gaps
wider than 2×3 context lines between occurrences.

- [x] Implement: `resultBody` hook + structuredPatch formatter in
      edit.ts + unit tests (fixture carved from the edit scenario)
- [x] Rerun harness including the edit scenario; update catalog
      (edit.diff: all diff blocks byte-identical; remaining lines are
      the decided Group E chrome + prompt-wrap width)

Accepted divergence (Anton, 2026-07-20): over-width diff lines. claude
wraps them with a gutter continuation (blank number field + repeated
gutter, content capacity ≈ pane − prefix − 1); we wrap at the plain
result indent. Matching would push the render width into `resultBody`
for two lines in a 5000-line session (session-44a0b993 capture).

## 2026-09-03 — decided divergence: transcript glyphs

The transcript's entry-kind glyphs now come from `src/tui/glyphs.ts`,
shared with the session tree (`format tree`, `/tree`): tool-call header
`▸` (claude: `●`, indistinguishable from assistant text) and result
prefix `⤷` (claude: `⎿` + nbsp). Assistant `●` and user `❯` are
unchanged. Same colors, same column widths, so every capture line
containing a tool header or result prefix now differs in that one glyph;
the captures under `scripts/tui-parity/out/` stay claude's output. Spec:
`docs/specs/tree-presentation.md`, "TUI glyph unification".
