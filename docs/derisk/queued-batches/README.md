# Derisk: queued batches — how the CLI records several stamped prompts queued at once

Question (docs/specs/query-pending-list.md): when N uuid-stamped prompts
are queued together, does the session file keep one identity per prompt or
one per batch — i.e. can the daemon's pending list hold one item per
stamped uuid, or must it hold a batch under a representative uuid? And
does an append (`shouldQuery: false`) ever share an entry with a
neighbouring prompt?

Run: `node docs/derisk/queued-batches/probe.mjs` (LIVE, haiku, ~12 calls,
`includePartialMessages` like the daemon). Artifacts in `captures/`
(SDK 0.3.258, 2026-09-16).

## Findings

| case                                                                                       | file                                                                                                                                                                                                                            | `result`s                                                        | `command_lifecycle`                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1..S3 default priority, queued while a Bash tool runs (absorbed, "steer")                 | **one `queued_command` attachment per member**, in submission order, directly after the `tool_result` user entry; each `attachment.source_uuid` = its own stamped uuid; three `queue-operation remove (absorbed_mid_turn)` rows | none of their own                                                | queued/started/completed **per member**, all inside the running turn       |
| T1..T3 default priority, queued during a text-only turn (merged next turn)                 | **one `user` entry**, content = the three prompts `\n`-joined, entry `uuid` = **T3, the last member**; three `queue-operation dequeue` rows before it                                                                           | one                                                              | queued per member; started ×3 then completed ×3 around the one merged turn |
| G1..G3 `later`, queued while a Bash tool runs (merged next turn)                           | same shape as T: **one entry, `\n`-joined, uuid = G3 (last)**                                                                                                                                                                   | one                                                              | as T                                                                       |
| D1, D2 `shouldQuery:false` then D3, each submitted idle after the previous completed       | **three separate `user` entries** under their own uuids                                                                                                                                                                         | one each (appends: `system:init` + empty `result`, no assistant) | full queued/started/completed per message, sequential                      |
| E1, E2 `shouldQuery:false` then E3, submitted idle back to back                            | **three separate entries**, `enqueue`×2 then `dequeue`/entry one at a time                                                                                                                                                      | one each                                                         | E1 completes before E2 starts, E2 before E3                                |
| M1 `later`, M2 `later`+`shouldQuery:false`, M3 `later`, queued while a Bash tool runs      | **NOT merged**: three separate entries, each preceded by its own `dequeue`                                                                                                                                                      | one each (M2's has no assistant)                                 | sequential per message                                                     |
| H1 default, H2 `shouldQuery:false`, H3 default, queued during a text-only turn             | **NOT merged**: three separate entries, one at a time                                                                                                                                                                           | one each                                                         | sequential per message                                                     |
| K1, K2 `later`, K3 `later`+`shouldQuery:false`, K4 `later`, queued while a Bash tool runs  | **runs merge**: `K1\nK2` under **K2**, then K3, then K4 — three entries                                                                                                                                                         | one each                                                         | sequential per run                                                         |
| J1 text, J2 `[image, text]`, J3 text, default, during a text-only turn (`probe-image.mjs`) | one entry under **J3**, content = **block array** `[text J1, image, text J2, text J3]` — strings lifted to text blocks, arrays spliced, no `\n`                                                                                 | one                                                              | —                                                                          |
| L1 `[image, text]`, L2 text, default, during a text-only turn (`probe-image.mjs`)          | one entry under **L2**, `[image, text L1, text L2]`                                                                                                                                                                             | one                                                              | —                                                                          |

`probe-mid-drain.mjs` (LIVE, 10 calls, 2026-09-20; artifacts in
`captures/mid-drain-*`) asks what a prompt accepted while a bucket is
mid-drain does — pushed at the first `stream_event` of run 1's turn:

| case                                                                                                   | file                                                                                                        | `command_lifecycle`                                                                   |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P1 `later`, P2 `later`+`shouldQuery:false`, P3 `later` during a Bash tool; N0 default during P1's turn | **N0 cuts ahead of the remaining runs**: P1, reply, N0, reply, P2, P3, reply                                | P1 started/completed, then N0, P2, P3 sequentially                                    |
| R1..R3 as above; R0 `now` during R1's turn                                                             | **R0 cancels the running turn**: R1's user entry with **no assistant reply**, then R0, reply, R2, R3, reply | R1 started → R0 queued → `result` → R1 **cancelled** → R0 started/completed → R2 → R3 |

Neither batch shape puts a stamped uuid on the query stream (as before);
the only query-side trace is `command_lifecycle`.

`probe-image.mjs` (LIVE, 4 calls) is the block-content variant: artifacts
in `captures/image-*`.

## Consequences for the spec

- **Appends never coalesce.** An append is always its own entry, whether
  submitted idle (spaced or back to back) or queued mid-turn, and every
  append produces its own empty `result`. "Append then turn" is two
  entries under two uuids.
- **Within a same-priority bucket, maximal runs of consecutive querying
  members merge; an append splits runs.** T (default) and G (`later`)
  merged into one `\n`-joined entry keyed by the **last** member's uuid,
  matching echoed-message-placement FINDINGS Q4; `[Q, Q, A, Q]` (K) became
  `Q\nQ` (keyed by the run's last member), `A`, `Q` — one dequeue and one
  `result` per run. This contradicts `queue-model.ts`, which drains the
  whole top-priority bucket as one delivery at a `result` regardless of
  `shouldQuery`; it must emit one `userMessageDequeued` per run, with the
  following runs dequeued at the following `result`s.
- **The bucket is re-ranked at every `result`.** A higher-priority prompt
  accepted while a bucket is mid-drain runs before the bucket's remaining
  runs, so the queue model must recompute the top bucket per `result`
  rather than commit to a bucket at its first dequeue. `now` is an
  interrupt (echoed-message-placement FINDINGS, priority table): the
  aborted turn still ends with a `result` (before the `cancelled`
  lifecycle), so "one run per `result`" holds; the user entry with no
  reply is what the file shows for it.
- **The join has two shapes.** All-string runs become one `\n`-joined
  string; a run with any block-form member (`clauctl prompt --image`)
  becomes one block array: string members lifted to `{type: "text"}`
  blocks, arrays spliced, submission order, no separator. The daemon's
  join function must reproduce both.
- Steers need no batch handling: each dequeued steer is its own pending
  item, resolved by its own attachment. A steer batch is N items.
- A merged turn is one file entry keyed by the **last** member's uuid;
  the other N−1 uuids never appear in the file. "Last member" is two
  observations on one SDK version; the SDK's docs only say
  "batch-representative uuid" — the sdk test pins which. `later` members
  during a Bash `sleep` (durable across tool→result handoffs, FINDINGS
  Q3) is the robust driver for that test.
- `command_lifecycle` `started`/`completed` are emitted for every member,
  representative or not, so lifecycle cannot distinguish the
  representative either.
