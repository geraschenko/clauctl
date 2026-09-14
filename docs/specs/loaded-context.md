# Loaded context truth, preserved-uuids normalization, and parallel-call display

> Status: **implemented; the per-request rebuild described here is replaced by the rolling builders of docs/specs/session-tracker.md.**

Successor to the retired work queue (next.md); derisk evidence lives in
docs/derisk/compact-boundary-injection/FINDINGS.md (probe ids like p18,
p19 cite it) and the loader model in docs/specs/session-tree.md.

# SPEC

## Problem statement

Three connected gaps, all rooted in `loadedContext` stopping at stage 2
of the CLI's five-stage load pipeline (relink + cut + walk):

1. **loadedContext under-reports.** It omits stage 3 (parallel-group
   expansion: the walk loses off-path results and calls of native
   parallel tool turns) and stage 4 (resume sanitization: result-less
   tool_use entries and thinking-only turns are dropped). Its answer
   therefore diverges from what the assistant actually sees, for every
   consumer: set-context verification, get-messages synthesize, seed,
   get-entries, tree-selector.
2. **set-context accepts preserved lists the loader will silently
   mutilate.** A list splitting a tool call from its result presents a
   context missing the pair (or patched by the CLI with a synthetic
   error result, p12); the caller learns nothing. Separately, the duplicate-uuid
   rejection's error message states a falsehood ("the loader silently
   skips the whole relink" — p14 disproved this: the rewrite runs
   unchecked and functionally deletes messages).
3. **The TUI loses parallel calls in history.** Live parallel calls
   render fine; after detach/reattach, `pathToLeaf` over the raw parent
   structure follows one branch and drops the other call + result
   (fixture: scripts/tui-parity/out/sessions/readonly-fold.jsonl).

## Desired behavior

- `loadedContext` means: **the entries the assistant will see on its
  next turn**, modeled at entry granularity — stages 1–4 of the
  pipeline. Stage 5 (wire normalization: adjacent-user merge, same-id
  regrouping, cross-model thinking strip) stays out of scope: it
  reshapes API messages, not which entries are present.
- set-context **normalizes** preserved lists (terminology: "normalize"
  — it both completes mismatched tool call/result pairs from the file,
  reporting what it added, and **fail-closed rejects** lists whose
  presented context would silently diverge from the list in a way
  completion cannot fix). Rejection philosophy: if the caller really
  wants an entry dropped, they should use a shorter list that
  omits it explicitly — silent acceptance followed by a silent loader
  drop confuses users.
- The TUI display tree linearizes parallel-call groups onto the spine
  in **strict chronological (file) order** (see
  docs/thoughts/tree-presentation.md), so `pathToLeaf` (name kept)
  shows both calls and both results. Display order and loader
  presentation share the group-collection code but deliberately
  differ in ordering: the display shows write-time truth; the loader
  mirrors the CLI's splice (see Edge cases). This spec does NOT
  implement the tree-presentation doc (renderdag, whole-tree
  chronological presentation) — it only linearizes parallel call
  groups in a way consistent with it.

## Concrete examples

readonly-fold.jsonl turn `xbYKZyKk` (raw): thinking → callA; callB is a
child of callA; resultB (written first) is a child of callB; resultA
(written last) is a child of callA; the continuation parents on resultA.

- Today `loadedContext` returns `[…, thinking, callA, resultA, …]`.
  After this spec: `[…, thinking, callA, callB, resultB, resultA, …]`
  (the recovered block splices after the group's last on-chain
  assistant entry — verified `Aer` behavior). The last element of the
  whole chain is unchanged.
- Today the TUI history after reattach shows one call. After: both
  calls and both results, in the order above.
- `set-context --uuids […, callA]` where resultA exists in the file:
  normalized to `[…, callA, resultA]`, result reports
  `added: [resultA]`.
- `set-context --uuids […, callA]` where the turn was killed and no
  result exists anywhere: **rejected** — the loader would drop the call
  entry; omit it explicitly instead.
- `set-context --uuids […, thinkingOnly]` including a group's thinking
  entry but no non-thinking sibling of that group: **rejected** — the
  loader drops thinking-only turns whole (p19).
- Duplicate uuid in the list: **rejected**, with the real
  mechanism in the message (see Edge cases).

## Success criteria

1. `loadedContextUuids(readonlyFoldEntries)` contains callB and resultB
   in the splice order above; the chain's last element equals the
   file's last user/assistant entry (`.at(-1)` leaf invariant).
