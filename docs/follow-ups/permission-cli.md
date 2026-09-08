# Permission asks on the CLI surface

Follow-up to docs/specs/permission-prompt.md, which lands asks in the TUI
dialog only. Everything below is one design because it hinges on the same
question: what an agent blocked on a permission ask _is_, in the state
vocabulary the CLI commands wait on.

## Symptoms today

- `clauctl archive` stops politely: wait for `idle`, then SIGTERM. An agent
  blocked on an ask is `activity: "working"` forever, so archive waits out
  its `--timeout` (or hangs without one). The parity harness works around it
  by denying over the socket before archiving (capture-dialogs.ts).
- `clauctl prompt` and `clauctl tail --until …` block for the same reason.
  `prompt` is the pure CLI interface to an agent: it should _return_ when
  the agent needs input from the user, and a pending ask is exactly that.
  Only `no-activity:<secs>` catches it today (until.ts header).
- Nothing on the CLI can answer an ask; the only responder is the attached
  TUI. `format`/`tail` show `permissionRequested` events but nothing says
  "this agent is waiting on you".

## Design questions

1. **Is "blocked on an ask" a third state, or a qualifier?** `idle` and
   `quiescent` (agent-state/selectors.ts) describe the loop; an ask leaves
   the loop mid-tool. Options: (a) a new until-condition
   `input-needed`/`blocked` = `allPendingAsks(state).length > 0`, orthogonal
   to activity; (b) widen `idle` to "not going to make progress without
   the user", which changes what archive/wait/prompt mean at once. (a)
   keeps `idle` honest (the tool call is still in flight — see
   AskUserQuestion, whose answer resumes the same call) and lets each
   command opt in; leaning (a).
2. **What does each command do at `blocked`?**
   - archive: do not wait. Denying the ask first vs SIGTERM straight
     away — SIGTERM aborts the query and the ask with it, so no deny is
     needed; confirm the session file ends cleanly (no dangling tool_use
     without result, or accept it as the resumed session's problem).
   - prompt: settle as if the turn ended, exit code distinct from 0/3 so
     scripts can branch ("input needed"). Print the ask(s) in the stream
     output (`permissionRequested` is already a formatted event).
   - tail: `--until` gains the new condition; default unchanged.
   - wait: gains the new condition.
3. **The responder subcommand.** `clauctl permission <target> allow|deny
   [--tool-use-id …] [--message …] [--always]` over the existing
   `permission-response` request (`--always` = apply the ask's
   suggestions, as dialog row 2). Which ask when several are pending
   (main + tasks): require `--tool-use-id` unless exactly one. Visibility:
   `clauctl inspect`/`ls` should show `blocked: <tool> (<n> asks)`.
4. **AskUserQuestion.** claude's answer picker is a different dialog
   (options with descriptions, multi-select, free text) over the same
   `canUseTool` channel; the parity harness already captures it
   (`askuser`, claude only). Its answer is an `updatedInput` allow, so
   the broker needs nothing new; the TUI needs a second dialog component
   and the CLI responder a way to pass the answer.

## Not in scope

The state model behind asks (broker, fold, wire) — done in the permission
prompt spec. This doc is about the commands that observe and answer them.
