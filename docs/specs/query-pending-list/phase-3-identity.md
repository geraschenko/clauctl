# Phase 3: identity

> Work log for phase 3 of docs/specs/query-pending-list.md (Type Design,
> "Phase 3 — identity"; Data Flow, "Phase 3"; Decisions, "Steers", the
> dequeue-fold leaf rule, `conversation_reset`, merged runs). Status:
> **implemented and committed** (review round 1, 2026-09-21); the
> Deferred section below became phase 3.5, also done.

## Scope

The queue id becomes the stamped uuid, and a dequeued prompt becomes a
merge observation on `query` like every other query-stream message. That
retires `deliveredMessages` (the fold's second, positional bookkeeping of
"delivered but not yet in the file") and the TUI's `queuedById` copy:

1. **Identity.** `EventHub.deliverUserMessage` stamps `uuid` before
   delivery; the queue model, the events, the prompt receipt, the pending
   area and the format layer carry that uuid instead of a counter.
2. **Dequeue = observation.** `foldUserMessageDequeued` observes the
   run's last member (turn/append) or each id (steer) on `query` of the
   query session, so `settled()` waits for the prompt's entry and the
   merge resolves it when the entry lands. `foldSessionEntry` learns
   which entries await their dequeue (`queuedMessages`), and observes a
   `queued_command` attachment's `source_uuid` on `session` so a steer
   resolves through its attachment.
3. **`conversation_reset`** excludes the last query-pending node that
   still awaits the file (the reset command's own prompt, filed under the
   next session) instead of clearing `deliveredMessages`.
4. **One joined message per run.** `joinedPrompt` builds the message the
   CLI writes for a merged run; both folds (`SessionModels` and the
   transcript's live echo) hold it under `ids.at(-1)`.
5. **TUI user turns as one component.** `UserTurnComponent`/`UserTurnItem`
   replace `CommandItem` and the per-view plain items, so a turn rendered
   from the dequeue echo is replaced in place by its entry at resolution
   (as assistant items are since phase 1.5), keeping attached output and
   expansion.

Out of scope: `/compact` (bypasses the queue model; its entry renders
through `appendEntry` only, as today); interrupt/`cancel_queued` (main
spec, Decisions); the SDK flag audit (follow-up).

## Definitions

- **Stamped uuid**: `SDKUserMessage.uuid` set by the hub before delivery;
  the CLI files the message (or the run it joins) under it. The queue id.
- **Run key**: `ids.at(-1)` of a turn/append `userMessageDequeued` — the
  uuid the file's entry carries (docs/claude-agent-sdk.md, "Queued
  prompts coalesce by run"). A steer has no run key: each id is its own
  observation, resolved by its attachment's `source_uuid`.
- **Awaits dequeue** (`awaitsDequeue(uuid)`): the uuid is in
  `state.queuedMessages` — a prompt this daemon accepted whose dequeue,
  its `query` observation, is still to come; the entry must not be
  excluded from `query`. The counterpart of the tracker's
  `expectsSdkMessage`: both answer "will the other stream carry this
  id?", one by class, one by queue state. (A uuid already in the merge —
  dequeue folded — is covered by `!first`.)
- **Awaiting the file**: a node pending on `query` whose `excludedFrom`
  lacks `"session"`. The reset rule ranges over these only.

## Type Design

Mirrors the main spec (Type Design, Phase 3); drift from it is marked
**(drift)** and listed under Implementation-Time Decisions for approval.

