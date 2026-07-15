# Why the daemon tracks user prompts itself

> Design rationale for `queuedMessages`, `deliveredMessages`, and
> `lastTranscriptUuid` in `AgentState` (src/core/agent-state.ts, which states
> the invariant in code; this doc holds the full rationale), and for the known
> limitations we accepted. Grounded in the echo-placement experiments
> (`docs/derisk/echoed-message-placement/FINDINGS.md`); read that before
> re-deriving any of this empirically.

## The SDK gap

The Agent SDK gives a live observer no direct view of user prompts:

- **Queue operations are invisible on the live stream.** The CLI's
  `enqueue`/`dequeue`/`remove` log exists only in the session JSONL as
  sidecar entries; a live observer sees nothing when a prompt is accepted,
  reordered, demoted, or consumed. The daemon models the queue instead
  (daemon/queue-model.ts) and synthesizes
  `userMessageQueued`/`userMessageDequeued`.
- **User prompts are never emitted on the live stream at all.** The stream's
  only `user` messages are tool_results (verified across the FINDINGS
  captures — no capture, including executed injected prompts and interrupts,
  ever emitted a text `user` message). A consumed prompt's transcript entry
  is written silently; the only live confirmation is indirect: transcript
  entries land in file-append order, so any uuid-carrying message emitted
  later proves the prompt's entry is already in the file before it. For an
  idle-accepted `shouldQuery: false` append, that next emission may not come
  until the next turn begins (unbounded).
- **Steered prompts never reach `get-messages` output.** The JSONL does
  record a demoted `next`/default prompt — a chain-linked `queued_command`
  attachment carrying the exact prompt text at its exact demotion point —
  but `getSessionMessages` never returns attachment entries (verified
  empirically against the `a_next` capture: only the real user/assistant
  chain entries come back). The rendered `<system-reminder>` wrapper exists
  only in the API request.

## The invariant

Because the SDK announces none of this, at any instant an accepted prompt is
in one of three states only the daemon's own bookkeeping can distinguish:
accepted-but-queued, delivered-but-unconfirmed, or confirmed-in-transcript.
`AgentState` carries all three, and the `nextAgentState` fold maintains the
**prompt-visibility invariant**: for any state, every accepted turn/append
prompt appears in exactly one place —

1. `queuedMessages` — accepted, still in the modeled queue;
2. `deliveredMessages` — dequeued as turn/append, no subsequent stream
   emission yet to confirm it;
3. the transcript at/before `lastTranscriptUuid` — a later emission
   confirmed its entry is within the boundary; a `get-messages` read covers
   it.

Transitions are atomic because each is one fold step over one event:
`userMessageQueued` adds to 1, a turn/append `userMessageDequeued` moves
its messages from 1 to 2, and a uuid-carrying `sdkMessage` advances the
boundary and clears `deliveredMessages` in the same transition (2 to 3).
The daemon's EventHub folds each event, writes it to subscribers, and
serves state reads in one synchronous step, so no observer can catch a
prompt in two states or none.

Why clearing _all_ of `deliveredMessages` on _every_ user/assistant emission
is sound: the CLI writes a delivered prompt's transcript entry when it
consumes it (a merged bucket as one `\n`-joined entry — FINDINGS Q4), and
entries land in file-append order — so any message emitted later has its
entry after every pending delivered prompt's. The prompt itself is never
re-emitted; the later message _is_ the confirmation. Once the boundary is at
that message, a history read (file order) covers them all. This rests on the
queue model being right about consumption order: a later message confirms
every prompt the model says was delivered before it.

An attaching observer (the TUI) then renders each prompt exactly once, in
order: history replay cut at the boundary, then `deliveredMessages`, then
`queuedMessages` into the pending area; everything past the boundary arrives
exclusively as live events.

## Known limitations (accepted, documented so we don't re-derive them)

- **Steered prompts are invisible to fresh attachers.** Their only
  transcript record is the `queued_command` attachment, and
  `getSessionMessages` never returns attachment entries (verified against
  the `a_next` capture: the attachment sits on the parentUuid chain in the
  raw JSONL, but the returned array holds only the real user/assistant
  entries) — so no history replay can show them. Including them in
  `deliveredMessages` would not fix this: they never get a user entry, so
  they would either linger forever (stale duplicates for every later
  attacher) or be cleared by the next emission and vanish anyway. The real
  fix, if ever wanted, is reading the raw JSONL (not `getSessionMessages`)
  and rendering `queued_command` attachments during replay. Live-attached
  observers do see steered prompts (their `userMessageDequeued` renders from
  the pending area).
- **Merged-bucket display inconsistency (cosmetic).** An attacher in the
  delivered window sees a merged bucket as N separate user messages (from
  `deliveredMessages`); once in history, it shows as the single `\n`-joined
  entry the CLI actually wrote. Same content, different segmentation.
- **Interrupt can drop a delivered prompt.** The emissions around an
  interrupt (the abort tool_result, the interrupting turn's messages) clear
  `deliveredMessages`; if the CLI discarded the prompt without writing its
  entry, it is gone from every view. No display path could have shown it —
  the daemon cannot distinguish "written, confirmation pending" from
  "discarded by the interrupt".
- **Compaction can hide a delivered append.** A delivered-but-unconfirmed
  `shouldQuery: false` append that survives into a compaction is cleared by
  the new segment's first message, but its entry lives in the pre-compaction
  segment `get-messages` no longer returns. Its content reached the model
  (via the compact summary's source material); it just stops being displayed.
- **Attach-during-compaction race can duplicate output.** When a compaction
  lands between the seed state and the `get-messages` read, the boundary
  uuid is absent from the returned (new) segment, so the prefix cut is
  impossible and exactly-once is unachievable. Replay shows the whole
  segment behind a warning banner (`historyUpToBoundary` in sdk-render.ts):
  replay-all was chosen over render-nothing because a missing boundary can
  also mean the session file lags the stream, where rendering nothing would
  silently drop real history. The cost in the compaction case is that the
  new segment's output can render twice — once from replay, once from the
  buffered live events.
- **Boundary-undefined delivery race.** If `lastTranscriptUuid` is undefined
  (no user/assistant emission yet this daemon lifetime → replay-all) while a
  prompt is delivered-but-unconfirmed, and the transcript read already includes
  that prompt's entry, replay-all plus `deliveredMessages` (or the buffered
  dequeue event) can render it twice. In practice this needs a just-revived
  daemon with prior history + an instant query + an instant attach within
  the read window; accepted as negligible.
