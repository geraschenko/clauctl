# Spec: TUI rendering parity with native claude

> Status: **implemented.** Read `docs/specs/tui.md`
> first — this spec builds a comparison harness _around_ the TUI that spec
> describes, plus the process for closing rendering differences it surfaces.

# SPEC

## Problem statement

The clauctl TUI (`src/tui/`) reimplements claude's interactive UI on top of
the sdk.sock stream. Its rendering currently differs from native claude in
many small ways. We want the transcript rendering to closely match native
claude, with intentional differences (e.g. clauctl showing token usage) as
small, documented tweaks on top of a faithful baseline.

The deliverables of this spec:

1. **A capture harness** (`scripts/tui-parity/`) that generates a reproducible
   corpus of claude sessions, renders each session in both native claude and
   the clauctl TUI inside tmux, captures both panes, normalizes the captures,
   and diffs them.
2. **A diff catalog** (`docs/derisk/tui-parity/`) recording each observed
   difference and its triage decision: _match claude_ / _intentionally
   differ_ / _skip_.
3. **Rendering parity fixes** driven by the catalog, applied as incremental
   changes to `src/tui/` — each fix gets its own type-design check-in before
   implementation (see "Process for fixes" below).

Keyboard-shortcut parity and claude's ctrl+o transcript-viewer mode are
**out of scope** — they get their own follow-up specs. This spec carries the
shortcut inventory (IMPLEMENTATION IDEAS → "Keyboard shortcuts") as the
starting point for those specs.

## Parity target

The reference is the claude binary **bundled with clauctl's pinned SDK**: the
platform-specific optional dependency
`node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`
(currently 2.1.211, matching `@anthropic-ai/claude-agent-sdk` 0.3.211). The
harness resolves this binary — never `claude` from PATH — so the comparison
is always against exactly what clauctl runs. After an SDK version bump, the
whole diff can be rerun cheaply: regenerate the corpus (or reuse existing
session files) and re-capture.

## What is committed to git

- The harness code and the scenario definitions (the corpus is _specified_
  in git and _materialized_ locally).
- The diff catalog and triage decisions.
- Unit tests for rendering, using **synthetic fixtures only**.

Not committed: session files, captures, diffs — they contain conversation
content. All harness output lives in the gitignored `scripts/tui-parity/out/`.

## Theme and ANSI scope

The clauctl TUI hardcodes a dark theme for now; that stays. Captures are
taken both plain and with ANSI (`tmux capture-pane -e`) from day one, but
diffing and triage start on the plain captures. Matching coloration,
bold/italic etc. is in scope as a **later pass** over the same stored ANSI
captures — structure and layout first.

## Success criteria

- `node scripts/tui-parity/generate.ts` produces the session corpus from the
  scenario definitions and writes `out/manifest.json`.
- `node scripts/tui-parity/capture.ts` produces, for every manifest entry,
  normalized plain captures and raw ANSI captures for both TUIs, and prints
  a diff summary.
- Re-running capture on an unchanged corpus is deterministic: same normalized
  captures, same diffs (this is what makes the loop cheap — generation costs
  API calls once; capture/diff is free to repeat).
- The diff catalog exists with every observed difference triaged.
- Each "match claude" catalog entry is closed by an incremental fix in
  `src/tui/`, locked in by a rendering unit test with synthetic fixtures.

## Type design (harness)

All in `scripts/tui-parity/`, dev-only TypeScript run via node's native
type-stripping (like the test suite). Nothing in `src/` changes in the
harness phase.

```ts
// scenarios.ts — the committed corpus definition
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export interface Scenario {
  name: string; // slug; output filenames and workdir derive from it
  description: string; // which rendering features it exercises
  prompts: string[]; // sent sequentially via SDK query(), each awaited to completion
  options?: Partial<Options>; // SDK overrides (model, maxThinkingTokens, …)
}
export const scenarios: Scenario[];
```

```ts
// generate.ts — entry point: node scripts/tui-parity/generate.ts [scenario…]
// Runs each scenario through the SDK in a fixed per-scenario workdir
// (out/workdir/<name>, so --resume finds the session by cwd), then records:
export interface GeneratedSession {
  scenario: string;
  sessionId: string;
  cwd: string;
  claudeVersion: string; // provenance: which bundled version produced it
}
// writes out/manifest.json: GeneratedSession[]
```