2. Unit tests (node --test) cover: splice position and ordering;
   result-less tool_use entry dropped (p20 shape); thinking-only turn
   dropped (p19 shape); single-call and interleaved same-id turns pass
   through untouched.
3. `normalizePreservedUuids` unit tests: completion adds the missing
   half adjacent to its partner and reports it; each of the four reject
   cases returns a reason naming the mechanism.
4. set-context verification succeeds for normalized lists: for a
   normalized list, expansion adds nothing and sanitization drops
   nothing, so effective = normalized list (+ summary entry per
   anchor).
5. `pathToLeaf` over `toDisplayTree(readonly-fold)` includes callB and
   resultB rows; the tui-parity harness renders both calls.
6. `tsc` clean; full test suite passes.

## Type design (approved 2026-08-31)

```ts
// src/core/tree/loader.ts

/** The group-collection maps both expansion and the display tree
 *  build from the same code: all assistant entries per message.id,
 *  and the tool_result user children per call entry. Values are
 *  uuids: byUuid stays the single store of entry payloads, and both
 *  consumers already hold it. */
export interface ToolGroupMaps {
  assistantsByMessageId: Map<string, UUID[]>;
  resultsByCallUuid: Map<UUID, UUID[]>;
}
export function toolGroupMaps(entries: SessionEntry[]): ToolGroupMaps;

/** Stage 3, mirroring the binary's Aer exactly: for each API-message
 *  group with an on-chain member, splice the missing same-id assistant
 *  siblings (timestamp-sorted) then the missing tool_result children
 *  of all group members (timestamp-sorted) immediately after the
 *  group's last on-chain assistant entry. On-chain refs keep their
 *  positions and their viaBoundary; recovered entries enter as bare
 *  `{uuid}` refs (they are never boundary-preserved). Entry payloads
 *  (type, message.id, tool blocks, timestamps) come from byUuid. */
export function expandParallelToolGroups(
  chain: TreeNodeRef[],
  byUuid: Map<UUID, SessionEntry>,
): TreeNodeRef[];

// loadedContext: signature UNCHANGED —
//   (entries: SessionEntry[], onInvalid: OnInvalid) => TreeNodeRef[]
// pipeline becomes: relink + cut → walk → expandParallelToolGroups →
// sanitize (private helper, also over TreeNodeRef[] + byUuid).
// Sanitize, entry-level, in order: drop assistant entries whose
// content is only tool_use blocks none of which has a tool_result
// anywhere on the expanded chain; then drop groups reduced to
// thinking-only entries.
```

```ts
// src/core/daemon/set-context.ts (co-located with its only caller)

export type NormalizePreservedUuidsResult =
  { ok: true; uuids: UUID[]; added: UUID[] } | { ok: false; reason: string };

/** Normalize or reject a requested preserved list against the file. Checks
 *  in order: relink validity — duplicates and uuids naming no file
 *  entry — by DELEGATING to the loader's invalidRelinkReason on the
 *  boundary shape about to be written (one implementation, no
 *  redundant check; the rejection message wraps the reason with the
 *  duplicate-clobbering rationale); tool pairing (complete from the
 *  file: missing result inserted immediately after its call, missing
 *  call immediately before its result; either half nonexistent in the
 *  file → reject); thinking-only groups after completion (reject).
 *  Called by the uuids-mode handler before buildBoundaryEntries; the
 *  handler's pre-gate duplicate and missing-uuid checks are removed. */
export function normalizePreservedUuids(
  requested: UUID[],
  byUuid: Map<UUID, SessionEntry>,
): NormalizePreservedUuidsResult;
```

```ts
// src/core/sdk-socket.ts
export interface SetContextResult {
  boundaryUuid?: UUID;
  summaryUuid?: UUID;
  /** Uuids normalization inserted into the preserved list (uuids mode only;
   *  omitted when nothing was added). */
  added?: UUID[];
}
```

`toDisplayTree(fullTree, entries): DisplayTree` — signature unchanged.
New internal rule 4 (parallel-group linearization), applied per
API-message group, built on `toolGroupMaps`. No spine/exit
classification:

- The group = all assistant entries sharing the message.id plus the
  tool_result children of any of them. Linearize the group in
  **strict chronological (file) order**: the first element keeps its
  raw display parent, each later element parents onto its
  predecessor.
- Any child of a group tool_result that is outside the group
  reparents onto the group's last element. (Children of non-result
  group members keep their raw parent: a branch forked off a call is
  still a fork.)
