# Tail parity

> Spec 3 of the prompt/tail parity effort
> ([prompt-tail-parity-overview.md](prompt-tail-parity-overview.md)). Builds on
> the canonical entry stream (Spec 1,
> [canonical-session-entry-stream.md](canonical-session-entry-stream.md)) and
> the streaming conversions/formatters (Spec 2,
> [streaming-conversions-and-formatters.md](streaming-conversions-and-formatters.md)).

# SPEC

## Problem statement

`clauctl tail` today is a raw sdk.sock JSONL watcher. Bring it to the
composable observation model: select messages, entries, or events; render
human-readable output by default with canonical JSONL behind `--json`; replay
persisted history after a cursor with `--since`; and settle on `--until`
conditions for every type. Messages and entries come from the session file
through the Spec 1/2 pipeline; events come from sdk.sock. Following an active
agent composes both sources into one observation stream — the interface we
wish the Claude Agent SDK provided — so dormancy, rollover, and settlement are
observable facts rather than hangs.

## Command surface

```text
clauctl tail [--type messages|entries|events]
             [--json]
             [--since <uuid>]
             [--until <condition>]
             [--timeout <seconds>]
```

- `--type messages` is the default. Tail follows by default; there is no
  `--follow` flag.
- `--json` emits canonical JSONL instead of formatted text.
- `--since <uuid>` starts after the retained first occurrence of that uuid in
  the current session file. Rejected for `--type events` (sdk.sock has no
  historical event log). A cursor absent from the current session file is an
  error naming the uuid and file — never "from the beginning". Older session
  files are not searched.
- `--until` accepts the existing conditions (`turn-end`, `idle`,
  `no-activity:<secs>`) for every type.
- `--timeout 0` emits available history and exits without accepting live
  activity. For `--type events` that history is the subscription snapshot
  alone.
- Formatting knobs stay on `format`; tail renders with default format options.
  Callers pipe `--json` output through `format` when they need non-defaults.
- tail never revives an agent, exactly as today.

## Behavior matrix

Liveness is the existing `isPidAlive(daemonPid)` check.

| type     | live agent                                                                | dormant/archived agent                          |
| -------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| messages | AgentObserver: history + follow, projected and formatted                   | finite: latest session file, canonical, projected |
| entries  | AgentObserver: history + follow, one line per entry                        | finite: latest session file, canonical            |
| events   | sdk.sock subscription (today's stream), formatted by default               | error: no live event source; tail never revives   |

Dormant messages/entries emit history and exit 0. A `--until` condition on a
dormant agent is trivially met (wait's rule: a dead process is conclusive
inactivity), so history is emitted and the command exits 0.

## Settlement classification

Every way a tail ends is classified so formatter flushing and cursor emission
follow mechanically:

**Graceful completion** — flush the formatter (`end()`, cursor line for
formatted messages) and exit 0:

- `--until` condition met (after entry catch-up, below);
- `--timeout` expired (tail was asked to watch for a bounded time, and it
  watched — the existing rule);
- `--timeout 0` after history;
- dormant agent's history end;
- socket close during a messages/entries follow — **conclusive idleness**: the
  daemon exiting is the strongest possible idle evidence, so this counts as
  graceful even with an unmet `--until` (extends wait's dormant-at-start rule).
  The observer drains file bytes already visible before closing.

**Runtime error** — no flush, exit 1:

- entry-stream failure (truncation, replacement, malformed line, watcher
  error);
- missing `--since` cursor;
- `--type events` on a dormant agent;
- socket close during a `--type events` tail with an unmet `--until` (today's
  rule, unchanged — events have no file to give the dormancy reading);
- bounded catch-up expiry (below).

**External interruption** (SIGINT) — no flush, no cursor; the process dies
mid-stream. An indefinitely followed stream has no promised final cursor.

Usage errors (bad flag combinations: `--since` with events, malformed
condition) exit 2 before any connection is made.

## `--until` settlement and entry catch-up

Conditions are evaluated on the sdk side of the observation stream with the
existing `untilMetAtSeed`/`untilMetByEvent`/`untilQuietMs`. Because entries lag
the sdk stream by the CLI's persistence delay (~100–180 ms), meeting a
condition does not end a messages/entries tail immediately:

1. When the condition is met (at seed or by an sdk event), record the target
   leaf: `state.sdk.leaf?.uuid`.
2. The tail settles when the target is `undefined` (nothing to catch up) or
   the target has been **consumed as an entry observation** — the settlement
   helper tracks the uuids of entries it has seen flow through the merged
   stream, so a target consumed before the condition fired settles
   immediately, and one still in flight settles when its entry arrives.
   Deliberately *not* `state.entries.seenUuids`: that set is shared by
   reference with the file scanner and already contains every history uuid at
   seed time, so testing it would settle before the queued history rendered.
3. **Bounded catch-up**: if the target has not been consumed within
   `CATCHUP_TIMEOUT_MS` (10 000) of the condition being met, fail with a
   runtime error naming the uuid and file. A flush failure becomes a diagnosis
   instead of a hang.

A condition met at seed therefore does not bypass history: the queued history
events drain and render until the target leaf is consumed. Entries positioned
after the target (typically uuid-less bookkeeping) may be omitted —
consistent with Spec 1's rule that uuid-less entries cannot advance a cursor.

`no-activity`'s quiet window is driven by the merged stream, so entry arrivals
also reset it. Entries only ever trail sdk activity by the persistence delay,
which is negligible against seconds-scale windows.

## Session rollover

A new session announces itself as a `system/init` sdkMessage whose
`session_id` differs from the folded `state.sdk.sessionId` (there is no
dedicated event kind). On rollover during a messages/entries follow, the
observer:

1. closes the current entry client;
2. derives the new file path as `dirname(currentFile)/<sessionId>.jsonl` (the
   project directory never changes for an agent — same cwd);
3. awaits the file's existence by watching the project directory (no
   polling), bounded by a deadline so a never-created file fails rather than
   hangs, then opens a new `SessionEntryClient` with `history: "emit"`, no
   `since`, and the **same** `CanonicalEntryFilter`;
4. continues the merged stream.

Carrying the filter gives cross-file first-wins deduplication. Empirically
(2026-07-30, two multi-session agents in the live registry) consecutive
session files share zero uuids — resume loads history into memory without
re-persisting it — so the carry is a no-op in the common case; but the
re-persistence findings' trigger hypothesis (a later `/compact` can flush
old-session entries into the new file) means duplicates can appear, and
first-wins suppresses the re-persisted copies.

