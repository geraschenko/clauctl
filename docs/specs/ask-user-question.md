# AskUserQuestion dialog in the TUI

Status: implemented 2026-10-06; Anton's review round (TDC comments,
commit ad83fc2) done 2026-10-07. Changes:

- renames;
- AskUserQuestion asks identified by tool name only. A probe confirmed
  that the CLI rejects malformed input before `canUseTool`, so there is
  no generic-dialog fallback;
- wording constants marked as pinned; shared test keys;
- `capturesEscape`, which fixes Esc in notes mode and amend mode;
- no banner for AskUserQuestion; `claudeOnly` removed;
- `header(args, context, result?)` replaces `headline`, `hiddenWhilePending`
  and `displayName`;
- the user's notes are shown in full;
- preview layout: the options column is `ceil(width/3)` and the pane fits
  the widest preview;
- tui-parity scenario `askuser-esc`: Esc matches native on the wire;
- the tool-schema capture runs through the SDK with `canUseTool`, which
  adds AskUserQuestion and the plan-mode tools;
- the CLI's input validation is pinned by the free shim test
  tests/sdk/ask-user-question-shim.test.ts. The view flags calls the CLI
  rejected, and args it cannot read, as `AskUserQuestion (invalid
  input)`;
- notes without a chosen option are sent as native's `(notes only)`
  answer; the view shows notes aligned under the answer;
- Enter in notes mode answers with the focused option, as native does;
- the interrupt marker renders as a notice, not a prompt, and survives
  reattach; the `interrupted` event banner is gone;
- key behaviour checked against native (parity scenarios); Cancel is
  `CANCEL_DENY`, which ends the turn like native.

Deferred: docs/follow-ups/{format-messages-tool-views,
interactive-mode-split}.md; the input slot: docs/specs/input-slot.md;
dialog keybindings:
docs/specs/dialog-keybindings.md;
Tab on an allow row: docs/specs/permission-amend-allow.md.

# SPEC

## Problem

The agent's AskUserQuestion tool reaches clauctl as a permission ask
(`canUseTool`). The TUI renders it as the generic permission dialog
(docs/specs/permission-prompt.md), which shows the input as `key: value`
JSON lines and can only allow (a bare allow, which the model receives as
"The user did not answer the questions.") or deny. The user cannot
answer the questions. The transcript renders the call generically too.

We want native claude's question dialog and transcript rendering in the
clauctl TUI, including option previews and notes. Wherever native claude's
behaviour is observable, we duplicate it, and an SDK test pins every native
behaviour the implementation relies on.

## Definitions

- **Question dialog**: the TUI component that answers an AskUserQuestion
  ask, in place of the permission dialog.
- **Answer** (per question): the chosen option labels, plus the "Type
  something." row's text when chosen. Its **answer text** is those values
  joined with `", "` in display order, e.g. `Red, Blue, Purple`. A question
  with nothing chosen has no answer text.
- **Preview layout**: a single-select question where at least one option
  has a `preview`. It renders the options beside a preview pane that shows
  the focused option's preview. Multi-select questions never use it.
- **Notes**: free text the user attaches to a preview-layout question. There
  is one notes field per question, kept across focus changes.
- **Feedback deny**: a deny whose message is native claude's wording for
  user feedback: `REJECTION_PREFIX + "To tell you how to proceed, the user
  said:\n" + feedback`, where `REJECTION_PREFIX` is "The user doesn't want to
  proceed with this tool use. The tool use was rejected (eg. if it was a
  file edit, the new_string was NOT written to the file). " (the wording of
  `PLAIN_DENY_MESSAGE` before its "STOP …" sentence).
- **Presented ask**: the ask whose dialog a TUI is showing.

## Behaviour (native claude, captured 2026-10-06 with claude 2.1.280)