```ts
// capture.ts — entry point: node scripts/tui-parity/capture.ts [scenario…]
export function resolveBundledClaude(): string;
// → node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude

export interface CaptureTarget {
  command: string[]; // claude --resume <id>, or the clauctl spawn/attach sequence
  cwd: string;
}
// Launches the target in a fresh tmux session `cols` wide, polls
// `capture-pane -S -` (full scrollback — pane height is an internal
// constant, irrelevant to captured content) with backoff until the
// *normalized* capture is identical for K consecutive polls (hard timeout),
// then captures once plain and once with -e. captureInTmux calls normalize
// for settle detection.
export async function captureInTmux(
  target: CaptureTarget,
  cols: number,
): Promise<{ plain: string; ansi: string }>;

// Strips animated/unstable regions: spinner frames, cursor, trailing
// whitespace, session ids and absolute paths.
export function normalize(capture: string): string;
```

Per-scenario outputs in `out/`: `<name>.claude.txt` / `<name>.clauctl.txt`
(normalized plain), `<name>.claude.ansi` / `<name>.clauctl.ansi` (raw).

## Process for fixes

Rendering fixes are exploratory by nature — the diff catalog dictates them,
so their type design cannot be pinned here. Each fix follows the normal
incremental flow: catalog entry → agreed type design (a check-in, recorded in
`docs/derisk/tui-parity/`) → implementation → rendering unit test → re-run
capture to confirm the diff closed.

## Edge cases and non-goals

- **Resume-vs-resume is the baseline.** Both TUIs render a _cold_ session
  file. Live-streaming rendering parity is a smaller follow-up check, not
  part of this spec's success criteria.
- **Regeneration nondeterminism is fine.** Regenerating the corpus changes
  the conversation content, but every diff compares claude-vs-clauctl on the
  same session file, so the comparison stays valid.
- **Light theme**: out of scope (dark hardcoded).
- **Vim-mode keybindings**: excluded even from the shortcut inventory.
- **Not a shipped feature**: the harness is never part of the published
  package (`files` only ships `dist`).

# IMPLEMENTATION IDEAS

## Derisk findings (verified)

- The bundled binary is the platform optional dep
  `@anthropic-ai/claude-agent-sdk-linux-x64/claude` (etc.); verified runnable,
  reports `2.1.211 (Claude Code)`. `extractFromBunfs` is only for bunfs
  builds — no extraction dance needed for npm installs.
- clauctl pins `pathToClaudeCodeExecutable` as an SDK-default invariant
  (`src/core/options.ts`), so SDK-spawned sessions and the harness's
  interactive reference use the same binary.
- Node 22.18+ runs `.ts` directly (the test suite already relies on this),
  so the harness needs no build step.

## Open verification items

- ~~Does `claude --resume` + exit leave the session file untouched?~~
  **Resolved: NO, but the mutation is convergent and harmless.** A full
  interactive resume (render + exit, nothing sent) appends metadata entries,
  no conversation entries: resume 1 appends `ai-title` + `agent-name`,
  resume 2 appends `mode` + `permission-mode`, resume 3+ append nothing.
  Normalized captures were verified deterministic both across
  restore-from-pristine runs and across converged-file runs, so the
  metadata doesn't change anything we observe. Capture therefore renders
  the live file with no restore; the generation-time snapshot in
  `out/sessions/` is kept only as a manual-recovery point (e.g. a prompt
  accidentally typed into a corpus session during triage).
- ~~The exact clauctl-side command sequence~~ **Resolved**: `spawn --cwd
<workdir> --id <uuid> -- --resume <sessionId>` (outside the pane; exits
  when sdk.sock is ready), `attach -t <uuid>` inside the pane, `archive -t
<uuid>` for cleanup. Verified none of these steps mutate the session file.
  No tension with the point above: the daemon's streaming Query never
  initializes before the first turn (exactly the blocker below), so its
  wrapped `--resume` never reaches the interactive CLI's first-open
  bookkeeping that appends those metadata entries.
- The shortcut table below is agent-sourced; verify against the bundled
  2.1.211 binary's `?` panel before the follow-up specs rely on it.

## Blocker found: clauctl renders resumed history as empty

`clauctl spawn -- --resume <id>` + `attach` shows an empty transcript. The
daemon starts its streaming-input `query()` at spawn, but a streaming Query
only initializes on its first turn (`set-context.ts` notes this), so
`events.agentState.sessionId` stays undefined and the daemon's `get-messages`
handler (`request-handlers.ts`) returns `[]` until the first prompt. Every
scenario's clauctl capture is currently just rules + footer.

Candidate fix (needs approval — it is a `src/` change outside this spec's
harness phase): seed the daemon's event hub with the resume session id from
`spawn-options.json`, the same seeding revival already does with the last
recorded session, so `get-messages` can serve the resumed transcript before
the first turn. This is a genuine product gap, not just a harness obstacle:
any user attaching to a freshly spawned `--resume` agent sees nothing.