If the sdk seed carries no `sessionId` and the agent record lists no sessions,
the entry side idles until the first init announces one — rollover from
nothing, same mechanism.

## Output formats

Single source of truth: tail calls exactly the Spec 2 projection and
formatters — `projectEntries`, `MessageFormatter`, `formatEntryLine`,
`EventFormatter` — with default options.

**Byte-equivalence criterion**: for any finite tail (graceful completion), the
default formatted output is byte-equal to the same invocation's `--json`
output piped through the corresponding `clauctl format <type>`.

| type     | `--json`                                                     | formatted (default)                                  |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| messages | one bare `MessageRecord` per line (canonical message JSONL)  | `MessageFormatter`; `[cursor: <uuid>]` at flush      |
| entries  | one bare `SessionEntry` per line                             | `formatEntryLine` per entry; no cursor line          |
| events   | today's framing: `{"snapshot": …}` then `{"event": …}` lines | `EventFormatter`; no cursor                          |

The events snapshot line is deliberate divergence from pictl (whose raw tail
emits no seed record): clauctl's sdk.sock protocol is seed-plus-fold, and the
snapshot is what makes the stream self-contained for an observer.

## Type design

### New: `src/core/agent-observer.ts`

The composed observation client — sdk.sock plus the session entry stream as
one `StreamClient`, driven by the existing generated `runStream`:

```ts
export type AgentObservation =
  | Readonly<{ source: "entry"; entry: SessionEntry }>
  | Readonly<{ source: "sdk"; event: SdkEvent }>;

export interface AgentObservationState {
  /** Folded via nextAgentState from the subscription seed. */
  readonly sdk: AgentState;
  /** leaf + seenUuids; the dedup set is carried across rollovers. */
  readonly entries: EntryStreamState;
}

export class AgentObserver
  implements StreamClient<AgentObservation, AgentObservationState>
{
  constructor(agent: AgentRecord, options: EntryClientOptions);
  /** Connects and subscribes sdk.sock first (no init can be missed), resolves
   *  the session file (seed sessionId matched against the record's sessions,
   *  else the record's last session, else await the first init), opens the
   *  entry client, merges both subscriptions into one queue. */
  subscribe(): Promise<
    StreamSubscription<AgentObservation, AgentObservationState>
  >;
  close(): void;
  /** Entry-stream failure or socket error; undefined for a clean close. */
  get failure(): Error | undefined;
}
```

