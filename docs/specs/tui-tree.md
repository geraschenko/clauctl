# Spec: TUI `/tree` and context-aware history

> Status: **approved for implementation** (Anton, 2026-07-18, after three
> review rounds + fresh-context reviewer approval; see WORK LOG).
> Follow-up to `docs/specs/session-tree-and-set-context.md`
> (set-context + get-tree), `docs/specs/boundary-substructure.md` (viaBoundary
> occurrences), and `docs/specs/format-tree.md` (tree rendering, which
> anticipated this spec). Background: `docs/thoughts/rewind-and-tree.md`.

## SPEC (stable requirements)

### Problem

The TUI predates set-context. Two gaps:

1. **The TUI ignores context changes.** When a `contextChanged` event arrives
   (a set-context from this TUI or any other client), the transcript keeps
   showing the old conversation. The TUI must redraw from the new context.
2. **The TUI has no rewind affordance.** Navigating the session tree requires
   the `clauctl set-context` CLI against uuids read from `format tree`. A
   pi-style `/tree` command should open an interactive picker over the
   conversation tree and rewind to the picked message.

Both features share one definition of "the history": **the root-to-leaf path
in `get-tree`**, not the `get-messages` chain. The path follows tree edges,
which cross compact boundaries via boundary substructure and
`logicalParentUuid` — so the TUI shows the full logical history,
pre-compaction messages included. The path contains BOTH the raw
pre-boundary prefix (the boundary's ancestors via `logicalParentUuid`) and
the relinked occurrences under the boundary, and the transcript renders
every path node in order — preserved messages appear twice, DELIBERATELY:
the segment below a "context compacted" banner is exactly the context that
boundary installed, which is the honest display of what the assistant now
sees (and matches `format tree`, which renders relinked occurrences as
their own rows).

### History rendering (attach + redraw)

- The transcript source becomes `get-tree` + the root-to-leaf path
  (`pathToLeaf`), replacing `get-messages`, in BOTH places:
  - **attach** (`loadHistory`): so history beyond a compact boundary is
    included — today's get-messages attach shows only the post-boundary tail;
  - **redraw**: a new `contextChanged` case in the event switch clears the
    transcript state (`chatContainer`, `streaming`, `toolComponents`), re-arms
    the live-event buffer, and reruns the history load.
- Path entries render through the existing live pipeline: converted with
  `entryToSessionMessage` and dispatched as today (user text →
  `UserMessageComponent`, the rest → `handleSdkMessage`, tool results resolve
  into their tool components). `compact_boundary` nodes on the path render the
  existing "context compacted" banner.
- The render walk keeps a rendered-uuid set — NOT to skip path nodes (every
  path node renders, duplicates included, per the Problem section), but as
  the release-dedupe set below: it separates path-vs-buffer duplication
  (a bug) from path-internal duplication (the honest display).
- `AgentState.lastTranscriptUuid` becomes `leafTreeNodeRef?: TreeNodeRef` —
  the current leaf _occurrence_ of the session tree. Stream user/assistant
  messages fold it as a raw ref (`{uuid}`, today's semantics); a
  `contextChanged` event now carries the new leaf (`leaf: TreeNodeRef |
  null`, the file-truth effective tip; `null` after an empty-context reset
  unsets the field), so the folded leaf is correct immediately after a
  set-context instead of naming a dropped entry. This is also the natural
  cursor representation for later cursor work.
- Every daemon read of the session file is flush-synced:
  get-tree/get-entries already read via `readEntriesAfterStreamFlush`;
  get-messages (`synthesizeMessages`) joins them. The wait key is
  `leafTreeNodeRef.viaBoundary ?? leafTreeNodeRef.uuid` — a relinked leaf's
  newest on-disk entry is its boundary; daemon-authored boundary appends are
  synchronous, so an unset leaf (or `--empty`) has nothing to wait for. This
  closes the FILE-LAG race: the snapshot leaf's backing entry is always in
  the fetched tree. It does not guarantee the snapshot leaf is on the
  fetched _path_ — a context change between snapshot and read moves the
  leaf; that case resolves through the buffered `contextChanged` (next
  bullet's warning suppression + the follow-up reload it triggers).
- Attach and redraw share one load path, cut at the leaf occurrence
  (`pathUpToBoundary(path, leaf)`, the path-based replacement for
  `historyUpToBoundary`; exact uuid+viaBoundary match). Only _ordinary raw_
  occurrences after the match are dropped — those are the entries whose
  live events render them; `viaBoundary` occurrences always replay
  (relinked entries never stream), so attaching right after a native
  compaction does not truncate the preserved substructure that follows the
  raw summary node on the path. Post-cut boundaries and their raw summaries
  always replay too, as a complete structural segment in path order
  (boundary, summary, relinked nodes), so the banner always precedes its
  installed-context segment — and because a summary's live `user` event
  renders no text (the sdkMessage user case only resolves tool results),
  replay is the only way its text appears; the buffered
  `compact_boundary`/summary events for it release-dedupe by uuid like any
  other replayed entry. A missing leaf match replays everything; the warning is
  emitted only when NO buffered `contextChanged` is pending — a pending one
  means this reload is already superseded (a context change moved the leaf
  between snapshot and read; the release loop reloads with the new leaf),
  so warning would be spurious. With no pending change, a missing match is
  a genuine invariant violation and warns as today.
- Double-render protection is dedupe on release: buffered transcript-
  rendering events whose uuid was already rendered from the path — user and
  assistant `sdkMessage` events AND `stream_event` messages (their partial-
  message wrapper carries the transcript uuid) — are folded into
  `agentState` but not rendered (no streaming component is created for a
  deduped uuid). The flush-synced read may include entries newer than the
  snapshot leaf, which are also in the buffer. (A dequeue-rendered prompt
  racing into the tree read has no uuid to dedupe on — accepted, same class
  as the attach-time missing-boundary window.) Replayed boundary BANNERS
  additionally dedupe one-shot beyond the release loop: stream-before-file
  ordering is the codebase's working assumption but unproven for native
  compaction events, so a banner event arriving after release consumes a
  persistent per-uuid entry instead of rendering a second banner (only
  banners need this — post-cut ordinary raw entries never replay, and a
  replayed summary's live user event renders nothing).
- Attach race semantics otherwise unchanged: delivered-but-unconfirmed
  prompts append after the replayed path; buffered live events release
  afterwards.
- A `contextChanged` that arrives while a reload is in flight lands in the
  live-event buffer and triggers a follow-up reload when released.

### `/tree` command

- Intercepted locally like `/model` (exact first token `/tree`, no argument)
  and listed in the autocomplete `LOCAL_COMMANDS`.
- Opens a `TreeSelectorComponent` over the `get-tree` response (statusContainer
  - focus, like the model selector; `get-tree` failure → error banner, no
    selector). Modeled on pi's `TreeSelectorComponent`, with rows rendered as
    `clauctl format tree` renders them (`flattenVisibleTree` +
    `formatTreeNodeLine`) minus the entry uuids (useful for copy-paste in the
    CLI, distracting in a picker; `formatTreeNodeLine` gains an `omitUuid`
    option) plus a selection highlight — shared code, not a copy.
- **Fixed visibility filter** (no filter cycling): user entries with text,
  final assistant entries (`isFinalAssistantEntry`) with text,
  `compact_boundary` markers, and the current leaf unconditionally.
  Restricting assistants to final entries makes assistant rows valid
  `rewindTo` targets in ordinary session shapes; the daemon's file-order
  validation ("no later entry shares message.id" — strictly stronger than
  the tree-child predicate) remains the authority and rejects exotic shapes
  with a clear error. The predicate also becomes a new `format tree` filter
  mode (`FILTER_MODES` gains `"picker"`), so the CLI can render exactly the
  picker's rows (uuids included there) and the predicate has one shared,
  testable home.
- **Search**, pi's UX: printable characters append to a query shown below the
  tree, backspace edits it, tokens AND-match case-insensitively against the
  rendered summary line, matching re-runs the visible-structure recalculation.
  Escape clears the search if one is active, otherwise cancels the selector.
- **Navigation**: up/down with wrap-around, page up/down, enter confirms,
  escape cancels (per above). Initial selection = the current leaf. Vertical
  windowing around the selection. The current-leaf visibility exemption
  applies to the fixed filter only, not to search (pi parity: a search that
  doesn't match the leaf hides it). Row text is the `formatTreeNodeLine`
  output at the selector's render width (same truncation and `*`/`•`
  markers); the selection highlight is additional; the picker renders no
  `[cursor: …]` line.
- **Pick semantics** (`resolveTreePick`; the pick is a `TreeNodeRef` — an
  occurrence, not a bare uuid):
  - assistant pick → `set-context {rewindTo: pick}`;
  - user pick → `rewindTo` = the nearest assistant ancestor of the picked
    node (tree-parent walk, skipping non-assistant nodes; the ancestor's own
    occurrence ref), with `editorText` = the picked user message's text,
    prefilled into the editor on success;
  - boundary pick → the same ancestor walk without `editorText`: rewind to
    the nearest assistant ancestor (for a boundary that's the pre-boundary
    leaf via `logicalParentUuid`) — picking a boundary undoes it;
  - no assistant ancestor (e.g. the first message of the session) →
    `set-context {uuids: []}` — a new root, empty context (P10-verified),
    `editorText` as above for a user pick.
- **Busy gating**: the selector opens regardless of activity, but confirming
  while the assistant is busy (`isBusy`) sends nothing and sets the hint text
  "cannot navigate tree while assistant is busy"; the selector stays open.
- On a successful set-context the resulting `contextChanged` event drives the
  redraw (previous section); only the initiating TUI prefills `editorText`.
  A daemon rejection → error banner.

### Occurrence-aware rewind (`rewindTo: TreeNodeRef`)

The set-context rewind target becomes a `TreeNodeRef` (`{uuid, viaBoundary?}`)
— picking a message _within_ a boundary's relinked context must rewind within
that boundary's chain, not to the raw file position (which would silently undo
the compaction).

- `viaBoundary` absent: semantics unchanged — desired context = the loader's
  view of the file truncated just after the target.
- `viaBoundary` present: it must name a `compact_boundary` entry; the desired
  context = the prefix, ending at `uuid`, of the effective chain of the file
  truncated after that boundary's block (its summary entry if present, else
  the boundary itself) — i.e. a prefix of the context that boundary installed.
  Error if `uuid` is not on that chain.
- File shape after a boundary: the boundary entry carries `parentUuid: null`
  (tree anchor = `logicalParentUuid`), and the first post-boundary write's
  `parentUuid` is the uuid of the FINAL message of the boundary's effective
  chain (P7: the last preserved uuid for up_to/no-summary, the summary
  entry's uuid for from-shape; empty chain → the boundary's own uuid, P10) —
  an old entry deep in the file. So yes, a parentUuid-only "raw tree" would
  look wrong: the new message would appear to continue the old branch as if
  the boundary didn't exist. That is exactly what boundary substructure
  fixes: the relink overwrites buildTree's uuid→node map, so the
  post-boundary write attaches to the _relinked occurrence_ under the
  boundary, not the raw node ("post-boundary entries and later boundaries'
  anchors land on relinked nodes").
- For an up_to-shaped original boundary the effective chain _starts_ with
  its summary entry, so any non-empty prefix includes the old summary's
  uuid as its first element — the new boundary's preserved list re-lists
  the old summary entry (P9 b verified exactly this). The appended boundary
  itself never carries a summary of its own: the rewind path always writes
  a no-summary boundary.
- Downstream is unchanged: desired-truncates-active → `resumeSessionAt(uuid)`
  with a filterTail override (P2 d, P9 c); otherwise a no-summary boundary
  listing the desired chain's user/assistant uuids (P9 a/b — a boundary may
  list a prefix of an earlier boundary's chain). Target validation is
  unchanged (assistant entry, final transcript entry of its API message).
- Presentation: `formatTreeNodeRef`/`parseTreeNodeRef` render/parse
  `<uuid>[@<viaBoundary>]`; the CLI `--rewind-to` accepts that syntax. The
  wire carries the object. No wire backward compatibility for the old bare
  string.
- Accepted consequence (refine later): a user-message pick whose nearest
  assistant ancestor is on the far side of a boundary rewinds to the
  pre-compaction context — the compaction is undone.

### Empty context (`--empty`)

- The daemon accepts `set-context {uuids: []}` (the "empty uuids without
  summaryText" rejection is removed — an explicit empty array on the wire is
  already a deliberate statement): it appends a no-summary boundary with an
  empty preserved list, which the loader honors as a context reset to
  nothing — P10: resumed probe request contained only the new prompt, which
  parented onto the boundary. Verification expects the empty chain.
- The fat-finger protection lives in the CLI, where accidental invocation
  actually happens: `--empty` is the only way to send an empty list — bare
  `set-context` stays a usage error, its message now listing `--empty`
  ("expected message uuids, --summary, --rewind-to, or --empty").
- CLI: new `--empty` boolean flag on `set-context` → `{uuids: []}`; mutually
  exclusive with positional uuids, `--summary`, `--anchor`, and `--rewind-to`
  (summary-only context is already expressible via `--summary` alone).

### Type design

**`src/core/tree.ts`** (new — the tree vocabulary and pure tree operations.
`TreeNodeRef` moves here from effective-chain.ts, `TreeNode`/`SessionTree`
from build-tree.ts, importers updated. tree.ts imports only session-file
types, so no cycle: effective-chain.ts and build-tree.ts both import from
it. `buildTree` stays in build-tree.ts — construction needs the relink
machinery.)

```ts
export interface TreeNodeRef { uuid: UUID; viaBoundary?: UUID } // moved
export interface TreeNode { /* moved verbatim */ }
export interface SessionTree { /* moved verbatim */ }

/** "<uuid>" or "<uuid>@<viaBoundary>" ("@" cannot appear in a uuid). */
export function formatTreeNodeRef(ref: TreeNodeRef): string;
/** Inverse of formatTreeNodeRef; throws on malformed input. */
export function parseTreeNodeRef(text: string): TreeNodeRef;
/** Structural equality (uuid + viaBoundary); undefined equals undefined. */
export function treeNodeRefsEqual(a: TreeNodeRef | undefined, b: TreeNodeRef | undefined): boolean;
/** Root-first path to the leaf occurrence; [] when leaf is null or absent. */
export function pathToLeaf(tree: TreeNode[], leaf: TreeNodeRef | null): TreeNode[];
/** No child of this occurrence continues the same assistant API message
 *  (shares message.id) — the entry is a valid rewindTo target. */
export function isFinalAssistantEntry(node: TreeNode): boolean;
```

`format/tree.ts`'s private `layoutId` is deleted in favor of
`formatTreeNodeRef` — the layout id and the CLI presentation become the same
function.

**`src/core/agent-state.ts`** — `lastTranscriptUuid?: string` becomes
`leafTreeNodeRef?: TreeNodeRef`: stream user/assistant messages fold
`{uuid: message.uuid}` (today's semantics, as a raw ref); a `contextChanged`
event folds its `leaf` field (`null` unsets). Consumers update: the
attach cut matches the occurrence; flush-wait keys on
`viaBoundary ?? uuid`; get-messages-override freshness compares refs with
`treeNodeRefsEqual`. In `src/core/effective-chain.ts`,
`SessionFileSeed.lastTranscriptUuid` becomes `leafTreeNodeRef?: TreeNodeRef`
and `seedFromEntries` derives it as the LAST user/assistant ref on
`effectiveTreeNodeChain(entries)` (viaBoundary preserved) — the same
eligibility the live fold applies, so state is identical before and after a
daemon restart (the chain may end in e.g. a `turn_duration` system entry,
which the fold would never have made the leaf).

**`src/core/sdk-socket.ts`**

```ts
| { type: "set-context"; rewindTo: TreeNodeRef }   // rewind variant
```

`parseSetContextRequest`: `rewindTo` must be a record with uuid `uuid` and
optional uuid `viaBoundary`; empty `uuids` arrays pass. The `contextChanged`
event gains `leaf: TreeNodeRef | null`, defined per path as the value
get-tree's leaf computation reports after the change (that equality is the
invariant a test pins):

- boundary append (and restart/verification failure after a durable
  append): the tip of `effectiveTreeNodeChain` over the re-read file;
- empty boundary: `null`;
- no-write rewind (both flavors): the `rewindTo` occurrence on the active
  occurrence chain — there is no file truth for this state, the chain tip
  of the file is the un-rewound leaf.

**`src/core/daemon/set-context.ts`** — `handleRewind(rewindTo: TreeNodeRef,
context)` computes `desired` per the occurrence rule above (calls
`effectiveChain` on the truncated file either way); the empty-uuids guard in
the request handler is removed. `GetMessagesOverride.installedAtLeafUuid`
becomes `installedAtLeaf?: TreeNodeRef`. Ordering constraint: the override
is installed with the POST-change leaf ref (the same value the
`contextChanged` event carries) — installing the pre-change ref would make
the override look stale the moment the event folds.

**`src/core/daemon/request-handlers.ts` / `get-messages.ts`** — the
get-messages handler awaits the leaf flush (`waitForEntryOnDisk`, key
`viaBoundary ?? uuid`) BEFORE either response path — the SDK
`getSessionMessages` call or synthesis; `synthesizeMessages` takes the
already-read `entries: SessionEntry[]` instead of re-reading the file
(one flush-synced read serves both). `startupOverride` takes the seed's
`leafTreeNodeRef`; the `freshOverride` staleness check uses
`treeNodeRefsEqual`. get-tree/get-entries are already flush-synced.

**`src/core/sdk-commands.ts`** — `--rewind-to` parsed with `parseTreeNodeRef`;
new `--empty` boolean flag with the exclusivity rule above.

**`src/core/session-file.ts`** (moved from `daemon/get-messages.ts` with its
wire type; `synthesizeMessages` keeps its chain loop and delegates the mapping)

```ts
export type SessionMessageOnWire = SessionMessage & { timestamp?: string };
/** The SDK's entry→SessionMessage mapping (user/assistant only;
 *  isMeta/isSidechain excluded; parent_tool_use_id/parent_agent_id null). */
export function entryToSessionMessage(entry: SessionEntry): SessionMessageOnWire | undefined;
```

**`src/format/tree.ts`** — export the existing `entrySummary`,
`collectToolNames`, `toLayoutNode`, `passesFilter`, and `formatTreeNodeLine`.
`formatTreeNodeLine` gains a trailing `omitUuid?: boolean`; `FILTER_MODES`
gains `"picker"`, and `passesFilter` becomes
`passesFilter(entry, isCurrentLeaf, isFinal, filter)` — `isFinal` computed
by callers via `isFinalAssistantEntry` over the TreeNode tree.

**`src/tui/components/tree-selector.ts`**

```ts
export type TreePickAction =
  | { kind: "rewind"; rewindTo: TreeNodeRef; editorText?: string }
  | { kind: "newRoot"; editorText?: string };
/** Assistant pick → itself; user pick → nearest assistant ancestor +
 *  editorText = the user text; boundary pick → nearest assistant ancestor,
 *  no editorText (undoes the boundary); no assistant ancestor → newRoot
 *  (sent as {uuids: []}). */
export function resolveTreePick(tree: SessionTree, pick: TreeNodeRef): TreePickAction;

export class TreeSelectorComponent extends Container implements Focusable {
  focused: boolean;   // Focusable, as in ModelSelectorComponent
  constructor(tree: SessionTree, onSelect: (pick: TreeNodeRef) => void, onCancel: () => void);
  handleInput(data: string): void;
  /** Persistent warning line for contextChanged-while-open. */
  setWarning(text: string): void;
}
```

`resolveTreePick` does NOT re-resolve a user pick's ancestor to the final
entry of its API message: the nearest assistant ancestor on the path is final
by construction except in exotic interrupt shapes, which the daemon's
final-entry validation rejects with a clear error.

**`src/tui/sdk-render.ts`** — `historyUpToBoundary` is replaced (deleted) by
the path-based equivalent (exact occurrence match; drops only raw
occurrences after the match — `viaBoundary` occurrences always replay):

```ts
export function pathUpToBoundary(
  path: TreeNode[], leaf: TreeNodeRef | undefined,
): { nodes: TreeNode[]; boundaryMissing: boolean };
```

**`src/tui/interactive-mode.ts`** — `loadHistory` switches to `get-tree` +
`pathToLeaf` + `entryToSessionMessage`; new `contextChanged` case; `/tree`
interception + `openTreeSelector()`; busy-gated confirm; `Editor.setText` for
`editorText`. **`src/tui/autocomplete.ts`** — `LOCAL_COMMANDS` gains `/tree`.

### Success criteria

1. A set-context issued by another client redraws an attached TUI: the
   transcript shows the new logical history root-to-leaf, with "context
   compacted" banners at boundary crossings, pre-boundary messages
   included, and each boundary's preserved messages re-rendered below its
   banner (the current-context segment).
2. Attaching to a session with a compact boundary shows the pre-boundary
   history (today it shows only the tail). The attach race behavior
   (boundary cut, missing-boundary warning, delivered prompts, buffered
   events) is preserved.
3. `/tree` opens a picker whose rows match `format tree --filter picker`
   output for the same session, minus the entry uuids; the current leaf is
   pre-selected; typing filters rows by summary text; escape clears the
   search, then cancels.
4. Picking an assistant row rewinds to it (both the resumeSessionAt path and
   the boundary-append path, chosen by the daemon as today) and the TUI
   redraws. Picking a user row rewinds to its previous assistant and
   prefills the editor with the user text. Picking a boundary row rewinds to
   the nearest pre-boundary assistant, undoing the boundary. Picking the
   session's first user message produces an empty context (new root) and
   prefills.
5. A pick inside a boundary's relinked context (`viaBoundary` occurrence)
   rewinds within that boundary's chain — the appended boundary's preserved
   list is a prefix of that chain — not to the raw pre-compaction position.
6. `clauctl set-context -t <agent> --rewind-to '<uuid>@<boundaryUuid>'` and
   `clauctl set-context -t <agent> --empty` work end-to-end; `--empty` conflicts
   with uuids/`--summary`/`--anchor`/`--rewind-to`. `set-context` with _no_
   non-target flags is an error whose message lists `--empty`.
7. Confirming a pick while the assistant is busy sends nothing and shows the
   hint; the selector stays open and usable.
8. Unit tests cover: `parseTreeNodeRef`/`formatTreeNodeRef` round-trip and
   malformed inputs; `pathToLeaf` (null leaf, missing leaf, viaBoundary
   occurrence selection); `isFinalAssistantEntry` (thinking→text chains, via
   occurrences); `resolveTreePick` (assistant, user, user-crossing-boundary,
   boundary pick → previous assistant without editorText, no-ancestor →
   newRoot, editorText); `pathUpToBoundary` (occurrence match, raw-only
   drop after the match, missing leaf); the `leafTreeNodeRef` fold (raw ref
   from stream messages, contextChanged leaf, null unsets) and the
   ref-based override freshness; `entryToSessionMessage` (shared with
   `synthesizeMessages`); handleRewind with viaBoundary (prefix-of-active →
   no-write, abandoned via-chain → prefix boundary, uuid not on the
   boundary's chain → error); empty-uuids set-context (boundary written,
   verification expects `[]`, contextChanged carries `leaf: null`); the
   path rendering over up_to, from-shape, and stacked-boundary fixtures
   (raw prefix, banner, then the preserved messages again — duplicates
   deliberate — and tool results resolving within each segment); the
   `contextChanged.leaf` = post-change get-tree
   leaf invariant per path (boundary append, empty, both no-write flavors);
   `treeNodeRefsEqual`; `seedFromEntries` deriving an occurrence-correct
   leaf ref (last user/assistant chain member — a trailing system entry
   must not become the leaf); warning suppression when a buffered
   `contextChanged` is
   pending; `stream_event` dedupe for an already-replayed uuid; a native
   compaction between snapshot and read (the post-cut boundary segment
   replays in order — banner before its preserved messages — and the
   buffered boundary event dedupes); the
   `"picker"` filter mode; selector filter/search/navigation and
   the contextChanged-while-open warning; the contextChanged redraw and
   tree-based attach (interactive-mode level, as far as the existing TUI
   test seams allow).

### Edge cases

- `get-tree` fails or no session yet → `/tree` shows an error banner;
  attach/redraw shows the existing "history fetch failed" banner.
- Empty session (`leaf: null`) → empty path, empty transcript; `/tree` shows
  only whatever roots pass the filter (possibly nothing) with nothing
  selectable.
- A `contextChanged` arriving while the selector is open immediately shows a
  warning ("context changed while the tree selector is open") — the attached
  user must know some other process is changing the context under them. The
  warning renders in the selector's own container (NOT `chatContainer`,
  which the concurrent redraw clears) and persists until the selector
  closes. The selector stays open with its now-stale tree (not
  auto-refreshed or closed); the transcript redraw proceeds underneath. A
  stale pick cannot _dangle_ (the file is append-only) and the daemon
  re-validates it regardless; the warning lets the user cancel or pick
  differently in light of the change.
- `effectiveChain` of a file ending in a bare empty-uuids boundary is `[]`
  (pinned by a test) — set-context verification and the redraw (empty path
  from the boundary-rooted leafless tree) both rely on it.
- A user pick whose text is empty (reachable only through the unconditional
  current-leaf exemption) behaves as a normal user pick with `editorText`
  omitted — `resolveTreePick` stays total.
- Zero visible rows (filter + search exclude everything): the selector
  renders a "(no matching entries)" line, enter does nothing, escape
  clears the search / cancels as usual.
- The picked user message's own occurrence may be `viaBoundary`; only its
  ancestor walk matters — `editorText` comes from the entry either way.

### Non-goals

- Auto-summarize on rewind ("summarize from here"/"up to here") — explicitly
  deferred by Anton; later spec.
- pi selector features beyond the floor: folding, branch-segment jump keys,
  copy-to-clipboard, labels, timestamps, filter cycling, horizontal panning.
- `rewindFiles` / file-checkpoint integration.
- Prefix-accepting uuids in `--rewind-to` (full uuids only, as elsewhere).
- Refining the boundary-crossing user-pick semantics (compaction undo is
  accepted for now).
- Any change to `get-messages` _response semantics_: it tells the caller
  exactly which messages are in the assistant's _current_ context, which
  remains important; the TUI just stops using it for transcript rendering.
  (This spec does flush-gate its read and move the per-entry mapping — the
  reported context is unchanged.)

## IMPLEMENTATION IDEAS (evolving)

- **Derisk evidence**: P10 (`p10-empty-boundary.mjs`, run 2026-07-17 on SDK
  0.3.211) — empty-preserved-list trailing boundary = empty context; probe
  request carried exactly the new prompt, first write parented on the
  boundary. P9 c — `resumeSessionAt` into a preserved-uuid member keeps the
  boundary's effect, so the no-write fast path needs no occurrence special
  case. P9 b — prefix-of-boundary-chain boundaries work, backing criterion 5.
- **handleRewind truncation point** for `viaBoundary`: truncate after the
  boundary's summary entry if `summaryOf` finds one, else after the boundary
  itself; then one `effectiveChain` call serves both rewind flavors. The
  final-entry check ("no later entry shares message.id") stays file-order
  based and occurrence-independent.
- **Redraw mechanics**: extract the constructor's `loadHistory` kickoff into
  a `reloadHistory()` that (1) clears chatContainer/streaming/toolComponents,
  (2) sets `liveEventsDuringReplay = []`, (3) runs the fetch+render+release
  sequence. The constructor and the `contextChanged` case both call it. The
  release loop already re-enters `handleEvent`, so a buffered second
  `contextChanged` reloads again naturally.
- **Selector rendering**: pi renders selection as an inverse-video line; use
  `theme` for the highlight and render `formatTreeNodeLine(flatNode,
  toolNames, width)` for the text. Width comes from the component render
  contract (pi-tui components receive width at render); recompute lines per
  render, state is just `flatNodes`/search/selection like pi's TreeList.
  Selection preservation across search changes: keep the selected ref if
  still visible, else nearest visible (pi's `lastSelectedId` idea).
- **Search predicate composition**: the fixed visibility filter and the
  search tokens compose into the one `passesFilter` predicate handed to
  `flattenVisibleTree`, so hidden-parent re-attachment keeps working during
  search. Always-visible current leaf applies before search too (pi keeps the
  leaf visible under filters; search does not exempt it — pi parity,
  pinned in the SPEC navigation bullet).
- **`isFinalAssistantEntry` via occurrences**: children of a relinked node
  come from the relink chain, so a preserved thinking→text pair keeps its
  same-`message.id` edge inside the substructure; the predicate needs no
  file-order access.
- **Pick recovery from layout ids**: `toLayoutNode` ids ARE
  `formatTreeNodeRef` output (the format-tree composite), so the selector
  recovers the picked `TreeNodeRef` with `parseTreeNodeRef(selected.node.id)`
  — no parallel bookkeeping.
- **Dedupe release mechanics**: `reloadHistory` collects the rendered path's
  user/assistant uuids; the release loop folds every buffered event but skips
  the render dispatch for `sdkMessage`/`stream_event` events whose uuid is
  in the set (fold-always, render-once). The set includes replayed
  boundary/summary uuids, so a post-cut compaction's buffered
  `compact_boundary` event doesn't render a second banner.
- **Duplicate tool_use ids on the path**: a preserved tool call registers in
  `toolComponents` once per occurrence under the same id. Path order makes
  last-wins correct: raw tool_use → raw result resolves it → relinked
  tool_use overwrites the slot → relinked result resolves that one. Don't
  "fix" the collision by keying on occurrence.
- **Busy check placement**: interactive-mode owns it (it has `agentState`);
  the selector stays dumb — `onSelect` fires, interactive-mode decides
  hint-vs-request. Reopening `/tree` while a selector is open (or its fetch
  pending) is a no-op, the `modelSelectorPending` pattern.
- **`entryToSessionMessage` move**: get-messages.ts keeps `synthesizeMessages`
  (needs the file read + chain loop); only the per-entry mapping and the
  OnWire type move to session-file.ts. Watch the import direction:
  session-file.ts must not import from daemon/.
- **Test seams**: request-handlers.test.ts already builds boundary fixtures;
  reuse for the viaBoundary rewind cases. TUI-level tests are thin
  (interactive-mode.test.ts is small); prioritize the pure functions
  (`resolveTreePick`, `pathToLeaf`, selector filter predicate) and daemon
  paths, and cover the selector via its exported pure pieces.
- **Manual E2E pass** (criteria 1, 4, 6): scripted daemon + two attached
  TUIs, set-context from the CLI, `/tree` picks of each kind — record in the
  work log.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-17: Derisk discussion with Anton; spec written. Decisions: history
  = root-to-leaf get-tree path everywhere (attach included), boundary rows
  render the existing banner; `/tree` copies pi's selector UX with search
  but a fixed filter (user-with-text + final-assistant-with-text +
  boundaries + current leaf) and no fold/copy/labels/timestamps;
  `rewindTo` becomes `TreeNodeRef` with `<uuid>[@<viaBoundary>]`
  parse/format helpers (Anton: the viaBoundary is part of the target, not a
  separate parameter); `editorText` naming for pi consistency; picks inside
  a boundary rewind within that boundary's chain (prefix boundary);
  boundary-crossing user picks undo the compaction (accepted, refine
  later); busy confirms are hint-blocked TUI-side. P10 probe written and
  run (SDK 0.3.211): empty-preserved-list boundary = empty context —
  new-root picks and `--empty` are in scope; FINDINGS.md/WORK-LOG.md
  updated. Type design approved by Anton before writing.
- 2026-07-17 (critique round): the draft reused the attach-time boundary cut
  for the redraw, but after a rewind `lastTranscriptUuid` is off the new
  path — every redraw would spuriously warn. Revised: redraw renders the
  whole path and dedupes buffered `sdkMessage` renders by rendered uuid
  (fold-always, render-once); attach keeps the cut. Also verified against
  the code that a trailing bare boundary yields `effectiveChain = []` /
  `leaf: null` (the walk's tip resolves undefined), which the empty-context
  verification and redraw rely on.
- 2026-07-17 (TDC round, commit 4788617): Anton's review addressed.
  `AgentState.contextChangedSinceLastTranscript` replaces the
  redraw-specific no-cut special case — one load path for attach and
  redraw, warning suppressed only when the cut is known stale (also fixes
  the attach-after-rewind spurious warning the previous draft missed);
  picker rows drop the uuid column (`formatTreeNodeLine` omitUuid); the
  picker predicate becomes `format tree --filter picker`; explicit
  `{empty: true}` wire variant — `{uuids: []}` stays rejected, its error
  now suggesting `--empty`; TreeNodeRef/TreeNode/SessionTree + ref
  format/parse + pathToLeaf + isFinalAssistantEntry move to a new
  `src/core/tree.ts` (no import cycles: it depends only on session-file
  types); contextChanged while the selector is open shows a warning banner
  (selector stays open, not refreshed); boundary rows are selectable —
  picking one rewinds to the nearest pre-boundary assistant, undoing the
  boundary.
- 2026-07-18 (review round 2): Anton pushed back on three points, all
  adopted. (1) The staleness boolean was a hack: `lastTranscriptUuid`
  becomes `leafTreeNodeRef?: TreeNodeRef`, updated by set-context via a new
  `leaf` field on `contextChanged`; the attach/redraw cut matches the leaf
  occurrence, and all daemon session-file reads become flush-synced
  (get-messages was the one raw reader), closing the read race structurally
  — the warning becomes an invariant safeguard. Refinement found while
  redesigning the cut: only raw occurrences after the match are dropped
  (viaBoundary occurrences never arrive as live events), which fixes
  attach-right-after-native-compaction truncating preserved substructure.
  (2) Clarified the file shape: the first post-boundary write's parentUuid
  is the final chain member's uuid, so a parentUuid-only tree WOULD look
  wrong — boundary substructure's map overwrite is what fixes it. (3) The
  `{empty: true}` wire variant is dropped: `{uuids: []}` already states the
  intent; the guard moves to the CLI (`--empty` flag required, bare
  set-context usage error lists it).
- 2026-07-18 (fresh-context reviewer round): a pictl reviewer read the spec
  against the code and found one claim-invalidating bug plus a batch of
  type-design gaps; all adopted. The big one: the root-to-leaf path
  contains BOTH the raw pre-boundary prefix (boundary ancestors via
  logicalParentUuid) and the relinked duplicates under the boundary — the
  spec's "raw occurrences are off-path" was false; exactly-once is now an
  explicit uuid-dedupe projection (first occurrence wins), whose rendered
  set doubles as the release-dedupe set. Other fixes: "structurally closed"
  weakened to file-lag-only, with warning suppression when a buffered
  contextChanged supersedes the reload; dedupe extended to `stream_event`;
  `SessionFileSeed`/`seedFromEntries` migrate to the leaf ref;
  get-messages flush-gates BEFORE getSessionMessages/synthesis and
  `synthesizeMessages` takes pre-read entries; `contextChanged.leaf`
  defined per set-context path with the invariant leaf = post-change
  get-tree leaf; `GetMessagesOverride.installedAtLeaf: TreeNodeRef` +
  `treeNodeRefsEqual`; empty-text user picks resolve as normal user picks
  (resolveTreePick stays total); the every-assistant-row-valid promise
  weakened (daemon file-order validation is the authority); selector
  warning lives in the selector container (redraw clears chatContainer);
  search does not exempt the current leaf (pinned); zero-row selector and
  row-parity details pinned; get-messages non-goal reworded to response
  semantics.
- 2026-07-18 (Anton, on the HC1 fix): the uuid-dedupe projection is
  REVERSED — duplicating preserved messages below the banner is the honest
  display (the segment after a banner IS the installed context; matches
  format tree's relinked rows). Every path node renders in order; the
  rendered-uuid set remains only for release dedupe (path-vs-buffer).
  Noted: toolComponents id collisions are correct under last-wins because
  results resolve within their own segment.
- 2026-07-18 (reviewer, final round): two adoptions. seedFromEntries picks
  the last user/assistant chain ref (live-fold eligibility), not the bare
  chain tip — trailing system entries must not seed a leaf the fold would
  never produce. And duplication exposed an ordering race the projection
  masked: the cut's raw-only drop would render a post-cut compaction's
  retained relinked segment BEFORE its buffered banner; fixed by replaying
  the complete structural segment (boundary, summary, relinked nodes) in
  path order and release-deduping the buffered boundary event by uuid.
  Reviewer confirmed path-internal duplication otherwise introduces no
  streaming-component or dedupe problem.
- 2026-07-18 (implementation, session 1): increments 1–5 of 7 done, all
  green (`npm run check` + 293 tests) after each increment; presubmit/lint
  not yet run. Completed:
  1. `src/core/tree.ts` — TreeNodeRef/TreeNode/SessionTree moved (importers
     updated incl. tests), formatTreeNodeRef/parseTreeNodeRef/
     treeNodeRefsEqual/pathToLeaf/isFinalAssistantEntry + tree.test.ts;
     format/tree.ts layoutId deleted in favor of formatTreeNodeRef.
  2. leafTreeNodeRef migration: AgentState field + fold (raw refs from
     stream messages, contextChanged leaf, null unsets, conversation_reset
     clears); contextChanged event carries `leaf: TreeNodeRef | null`;
     set-context computes it per path (`changedLeaf` set before restart;
     handleRewind gets a `setChangedLeaf` context callback);
     GetMessagesOverride.installedAtLeaf: TreeNodeRef pinned to the
     POST-change leaf; freshOverride uses treeNodeRefsEqual; seedFromEntries
     derives the last user/assistant chain REF (viaBoundary preserved);
     get-entries/get-tree/set-context flush waits key on viaBoundary ?? uuid.
     Tests: fold cases, leaf-invariant vs get-tree (append + no-write),
     trailing-system-entry seed, viaBoundary seed occurrence.
  3. get-messages flush gate (waitForEntryOnDisk before BOTH response
     paths); entryToSessionMessage + SessionMessageOnWire moved to
     session-file.ts; synthesizeMessages(entries, chain) takes pre-read
     entries. entryToSessionMessage unit test.
  4. Occurrence-aware rewind + empty context: wire rewindTo is a
     {uuid, viaBoundary?} object (parse validates; old string form
     rejected); handleRewind computes desired per flavor (viaBoundary:
     truncate after the boundary's block — summary if present — one
     effectiveChain call; errors for non-boundary viaBoundary and
     off-chain uuid); empty-uuids daemon guard removed; CLI --rewind-to
     parses `<uuid>[@<via>]`, new --empty flag with exclusivity, bare
     usage error lists --empty. Tests: viaBoundary no-write/prefix-boundary/
     validation, empty context (leaf null, get-tree null, get-messages []),
     bare-empty-boundary chain = [] pin, parse cases. format events
     contextChanged test now expects the JSON fallback (truncated at 80).
  5. format/tree.ts: exports entrySummary/collectToolNames/toLayoutNode/
     passesFilter/formatTreeNodeLine; passesFilter(entry, isCurrentLeaf,
     isFinal, filter); FILTER_MODES + "picker"; formatTreeNodeLine
     omitUuid; NEW helper `collectFinalAssistantIds(tree): Set<string>`
     (layout ids of final assistant occurrences — exported so the selector
     reuses the same walk instead of duplicating it; extension beyond the
     pinned export list). Picker + omitUuid tests.
     Remaining: increment 6 (TUI history: pathUpToBoundary + carve-out,
     reloadHistory, contextChanged redraw, release dedupe incl. stream_event —
     verified SDKPartialAssistantMessage carries `uuid`), increment 7 (/tree
     selector), then work-log/presubmit/review. Note: interactive-mode.ts
     loadHistory currently passes `seedState.leafTreeNodeRef?.uuid` into the
     old get-messages cut as a TRANSITIONAL shim — increment 6 replaces it.
     Everything is uncommitted on `format` (Anton has not asked for commits).
- 2026-07-18 (implementation, session 2): increments 6–7 done; presubmit
  green (check + eslint + treefmt + 311 tests). Completed:
  6. TUI history: `pathUpToBoundary(path, leaf)` in sdk-render.ts replaces
  the deleted `historyUpToBoundary` AND `historyToSdkMessages` (its one
  other caller was the deleted loadHistory; format/messages.ts's comment
  reference updated). Occurrence-exact cut; raw-only drop after the
  match; the carve-out keeps a post-cut boundary + its summary
  (`isCompactSummary && parentUuid ∈ kept`) when relinked descendants
  are retained, and drops a fully-raw post-cut compaction (arrives as
  live events). interactive-mode: `reloadHistory()` (clears transcript
  state, re-arms the buffer synchronously, get-tree → pathToLeaf → cut
  at `agentState.leafTreeNodeRef`, renders via `renderPathNode` —
  boundary banner or entryToSessionMessage → userText/handleSdkMessage —
  then delivered prompts from `agentState.deliveredMessages`, warning
  only if boundaryMissing with no buffered contextChanged, then release
  with `replayedUuids` set and cleared in a finally); constructor and a
  new `contextChanged` case both call it; the transitional shim is gone.
  Release dedupe sits at the top of handleSdkMessage: user/assistant/
  stream_event/system-compact_boundary messages whose uuid is in
  `replayedUuids` fold but render nothing. sdk-render tests replaced
  with 6 pathUpToBoundary tests (occurrence match, raw drop, carve-out
  order, boundary-without-relinks drop, undefined leaf, missing leaf).
  7. /tree: `src/tui/components/tree-selector.ts` — `resolveTreePick`
  (pathToLeaf to the pick + backwards assistant walk; editorText from
  extractTextContent, omitted when empty) and `TreeSelectorComponent`
  (render(width) override: header, windowed rows via the shared
  flattenVisibleTree + formatTreeNodeLine omitUuid, inverse-video
  selection — theme gains an `inverse` helper — search line, persistent
  setWarning line, "(no matching entries)"; handleInput: up/down wrap,
  page keys, enter → parseTreeNodeRef(row id), escape clears search
  then cancels, backspace, printable chars append; selection recovery
  via nearest visible ancestor over a full-tree parent map).
  interactive-mode: `/tree` first-token interception, openTreeSelector
  (get-tree → selector in statusContainer + focus; pending guard like
  /model), confirmTreePick (busy → hint "cannot navigate tree while
  assistant is busy", selector stays open; else resolveTreePick →
  set-context rewindTo / uuids: [] — close, prefill editorText on
  success, error banner on rejection), contextChanged sets the
  selector's warning, global-escape interrupt suppressed while open.
  autocomplete LOCAL_COMMANDS + `/tree` (3 test expectations updated).
  Tests: 6 resolveTreePick + 9 selector tests (row parity with the
  picker filter incl. relinked occurrence rows, leaf pre-selection,
  enter ref recovery, wrap navigation, search + ancestor selection
  recovery, backspace, escape semantics, zero-row, warning
  persistence).
  Remaining: Anton's review; the manual E2E pass (criteria 1, 4, 6 —
  scripted daemon + two attached TUIs + CLI set-context + /tree picks) has
  NOT been run: it needs a live agent session. Everything remains
  uncommitted on `format`.

- 2026-07-18 (post-implementation reviewer round): the pictl reviewer read
  the working tree against the spec. Adopted: (HC1) the carve-out's
  "post-cut boundary with no retained relinks stays dropped" lost the
  compaction summary — a summary's live `user` event renders no text (the
  sdkMessage user case only resolves tool results), so the summary would
  vanish until the next reload. Post-cut boundaries and raw summaries now
  ALWAYS replay (SPEC bullet updated; buffered banner/summary events
  release-dedupe by uuid; a pre-subscribe event is never delivered, so no
  double render either way); pathUpToBoundary simplified accordingly, test
  flipped. Also adopted: the release-dedupe predicate extracted as
  `releaseDedupeUuid` in sdk-render.ts (pure, unit-tested — the cheap seam
  for the otherwise untestable dedupe). Reviewer's verdict on the
  untested TUI orchestration paths: acceptable with the extracted
  predicate + the manual E2E before merge; a replay-buffer coordinator
  refactor was explicitly not required. Speculative notes (not acted on):
  contextChanged during a pending /tree fetch shows no warning when the
  selector then opens; a system-entry current leaf is pickable via the
  unconditional exemption (leaf eligibility makes this unreachable in
  practice).
- 2026-07-18 (reviewer round 2, both blockers adopted): (1) the always-
  replay reasoning leaned on unproven stream-before-file ordering for
  native compaction events — a banner event arriving AFTER release (once
  replayedUuids is cleared) would render a second banner. Fixed with a
  persistent one-shot `replayedBoundaryUuids` set in interactive-mode:
  populated per replayed banner, consumed by a buffered dedupe hit or by a
  late compact_boundary event (which then renders nothing once); cleared at
  each reload; daemon boundaries emit no event so their entries just
  linger, bounded by the current path. SPEC dedupe bullet updated. (2) HC2
  reclassified from escalate-to-Anton to in-scope: the reviewer showed it
  is reachable through /tree alone (rewind, then immediately rewind to an
  abandoned branch, no turn between), a user-visible violation of this
  spec's history semantics. Fixed narrowly: `SetContextShared` gains
  `freshOverride()` (the request-handlers closure, reused), and both
  boundary-append sites anchor `logicalParentUuid` at a fresh filterTail
  override's `installedAtLeaf.uuid` when one is active, else the file
  chain tip as before — trailing-system-entry anchoring is unchanged. Two
  regression tests (uuids-mode and abandoned-branch-rewind after a
  no-write rewind). Presubmit green, 314 tests. Anton: this daemon change
  went beyond the spec's pinned type design on reviewer insistence —
  please double-check the anchoring rule.

### Implementation-Time Decisions

- **`collectFinalAssistantIds` exported from format/tree.ts** (beyond the
  pinned export list): the picker filter needs per-node `isFinal` and both
  formatSessionTree and the selector need the same tree walk; exporting the
  walk beats duplicating it. Alternative (computing it inside the selector)
  rejected as a copy.
- **`theme.inverse` helper**: the selection highlight needs inverse video;
  the theme module already holds the bold/italic/underline SGR helpers, so
  the highlight lives there rather than as a raw escape in the selector.
- **Release-dedupe placement**: the uuid-skip sits at the top of
  `handleSdkMessage` (not in the release loop) so replay and release share
  one dispatch path; it is inert outside release because `replayedUuids` is
  only nonempty during the release loop (set before, cleared in a finally).
  A buffered `contextChanged` re-entering `reloadHistory` mid-release is
  safe: its synchronous prefix re-arms the buffer, so the rest of the outer
  release feeds the follow-up reload instead of rendering.
- **`renderPathNode` records only rendered uuids**: nodes that
  `entryToSessionMessage` drops (isMeta, sidechain, non-boundary system)
  add nothing to `replayedUuids` — the dedupe predicate is narrowed to the
  four renderable kinds instead, so an unreplayed system event (e.g.
  local_command_output) can never be swallowed by a uuid collision.
- **`/tree` interception matches the first token** (`/^\/tree(\s|$)/`) and
  ignores any argument, mirroring the `/model` token rule; the command
  takes no argument so there is nothing to parse.
- **`resolveTreePick` on an unresolvable pick** (pathToLeaf returns []) falls
  through to `newRoot` — unreachable from the selector (picks come from the
  rendered tree) and total per the spec; no throw path.