1. **Layout, one question:**
   ```
   ──────────────── (full-width rule)
    ☐ <header>

   <question>

   ❯ 1. <label>
        <description>
     2. <label>
        <description>
     3. Type something.
   ────────────────
     4. Chat about this

   Enter to select · ↑/↓ to navigate · Esc to cancel
   ```
   Choosing an option in a single-select, single-question dialog submits
   it (assumed; confirmed by the `askuser` parity capture).
2. **Several questions** add a tab bar in place of the header line:
   `←  ☐ Pet  ☐ Colors  ✔ Submit  →`. A tab's box becomes `☒` once its
   question has an answer. Answering a single-select question moves to the
   next tab. Tab and ←/→ switch tabs, and the hint reads "Tab/Arrow keys to
   navigate".
   The Submit tab shows:
   ```
   Review your answers

    ● <question>
      → <answer text>

   Ready to submit your answers?

   ❯ 1. Submit answers
     2. Cancel
   ```
3. **Multi-select:** rows render as `[ ] <label>` or `[✔] <label>`, and both
   Enter and Space toggle them. Typing on the "Type something" row edits its
   text in place and ticks it. A final unnumbered `Submit` row follows the
   options.
4. **Free text:** typing on the "Type something." row of a single-select
   question replaces the row's label with the text, and Enter chooses it
   (seen for multi-select only; single-select confirmed by capture).
5. **Preview layout:**
   - Options sit in a left column and the focused option's preview in a
     bordered pane to the right. An option without a preview shows "No
     preview available".
   - Descriptions and the "Type something." row are not shown.
   - Preview markdown is rendered with pi-tui's `Markdown` component as-is.
     Native claude styles headings, emphasis, code and blockquotes and leaves
     tables and lists raw; matching that exactly is a non-goal.
   - Below the pane, `Notes: press n to add notes`, and the hint gains "n to
     add notes".
   - `n` enters notes mode: an input for the question's notes. In notes
     mode, ctrl+g opens the notes in the external editor; exit 0 replaces the
     notes and nothing is submitted. Esc returns to selection mode.
   - The notes text persists, dimmed in selection mode, whichever option is
     focused.
6. **Decisions:**
   - **Submit:** allow with `updatedInput = {...input, answers, annotations}`.
     - `answers` maps each question's text to its answer text; unanswered
       questions are omitted.
     - `annotations` maps the question text of each answered preview-layout
       question to `{ preview?: <the chosen option's preview>, notes?:
       <notes> }`, with absent fields omitted. It is `{}` when there are no
       annotations.
   - **Esc:** `PLAIN_DENY` (the permission dialog's plain deny).
   - **Chat about this:** a feedback deny whose feedback is:
     ```
     The user wants to clarify these questions.
         This means they may have additional information, context or questions for you.
         Take their response into account and then reformulate the questions if appropriate.
         Start by asking them what they would like to clarify.

         Questions asked:
     - "<question>"
       Answer: <answer text>
     - "<question>"
       (No answer provided)
     ```
     The leading spaces shown are exact.
7. **The permission dialog's amend input** (Tab, or the plan dialog's
   amend row) sends a feedback deny instead of the raw text.
8. **Transcript:**
   - Answered: a `● User answered Claude's questions:` line, then
     `⎿  · <question> → <answer text>` per answered question.
   - Denied (Esc or Chat about this): `● User declined to answer questions`,
     then `⎿  · <question> (<label> / <label>)` per question.
   - Lines for annotations, and the rendering while the call is pending, are
     taken from parity captures (IMPLEMENTATION IDEAS).
9. **Ask queueing, first come first served** (applies to every dialog and
   to every `allPendingAsks` consumer, including `status` and `inspect`):
   - The daemon stamps each ask with `arrivedAt` when `canUseTool` fires.
     The SDK supplies no timestamp.
   - `allPendingAsks` orders asks by `arrivedAt`, using a stable sort. Ties
     keep the main-first order.
   - The TUI presents the head. A newer ask never replaces a presented
     one, even a main-agent ask arriving while a task's ask is shown.
   - The order lives in `AgentState`, so every client presents the same
     ask: a reattached TUI, a second TUI, and `status` agree.
   - Because a dialog is only rebuilt once its ask resolves, an in-progress
     answer is never lost.
