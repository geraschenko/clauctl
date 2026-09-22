# Phase 3.5: uuid-less events, slash-command runs, interrupt probes

> Work log for the deferrals of phase 3
> (docs/specs/query-pending-list/phase-3-identity.md, Deferred). Status:
> **implemented and committed** (review round 83641a3 addressed; WORK
> LOG). Side findings: docs/thoughts/session-tracker-follow-ups.md.

## Scope

Three independent items, ordered by evidence needed:

1. **Probes** (LIVE, haiku, `tests/sdk/`): what the CLI does with queued
   prompts across an interrupt / a `now` prompt, and the exact
   slash-command exemption predicate. Facts land in
   docs/claude-agent-sdk.md; they decide items 2 and 3.
2. **Slash-command exemption in the queue model**: `queue-model.ts`
   predicts a steer for a `/command` pushed mid-turn and merges two
   queued `/command`s into one run; the CLI does neither
   (docs/claude-agent-sdk.md, "Slash commands are turns of their own").
   Daemon-only fix, no protocol change.
3. **Every event a merge node**: the hub stamps every event that lacks a
   uuid and the fold observes each kind on its stream (Derisk 1 table),
   so `SessionState.resolved` is a topological sort of the whole stream.
   Removes the `contextChangedAfter` side channel.

Non-goals: no change to what the TUI renders for any event.

## Derisk — open questions