```ts
// protocol.ts
| { kind: "userMessageQueued"; id: UUID; message: SDKUserMessage }
| { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: UUID[] }
// prompt request receipt: { id: UUID }

// daemon/queue-model.ts
export interface QueuedMessage { id: UUID; message: SDKUserMessage; toolResultSeen: boolean }
export interface QueueModelState { queued: QueuedMessage[] }   // nextId gone
export interface AcceptTransition extends QueueTransition { id: UUID }
/** `message.uuid` must be set (the hub stamps before delivery); throws
 *  otherwise — a daemon bug, not a stamping site. */
export function acceptUserMessage(state, message: SDKUserMessage, isIdle: boolean): AcceptTransition

// daemon/event-hub.ts
/** Stamps `uuid: randomUUID()`, delivers the stamped message, accepts it. */
deliverUserMessage(message: SDKUserMessage): UUID
// constructor seed assertion: `activity !== "idle" || queuedMessages.length > 0`

// daemon/set-context.ts — eligibility drops the deliveredMessages clause; a
// dequeued-but-unfiled prompt is pending on `query`, which the
// acquireSettledExclusive gate already waits out.

// agent-state/agent-state.ts
readonly queuedMessages: readonly { id: UUID; message: SDKUserMessage }[];
// `deliveredMessages` removed; header comment's prompt-visibility
// paragraph rewritten: a prompt is in `queuedMessages` or pending on
// `query` in the query session's merge or resolved into the file.
export { joinedPrompt } from "./joined-prompt.ts";

// agent-state/joined-prompt.ts (new)
/** The one message the CLI writes for a merged run: the last member
 *  (uuid, origin, priority, shouldQuery) with the run's content joined
 *  the way the CLI joins it — all strings → `\n`-joined; otherwise one
 *  block array, strings lifted to text blocks, arrays spliced. */
export function joinedPrompt(messages: readonly [SDKUserMessage, ...SDKUserMessage[]]): SDKUserMessage

// agent-state/fold-user-message-queued.ts
export function foldUserMessageQueued(state, id: UUID, message): AgentState

// agent-state/fold-user-message-dequeued.ts
//   ids leave queuedMessages. With querySessionId:
//     turn/append: session.pendingLeaf = ids.at(-1); observeOn(session,
//       "query", ids.at(-1), "prompt", false)
//     steer: observeOn(session, "query", id, "prompt", false) per id
//   anomalies via withAnomalies; no querySessionId → removal only.

// agent-state/observe-on.ts
//   The apply/resolved/pendingLeaf bookkeeping of observeOn becomes
//   applyMergeStep(session, result, className, uuid, stream): Observation,
//   used by observeOn (twice) and by the new
/** Exclude `uuid` from `stream` on `session`; resolves it when that was
 *  the last stream it awaited. */
export function excludeOn(session: SessionState, stream: MergeStream, uuid: UUID, className: string): Observation

// agent-state/fold-session-entry.ts
//   awaitsDequeue = (uuid) => state.queuedMessages.some((entry) => entry.id === uuid)
//   entry.uuid:  excludeOther = first && !awaitsDequeue(uuid) && (!expectsSdkMessage || scanExcluded)
//   source_uuid (queuedCommandSourceUuid(entry) !== undefined):
//     a second observeOn(session, "session", sourceUuid, "prompt",
//     firstSource && !awaitsDequeue(sourceUuid)) after the entry's own.

// agent-state/fold-sdk-message.ts, conversation_reset (session = message.session_id's)
//   const last = pending(session.merge, "query")
//     .filter((id) => !session.merge.nodes[id]!.excludedFrom.includes("session"))
//     .at(-1);
//   if (last !== undefined) excludeOn(session, "session", last, "conversation_reset")
//   The uuid-bearing user/assistant branch (deliveredMessages clear) goes.

// core/prompt.ts
submitPrompt(...): Promise<UUID | undefined>      // receipt check: typeof id === "string"
opensGate(event: AgentEvent, promptId: UUID | undefined): boolean

// format/sdk-message.ts  FormatState.queuedMessages: Map<UUID, SDKUserMessage>
// format/events.ts       no `delivered:` lines at the snapshot; a
//   turn/append dequeue renders joinedPrompt(messages) once (one record,
//   as the file has one entry); steers render each.   (drift: today one
//   record per id)

// tui/components/pending-messages.ts
add(id: UUID, text: string): void
take(ids: UUID[]): string[]

// tui/session-models.ts
class SessionModels {
  constructor(onInvalid, onResolved, onContextChanged);          // unchanged (drift: spec drops onContextChanged)
  /** Accepted prompts by stamped uuid, from `userMessageQueued` and the
   *  seed state; a dequeue takes its ids out. */
  private readonly queued = new Map<UUID, SDKUserMessage>();
  /** Was seedPending: the seed state's query-pending ids AND its
   *  queuedMessages. */
  seed(state: AgentState): void;                                  // (drift: spec seeds via a constructor arg)
  // observe(): userMessageQueued → queued.set(id, message)
  //   userMessageDequeued → messages = ids.map(queued.take)
  //     steer:       recordPending(id, message) per id
  //     turn/append: recordPending(ids.at(-1), joinedPrompt(messages))
  //   on the model of state.querySessionId, through the store rule
  //   (recorded iff the merge node / this step's `resolved` has "query";
  //   an entry-first prompt is recorded and retired in the same step).
  //   Steps run in today's order: record, then applyEntry/applyResolutions.
}

// tui/components/user-turn.ts (new)
/** One user turn — prompt text, slash command, its output — as one
 *  component, so the dequeue echo's provisional rendering is replaced in
 *  place by the entry's. Composes UserMessageComponent (prompt,
 *  contextTag) and UserCommandComponent (slashCommand, bashInput; output
 *  views attach to the preceding command child without output, else
 *  render as a standalone output block). */
export class UserTurnComponent extends Container {
  constructor(views: readonly UserTurnView[], toolsExpanded: boolean);
  /** Re-renders from `views`; output attached by attachOutput and the
   *  expansion state carry over. */
  updateContent(views: readonly UserTurnView[]): void;
  /** Output under the turn's command view. True when attached, or when
   *  that command is /compact (its stdout stays hidden, as today); false
   *  when the turn has no command view or it already holds output — the
   *  caller renders standalone output. */
  attachOutput(text: string): boolean;
  setExpanded(expanded: boolean): void;
}

// tui/transcript.ts
interface UserTurnItem extends ItemKey { kind: "userTurn"; component: UserTurnComponent }
type TranscriptItem = AssistantItem | ToolItem | PlainItem | UserTurnItem;   // CommandItem gone
private readonly itemsByUuid = new Map<UUID, AssistantItem | UserTurnItem>();
/** The views a session entry contributes to a user turn (user message,
 *  queued_command attachment, system/local_command; empty otherwise —
 *  compact summaries and boundaries render as today). */
private entryUserViews(entry: SessionEntry): UserTurnView[];
/** One UserTurnItem for `views` under `uuid`, or — views that are all
 *  output — attachOutput on the immediately preceding UserTurnItem, else
 *  a standalone output turn. Replaces appendUserView/addCommand/
 *  attachCommandOutput. */
private addUserTurn(views: readonly UserTurnView[], uuid: UUID | undefined, part: TranscriptItem[]): void;
// replaceContent(uuid, entry): assistant as today; a UserTurnItem gets
//   component.updateContent(entryUserViews(entry)) and then appendEntry(entry)
//   (its views are keyed already, so only its tool results apply).
// appendEntry: the user-turn branches collapse into
//   addUserTurn(entryUserViews(entry), queuedCommandSourceUuid(entry) ?? entry.uuid, part)
//   guarded by firstRender(key).
// conversation_reset / resetTranscript clear itemsByUuid with the rest (as today).
```

