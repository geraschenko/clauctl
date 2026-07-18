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

All triage entries below are PROPOSED, pending Anton's review.

## Group B — collapsing & tool rendering (highest visual impact)

| id | claude | clauctl | proposed |
|----|--------|---------|----------|
| thinking-collapse | collapses thinking to italic `Thought for 3s (ctrl+o to expand)` | full thinking text inline | match |
| tool-call-header | `● ToolName(primary arg)` one-liner, e.g. `● Write(~/notes.txt)`, `● Bash(cmd…)` | bare tool name, then raw JSON input (6-line truncation) | match |
| tool-result-collapse | `⎿  <one-line summary>` (e.g. blank, `Added 1 line`, first line + `… +14 lines (ctrl+o to expand)`) | raw result text, truncated at ~6 lines with `… (+N more lines)` | match |
| readonly-tool-folding | consecutive thinking + read-only tools fold into one line: `Thought for 4s, searched for 2 patterns`, `Read 1 file (ctrl+o to expand)` | every tool call rendered individually | match |
| edit-diff-view | `● Update(path)` + `⎿  Added N lines, removed M lines` + line-numbered diff with `+`/`-` gutters | raw JSON with `\n`-escaped old_string/new_string | match |
| subagent-summary | `● Agent(description)` + `⎿  Done (2 tool uses · 16.8k tokens · 14s)` | raw Task JSON input + raw subagent result (incl. agentId continuation hint) | match |
| tool-error-summary | `⎿  Error writing file` (styled) | raw `<tool_use_error>…</tool_use_error>` text | match |

Notes:

- readonly-tool-folding implies a classification of tools (read-only vs
  mutating) and a summarizer per tool (`read 1 file`, `searched for 2
  patterns`). The exact folding rules need enumeration during type design —
  e.g. claude gave the failed `Write` its own `●` block but folded the
  following `Read` into the next `Thought for` line.
- tool-result summaries are per-tool: Write → blank/error, Edit → added/
  removed counts, Bash → first output line + `… +N lines`, Agent → Done
  stats. This is the largest single work item in the catalog.

## Group A — message chrome

| id | claude | clauctl | proposed |
|----|--------|---------|----------|
| user-gutter | `❯ ` prefix, continuation lines indented 2 | no prefix, 1-space indent | match |
| user-verbatim | user text shown verbatim (`**bold**`, backticks preserved) | user text rendered as markdown | match |
| assistant-gutter | `● ` prefix on first block line, continuation indented 2 | no prefix, 1-space indent | match |
| block-spacing | exactly one blank line between blocks | inconsistent (e.g. two blank lines after user message) | match |

## Group C — markdown body

| id | claude | clauctl | proposed |
|----|--------|---------|----------|
| code-fence-stripping | fence markers stripped, content syntax-highlighted at block indent | ```` ```ts ```` fences kept, content extra-indented | match |
| heading-style | bold white, `##` stripped | bold yellow, `##` stripped | match (color part → ANSI pass) |
| link-render | OSC 8 hyperlink: link text only, target invisible | `text (target)` with underline | match |
| inline-style | bold `[1m`, italic `[3m`, inline code 256-color 153, no background | bold/italic same; truecolor palette with background fills | ANSI pass |

Tables and bullet lists already match (see markdown scenario).

## Group D — special message types

| id | claude | clauctl | proposed |
|----|--------|---------|----------|
| slash-command | `❯ /login` + `⎿  Login successful`; bare `❯ /compact` when no output | raw `<command-name>`/`<command-message>`/`<command-args>` tags + separate "No response requested" block | match |
| bash-passthrough | `! cmd` turns absent from resumed scrollback (verify) | raw `<bash-input>`/`<bash-stdout>` tags, with HTML entities double-escaped (`&lt;` shown literally) and stdout mangled by markdown rendering | match + fix escaping bug |
| ide-selection | `<ide_selection>` context rendered as its own `❯` block, blank line before the real question's `❯` block | ide_selection and question text run together in one block | match |
| turn-duration | `· Brewed for 9m 11s` / `· Cogitated for 5m 53s` lines between long turns | absent | skip (proposed) |
| compact-boundary | not observed (scrolled out of claude capture) | compaction summary rendered as full plain text | investigate |

Notes:

- bash-passthrough has a genuine bug independent of parity: clauctl displays
  `&lt;`/`&gt;` literally (double-escaping) and renders stdout as markdown
  (git output with a ``` line derails it).
- turn-duration: the whimsical timer lines only carry information live; on a
  resumed transcript they're noise. Proposed skip, revisit if we do live
  parity.
- compact-boundary: existing WORK LOG item — rework the slash-command
  scenario so /compact actually compacts, then capture how claude renders the
  boundary + summary.

## Group E — session chrome (proposed intentional differences)

| id | claude | clauctl | proposed |
|----|--------|---------|----------|
| welcome-banner | boxed banner: logo, model/account, cwd, tips, what's-new | nothing | differ |
| input-footer | input box `❯` between rules; mode line `⏸ manual mode on · ? for shortcuts · ← for agents` (+ effort indicator) | rules + status line `idle … default • model • agent-id` | differ |
| scrollback-depth | — | — | n/a |

Notes:

- input-footer: clauctl's status line (state, permission mode, model, agent
  id) is deliberate attach UX. Once message rendering matches, decide whether
  to adopt claude's input-box look around it.
- scrollback-depth is a harness artifact, not a rendering difference: claude
  collapses so much that its scrollback covers a longer time span than
  clauctl's for the same tmux history limit, which inflates the raw diff line
  count on long sessions (078b1e79: 2711-line diff). Fixing the collapsing
  entries shrinks this automatically. If it stays noisy, the harness could
  align captures on the last common line before diffing.