1. **Every event is a merge node** (Anton, 2026-09-21; rejects the
   "`contextChanged` only" proposal): the protocol guarantees a client can
   topologically sort _all_ events from `SessionState.resolved` alone, so
   nothing passes beside the merge. Each kind is observed on the stream it
   is synchronized with:

   | stream    | kinds                                                                                                                                                                                                                                                          |
   | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `query`   | `userMessageQueued`, `userMessageDequeued`, `compactSent`, `interruptSent`, `controlApplied`, `sdkMessage`, `sessionAppended` (its entry arrives on `session` as a `sessionEntry`), `shutdown` (a stamped node of every live session, excluded from `session`) |
   | `session` | `sessionEntry`, `sessionFileChanged`, `contextChanged`, `scanComplete`                                                                                                                                                                                         |
   | either    | `trackerAnomaly`: the stream whose processing raised it (`stream: MergeStream` field, proposed over two kinds)                                                                                                                                                 |

   Every event is a node of exactly one stream. `shutdown` on both streams
   (the original proposal) cannot "resolve only once nothing is pending":
   an id seen on both streams closes every predecessor on both, so a
   query-pending id whose echo has not reached the file resolves as
   head-mismatch — the observation asserts the file caught up rather
   than waiting for it (decided 2026-09-21).

   Decisions (Anton, 2026-09-21):
   - (a) **Queuing and insertion are different events.**
     `userMessageQueued.uuid` becomes a random event uuid; the prompt's
     uuid stays on `message.uuid` and enters `query` only at its
     dequeue, and only as the run key (a merged run's non-last uuids
     never enter). Proposed corollary (unconfirmed): the dequeue's node
     _is_ the run key — it is the insertion — so no second uuid on the
     dequeue; `eventUuid(event)` (Type Design) names each kind's node.
   - (b) **Payload uuids are the node.** Anything with a uuid is
     observed under it; anything without one is stamped by the hub
     (uuid-less SDK messages and entries included).
   - (c) **The session id is known ahead of time.** A fresh spawn
     generates the session uuid and passes `Options.sessionId`
     (sdk.d.ts 0.3.258: "Use a specific session ID … cannot be used with
     `resume` unless `forkSession`"); revival and set-context restarts
     pass `resume`; so `querySessionId` is seeded (daemon.ts already
     seeds it on revival) and a `SessionState` is created on first
     observation. Proposed (unconfirmed): query-side synthesized events
     are routed to `querySessionId` by the fold, as `sessionEntry` is to
     `fileSessionId` — no `sessionId` field on them, no `session_id`
     stamped on the outgoing prompt. Hole to document: between
     `conversation_reset` and the next `init` the new id is unknown
     (`new_conversation_id` is not it), so a prompt accepted then is
     queued on the old session and dequeued on the new — the reset rule's
     case already. Implementation risk to check:
     `tracked-session-log.ts` switches files whenever
     `querySessionId ≠ fileSessionId`; a seeded id before the file exists
     must not trigger a switch to a missing file.
   - (d) `trackerAnomaly` carries `stream: MergeStream`; `shutdown` is a
     stamped `query` node of every live session (revised from "both
     streams", see the table's note; the socket close, not the merge, is
     the client's signal).
   - (e) **Session start is a node on the new session's merge**
     (decided). Every session B begins with one node, id = B's session
     id, reached by two events that are by construction the heads of B's
     chains: a new `querySessionChanged` emitted by the hub the moment it
     first sees a query message with B's `session_id` (before that
     message's `sdkMessage`), observed on B's `query`; and
     `sessionFileChanged {sessionId: B}` observed on B's `session`. No
     exclusion. The node resolves exactly when both the Query and the
     follower are on B, and every later B node has it as predecessor on
     its chain, so nothing on B resolves before both switches. The old
     session A needs no sentinel: one Query and one follower mean all of
     A's query events precede B's first and all of A's session events
     precede `sessionFileChanged {B}` (the drain), so by the fold step
     that resolves B's node, A has every observation it will ever get —
     whatever could resolve on A already did, in earlier steps; anything
     still pending on A is stuck (reset rule / interrupt), not late. A
     total order across sessions is therefore fold-step order of the
     `resolved` lists; no client rule. A fresh spawn and a resume emit
     the pair too (`querySessionChanged` for the seeded id before the
     first `init`; `sessionFileChanged` for the seed file), else the
     file-side observation would resolve with a head-mismatch anomaly.
     The sentinel's query observation creates B's `SessionState`
     (replacing `fold-query-message.ts`'s first-message creation);
     `sessionFileChanged` creates it only when it arrives first. A
     same-file rescan (follower failure) is NOT a session start — open,
     see Derisk 1(g).
   - (f) `eventUuid(event)` confirmed; the dequeue's node is
     `uuids.at(-1)` (the dequeue is the insertion). Query-side synthesized
     events are routed by `querySessionId`; no `sessionId` fields, no
     `session_id` stamped on the outgoing prompt.
   - (g) **Same-file rescan** (decided). A rescan (follower failure:
     inode change, truncation; `follower-failure` anomaly already
     emitted) is not a session start: re-observing the session id on the
     rebuilt `session` chain would repeat an id on one stream (undetectable
     — resolved nodes are forgotten — but a violation of the model). So
     `sessionFileChanged` carries `uuid?: UUID`: a rescan's own node,
     hub-stamped; absent for a session start, whose node is `sessionId`
     shared with `querySessionChanged {sessionId}` (self-describing, no
     hub bookkeeping). `eventUuid` → `event.uuid ?? event.sessionId`; the
     fold's `excludeOther = event.uuid !== undefined` (a rescan is
     session-only). Without the exclusion it would still resolve — with a
     head-mismatch anomaly, in the step the first shared entry past the
     replayed prefix resolves, taking the whole prefix with it
     (stream-merge.ts header: exclusion only lets the proof happen
     earlier). Set-context's `restartQuery` resumes the same session id:
     no `querySessionChanged`, the merge continues.

2. **Slash-command predicate** (decided from the probe, 2026-09-21):
   `typeof content === "string" && content.startsWith("/")`. Evidence
   (`tests/sdk/steer-slash-command.test.ts`): `/nonexistent` is a
   command too (not steered, its own run with `local_command` "Unknown
   command" entries and no user entry, lifecycle completes); a `/cost`
   text **block** is steered like text (its attachment's `prompt` is the
   block array); a `later` `/cost` runs expanded after the default turns
   pushed after it; `[text, /cost, text]` in one bucket → three runs.
   `system/init.slash_commands` is rejected as the predicate: it omits
   `cost`, which the CLI runs (`tests/sdk/session-id-option.test.ts`).
3. **Interrupt** (decided from the probe, 2026-09-21): queued prompts
   survive both `interrupt()` and a `now` prompt and run after the
   aborted `result`; the receipt lists them as `still_queued` once the
   CLI has acknowledged them (`tests/sdk/interrupt-queue.test.ts`).
   Nothing changes in the daemon; user-message-tracking.md's limitation
   is replaced by the one-sentence rule.

## Definitions

- **Stamped event**: an `AgentEvent` the hub gives a `uuid` at emission
  (as `deliverUserMessage` stamps prompts) and the fold observes on one
  merge stream with `excludeOther = true`: it resolves right after its
  stream predecessors and appears in `SessionState.resolved` like any
  entry.
- **Slash command**: a queued `SDKUserMessage` whose string content the
  CLI treats as a command invocation (predicate from Derisk 2). Never
  demotable; always a run of one.

## Type Design (Item 3 shape agreed in Derisk 1(a)–(g) and the pre-compaction decisions, 2026-09-21; Item 2 predicate from Derisk 2)

### Item 2 — queue-model.ts

```ts
/** A `/command` prompt: the CLI never steers or merges one
 *  (docs/claude-agent-sdk.md, "Slash commands are turns of their own"). */
function isSlashCommand(message: SDKUserMessage): boolean; // string content starting with "/" (Derisk 2)

function isDemotable(message: SDKUserMessage): boolean; // existing rule && !isSlashCommand
function nextRun(head: QueuedMessage, tail: QueuedMessage[]): QueuedMessage[];
// an append OR a slash command alone; a querying prefix stops before the
// first append or slash command.
```

No new exports; protocol unchanged.

### Item 3 — every event a merge node

```ts
// protocol.ts — `uuid` on every variant whose payload carries none
| { kind: "userMessageQueued"; uuid: UUID; message: SDKUserMessage }  // uuid random; message.uuid = prompt uuid
| { kind: "userMessageDequeued"; delivery: MessageDelivery; uuids: readonly [UUID, ...UUID[]] }  // node = uuids.at(-1)
| { kind: "compactSent"; uuid: UUID; message: SDKUserMessage }
| { kind: "interruptSent"; uuid: UUID }
| { kind: "controlApplied"; uuid: UUID; request: SdkControlApplied }
| { kind: "contextChanged"; uuid: UUID; boundary: UUID; leaf: TreeNodeRef | null }
| { kind: "sdkMessage"; message: SDKMessage; uuid?: UUID }        // node = message.uuid ?? uuid; payload never mutated
| { kind: "sessionEntry"; entry: SessionEntry; uuid?: UUID; ... }  // node = entry.uuid ?? uuid; payload never mutated
// The head of the new session's query chain: emitted by the hub before the
// first sdkMessage carrying `sessionId` (for the seeded id: at construction).
| { kind: "querySessionChanged"; sessionId: UUID }   // node = sessionId
| {
    kind: "sessionFileChanged";
    sessionId: UUID;
    /** A same-file rescan's own node (the session id already heads this
     *  session's chain); absent for a session start, whose node is
     *  `sessionId`, shared with `querySessionChanged`. */
    uuid?: UUID;
  }
| { kind: "scanComplete"; uuid: UUID }
| { kind: "sessionAppended"; message: SDKMessage }    // node = message.uuid (always set: the daemon wrote it)
| { kind: "trackerAnomaly"; uuid: UUID; stream: MergeStream; anomaly: TrackerAnomaly }
| { kind: "shutdown"; uuid: UUID; reason: ... }

/** The event's merge node: the payload's uuid when it carries one
 *  (sdkMessage, sessionEntry, sessionAppended: the message's; dequeue:
 *  `uuids.at(-1)`; session start: `sessionId`), else the stamped `uuid`. */
export function eventUuid(event: AgentEvent): UUID;

/** The one stream each kind is synchronized with (Derisk 1 table). */
export function eventStream(event: AgentEvent): MergeStream;

// event-hub.ts: the hub stamps every payload/event lacking a uuid.
type Unstamped<E> = E extends { uuid: UUID } ? Omit<E, "uuid"> : E;   // distributive
emit(event: Unstamped<Extract<AgentEvent, { kind: ... }>>): void;      // the list as today
// observeSdkMessage stamps `message.uuid` when absent; the tracker stamps
// uuid-less entries (SessionEntry.uuid becomes required? — see Cost).
// acceptUserMessage takes the event uuid from the hub (randomUUID()).

// agent-state/agent-state.ts fold — one rule replaces the pass-through cases:
//   session-side kinds: observeOn(fileSession, "session", eventUuid(e), e.kind, true)
//   query-side synthesized kinds: observeOn(querySession, "query", eventUuid(e), e.kind, true)
//   sdkMessage: every message on "query" (subagent traffic too, excluded
//     from "session"; the rest per classification.ts); sessionEntry /
//     dequeue: as today (they choose excludeOther)
//   shutdown: observeOn(session, "query", uuid, kind, true) for every session
//   trackerAnomaly: observeOn(session of `stream`, stream, uuid, kind, true)
//   querySessionChanged: creates the SessionState (replacing
//     fold-query-message.ts's first-message creation), sets querySessionId,
//     observeOn(session, "query", sessionId, kind, false)
//   sessionFileChanged: session start → fresh SessionState unless it exists,
//     observeOn(session, "session", sessionId, kind, false); rescan → the
//     rebuilt state as today, observeOn(session, "session", uuid, kind, true)
// The hub emits querySessionChanged in observeSdkMessage when
// message.session_id ≠ state.querySessionId, before the sdkMessage; and at
// construction for the seeded id (daemon.ts passes Options.sessionId on a
// fresh spawn, `resume` otherwise). A query-side event before
// `querySessionId` is set is impossible after (c); asserted as an anomaly.

// tui/session-models.ts
private readonly pendingEvents = new Map<UUID, AgentEvent>(); // stamped events awaiting resolution, by eventUuid
// observe: a stamped kind → pendingEvents.set; applyResolutions: a resolved
// uuid in pendingEvents → delete and dispatch (contextChanged → onContextChanged;
// the rest: nothing today). QueuedEntry/enqueueContextChange/Resolution.contextChanged removed.

// tui/transcript.ts: addBanner(text, color, uuid) keys the banner so
// resolve(uuid) moves it; partFor's unkeyed rule stays for the welcome banner only.
```

`format/events.ts` prints `eventUuid` for every record.

## Data Flow

- Item 2: unchanged paths; `observeSdkMessage` marks/steers only
  demotable entries, so a slash command waits for a `result` and
  `nextRun` cuts around it.
- Item 3, a session B starting after A: hub sees B's first query message
  → emits `querySessionChanged {B}` (creates B's state, node B on B's
  `query` chain head) → B's `sdkMessage`s observe behind it (pending: B
  unresolved) → the follower drains A (`whenFileSettled`) → `open` emits
  `sessionFileChanged {B}` (node B on B's `session` chain head) → B
  resolves; everything of B behind it resolves in later steps as usual.
  A got its last observation before either; whatever could resolve on A
  did. A fresh spawn: `querySessionChanged` at hub construction, then
  `sessionFileChanged` when `TrackedSessionLog.start` opens the seed
  file. Every other stamped event: emitter → `hub.emit` (stamps) → fold
  observes on its stream, excluded from the other → `resolved` carries
  it → `SessionModels.applyResolutions` dispatches from `pendingEvents`
  (`contextChanged` → `onContextChanged`, after that step's entries;
  replaces `contextChangedAfter`). Attach: a stamped event pending in the
  seed state is a pending id with no payload; the TUI dispatches nothing
  for it (a `contextChanged` pending at attach is covered by the attach
  render itself).

## Cost

- Item 3: one transient merge node per event; `pendingEvents` holds the
  unresolved ones. `stream_event` frames are the volume (one per token
  delta): each becomes a node that resolves with its `assistant`
  predecessor's resolution — a merge-size increase proportional to stream
  lag, as today's user/assistant nodes are. Uuid-less payloads are
  stamped beside the payload (WORK LOG, pre-compaction decisions), so
  `SessionEntry` and the tree builders are untouched.
- Probes: ~4 haiku sessions once; the pinned tests re-run on SDK bumps.

## Tests

- `tests/sdk/steer-slash-command.test.ts` (extended): `/nonexistent`,
  block-form `/cost`, a `later` `/cost` in the steer window;
  `[text, /cost, text]` into a text-only turn.
- `tests/sdk/interrupt-queue.test.ts`: (a) sleep turn, `later` text
  pushed at tool_use, `interrupt()` once it is `queued` — it runs after
  the aborted result, `still_queued` names it; (b) sleep turn, default
  text then a `now` text pushed at tool_use — the default text runs
  unsteered after the `now` turn; (c) `/cost` with `now` interrupts and
  expands; `command_lifecycle` states of each.
- `tests/sdk/session-id-option.test.ts`: `Options.sessionId` honored;
  the file appears with the first turn (absent at spawn and at `init`);
  `slash_commands` names carry no slash.
- `queue-model.test.ts`: slash command mid-turn → no steer, its own
  `turn` after the result; `[text, /cmd, text]` → three runs.
- `agent-state.test.ts`: session start resolves only once both
  `querySessionChanged` and `sessionFileChanged` are folded, and B's
  query messages stay pending until then; a rescan's `sessionFileChanged`
  resolves alone; `shutdown` is query-pending on every session behind the
  query tail and leaves session-pending ids alone; `trackerAnomaly`
  observes on its `stream`; a stamped
  `contextChanged` resolves after its entry.
- `session-models.test.ts`: `contextChanged` reported once, after its
  entry, via `pendingEvents`; `session-model.test.ts`:
  `enqueueContextChange` tests removed.
- `event-hub.test.ts`: `querySessionChanged` precedes the first
  `sdkMessage` of a new session id; the seeded id's at construction.
- `tests/sdk/`: `Options.sessionId` honored by the CLI (the session file
  lands under the chosen id) — unprobed today; fact for
  docs/claude-agent-sdk.md.

## Plan

1. Probes (item 1); record facts in docs/claude-agent-sdk.md; revise
   user-message-tracking.md's limitation; decide Derisk 2 and 3.
2. Item 2 with its unit tests.
3. Item 3 (after Derisk 1 is answered): protocol → hub → fold → TUI →
   docs (protocol.md event table, user-message-tracking.md, delete the
   `contextChangedAfter` mention in docs/thoughts/old/fold-resolved-events.md).
4. Presubmit; LIVE reruns; TUI smoke (compaction → rebuild once).

# WORK LOG

- [x] Derisk 1 (every event a merge node) decided 2026-09-21: (a)–(g);
      stream-merge.ts header gained the "exclusion is never required"
      sentence (committed by Anton with the phase 3 round-1 fixes).
- [x] Pre-compaction decisions 2026-09-21 (Anton):
  - Payloads are passed along exactly as received: never mutate an
    `SDKMessage` or a `SessionEntry` to stamp it. `sdkMessage` and
    `sessionEntry` get `uuid?: UUID` beside the payload, set by the hub /
    tracker only when the payload carries none; `eventUuid` →
    `payload.uuid ?? event.uuid`.
  - Every `sdkMessage` is observed on `query` — including
    `parent_tool_use_id` (subagent) traffic, which
    `fold-sdk-message.ts` skips today; it is `excludeOther = true` (its
    entries live in the subagent's transcript, never this file). After
    this phase every event is observed on exactly one stream (`shutdown`
    included: query-only, revised during implementation — see the Derisk
    1 table's note).
  - Switch trigger: the CLI creates the session file at the first turn,
    so with `querySessionId` seeded at spawn the switch worker must not
    key on it (its `awaitFileExists` clock would start at spawn and time
    out while the user idles in the TUI). `TrackedSessionLog` tracks the
    session id of the last observed `sdkMessage` itself (it already
    subscribes to the hub) and switches when that differs from
    `fileSessionId`; `querySessionId` is for routing only and the log
    never reads it. The `Options.sessionId` LIVE probe also records when
    the file appears.
- [x] Probes run 2026-09-21 (13/13 LIVE): `Options.sessionId` proven
      (file absent at spawn and at `init`, present at `result`);
      Derisk 2–3 decided; facts in docs/claude-agent-sdk.md (three new
      sections: interrupt, session id, slash predicate);
      user-message-tracking.md's limitation replaced. Side finding:
      `queuedCommandSourceUuid` (file.ts) reads string prompts only, so a
      block-form steer's attachment would not resolve its dequeue — fixed
      2026-09-22 (`queuedCommandAttachment` accepts string or block-array
      prompts; `queuedCommandPrompt` joins the text blocks).
- [x] Item 2 implemented 2026-09-21: queue-model.ts (`isSlashCommand`,
      `isMergeable`, `nextRun`), three queue-model tests.
- [x] Item 3 implemented 2026-09-21 (protocol → hub → fold → TUI → docs;
      suite green). Decisions and findings made during implementation,
      for Anton's review:
  - **`shutdown` is query-only** (Anton, 2026-09-21; Derisk 1 table
    note): `fold-shutdown.ts`, `eventStream` (singular — every event is
    a node of exactly one stream), protocol.md.
  - **`settled` redefined**: `sessionSettled(file, sessionId)` holds when
    `awaitingAnchors` is empty and every query-pending id is the start
    node or excluded from `session`. Stamped query nodes (a `result`'s,
    a queued event's) pend on `query` until the query tail passes, and
    the start node pends until the file switch; neither means the file
    is behind.
  - **Subagent traffic is in the pending list**: every `sdkMessage` is
    observed on `query`, so `SessionModels.recordObserved` records
    subagent frames with their frame like any query-only message; they
    retire with their query predecessor and a rebuild replays them
    through `append`, which routes by `parent_tool_use_id` as the live
    path does.
  - **`SessionModels.applySnapshot`** discards the snapshot of a session
    the latest state dropped, and `applyResolutions` skips a session
    without a session model: start nodes resolving on a switched-away
    session surfaced a latent "resolved but never observed" through the
    revived session model.
  - `withAnomalies` renders an anomaly as `${kind}: ${detail}`; the
    trackerAnomaly fold keeps the event's own anomaly verbatim when its
    observation raises none.
  - Side findings, not addressed: an unknown `/command` turn files no
    user entry, so its query observation pends until the next reset;
    `userMessageQueued` consumers cast `message.uuid as UUID` (the
    daemon always stamps it); `SessionModels.pendingEvents` holds only
    `contextChanged` today.
- [x] Presubmit green (740 tests). LIVE `npm run test:sdk`: 31/32; the
      one failure is the compact-boundary-injection derisk suite's
      `p4.q7 post-compact probe sees new compacted context`, a pure-SDK
      probe (the suite does not import daemon code) — unrelated to this
      phase, left for triage. Note the suite rewrites its tracked
      `captures/` on every run.
- [x] Isolated daemon smoke (haiku; one turn, `/compact`, `/clear`, a
      turn): every event on the socket carries a merge node, zero
      anomalies; `querySessionChanged` precedes the new session's init;
      `sessionFileChanged → entries → scanComplete` on the first file
      open. Two observations, both by design: `prompt --type events
    --until idle` exits at the `result` with query ids still pending
      (the events leg has no settlement wait, only `promptLive` does);
      after `/clear` the switch to the new file runs between prompts, so
      the next prompt's gated window shows only the late tail entries.
- [x] TUI smoke (Anton, 2026-09-22, after phase 4): works.