- Already-chronological groups (single-call turns, interleaved
  same-id turns) come out identity. A genuine user fork off two
  different results flattens to two siblings hanging off the group's
  last element — acceptable; mid-group forks are not producible by
  set-context (rewindTo targets final entries only).

`pathToLeaf` keeps its name; per the PathNode re-evaluation it now
returns `TreeNodeRef[]` (missing-entry validation retained):

```ts
// src/core/tree/nodes.ts
// PathNode is DELETED — path/render code deals in TreeNodeRef[] plus
// a byUuid lookup, entries only where rendering needs the payload.
// Naming standard: the uuid → SessionEntry map is `byUuid:
// Map<UUID, SessionEntry>` everywhere; the function-valued `entryOf`
// params are replaced by the map itself (every caller already holds
// one, the indirection bought nothing).
export function pathToLeaf(
  parentMap: ParentMap,
  byUuid: Map<UUID, SessionEntry>,
  leaf: TreeNodeRef | null,
): TreeNodeRef[];

// src/tui/sdk-render.ts — same shape swap; the boundary/summary
// filter looks entries up in byUuid.
export function pathUpToBoundary(
  path: TreeNodeRef[],
  byUuid: Map<UUID, SessionEntry>,
  leafNode: TreeNodeRef | undefined,
): { nodes: TreeNodeRef[]; boundaryMissing: boolean };

