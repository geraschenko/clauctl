# TUI history: get-messages RPC and transcript replay on attach

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

// StateSnapshot gains (present when non-empty, matching existing style):
queuedMessages?: { id: number; message: SDKUserMessage }[];
// TDC: With deliveredPending, is lastTranscriptUuid still required? I think yes, but please think about this question carefully.
// ...and the attach boundary (present once any user/assistant sdkMessage has
// been emitted this daemon lifetime): the uuid of the last one. Transcript
// entries at/before it were emitted before this snapshot, so the subscriber
// never saw them; everything after arrives on the live stream.
lastTranscriptUuid?: string;
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
(a compaction raced the attach; the buffered live events carry the new
segment); otherwise the prefix through the boundary entry.

### `src/tui/interactive-mode.ts` (`InteractiveController`)

- New field:
  ```ts
  private historyBuffer: SdkEvent[] | undefined = [];
  ```
- Constructor: replace the `(queued message N)` placeholder loop — seed the
  pending area directly from the snapshot:
  `pendingMessages.add(entry.id, userText(entry.message))` for each entry of
  `snapshot.queuedMessages ?? []`. Then kick off
  `void this.loadHistory(snapshot.lastTranscriptUuid)`.
- `private async loadHistory(boundaryUuid: string | undefined)`: request
  `get-messages`; on success replay each message of
  `historyToSdkMessages(historyUpToBoundary(history, boundaryUuid))`; on
  failure add a banner. Either way drain `historyBuffer` and set it to
  `undefined`. Replay of one adapted message:
  - `user` with non-empty `userText` → `new UserMessageComponent(text)` into
    the chat container first. Live user prompts enter the transcript via
    `userMessageDequeued` (never via `sdkMessage`), so history must render
    them itself — same `userText` + `UserMessageComponent` as the dequeue
    path.
  - then `handleSdkMessage(adapted)` for every message — assistant messages
    render whole (streaming map is empty), tool_result blocks resolve the
    tool components, text-only user messages fall through harmlessly.
- `handleEvent`: while `historyBuffer !== undefined`, push the event and
  return; the drain replays through `handleEvent` with the gate open, so
  every buffered event takes the normal fold+render path. No dedupe is
  needed: replay stops at the boundary, and everything after the boundary
  was emitted post-snapshot, so it arrives (only) as buffered/live events —
  each message renders exactly once by construction. This covers user
  prompts too: a prompt past the boundary is skipped by replay and rendered
  by its buffered `userMessageDequeued`; a prompt at/before the boundary was
  dequeued pre-snapshot (its dequeue precedes its transcript replay on the
  stream), so no dequeue event for it can reach this subscriber.

## Edge cases

- **No session yet** (spawned, never queried): `get-messages` returns `[]`;
  the TUI renders nothing extra.
- **Attach mid-turn**: messages completed before the transcript read appear
  in history; in-flight partials arrive only on the live stream (the jsonl
  holds completed messages). Buffer-then-drain plus the boundary cut makes
  the overlap window render-once. An assistant message mid-stream at attach
  renders whole from its live `assistant` message (its `message_start` was
  pre-snapshot, so the streaming map has no component and stray deltas are
  ignored).
  TDC: Just to confirm my understanding, this means that the assistant message is effectively missing until it is _completed_, not that it's missing entirely, right?
- **Known residual race**: attaching to a just-revived daemon (boundary
  undefined) while a first query races the transcript read can render that
  prompt twice (once from replay-all, once from its buffered dequeue).
  Requires revival + instant query + instant attach within the read window;
  accepted as negligible.
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
- [x] TUI: history load, event buffering, uuid dedupe, queued-text seeding (interactive-mode.ts)
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
Steer dequeues cannot duplicate (their prompts appear in history only inside
tool_result blocks, where `userText` is empty).

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
  the just-accepted message). Steer dequeues stay out (content reaches an
  attacher inside the tool_result text; no echo exists).
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

- [ ] Final approval of the clearing-rule refinement, then fold this design
      into the SPEC type-design section
- [ ] Implement daemon `deliveredPending` + snapshot `deliveredMessages`
- [ ] TUI renders `deliveredMessages` between history replay and drain
- [ ] Test for the attach-window gap (form TBD)
- [ ] New doc explaining why the daemon must track queued + delivered
      prompts (SDK echo gap), e.g. `docs/thoughts/user-message-tracking.md`
- [ ] Presubmit + credit-free live check; then back to reviewer 9c67337b
      (continue the existing conversation, do not spawn fresh)

## 2026-07-11 — TDC: no backward-compatibility affordances

Resolved (agreed; matches the standing no-backward-compat rule): removed the
old-daemon success criterion in favor of "a failed `get-messages` surfaces as
the TUI's ordinary error banner", dropped the pre-extension-daemon edge case,
and simplified queued-message seeding to iterate `snapshot.queuedMessages`
directly (no id-map over `assistantState.queued`, no placeholder fallback).
The `SDK_SOCKET_VERSION` stays-1 note is kept as a protocol fact, not a
compatibility promise.
