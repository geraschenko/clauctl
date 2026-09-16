# Confirm a delivered prompt by identity, not by position

Raised in the phase-5 docs review (docs/specs/session-tracker/phase-5-docs.md,
2026-09-15). Deferred; needs its own spec.

## Today

`deliveredMessages` (docs/user-message-tracking.md) holds prompts the queue
model dequeued as turn/append until "some later uuid-carrying `sdkMessage`"
arrives, and is then cleared wholesale. That is positional confirmation:
entries land in file order, so a later emission proves every earlier
delivered prompt's entry is on disk. It never says _which_ entry is the
prompt's, and it is wrong exactly when an interrupt makes the CLI discard a
delivered prompt: the interrupt's own emissions clear the list and the
prompt vanishes from every view.

Text matching against the file stream is ruled out (Anton): fragile, and
merged buckets join several prompts into one `\n`-joined entry.

## The handle: `SDKUserMessage.uuid`

`docs/derisk/uuid-stamping/` shows the CLI persists a host-chosen uuid:

- a turn/append prompt's `user` entry gets the stamped uuid as its own
  `uuid`;
- a steered prompt's `queued_command` attachment carries it as
  `attachment.source_uuid`;
- every stamped submission also produces `command_lifecycle` messages on
  the query stream (`command_uuid` = stamped uuid; `queued` → `started` →
  `completed`), and the SDK's interrupt/`cancel_async_message` address
  queued prompts by that uuid.

So stamping at accept time (request-handlers.ts builds the
`SDKUserMessage`; `crypto.randomUUID()`) gives the daemon an identity that
appears on the file stream, the query stream, and the cancellation API.

## Sketch

- `userMessageQueued` carries the uuid; `deliveredMessages` becomes keyed
  by it.
- A delivered prompt is confirmed when the file stream yields the entry
  with that uuid (or a `queued_command` with that `source_uuid`), not when
  any later message arrives. The merge (`src/core/stream-merge.ts`) already
  models this as "observe on `query` at delivery, resolved by the file
  entry" — the uuid-stamping findings spell out the steer caveat: observe
  on `query` only at a turn/append dequeue, or `excludeFrom("session")` at
  a steer dequeue, or the item pends forever.
- A `command_lifecycle` with a terminal state and no matching entry is
  the positive signal that the prompt was discarded; the fold can then
  drop it from `deliveredMessages` with an explicit reason (and a client
  can show "prompt discarded") instead of losing it silently.
- The merged-bucket display inconsistency stays: the file has one entry
  for N prompts; the N uuids would map to one entry.

## Open questions

- Is `command_lifecycle` reliable enough to replace the queue model's
  inferred dequeues altogether? The findings call it a candidate; it would
  remove the inference that decides turn vs steer.
- Does stamping change anything the CLI does with an unstamped message
  (ordering, `queue-operation` rows)? The probe saw none, on one SDK
  version.
- Settlement (docs/protocol.md, `[^settlement]`) currently waits for the
  entry behind any observed uuid; with stamped prompts, settlement of a
  delivered prompt becomes a real wait on the CLI persisting it, which the
  uuid-stamping findings already flag.
