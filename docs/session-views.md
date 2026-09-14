# The three views of a session

We have three ways of thinking about a session: what's in the session file,
what's presented to the assistant model, and what's presented to the user. It's
important not to conflate them.

## 1. What's in the session file

The raw jsonl entries with their parent pointers — write-order truth. Entries
appear in the order events happened: parallel tool calls chain as they stream,
each result parents on its own call at completion, and the next turn parents on
whatever entry is the file tip when it is written (the last-WRITTEN result, not
a position fixed at call time). The file accumulates forks (rewinds, abandoned
branches), compact boundaries, re-persisted duplicates. Nothing here is what
anyone _sees_; it is the substrate both other views are computed from.

Owned by: `src/core/session/` (parsing, canonical first-wins dedup, the
follower), `SessionTreeBuilder` in `src/core/tree/build-tree.ts` (the full
occurrence tree).

## 2. What's presented to the assistant

`ContextTree` (src/core/tree/context-tree.ts) is the assistant's view: every
full-tree occurrence except boundary rows, each under its context predecessor
(parallel groups linearized[^groups], entries the loader always drops marked
`excluded`), so `contextAt(ref)` is the context the assistant had with `ref` as
the tip and `contextAt(leaf)` is what the next turn will see. Every
read of the assistant's context (`get-context`, the daemon's `leaf`, the
`contextChanged` event, `/tree` picks) goes through it.

Note that the SDK function `getSessionMessages` does _not_ supply the assistant
view; see [socket-interface.md](docs/socket-interface.md) for details.

## 3. What's presented to the user

The display tree is the order in which messages appear in the TUI transcript (src/core/tree/display-tree.ts, src/tui/). This represents the user's view, which is different from both other views in two important ways. First, pre-compaction history survives on the screen above the "context compacted" banner, so in the display tree compaction boundary entries have parents, whereas in the context tree a compaction boundary is always a root because the assistant sees nothing before it. Second, a prefix of the relinked messages in a compaction boundary are hidden when they match the suffix of the messages immediately prior to the boundary. This is basically to address the fact that when you `/compact`, the TUI user expects to "continue from the summary", whereas the assistant actually sees the summary followed by the exact message it sent immediately prior to compaction.

A critical relationship between the two trees is that if X is a parent of Y in the display tree, then `contextAt(Y)` _must_ equal `[...contextAt(X), Y]`. This property ensures that even though the user and assistant have different views of the conversation, `set-context --rewind-to X` (i.e. setting the leaf to X) has the effect of resetting both views to whatever they were when X had just happened.

## How the views are kept

All three trees are **rolling builders** (`SessionTreeBuilder`,
`ContextTreeBuilder`, `DisplayTreeBuilder` in `src/core/tree/`): each is
pushed one entry at a time, in file order, and extends its structure
incrementally; a dependent builder reads its upstream's nodes through a
cursor. The structure is a function of the entry sequence alone, so a tree
built live, entry by entry, equals the tree a restart rebuilds from the file.
Nothing is ever rebuilt per request.

Two holders run the same builders with different retention:

- **The daemon** (`SessionTracker`, src/core/daemon/session-tracker.ts)
  keeps view 2 (and 1, but only because it's require to build 2) for the tracked
  file — an index of byte ranges plus the
  full and context trees — and no entry payloads; it serves `get-entries`
  and `get-context` by re-reading payloads by range. It computes the leaf
  and `contextChanged` and stamps them onto the `sessionEntry` events it
  emits.
- **The TUI** (`SessionModel`, src/tui/session-model.ts) keeps view 3 (also 1
  and 2, but only because they are required to build view 3),
  fed by the socket: the `get-entries` snapshot after subscribing, then
  every live `sessionEntry`. It holds every entry (complete from the
  snapshot, structural for live shared entries whose payload came as an
  `sdkMessage`) so `/tree` and transcript redraws read local state and never
  refetch.

Both reset their per-file model on `sessionFileChanged` and rebuild it from
the new file's scan. How the entry stream reaches a client, and why the
daemon's and the TUI's trees agree, is in
[`socket-interface.md`](socket-interface.md) and
[`stream-merging.md`](stream-merging.md).

## Historical note: `loadedContext`

`loadedContext` (src/core/tree/loader.ts) is clauctl's implementation of the
claude CLI's exact load pipeline (stages 1–4: relink + cut, leaf walk,
parallel-group expansion, resume sanitization — docs/specs/session-tree.md
"Ground truth"), including its unintuitive parts, e.g. splicing recovered
parallel results after the group's last on-path assistant entry. It was the
implementation of view 2 before `ContextTree`, and it remains the fidelity
oracle the context tree is checked against at every settled prefix
(src/core/tree/context-check.ts, scripts/check-context-at.ts). Clauctl no longer
uses it.

## Footnotes

[^groups]: `ContextTree` exists to answer `contextAt` for any point of the file by
    lookup, which requires one fixed linearization of each parallel tool
    group; it keeps file order. The CLI's loader instead splices a group's
    off-path results after the last on-path assistant entry, so its order
    inside an interleaved group depends on the tip. The two differ only in
    the order of `tool_result` blocks inside the merged user message
    (docs/specs/context-tree.md, "Group order is canonical"). Our order
    never reaches the API, so this costs nothing; the loader's own
    tip-dependent reordering does mean that a rewind into a group can miss
    the prompt cache even inside its window.
