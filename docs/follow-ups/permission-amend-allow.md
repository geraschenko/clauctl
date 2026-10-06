# Permission dialog: Tab on "Yes" (allow with feedback)

In native claude's generic permission dialog, Tab on a row opens an amend
input. On "No" the result is `feedbackDenial(text)` — clauctl matches this
(`src/tui/components/permission-prompt.ts`, captured during the
AskUserQuestion work; see docs/specs/ask-user-question.md WORK LOG). On
"Yes" native relabels the row "Yes, and tell Claude what to do next": the
tool runs and the text also reaches the model. clauctl has no equivalent.

## Decided (Anton, 2026-10-06)

- Aim for parity with native claude.

## Known so far (2026-10-07)

- **Bug (Anton):** in clauctl, Tab-to-amend always denies, even with "Yes"
  focused; the amend text goes out as `feedbackDenial`.
- **Native evidence** (session d69ee703…, ~/.claude): on Tab-on-Yes the
  tool runs (entry 08e440dc…), and the text reaches the model as a
  separate entry after it (1d802ad9…).
- `feedbackDenial`'s wording (`REJECTION_PREFIX` + "To tell you how to
  proceed, the user said:\n" + text) comes only from the AskUserQuestion
  "Chat about this" capture. No native amend-on-No capture pins it yet.

## Tasks

- Capture a native amend on "No" (tmux parity scenario) and pin the
  `feedbackDenial` wording with an SDK test; fix the wording if it
  differs.
- Probe how native carries the text on allow: capture the persisted
  tool_result and the API request (MITM, as in
  `tests/sdk/api-context.test.ts`), under the usual isolation rules.
- Decide how the SDK `PermissionResult` can express it; if it cannot,
  record what native sends and how to reproduce it.
- Add a tmux parity scenario for the Tab-on-Yes flow.