10. **Fallback:** an AskUserQuestion ask whose input fails the runtime
    check renders as the generic permission dialog, as it does today.

## Success criteria

1. Unit tests: the pure functions in `question-dialog.ts` produce the
   decisions in Behaviour 6 (answers, annotations, the clarify text with
   answered and unanswered questions), and `feedbackDenial` produces the
   feedback deny.
2. Component tests: rendering and key handling for Behaviours 1–5.
   Selector tests (Behaviour 9):
   - a main-agent ask arriving after a task's ask sorts after it;
   - same-millisecond asks keep the main-first order.
3. Parity: `scripts/tui-parity` dialog scenarios `askuser` (single
   question; no longer `claudeOnly`), `askuser-multi` (several questions,
   one multi-select) and `askuser-preview` (preview layout). Each is
   captured on both sides and diffed, and any remaining differences are
   listed as decided divergences.
4. SDK tests (live, haiku; native behaviour we rely on), in
   `tests/sdk/ask-user-question.test.ts`:
   1. An allow with `updatedInput.answers` yields a non-error tool_result
      naming each question and answer, and `tool_use_result.answers` equal
      to what we sent.
   2. An allow with `annotations` (preview and notes) yields a tool_result
      containing the `selected preview:` and `notes:` text, and
      `tool_use_result.annotations` equal to what we sent.
   3. A deny's message reaches the tool_result content verbatim, with
      `is_error: true`. This is why we must send the feedback deny's prefix
      ourselves.
   4. `PLAIN_DENY` and the chat deny produce the tool_result content of
      native claude's Esc and "Chat about this", as recorded in the fixtures
      captured 2026-10-06.
5. MITM (`tests/sdk/api-context.test.ts` fixtures, answering shim):
   persisted AskUserQuestion exchanges render into the `/v1/messages` body
   exactly as `format api-request` converts them. The fixtures cover:
   - answered;
   - answered with annotations;
   - plain deny;
   - chat deny;
   - an amend feedback deny.
6. A live TUI smoke (tmux, isolated config) answers each kind of question
   end to end.

## Type design

```ts
// src/tui/question-dialog.ts — pure; no TUI, no I/O.
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";

/** The ask's input, checked at runtime; undefined → generic dialog. */
export function askUserQuestionInput(
  request: PermissionRequest,
): AskUserQuestionInput | undefined;

type Question = AskUserQuestionInput["questions"][number];

/** One question's answer in progress. */
export interface QuestionAnswer {
  /** Chosen option indices; at most one unless multiSelect. */
  readonly selected: readonly number[];
  /** The "Type something" row's text; chosen when non-empty and selected. */
  readonly otherText: string;
  readonly otherSelected: boolean;
  /** Preview layout only; kept across focus changes. */
  readonly notes: string;
}
export const EMPTY_ANSWER: QuestionAnswer;

/** "Dogs" | "Red, Blue, Purple"; undefined when nothing is chosen. */
export function answerText(
  question: Question,
  answer: QuestionAnswer,
): string | undefined;
/** Single-select and some option has a preview. */
export function usesPreviewLayout(question: Question): boolean;
/** Submit: allow with updatedInput {...input, answers, annotations}. */
export function submitDecision(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[],
): PermissionResult; // calls answerText, usesPreviewLayout
/** "Chat about this": the clarify text as a feedback deny. */
export function chatDecision(
  input: AskUserQuestionInput,
  answers: readonly QuestionAnswer[],
): PermissionResult; // calls answerText, feedbackDenial
```

```ts
// src/tui/permission-dialog.ts — added
/** A deny carrying user feedback, worded as native claude words it. */
export function feedbackDenial(feedback: string): PermissionResult;
// PermissionPromptComponent's amend input calls it.
```