**Approved and implemented** (daemon.ts): the AgentState seed now uses
`resumeSessionId`, which equals the last recorded session on revival
(unchanged behavior) and `spawn-options.json`'s resume id on fresh spawn —
so the file-derived seed and get-messages serve the resumed transcript
before the first turn. Validated by the 2026-07-16 capture rerun: all five
clauctl-side captures now render the resumed transcript.

## Design notes

- **Settle detection** runs `normalize` first, so spinner/cursor animation
  can't defeat the stability check. Polling with backoff + hard timeout is
  the sanctioned pattern here (no external "render finished" signal exists).
- **Cost model**: generation is the only step that costs API calls; capture
  and diff are free to repeat indefinitely. Scenarios pin cheap models via
  `options` except where the scenario specifically exercises thinking or
  subagent output.
- Initial corpus should cover at least: plain markdown response, thinking
  blocks, tool calls with short and long outputs, subagent (Task) nesting,
  an interrupted turn, a compaction boundary, slash-command output.
- Normalized claude captures can _inform_ rendering unit tests, but their
  content is never committed — tests reconstruct the relevant shape with
  synthetic fixtures.
- Later ANSI pass: diff the `.ansi` captures (or a normalized form of them)
  once plain-text parity is done; theme/bold/italic differences land in
  `src/tui/theme.ts` and the components.

## Keyboard shortcuts (starting point for follow-up specs)

Inventory of native claude 2.1.x shortcuts (agent-sourced from docs and the
in-app `?` panel; **verify against the bundled binary before use**; vim mode
excluded). Follow-up specs will turn this into a decision table
(match / intentionally differ / skip) and cover the transcript viewer.

Notable for planning: **ctrl+o is a full transcript-viewer mode** in 2.1.x
(with its own sub-mode keys), not a simple verbose toggle. The clauctl TUI is
retained-mode (components stay alive in `chatContainer`), so view modes can
re-render existing components against a shared render-options value — no
transcript replay needed.

| Shortcut                                      | Behavior                                                                                | Mode/Context          |
| :-------------------------------------------- | :-------------------------------------------------------------------------------------- | :-------------------- |
| Ctrl+C                                        | Interrupt running operation; first press clears input, second press exits               | Anytime               |
| Ctrl+D                                        | Exit session (two presses within 800ms); deletes char after cursor if prompt has text   | Anytime               |
| Ctrl+L                                        | Redraw screen                                                                           | Anytime               |
| Ctrl+O                                        | Toggle transcript viewer (tool usage, timestamps, model per message, expands MCP calls) | Anytime               |
| Ctrl+E                                        | Move cursor to end of logical line                                                      | Text editing          |
| Ctrl+R                                        | Reverse search command history (100 most recent unique prompts)                         | Anytime               |
| Ctrl+T                                        | Toggle task checklist (to-do view in status area)                                       | Anytime               |
| Ctrl+V / Cmd+V (iTerm2) / Alt+V (Windows/WSL) | Paste image from clipboard; inserts `[Image #N]` chip                                   | Anytime               |
| Ctrl+B                                        | Background running Bash/agents (press twice under tmux)                                 | During tool execution |
| Ctrl+G / Ctrl+X Ctrl+E                        | Open prompt in external editor                                                          | Anytime               |
| Ctrl+K / Ctrl+U / Ctrl+W                      | Delete to line end / to line start / previous word (kill ring)                          | Text editing          |
| Ctrl+Y, then Alt+Y                            | Paste deleted text; cycle paste history                                                 | Text editing          |
| Ctrl+A                                        | Move cursor to start of line                                                            | Text editing          |
| Ctrl+J / Shift+Enter / \ + Enter              | Newline for multiline input (Shift+Enter needs terminal support)                        | Multiline input       |
| Esc                                           | Interrupt mid-turn; close open dialog                                                   | Anytime               |
| Esc Esc                                       | Clear input draft (saved to history); or open rewind menu if input empty                | Anytime               |
| Shift+Tab / Alt+M                             | Cycle permission modes                                                                  | Anytime               |
| Up/Down, Ctrl+P/Ctrl+N                        | Move within multiline input; at edge, navigate history                                  | Text input            |
| Alt+B / Alt+F                                 | Move cursor back/forward one word                                                       | Text editing          |
| Alt+P                                         | Switch model                                                                            | Anytime               |
| Alt+T                                         | Toggle extended thinking                                                                | Anytime               |
| Alt+O                                         | Toggle fast mode                                                                        | Anytime               |
| Tab                                           | Accept suggestion; `@` path autocomplete; exit reverse search                           | Anytime               |
| `/` at start                                  | Command/skill menu                                                                      | Prompt input          |
| `!` at start                                  | Shell mode                                                                              | Prompt input          |
| `@`                                           | File path autocomplete                                                                  | Prompt input          |
| `?` on empty input                            | Toggle shortcut help panel                                                              | Anytime               |
| Ctrl+X Ctrl+K                                 | Stop all background subagents (twice within 3s)                                         | Subagents running     |
| Transcript viewer: Ctrl+E                     | Toggle show-all content                                                                 | Viewer open           |
| Transcript viewer: q / Ctrl+C / Esc           | Exit viewer                                                                             | Viewer open           |
| Transcript viewer: `{` / `}`                  | Jump to previous/next user prompt                                                       | Viewer (fullscreen)   |
| Transcript viewer: `[`                        | Write conversation to scrollback                                                        | Viewer (fullscreen)   |
| Transcript viewer: v                          | Open conversation in $VISUAL/$EDITOR                                                    | Viewer (fullscreen)   |

