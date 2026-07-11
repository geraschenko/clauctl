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
   renders the history through *exactly* the same code path live messages
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
- Old daemon + new TUI: no `queuedMessages` in the snapshot → placeholder
  text, and a rejected `get-messages` → an error banner; the TUI otherwise
  works. `SDK_SOCKET_VERSION` stays 1 (both protocol additions are additive
  optional shapes).
  TDC: Do not make any backwards compatibility affordances. The error banner should be generic, the same sort of error banner the TUI would show if `get-messages` failed for any other reason.
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
```

### `src/core/daemon.ts`

- New `case "get-messages"` in `handleRequest`: resolve the latest session
  from `record.sessions`; none → `[]`; otherwise
  `await getSessionMessages(sessionId, { dir: record.cwd })`.
- Subscribe snapshot gains
  `...(queueModel.queued.length > 0 && { queuedMessages: queueModel.queued.map(({ id, message }) => ({ id, message })) })`
  — dropping the internal `toolResultSeen`.

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
```

Filters to `user`/`assistant` and casts — `SessionMessage` carries every
field the corresponding `SDKMessage` variants require (`type`, `message`,
`uuid`, `session_id`, `parent_tool_use_id`).

### `src/tui/interactive-mode.ts` (`InteractiveController`)

- New fields:
  ```ts
  private historyBuffer: SdkEvent[] | undefined = [];
  private readonly historyUuids = new Set<string>();
  ```
- Constructor: replace the `(queued message N)` placeholder loop — build a
  `Map<number, string>` of `id → userText(message)` from
  `snapshot.queuedMessages`, iterate `assistantState.queued` (ids stay
  authoritative), placeholder only as fallback for a pre-extension daemon.
  Then kick off `void this.loadHistory()`.
- `private async loadHistory(): Promise<void>`: request `get-messages`; on
  success replay each `historyToSdkMessages` result, recording each uuid in
  `historyUuids`; on failure add a banner. Either way drain `historyBuffer`
  and set it to `undefined`. Replay of one adapted message:
  - `user` with non-empty `userText` → `new UserMessageComponent(text)` into
    the chat container first. Live user prompts enter the transcript via
    `userMessageDequeued` (never via `sdkMessage`), so history must render
    them itself — same `userText` + `UserMessageComponent` as the dequeue
    path.
  - then `handleSdkMessage(adapted)` for every message — assistant messages
    render whole (streaming map is empty), tool_result blocks resolve the
    tool components, text-only user messages fall through harmlessly.
- `handleEvent`: while `historyBuffer !== undefined`, push the event and
  return. During the drain and afterward, `sdkMessage` events whose
  `message.uuid` is in `historyUuids` (applies to `assistant`, `user`, and
  `stream_event` — all three carry the message uuid) skip *rendering only*:
  the `nextAssistantState` fold still runs, because every buffered event is
  post-snapshot and the snapshot state does not include it. Concretely: fold
  first (as today), then bail out of the render switch on a uuid hit.

## Edge cases

- **No session yet** (spawned, never queried): `get-messages` returns `[]`;
  the TUI renders nothing extra.
- **Attach mid-turn**: messages completed before the transcript read appear
  in history; in-flight partials arrive only on the live stream (the jsonl
  holds completed messages). The buffer-then-drain ordering plus uuid dedupe
  makes the overlap window render-once.
- **Tool results in history**: a history user message's `tool_result` blocks
  update the `ToolExecutionComponent`s created by the preceding assistant
  message, exactly as live. A dangling tool call (turn interrupted before its
  result) stays unresolved, matching what a live viewer saw.
- **Pre-extension daemon**: `get-messages` is rejected → error banner, blank
  transcript otherwise (today's behavior); no `queuedMessages` → placeholder
  pending text.
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
  the *same* session file (the `forkSession: true` option exists precisely to
  make resume create a new file), so post-rewind messages branch via
  parentUuid: an in-file tree, no forkSession needed. `getSessionMessages`
  walks back from the file's last entry → active branch. File state is
  restored separately via `Query.rewindFiles(userMessageId)` (requires
  `enableFileCheckpointing`). Implementing this means daemon query-lifecycle
  restart — a separate spec. Not yet observed in a real transcript (no branch
  points found in recent sessions); confirm with one interactive claude
  Esc-Esc before building `/tree`.
- **Attach race**: the subscribe snapshot and the transcript read are not
  atomic. Subscribe-first + buffer + uuid dedupe closes it: any message that
  lands in both the jsonl read and the buffered live events is skipped by
  uuid on the live side. Dedupe must also cover `stream_event`s (their `uuid`
  is the message uuid) or a deduped assistant message's buffered partials
  would leave a stray streaming component. If the stream_event/assistant uuid
  identity assumption fails, the failure mode is a transient duplicate that
  the assistant-message finalize collapses — not corruption. Verify the
  identity during implementation.
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

- [ ] Protocol: `get-messages` request + `queuedMessages` snapshot field (sdk-socket.ts)
- [ ] Daemon: `get-messages` handler + snapshot population (daemon.ts)
- [ ] CLI: `get-messages` subcommand (sdk-commands.ts)
- [ ] Render: `historyToSdkMessages` + tests (sdk-render.ts)
- [ ] TUI: history load, event buffering, uuid dedupe, queued-text seeding (interactive-mode.ts)
- [ ] Presubmit green; live check against a real agent