```ts
// src/tui/components/question-prompt.ts
export class QuestionPromptComponent extends Container implements Focusable {
  constructor(
    input: AskUserQuestionInput,
    /** " — task: <description>" for a task's ask. */
    titleSuffix: string | undefined,
    pendingCount: number,
    onDecide: (decision: PermissionResult) => void,
    /** ctrl+g in notes mode. */
    editText: (text: string) => Promise<string | undefined>,
  );
  /** Renders "(+N more)" when > 1. */
  pendingCount: number;
}
// State held privately: the current tab, cursor and mode (select | other
// text | notes), and the QuestionAnswer[].
// The preview pane uses pi-tui Markdown.
```

```ts
// src/tui/external-editor.ts — extracted from
// InteractiveMode.openExternalPromptEditor, which then calls it.
/** Edit `text` in $VISUAL/$EDITOR with the TUI suspended; undefined if
 *  no editor is set or it exited nonzero. */
export function editTextInExternalEditor(
  ui: TUI,
  text: string,
): Promise<string | undefined>;
```

```ts
// src/core/protocol/permission.ts — PermissionRequest gains:
/** When the daemon received the ask (epoch ms); orders `allPendingAsks`. */
arrivedAt: number;

// src/core/protocol-server/permission-broker.ts
export function permissionRequestOf(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  arrivedAt: number, // the caller passes Date.now(); stays pure
): PermissionRequest;

// src/core/agent-state/selectors.ts — signature unchanged; order is now
// by arrivedAt (stable; ties keep main-first).
export const allPendingAsks: (state: AgentState) => readonly PendingAsk[];
```

```ts
// src/tui/interactive-mode.ts
// permissionPrompt: PermissionPromptComponent | QuestionPromptComponent
// syncPermissionPrompt: presents the head of allPendingAsks (unchanged);
// mounts QuestionPromptComponent when askUserQuestionInput(request) is
// defined, PermissionPromptComponent otherwise.
```

```ts
// src/format/entry-view/tool-view/tool-view.ts — ToolView<A> gains:
/** Replaces the `Name(arg)` header line when present. */
headline?(args: A, result: RenderToolResult | undefined): string;

// src/format/entry-view/tool-view/ask-user-question.ts
export const askUserQuestionView: ToolView<AskUserQuestionInput>;
// headline: "User answered Claude's questions:" | "User declined to answer
// questions"; resultSummary: the per-question lines (Behaviour 8).
```

## Data flow

1. The daemon's `canUseTool` stamps `arrivedAt`, and the ask enters
   `AgentState`. `syncPermissionPrompt` presents the head of
   `allPendingAsks`, the earliest-arrived pending ask.
2. When `askUserQuestionInput(request)` parses the input, the TUI mounts a
   `QuestionPromptComponent` in place of the editor.
3. Keys update the component's private state. ctrl+g in notes mode calls
   `editText`, and its result replaces the notes.
4. Submit, Chat about this and Esc each pass a decision to `onDecide`:
   `submitDecision`, `chatDecision` and `PLAIN_DENY` respectively.
5. `onDecide` goes to `sendPermissionResponse`, then the daemon, then
   `canUseTool`. The CLI builds the tool_result from `updatedInput`.
6. The tool_result becomes a session entry. `askUserQuestionView` renders
   it in the transcript, and `format api-request` converts it like any
   tool_result.

## Cost

- Preview markdown is rendered on every render. Cache the rendered lines
  per (option, pane width).
- Everything else is O(questions × options), at most 16.

## Edge cases

- **The ask is cancelled or answered elsewhere** (another client,
  `permission-response`, interrupt): the dialog closes as for permission
  asks, and its partial answer is discarded.
- **Submit with unanswered questions:** allowed. Their questions are left
  out of `answers`, which the model sees in the tool_result (assumed;
  confirmed against native claude by capture before implementing).
- **A preview option chosen without notes:** the annotation has `preview`
  only. **Notes without a preview** (the chosen option has no preview):
  `notes` only (assumed; SDK test 4.2 and the smoke confirm what native
  claude records).