Socket close ⇒ final drain of visible file bytes, then the merged queue closes
(runStream outcome `"closed"`, classified graceful by tail). Entry-stream
failure ⇒ `failure` set, queue closes. Rollover is handled inside the
observer; observers of the merged stream just see the entries keep flowing.

### Changed: `SessionEntryClient` (src/core/session/entry-stream.ts)

```ts
constructor(
  filePath: string,
  options: EntryClientOptions,
  filter?: CanonicalEntryFilter,  // rollover carry-over; defaults to own
)
```

An externally supplied filter must not be combined with `history: "emit"` +
`since` (the filter already consumed its cursor); the constructor throws on
that combination.

### Rewritten: `src/core/tail.ts`

```ts
const TAIL_TYPES = ["messages", "entries", "events"] as const;
type TailType = (typeof TAIL_TYPES)[number];

const tailFlags = {
  type: enumFlag("Stream type", TAIL_TYPES),        // default "messages"
  json: booleanFlag("Emit canonical JSONL instead of formatted text"),
  since: parsedFlag("Replay after this entry uuid", parseUuidFlag, "uuid"),
  // parseUuidFlag is new (no uuid flag parser exists): syntax-check + UUID cast

  until: /* existing */,
  timeout: /* existing */,
};

async function tail(this: CommandContext, flags: TailFlags): Promise<void>;
// dispatches on type × liveness to the four paths in the behavior matrix

/** Records the target leaf when the sdk-side condition fires; tracks the
 *  uuids of consumed entry observations; answers true once the target has
 *  been consumed; owns the bounded catch-up deadline. */
class UntilSettlement {
  constructor(condition: UntilCondition | undefined);
  metAtSeed(seed: AgentObservationState): boolean;
  observe(
    observation: AgentObservation,
    state: AgentObservationState,
  ): boolean; // true = settle the stream
}
```

`UntilSettlement` is a tail-internal helper (exported for tests). Exact
member breakdown may flex during implementation; the observable behavior
(catch-up + bounded deadline) is normative.

tail.ts imports the renderers from `src/format/` — precedent: `core/app.ts`
already imports `format/command.ts`.

`wait` is untouched.

## Data flow

**Live messages** (`tail`, `tail --json`):

```text
AgentObserver.subscribe()
  ├─ sdk.sock subscribe ──────────────► seed AgentState ┐
  └─ SessionEntryClient(file, {emit, since}) ─ seed ────┴─ merged seed
runStream(observer, handler, timeoutMs)
  entry observation ──► projectEntries streaming core ──► MessageFormatter.push
                        (CanonicalEntryFilter already applied by the client)
  sdk observation ────► UntilSettlement.observe(state)
settlement (graceful) ─► formatter.end() ─► [cursor: <uuid>]
```

`--json` replaces the projection+formatter leg with
`JSON.stringify(record)+"\n"` per projected `MessageRecord`. Entries mode
skips the projection and renders `formatEntryLine` (or the bare entry).

**Live events**: today's `runStream` over the socket client; records pass
through `EventFormatter` (default) or are printed in today's framing
(`--json`).

**Dormant messages/entries**: `readSessionEntries(latest file)` →
`canonicalizeEntries(entries, since)` → the same projection/formatting legs →
flush. No sockets, no watchers.

## Cost

- Per live tail: one unix-socket connection, one fd, one `fs.watch` (plus a
  transient directory watch during rollover).
- Full-file scan at subscribe (accepted in the overview), and again for the
  new file on each rollover.
- `seenUuids` grows O(total uuids across all followed files) and is retained
  for the tail's lifetime — the price of cross-file dedup. With `--until`,
  the settlement helper keeps a second uuid set (consumption-ordered) of the
  same magnitude.
- Formatter/projection state: tool-use id→name map and dedup set, both O(file
  contents); unchanged from Spec 2.

## Edge cases

- Empty or freshly created session file: history is empty; follow proceeds.
- `--since` names a uuid seen only after rollover: not found in the initial
  file ⇒ error at subscribe (since applies to the file current at start).
