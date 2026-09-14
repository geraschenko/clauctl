# TUI history: get-messages RPC and transcript replay on attach

> Status: **implemented; history replay now comes from get-entries over the socket (docs/specs/session-tracker.md), and get-messages became get-context (docs/specs/get-context.md).**

# SPEC

## Problem

Attaching `clauctl _tui` to a running agent starts with a blank transcript:
the subscriber protocol deliberately replays no history, so everything said
before the attach is invisible. The daemon needs an analogue of pictl/pi's
`get-messages` RPC, and the TUI needs to render that history on attach — at
least back to the last compaction point.

Separately, queued-but-undelivered messages live only in the daemon's queue
model (they are not in the transcript file), so an attaching TUI shows
placeholder text (`(queued message N)`) in the pending area instead of the
queued messages themselves.

## What we want

1. **`get-messages` on sdk.sock**: a request that returns the session's
   transcript segment since the last compaction — verbatim what the SDK's
   `getSessionMessages(sessionId, { dir })` returns: user/assistant messages
   in chronological order, starting at the compact-summary user message when
   a compaction has occurred. No session yet → empty array.
2. **CLI subcommand**: `clauctl get-messages -t <agent>` printing the response
   as JSON, like every other read passthrough (parity with
   `pictl get-messages`).
3. **TUI history replay**: on attach, the TUI fetches `get-messages` and
   renders the history through _exactly_ the same code path live messages
   use (`handleSdkMessage` → `renderAssistant`/`toolResultsOf`), then
   switches to the live stream without dropping or duplicating messages in
   the window between the subscribe snapshot and the transcript read.
4. **Queued messages in the snapshot**: `StateSnapshot` carries the queued
   messages (id + full `SDKUserMessage`) so the pending area shows their real
   text on attach.

## Success criteria

- `clauctl get-messages -t <agent>` on an agent with prior turns prints a
  JSON array of `{type, uuid, session_id, message, parent_tool_use_id}`
  entries; on a fresh agent (no session) it prints `[]`.
- After a `/compact`, `get-messages` returns only the post-compaction
  segment, whose first entry is the compact-summary user message.
- Attaching `_tui` to an agent with history shows the prior conversation —
  user messages, assistant messages, and tool executions with their results —
  rendered identically to how they appeared live, followed seamlessly by live
  output. A message that completes during the attach window renders once.
- Attaching `_tui` to an agent with queued messages shows their text in the
  pending area (not `(queued message N)`).
- A failed `get-messages` surfaces as the TUI's ordinary error banner — no
  version-skew special-casing anywhere. `SDK_SOCKET_VERSION` stays 1 (both
  protocol additions are additive optional shapes).
- `npm run check`, `npm run lint`, and `npm test` pass.

## Type design (approved)

### `src/core/sdk-socket.ts`

```ts
// New standalone member of the SdkRequest union (beside wait-idle/subscribe —
// it reads the transcript file via getSessionMessages, not the Query, so it
// does not join SdkControlRead):
| { type: "get-messages" }
// Response data: SessionMessage[] — verbatim getSessionMessages output.

// StateSnapshot gains (each present when non-empty/defined, matching
// existing style):
queuedMessages?: { id: number; message: SDKUserMessage }[];
// ...delivered-but-unconfirmed prompts: dequeued as turn/append, not yet
// confirmed by a later stream emission, in dequeue order:
deliveredMessages?: SDKUserMessage[];
// ...and the attach boundary (present once any user/assistant sdkMessage has
// been emitted this daemon lifetime): the uuid of the last one. Transcript
// entries at/before it were emitted before this snapshot, so the subscriber
// never saw them; everything after arrives on the live stream.
lastTranscriptUuid?: string;
```

