# Spec: TUI rendering parity with native claude

> Status: **approved spec, not yet implemented**. Read `docs/specs/tui.md`
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
  name: string;            // slug; output filenames and workdir derive from it
  description: string;     // which rendering features it exercises
  prompts: string[];       // sent sequentially via SDK query(), each awaited to completion
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
  claudeVersion: string;   // provenance: which bundled version produced it
}
// writes out/manifest.json: GeneratedSession[]
```

```ts
// capture.ts — entry point: node scripts/tui-parity/capture.ts [scenario…]
export function resolveBundledClaude(): string;
// → node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude

export interface CaptureTarget {
  command: string[];       // claude --resume <id>, or the clauctl spawn/attach sequence
  cwd: string;
}
export interface PaneSize { cols: number; rows: number }

// Launches the target in a fresh tmux session of fixed size, polls
// capture-pane with backoff until the *normalized* capture is identical for
// K consecutive polls (hard timeout), then captures once plain and once
// with -e. captureInTmux calls normalize for settle detection.
export async function captureInTmux(
  target: CaptureTarget,
  size: PaneSize,  // TDC: we should `capture-pane -S -`, so really only the number of columns matter
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

- **Does `claude --resume` + exit leave the session file untouched?**
  Believed yes. Verify with a checksum before/after during harness bring-up;
  if it appends, capture clauctl first or resume from a copy.
- The exact clauctl-side command sequence for `CaptureTarget` (spawn with
  `--resume`, then attach in the pane; daemon lifecycle around it) — settle
  during harness bring-up.
- The shortcut table below is agent-sourced; verify against the bundled
  2.1.211 binary's `?` panel before the follow-up specs rely on it.

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
- [ ] Add `scripts/tui-parity/out/` to `.gitignore` (currently absent)
- [ ] Harness: scenarios.ts + generate.ts
- [ ] Harness: capture.ts (resolveBundledClaude, captureInTmux, normalize)
- [ ] Verify `claude --resume` leaves session file untouched
- [ ] Verify shortcut table against bundled binary's `?` panel
- [ ] Initial corpus generation + first diff run
- [ ] Diff catalog in docs/derisk/tui-parity/ with triage decisions
- [ ] Rendering fixes (one catalog entry at a time, each with type-design
      check-in and unit test)
- [ ] ANSI/coloration pass