- Rollover while `--until` catch-up is pending: `seenUuids` is shared across
  files, so a target re-persisted into the new file still satisfies it; the
  bounded deadline still applies.
- Two rapid rollovers: each init is processed in stream order; the directory
  await targets the latest announced sessionId.
- `--timeout 0 --type events --json` emits exactly one `{"snapshot": …}`
  line; formatted, exactly the snapshot's rendering.

## Non-goals

- **No correlation machinery** between the sdk and entry streams beyond
  settlement catch-up. In particular, delivery-kind annotation (marking a
  rendered message as steered/queued/turn from `userMessageDequeued`) is
  structurally excluded: tail's message output must equal `format messages`
  over the same entries, and the projection is entries-only by the settled
  single-projection decision.
- No event cursor and no `--since` for events. (Noted divergence: pictl's
  finite raw watch emits an entry cursor for cross-type resumption; not
  imported.)
- No lag masking (rendering from sdk events ahead of persistence) — that is
  the buried dual-adapter design.
- No searching older session files for a `--since` cursor.
- No revival of dormant agents; no daemon-maintained entry stream.
- No `--follow`/`-n` flags; no formatting knobs on tail.
- No changes to `wait`.

# IMPLEMENTATION IDEAS

- **Merged queue pump**: AgentObserver owns one `AsyncQueue<StreamEvent<…>>`
  and two pump loops (`for await` over each subscription), each folding its
  side of the state and pushing tagged observations. The sdk pump runs
  `nextAgentState`; the entry pump reuses the states the entry client already
  pairs with its events. Rollover: the sdk pump notices the sessionId change
  in its own fold and swaps the entry pump.
- **Awaiting the rollover file**: `fs.watch(projectDir)` + an existence check
  (watch first, then check, to close the race), resolved on the rename event
  naming the file. A deadline (reuse `CATCHUP_TIMEOUT_MS`?) so a never-created
  file fails rather than hangs — decide during implementation whether the
  deadline is shared or separate.
- **Bounded catch-up**: runStream exposes only one timeout; the deadline
  likely lives in the tail handler — record `conditionMetAt`, and on each
  observation compare. A stream that goes completely silent after the
  condition fires needs a timer to wake settlement: `Promise.race` the
  runStream promise against a deadline armed when the condition fires
  (clearTimeout on settle) — an awaited deadline, not a sleep.
- **timeout-0 drain**: verify the generated driver drains already-queued
  history events before an immediate deadline fires. If it does not, emit
  history before arming the timer (subscribe, drain queued events
  synchronously, then run).
- **conversation_reset**: clears `sessionId` until the authoritative init;
  rollover triggers on the init, so the reset itself needs no entry-side
  action.
- **Tests**: stream-commands.test.ts currently exercises the raw tail; those
  tests become `--type events --json` invocations. New tests: settlement
  catch-up (condition met, leaf lands later), bounded catch-up expiry,
  rollover mid-follow (two files, shared filter), dormancy close mid-follow,
  byte-equivalence of formatted vs `--json | format`.
- **Smoke**: live agent in the tui-harness sandbox; `tail --timeout 0` vs
  `get-entries | format messages` equivalence; rollover via `/clear`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] 2026-07-30: Derisk round. Decisions (Anton): composed AgentObserver
      ("the interface I wish the SDK provided"); socket close = conclusive
      idleness (graceful, any `--until` counts as met); rollover switches to
      the new file (no searching older sessions); all `--until` conditions
      for all types; events `--timeout 0` emits the snapshot; bare-record
      `--json` for messages/entries; no correlation machinery beyond
      settlement catch-up, which gains a bounded deadline. Empirical:
      consecutive session files of real multi-session agents share zero
      uuids; no session_changed event exists (init fold is the signal);
      pictl's raw tail emits no seed snapshot but does emit a final entry
      cursor (divergence noted, not imported).
- [x] 2026-07-30: Spec written; critique pass fixed one design flaw: catch-up
      tested against the shared `seenUuids` would settle at seed (the set
      already holds all history uuids at subscribe), skipping history
      rendering — settlement now tracks *consumed* entry observations. This
      corrects the overview's `--until idle` sketch, which named `seenUuids`.
      Also made the rollover file-await deadline normative and noted that no
      uuid flag parser exists yet.
- [ ] Owner review of the spec.
- [ ] Implementation.