- **No external editor set:** ctrl+g shows the existing "set $EDITOR"
  banner.

## Non-goals

- Exact markdown parity in the preview pane.
- Matching the CLI's model-facing wording for answered questions. The CLI
  chooses it: through the SDK, answers without annotations read "Your
  questions have been answered: …", while answers with annotations (SDK
  test 4.2), like interactive claude's, read "The user answered: … Read the
  answers carefully …".
- MCP elicitation (`onElicitation`) and `onUserDialog`.

# IMPLEMENTATION IDEAS

- Derisk tooling (throwaway): `/tmp/aq.sh` drives native claude in tmux
  on the parity harness's isolated config (`~/.cache/clauctl-tui-parity`).
  `/tmp/aq-probe/probe.ts` is the SDK probe.
- Native tool_result texts captured 2026-10-06, the basis for the SDK
  test fixtures:
  - Esc: `PLAIN_DENY_MESSAGE` verbatim, `is_error: true`, and
    `toolUseResult` "User rejected tool use".
  - Chat about this: the feedback deny with the clarify text (Behaviour 6).
  - Native answered: `The user answered: "<q>"="<a>" selected
    preview:\n<preview> notes: <notes>, … Read the answers carefully — …`.
  - SDK answered: `Your questions have been answered: "<q>"="<a>". You
    can now continue with these answers in mind.`
  - Bare allow: "The user did not answer the questions."
- Anton's interactive experiment (session d69ee703 in his real
  ~/.claude) recorded annotations as `{[question]: {preview, notes?}}`.
- The "ctrl+g to edit in Vim" hint was seen with focus on "Chat about
  this". Anton reports that ctrl+g applies in notes mode; the exact hint
  placement comes from the parity captures.
- To take from captures:
  - The parity captures settled the preview pane's width and border and
    the pending transcript line; see the WORK LOG.
  - Static captures cannot show key behaviour: digit shortcuts, the Submit
    tab's Cancel, and Tab versus ←/→. These remain provisional
    (Implementation-Time Decisions).
  - The annotation lines are still open.
- `arrivedAt` is a wire change. Check at implementation whether
  `PROTOCOL_VERSION` must bump; older clients ignore the field. A
  restarted daemon starts a fresh clock, which is harmless because pending
  asks die with the Query. A wall-clock step backwards could misorder two
  asks; accepted.
- Verify the exact amend wording against a native amend capture before
  changing it. The prefix is known only from the Chat about this result.

# WORK LOG

## Implementation-Time Decisions

- **No `PROTOCOL_VERSION` bump for `arrivedAt`.** The field is additive:
  older clients ignore it. A newer client talking to an older daemon would
  see it undefined, and the sort would compare NaN, giving an unspecified
  order for that session. Accepted, pending Anton's review. A bump is a
  one-line change if he prefers it.
- **Order of work.** Ask queueing was implemented first, ahead of the
  remaining stubs, because it is self-contained and orthogonal to the
  dialog.
- **Per-question `Input`s** for the "Type something" text and the notes.
  pi-tui's `Input.setValue` keeps the old cursor (it only caps it), so one
  shared input refilled on each tab switch put revisited text's cursor at
  0.
- **Editor failures in notes mode** show the prompt editor's "external
  editor failed" banner (`editNotesText` catches). The "set $EDITOR to edit
  the notes" banner follows the existing "set $EDITOR to edit the …"
  family.
- **An answered preview-layout question with neither a chosen preview nor
  notes gets no `annotations` entry**, rather than `{}`. Notes on an
  unanswered question are dropped. Both are unverified against native.