The three fields jointly maintain the **prompt-visibility invariant**: for
any snapshot, every accepted turn/append prompt appears in exactly one of
`queuedMessages`, `deliveredMessages`, or the transcript at/before
`lastTranscriptUuid` — so an attacher renders each prompt exactly once with
no dedupe. Neither of the latter two subsumes the other (resolved: yes,
`lastTranscriptUuid` is still required with `deliveredMessages`): the
boundary prevents _duplication_ — `get-messages` reads the file after the
snapshot, so without the cut everything written post-snapshot would render
twice (replay + buffered event for emitted messages; replay +
`deliveredMessages` for a delivered prompt whose entry lands in the read
window) — while `deliveredMessages` prevents _loss_ of the one thing the
boundary cut removes that nothing else re-supplies. Rationale and accepted
limitations: `docs/user-message-tracking.md`.

### `src/core/queue-model.ts`

```ts
/** The messages a transition hands to the CLI as turn/append deliveries, in
 *  dequeue order; steer dequeues excluded (their only transcript record is a
 *  queued_command attachment getSessionMessages never returns). Ids resolve
 *  against the pre-transition queue, or the transition's own queued event
 *  for the idle-accept immediate dequeue. */
export function deliveredMessages(
  before: QueueModelState,
  transition: QueueTransition,
): SDKUserMessage[];
```

### `src/core/daemon.ts`

- New `case "get-messages"` in `handleRequest`: resolve the latest session
  from `record.sessions`; none → `[]`; otherwise
  `await getSessionMessages(sessionId, { dir: record.cwd })`.
- Subscribe snapshot gains
  `...(queueModel.queued.length > 0 && { queuedMessages: queueModel.queued.map(({ id, message }) => ({ id, message })) })`
  — dropping the internal `toolResultSeen`.
- `trackedState` gains `lastTranscriptUuid?: string`, updated in
  `handleMessage` for every `user`/`assistant` message carrying a uuid
  (verified in the CLI 2.1.195 binary: both stream-emission sites always
  attach the internal transcript uuid, so stream uuids match file entries;
  `SDKUserMessage.uuid?` is optional only for host-pushed input). The
  snapshot includes it when defined. `handleMessage` is synchronous, so the
  boundary is exact: a subscriber attaches only between messages.
- `deliveredPending: SDKUserMessage[]`: `applyQueueTransition` appends
  `deliveredMessages(queueModel, transition)` before advancing the model;
  the boundary-advance site in `handleMessage` clears the whole list.
  Clearing all on every user/assistant emission is sound even though the
  stream never emits prompts themselves: a delivered prompt's transcript
  entry is written at consumption (a merged bucket as one `\n`-joined entry
  — echo-placement FINDINGS Q4) and entries land in file-append order, so
  any message emitted later has its entry past every pending prompt's — the
  later message _is_ the confirmation, and once the boundary reaches it a
  history read covers them all (assuming the queue model is right about the
  delivery order). Add and clear each share one synchronous step with their
  queue/boundary counterpart, which is what makes the invariant transitions
  atomic. The snapshot includes a copy when non-empty.

### `src/core/sdk-commands.ts`

```ts
"get-messages": bareRequestCommand(
  "print the transcript since the last compaction",
  { type: "get-messages" },
),
```

### `src/tui/sdk-render.ts`

```ts
/** History entries adapted to the live-message shape so replay reuses the
 *  exact rendering path; system entries are dropped. */
export function historyToSdkMessages(messages: SessionMessage[]): SDKMessage[];

/** The replayable prefix: entries at/before the attach boundary. */
export function historyUpToBoundary(
  messages: SessionMessage[],
  boundaryUuid: string | undefined,
): SessionMessage[];
```

`historyToSdkMessages` filters to `user`/`assistant` and casts —
`SessionMessage` carries every field the corresponding `SDKMessage` variants
require (`type`, `message`, `uuid`, `session_id`, `parent_tool_use_id`).