Current clauctl bindings for comparison (`interactive-mode.ts`): esc =
interrupt while busy; shift+tab = cycle permission mode; ctrl+c ×2 = detach
(or detach hint under `--managed`); editor keys are whatever pi-tui's Editor
provides.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] 2026-07-16 Derisk: located bundled binary (platform optional dep,
      2.1.211), confirmed node-runs-ts, gathered shortcut inventory, agreed
      harness type design. Decisions: generated (not pre-existing) sessions as
      the corpus; sessions/captures never committed; plain-text diff before ANSI;
      shortcuts and view modes deferred to follow-up specs.
- [x] Add `scripts/tui-parity/out/` to `.gitignore`
- [x] Harness: scenarios.ts + generate.ts
- [x] Harness: capture.ts (resolveBundledClaude, captureInTmux, normalize)
- [x] Verify `claude --resume` leaves session file untouched → it does NOT
      (see Open verification items); snapshot/restore added in response
- [ ] Verify shortcut table against bundled binary's `?` panel
- [x] Initial corpus generation + first diff run (5 scenarios; claude side
      renders fully, clauctl side blocked on the resumed-history gap)
- [x] Resolve the clauctl resumed-history blocker (approved via TDC;
      daemon.ts seed now uses resumeSessionId) — validated by capture rerun
- [x] 2026-07-16 TDC round follow-up: `dontAsk` denied tools during
      generation, fixed with per-scenario `allowedTools` (tools: Write/Read/
      Bash; subagent: Task/Bash/Glob/Read) — `auto` mode rejected because the
      claude footer reports "auto mode unavailable for this model" on haiku.
      Corpus regenerated (0 denials) and capture rerun end-to-end: both sides
      render on all 5 scenarios; diffs are 89/30/123/40/39 lines
      (markdown/thinking/tools/subagent/slash-command) — triage is next
- [x] 2026-07-17 TDC round: mutation frequency verified (convergent — see
      Open verification items), snapshot RESTORE removed from capture in
      response (snapshot kept as manual-recovery point); claude config dir
      isolated to `~/.cache/clauctl-tui-parity/config` seeded from the real
      credentials + `~/.claude.json` (verified: headless generation and
      interactive resume both work in the isolated dir; unseeded dirs block
      on the onboarding wizard). The seed drops the user's per-project map
      (foreign MCP servers, history — isolation hygiene). Separately, claude
      shows an auth-state-dependent "⚠ N MCP servers need authentication"
      line sourced from ACCOUNT-level (claude.ai) connectors, which no local
      config isolation can remove — normalize() strips it. Corpus
      regenerated in the isolated dir; capture rerun repeatedly — diff
      bodies byte-identical across runs (determinism criterion holds
      without restore; diffFiles uses --label so diff headers carry no
      mtimes)
- [x] 2026-07-17 `--session` on a large LIVE session (this harness's own
      conversation) surfaced three failure modes, all fixed: (1) resuming a
      near-context-limit session auto-compacts on open (animated progress →
      settle timeout; also rewrites the transcript and burns tokens) →
      `DISABLE_AUTO_COMPACT=1` in `claudeEnv` (renamed from
      `claudeConfigEnv`), applied to every claude invocation; (2) a
      first-open "Try the new fullscreen renderer?" upsell whose DEFAULT
      answer opts into a different renderer → suppressed via
      `fullscreenUpsellSeenCount: 3` in the seeded `.claude.json` (the
      binary shows it until seenCount ≥ 3), never dismissed generically;
      (3) dialog detection matched "Enter to confirm" anywhere in the
      scrollback, but a transcript ABOUT this harness quotes that string →
      detection now anchors on the last non-blank line of the visible
      viewport, where a live modal's hint always sits and below which
      quoted text always has claude's footer. This session (2700+ diff
      lines) now captures in ~9s.
