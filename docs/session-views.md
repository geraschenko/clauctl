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

Owned by: `src/core/session/`, `buildTree` in `src/core/tree/`.

## 2. What's presented to the assistant

`ContextTree` (src/core/tree/context-tree.ts) is the product's view: every
full-tree occurrence except boundary rows, each under its context predecessor
(parallel groups linearized, entries the loader always drops marked
`excluded`), so `contextAt(ref)` is the context the assistant had with `ref` as
the tip and `contextAt(leaf)` is what the next turn will see. Every product
read of the assistant's context (`get-context`, the daemon's `leaf`, the
AgentState seed, `/tree` picks) goes through it.

`loadedContext` (src/core/tree/loader.ts) is the fidelity oracle behind that
view: the entries the assistant will see on its next turn, computed the way the
claude CLI computes them. This MUST mirror the claude CLI's load pipeline
(stages 1–4: relink + cut, leaf walk, parallel-group expansion, resume
sanitization — see docs/specs/session-tree.md "Ground truth"), even where that
pipeline is unintuitive — e.g. recovered parallel results are spliced after the
group's last on-path assistant entry, not at their chronological position.
Fidelity to the binary outranks elegance: this view exists to predict, not to
please. Stage 5 (wire normalization) reshapes API messages, not which entries
are present, and is out of scope. set-context playlists are instructions about
THIS view, and are validated/normalized against loader semantics before being
written. The context tree is checked against it at every settled prefix
(src/core/tree/context-check.ts, scripts/check-context-at.ts); it is not used by
product code otherwise.

## 3. What's presented to the user

The display tree and TUI transcript (src/core/tree/display-tree.ts, src/tui/):
optimized for human comprehension, deliberately different from both other views.
It is the context tree's relation with an edge meaning — row Y under row X iff
the assistant context at Y is "the context at X, then Y" — plus boundary rows
re-inserted where they are shown (docs/specs/context-tree.md). It shows MORE
than the assistant sees (pre-boundary history survives compaction on screen),
HIDES file artifacts (a boundary's relinked block, when the block reproduces a
context that already existed on screen), and prefers strict chronological order
(docs/thoughts/tree-presentation.md) where the loader's order would misrepresent
what happened.
