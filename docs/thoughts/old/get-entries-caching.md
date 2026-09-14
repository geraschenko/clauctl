For long sessions, get-entries requests become pretty slow, which makes it so that things like `/tree` have very noticable lag. To address this, the daemon should keep a prefix of the session file in memory and file reads in src/core/session/file.ts should only read from the last read byte offset (or something like that).

## Rolling trees (2026-09-03)

The same incremental read should feed the trees. Today every `/tree` and
history render re-runs `buildTree → toContextTree → toDisplayTree` over the
whole entry list; each of those is a single pass now (review round
48536d3 in docs/specs/context-tree.md), which is the shape a rolling
builder needs: place each row once when it arrives.

Model: the daemon keeps a `tail -f` of the session file and, per appended
entry, extends
(1) the entry list / `byUuid` (maybe also a uuid->index-in-entry-list map),
(2) the full tree (parent via the latest boundary's relink; a boundary appends
its block after its anchor row, so an up_to block waits for the summary
entry),
(3) the context tree (group linearization: an arriving same-message assistant,
result, or outside child of a group result parents onto the group's tail so
far), and
(4) the display tree (a boundary is matched against the rows placed so far;
hidden rows reattach children to the nearest visible ancestor).

Retroactive effects are bounded:

- `excluded` changes when a result arrives for a call that had none, or a
  non-thinking member joins a thinking-only group: bounded by the group's
  size.
- A boundary hides a prefix of its own block and re-parents the rows that
  follow it: bounded by the preserved list length.
- Nothing already placed changes its parent; the full tree's
  first-wins/parent-before-child invariants are exactly what make appends
  safe.

What stays per-request: the leaf marker and rendering. What goes away:
`get-entries` shipping the whole file to the TUI so it can rebuild the
trees itself — the daemon would serve the trees (or their deltas).
Alternatively, the TUI can maintain its own rolling trees (using the same core
code) and the TUI could use `get-entries --since` to compute the delta since the
last time it updated. I'm not sure if this is better or worse than the daemon
serving the tree deltas directly.

## Two streams, one leaf (2026-09-07)

Once the daemon `tail -f`s the session file it holds two streams that are
not synchronized: the SDK stream (what `agentState` folds today, including
`agentState.leaf` = the last user/assistant message the stream reported)
and the file stream (every entry, including `turn_duration`, attachments,
isMeta prompts — which is why `seed.ts` exists: it bridges the file into
the stream-shaped state at startup, under the stream's eligibility
filter). That is the point to decide how the two interleave and whether
`agentState.leaf` can simply become `ContextTree.leaf` (the last row of
any kind; docs/specs/get-context.md) instead of a stream-derived value
with its own filter. Until then the seed keeps mirroring the fold.

This is also where we would decide what file entries should be emitted as
SdkEvents. It seems reasonable that at least _some_ entries should produce
SdkEvents, e.g. the uuid of a user message is otherwise unobservable. Right now,
if there are consumers of the sdk stream, they read the session file through
entryToSessionMessage in src/core/session/file.ts. The ideal we should aim for is that sdk stream consumers behave the same regardless of whether the stream is being "reconstructed" from the file or played live.