`historyUpToBoundary`: `boundaryUuid` undefined → the whole segment (nothing
was emitted this daemon lifetime); boundary not found in the segment → empty
— a compaction raced the attach, and replaying nothing avoids duplicating
the post-snapshot rendering the buffered events already carry. In that race
the compact-summary user message renders nowhere (live `sdkMessage: user`
text is never rendered, and it is not an accepted prompt, so it is in
neither `deliveredMessages` nor any dequeue event); accepted as a rare
display limitation (see `docs/user-message-tracking.md`).
Otherwise the prefix through the boundary entry.

### `src/tui/interactive-mode.ts` (`InteractiveController`)

- New field (live events held back while history renders — named for what it
  buffers, not what it waits for):
  ```ts
  private liveEventsDuringReplay: SdkEvent[] | undefined = [];
  ```
- Constructor: replace the `(queued message N)` placeholder loop — seed the
  pending area directly from the snapshot:
  `pendingMessages.add(entry.id, userText(entry.message))` for each entry of
  `snapshot.queuedMessages ?? []`. Then kick off
  `void this.loadHistory(snapshot.lastTranscriptUuid, snapshot.deliveredMessages ?? [])`.
- `private async loadHistory(boundaryUuid, deliveredMessages)`: request
  `get-messages`; on success replay each message of
  `historyToSdkMessages(historyUpToBoundary(history, boundaryUuid))`; on
  failure add a banner. Then (fetch outcome regardless) render each
  `deliveredMessages` entry through the same `userText` +
  `UserMessageComponent` path — chronologically they follow the replayed
  transcript and precede every buffered event. Finally drain
  `liveEventsDuringReplay` and set it to `undefined`. Replay of one adapted
  message:
  - `user` with non-empty `userText` → `new UserMessageComponent(text)` into
    the chat container first. Live user prompts enter the transcript via
    `userMessageDequeued` (never via `sdkMessage`), so history must render
    them itself — same `userText` + `UserMessageComponent` as the dequeue
    path.
  - then `handleSdkMessage(adapted)` for every message — assistant messages
    render whole (streaming map is empty), tool_result blocks resolve the
    tool components, text-only user messages fall through harmlessly.
