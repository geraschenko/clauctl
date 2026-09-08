# Derisk: uuid stamping — does the CLI persist a host-chosen `SDKUserMessage.uuid`?

Question: when clauctl sets `uuid` on a streamed user message, does the
session log's `user` entry carry that uuid, so the daemon can recognise
its own submissions in the file by id instead of inferring placement?

Run: `node docs/derisk/uuid-stamping/probe.mjs` (LIVE, haiku, ~4 calls).
Artifacts in `captures/` (SDK 0.3.258, 2026-09-11).

## Findings

| submission                                                                   | file entry                                                                                                                                                                                                                   | uuid                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| A, submitted idle (starts a Bash turn)                                       | `user` prompt                                                                                                                                                                                                                | **= stamped uuid**             |
| B, queued mid-turn (default priority, absorbed at the tool result — "steer") | `attachment` with `attachment.type: "queued_command"`, `attachment.source_uuid` **= stamped uuid**; entry's own `uuid` is CLI-generated; `queue-operation` enqueue/remove (`reason: "absorbed_mid_turn"`) rows are uuid-less | referenced, not the entry uuid |
| C, submitted idle                                                            | `user` prompt                                                                                                                                                                                                                | **= stamped uuid**             |

The query stream never echoes any of the three uuids (as before).

## Consequences for the tracker spec

- A submitted prompt is a **query-stream action item**: the daemon
  `observe("query", uuid)` at acceptance and the log's `user` entry
  resolves it. Settledness therefore waits for the CLI to persist the
  prompt.
- A steered message never becomes a `user` entry; its uuid appears only
  as `attachment.source_uuid`. The daemon's queue model still decides
  "steer vs turn" by inference (queue-model.ts), but the attachment gives
  the file side a positive confirmation of the steer, and the merge must
  **not** expect a stamped uuid for a steered message to appear as an
  entry uuid — pending forever otherwise. Design question for the
  rewrite: observe the uuid on `query` only once the queue model emits
  its `turn`/`append` dequeue (not at acceptance), or `excludeFrom`
  `session` at the `steer` dequeue.
- `SDKUserMessage.uuid` must be a real uuid string (probe used
  `crypto.randomUUID()`); other formats untested.

## Follow-up observations (tests/sdk/stream-classification.test.ts, 2026-09-11)

- Slash commands accept a stamped uuid too: the `/cost` and `/compact`
  `user` entries (`<command-name>` bodies) carry the stamped uuid.
- Every stamped submission produces `command_lifecycle` messages on the
  query stream (`command_uuid` = stamped uuid; `state` = `queued` →
  `started` → `completed`). For the steered message all three states
  arrive during the running turn, before the running turn's own
  `completed`. Unstamped submissions produce none (the probe here had
  eight for A/B/C; the unstamped stream-classification probe had zero).
  This is a CLI-authored per-message lifecycle — a candidate for
  replacing queue-model.ts's inferred dequeues; not pursued yet.
- The SDK's interrupt request can cancel "every uuid-stamped main-thread
  command still in the queue" and `cancel_async_message` drops one by
  uuid (sdk.d.ts 0.3.258) — stamping is the handle for both.
