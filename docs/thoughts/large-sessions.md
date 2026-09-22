# Large sessions load slowly

Observed 2026-09-22 (Anton, TUI attach to a very large session after the
query-pending-list phases landed): the initial load takes several seconds
longer than the pre-rebuild TUI did. Not diagnosed; recorded so it gets
its own investigation.

Where the time plausibly goes (unmeasured — profile before optimizing):

- The attach fetches the full entry list and `renderHistory` renders the
  whole `pathToLeaf` through `TranscriptRenderer.appendEntry`, one
  component per item, with a `rebuild` per append.
- The daemon's history read walks the whole file (rolling builders,
  context tree, `byUuid`).

Candidate optimizations, roughly in order of payoff for the work:

- Load only the "live" part of the conversation first (the tail of
  `pathToLeaf` that fits a few screens), then iterate over the rest of the
  session file at a leisurely rate in the background, prepending as it
  arrives.
- Cap the length of the `pathToLeaf` the transcript shows; when the path
  overflows the cap, show just the tail with a "N earlier entries" marker.
- One `rebuild` per history batch instead of per item.
- Measure whether the daemon side (read + tree build) or the TUI side
  (render) dominates before touching either.

Constraint carried over from docs/specs/query-pending-list.md: whatever
loads first must keep the live/re-attached transcript agreement (the
transcript is a function of the session models), so a partial initial load
is a view cap, not a different rendering path.
