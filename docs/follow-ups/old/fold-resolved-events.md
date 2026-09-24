# The fold should emit what each step resolved

Raised while planning docs/specs/session-tracker/phase-5-docs.md
(Anton, 2026-09-14). Deferred; a follow-up spec.

## The leak

sdk.sock's promise is that a subscriber maintains `AgentState` from the
subscription alone. `MergeState` (src/core/stream-merge.ts) mostly hides
that the state is assembled from unsynchronized streams, but not
completely: a client sees an `sdkMessage` before its `sessionEntry`
twin (or the reverse), and if it wants to act only on facts that no
later arrival can reorder, it has to read the merge's pending set and
understand settledness. The TUI does this by hand (`SessionModel`,
src/tui/session-model.ts: merging entries and SDK messages into
`byUuid`, separately from its tree building).

## Idea

`nextAgentState(state, event)` returns not only the next state but the
events that became **resolved** in that step (stream-merge.md's term:
no future arrival on any stream can precede them). A client that
tolerates the follower's latency consumes the resolved list and never
learns that streams exist; a client that wants immediacy (the TUI's
transcript) keeps consuming raw events as today. Both use the same
fold.

For that to be strictly correct:

- the merge-and-`byUuid` half of `SessionModel` moves into `src/core/`
  next to the fold — it is the resolved-order projection every client
  would otherwise reimplement;
- the daemon-bookkeeping events go on the **query** side of the merge,
  so they are interwoven with the resolved order rather than floating
  beside it (today they are neither pending nor resolved; they just
  pass through).

Closed by phase 3.5 of docs/specs/query-pending-list.md: every event is a
merge node (`eventUuid`), the uuid-less ones stamped by the daemon and
observed on their stream.

## Open

- Return shape: `{ state, resolved: AgentEvent[] }` versus a separate
  projection over the state; the fold is pure and the resolved list is
  derivable from consecutive states, so this may be a helper rather
  than a signature change.
- Whether `sessionAppended`/`scanComplete` still exist once resolution
  is first-class.