`interactive-mode.ts`: `queuedById` goes; the seed loop fills the pending
area only; `userMessageDequeued` in `renderEvent` appends the query session
model's `queryMessages.get(key)` for the run key (turn/append) or each id
(steer) — the message `SessionModels.observe` just recorded, absent when
the step already resolved it (entry-first: the entry rendered it via
`onResolved`) or there is no query session yet (the entry renders it at
resolution). `renderHistory` drops the `deliveredMessages` tail; the
pending prompts replay from `queryMessages` as every other pending
frame. **(drift)**: the spec has the live case "call `append` on the joined
message" without naming the source; reading `queryMessages` keeps one
copy.

## Data Flow

1. `prompt` request → `deliverUserMessage`: `message.uuid = randomUUID()`;
   `deliver(message)`; `acceptUserMessage` → `userMessageQueued {id: uuid}`
   (+ immediate dequeue when idle). Receipt `{id: uuid}` → `submitPrompt`
   → `opensGate` matches `ids.includes(uuid)`.
2. `userMessageDequeued` (daemon and every subscriber): ids leave
   `queuedMessages`; turn/append sets `pendingLeaf` to the run key and
   observes it on `query`; steer observes each id. `settled()` is false
   until the entry. `SessionModels` records the joined message (or each
   steer) under the observed key; the TUI appends it (pending part).