- **`toolViews` gains an explicit `AskUserQuestion` key.** The generated
  tool set (scripts/claude-tools/tool-schemas.json) omits AskUserQuestion,
  so `ToolName` cannot key it; the registry type is widened with
  `AskUserQuestion?: ToolView<AskUserQuestionInput>` (the SDK's type).
- **`editTextInExternalEditor` conflates "no editor" with "nonzero
  exit"** (both undefined, as the approved signature says). Callers that
  need the "set $EDITOR" banner check `externalEditorCommand()` first.
- **`REJECTION_PREFIX`** is factored out of `PLAIN_DENY_MESSAGE`;
  `feedbackDenial` appends "To tell you how to proceed, the user said:\n"
  and the feedback, exactly as the clarify capture shows.

- **Unspecified component details, chosen provisionally until the parity
  captures say otherwise:**
  - Enter in notes mode returns to selection mode, like Esc.
  - A chosen single-select option or typed answer shows a trailing `✔`
    when its tab is revisited.
  - Switching tabs resets the cursor to the first row.
  - The Submit tab's Cancel sends `PLAIN_DENY`.
  - The preview pane's top border aligns with the first option row. The
    options column is 34 columns and the pane 44, as native at 100 columns;
    below 78 columns the options column is a third of the width.
- **`ToolView.hiddenWhilePending`** (a type-design addition for Anton's
  review). Native renders nothing for a pending AskUserQuestion call, since
  the dialog presents it. `ToolExecutionComponent` renders no lines for a
  view with this flag until the call resolves, and `headline` now takes a
  defined result.
- **Notes after ctrl+g re-render without a component render hook.**
  pi-tui renders on a throttled `setTimeout`, so the notes set in
  `editText`'s continuation (a microtask) are in place by the next render.
  To be confirmed in the live smoke.
- **`PLAIN_DENY` is exported** from permission-dialog.ts so the question
  dialog sends the identical object.

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-10-06: Derisk. Deleted docs/follow-ups/permissions-prompts.md and
  repointed its references to docs/specs/permission-prompt.md. Native
  captures and the SDK probe are summarised in IMPLEMENTATION IDEAS. Anton
  decided:
  - preview, notes and ctrl+g are in;
  - pi-tui markdown is good enough;
  - match native deny wording, including the amend fix;
  - the transcript view is in;
  - asks queue first come first served via a daemon-stamped `arrivedAt`
    (per-TUI stickiness rejected: inconsistent across reattach and
    multiple clients);
  - SDK and MITM tests cover every relied-on native behaviour.
- [x] SDK tests (criterion 4), 2026-10-06:
  - tests/sdk/ask-user-question.test.ts, 4 haiku queries, all passing.
  - Each answers the ask with question-dialog.ts's own decisions.
  - Through the SDK, answers with annotations get the interactive wording
    (Non-goals updated).
- [x] MITM fixtures (criterion 5), 2026-10-06:
  - Five tests in api-context.test.ts (`captureToolExchange`): answered,
    answered with annotations, plain deny, chat deny, and an amend
    feedback deny.
  - The tool_result texts and `toolUseResult` shapes are copied from the
    4.x runs' persisted sessions. The conversion comparison passes and each
    tool_result goes out verbatim.
- [x] `feedbackDenial` and the amend fix, 2026-10-06:
  - Native amend captured via `/tmp/aq.sh`: Bash ask, ↓↓ to "No", Tab, typed
    "use ls instead", Enter. The persisted tool_result is exactly
    `feedbackDenial("use ls instead")`, with `is_error`.
  - `PermissionPromptComponent.openAmend` now sends `feedbackDenial`. Test
    in permission-prompt.test.ts.
  - Out of scope, for Anton:
    - Native Tab amends the _focused_ row. On "Yes" it becomes "Yes, and
      tell Claude what to do next", an allow with feedback, which clauctl
      lacks.
    - The amend input's "Esc returns to the rows" is pre-empted by the
      global interrupt, as notes mode was. It is a pre-existing
      permission-prompt bug; the `editingNotes` exemption would extend to
      it.
  - An earlier blind attempt recorded no tool_result: Tab was pressed on
    "Yes", which amends that row instead.
- [x] Ask queueing by `arrivedAt` (Behaviour 9), 2026-10-06:
  - `PermissionRequest.arrivedAt` is stamped by `daemon.ts` with `Date.now()`
    and passed to `permissionRequestOf`.
  - `allPendingAsks` sorts by it with a stable sort.
  - Two selector tests in agent-state.test.ts: first come first served, and
    same-millisecond asks keep main first.
  - Test fixtures use `arrivedAt: 0`.
  - `npm run ready` green (888 tests).
- [x] `question-dialog.ts` and its unit tests (question-dialog.test.ts,
      wordings from the 2026-10-06 native capture). `feedbackDenial` is
      implemented (the clarify capture pins its wording) and wired into the
      amend input (above).
- [x] `editTextInExternalEditor` extracted; `openExternalPromptEditor`
      calls it and keeps the "set $EDITOR" banner check.
- [x] `askUserQuestionView` and the `ToolView.headline` consumer
      (tool-execution.ts `headerLines`; the tree's `toolCallPart` still
      shows `[AskUserQuestion]`). The pending call renders nothing
      (`hiddenWhilePending`). Annotation lines are absent and still open,
      because no capture shows them (the harness never answers). Tests in
      tool-view.test.ts and tool-execution.test.ts.
- [x] `QuestionPromptComponent` (components/question-prompt.ts, 9 tests),
      mounted by `syncPermissionPrompt` when `askUserQuestionInput` parses;
      ctrl+g passes through to it (only the plan dialog intercepts).
      `npm run ready` green (905 tests), 2026-10-06.
- [x] Live smoke (criterion 6). Driver `/tmp/smoke.sh`
      (start/keys/cap/tail/kill, harness isolation env, tmux socket
      `clauctl-smoke`). 2026-10-06 run 1, a three-question ask:
  - Single-select advance, multi-select toggles, inline Purple, the Submit
    row and the preview pane for the focused option all worked.
  - **Bug found:** Esc in notes mode interrupted the turn. `app.interrupt`
    is `escape`, and `handleGlobalKey` consumes it whenever an ask is
    pending, before the focused dialog. Fixed: the global interrupt yields
    while `QuestionPromptComponent.editingNotes` (a public getter, a
    type-design addition for review), like an open selector does.
    Regression test in interactive-mode.permission.test.ts, which now
    installs `CLAUCTL_KEYBINDINGS` (without them `app.interrupt` is unbound
    there and Esc never interrupts).
  - In selection mode Esc is likewise the global interrupt, never the
    component's `PLAIN_DENY`. The persisted tool_result is the identical
    `PLAIN_DENY` text, followed by `[Request interrupted by user for tool
    use]`. The generic dialog behaves the same way. Native matches on the
    wire (2026-10-07, tui-parity scenario `askuser-esc`: the same
    tool_result, `toolUseResult`, and interrupt marker in both
    transcripts). The screens differ only in clauctl's general interrupt
    display (`interrupted` and `turn failed` banners, the marker shown as
    a prompt line), which native omits. The component's Esc branch (and
    its test) covers only the unmounted component.
  - Run 2, after the fix, end to end:
    - the three-question ask: notes Esc stays in the dialog; ctrl+g in vim
      edits the notes, which re-render on return (confirms the notes
      render timing decision above); the review tab; Submit;
    - the model's reply quoted the answers, the Grid preview and the
      notes;
    - single-select free text ("Ferret") was answered;
    - "Chat about this" sent the chat deny, and the model asked what to
      clarify.
  - Observations, unchanged: the existing `permission denied: <message>`
    event banner prints the whole clarify text, and the `permission
    allowed` banner follows each answer. Native shows neither (event
    banners are a clauctl convention).
