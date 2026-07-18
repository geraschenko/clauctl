# Spec: TUI `/tree` and context-aware history

> Status: **draft.** Follow-up to `docs/specs/session-tree-and-set-context.md`
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
`logicalParentUuid` — so the TUI shows the full logical history (pre-compaction
messages included, each rendered once: relinked `viaBoundary` occurrences are
on the path, their raw occurrences are off-path).

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
- `AgentState.lastTranscriptUuid` becomes `leafTreeNodeRef?: TreeNodeRef` —
  the current leaf *occurrence* of the session tree. Stream user/assistant
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
  synchronous, so an unset leaf (or `--empty`) has nothing to wait for. With
  that, a subscribed client's fetch always contains its snapshot leaf: the
  read-races-a-writer window is structurally closed, not warned about.
- Attach and redraw share one load path, cut at the leaf occurrence
  (`pathUpToBoundary(path, leaf)`, the path-based replacement for
  `historyUpToBoundary`; exact uuid+viaBoundary match). Only *raw*
  occurrences after the match are dropped — those are the entries that
  arrive as live events; `viaBoundary` occurrences always replay (relinked
  entries never stream), so attaching right after a native compaction does
  not truncate the preserved substructure that follows the raw summary node
  on the path. A missing leaf match still replays everything behind the
  existing warning — now a should-never-fire invariant safeguard rather
  than an expected race.
- Double-render protection is dedupe on release: buffered user/assistant
  `sdkMessage` events whose uuid was already rendered from the path are
  folded into `agentState` but not rendered again — the flush-synced read
  may include entries newer than the snapshot leaf, which are also in the
  buffer. (A dequeue-rendered prompt racing into the tree read has no uuid
  to dedupe on — accepted, same class as the attach-time missing-boundary
  window.)
- Attach race semantics otherwise unchanged: delivered-but-unconfirmed
  prompts append after the replayed path; buffered live events release
  afterwards.
- A `contextChanged` that arrives while a reload is in flight lands in the
  live-event buffer and triggers a follow-up reload when released.

### `/tree` command

- Intercepted locally like `/model` (exact first token `/tree`, no argument)
  and listed in the autocomplete `LOCAL_COMMANDS`.
- Opens a `TreeSelectorComponent` over the `get-tree` response (statusContainer
  + focus, like the model selector; `get-tree` failure → error banner, no
  selector). Modeled on pi's `TreeSelectorComponent`, with rows rendered as
  `clauctl format tree` renders them (`flattenVisibleTree` +
  `formatTreeNodeLine`) minus the entry uuids (useful for copy-paste in the
  CLI, distracting in a picker; `formatTreeNodeLine` gains an `omitUuid`
  option) plus a selection highlight — shared code, not a copy.
- **Fixed visibility filter** (no filter cycling): user entries with text,
  final assistant entries (`isFinalAssistantEntry`) with text,
  `compact_boundary` markers, and the current leaf unconditionally.
  Restricting assistants to final entries makes every assistant row a valid
  `rewindTo` target. The predicate also becomes a new `format tree` filter
  mode (`FILTER_MODES` gains `"picker"`), so the CLI can render exactly the
  picker's rows (uuids included there) and the predicate has one shared,
  testable home.
- **Search**, pi's UX: printable characters append to a query shown below the
  tree, backspace edits it, tokens AND-match case-insensitively against the
  rendered summary line, matching re-runs the visible-structure recalculation.
  Escape clears the search if one is active, otherwise cancels the selector.
- **Navigation**: up/down with wrap-around, page up/down, enter confirms,
  escape cancels (per above). Initial selection = the current leaf. Vertical
  windowing around the selection.
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
— picking a message *within* a boundary's relinked context must rewind within
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
  post-boundary write attaches to the *relinked occurrence* under the
  boundary, not the raw node ("post-boundary entries and later boundaries'
  anchors land on relinked nodes").
- For an up_to-shaped original boundary the effective chain *starts* with
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
`viaBoundary ?? uuid`; get-messages-override freshness compares refs.

**`src/core/sdk-socket.ts`**

```ts
| { type: "set-context"; rewindTo: TreeNodeRef }   // rewind variant
```

`parseSetContextRequest`: `rewindTo` must be a record with uuid `uuid` and
optional uuid `viaBoundary`; empty `uuids` arrays pass. The `contextChanged`
event gains `leaf: TreeNodeRef | null` — the file-truth effective tip after
the change (null for an empty context), computed via `effectiveTreeNodeChain`
where each path already re-reads the file.

**`src/core/daemon/set-context.ts`** — `handleRewind(rewindTo: TreeNodeRef,
context)` computes `desired` per the occurrence rule above (calls
`effectiveChain` on the truncated file either way); the empty-uuids guard in
the request handler is removed. Ordering constraint: the get-messages
override is installed with `installedAtLeaf` = the POST-change leaf ref (the
same ref the `contextChanged` event carries) — installing the pre-change ref
would make the override look stale the moment the event folds.

**`src/core/daemon/request-handlers.ts` / `get-messages.ts`** — every
session-file read is flush-synced: get-messages switches from
`readSessionEntries` to `readEntriesAfterStreamFlush` (get-tree/get-entries
already are), keyed on `leafTreeNodeRef.viaBoundary ?? .uuid`; the
`freshOverride` staleness check compares leaf refs.

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
gains `"picker"`, and `passesFilter` gains an `isFinal: boolean` input for
the final-assistant restriction (computed by callers via
`isFinalAssistantEntry` over the TreeNode tree, alongside `isCurrentLeaf`).

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
  constructor(tree: SessionTree, onSelect: (pick: TreeNodeRef) => void, onCancel: () => void);
  handleInput(data: string): void;
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
   compacted" banners at boundary crossings and pre-boundary messages
   included.
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
   `"picker"` filter mode; selector filter/search/navigation and
   the contextChanged-while-open banner; the contextChanged redraw and
   tree-based attach (interactive-mode level, as far as the existing TUI
   test seams allow).

### Edge cases

- `get-tree` fails or no session yet → `/tree` shows an error banner;
  attach/redraw shows the existing "history fetch failed" banner.
- Empty session (`leaf: null`) → empty path, empty transcript; `/tree` shows
  only whatever roots pass the filter (possibly nothing) with nothing
  selectable.
- A `contextChanged` arriving while the selector is open immediately shows a
  warning banner ("context changed while the tree selector is open") — the
  attached user must know some other process is changing the context under
  them. The selector stays open with its now-stale tree (not auto-refreshed
  or closed); the transcript redraw proceeds underneath. A stale pick cannot
  be *invalid* (the file is append-only) and the daemon re-validates anyway;
  the banner lets the user cancel or pick differently in light of the
  change.
- `effectiveChain` of a file ending in a bare empty-uuids boundary is `[]`
  (pinned by a test) — set-context verification and the redraw (empty path
  from the boundary-rooted leafless tree) both rely on it.
- A user pick whose text is empty (shouldn't pass the filter) → no action.
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
- Any change to `get-messages`: it tells the caller exactly which messages
  are in the assistant's _current_ context, which remains important; the TUI
  just stops using it for transcript rendering.

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
  leaf visible under filters; decide in implementation whether search also
  exempts it — pi does not).
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
  the render dispatch for `sdkMessage` events whose uuid is in the set
  (fold-always, render-once).
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