3. Entry-first prompt (file beats the dequeue): `foldSessionEntry` sees
   `uuid` in `queuedMessages` → observed on `session` without excluding
   `query`, pending on session; the dequeue's `query` observation resolves
   it in that step → `resolved` → `onResolved` → `transcript.resolve` →
   `appendEntry` (nothing in `queryMessages` to retire, nothing recorded).
4. Dequeue-first prompt: the entry's uuid has a node → `first` false → no
   exclusion; the observation resolves it → `onResolved(uuid, entry)` →
   `transcript.resolve` moves its items to the resolved part and
   `replaceContent` re-renders the `UserTurnItem` from the entry.
5. Steer: dequeue observes `S` on `query`; the `queued_command`
   attachment entry observes its own uuid (session-only) and `S` on
   `session` → `S` resolves; `entryFor(S)` is the attachment
   (`attachmentBySource`, phase 1); `replaceContent(S, attachment)`.
6. `conversation_reset` (old session): the last query-pending node
   awaiting the file is excluded from `session` → resolved (`pendingLeaf`
   cleared if it was that node); `SessionModels` retires it, `onResolved`
   with `entryFor` undefined → the transcript moves its items only; the
   `conversation_reset` frame then clears the transcript. The prompt's
   entry in the new file is `user` without `tool_result` → session-only →
   resolves at once.
7. Attach: the seed's `queuedMessages` fill `SessionModels.queued` and
   the pending area; its query-pending ids (including dequeued prompts)
   are recorded frameless (`seed`); their resolutions retire known ids.

## Cost

Negligible: `SessionModels.queued` holds what `queuedById` held;
`queryMessages` gains the dequeued prompts (bounded by the file lag). The
`awaitsDequeue` test is a linear scan of `queuedMessages` per uuid-bearing entry
(tens of entries at most).

## Tests

`queue-model.test.ts`: ids are stamped uuids; `acceptUserMessage` throws
on an unstamped message; existing cases re-keyed.

`event-hub.test.ts`: `deliverUserMessage` stamps before `deliver` sees the
message, and the receipt equals the delivered `uuid`; seed assertion
without `deliveredMessages`.

`agent-state.test.ts` (main spec Tests; replaces the `deliveredMessages`
cases at ll.383, 506–582):

- turn dequeue with a query session: ids leave `queuedMessages`,
  `pendingLeaf` = run key, run key pending on `query`; `settled` false.
- steer dequeue: each id pending on `query`, `pendingLeaf` untouched.
- dequeue with no query session: removal only.
- entry-first turn: entry pending on session (not excluded from query),
  dequeue resolves it; `resolved` carries it with seenOn `[session, query]`.
- entry-first multi-steer: several resolutions in one step.
- steer resolved by its attachment's `source_uuid`; a historical
  attachment (source not awaiting dequeue, first) is excluded from `query`.
- historical `user` entry (not awaiting dequeue, first, session-only
  class) → excluded
  from query, as today.
