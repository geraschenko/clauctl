# Why the daemon tracks user prompts itself

> Design rationale for `queuedMessages`, `deliveredMessages`, and the
> transcript leaf in `AgentState` (src/core/agent-state.ts, which states
> the invariant in code; this doc holds the full rationale), and for the known
> limitations we accepted. The queue events are one leg of the event stream
> described in `docs/socket-interface.md`. Grounded in the echo-placement experiments
> (`docs/derisk/echoed-message-placement/FINDINGS.md`); read that before
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
accepted-but-queued, delivered-but-unconfirmed, or confirmed-in-transcript.
`AgentState` carries all three, and the `nextAgentState` fold maintains the
**prompt-visibility invariant**: for any state, every accepted turn/append
prompt appears in exactly one place —

1. `queuedMessages`: accepted, still in the modeled queue;
2. `deliveredMessages`: dequeued as turn/append, no subsequent stream
   emission yet to confirm it;
3. the transcript at/before the leaf: a later emission confirmed its entry
   is within the boundary; a `get-entries` read covers it.

Transitions are atomic because each is one fold step over one event:
`userMessageQueued` adds to 1, a turn/append `userMessageDequeued` moves
its messages from 1 to 2, and a uuid-carrying `sdkMessage` advances the
boundary and clears `deliveredMessages` in the same transition (2 to 3).
The daemon's EventHub folds each event, writes it to subscribers, and
serves state reads in one synchronous step, so no observer can catch a
prompt in two states or none.

When several prompts are queued, claude writes all of the same priority as
one `\n`-joined entry (`docs/derisk/echoed-message-placement/FINDINGS.md`,
Q4). Entries land in file-append order, so
any message emitted after a delivery has its entry after every delivered
prompt's; the prompt itself is never re-emitted, the later message _is_ the
confirmation. Clearing _all_ of `deliveredMessages` on _every_
user/assistant emission is therefore sound, provided the queue model is
right about consumption order: a later message confirms every prompt the
model says was delivered before it. Once the leaf is at that message, a
history read (file order) covers them all.

An attaching observer (the TUI) then renders each prompt exactly once, in
order: history replay (`get-entries`) cut at the leaf, then
`deliveredMessages`, then `queuedMessages` into the pending area; everything
past the leaf arrives exclusively as live events. Steered prompts are not in
`deliveredMessages` at all: they never get a user entry, so they would
either linger forever or be cleared by the next emission and vanish; they
render from their `queued_command` attachment entry instead, which the
entry stream delivers live and `get-entries` returns in replay.

## Known limitations (accepted, documented so we don't re-derive them)

- **Merged-bucket display inconsistency (cosmetic).** An attacher in the
  delivered window sees a merged bucket as N separate user messages (from
  `deliveredMessages`); once in history, it shows as the single `\n`-joined
  entry the CLI actually wrote. Same content, different segmentation.
- **Interrupt can drop a delivered prompt from every view.** A prompt
  dequeued as turn/append sits in `deliveredMessages` until the next
  uuid-carrying emission. If an interrupt lands first, the emissions around
  it (the abort tool_result, the interrupting turn's messages) clear
  `deliveredMessages` whether or not claude wrote the prompt's entry; if it
  discarded the prompt, nothing shows it anywhere. The file stream does not
  change this by itself: confirmation is by "a later emission exists", not
  by "this prompt's entry arrived", because nothing ties a delivered prompt
  to the entry the CLI writes for it. Stamping `SDKUserMessage.uuid` would
  provide that tie — the CLI persists it as the entry's uuid
  (`docs/derisk/uuid-stamping/`) — but clauctl does not stamp today.
