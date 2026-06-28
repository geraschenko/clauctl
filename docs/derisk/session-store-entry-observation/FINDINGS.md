# Findings: SessionStore as a persisted-entry observation point

> Probe date: 2026-07-29\
> SDK: `@anthropic-ai/claude-agent-sdk` 0.3.211\
> bundled Claude Code: 2.1.211

## Question

Can clauctl use the SDK's alpha `SessionStore.append()` hook as the complete,
ordered live source of session JSONL entries without changing its ordinary
local persistence and resume behavior?

This was investigated for the canonical session-entry stream planned in
`docs/specs/prompt-tail-parity-overview.md`. The probe used a temporary
`CLAUDE_CONFIG_DIR` and `shouldQuery: false`, so it exercised the real bundled
CLI and SDK persistence path without making a model request.

## Conclusion

`SessionStore.append()` is a strong observation point for entries written by
the Claude subprocess:

- the callback received the probed subprocess-written entries in file order,
  including UUID-less entries;
- every callback ran after the corresponding lines were already present in the
  local JSONL file;
- the SDK flushed the observed batches before delivering the turn's `result`.

The only demonstrated completeness gap is that clauctl's own synthetic
boundary writes use `appendFileSync` directly and therefore bypass the
subprocess's transcript-mirror hook. clauctl could close that gap by publishing
those writes through the same in-process observer. The experiment therefore
does **not** establish that SessionStore is unsuitable or incomplete once
supplemented.

SessionStore nevertheless buys little for clauctl's canonical entry stream.
clauctl still needs the local file for dormant history and its out-of-band
writer. A SessionStore-based design would additionally participate in query
resume through `load()`, and would need to reconcile a file snapshot with
already-buffered callbacks—especially UUID-less overlap. Direct file following
instead provides the history/live byte cutoff, observes every writer through
one source of truth, works for running and dormant agents, and leaves query
construction and resume untouched.

For this use case, use the local session JSONL file with a watch-before-read,
byte-positioned follower. This is a leverage decision, not a finding that
SessionStore is defective. SessionStore remains useful for external transcript
mirrors where the adapter intentionally owns resume materialization and
accounts for writes made outside the subprocess.

## SDK contract evidence

The 0.3.211 declarations describe `Options.sessionStore` as a secondary copy:
the subprocess still writes to `CLAUDE_CONFIG_DIR`, then emits entries to the
adapter after local-write success.

Relevant declared behavior:

- `append(key, entries)` receives JSON-safe POJOs corresponding to local JSONL
  lines.
- Calls are ordered within one process. Default batching is approximately
  100 ms; `sessionStoreFlush: "eager"` schedules a flush for every mirror
  frame.
- Rejected appends are attempted up to three times. A timed-out append is not
  retried because it may still commit. A permanently failed batch is dropped
  and reported as an SDK `mirror_error`; the subprocess continues.
- UUIDs are recommended idempotency keys for external stores, while UUID-less
  entries are appended without deduplication. A consumer that needs the raw
  append sequence must deliberately retain duplicate UUID occurrences instead
  of following the recommended upsert policy.
- On resume, `load(key)` runs in the SDK parent before subprocess spawn. A
  returned transcript is materialized into a temporary JSONL file and handed
  to the CLI's existing resume path.

The bundled SDK implementation also flushes its transcript-mirror batcher
before exposing a `result` message and once more when its message reader ends.

## Probe 1: eager append observation

### Setup

The probe:

1. created a temporary `CLAUDE_CONFIG_DIR`;
2. generated an explicit session UUID;
3. started a real SDK streaming-input query with:
   - `persistSession: true`;
   - an in-memory `SessionStore`;
   - `sessionStoreFlush: "eager"`;
4. yielded one human-origin `SDKUserMessage` with `shouldQuery: false`;
5. recorded each append callback and read the local session file from inside
   the callback;
6. consumed the SDK stream through its successful `result`.