- `conversation_reset`: the last node awaiting `session` is excluded and
  resolved; a query-only node after it (`command_lifecycle`,
  the reset frame) is skipped; nothing pending → no-op; `pendingLeaf`
  cleared when it was the excluded node; queued work preserved.
- `joinedPrompt`: string join; block lift + splice; last member's fields.

`session-models.test.ts`: dequeue-first and entry-first (turn and steer)
retiring on resolution; a seed with `queuedMessages` then their dequeue
records the joined message; dequeue without a query session records
nothing; a steer records one per id.

`transcript.test.ts`: user-turn replacement preserving attached output and
expansion (main spec); the existing command-block, bash passthrough,
output-only and `resolve`-enrichment cases pass over `UserTurnItem`;
`cached-lines.test.ts` keeps `UserCommandComponent` (still used inside
the turn component).

`format/events.test.ts`: uuid ids; snapshot without `delivered:`; a merged
run renders one joined record.

`prompt.test.ts`: uuid receipts; a numeric receipt is malformed.

`tests/sdk/` LIVE: `queued-batches` and `stream-classification` already
stamp; rerun to confirm nothing depends on the daemon's old ids.

## Plan

Each step ends with `npm run check` and the affected tests green, and
updates this doc and the WORK LOG.

1. **Ids → uuids.** `protocol.ts`, `queue-model.ts` (`nextId` gone, throw
   on unstamped), `event-hub.ts` (stamp + receipt), `fold-user-message-queued.ts`,
   `agent-state.ts` type, `prompt.ts`, `pending-messages.ts`,
   `format/sdk-message.ts`, `format/events.ts` (id type only),
   `interactive-mode.ts` map type; tests. `deliveredMessages` untouched.
2. **Fold.** `joined-prompt.ts`; `observe-on.ts` split + `excludeOn`;
   `fold-user-message-dequeued.ts` observation; `fold-session-entry.ts`
   `queued`/`source_uuid`; `fold-sdk-message.ts` reset rule;
   `deliveredMessages` removed (type, initial state, hub seed assertion,
   `set-context.ts`, `format/events.ts` snapshot, `interactive-mode.ts`
   history tail); header comment rewritten; tests.
3. **SessionModels.** `queued` map, `seed`, dequeue recording;
   `interactive-mode.ts` drops `queuedById`, live dequeue renders from
   `queryMessages`; tests.
4. **Transcript.** `user-turn.ts`; `UserTurnItem`, `addUserTurn`,
   `entryUserViews`, `replaceContent` for user turns; tests.
