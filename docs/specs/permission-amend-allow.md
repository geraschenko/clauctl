# Permission dialog: Tab on an allow row (allow with feedback)

Status: Done 2026-10-08. Task tg 574c3235.

# SPEC

## Problem

In the permission dialog (docs/specs/permission-prompt.md), Tab opens the
amend input. Whatever row is focused, Enter in that input sends
`feedbackDenial(text)`. So Tab on "Yes" denies the tool, which is a bug.

In native claude, Tab on "Yes" runs the tool and the typed text reaches the
model with the tool's result. We want the same outcome in clauctl.

## Native behaviour (claude 2.1.280; tui-parity `amend-yes`, `amend-no`)

- **Tab on Yes, text, Enter:** the tool runs. The user message holding its
  `tool_result` also carries `{type: "text", text}` as a second block.
  The turn continues.
- **Tab on No, text, Enter:** the `tool_result` is
  `feedbackDenial(text)`, which clauctl already matches.

## Definitions

- **Allow feedback:** text the user attaches to an allow. The daemon
  hands it to the CLI through the tool's post-execution hook, for the
  next API request of the agent that ran the tool, after the tool's
  `tool_result` (not necessarily adjacent to it: sibling results and
  other hooks' contexts may come between), whether the tool succeeded or
  failed. A tool that never completes, or a cancelled callback, delivers
  nothing.

## Behaviour

1. **Amend on an allow row** (a `decide` row whose decision is
   `behavior: "allow"`, i.e. "Yes" or "Yes, and don't ask again …"): Enter
   in the amend input answers with the row's decision and, when the typed
   text is non-empty, with the text as allow feedback. Empty text answers
   with the plain decision.
2. **Amend on any other row** (a deny row, or the plan dialog's "Tell
   Claude what to change" row): `feedbackDenial(text)`, as today.
3. **`permission-response` carries the feedback.** The request gains
   `feedback?: string`. The broker records it with the decision, in the
   same synchronous step that settles the ask. When the ask is not
   pending, the request fails with `NOT_PENDING_ERROR` and nothing is
   recorded. Empty `feedback` is no feedback. The request also fails,
   recording nothing, if `feedback` is not a string, or if non-empty
   feedback comes with a deny; that error says to put the text in the
   deny's `message`. As for every request, a handler's throw is the
   request's error response.
4. **The CLI subcommand exposes it:** `clauctl permission-response
   --feedback <text>`, because the subcommands give full access to the
   protocol.
5. **How the agent sees it** (pinned by tests/sdk/amend-allow.test.ts):
   - The daemon registers a `PostToolUse` and a `PostToolUseFailure`
     callback hook. Each identifies the tool use by its input's
     `tool_use_id` (required once narrowed by `hook_event_name`; the
     callback's positional `toolUseID` is optional). It removes the
     feedback recorded for that id and returns it as
     `additionalContext`: `The user approved this tool call and added:
     <text>`. With nothing recorded it returns `{}`. The guarantee is an
     at-most-once hand-out to the CLI, not a delivery receipt.
   - The CLI puts that into the next API request of the agent that ran
     the tool, main agent or subagent, after the `tool_result`, as the
     text `<Event>:<Tool> hook additional context: <context>`. Placement
     is the CLI's general one for an attachment after a tool_result:
     folded into the tool_result's string content as a
     `<system-reminder>` (e.g. Haiku), or, for a mid-conversation-system
     model, in the trailing `role: "system"` message.
     `format api-request` reproduces both by replaying the entry's
     `rendered` snapshot.
     The hook starts no turn of its own. The session file of that agent
     gets a `hook_additional_context` attachment.
   - Probed: Bash (success, failure, inside a foreground subagent), Write,
     background Bash (handed out with the launch result, not at
     completion). `disableAllHooks: true` in settings does not suppress
     callback hooks. MCP tools: covered by the SDK test; if it fails,
     return to planning.
   - **Limitation:** feedback on an AskUserQuestion or ExitPlanMode allow
     is unverified. Their dialogs offer no allow amend; the protocol
     accepts the field but promises nothing for these tools.
   - The CLI's prefix is hook-attributed. Our wording attributes the text
     to the user. No code depends on the prefix, so it is not pinned.
6. **The dialog layout is unchanged:** the separate amend input and the
   `Tab to amend` hint stay. Native edits the row in place; matching that
   is a non-goal.
7. **Not-pending failures show the banner.** Every failed
   `permission-response`, not-pending included, shows `permission response
   failed: <error>`. This replaces permission-prompt.md's rule that a late
   response fails silently: the user should learn that their answer, and
   any feedback with it, was not delivered.

## Success criteria

- tests/sdk/amend-allow.test.ts (free, answering shim), with the hooks
  registered as the daemon registers them, asserts:
  - main-agent ask, tool succeeds: the second API request has the
    `tool_result`, then a system text block holding the context
    (mid-conversation-system model, the default for every case); there
    is no third API request (the session ends on its own; a timeout
    fails the test);
  - the same on Haiku: the context is folded into the tool_result;
  - main-agent ask, tool fails (`exit 3`): the same, through
    `PostToolUseFailure`;
  - subagent ask (foreground Agent): the subagent's request after its
    `tool_result` carries the context, and no main-agent request does
    (the shim's subagent reports nothing back);
  - Write ask, and an MCP tool ask (the stdio server
    scripts/tui-parity/mcp-greet-server.ts): the context follows the
    `tool_result`;
  - background Bash ask: the context follows the launch result, while
    the command is still blocked;
  - `disableAllHooks: true` in settings: the context still arrives;
  - an interrupt while the allowed tool runs: neither hook is called;
  - the session file has a `hook_additional_context` attachment holding
    the context;
  - a callback hook emits no hook events on the stream, although
    `includeHookEvents` is set.
- permission-broker tests, through `feedbackHooks`:
  - after `respond(id, allow, feedback)`, the first hook call for `id`
    returns the context, a second returns `{}`; PostToolUse and
    PostToolUseFailure share that one record;
  - a hook call for another id returns `{}` and leaves the record;
    parallel ids keep their own text;
  - not pending: `NOT_PENDING_ERROR`, nothing recorded;
  - after `cancelAll()`, a late hook call returns `{}`, and a later ask
    with feedback works.
- The production code relying on SDK behaviour (hook routing, the
  attachment, no stream hook events) names tests/sdk/amend-allow.test.ts.
- Request-handler tests for `permission-response` with `feedback`:
  - non-string `feedback`, or non-empty `feedback` with a deny: an error,
    and the ask is still pending;
  - empty `feedback`, with an allow or a deny: settles with no feedback;
  - a valid one reaches `respond` with the feedback.
- permission-prompt.test.ts asserts:
  - Tab on Yes, text, Enter → `onDecide(ALLOW, text)`;
  - Tab on Yes, empty text, Enter → `onDecide(ALLOW)`;
  - Tab on "Yes, and don't ask again", text, Enter → the row's full
    decision, `updatedPermissions` included, and the text;
  - Tab on No → `onDecide(feedbackDenial(text))`;
  - the plan dialog's amend row → `onDecide(feedbackDenial(text))`.
- The tui-parity scenarios `amend-yes-typing`, `amend-yes` and `amend-no`
  stay as regression captures.

## Type design

```ts
// src/core/protocol/messages.ts — ProtocolRequest variant
| {
    type: "permission-response";
    toolUseId: string;
    decision: PermissionResult;
    /** Allow feedback (allow only; empty means none): handed to the agent that
     *  ran the tool with the tool's result, if the tool completes. */
    feedback?: string;
  }

// src/core/protocol/version.ts — PROTOCOL_VERSION bumped: an older daemon
// would accept the request and silently drop `feedback`.

// src/core/protocol-server/permission-broker.ts
class PermissionBroker {
  /** Throws NOT_PENDING_ERROR when not pending; then records nothing. */
  respond(toolUseId: string, decision: PermissionResult, feedback?: string): void;
  /** Also drops recorded feedback. */
  cancelAll(): void;
  /** The SDK hooks that hand recorded feedback to the agent that ran the
   *  tool; the daemon passes them as `Options.hooks`. */
  readonly feedbackHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

// src/commands/sdk-commands.ts
const permissionResponseFlags = {
  toolUseId: requiredStringFlag(...),
  feedback: stringFlag(...), // --feedback
};

// src/tui/components/permission-prompt.ts
export class PermissionPromptComponent {
  constructor(
    dialog: PermissionDialog,
    pendingCount: number,
    onDecide: (decision: PermissionResult, feedback?: string) => void,
  );
  /** `row` is the focused row (Tab) or the plan dialog's amend row. */
  private openAmend(row: PermissionRow): void;
}

// src/tui/components/question-prompt.ts — unchanged:
//   onDecide: (decision: PermissionResult) => void

// src/tui/interactive-mode.ts
class InteractiveMode {
  private sendPermissionResponse(
    toolUseId: string,
    decision: PermissionResult,
    feedback?: string,
  ): void;
}
```

- The broker owns the feedback because the feedback is part of the answer
  to an ask. The hooks are the broker's too, so the recording, the
  hand-out and the wording live in one place.
- `takeFeedback` stays private; the broker test reaches it through
  `feedbackHooks`.
- No shared callback type. InteractiveMode passes each component its own
  closure. The question prompt never sends feedback: its free text goes
  out in `answers`/`annotations`, or in the Chat-about-this feedback deny.
- queue-model.ts and the TurnQueue are not involved.

## Data flow

1. The amend input's Enter on an allow row calls `onDecide(decision,
   text)` (or `onDecide(decision)` for empty text).
2. `sendPermissionResponse` sends one `permission-response` request with
   `feedback`. Failures show the banner (Behaviour 7).
3. The daemon's handler validates `toolUseId`, `decision` and `feedback`,
   then calls `permissionBroker.respond(toolUseId, decision, feedback)`.
   The handler needs no Query gate: nothing is sent to the Query.
4. `respond` checks pending, records the feedback under the toolUseId,
   then settles. The CLI receives the allow, runs the tool, and calls the
   PostToolUse (or PostToolUseFailure) hook. The hook takes the feedback
   and returns it as `additionalContext`. The tool cannot finish before
   the allow, so the hook cannot run before the feedback is recorded.
5. The CLI delivers the context as in Behaviour 5.

## Cost

Input tokens for the hook's prefix and our wording. A map entry per
allow with feedback, held until the hook fires or `cancelAll()`. A
`PostToolUse`/`PostToolUseFailure` callback round trip over stdio for
every tool call, also those without feedback (the hook cannot be
registered per tool use).

## Edge cases

- **The tool never completes** (interrupt, Query abort): no hook fires,
  not even `PostToolUseFailure` (probe: interrupt during `sleep 5`). The
  feedback is lost. Unconsumed feedback, from this or any other path
  that skips the hook, stays until `cancelAll()`, i.e. until Query
  teardown (set-context, shutdown); there is no fixed bound. A turn's
  `result` cannot retire it while background subagents may still run
  their tools. Accepted.
- **Another client answers first:** our request fails as not-pending;
  nothing is recorded.
- **"Yes, and don't ask again" + Tab:** follows rule 1 (the allow with
  its rule updates, plus the feedback). Not captured natively.
- **Parallel tool calls:** feedback is keyed by `tool_use_id`, so it
  follows its own tool.
- **User-configured hooks** in settings run alongside ours. How the CLI
  combines their contexts is not probed; nothing here depends on it.
- **A subagent quotes the feedback** in its report: the main agent then
  sees it too, legitimately.

## Transcript display

The TUI transcript renders every `hook_additional_context` attachment of
the main session file, ours and user hooks' alike, under the tool its
`toolUseID` names: what the agent saw. A read-only tool carrying hook
context does not fold, since the fold would hide it. Native shows our case as a `❯ ok`
prompt line; we do not match that. A subagent's attachment is only in
the subagent's file, which the daemon does not follow, and callback hooks
emit no stream events, so subagent feedback is not shown until subagent
files are followed (docs/follow-ups/subagent-activity.md). Our feedback
is recognised by its wording (`allowFeedbackOf`) and shown as typed;
another hook's context shows as `<hookName>: <context>`. The file
carries no other provenance, and `format tree` reads only the file. A
user hook that starts its context with our wording would read as
feedback; that risk is accepted. The wording exists only in
`allowFeedbackContext`, so writer and reader cannot drift.

## Slash-command prediction

queue-model.ts's `isSlashCommand` mirrors the CLI's command test. The
CLI trims leading whitespace first (probe: `/tmp/x …` with
`shouldQuery: false` is not steered; `​/tmp/x …` is), so the
predicate tests the text after `trimStart()`. A free shim test,
tests/sdk/steer-slash-trim.test.ts, pins both cases.

## Non-goals

- Native's in-place amend editing and row relabel ("Yes, and tell Claude
  what to do next").
- Steering subagents: the SDK input cannot reach one
  (docs/follow-ups/subagent-activity.md).
- The input-slot union (tg c60bca6d, docs/follow-ups/input-slot-dialogs.md).

# IMPLEMENTATION IDEAS

- Mechanisms probed (free shim, claude 2.1.280, SDK 0.3.280; throwaway
  probes, replaced by tests/sdk/amend-allow.test.ts and
  tests/sdk/steer-slash-trim.test.ts). None reproduces native's sibling
  text block:
  - PostToolUse `additionalContext` (chosen): `PostToolUse:Bash hook
    additional context: <text>` after the `tool_result`, in the agent
    that ran the tool. It reached a foreground subagent's own request,
    and through `PostToolUseFailure` it followed a failed tool's error
    result. Callback hooks emitted no hook events.
  - PostToolUse `updatedToolOutput` is honoured only in the tool's own
    output shape and replaces the `tool_result` content, so it is
    tool-specific.
  - A `shouldQuery: false` user message pushed during `canUseTool`
    (rejected). Three problems:
    - its stdin write races the allow's control response, because
      `deliverUserMessage` only queues it;
    - it always reaches the main agent, even with `parent_tool_use_id`
      set to a subagent's Agent call;
    - a text starting with `/` (after trimming: a leading space does not
      help) is never steered.
- amend-allow.test.ts is shaped like interrupt-marker.test.ts. It takes
  the hooks from a `PermissionBroker` rather than copying them, and ends
  each session by closing its input rather than closing the Query at the
  first `result`.
- The wording lives in src/core/protocol/permission.ts:
  `allowFeedbackContext(feedback)` (the broker writes it) and
  `allowFeedbackOf(context)` (readers recover the typed text).
  `hookContextDisplayText(hookName, context)` is the display both
  surfaces use: allow feedback as typed, any other hook's context as
  `<hookName>: <context>`.
- `hookAdditionalContext(attachment)` (src/core/session/file.ts) parses
  the attachment payload for the transcript, the `format tree` view
  (`hookAdditionalContextView`) and the SDK test. The transcript renders
  the display text under the tool's result
  (`ToolExecutionComponent.addHookContext`). Neither mirrors the CLI's
  `hook additional context:` wording.
- `openAmend(row)`: if `row.action.kind === "decide"` and the decision's
  `behavior === "allow"`, call `onDecide(row.action.decision, text)`
  (omit `text` when empty); otherwise call `onDecide(feedbackDenial(text))`.
- Proposed error texts: `permission-response: feedback must be a
  string`; `permission-response: feedback is for an allow; a
  deny carries its text in decision.message`.
- Hook matchers have no `matcher` field, so they apply to every tool.
  The hook ignores `agent_id`: the `tool_use_id` alone identifies the
  tool use.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## Tasks

- [x] Native captures: tui-parity `amend-yes-typing`, `amend-yes`,
      `amend-no` (paid, approved 2026-10-07).
- [x] Shim probes of the SDK mechanisms; Anton chose the hook.
- [x] tests/sdk/amend-allow.test.ts from the probes (8 cases, free, all
      pass, MCP included); both probes deleted.
- [x] Protocol: `feedback` on `permission-response`; version bump (5).
- [x] `PermissionBroker`: `respond(…, feedback?)`, `feedbackHooks`,
      `cancelAll` drops feedback; tests. Daemon passes `feedbackHooks`
      as `Options.hooks`.
- [x] Handler validation; request-handler tests.
- [x] CLI: `permission-response --feedback`.
- [x] `PermissionPromptComponent`: `onDecide` signature, `openAmend(row)`;
      tests.
- [x] `InteractiveMode`: per-component `onDecide` closures;
      `sendPermissionResponse(toolUseId, decision, feedback?)`;
      not-pending failures show the banner.
- [x] Transcript renders main-file `hook_additional_context` attachments
      under their tool; transcript test.
- [x] queue-model `isSlashCommand` trims; unit test;
      tests/sdk/steer-slash-trim.test.ts (free, passes).
- [x] Docs:
  - permission-cli.md: the request shape and the subcommand flag;
  - permission-prompt.md: "Amended deny" definition points here; its
    late-response rule (:74) replaced by Behaviour 7;
  - input-slot-dialogs.md records Anton's union decision;
  - delete docs/follow-ups/permission-amend-allow.md and repoint
    ask-user-question.md's reference.
- [x] `npm run ready`; report on tg 574c3235.

`PermissionBroker` is exported from protocol-server/index.ts, and its
constructor takes `Pick<EventHub, "emit">`, so the SDK test builds the
broker without a hub (lint forbids importing protocol-server siblings).
Implementation review (reviewer 7724227c) fixes:

- a read-only tool with hook context no longer folds;
- the SDK test classifies subagent requests by their first message;
- it checks placement on content blocks, not substrings;
- the interrupt case asserts the interrupt was sent;
- the background command blocks on a fifo until the launch result's
  request arrives;
- the slash test fails on its watchdog.
  Second review round:
- the slash test proves the space text was delivered in time: its
  `enqueue` queue-operation precedes the tool_result entry, and no
  `queued_command` steer follows. The CLI records it as a plain user entry
  with `queueTranscriptOnly: true`;
- the interrupt case tolerates only the SDK's "returned an error result"
  throw;
- cleanup opens a reader on the fifo to finish a pending release write.
  The reviewer reports no production-code blockers.
  The SDK throws when an interrupted turn's error result ends the stream;
  the interrupt case of amend-allow.test.ts tolerates that throw.
  `isNotPendingError` (protocol/permission.ts) lost its only caller, the
  TUI's silent late-response path, and is deleted.

Anton's review (2026-10-08):

- Placement is model-dependent (see Behaviour 5). The SDK test pins the
  model (a mid-conversation-system model by default) and adds a Haiku
  case asserting the fold into the tool_result. `format api-request`
  needs no change: it replays the `rendered` snapshot in both modes.
- Empty `feedback` is no feedback (Decisions).
- The allow-feedback wording is shared (`allowFeedbackContext` /
  `allowFeedbackOf`); `format tree` gets a `hook_additional_context`
  view and the transcript shows the same display text: the typed
  feedback alone.
- Test ids: `uuidN` and `stampN` (the event stamp for `uuidN(n)`'s
  message) live in src/test-support/uuids.ts; queue-model.test.ts's
  `accept` takes `n` explicitly.

## Decisions (Anton, 2026-10-08)

- Deliver the feedback through PostToolUse/PostToolUseFailure
  `additionalContext`, worded to attribute it to the user. A
  `shouldQuery: false` user message was chosen first, then dropped: it
  races the allow on stdin, cannot reach a subagent, and is not steered
  when it starts with `/`.
- The feedback travels in the `permission-response` request, not in a
  second request, so it can never attach to an ask another client
  already answered.
- A not-pending failure shows a banner in the TUI, like every other
  failure.
- Errors stay as handler throws, which become the request's error
  response.
- Empty text sends no feedback. The daemon treats empty `feedback` as
  none (so a script's `--feedback "$TEXT"` works with an empty $TEXT),
  and rejects non-empty `feedback` that comes with a deny, pointing to
  the deny's `message` rather than filling it (one spelling per text).
- `clauctl permission-response` gets the flag: the subcommands give full
  access to the protocol.
- The two components' `onDecide` callbacks need not share a signature.
  The question prompt's has no feedback argument.
- The input slot should become a union of its occupants (editor,
  selectors, permission prompt, question prompt), not a shared interface.
  Deferred to tg c60bca6d.
- The amend UI stays as it is.
- Transcript: render main-file `hook_additional_context` attachments
  under their tool, allow feedback as the user typed it.
- `format tree` labels the attachment by its type, like every other
  attachment: `hook_additional_context: <typed text>`.
- A deny's text stays in `decision.message` (required by the SDK type);
  `feedback` never fills it.
- The `isSlashCommand` trim fix lands with this spec.
