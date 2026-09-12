# Derisk: stream classification — which uuids are shared between the query stream and the session log

> Status: probe run once on SDK 0.3.258 (2026-09-11); findings below feed
> the classification table in docs/specs/session-tracker.md. Next: decide
> the SDK tests in tests/sdk/ that pin these behaviours (Anton).

`probe.mjs` (LIVE, haiku, ~10 calls): one session with a Bash tool turn
under PostToolUse + Stop command hooks, `/cost`, a plain turn, `/compact`,
a plain turn. Captures every SDK message (`captures/events.jsonl`), the
CLI's file (`captures/session.jsonl`), and a per-class tally
(`captures/report.json`) of "shared / query-only / session-only" by uuid.

## Findings

| class                                                                                                                       | verdict                     | note                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant` ↔ `assistant`                                                                                                   | shared                      | 8/8                                                                                                                                                                                                             |
| `user` tool results, post-compaction summary, `<local-command-stdout>` (`/compact`'s "Compacted", replayed with `isReplay`) | shared                      | 3/3 on the query stream (one of each; the stdout one was first miscounted as a summary — corrected 2026-09-12)                                                                                                  |
| **user prompts we submit**                                                                                                  | **session-only**            | the SDK does not echo them and clauctl stamps no uuid, so the file entry's uuid is unknown to the query side — **unless clauctl stamps `SDKUserMessage.uuid`, which the CLI persists** (see ../uuid-stamping/). |
| local-command input `user` entries (`<local-command-caveat>` `isMeta`, `<command-name>` not)                                | session-only                | output is shared (above, and `system/local_command` below)                                                                                                                                                      |
| **`system/local_command`** ↔ query **`assistant`**                                                                          | **shared, different types** | `/cost` output is an `assistant` on the query stream and a `system/local_command` entry in the file with the same uuid — classification must be by uuid, never "system entries are session-only"                |
| `system/compact_boundary` ↔ `system/compact_boundary`                                                                       | shared                      | also seen live on the real session 2026-09-10                                                                                                                                                                   |
| `system/stop_hook_summary`                                                                                                  | session-only                | **no hook message of any kind reached the query stream** (0 `hook_*`), although both hooks ran                                                                                                                  |
| `attachment`                                                                                                                | session-only                | 14/14                                                                                                                                                                                                           |
| `system/init`, `status`, `thinking_tokens`, `stream_event`, `result`, `rate_limit_event`                                    | query-only                  |                                                                                                                                                                                                                 |
| `system/turn_duration`, `system/api_error`                                                                                  | not observed                | treat as session-only until seen                                                                                                                                                                                |
| `queue-operation`, `last-prompt`, `atis-latch`                                                                              | uuid-less                   | never in the merge                                                                                                                                                                                              |

## Consequences for the tracker spec

- The classification is a function of (stream, message/entry class) →
  streams carrying the uuid, and one entry class (`system/local_command`)
  is shared with a _different_ class on the other side, so the table is
  keyed per side, not per "kind".
- Submitted user prompts become query action items once clauctl stamps
  `SDKUserMessage.uuid` (the CLI honours it; ../uuid-stamping/), except
  steered messages, which never get a `user` entry.

## Additional findings from the pinned test (tests/sdk/stream-classification.test.ts, 2026-09-11)

The test runs the same shape as the probe (Bash turn with a steered
message, `/cost`, `/compact`, closing turn), all prompts uuid-stamped,
and captures `query-events.jsonl` + `session.jsonl` under
`/tmp/clauctl-cbi-derisk/stream-classification/`. Two things the probe
did not show:

- **A shared uuid can repeat on the query stream.** When `/compact`
  directly follows `/cost`, the `/cost` output (`assistant` on the
  query stream, `system/local_command` in the file, and the
  compaction's preserved tail / `logicalParentUuid`) is emitted a
  second time after the compaction summary `user` message; the file
  holds it once. Reproduced 2/2. The probe's sequence had a plain turn
  between `/cost` and `/compact` and showed no repeat. Consequence: the
  daemon must dedup query uuids first-wins before `observe` (the merge
  library requires duplicate-free streams: a repeat while the first is
  unresolved is an `order-violation`, after resolution it is a node
  that never settles); the invariant the test pins is the order of
  _first_ occurrences.
- **`command_lifecycle` messages** (`{type:"command_lifecycle",
command_uuid, state: "queued"|"started"|"completed", uuid}`) appear
  on the query stream for every uuid-stamped submission, including
  slash commands and steered messages. The type is absent from
  `SDKMessage` in sdk.d.ts 0.3.258 (only mentioned in the interrupt
  request's docs alongside `cancel_async_message`). Query-only. See
  ../uuid-stamping/README.md.