// src/tui/transcript.ts: appendPathNode(node: PathNode) becomes
// appendEntry(entry: SessionEntry) — it only ever read node.entry.
// interactive-mode's renderPathNode wrapper likewise takes the entry.
```

`SessionSnapshot` stays as-is: `entries: SessionEntry[]` is the RPC
wire shape; consumers derive their `byUuid` map locally (a Map does
not serialize).

## Data flow

- **loadedContext**: file entries → relink + cut → walk (TreeNodeRef
  chain) → expandParallelToolGroups (refs in, refs out; entry payloads
  via byUuid) → sanitize → return.
- **set-context (uuids mode)**: requested uuids →
  normalizePreservedUuids → reject (error to caller, nothing written)
  | normalized list →
  buildBoundaryEntries(normalized) → append →
  restartAndVerify(normalized [+ summary]) → result carries `added`.
- **set-context verification**: unchanged code path; it compares
  effective `loadedContext` against expected — both sides now speak
  stage-1–4 truth, so native parallel turns after the boundary no
  longer produce spurious mismatches.
- **TUI**: get-entries chain and snapshot.leaf come from the truer
  loadedContext (`.at(-1)` invariant holds — see Edge cases);
  reloadHistory: buildTree → toDisplayTree (rule 4) → pathToLeaf shows
  the linearized group.

## Cost

- Two O(n) map builds (byUuid already exists; message.id groups,
  results-by-parent) per loadedContext call and per toDisplayTree call.
  Both run on every get-entries/reload; n = file entries. Negligible
  next to the file read, no new persistent state.
- normalizePreservedUuids: O(list × file) worst case with naive lookups;
  implement with the same prebuilt maps to stay O(n).

## Edge cases

- **`.at(-1)` leaf invariant** (why TreeNodeRef[] needs no leaf
  machinery): Aer splices after the group's last on-chain _assistant_
  entry, before any on-path result that follows. A recovered entry
  could only trail the walk tip if the tip were a group assistant with
  later off-path results in the file — impossible, results are written
  after calls, so the tip would be a result. Post-cut preserved lists are
  relinked linearly (no off-path members), so recovery only touches
  post-boundary native turns where that argument applies.
- **Interleaved same-id turns** (call → result → call, one message.id,
  observed in real sessions): fully on-chain, so expansion is a no-op,
  and chronological linearization reproduces the existing chain. Order
  preserved.
- **Display order vs loader presentation diverge within a turn, by
  design**: the loader (Aer) keeps on-chain positions and splices the
  whole recovered block after the group's last on-chain assistant; the
  display shows strict file order. Example (five parallel Bash calls,
  session 75e1): later calls parent onto whichever results already
  arrived, so calls and results interleave chronologically — the
  loader presents the two recovered results late (after the last
  call), the display shows them where they happened. Calls-then-
  results ordering was rejected because it can reverse the original
  graph direction. For clean parallel turns (readonly-fold) the two
  orders coincide.
- **Duplicates rejection message** (and the loader.ts comment at the
  `invalidRelinkReason` duplicate check): state the mechanism — the
  relink rewrites parents sequentially over a uuid-keyed map, so a
  repeated uuid clobbers its earlier reparenting; the list prefix
  before the duplicate's second-to-last occurrence is functionally
  deleted and the remainder is left with a parent cycle (p14: the
  summary vanished from the wire). A duplicate can never mean "this
  message twice". Tell the caller: if that deletion is what you want,
  send the shorter list explicitly.
- **Sanitization can shorten the chain's tail**: a file whose last turn
  was killed mid-parallel-write ends in result-less call entries;
  stage 4 drops them, so `.at(-1)` reports the effective context tip,
  which may predate the raw file tip. That is the truth every
  consumer of loadedContext wants (the dropped call is not in
  context); where the CLI's _next write_ parents is a file-domain
  question and unchanged by this spec. Consequence: get-entries
  snapshot.leaf and seed's leaf move off the dangling call for such
  files.
- **Mixed-content entries** (text + result-less tool_use in ONE entry —
  not a shape the CLI writes, one block per assistant entry): the CLI
  drops the dead block and keeps the text; our entry-granularity model
  keeps the whole entry. Known approximation, entry granularity cannot
  express a block-level drop.
- **Result-less call in a preserved list whose result exists in the file**:
  completed, not rejected — the caller's intent (the call in context)
  is satisfiable.
- **Sanitize scope**: sanitization applies to loadedContext's view of
  any file (killed turns exist on disk); normalizePreservedUuids's
  rejections guarantee set-context never _creates_ a preserved list relying
  on those drops.
- **Same-id closure is NOT normalization's business** (p20-part1):
  excluding a text or thinking sibling while keeping a call+result is
  legal and presented as such; normalization touches only call/result
  pairs, whose split presentation is meaningless.

## Non-goals

- Stage 5 wire normalization (user-merge, regrouping, thinking strip)
  in loadedContext.
- Rendering set-context uuids-mode boundaries specially in the display
  tree (docs/thoughts/set-context-boundary-display.md, separate work).
- The deferred backlog carried below (TUI live context-changed marker,
  probes-as-regression-suite, blog corrections).
- Renaming pathToLeaf (considered, rejected — display-tree expansion
  makes it return the right history under its current contract).

# IMPLEMENTATION IDEAS

- toolGroupMaps runs once per loadedContext/toDisplayTree call;
  expansion mirrors Aer's first-seen-id dedupe and its "recovered set"
  guard so a group splices once.
- Aer subtlety to mirror: the splice anchor is the _last_ on-chain
  assistant with the id (Aer's `u` map overwrites in chain order).
- Timestamp sorts use `localeCompare` on the ISO strings, as Aer does.
- set-context.ts's pre-gate duplicate check (with its stale "silently
  skips the whole relink" message) and the "uuids not in the session
  file" check are removed in favor of normalizePreservedUuids, which needs
  the gated entries read anyway; loader.ts's invalidRelinkReason
  duplicate comment gets the corrected rationale (resolving its TDC).
  Side effect: preserved-list errors now surface after the
  idle-eligibility check instead of before it.
- restartAndVerify's `expected` becomes the normalized list; the
  summary-uuid splicing logic is unchanged.
- TDC cleanup while implementing: nodes.ts (SessionSnapshot — answered:
  stays the wire shape; PathNode — deleted; pathToLeaf — returns
  refs), transcript.ts / interactive-mode.ts (take SessionEntry).
- entryOf → byUuid standardization touches every entryOf site:
  tree-selector, format/tree, interactive-mode, nodes (+ tests).
- Verify against the tui-parity harness (safety: isolated config
  copies, no bypassPermissions, never commit sessions).

## Deferred backlog (carried from the retired next.md)

- **TUI after set-context** (observed 2026-08-29,
  /tmp/claude-tui-too-many-oks{,2}): live "context changed" marker
  when set-context rewrites context under an attached TUI (today it
  appears only after detach/reattach); render the effective
  post-boundary context via the same loader code — no UI-specific
  reimplementation. Related TDC in display-tree.ts (show
  boundaries' `@boundary` rows for explicit-uuids set-context).
- **Blog corrections** (geraschenko.com claude-context): loader is not
  a pure parent walk (expansion), relink details
  (last-boundary-only, cut, abort-untouched), request-time merge —
  last, after the implementation settles.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] Derisk (2026-08-31): pipeline description reviewer-approved;
      continuation-parent rule resolved by evidence (parents on the
      last-WRITTEN result — readonly-fold vs both real sessions,
      discriminating cases in FINDINGS §3); Aer splice position
      source-traced (recorded in FINDINGS §3), `.at(-1)` invariant
      established; type design approved.
- [x] Review round (2026-09-01, 00fb295): "heal" → "normalize";
      expansion refs-based; calls-then-results ordering rejected for
      strict chronological display order (5-Bash session 75e1,
      docs/thoughts/tree-presentation.md); spine/side classification
      dropped for the simple linearize-and-reparent rule; duplicate check
      in ONE place (normalizePlaylist delegates to invalidRelinkReason);
      PathNode dissolution folded in; display-tree TDC moved to
      docs/thoughts/set-context-boundary-display.md.
- [x] Review round (2026-09-01, 5f66ea5): three-views distinction
      documented in docs/session-views.md (+ src/core/tree/AGENTS.md
      pointer, overview.md doc map); rewind-and-append expansion recorded
      in docs/thoughts/set-context-boundary-display.md; ToolGroupMaps
      values → uuids; standardized on `byUuid` maps over `entryOf`
      functions; tree-presentation non-implementation noted inline.
- [x] Stubs: toolGroupMaps, expandParallelToolGroups,
      normalizePlaylist, SetContextResult.added; compile. (The pathToLeaf
      signature change moved to the PathNode-dissolution step — it cannot
      compile without its callers adapting, which IS that step.)
- [x] loadedContext stages 3+4 with unit tests. Recovery universe =
      entries surviving the cut (deleted() excluded), which is what makes
      p20-part1 exclusion work; verified splice order and `.at(-1)` on the
      real readonly-fold.jsonl.
- [x] normalizePlaylist + set-context wiring (incl. both stale
      duplicate comments/messages) with unit tests. Helper predicates
      (isToolCallEntry, isToolResultEntry, isThinkingOnlyEntry) exported
      from loader.ts so normalization and sanitization share one notion of
      the entry shapes; synthetic anchor uuid feeds invalidRelinkReason
      (buildBoundaryEntries mints a fresh anchor, so anchor-in-uuids is
      unproducible); end-to-end split-pair completion test proves
      verification success (criterion 4).
- [x] toDisplayTree rule 4 with unit tests. Overrides live beside rule 1
      in the shared parentOf relation (rule 1 wins for boundary rows); the
      display-tree test builder needed unique per-entry API message ids —
      the old shared "msg_x" made unrelated turns one rule-4 group.
- [x] PathNode dissolution across tui/sdk-render + TDC comment cleanup.
      pathToLeaf returns TreeNodeRef[] (missing-entry validation retained);
      pathUpToBoundary takes byUuid; appendPathNode → appendEntry(SessionEntry);
      entryOf → byUuid everywhere (incl. scripts/tui-parity/render-session.ts,
      found only at compile time — not in the original call-site inventory).
- [x] tui-parity check on readonly-fold. Both parallel groups' calls and
      results are on the display path; the direct render now shows the Glob
      call the pre-rule-4 capture dropped ("used Grep 1 time, used Glob 1
      time" vs claude's "searched for 2 patterns" — same calls, fold phrasing
      differs, a rendering-parity concern outside this spec).
- [x] Review round (2026-09-01, 84b5e04): "playlist" terminology retired
      for the established "preserved uuids" (normalizePlaylist →
      normalizePreservedUuids, result field `playlist` → `uuids`; the
      spec body above renamed to match, so future spec drafters don't
      inherit the coinage — older work-log entries keep it as session
      history);
      normalize restructured as validate-then-place with insertion-ordered
      Sets (recursive `place` pulls in only non-requested pair halves, so
      complete lists pass through verbatim); killed-turn rejection reports
      toolu ids via new loader.toolCallIdsOf; resultsByCall →
      resultsByCallUuid; display rule 4 extracted to
      linearizedGroupParents (rule4Parent/fileIndexOf renamed, entry
      passes merged); loader header enumerates stages and points at
      FINDINGS "The load pipeline"; probe-id references ("; see file
      comment") and no-minified-names audits done; review patterns
      recorded in AGENTS.md (Naming and References).
- [x] Probes as an SDK-upgrade regression suite (2026-09-01): kept
      check-reports.mjs as the single assertion site and added
      run-suite.mjs (ordered probe runner + check-reports, nonzero exit);
      harness asserts installed SDK == package.json pin instead of a
      hand pin, seeds onboarding from ~/.claude.json (the /tmp template
      was lost on reboots), writes copied credentials 0600; p0b's
      native boundary+summary shape now asserted; p4 q8 verifies each
      setup write and aborts with a "fixture setup failed" message so a
      model flake cannot masquerade as loader drift; the suite is a
      standing approval-gated step of skills/update-claude-agent-sdk.