The input iterable stayed open until the first append callback. This made the
probe await the observation condition rather than an assumed delay. A 15-second
abort timer existed only as a bounded failure deadline.

### Observed append sequence

The first callback contained, in exact local-file order:

1. UUID-less `queue-operation` enqueue;
2. UUID-less `queue-operation` dequeue;
3. the UUID-bearing user entry;
4. UUID-bearing deferred-tools attachment;
5. UUID-bearing agent-listing attachment;
6. UUID-bearing skill-listing attachment.

A second callback contained the UUID-less `last-prompt` entry.

For both callbacks:

- the key was `{ projectKey, sessionId }` for the expected project/session;
- the local session file already existed;
- all callback entries were already present in the file in the same order;
- parsing the local lines produced objects equal to the callback payloads.

The SDK stream then produced `system/init` followed by a successful `result`.
Both append promises had resolved before that result was delivered.

### What this establishes

For this no-query turn, eager SessionStore observation was complete and ordered
relative to the local transcript, preserved UUID-less records, and provided a
post-local-write callback before turn completion.

It does not establish completeness for every entry kind or failure path; see
Limitations.

## Probe 2: resume participation

A second SDK query resumed the temporary session while the ordinary local JSONL
file remained present. It supplied another SessionStore whose `load()` logged
the call and returned `null`.

Observed call order:

1. `load({ projectKey, sessionId })`;
2. eager append callbacks for new resume/input entries;
3. successful SDK result.

The existing local transcript remained and the resumed CLI appended further
entries. This proves that merely supplying `sessionStore` adds an adapter call
to the resume path. The probe did **not** compare every resulting loader detail
against a control run without SessionStore, so it does not prove that a
`load() => null` observer changes the final conversation semantics. The public
contract nevertheless assigns `load()` ownership of external resume
materialization when it returns entries, which is unnecessary coupling for a
read-only observer.

## Why append observation is insufficient for clauctl

### clauctl has another writer

`src/core/session-file.ts` implements `appendSessionEntries()` with a direct
`appendFileSync`. `set-context` uses it to write synthetic compact-boundary and
optional summary entries. Those writes are deliberately outside the Claude
subprocess and therefore cannot generate the subprocess's
`transcript_mirror` frames.

A SessionStore-based observer would need a second explicit publication path for
those entries. The session file already combines both producers, so following
it avoids split responsibility.

### Snapshot/live overlap still needs reconciliation

`append()` happens after local-write success. If an observer subscribes to
append callbacks and then reads history, an append can be both:

- present in the history snapshot; and
- buffered for subsequent live delivery.

UUID-bearing overlap can be suppressed by UUID, but canonical semantics retain
every UUID-less occurrence. Correctly reconciling those records requires
ordered suffix matching or an equivalent file position. A byte-positioned file
follower gets that cutoff directly: establish the watch first, take a snapshot
to a known byte position, then drain later changes from that position.

### Resume coupling is avoidable

clauctl currently resumes from the normal local transcript. Passing a
SessionStore means implementing `load()` semantics, accepting an alpha option
in every query/restart, and maintaining fidelity with the SDK's materialization
path merely to observe writes already available in the local file.

The file follower does not alter query construction or loader behavior.

## Limitations and future probes

The experiment did not test:

- a model-backed turn, tool use, automatic or manual compaction;
- session rollover (`/clear`) or subagent transcript keys;
- default `"batched"` cadence versus `"eager"` beyond the declared contract;
- append rejection, retry, timeout, `mirror_error`, or process-crash behavior;
- whether every possible local CLI write produces a mirror frame;
- byte-for-byte serialization equality (only parsed-object equality is
  required by the SDK and was checked here);
- a controlled resume comparison between no store, `load() => null`, and
  `load() => entries`.

If SessionStore is adopted later, run focused probes for those paths and decide
explicitly whether the adapter is an idempotent external mirror or an ordered
append log. The SDK's recommended UUID upsert behavior is unsuitable for the
latter because Claude can legally re-persist duplicate UUIDs.