- `handleEvent`: while `liveEventsDuringReplay !== undefined`, push the
  event and return; the drain replays through `handleEvent` with the gate
  open, so every buffered event takes the normal fold+render path. No dedupe
  is needed: replay stops at the boundary, and everything after the boundary
  was emitted post-snapshot, so it arrives (only) as buffered/live events —
  each message renders exactly once by construction. This covers user
  prompts too: a prompt past the boundary is skipped by replay and rendered
  by its buffered `userMessageDequeued`; a prompt at/before the boundary was
  dequeued pre-snapshot (its entry was written at its dequeue, before the
  boundary message's emission), so no dequeue event for it can reach this
  subscriber; and a prompt dequeued pre-snapshot whose entry is past the
  boundary (or not yet in the read) is exactly the `deliveredMessages` case.

## Edge cases

- **No session yet** (spawned, never queried): `get-messages` returns `[]`;
  the TUI renders nothing extra.
- **Attach mid-turn**: messages completed before the transcript read appear
  in history; in-flight partials arrive only on the live stream (the jsonl
  holds completed messages). Buffer-then-drain plus the boundary cut makes
  the overlap window render-once. An assistant message mid-stream at attach
  renders whole from its live `assistant` message (its `message_start` was
  pre-snapshot, so the streaming map has no component and stray deltas are
  ignored) — i.e. it is missing only until it _completes_, never permanently;
  what is lost is the pre-completion streaming view. (TDC resolved:
  confirmed.)
- **Known residual race (boundary-undefined delivery)**: whenever the
  boundary is undefined (replay-all) while a prompt is
  delivered-but-unconfirmed and the transcript read already includes its entry,
  replay-all plus `deliveredMessages` (or the buffered dequeue) renders it
  twice. In practice this requires a just-revived daemon with prior history
  - instant query + instant attach within the read window; accepted as
    negligible.
- **Accepted display limitations** (each documented with its cause in
  `docs/user-message-tracking.md` so no re-derivation is needed):
  steered prompts are invisible to fresh attachers (their only transcript
  record is a `queued_command` attachment `getSessionMessages` never returns
  — `deliveredMessages` cannot fix this, no user entry ever comes); a merged
  bucket shows as N separate user messages from `deliveredMessages` but one
  `\n`-joined entry once in history (cosmetic); the emissions around an
  interrupt clear `deliveredPending`, so a prompt the CLI discarded
  unwritten is gone from every view; a delivered-but-unconfirmed append
  that survives into a compaction stops being displayed (its entry is in
  the pre-compaction segment `get-messages` no longer returns).
- **Tool results in history**: a history user message's `tool_result` blocks
  update the `ToolExecutionComponent`s created by the preceding assistant
  message, exactly as live. A dangling tool call (turn interrupted before its
  result) stays unresolved, matching what a live viewer saw.
- **Compact-summary message**: renders as an ordinary (long) user message —
  it is one, and it is the segment's context.
- **Non-prompt user text**: sessions ever driven by interactive claude
  contain `<command-name>`/`<local-command-stdout>` user entries (verified
  empirically); they render verbatim as user messages. clauctl-managed
  agents only receive prompts over sdk.sock, so this is cosmetic and only in
  mixed-driver sessions.

## Non-goals

- Reaching past the last compaction (`limit`/`offset`/`includeSystemMessages`
  pass-through) — deferred until `/tree`.
- Conversation rewind / `/tree` (see IMPLEMENTATION IDEAS for the follow-up
  path).
- Replaying daemon-only events (queued/dequeued history, banners); history is
  the transcript, not the event stream.

# IMPLEMENTATION IDEAS

## Derisk findings (2026-07-08)

- **`getSessionMessages` does the whole job.** Run empirically against a
  heavily-compacted transcript: it returned exactly the segment from the last
  compaction to now (36 messages), chronological, starting at the
  compact-summary user message. The SDK builds the chain via parentUuid
  internally; no manual jsonl walking. `SessionMessage.message` is the API
  message — the same shape `sdk-render.ts` already consumes.
- **Chain termination at compaction is structural**: `compact_boundary`
  entries have `parentUuid: null`; the pre-compaction chain hangs off a
  separate `logicalParentUuid` field, so a backward walk stops there
  naturally.
- **Esc-Esc / rewind mechanism** (for the future `/tree`): `Query` has no
  in-session conversation rewind. The mechanism is a query restart with
  `{ resume: sessionId, resumeSessionAt: <messageUuid> }` — resume appends to
  the _same_ session file (the `forkSession: true` option exists precisely to
  make resume create a new file), so post-rewind messages branch via
  parentUuid: an in-file tree, no forkSession needed. `getSessionMessages`
  walks back from the file's last entry → active branch. File state is
  restored separately via `Query.rewindFiles(userMessageId)` (requires
  `enableFileCheckpointing`). Implementing this means daemon query-lifecycle
  restart — a separate spec. Not yet observed in a real transcript (no branch
  points found in recent sessions); confirm with one interactive claude
  Esc-Esc before building `/tree`.
- **Attach race**: the subscribe snapshot and the transcript read are not
  atomic. The original design closed it with live-side uuid dedupe; review
  found that dequeued prompts escape it (a `userMessageDequeued` carries only
  queue ids, and the prompt's uuid-bearing replay is emitted _after_ its
  dequeue), so it was superseded by the snapshot boundary
  (`lastTranscriptUuid`): replay stops at the boundary and the live stream
  renders the rest, which also makes uuid dedupe (including its stream_event
  identity assumption) unnecessary. See the 2026-07-11 WORK LOG entries.
- **User prompts are not on the sdkMessage render path** (critique finding):
  `handleSdkMessage`'s `user` case only resolves tool results; live prompts
  render at `userMessageDequeued`. History replay therefore renders user text
  itself with the same `userText` + `UserMessageComponent` pair the dequeue
  path uses. `userText` returns `""` for tool_result-only messages, so the
  non-empty check cleanly separates the two kinds (verified: history user
  entries are either plain text or tool_result blocks, never mixed with
  meaningful text in practice).
- **Why `queuedMessages` sits beside `assistantState.queued`** instead of
  fattening `QueuedEntry`: the assistant-state fold is a pure state machine
  shared by daemon and observers; carrying full message bodies through it
  changes its semantics and size for one consumer. The snapshot field is
  daemon-only truth (queue-model state), delivered once at attach.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Protocol: `get-messages` request + `queuedMessages` snapshot field (sdk-socket.ts)
- [x] Daemon: `get-messages` handler + snapshot population (daemon.ts)
- [x] CLI: `get-messages` subcommand (sdk-commands.ts)
- [x] Render: `historyToSdkMessages` + tests (sdk-render.ts)
- [x] TUI: history load, event buffering, boundary cut (superseded the original uuid-dedupe idea), queued-text seeding (interactive-mode.ts)
- [x] Presubmit green; live check against a real agent

## 2026-07-11 — Implementation

All six items done. check/lint/test (89) and treefmt green; the
sync-from-pictl check fails on pre-existing cli.ts/targets.ts drift from
uncommitted pictl edits, unrelated to this change. Live check ran credit-free
under an isolated `CLAUCTL_DIR`/`CLAUDE_CONFIG_DIR`: fresh agent →
`get-messages` prints `[]`; after one turn (unauthenticated, so the reply was
the synthetic "Not logged in" assistant message — no credits spent) it prints
the user and assistant entries in order with uuids/session ids. Hands-on
`_tui` attach verification against a real logged-in agent is left for review.

### Implementation-Time Decisions

- ~~**`historyUuids` records every history entry's uuid, system included**~~ —
  obsolete: the dedupe set was removed when the attach boundary superseded
  uuid dedupe (see the review-finding entry below).
- **Buffer drain re-enters `handleEvent`** — `loadHistory` sets
  `historyBuffer` to `undefined` _before_ replaying the buffered events
  through `handleEvent`, so the gate at the top of `handleEvent` is already
  open and each drained event takes the normal fold+render path.

## 2026-07-11 — Review finding: attach-window prompt duplication (resolved)

Reviewer finding (confirmed real): a user prompt dequeued between the
subscribe snapshot and the transcript read renders twice — once from history
replay, once from the buffered `userMessageDequeued` (which carries only
queue ids, so uuid dedupe cannot cover it). Violates the render-once
criterion.

A trigger-adjacency fix (flag a history-deduped user replay, suppress the
immediately-following dequeue render) was attempted and reverted: its premise
is wrong. Per queue-model.ts, a dequeue's trigger is the previous turn's
`result` (turn/append), post-tool_result assistant activity (steer), or the
accept itself when idle — the prompt's uuid-carrying replay is emitted
_after_ its dequeue, so it can never inform the dequeue's render decision.
Steer dequeues cannot duplicate — their prompts never appear in history at
all (correction: the rendered `<system-reminder>` exists only in the API
request; the JSONL records just a `queued_command` sidecar attachment, per
the echo-placement FINDINGS — an earlier version of this entry wrongly said
the content appears inside tool_result blocks).

Resolution (approved): snapshot attach boundary. `StateSnapshot` gains
`lastTranscriptUuid` (last user/assistant sdkMessage uuid emitted this daemon
lifetime); history replay renders only entries at/before it
(`historyUpToBoundary`), and everything after arrives exclusively as
buffered/live events. This replaced the `historyUuids` dedupe set entirely —
render-once holds by construction instead of by dedupe. Verified in the CLI
2.1.195 binary that stream user/assistant messages always carry the
transcript uuid (the boundary's soundness assumption). Known residual:
revived daemon (boundary undefined) + instant query + instant attach can
duplicate one prompt; documented as an accepted edge case.

Implemented; check/lint/test (92) and treefmt green. Live check (credit-free,
isolated config dir): after one turn, the subscribe snapshot's
`lastTranscriptUuid` equals the uuid of the transcript's last entry, so
replay covers exactly the pre-attach segment.

## 2026-07-11 — Review finding 2: delivered-but-unconfirmed prompts (open, design approved in principle)

Reviewer's second-pass finding on the boundary design (confirmed real, a
prompt-LOSS hole): a prompt dequeued _before_ the subscribe whose transcript
entry lands _after_ the boundary is displayed nowhere — not in
`queuedMessages` (already dequeued), cut from history replay (past the
boundary), its dequeue event pre-snapshot (never delivered to this
subscriber), and the live `user` sdkMessage renders no text. Window =
dequeue → next transcript emission. The pre-boundary `historyUuids` design
had a narrower version of the same hole (entry written after the read).

Root cause worth its own doc (see checklist): the SDK gives no timely echo
of delivered user prompts, so — exactly as the daemon must model the queue —
it must also track delivered-but-not-yet-visible prompts and hand them to
attaching observers.

Approved design (user, 2026-07-11; clearing-rule refinement pending final
nod):

- Daemon keeps `deliveredPending: SDKUserMessage[]`: on a `turn`/`append`
  dequeue, append the dequeued messages (looked up by id in the
  pre-transition `queueModel.queued`; the idle-accept immediate dequeue uses
  the just-accepted message). Steer dequeues stay out: no echo ever comes,
  so entries would linger or vanish uselessly. (Correction during
  implementation: this entry originally said steered content reaches an
  attacher inside the tool_result text — false per the echo-placement
  FINDINGS; the rendered reminder is in neither the stream nor the JSONL.
  Steered prompts are therefore invisible to fresh attachers — an accepted,
  documented limitation, not something `deliveredMessages` can fix.)
- Clearing rule: clear `deliveredPending` on EVERY user/assistant sdkMessage
  emission — i.e. exactly when `lastTranscriptUuid` advances. Sound because
  any user/assistant message emitted after a delivery sits after the
  delivered prompt in the transcript, so once the boundary passes it,
  history replay covers the prompt. Clearing and boundary advance share one
  synchronous `handleMessage`, so a snapshot shows each delivered prompt in
  exactly one place. This needs no echo detection and is correct whether or
  not the SDK echoes prompts (get-messages reads the file, where prompts
  land regardless). Turns run sequentially, so at most one un-echoed bucket
  (plus appends merging into the next turn) exists — clearing all is sound.
- `StateSnapshot` gains `deliveredMessages?: SDKUserMessage[]` (present when
  non-empty).
- TUI: after history replay and before the buffer drain, render each entry
  via the same `userText` + `UserMessageComponent` path.
- Known corner: an interrupt's synthetic user message clears the list; if
  the CLI also dropped the prompt unwritten, it is lost — but no display
  path could have shown it.
- Reviewer also asks that this gap be test-covered once fixed (pure seam or
  fake-client integration test — undecided).

Remaining work checklist:

- [x] Final approval of the clearing-rule refinement, then fold this design
      into the SPEC type-design section
- [x] Implement daemon `deliveredPending` + snapshot `deliveredMessages`
- [x] TUI renders `deliveredMessages` between history replay and drain
- [x] Test for the attach-window gap (form TBD)
- [x] New doc explaining why the daemon must track queued + delivered
      prompts, e.g. `docs/user-message-tracking.md`
- [x] Presubmit + credit-free live check; then back to reviewer 9c67337b
      (continue the existing conversation, do not spawn fresh)

## 2026-07-11 — Finding 2 implemented (deliveredMessages)

Clearing rule approved (clear `deliveredPending` on every user/assistant
emission — exactly when the boundary advances). Re-evaluation before
implementing sharpened the soundness argument with two facts from the
echo-placement FINDINGS: (1) same-priority executing messages merge FIFO
into a _single_ `\n`-joined user entry (Q4), so one dequeued bucket has
exactly one echo and clear-all cannot orphan part of a bucket; (2) the
rendered steer `<system-reminder>` exists in neither the stream nor the
JSONL, which both confirms excluding steer from `deliveredPending` and
surfaces the fresh-attacher steer blind spot as a separate accepted
limitation (see corrections above).

Implementation: the exactly-once **prompt-visibility invariant** is stated
on `StateSnapshot` (sdk-socket.ts) and expanded in the new
`docs/user-message-tracking.md` (which also records every accepted
limitation with its cause, per the no-re-derivation requirement). The
delivery computation is a pure seam, `deliveredMessages(before, transition)`
in queue-model.ts, so the attach-window gap logic is unit-tested there
(idle-accept delivers, busy accept doesn't, result dequeue delivers the
bucket FIFO, steer delivers nothing) — the chosen "pure seam" test form.
Daemon: `deliveredPending` appended in `applyQueueTransition`, cleared at
the boundary-advance site in `handleMessage`, copied into the snapshot when
non-empty. TUI: `loadHistory(boundaryUuid, deliveredMessages)` renders the
delivered prompts after replay (even if the fetch failed) and before the
drain; `historyBuffer` renamed to `liveEventsDuringReplay` (TDC).

Presubmit green (check/lint/treefmt/96 tests; sync-from-pictl still blocked
only by pre-existing pictl drift). Credit-free live check exercised the
handoff end-to-end: a subscribe immediately after the query response (echo
still pending on first-turn process spawn) showed the prompt in
`deliveredMessages` with no boundary; after idle, `deliveredMessages` was
absent, the boundary equaled the last transcript uuid, and `get-messages`
held the prompt at/before it — each state showing the prompt in exactly one
place.

## 2026-07-11 — review comment: no backward-compatibility affordances

Resolved (agreed; matches the standing no-backward-compat rule): removed the
old-daemon success criterion in favor of "a failed `get-messages` surfaces as
the TUI's ordinary error banner", dropped the pre-extension-daemon edge case,
and simplified queued-message seeding to iterate `snapshot.queuedMessages`
directly (no id-map over `assistantState.queued`, no placeholder fallback).
The `SDK_SOCKET_VERSION` stays-1 note is kept as a protocol fact, not a
compatibility promise.

## 2026-07-11 — TDC review: "transcript echo" framing was wrong

TDC comments on the finding-2 implementation exposed a wrong mental model in
the prose (the mechanism was already correct): the live SDK stream never
emits user prompts at all — re-verified across the FINDINGS captures, where
the only `user` events are tool_results, including in interrupt scenarios
(so there is also no "interrupt synthetic user message"; the clear comes
from the surrounding emissions). All "transcript echo" language is replaced
with the confirmation framing: entries land in file-append order, so any
later emitted message confirms every prompt delivered before it. Two more
corrections: the JSONL _does_ record steered prompts (a chain-linked
`queued_command` attachment carrying the exact text at the demotion point) —
the earlier "not in the JSONL" wording conflated the rendered wrapper with
the prompt content; and the reason they stay invisible to `get-messages` is
that `getSessionMessages` never returns attachment entries (verified
empirically by pointing it at the `a_next` capture in an isolated config
dir: only the 9 real user/assistant chain entries came back), so the
eventual fix would read the raw JSONL. Rationale doc moved to
`docs/user-message-tracking.md`; comments in sdk-socket.ts, queue-model.ts,
daemon.ts, and the queue-model tests reworded to match.
