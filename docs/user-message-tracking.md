# Why the daemon tracks user prompts itself

> Design rationale for `queuedMessages`, the stamped prompt uuid, and the
> stream merge's part in prompt tracking (src/core/agent-state/agent-state.ts,
> which states the invariant in code; this doc holds the full rationale), and
> for the known limitations we accepted. The queue events are one leg of the
> event stream described in `docs/protocol.md`. Grounded in the echo-placement
> experiments (`docs/derisk/echoed-message-placement/FINDINGS.md`) and the
> uuid-stamping probe (`docs/derisk/uuid-stamping/`); read those before
> re-deriving any of this empirically.

## The SDK gap

The Agent SDK gives a live observer no direct view of user prompts:

- **Queue operations are invisible on the SDK stream.** Claude Code's
  `enqueue`/`dequeue`/`remove` log exists only in the session JSONL as
  sidecar entries; a live SDK observer sees nothing when a prompt is accepted,
  reordered, demoted, or consumed. So clauctl's daemon models the queue instead
  (daemon/queue-model.ts) and synthesizes
  `userMessageQueued`/`userMessageDequeued`.
- **User prompts are never emitted on the SDK stream at all.** The stream's
  only `user` messages are tool_results (verified across the
  echoed-message-placement captures; no capture, including executed
  injected prompts and interrupts,
  ever emitted a text `user` message). A consumed prompt's transcript entry
  is written silently. The only live confirmation is indirect: transcript
  entries land in file-append order, so any uuid-carrying message emitted
  later proves the prompt's entry is already in the file before it. For an
  idle-accepted `shouldQuery: false` append, that next emission may not come
  until the next turn begins (unbounded).
- **Steered prompts never reach `getSessionMessages` output.** The JSONL
  does record a demoted `next`/default prompt (a chain-linked
  `queued_command` attachment carrying the exact prompt text at its exact
  demotion point) but `getSessionMessages` never returns attachment
  entries (verified empirically against the `a_next` capture: only the real
  user/assistant chain entries come back). The rendered `<system-reminder>`
  wrapper exists only in the API request. This is one reason clauctl reads
  the session file itself instead of asking the SDK
  (`docs/session-views.md`, "Why not ask the SDK?").

**Why model the queue rather than read the file's `queue-operation`
entries?** Those entries are available live, but they are not a usable signal:
they are uuid-less, lag the SDK stream by a flush, and record less than we need.
`enqueue` carries text and timestamp, `dequeue` only a timestamp (no identity),
and a `remove` is a demotion we already absorb as a steer. The queue model's
inputs are our own `prompt` requests and the SDK stream, so it knows the
delivery classification (turn, steer, append) and immediacy at the moment it
happens, and it works before the file exists (a `/clear`'s first turn).

## The invariant

Because the SDK announces none of this, at any instant an accepted prompt is
in one of three states only the daemon's own bookkeeping can distinguish:
accepted-but-queued, delivered-but-unfiled, or in the transcript.
`AgentState` carries all three, and the `nextAgentState` fold maintains the
**prompt-visibility invariant**: for any state, every accepted prompt
appears in exactly one place —

1. `queuedMessages`: accepted, still in the modeled queue, keyed by the
   uuid the daemon stamps on the `SDKUserMessage` before handing it to the
   SDK (the CLI persists that uuid as the prompt's entry uuid;
   `docs/derisk/uuid-stamping/`);
2. the query session's stream merge, pending on `query` under that uuid:
   dequeued, its entry not yet filed;
3. the transcript: the entry arrived, the merge resolved the uuid.

Transitions are atomic because each is one fold step over one event:
`userMessageQueued` adds to 1; `userMessageDequeued` removes from 1 and observes
the prompt on `query` (2); the prompt's `sessionEntry` observes it on `session`,
resolving it (3). Empirically, the session file normally lags the SDK event
stream by a couple hundred milliseconds, but if the file beats the dequeue, the
entry is observed on `session` without excluding `query` — the prompt is still
in `queuedMessages`, so its `query` observation is known to be coming — and the
dequeue step resolves it, so it jumps straight from 1 to 3. The daemon's
EventHub folds each event, writes it to subscribers, and serves state reads in
one synchronous step, so no observer can catch a prompt in two states or none.

When several prompts are queued, claude writes each run — a maximal
prefix of querying same-priority prompts, or a lone append — as one
`\n`-joined entry under the LAST member's uuid (`docs/claude-agent-sdk.md`,
"Queued prompts coalesce by run"). A dequeue therefore observes only its
last uuid, the run key, and the observer that renders the dequeue (the
TUI, `format events`) joins the run's messages the way the CLI does
(`joinedPrompt`) so what it shows is what the file will hold. A steered
prompt never gets a user entry: the CLI records it as a `queued_command`
attachment whose `source_uuid` is the stamped uuid, so the daemon emits
one dequeue per steered prompt (a run of one) and the attachment entry
resolves it.

An attaching observer (the TUI) renders each prompt exactly once, in
order: history replay (`get-entries`) resolves what the file holds; the
seed's query-pending uuids (dequeued prompts among them) replay as pending
frames from the query session model; `queuedMessages` fill the pending
area; everything else arrives exclusively as live events. A dequeue echo
renders provisionally in the pending part and is replaced in place by its
entry (or its attachment) at resolution.

## Known limitations (accepted, documented so we don't re-derive them)

- **Interrupt can leave a dequeued prompt pending.** A prompt dequeued as
  turn/append is pending on `query` until its entry. If an interrupt lands
  first and claude discards the prompt, nothing files it: the prompt stays
  pending (the TUI keeps its provisional echo; `settled()` stays false)
  until a `conversation_reset` excludes it or the daemon restarts. The
  daemon has no signal that distinguishes "discarded" from "not yet
  written". Whether an interrupt (or a `now`-priority prompt) actually
  discards queued prompts is unprobed; the phase 2.5 spec
  (`docs/specs/query-pending-list/phase-3-identity.md`, Deferred) plans
  the LIVE tests and revises this entry from their findings.