5. **Docs + hand-off.** `docs/user-message-tracking.md` and
   `docs/protocol.md` where they describe numeric ids or
   `deliveredMessages`; `format/events.ts` header; presubmit; main spec
   WORK LOG; file list to Anton (`git mv
docs/thoughts/fold-resolved-events.md docs/thoughts/old/` is Anton's).

## Implementation-Time Decisions

Approved by Anton 2026-09-20 with the plan:

- `SessionModels` keeps `onContextChanged` and seeds `queued` through
  `seed(state)` (the renamed `seedPending`, which already takes the seed
  state) instead of a constructor argument.
- The live dequeue echo reads `queryMessages` (one copy) rather than a
  second map or a return value from `observe`.
- `format events` renders a merged run as one joined record.
- Observation class names: `"prompt"` for dequeue and `source_uuid`
  observations, `"conversation_reset"` for the reset exclusion (anomaly
  details only).
- The spec's `ours(uuid)` is named `awaitsDequeue(uuid)` and collapses
  to the `queuedMessages` half (Definitions); the main spec's wording
  updated to match.

## Review round 1 (Anton, commit 8bd2284, 2026-09-21)

Decisions (`// TDC:` comments in the tree; each removed when addressed):

1. **`id` → `uuid` everywhere** (event fields, `QueuedMessage`,
   `AcceptTransition`, `queuedMessages` entries; Anton's IDE rename):
   sweep the remaining variable names, helper params, comments and docs
   prose (`ids`, "run key (the last id)").
2. **`appearedInQuery`** (Anton's rename of `first` in
   `fold-session-entry.ts`) stays; inversions verified. Node-exists ≡
   appeared-in-query except a duplicate file line (a merge-error anyway).
3. **Steers are separate events.** `queue-model.ts` emits one
   `userMessageDequeued {delivery: "steer"}` per absorbed member; no
   consumer branches on `steer` to split ids. The fold keeps ONE
   delivery distinction: `pendingLeaf` is set only for turn/append (a
   steer never becomes a user entry; its attachment has its own uuid, so
   predicting the leaf as the steer uuid is wrong).
4. **`uuids: readonly [UUID, ...UUID[]]`** (non-empty tuple) on the one
   event shape, instead of arity rolled into `MessageDelivery`:
   consumers stay uniform; steer/append being singletons is a
   queue-model invariant with a test. Removes the `runKey === undefined`
   branch.
5. **`joinedPrompt(messages: readonly SDKUserMessage[]): SDKUserMessage |
undefined`** — empty → undefined; the `[first, ...rest]` destructuring
   at every call site (a tuple-typing artifact) goes.
6. **Dequeue with no query session** (`querySessionId === undefined`) is
   legitimate: the daemon's first prompt is dequeued at accept before any
   query message named a session; its entry, no longer awaiting dequeue,
   is excluded from `query` and resolves at once. Comment says so.
7. **Transcript.** `appendEntry` handles user entries fully
   (`addUserTurn(entryUserViews)` + a new `applyToolResults(message)`)
   and delegates to `appendMessage` only for non-user messages, so views
   are computed once per path. `replaceContent` becomes private
   `replaceItem(item, entry)` taking the item `resolve` found, split into
   `replaceAssistant(item, message)` / `replaceUserTurn(item, entry)`.
8. **A steered prompt's attachment renders as plain prompt text**
   (`[{kind: "prompt", text}]`, not `userTurnViewsFromText`): an
   attachment is always verbatim text. LIVE probe
   (`tests/sdk/steer-slash-command.test.ts`, 2 haiku sessions) found the
   actual rule: a prompt that IS a `/command` (built-in `/cost`, custom
   `/hello`) is **never steered and never merged** — it waits through the
   tool result and runs as its own expanded turn after the `result`
   (`/cost` expands to its alias `/usage` + `local_command` stdout;
   `/hello` to `<command-name>/hello</command-name>` + an `isMeta` entry
   with the expanded prompt); two such commands queued together ran as
   two turns with two results. A plain text mentioning `/cost` is steered
   verbatim. Recorded in docs/claude-agent-sdk.md ("Slash commands are
   turns of their own"). **Queue-model gap** (→ Deferred): the daemon
   would emit `steer` for a mid-turn `/command` and merge two queued
   ones into one turn.
9. Docs: `user-message-tracking.md` "file normally lags by ~200ms"
   wording (Anton's edit) kept.

## Deferred (→ phase 3.5 spec, `query-pending-list/phase-3.5-*.md`)

- **Uuid-less events.** Stamp a uuid on every `AgentEvent` variant that
  lacks one (event-hub, like prompts) and observe it on its stream with
  `excludeOther = true`, so it resolves behind its stream predecessors
  and `SessionState.resolved` carries everything: `contextChanged`,
  `sessionFileChanged`, `scanComplete` → `session`; `compactSent`,
  `interruptSent`, `controlApplied` → `query`; `shutdown`/`trackerAnomaly`
  may keep passing through. Removes `contextChangedAfter` in
  session-model.ts and the transcript's unkeyed-item rule. Open: the TUI
  must map resolved non-entry ids back to their events (`entryFor` is
  undefined for them today; the session model would hold the payloads as
  it holds `queryMessages`).
- **Slash-command exemption in the queue model** (decision 8's finding).
  `queue-model.ts` needs "a `/command` prompt is not demotable and is a
  run of one" (`isDemotable` false; `nextRun` cuts before and after it).
  Open: the CLI's exact predicate (leading `/` + a known command name from
  `system/init.slash_commands`? any `^/\S+`? — `/nonexistent` unprobed)
  and whether the exemption also holds for `later`/`now` priorities.
- **Interrupt probes** (LIVE tests): (a) queue a prompt mid-turn,
  interrupt before its dequeue: does it run after the interrupted result
  and does its entry land; (b) whether a "now"-priority prompt drops
  queued messages. Anton's expectation: no logical gap between claude
  accepting a prompt and filing it, only the streams' temporal skew. A
  `canceled` delivery variant only if a probe shows cancellation; the
  "interrupt can leave a dequeued prompt pending" limitation in
  user-message-tracking.md is revised from the findings.

## Verification

- `npm test`; `npm run presubmit`.
- LIVE: `tests/sdk/queued-batches.test.ts`, `tests/sdk/clear-session.test.ts`.
- Manual TUI smoke under `/tmp/clauctl-cbi-derisk/` (isolated config): a
  prompt typed idle, two queued mid-turn (merged), a steer during a Bash
  tool, `/clear` with a prompt behind it; each renders once, the
  pending area drains, `clauctl wait --until idle` settles.

# WORK LOG

- [x] Anton reviews this plan (2026-09-20): approved; `ours` →
      `awaitsDequeue`.
- [x] Step 1 ids → uuids (2026-09-20): protocol/queue-model/hub/prompt/format/tui types; tests stamp `uuidN(n)`; suite green.
- [x] Step 2 fold (2026-09-20): joined-prompt.ts, observe-on split + excludeOn, dequeue observation, awaitsDequeue/source_uuid, reset exclusion, deliveredMessages removed; set-context tests now file the prompt entry (the gate waits for it); suite green.
- [x] Step 3 SessionModels + interactive-mode (2026-09-20): `queued` map, `seed`, dequeue recording (joined run / per steer) through the store rule; TUI echo reads `queryMessages`; `queuedById` gone; tests added.
- [x] Step 4 transcript user turns (2026-09-20): `user-turn.ts`
      (`UserTurnComponent`, `isOutputView`/`outputText`); `UserTurnItem`
      replaces `CommandItem`; `addUserTurn`, `entryUserViews` (a module
      function taking the entry's converted message, so `appendEntry`
      converts once), `replaceContent` for user turns — it keeps the
      frame's rendering when the entry contributes no user views (an
      entry that only carries tool results); 3 tests added; suite green.
- [x] Step 5 docs, presubmit (2026-09-20): `user-message-tracking.md`
      invariant + limitations rewritten around the stamped uuid and the
      merge; `protocol.md`/`architecture.md` invariant wording;
      `format/events.ts` renders a turn/append dequeue as one joined
      record; presubmit green (733 tests).
- [x] LIVE `queued-batches` + `clear-session` rerun 2026-09-20: 10/10.
- [x] Review round 1 (2026-09-21): decisions recorded above.
- [x] Round 1 fixes (2026-09-21): (1) uuid sweep, (3) per-steer events +
      fold `pendingLeaf`, (4) tuple, (5) joinedPrompt, (6) comment, (7)
      transcript, (8) steer plain text + LIVE
      `tests/sdk/steer-slash-command.test.ts` (3/3; finding in decision
      8 and docs/claude-agent-sdk.md); no `// TDC:` left in src; presubmit
      green (735 tests); LIVE `queued-batches` + `clear-session` 10/10.
- [x] Phase 3.5 spec: uuid-less events + slash-command exemption +
      interrupt probes (Deferred) —
      `query-pending-list/phase-3.5-uuid-less-events.md`, done.
- [x] TUI smoke (Anton, 2026-09-22, after phase 4): works.