- [ ] Rework the slash-command scenario: `/compact` via SDK query() passed
      through with no compaction (probably a no-op on a 2-turn session), so
      the corpus has no compact-boundary coverage yet
- [x] 2026-07-17 Capture-time breakdown measured (markdown, warm): claude
      pane 4.0s / spawn 0.4s / clauctl pane 2.5s / archive 0.3s; ~2.4s per
      pane is the settle-confirmation floor (3 identical polls with
      backoff). Decision (Anton): acceptable — don't tune the settle loop.
      The likely future shape instead: render the claude side ONCE per
      session (it's the fixed reference), and add clauctl instrumentation
      to render a session file directly without spawn/attach (no
      interaction happens, and the session file fully determines the
      render); and/or carve claude captures into lines per logical message
      and unit-test clauctl's rendering of the same messages. Direction for
      the upcoming rendering-parity spec.
- [ ] Diff catalog in docs/derisk/tui-parity/ with triage decisions
- [ ] Rendering fixes (one catalog entry at a time, each with type-design
      check-in and unit test)
- [ ] ANSI/coloration pass

## Implementation-Time Decisions (2026-07-16, harness bring-up)

- **Workdirs live outside the repo**
  (`~/.cache/clauctl-tui-parity/workdir/<name>`, exported as `workdirBase`),
  not under `out/` as originally sketched. Inside the repo, claude walks up
  to clauctl's own CLAUDE.md, which pollutes generated sessions with
  clauctl's instructions and triggers the external-import trust dialog on
  every interactive resume.
- **Session snapshots** (`GeneratedSession` gained `sessionFilePath` and
  `snapshotPath`): generation copies the pristine session file to
  `out/sessions/<name>.jsonl`. Originally capture also restored it before
  rendering each side; the restore was removed once the mutation was shown
  to be convergent metadata with no capture impact (see Open verification
  items). The snapshot remains as a manual-recovery point.
- **Isolated claude config dir** (2026-07-17, per review):
  `~/.cache/clauctl-tui-parity/config`, used by every claude invocation in
  the harness — SDK generation (`env` option), the interactive claude pane,
  and the clauctl daemon's claude child — so generated sessions never
  pollute the user's `~/.claude`. `ensureClaudeConfigDir()` seeds it once
  from `~/.claude/.credentials.json` + `~/.claude.json` (login and
  onboarding state; a bare dir blocks interactively on the onboarding
  wizard) and never overwrites — claude refreshes tokens and records trust
  in the copies. Delete the dir to re-seed. The seeded `.claude.json` gets
  `projects: {}` — the harness has no business inheriting the user's
  per-project MCP servers or history, and trust state for the harness
  workdirs is re-recorded by the dialog-dismissal loop anyway.
- **Real-session capture** (2026-07-17, per review): `capture.ts --session
<id-or-jsonl-path>` imports a COPY of a real session into the isolated
  config dir (cwd read from the session's own entries; bare ids searched
  under the real `~/.claude/projects`) and runs the same capture/diff as a
  scenario, as `out/session-<id8>.*`. The original file is never opened by
  either TUI. This is the path for turning unexpected rendering in
  day-to-day sessions into comparison cases. Internally `captureSubject`
  now takes a `CaptureSubject` (name/sessionId/cwd) fed by either the
  manifest or the import.
- **Dialog dismissal inside captureInTmux**: a pane that settles on a screen
  containing "Enter to confirm" gets Enter sent (accepting the default) and
  the settle loop restarts, bounded at 3 dialogs. Trust answers persist per
  directory in ~/.claude.json, so this normally fires once per workdir.
- **`scripts/tui-parity/tsconfig.json`** (extends the root config, noEmit):
  the root tsconfig only includes `src/`, so the harness gets its own config
  for `npx tsc -p scripts/tui-parity`. Not wired into presubmit.
- **Isolated clauctl registry at `/tmp/clauctl-tui-parity`** (per review):
  spawn/attach/archive all run with `CLAUCTL_DIR` pointing there (the attach
  pane gets it via `tmux new-session -e`), so harness agents never touch the
  real registry. /tmp keeps agentDir/sdk.sock inside the unix socket path
  budget, which an `out/`-based registry would exceed. Agents are still
  archived after capture. (`CaptureTarget` gained an optional `env` field
  for the pane environment.)
