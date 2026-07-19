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
  lines.
- `capture.ts --direct` produces the clauctl side without spawning a
  daemon, and its output matches what attach renders for the same session
  (verified once against a tmux capture, then relied upon).
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

Approved 2026-07-18. New/changed symbols only; phases are ordered.

### Phase 1 — render-from-file instrumentation

`src/tui/transcript.ts` (new): the message→component dispatch extracted
from `interactive-mode.ts` so attach and file-render share it exactly
(single source of truth for transcript rendering):

```ts
export class TranscriptRenderer {
  constructor(container: Container);
  /** Fold one SDK message into transcript components (the dispatch attach uses). */
  append(message: SDKMessage): void;
  setToolsExpanded(expanded: boolean): void; // fans out to ToolExecutionComponents
  setShowThinking(show: boolean): void; // fans out to AssistantMessageComponents
  // internally owns: toolComponents: Map<string, ToolExecutionComponent>
}
```

`InteractiveMode` keeps streaming/pending/status handling and delegates
its transcript cases to `TranscriptRenderer`.

`scripts/tui-parity/render-session.ts` (new):

```ts
export function renderSessionFile(sessionFilePath: string, width: number): string[];
```

Reuses the daemon's own seeding path: `readSessionEntries` →
`pathToLeaf` → `entryToSessionMessage` → `TranscriptRenderer`.
`capture.ts` gains `--direct`: the clauctl side comes from
`renderSessionFile`; the claude side is unchanged (tmux).

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
- `scripts/claude-tools/generate.ts` — `json-schema-to-typescript` over
  the schemas → `src/tui/tool-views/generated.ts`: one input interface
  per tool (`WriteInput`, `BashInput`, …), `export type ToolName = …`
  union, `export const TOOL_NAMES: readonly ToolName[]`. `--check` mode
  regenerates and diffs (presubmit, same pattern as
  `sync-from-pictl.mjs --check`).

### Phase 3 — per-tool views (Group B)

`src/tui/tool-views/tool-view.ts` (new):

```ts
export interface ToolView<A> {
  /** Header arg, e.g. "~/notes.txt" for Write; undefined → bare name. */
  headerArg(args: A, cwd: string | undefined): string | undefined;
  /** Collapsed ⎿ summary; undefined → generic first-line + "… +N lines". */
  resultSummary(args: A, result: RenderToolResult): string | undefined;
  /** Folds into the "Thought for Ns, read 1 file" line. */
  readOnly: boolean;
  /** Fold-line contribution, e.g. (2) => "read 2 files". */
  foldLabel(count: number): string;
}
export const toolViews: { [K in ToolName]?: ToolView<InputFor<K>> };
export function toolViewFor(name: string): ToolView<unknown> | undefined;
```

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
`⎿ summary`; expanded shows full args/output (existing `setExpanded`).

Folding (in `TranscriptRenderer`): consecutive thinking + readOnly tool
calls collapse to one line — `Thought for Ns, read 2 files` — duration
derived from session-entry timestamps when available, else omitted
(`Thought (ctrl+t to show)`). This is our own rule, not a
reverse-engineering of claude's classifier (approved divergence).

Keybindings in `InteractiveMode`: `ctrl+o` toggles tool output expanded,
`ctrl+t` toggles thinking shown.

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

HTML-entity unescaping happens here (fixes the double-escaping bug).
Compact summaries render in full through `Markdown` (decided).
`TranscriptRenderer` maps each view kind to a component: prompt/
contextTag → `❯` blocks, slashCommand → `❯ /name args` +
`⎿ output` when present, bashInput/bashOutput → `❯`-style command +
collapsed output.

### Phase 6 — footer

```ts
// src/tui/components/footer.ts becomes pi-layout-shaped:
export class FooterComponent {
  constructor(branchWatcher: GitBranchWatcher | undefined);
  setState(state: AgentState): void;
  render(width: number): string[];
  // line 1: cwd (branch)
  // line 2: permission mode left (claude's per-mode colors) …
  //         context usage • model • thinking level right
}

// src/tui/git-branch.ts (new, pi FooterDataProvider subset, ported):
export class GitBranchWatcher {
  constructor(cwd: string);
  getBranch(): string | null;
  onChange(callback: () => void): void;
  dispose(): void;
}
```

Context usage from the existing `AgentState.lastUsage` (input + cache
tokens ≈ current context size); pi's cumulative session counters and
cost are skipped (decided). Shown as raw `NNk`, with a percent only if
window size is cheaply available (small model→window map, default 200k).
Mode colors: `auto` = 256-color 220 (gold), manual/default grey 246;
remaining modes captured during implementation.

### Phase order

1 → 2 → 3 → 4/5 (independent of each other) → 6.

## Edge cases

- Tool result for an unknown `toolCallId` (subagent-routed or replay
  races): keep current behavior (generic rendering under the owning
  component or dropped, as today).
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
  pi-coding-agent for later phases: `truncateToVisualLines`, `keyHint`,
  `formatTokens`, `formatCwdForFooter`.
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

- [ ] Phase 1: `TranscriptRenderer` extraction + `render-session.ts` +
      `capture.ts --direct` + first unit-test fixtures
- [ ] Phase 2: mitm capture + addon + `generate.ts` + presubmit `--check`
- [ ] Phase 3: tool views + diff ports + `ToolExecutionComponent` rework +
      folding + keybindings
- [ ] Phase 4: user/assistant gutters, verbatim user text, spacing,
      markdown empirical checks
- [ ] Phase 5: `userTurnViews` + special-message components + escaping
      bugfix + compact summary markdown
- [ ] Phase 6: footer + `GitBranchWatcher` + mode colors capture
- [ ] Close the loop: rerun harness captures, verify catalog entries'
      hunks closed, update `diff-catalog.md` statuses
