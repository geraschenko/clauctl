# Why the daemon tracks user prompts itself

> Design rationale for `queuedMessages`, `deliveredMessages`, and
> `lastTranscriptUuid` in `StateSnapshot` (sdk-socket.ts), and for the known
> limitations we accepted. Grounded in the echo-placement experiments
> (`docs/derisk/echoed-message-placement/FINDINGS.md`); read that before
> re-deriving any of this empirically.

## The SDK gap

The Agent SDK does not echo user prompts in a timely, observable way:

- **Queue operations are invisible on the live stream.** The CLI's
  `enqueue`/`dequeue`/`remove` log exists only in the session JSONL as
  sidecar entries; a live observer sees nothing when a prompt is accepted,
  reordered, demoted, or consumed. The daemon models the queue instead
  (queue-model.ts) and synthesizes `userMessageQueued`/`userMessageDequeued`.
- **A consumed prompt's transcript echo arrives late.** When the CLI consumes
  a prompt (starts its turn, or appends a `shouldQuery: false` message), the
  uuid-carrying `user` stream message is emitted only when the transcript
  entry is echoed — after the dequeue, and for an idle-accepted append
  possibly not until the next turn begins (unbounded).
- **Steered prompts are never echoed at all.** A `next`/default prompt
  demoted at a tool→result handoff is rendered as a `<system-reminder>` into
  the tool result _at request-build time_; the rendered text appears in
  neither the live `tool_result` nor the JSONL (only a `queued_command`
  sidecar attachment records it).

So at any instant a prompt can be in one of three states the transcript file
alone cannot distinguish for a fresh observer: accepted-but-queued,
delivered-but-unechoed, or echoed.

## The invariant

`StateSnapshot` therefore carries all three, and the daemon maintains the
**prompt-visibility invariant**: for any snapshot, every accepted turn/append
prompt appears in exactly one place —

1. `queuedMessages` — accepted, still in the modeled queue;
2. `deliveredMessages` — dequeued as turn/append, transcript echo not yet
   emitted (`deliveredPending` in daemon.ts);
3. the transcript at/before `lastTranscriptUuid` — echo emitted; a
   `get-messages` read covers it.

Transitions are atomic because each happens in one synchronous daemon step:
acceptance and dequeue both run inside `applyQueueTransition` (moving a
prompt from 1 to 2), and the boundary advance and `deliveredPending` clear
share the top of `handleMessage` (moving 2 to 3). No `await` separates the
halves of a transition, so no snapshot can catch a prompt in two states or
none.

Why clearing _all_ of `deliveredPending` on _every_ user/assistant emission
is sound, with no echo detection: a delivered prompt's transcript entry is
written when the CLI consumes it, and the stream echoes the file in append
order — so any user/assistant message emitted later sits after every pending
delivered prompt in the file. Once the boundary passes that message, a
history read covers them all. One dequeued bucket also produces exactly one
echo: same-priority executing messages merge FIFO (joined by `\n`) into a
single user entry (FINDINGS Q4), so there is no partially-echoed bucket to
split the clear.

An attaching observer (the TUI) then renders each prompt exactly once, in
order: history replay cut at the boundary, then `deliveredMessages`, then
`queuedMessages` into the pending area; everything past the boundary arrives
exclusively as live events.

## Known limitations (accepted, documented so we don't re-derive them)

- **Steered prompts are invisible to fresh attachers.** Their content exists
  only as a `queued_command` sidecar attachment (dropped by
  `historyToSdkMessages`) — there is no user/assistant entry to replay.
  Including them in `deliveredMessages` would not fix this: with no echo ever
  coming, they would either linger forever (stale duplicates for every later
  attacher) or be cleared by the next emission and vanish anyway. The real
  fix, if ever wanted, is rendering `queued_command` attachments during
  history replay. Live-attached observers do see steered prompts (their
  `userMessageDequeued` renders from the pending area).
- **Merged-bucket display inconsistency (cosmetic).** An attacher in the
  delivered window sees a merged bucket as N separate user messages (from
  `deliveredMessages`); once echoed, history shows the single `\n`-joined
  entry the CLI actually wrote. Same content, different segmentation.
- **Interrupt can drop a delivered prompt.** An interrupt's synthetic user
  message clears `deliveredPending`; if the CLI also discarded the prompt
  without writing it, it is gone from every view. No display path could have
  shown it — the daemon cannot distinguish "written, echo pending" from
  "discarded by the interrupt".
- **Compaction can hide a delivered append.** A delivered-but-unechoed
  `shouldQuery: false` append that survives into a compaction is cleared by
  the new segment's first message, but its entry lives in the pre-compaction
  segment `get-messages` no longer returns. Its content reached the model
  (via the compact summary's source material); it just stops being displayed.
- **Attach-during-compaction race hides the compact summary.** When a
  compaction lands between the snapshot and the `get-messages` read, the
  boundary uuid is absent from the returned segment and replay renders
  nothing (correct: the buffered events already carry the new segment's
  assistant output, so replaying it would duplicate). But the
  compact-summary _user_ text renders nowhere: live `sdkMessage: user` text
  is never rendered, and the summary is not an accepted prompt, so it is in
  neither `deliveredMessages` nor any dequeue event. That attacher sees the
  "context compacted" banner and the conversation resuming without the
  summary text. (Reviewer round 3.)
- **Boundary-undefined delivery race.** If `lastTranscriptUuid` is undefined
  (no user/assistant emission yet this daemon lifetime → replay-all) while a
  prompt is delivered-but-unechoed, and the transcript read already includes
  that prompt's entry, replay-all plus `deliveredMessages` (or the buffered
  dequeue event) can render it twice. In practice this needs a just-revived
  daemon with prior history + an instant query + an instant attach within
  the read window; accepted as negligible.
