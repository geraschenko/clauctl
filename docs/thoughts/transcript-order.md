# Live transcript order for session-only entries

Starting point for a follow-up spec (raised in review round 88b4f5b of
docs/specs/session-tracker/phase-4-wire-clients.md).

## The problem

The TUI transcript is appended from two streams. Shared entries render
from their `sdkMessage` (the query stream); session-only entries with
content of their own — today only the steered prompt's `queued_command`
attachment, later possibly harness-injected attachments — render from
their `sessionEntry` (the file stream) at arrival
(`InteractiveMode.applyEvent`, the `sessionEntry` arm in
src/tui/interactive-mode.ts). The file stream trails the query stream by
the follower's fs.watch latency, so a session-only entry can land after a
later shared entry already rendered. For the steered prompt this needs
the model's next `sdkMessage` to beat that latency, so it is rare, but it
is not excluded, and every future session-only rendering inherits it.

The correct order is the display tree's: the session model
(src/tui/session-model.ts) already places every entry, shared or not, on
arrival. The history path (`renderHistory`) renders from that tree, so
only the live path can misorder.

## Design: insert after the display-tree parent

On a session-only `sessionEntry`, look up the entry's display-tree parent
and insert the rendered item right after it. Needs `TranscriptRenderer`
to find an item by entry uuid: `items: TranscriptItem[]`
(src/tui/transcript.ts) is the ordered source the container is rebuilt
from, so an index by uuid plus a splice-and-`rebuild` is the mechanism.
The parent may itself be unrendered (an attachment chained to another
attachment, a boundary), so the target is the nearest rendered ancestor —
the same visible-ancestor resolution `treeLines` does for filters. The
two-source append model and its release-dedupe bookkeeping
(`replayedUuids`, `replayedBoundaryUuids`) stay. If the entry itself is not in the display-tree yet, we should do something sensible like "append it for now, but add it to a watch list and when it's added to the display tree, move the component to the right place in the list".

Open points for the spec: what the index holds across `rebuild` (items,
not container children); an entry whose ancestors are all unrendered
(append, as today); interaction with an in-flight streaming component
for the parent's message.

## Ruled out: transcript as a projection of the display tree

Rendering everything from the session model's tree (as `renderHistory`
does for the replayed path) would make order the tree's by construction,
but it cannot be the live model: the transcript holds items that are not
session entries (banners for `compactSent`, `interruptSent`, keybinding
and request errors), and the file entry always trails the sdkMessage by
the follower latency, so waiting for the tree to place an entry would
delay every shared entry, not just reorder the rare session-only one. The
transcript stays append-on-arrival, with the insertion above as the one
exception.
