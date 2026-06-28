# TUI parity diff catalog

Derisk artifact for the rendering-parity spec (parent:
`docs/specs/tui-parity.md`). Each entry is one logical rendering difference
between native claude and clauctl attach, distilled from the harness captures
(`scripts/tui-parity/out/*.diff`) of claude v2.1.211 on 2026-07-17. Sources:
the five generated scenarios plus real sessions 723ff026 (small) and 078b1e79
(large).

Side-by-side examples for every entry: `diff-catalog.html` (open in a
browser). Examples are verbatim excerpts from the captures.

Triage values:

- **match** — clauctl should render like claude
- **differ** — intentional clauctl difference; keep, and normalize or accept
  in the diff
- **skip** — not worth doing now
- **investigate** — behavior not yet fully observed; needs a targeted capture

Triage reviewed and approved by Anton (2026-07-17/18); the "proposed"
columns below are the decided values. Implementation spec:
`docs/specs/tui-rendering-parity.md`.

Status (2026-07-19 recapture, all spec phases 0–6 complete): Groups B,
A, and D are implemented and match in the scenario captures; the
thinking and slash-command scenarios' transcript bodies are
byte-identical to claude in the normalized diff. The phase-6 footer
(claude-style two-line cwd/mode/context footer with the captured
per-mode colors) is implemented but outside these diffs by construction:
the default direct render is the transcript only, and the remaining Group E chrome
(welcome banner, input box, claude's shortcut hints) is decided-differ.
Remaining scenario diff lines are exactly: that Group E chrome, the kept
code fences (Group C, recorded divergence below), the decided
Bash-never-folds divergence (tools scenario), and one harness artifact:
the direct render covers the main chain only, so sidechain (subagent) children
are absent and the Agent tool's `(ctrl+o to expand)` hint line — shown
only when hidden children exist — does not appear; live attach shows it.
Tool-header file paths additionally render as OSC 8 links when the
terminal supports hyperlinks (invisible in these captures: the harness
tmux advertises no hyperlink termfeature).

Status (2026-07-20): edit-diff-view verified against the new `edit`
scenario (mid-file hunk, replace_all, long diff, multi-hunk) — the
line-numbered diff now renders by default beneath the summary, and every
diff block in `edit.diff` is byte-identical to claude; the remaining
differing lines are the decided Group E chrome.

## Group B — collapsing & tool rendering (highest visual impact)

| id                    | claude                                                                                                                                 | clauctl                                                                     | proposed |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| thinking-collapse     | collapses thinking to italic `Thought for 3s (ctrl+o to expand)`                                                                       | full thinking text inline                                                   | match    |
| tool-call-header      | `● ToolName(primary arg)` one-liner, e.g. `● Write(~/notes.txt)`, `● Bash(cmd…)`                                                       | bare tool name, then raw JSON input (6-line truncation)                     | match    |
| tool-result-collapse  | `⎿  <one-line summary>` (e.g. blank, `Added 1 line`, first line + `… +14 lines (ctrl+o to expand)`)                                    | raw result text, truncated at ~6 lines with `… (+N more lines)`             | match    |
| readonly-tool-folding | consecutive thinking + read-only tools fold into one line: `Thought for 4s, searched for 2 patterns`, `Read 1 file (ctrl+o to expand)` | every tool call rendered individually                                       | match    |
| edit-diff-view        | `● Update(path)` + `⎿  Added N lines, removed M lines` + line-numbered diff with `+`/`-` gutters                                       | raw JSON with `\n`-escaped old_string/new_string                            | match    |
| subagent-summary      | `● Agent(description)` + `⎿  Done (2 tool uses · 16.8k tokens · 14s)`                                                                  | raw Task JSON input + raw subagent result (incl. agentId continuation hint) | match    |
| tool-error-summary    | `⎿  Error writing file` (styled)                                                                                                       | raw `<tool_use_error>…</tool_use_error>` text                               | match    |

Notes:

- readonly-tool-folding implies a classification of tools (read-only vs
  mutating) and a summarizer per tool (`read 1 file`, `searched for 2
patterns`). The exact folding rules need enumeration during type design —
  e.g. claude gave the failed `Write` its own `●` block but folded the
  following `Read` into the next `Thought for` line. Decided divergence:
  we use our own folding rule (spec phase 3), not claude's classifier; in
  particular Bash never folds, though claude sometimes folds
  read-only-looking bash commands.
- Keybinding divergence (decided, Anton): claude's `ctrl+o` expands both
  tools and thinking; we split — `ctrl+o` toggles tool output, `ctrl+t`
  toggles thinking — so collapsed-thinking hint text reads
  `(ctrl+t to show)` where claude's reads `(ctrl+o to expand)`.
- tool-result summaries are per-tool: Write → blank/error, Edit → added/
  removed counts, Bash → first output line + `… +N lines`, Agent → Done
  stats. This is the largest single work item in the catalog.

## Group A — message chrome

| id               | claude                                                     | clauctl                                                | proposed |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------ | -------- |
| user-gutter      | `❯` prefix, continuation lines indented 2                  | no prefix, 1-space indent                              | match    |
| user-verbatim    | user text shown verbatim (`**bold**`, backticks preserved) | user text rendered as markdown                         | match    |
| assistant-gutter | `●` prefix on first block line, continuation indented 2    | no prefix, 1-space indent                              | match    |
| block-spacing    | exactly one blank line between blocks                      | inconsistent (e.g. two blank lines after user message) | match    |

## Group C — markdown body

| id                   | claude                                                             | clauctl                                                   | proposed                       |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------ |
| code-fence-stripping | fence markers stripped, content syntax-highlighted at block indent | `` ```ts `` fences kept, content extra-indented           | differ (see note)              |
| heading-style        | bold white, `##` stripped                                          | bold yellow, `##` stripped                                | match (color part → ANSI pass) |
| link-render          | OSC 8 hyperlink: link text only, target invisible                  | `text (target)` with underline                            | match                          |
| inline-style         | bold `[1m`, italic `[3m`, inline code 256-color 153, no background | bold/italic same; truecolor palette with background fills | ANSI pass                      |

Tables and bullet lists already match (see markdown scenario).

Notes:

- code-fence-stripping (empirical check, phase 4): pi-tui `Markdown`
  pushes the fence lines unconditionally — a `codeBlockBorder` that
  returns `""` leaves blank lines where the fences were, and
  `codeBlockIndent` only changes the content indent. Eliding fences
  would mean forking `Markdown`, which the spec rules out; per its
  instruction the entry becomes a recorded divergence (fences kept).
- link-render (empirical check, phase 4): pi-tui `Markdown` already
  emits claude-style OSC 8 (link text only, URL invisible) when
  `getCapabilities().hyperlinks` is true — auto-detected per terminal,
  with a tmux `client_termfeatures` probe — and falls back to
  `text (url)` otherwise. No code needed; the harness tmux reports no
  hyperlink support, so captures show the fallback on our side while
  claude emits OSC 8 unconditionally (visible in the .ansi files).

## Group D — special message types

| id               | claude                                                                                                   | clauctl                                                                                                                                      | proposed                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| slash-command    | `❯ /login` + `⎿  Login successful`; bare `❯ /compact` when no output                                     | raw `<command-name>`/`<command-message>`/`<command-args>` tags + separate "No response requested" block                                      | match                                         |
| bash-passthrough | `! cmd` turns absent from resumed scrollback (verify)                                                    | raw `<bash-input>`/`<bash-stdout>` tags, with HTML entities double-escaped (`&lt;` shown literally) and stdout mangled by markdown rendering | match live look + fix escaping bug (see note) |
| ide-selection    | `<ide_selection>` context rendered as its own `❯` block, blank line before the real question's `❯` block | ide_selection and question text run together in one block                                                                                    | match                                         |
| turn-duration    | `· Brewed for 9m 11s` / `· Cogitated for 5m 53s` lines between long turns                                | absent                                                                                                                                       | skip (proposed)                               |
| compact-boundary | not observed (scrolled out of claude capture)                                                            | collapsed "Compacted (ctrl+o to see full summary)" line; full markdown summary on ctrl+o                                                     | match (2026-07-19)                            |

Notes:

- bash-passthrough has a genuine bug independent of parity: clauctl displays
  `&lt;`/`&gt;` literally (double-escaping) and renders stdout as markdown
  (git output with a ``` line derails it). Decided (Anton, 2026-07-18):
  render `❯ ! cmd` + collapsed output on resume — claude's _live_ rendering —
  regardless of whether claude's resumed scrollback drops such turns
  (unverified; decided divergence if it does).
- turn-duration: the whimsical timer lines only carry information live; on a
  resumed transcript they're noise. Proposed skip, revisit if we do live
  parity.
- compact-boundary (decided, Anton, revised 2026-07-19): match claude —
  a collapsed "Compacted (ctrl+o to see full summary)" line by default, the
  full markdown-rendered summary when expanded (ctrl+o toggles it together
  with tools). Capturing claude's boundary marker (rework the slash-command
  scenario so /compact actually compacts) stays a low-priority WORK LOG item.

## Group E — session chrome (proposed intentional differences)

| id               | claude                                                                                                          | clauctl                                                 | proposed         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- |
| welcome-banner   | boxed banner: logo, model/account, cwd, tips, what's-new                                                        | nothing                                                 | differ           |
| input-footer     | input box `❯` between rules; mode line `⏸ manual mode on · ? for shortcuts · ← for agents` (+ effort indicator) | rules + status line `idle … default • model • agent-id` | differ (decided) |
| scrollback-depth | —                                                                                                               | —                                                       | n/a              |

Notes:

- input-footer (decided, Anton): differ from both, but borrow from each —
  - permission mode on the left, with claude's per-mode coloring. Captured so
    far: `⏵⏵ auto mode on` in 256-color 220 (gold), manual/default mode line
    all-grey 246. Colors for acceptEdits/plan/bypassPermissions/dontAsk not
    yet captured — grab them from targeted captures during implementation;
  - pi-default-footer content: cwd (`~`-abbreviated) + git branch,
    context-window usage, model + thinking level. Context usage comes from
    the existing `AgentState.lastUsage` (decided, Anton). pi's cumulative
    session counters (`↑input ↓output Rcache-read CH<hit-rate>% $cost`) and
    cost are skipped — they'd require folding per-message usage sums into
    AgentState, and cost is moot on subscription billing. The SDK's usage
    messages carry the same per-request fields, so the counters stay addable
    later.

  pi implementation facts (from a source read of
  `~/git/earendil-works/pi`, workspace 0.80.9): the footer is
  `packages/coding-agent/src/modes/interactive/components/footer.ts`
  (`FooterComponent`). It is entangled with pi's in-process `AgentSession`
  (token/context/model/thinking) plus a `FooterDataProvider`
  (`core/footer-data-provider.ts` — standalone-copyable git-branch watcher
  reading `.git/HEAD`). Plan: copy the layout logic (`formatCwdForFooter`,
  the stats-left/model-right line algorithm) and feed it clauctl data.
  User-configurable footer: skipped this pass — pi's mechanism is an
  extension `setFooter` factory, not a settings knob, so it doesn't meet the
  "extremely easy" bar.

- scrollback-depth is a harness artifact, not a rendering difference: claude
  collapses so much that its scrollback covers a longer time span than
  clauctl's for the same tmux history limit, which inflates the raw diff line
  count on long sessions (078b1e79: 2711-line diff). Fixing the collapsing
  entries shrinks this automatically. If it stays noisy, the harness could
  align captures on the last common line before diffing.

## pi component reuse

Guiding constraint (Anton): minimize TUI maintenance burden. Don't
reverse-engineer claude's exact rendering where pi has an open-source
component — borrow from pi (ideally verbatim), and keep ports updatable via
`scripts/update-ports.sh`. The philosophy is documented in `src/tui/AGENTS.md`;
per-component reuse verdicts from a source read of pi @ 0.80.9 (all paths
under `packages/coding-agent/src/` unless noted):

| catalog entries                                                                                     | pi component                                                                                                                               | verdict                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| code-fence-stripping, heading-style, link-render, inline-style                                      | `Markdown` in pi-tui (`packages/tui/src/components/markdown.ts`)                                                                           | already imported — differences are theme/config, fix via `getMarkdownTheme()` in `src/tui/theme.ts`                                                                                     |
| edit-diff-view                                                                                      | `modes/interactive/components/diff.ts` (`renderDiff`, word-level intra-line highlights) + `core/tools/edit-diff.ts` (`generateDiffString`) | reversed 2026-07-20 (see the rendering-parity spec WORK LOG): pi anchors line numbers by diffing the whole file, which the transcript lacks — custom claude-layout formatter in edit.ts |
| tool-call-header, tool-result-collapse, readonly-tool-folding, subagent-summary, tool-error-summary | `modes/interactive/components/tool-execution.ts` delegates to per-tool `renderCall`/`renderResult` in `core/tools/{edit,bash,read,…}.ts`   | reference patterns only — pi's machinery is entangled with its tool registry/extensions; our `tool-execution.ts` port keeps the generic shell and grows claude-style per-tool summaries |
| tool-result-collapse (Bash)                                                                         | `modes/interactive/components/bash-execution.ts` + `visual-truncate.ts` (`truncateToVisualLines`)                                          | copyable (deps: theme, `dynamic-border.ts`, `keybinding-hints.ts`)                                                                                                                      |
| input-footer                                                                                        | `modes/interactive/components/footer.ts` + `core/footer-data-provider.ts`                                                                  | copy layout helpers + branch watcher; data re-wired to AgentState (see Group E note)                                                                                                    |
| thinking-collapse                                                                                   | `AssistantMessageComponent` already supports `hideThinkingBlock` → one-line italic label                                                   | our port already has it — claude-style "Thought for Ns" is a label change plus a duration source                                                                                        |

Caveat for an update script: pi's npm tarballs ship compiled `dist/` only, so
verbatim ports must copy from a git checkout of the pi repo (as
`update-ports.sh` already does via `$PI_REPO`), pinned by tag.