- [x] Parity scenarios and captures (criterion 3), 2026-10-06:
  - Scenarios: `askuser` (no longer `claudeOnly`), `askuser-multi` and
    `askuser-preview`. No scenario sets `claudeOnly` any more; the field is
    unused but has not been removed (ask Anton).
  - Fixes from the diffs:
    - the preview widths (above);
    - a full-width rule before "Chat about this";
    - the tab bar's spacing;
    - descriptions hidden in the preview layout;
    - the pending call hidden (`hiddenWhilePending`).
  - Decided divergences:
    - the standard banner and footer;
    - haiku's option wording, which varies between runs.
  - Not covered by any scenario: the answered and declined transcript lines,
    and annotation lines. These need a capture after answering, and the
    harness never answers.

## Review rounds, 2026-10-07

These supersede earlier entries in this log where they disagree.

- **`arrivedAt`: no `PROTOCOL_VERSION` bump** (Anton).
- **Notes on an unanswered question** are no longer dropped. Native sends
  the answer `(notes only)` with the notes annotation (session
  d69ee703…), and the CLI tells the model `(no option selected) notes:
  …`. `submitDecision` does the same for a preview question. The CLI's
  side is pinned by tests/sdk/ask-user-question-shim.test.ts.
- **No explicit `AskUserQuestion` key in `toolViews`.** The tool-schema
  capture now runs through the SDK with `canUseTool`, so the generated
  `ToolName` includes AskUserQuestion.
