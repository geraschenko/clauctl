# Rename the merge streams: `query`/`session` → `sdk`/`file`

Anton, 2026-09-22. The two merge streams (`MergeStream` in
src/core/agent-state/session-state.ts; `eventStream` in protocol.ts;
`seenOn`/`excludedFrom` in stream-merge.ts; `pending(merge, "query")`
readers in the TUI; docs/protocol.md, docs/user-message-tracking.md, the
query-pending-list and session-tracker specs) are named `query` and
`session`. Both names mislead:

- `session` collides with "session" the conversation (a `SessionState`,
  a session id, the session models), so "the session stream" reads as
  "the conversation's stream" rather than "the session file's stream".
- `query` names the SDK `Query` object, but the daemon's own events
  (dequeue echoes, `compactSent`, `shutdown`) are observed on it too.

The intended meaning is **what a node is synchronized with**, not where
it originated: a node on the `sdk` stream is ordered against the SDK
message sequence; a node on the `file` stream is ordered against the
session file's append order. A dequeue echo is a daemon-made event, but it
belongs to the SDK stream because its position is fixed relative to the
SDK messages around it. The rename should make that reading the obvious
one: `sdk` / `file`, and prose that says "synchronized with the SDK
stream", never "came from".

Scope of the rename, when it happens:

- `MergeStream = "sdk" | "file"`, `MERGE_STREAMS`, `eventStream`,
  `excludedFromQuery`/`excludedFromSession` → `excludedFromSdk`/
  `excludedFromFile`, `excludedFromOther`, `scanExcluded` wording,
  `querySessionId`/`fileSessionId` (the former becomes `sdkSessionId`).
- `sessionEntry.expectsSdkMessage` — Anton's `expectsQueryMessage`
  proposal (docs/thoughts/session-tracker-follow-ups.md) is folded into
  this overhaul; under the new names the question is whether the field
  predicts an SDK twin or "not excluded from `sdk`".
- Wire: `AgentState` and `SessionState` cross the socket, so `seenOn`/
  `excludedFrom` values change on the wire; subscribers run the same fold
  code, so no compatibility shim.
- Docs and specs: update the live docs (protocol.md,
  user-message-tracking.md, architecture.md); leave finished specs'
  WORK LOGs as written, with a note at the top pointing here.
