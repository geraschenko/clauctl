# `format messages` renders tool results through tool views

`clauctl format messages` does not use the `ToolView`s the TUI uses.
`src/format/sdk-message.ts` prints every call as a generic
`[tool:Name {json…}]` line (`assistantBody`, args truncated by
`maxToolArgChars`) and every result as `[Name:ok N lines, B bytes]`
(`formatToolResult`). A reader of the output cannot see, for example,
AskUserQuestion's questions or answers (example session:
`~/.claude/projects/-home-anton-git-geraschenko-clauctl/d69ee703-8ad4-4e68-bf08-90ab6af5362c.jsonl`).

## Decided (Anton, 2026-10-06)

- `format messages` should render tools through the same `ToolView` code the
  TUI uses (single source of truth). Deferred from the AskUserQuestion
  cleanup because it is a bigger change.

## Open

- The call and its result live in different chunks (assistant chunk vs the
  results-only user chunk). Proposal from the cleanup triage: the result
  line renders the view's header/body (which take both args and result);
  the call line stays short. Not agreed in detail.
- How this interacts with `--tool-results none|summary|full` and with the
  expansion levels in click-to-expand.md.
- `format tree` shows nothing about tool calls (they fold into the
  assistant node); Anton wants it "a bit more informative" for
  AskUserQuestion. What the line should show is undecided.