- **Annotation lines:** the user's notes follow the answer line in full,
  indented to align under the answer text. Previews are not shown.
- **Preview layout:** the options column is `ceil(width/3)`, which is 34
  at 100 columns as in native. The pane fits the widest preview among the
  question's options, so it is narrower than native's 44 for short
  previews.
- **Enter in notes mode** answers with the focused option and advances,
  or submits a single question; on a non-option row it only advances.
  Native evidence (session d69ee703…): one Enter answered `(notes only)`,
  and the retry answered with the focused option "Beta". This follows the
  retry.
- **Invalid input:** malformed AskUserQuestion input never reaches
  `canUseTool`. The CLI answers it with a `<tool_use_error>InputValidationError`
  tool_result (pinned by the shim test). The view shows such calls, and
  args it cannot read, as `AskUserQuestion (invalid input)` with the
  CLI's error as the summary.
- **Notes wrapping:** a wrapped notes line keeps its indent. The result
  block wraps each source line under its own leading whitespace
  (`resultBlockLines`).
- **Esc during the dialog:** the CLI's `[Request interrupted…]` marker
  renders as a dim notice with the CLI's wording, from its live frame or
  from its session entry, so late attachers see it too
  (`interruptMarkerText`). The `interrupted` event banner is gone; it did
  not survive reattach. Neither does `turn failed: …`, because `result`
  messages are not session entries. Live frames carry no `origin`, so the
  marker is recognised by its text (pinned by
  tests/sdk/interrupt-marker.test.ts). `<task-notification>` and subagent
  hand-back entries still render as user turns until tg e28b158c.
- **Key-behaviour parity** (tui-parity scenarios `askuser-revisit`,
  `-digit`, `-tab`, `-submit-tab`, `-submit-cancel`, `-notes-enter`,
  2026-10-07). These settle the provisional component details:
  - These match native: `✔` on a revisited answer, the cursor reset to
    row 1 on a tab switch, ← switching tabs, a digit answering and
    advancing, Tab advancing without answering, and Enter in notes
    (native recorded `List` with notes `ok`, as clauctl did).
  - **The Submit tab's Cancel is `CANCEL_DENY`:** the plain deny plus
    `interrupt: true`. Native writes the plain-deny tool_result and then
    the interrupt marker, and the turn ends without another model call.
    A bare `PLAIN_DENY` let the model carry on. The component's own Esc
    sends the same decision. The CLI's side is pinned by
    tests/sdk/interrupt-marker.test.ts.
  - The harness sends each `keysAtDialog` key once the screen settles.
    Back-to-back keys raced native's Ink loop.
  - Static differences:
    - The free-text row reads "Type something." on every question;
      native drops the period on multi-select (Anton: one wording).
    - The Submit tab shows native's `⚠ You have not answered all
      questions` while any question is unanswered.
    - Kept on purpose (Anton): native indents multi-select descriptions
      under the label (column 9) and the `Submit` row at column 5; ours
      stay at 5 and 2.
