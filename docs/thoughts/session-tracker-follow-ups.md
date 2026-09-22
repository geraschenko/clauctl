# Session tracker / fold follow-ups

Items deferred from the query-pending-list phases
(docs/specs/query-pending-list.md and its `query-pending-list/phase-*.md`
work logs) that were not bugs worth fixing in-phase. Each is small; none
blocks anything. daemon.ts factoring is listed in
docs/specs/session-tracker.md "Follow-up work", not repeated here.

## Naming: `expectsSdkMessage` → `expectsQueryMessage`

(phase 4 WORK LOG, Anton's review 16099e0.) The tracker sets
`sessionEntry.expectsSdkMessage = !excludedFromQuery(entry)`, so the field
literally means "an sdkMessage twin will arrive". A plain `user` prompt
entry is `excludedFromQuery` (the SDK emits no message for a prompt; its
`query` node is the daemon's dequeue), so the field is `false` for it
even though the entry does meet a query node. Anton's proposal: rename to
`expectsQueryMessage` with the semantics "the daemon's recorded prediction
of whether this entry is excluded from the query stream, modulo
`scanExcluded`". That would fold the dequeue knowledge (a prompt entry's
query twin is the dequeue) into the tracker's predicate, which today lives
in `excludedFromOther` (classification.ts, the `queuedCommandSourceUuid`
and uuid-less arms). Decide whether the predicate should move before
renaming; a rename alone would make the name wrong for prompts.

## Unknown `/command` turn resolves as a head-mismatch

(phase 3.5 WORK LOG, side finding; corrected 2026-09-22.) A `/command`
the CLI does not know files no user entry (only two `system/local_command`
entries: the name and "Unknown command"), so the dequeue's `query` node
never meets a `session` twin. It is not stuck: the next shared node seen
on `session` closes it and it resolves as a **head-mismatch** anomaly
("seen on query, skipped by session"). Letting that anomaly stand would
train the user to ignore anomalies, and it is expected, so it should not
be logged either. Anton's preferred handling: catch the head-mismatch,
check whether the sdk-side message for that uuid starts with `/`, and
show a banner like "unknown /command" so the user knows claude ignored
it. Same mechanism could serve any other query-only message the CLI
turns out not to file (see the anomaly-log investigation, 2026-09-22).

## Not LIVE-verified

- Phase 3.5 item 5: the file wait now starts at the dequeue rather than
  at the first `init` (10 s `SESSION_FILE_TIMEOUT_MS`); the timing was
  reasoned, not observed under load.
- Phase 4 changed no wire shape, so its LIVE sdk suites were not rerun.
- `tests/sdk` compact-boundary suite `p4.q7 post-compact probe sees new
  compacted context`: a pure-SDK probe, failing on 0.3.258 as of the
  phase 3.5 run (31/32); keep-reach flips between runs (see
  docs/derisk/compact-boundary-injection/). Triage separately.

## SDK control-request flag audit

(query-pending-list.md WORK LOG.) `cancel_queued` / `cancel_async_message`
are unreachable through `Query.interrupt()`; audit which control-request
flags the SDK exposes vs. what the daemon relies on
(docs/claude-agent-sdk.md "interrupt").
