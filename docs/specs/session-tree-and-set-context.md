# Session tree reading and context setting

# SPEC

## Problem statement

clauctl needs to expose the session transcript's full tree structure and let a
caller reshape the agent's effective context (rewind, branch switch,
compaction with caller-authored summary). The mechanism was derisked in
`docs/derisk/compact-boundary-injection/` (FINDINGS.md): appending a synthetic
`compact_boundary` (+ optional summary) entry to the session jsonl and
restarting the SDK `Query` deterministically controls which messages the model
sees. This spec adds three RPC commands to the daemon socket and matching
`clauctl` subcommands:

- `get-entries` — every jsonl entry of the current session, verbatim.
- `get-tree` — the session as a forest with boundaries resolved.
- `set-context` — reshape the effective context and restart the `Query` so it
  takes effect. Two modes: **boundary mode** (append a boundary + optional
  summary; arbitrary uuid playlists) and **rewind mode** (`--rewind-to
  <uuid>`: the final entry of any assistant API message in the session file;
  context becomes what it was when that message first appeared). Rewind mode
  is a semantic, not a mechanism: it
  uses the SDK's `resumeSessionAt` when that suffices and falls back to
  appending a no-summary boundary when it doesn't (see Concrete examples).

`get-messages` (already shipped) remains the "effective context" read.

## Background: boundary mechanics (documented here per derisk findings)

- On resume, the CLI loader picks the active leaf (last chain entry in file
  order) and walks `parentUuid` to the root. A `compact_boundary` entry in
  that chain triggers a **load-time relink**: `preservedMessages.uuids[0]` is
  re-parented onto `anchorUuid`, each `uuids[i]` onto `uuids[i-1]`. Purely in
  memory; on-disk entries keep their original parents. `uuids` is an ordered
  list, followed verbatim (non-contiguous subsets and arbitrary order are
  honored).
- `anchorUuid` is the graft point. Native boundaries use exactly two values:
  the summary entry's uuid ("up_to" shape: context = summary, then `uuids`) or
  the boundary's own uuid ("from" shape: context = `uuids`, then summary). In
  from-shape the chain ends with an unanswered user message, so at the first
  subsequent turn the CLI synthesizes and persists a `"No response requested."`
  assistant entry to restore turn alternation.
- Native `/compact` sends a normal inference request (current context + an
  instruction block appended to the last user message), then writes a boundary
  (up_to shape, machine-chosen `uuids` = a small recent tail) and a summary
  user entry flagged `isCompactSummary: true`. **Neither the summarization
  instruction nor the raw API response is ever persisted** — the summary user
  entry is the only artifact. Consequence: `/compact` cannot be reproduced
  through the SDK alone (every SDK request/response pair persists user and
  assistant entries); reproducing it requires jsonl editing, which is what
  `set-context` does with caller-supplied text.
- The turn's final assistant entry reaches disk ~100–180 ms *after* the SDK
  `result` message. Safe mutation lifecycle (proven, 12/12 hard-asserted
  cycles): turn result → leaf entry on disk (fs.watch + uuid predicate) → end
  the prompt stream → await generator completion (SDK cleanup awaits child
  exit) → append → resume.

## Success criteria

1. `clauctl get-entries` (and the socket command) returns every line of the
   session jsonl as parsed JSON, order preserved, fields untouched (unknown
   fields included).
2. `clauctl get-tree` returns a forest built from raw `parentUuid` edges,
   with each boundary node additionally attached as a child of its
   `logicalParentUuid` entry. On a fixture with one branch point and one
   boundary: both branches appear; the boundary hangs under the last
   pre-compaction message; the summary appears under the boundary (its raw
   parent). Entries without a `uuid` (`file-history-snapshot`,
   `queue-operation`) get no tree node — they remain visible via
   `get-entries`. Boundary relink substructure (duplicate nodes,
   `viaBoundary`) is NOT built in this spec — `buildTree` ships the raw
   forest only; a follow-up spec pins down the substructure.
3. `clauctl set-context <uuids...>` on an idle daemon: appends the boundary
   (+ summary when `--summary` given), restarts the `Query` resuming the same
   session id, and afterwards `get-messages` returns exactly the new effective
   context (summary if any + the listed messages — modulo the documented
   whole-API-message granularity: `getSessionMessages` includes same-message
   sibling entries; see FINDINGS.md P8). The next turn's user entry
   parents onto the last uuid of the list (up_to/no-summary) or the synthetic
   assistant (from-shape). This exactness is promised only for playlists that
   keep whole API messages together and form a valid sequence (the documented
   authoring rule); strange playlists (orphan tool blocks, attachment uuids)
   are silently normalized by the CLI at inference time (FINDINGS.md failure
   modes). The post-restart verification is structural — the loader's relink
   recomputed over the re-read file — so it catches torn or failed appends
   but NOT that inference-time normalization (no file-reading oracle can:
   `getSessionMessages` reads the same file). Authoring-rule compliance is
   the caller's responsibility.
   Mechanism note (discovered at implementation time): `getSessionMessages`
   alone does NOT deliver this — its chain selection picks the user/assistant
   leaf with the largest file index across all dangling leaves, so for any
   playlist whose tip predates another leaf in file order (branch switch,
   resurrecting a summarized region) it reports the wrong chain until the
   first post-boundary transcript write lands (verified: after that write it
   agrees with the loader again). During that window — boundary appended, no
   user/assistant entry yet — the daemon SYNTHESIZES the get-messages
   response from the session file: the expected chain (already computed for
   verification) mapped to SessionMessage shape. The window state is tracked
   in the daemon (installed on a durable boundary append, cleared when
   `lastTranscriptUuid` changes or a later set-context replaces it) and
   reconstructed once at daemon startup by reading the session file (last
   boundary has no post-boundary user/assistant entries besides its own
   summary → synthesize), so a restart inside the window stays correct.
   Unlike the superseded-tail filter, this state is file-derivable — hence
   startup reconstruction works here but not for no-write rewinds.
4. `set-context` with a uuid not in the file fails with a clear error and does
   not restart the query.
5. `set-context` while the assistant is busy fails with a clear error (caller
   can `wait-idle` first).
6. Existing daemon behavior (event stream, queueing, get-messages) works after
   a `set-context` restart.
7. A successful `set-context` (both modes, including no-write rewinds)
   broadcasts a `contextChanged` event on sdk.sock carrying the request, so
   watchers (e.g. an attached TUI) know to re-read — mirroring how
   `controlApplied` is broadcast in `src/core/daemon.ts`. It is a separate
   `SdkEvent` variant: `SdkControlMutation` stays reserved for controls the
   real SDK supports, while `set-context` is a method we wish the SDK had.
   The event is also broadcast when the file was mutated but the subsequent
   Query restart failed — watchers track file truth; the RPC caller gets the
   restart error.
8. `clauctl set-context --rewind-to <uuid>` on an idle daemon accepts the
   uuid of any assistant entry that is the FINAL transcript entry of its API
   message (no later sibling with the same `message.id` — a thinking entry's
   uuid is rejected; validated before teardown); afterwards `get-messages`
   returns the context as it was when that message first appeared: walk
   `parentUuid` from the target, applying the effective-parent map of the
   last boundary that PRECEDES the target in file order — boundaries after
   the target don't exist yet from the target's point of view. (Equivalently:
   what the loader would produce for the file truncated just after the
   target.) So rewinding to a post-compaction message keeps its summary;
   rewinding to a boundary playlist member follows raw ancestry — the
   summarized region comes back. When the desired chain is a truncation of
   the current active chain, nothing is written to disk (`resumeSessionAt`)
   and the daemon records the superseded tail (the uuids of the active-chain
   entries after the target); `get-messages` filters those out of its output.
   No clearing event is needed: once the next turn writes a new leaf, the
   active chain no longer contains the superseded entries and the filter is
   inert. Filter lifecycle: installed/replaced only when a no-write restart
   SUCCEEDS; cleared when a later set-context durably appends a boundary
   (even if that restart then fails — the file now carries the truth);
   requests that fail without mutating the file or establishing a new Query
   leave it unchanged. Otherwise a no-summary
   boundary is appended. Known limitation: a no-write rewind is not durable
   until the next turn — if the daemon exits before then, a later resume sees
   the un-rewound chain.

## Concrete examples

```bash
# Rewind: keep only the first turn (whole API messages), no summary
clauctl set-context 815b1fad… 54a37d1c… 309f0cfc… c8afccff… 59e71878… 64aae3ff… 87c8b882… 5c67b617… 7844a932…

# Branch switch: uuids spanning the target branch's chain, no summary
clauctl set-context <chain of branch B uuids...>

# Compaction with caller-authored summary (summary first, like /compact)
clauctl set-context <recent tail uuids...> --summary "Earlier we set up the build; the failing test is X."

# Keep prefix, summarize the discarded suffix (from-shape)
clauctl set-context <prefix uuids...> --summary "Then we explored Y (abandoned)." --anchor boundary

# Rewind within the active chain: no summary, no file mutation
clauctl set-context --rewind-to <assistant uuid>

clauctl get-entries   # raw jsonl entries
clauctl get-tree      # resolved forest
```

Rewind semantics: "rewind the context to what it was when this message FIRST
appeared" — run loader semantics on the file as it stood when the target was
written, i.e. truncated just after the target. This is the only
well-specified reading: the alternative "truncate the effective chain, keeping
boundary effects" breaks down once a uuid sits on multiple boundary playlists
(which boundary's view wins?), whereas file position is unique. Callers who
want a specific boundary's view of a message address it through that boundary
(boundary mode with a playlist prefix, P9 b).

Computing the desired chain needs no tree: find the last `compact_boundary`
entry that precedes the target in file order. If none, the chain is the raw
`parentUuid` walk from the target. Otherwise build that boundary's effective
parent map and walk from the target taking mapped parents first, raw
`parentUuid` otherwise. The map, covering both anchor shapes:

- `uuids[i] → uuids[i-1]`; `uuids[0] → anchorUuid`.
- From-shape only (`anchorUuid` = the boundary's own uuid, summary present,
  playlist non-empty): the summary's effective parent is `uuids[last]` — the
  raw chain there runs summary → boundary and would skip the playlist
  entirely, but the loader's from-shape context is `[uuids…, summary]`
  (p2.b: prefix first, summary after). Post-boundary writes chain through
  the synthetic "No response requested." assistant → summary, so this rule
  is what carries a from-shape walk across the playlist. With an empty
  playlist the summary keeps its raw parent (the boundary) — the intended
  summary-only context.
- The boundary entry itself is transparent: a system entry, not part of the
  message context; reaching it (or an entry with no parent) ends the walk.

A raw walk alone is NOT correct in either shape: up_to post-boundary entries
parent onto the preserved tail, never onto the boundary (every experiment's
`firstNewUserParent` = the tail), so a literal raw walk from a
post-compaction message would resurrect the summarized region. Only the last
preceding boundary applies (stacked boundaries: last wins entirely, P3 m5).

The SDK option that exists, `resumeSessionAt`, implements something narrower —
truncation of the current EFFECTIVE chain — and disagrees with these semantics
on boundary playlist members: it keeps the boundary's summary and seals the
summarized region there (P9 c), while our semantics never cross a boundary
that the target predates. (`upToMessageId` is a `forkSession()` param minting a
NEW session id with fresh uuids — wrong tool for a daemon that keeps one
session.) So the handler computes the desired chain itself and dispatches:

- Desired chain == current active chain truncated at the target →
  `resumeSessionAt`, no file mutation (P2 d), plus the pending-rewind
  tracking of criterion 8.
- Otherwise (abandoned branch — unreachable by `resumeSessionAt`, P2 e;
  boundary playlist member — reachable but with the WRONG semantics, P9 c) →
  append a no-summary boundary listing the computed chain (P9 a, P2 j). A
  leaf-marker is not an alternative: markers pointing into a sealed region are
  ignored (P2 k).

How a future TUI `/tree` maps a selected `TreeNode` onto these modes (recorded
here so the design survives; TUI itself is a non-goal):
- Target reached `viaBoundary` → boundary mode with `uuids` = a prefix of the
  chain the creating boundary spelled out (including its summary entry as a
  playlist member — verified, P9 b).
- Target not `viaBoundary` → rewind mode: first-appeared semantics. (The
  duplicate-node design earns its keep here: a playlist member's raw node
  means "resurrect my raw history", its viaBoundary node means "keep the
  compaction".)
- Target on an abandoned raw branch → boundary mode listing that branch's
  chain (P2 j).
- Target is a user message → rewind/navigate to the immediately previous
  assistant message and prefill the input box with the user message text
  ("rewind to where I said this, but edit my message").

## Type design

Uuid-valued fields use `UUID` from `node:crypto`, mirroring the SDK's own
transcript types (readers cast after validating; the SDK's `Options.resume`
itself is `string`, so session ids stringify without friction).

```ts
// src/core/sdk-socket.ts — new SdkRequest union members
import { UUID } from "node:crypto";

| { type: "get-entries" }   // response data: SessionEntry[]
| { type: "get-tree" }      // response data: SessionTree
| SetContextRequest         // response data: SetContextResult

/** Exactly one of `uuids` / `rewindTo` selects the mode. */
export type SetContextRequest =
  // Boundary mode:
  | {
      type: "set-context";
      /** Ordered; becomes compactMetadata.preservedMessages.uuids (and allUuids). */
      uuids: UUID[];
      /** Omitted → no summary entry is written and anchor is forced to "boundary". */
      summaryText?: string;
      /** "summary" (default): summary first, then uuids (up_to shape).
       *  "boundary": uuids first, then summary (from shape). */
      anchor?: "summary" | "boundary";
    }
  // Rewind mode: the final transcript entry of an assistant API message;
  // context = what it was when that message first appeared (see Concrete
  // examples for the algorithm and the resumeSessionAt/no-summary-boundary
  // dispatch).
  | { type: "set-context"; rewindTo: UUID };

/** The socket casts untrusted JSON, so the one destructive command is parsed
 *  explicitly before any teardown. Throws with a descriptive message on:
 *  both or neither of uuids/rewindTo, non-array or non-uuid-string uuids,
 *  unknown anchor, non-string or empty summaryText. */
export function parseSetContextRequest(raw: Record<string, unknown>): SetContextRequest;

// New SdkEvent union member, broadcast after every successful set-context
// (both modes, including no-write rewinds). Deliberately NOT an
// SdkControlMutation: that type is reserved for controls the real SDK
// supports.
| { kind: "contextChanged"; request: SetContextRequest }

/** Response data for set-context. boundaryUuid absent when a rewind needed no
 *  boundary; summaryUuid absent whenever no summary entry was written. */
export interface SetContextResult {
  boundaryUuid?: UUID;
  summaryUuid?: UUID;
}
```

```ts
// src/core/session-file.ts (new) — jsonl location, read, and append.
// (importSessionToStore/@alpha could read for us, but direct file access
// avoids the alpha dependency and we need the path for appending anyway —
// documented in code comments.)

import { UUID } from "node:crypto";

/** One parsed jsonl line, verbatim. Known fields typed, everything else kept. */
export interface SessionEntry {
  uuid?: UUID;
  parentUuid?: UUID | null;
  logicalParentUuid?: UUID | null;
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

/** The CLI's project-directory encoding: cwd with [^a-zA-Z0-9] → "-". */
export function projectKey(cwd: string): string;

/** <configDir>/projects/<projectKey>/<sessionId>.jsonl. configDir is explicit:
 *  the caller resolves it the same way the CLI child does (CLAUDE_CONFIG_DIR
 *  from the child's env if set, else ~/.claude). */
export function sessionFilePath(configDir: string, cwd: string, sessionId: UUID): string;

export function readSessionEntries(filePath: string): SessionEntry[];

/** Builds boundary (+ summary) entries and appends them. Pure construction
 *  split from the write so tests can inspect entries without a filesystem. */
export function buildBoundaryEntries(params: {
  sessionId: UUID;
  cwd: string;
  uuids: UUID[];
  summaryText?: string;
  anchor: "summary" | "boundary";
  /** Recorded as the boundary's logicalParentUuid (tree anchoring). */
  logicalParentUuid: UUID | null;
}): { entries: SessionEntry[]; result: SetContextResult };

export function appendSessionEntries(filePath: string, entries: SessionEntry[]): void;

/** Resolves when an entry with this uuid is in the file (fs.watch + predicate;
 *  covers the ~100–180 ms flush lag after the SDK result message). */
export function waitForEntryOnDisk(filePath: string, uuid: UUID, timeoutMs?: number): Promise<void>;
```

```ts
// src/core/build-tree.ts (new)
import { UUID } from "node:crypto";
import { SessionEntry } from "./session-file.js";

export interface TreeNode {
  entryUuid: UUID;
  children: TreeNode[];
  /** Set when the edge to this node's parent comes from a boundary relink
   *  rather than the entry's raw parentUuid. */
  viaBoundary?: UUID;
}

export interface SessionTree {
  roots: TreeNode[];
  /** Payloads by uuid; duplicated tree nodes share one payload. Entries
   *  lacking a uuid (file-history-snapshot, queue-operation) are omitted —
   *  they get no tree node and are visible via get-entries only. */
  entries: Record<UUID, SessionEntry>;
}

/** THIS SPEC ships the raw forest only: raw parentUuid edges give the base
 *  forest, and each boundary node is attached as a child of its
 *  logicalParentUuid entry (root if absent). The boundary's relinked chain —
 *  summary + uuids per anchor shape hanging under it as DUPLICATE nodes
 *  (same entryUuid, new TreeNode), with relink revisits unrolled linearly —
 *  is specified and built in a FOLLOW-UP spec; until then viaBoundary is
 *  never set. The TreeNode/SessionTree shapes above are fixed now so the
 *  follow-up is additive.
 *
 *  logicalParentUuid is not interpreted by the loader — it exists for tree
 *  anchoring, and we set it ourselves when building a boundary (= the active
 *  leaf at set-context time). Native boundaries follow the same idea: always
 *  the last message before the summarization point (full /compact: the
 *  pre-compaction leaf; up_to: the last entry of the summarized segment;
 *  from: the last preserved entry = parent of the first summarized message —
 *  confirmed in the p0b/p0c captures). Native summary entries parent onto the
 *  boundary in BOTH shapes, so parentUuid-based tree construction stays
 *  correct without special-casing. */
export function buildTree(entries: SessionEntry[]): SessionTree;
```

```ts
// src/core/daemon.ts — internal restructuring (no exported API change)
// `claudeQuery` becomes reassignable; construction is extracted so set-context
// can rebuild it:
//   let claudeQuery: Query = startQuery(resumeSessionId?)
//   async function restartQuery(resumeSessionId: string, resumeSessionAt?: UUID): Promise<void>
// A Query gate (readers-writer) serializes set-context against everything
// Query-bound (the daemon otherwise dispatches connection requests
// concurrently — an idle check alone is a moment-in-time read). Query-bound
// operations — query, interrupt, SdkControlMutation, SdkControlRead — take
// the gate shared; set-context takes it exclusive, so it waits for in-flight
// Query operations to finish and no new one can touch the old Query during
// teardown/replacement. While set-context holds the gate, newly arriving
// Query-bound requests and other set-contexts error ("context change in
// progress"); file reads (get-entries/get-tree/get-messages) wait for the
// gate so they never observe a half-done mutation. Eligibility, checked
// under the gate: assistantState idle AND queueModel.queued empty AND
// deliveredPending empty — else error.
// set-context handler sequence (under the exclusive gate):
//   parseSetContextRequest + uuid-existence validation → eligibility →
//   leaf-on-disk wait → end turnQueue / close query → await child exit →
//   [boundary mode: buildBoundaryEntries + appendSessionEntries, one write] →
//   restartQuery(sessionId, rewindTo?) → verify (below) → broadcast
//   contextChanged (criterion 7) → SetContextResult
// Rewind mode computes the desired chain (last boundary preceding the target
// in file order + effective-parent-map walk; see Concrete examples) and
// compares it to the active chain truncated at rewindTo: equal →
// restartQuery with resumeSessionAt: rewindTo, no file mutation, and record
// the superseded tail uuids — get-messages filters them from its output
// (naturally inert after the next turn; filter lifecycle per criterion 8).
// Different → build + append a no-summary boundary listing the computed
// chain, then a plain restart.
// Restart failure: a synchronous query() construction failure puts the
// daemon in a query-unavailable state — Query-bound requests error clearly
// ("query restart failed; retry set-context"), file reads keep working, and
// a subsequent set-context (or daemon restart) reconstructs the Query. An
// ASYNC child-startup failure is not catchable at restart time (streaming
// mode has no readiness signal; init fires on the first turn) — it surfaces
// as a reader error and exits the daemon like any other stream death, and
// revival reconstructs from the file. Either way an appended boundary is
// already durable and any later resume picks it up.
// contextChanged is broadcast iff the FILE was mutated, even when the
// restart then fails (watchers track file truth); the RPC itself still
// returns the restart error. The intentional completion of the old Query's
// stream-consumption loop must not be treated as daemon shutdown.
// Verification: boundary mode re-reads the file and asserts that
// effectiveChain over it matches (summary first when given, tail == uuids) —
// NOT via getSessionMessages, whose latest-leaf tip selection is wrong for
// branch-switch playlists (criterion 3 mechanism note). Weaker as an
// independent oracle (same model that computed the append), but the
// wire-level truth was derisked (P9) and the check still catches torn or
// failed appends. This checks the loader's view of the FILE, not the live
// Query — a streaming Query initializes on its first turn, so a bad resume
// can still surface at the next turn. No-write rewinds skip file
// verification (nothing changed).
// get-messages override slot (one slot, two variants, mutually exclusive):
//   { kind: "filterTail", uuids }   — after a successful no-write rewind
//   { kind: "synthesize", chain }   — after a durable boundary append
// filterTail subtracts the superseded tail from getSessionMessages output;
// synthesize maps the stored chain to SessionMessage shape from the session
// file, avoiding getSessionMessages' wrong-chain window entirely. Cleared
// when lastTranscriptUuid changes (next transcript write makes both inert /
// wrong to keep); replaced by the next successful set-context. On daemon
// startup the synthesize variant is reconstructed from one session-file read
// (see criterion 3); filterTail is not reconstructible (criterion 8's
// documented durability limitation).
```

```ts
// src/core/sdk-commands.ts — CLI wiring
// get-entries, get-tree: bareRequestCommand.
// set-context: parameterized command; positional uuids, --summary <text>,
// --anchor <summary|boundary>, or --rewind-to <uuid> (mutually exclusive with
// the boundary-mode arguments; follows existing parameterized patterns).
```

## Edge cases

- `set-context` while busy → error (criterion 5). Busy = assistant not idle,
  OR queued messages, OR delivered-but-pending prompts, OR another
  set-context in progress (the mutex). No implicit waiting.
- Malformed request (both or neither of `uuids`/`rewindTo`, non-uuid strings,
  unknown `anchor`, non-string or empty-string `summaryText`) → error from
  `parseSetContextRequest`, before eligibility checks or teardown.
- Boundary + summary are written in ONE `write()` call, boundary line first
  (native file order, p0b/p0c captures). A crash can still tear the tail of a
  single write; the residual case — complete boundary, torn summary — leaves
  an anchorUuid pointing at a missing entry. Untested, but the analogous
  missing-playlist-uuid case fails closed (relink silently skipped, P1 d).
  Accepted risk; no repair protocol in v1.
- Unknown uuid in `uuids` → error before any file mutation (criterion 4).
  (A missing/duplicate uuid that reached the loader would silently produce a
  summary-only context — validated up front instead.)
- Empty `uuids` with `summaryText` → allowed: context becomes the summary
  alone. Empty `uuids` without `summaryText` → error (nothing to load).
- `anchor: "summary"` without `summaryText` → error (nothing to anchor on).
- Duplicate uuids in the list → error. Verified experimentally (P3 m4): a
  duplicated uuid makes the loader silently skip the whole relink, leaving a
  summary-only context.
- `rewindTo` that is not in the file, not an assistant entry, or not the
  final transcript entry of its API message (a later sibling shares its
  `message.id` — e.g. a thinking entry) → error before teardown. Requiring a
  final assistant entry keeps the chain answer-terminated with whole API
  messages — `resumeSessionAt` and `getSessionMessages` behavior for
  mid-message siblings is untested. The TUI maps user-message targets to the
  previous assistant itself.
- No session yet (daemon never started a session) → error for all three
  commands.
- get-entries/get-tree tolerate a torn final line (mid-append read): skip it.

## Non-goals

- Summary *generation* (side inference call, summary-prompt override) — later
  spec; `set-context` takes caller-supplied text only.
- Reproducing native compaction's `<system-reminder>` re-injection of recent
  tool results.
- Auto-compaction behavior or thresholds.
- TUI rendering of the tree.
- get-tree boundary substructure (duplicate nodes, `viaBoundary` population)
  — follow-up spec; this spec ships the raw forest.
- Subagent/sidechain trees (`isSidechain` entries are returned by get-entries
  but get-tree treats them like any other entry in v1).
- Preserving partial API messages: callers should list whole API messages
  (all jsonl sibling entries of one `message.id`); v1 documents this rule but
  does not enforce it.

# IMPLEMENTATION IDEAS

- ~~Assumption to verify before implementation~~ **Verified (P9,
  `docs/derisk/compact-boundary-injection/p9-navigation.mjs`)**: (a) a
  boundary with NO summary entry and `anchorUuid` = the boundary's own uuid
  relinks correctly even as the last entry in the file; (b) a boundary whose
  playlist is a prefix of an earlier boundary's chain — including that
  boundary's summary entry and entries it summarized away — is honored
  exactly; (c) `resumeSessionAt` onto a playlist member of a relinked chain
  preserves the boundary's effect and writes nothing to the file.
- Boundary entry construction mirrors the known-working recipe
  (FINDINGS.md): `type:"system"`, `subtype:"compact_boundary"`,
  `parentUuid:null`, `logicalParentUuid` = current active leaf,
  `compactMetadata.trigger:"manual"`, `preservedMessages:{anchorUuid, uuids,
  allUuids}`; summary entry `type:"user"`, `parentUuid` = boundary uuid,
  `isCompactSummary:true`. Fields like preTokens/postTokens are not
  individually ablated — keep writing plausible values.
- get-tree boundary substructure (now a follow-up spec) needs a working
  session together: how the anchor shapes map to nodes (e.g. up_to: boundary
  → summary → uuid chain; from: boundary → uuid chain → summary), whether the
  synthetic "No response requested." assistant (a real on-disk entry after
  the first post-boundary turn) needs special handling, and how stacked
  boundaries nest (last one wins for loading; earlier ones still render).
  The `buildTree` signature is fixed now so that spec is additive.
- Restart machinery: the stream-consumption loop, queue model, and
  trackedState in daemon.ts are built around a single `claudeQuery`. The
  restart must rewire the consumption loop onto the new Query and keep the
  EventBus/subscribers untouched. A TurnQueue generator cannot be restarted
  after ending — restartQuery creates a fresh TurnQueue too. Audit which
  pieces are per-Query vs per-daemon before extracting `startQuery`.
- Restart failure after append: the boundary is already on disk and is picked
  up by any later resume; no rollback of the appended entries. A synchronous
  `query()` construction failure puts the daemon in the query-unavailable
  state defined in the daemon.ts sketch; an asynchronous child-startup
  failure is not catchable at restart time (no readiness signal in streaming
  mode) and exits the daemon via the normal stream-death path, with revival
  reconstructing from the file.
- Post-restart verification: ~~use `getSessionMessages` (cross-validated
  against the wire, P8)~~ — P8's fixtures all had active-chain-tail playlists
  and missed the latest-leaf tip selection (sdk.mjs `W6`); verification now
  recomputes `effectiveChain` over the re-read file instead. Divergence
  returns an error but the file mutation is not rolled back (subsequent
  `set-context` can fix it; boundaries stack, last wins). The "KNOWN
  DIVERGENCE" test in request-handlers.test.ts pins the SDK behavior and
  fails when an upgrade fixes it.
- Idle definition: the eligibility predicate (daemon sketch) covers
  assistantState, queueModel.queued, and deliveredPending; `set-context` also
  needs "leaf on disk", which `waitForEntryOnDisk` covers using
  `trackedState.lastTranscriptUuid`. If no turn has run this daemon lifetime
  (revived session), `lastTranscriptUuid` is unset and the file is quiescent
  — skip the wait.
- Graceful teardown: end the prompt stream (TurnQueue must expose/allow
  ending), await generator completion — the SDK's cleanup awaits child exit
  (verified in P7: ~12 ms, no surviving child process).
- The no-write-rewind durability caveat (criterion 8: daemon death before the
  next turn loses the rewind — the file carries no record of it) must be
  documented as a code comment where the superseded-tail filter is
  implemented in daemon.ts, so it's discoverable next to the mechanism.
- `readSessionEntries` uses the same torn-line-tolerant parse as the derisk
  harness (`readJsonlSafe`).
- SDK↔jsonl read consistency (get-entries/get-tree): before reading, wait for
  `trackedState.lastTranscriptUuid` to be on disk (`waitForEntryOnDisk`), so
  the returned entries always include everything the daemon has already
  reported on the event stream. Agreed 2026-07-14: do NOT additionally
  truncate the file at that uuid — legitimate non-transcript entries
  (`file-history-snapshot`, `queue-operation`) land after the transcript leaf
  with `parentUuid: null` and would be silently dropped; and mid-turn trailing
  writes can only appear if the caller reads while busy, which is their
  choice. If a stable snapshot semantic is wanted instead, truncation would
  need a rule for those null-parent entries.
- Cheap fixture for tests: a jsonl checked into test fixtures (branch +
  boundary), driving buildTree and the read commands without a live CLI.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-07-14: Spec written after derisk discussion. Key decisions from that
  discussion: mirror SDK naming (`uuids`, not "playlist"); two read commands
  (`get-entries` verbatim / `get-tree` resolved, duplicate nodes rather than a
  DAG, cycles unrolled linearly); tree building in its own file
  (`build-tree.ts`); daemon reads the jsonl directly (no @alpha
  `importSessionToStore` dependency — noted in comments); caller-supplied
  summary text only; `summaryText` omitted → no summary entry + anchor forced
  to boundary (UNTESTED — experiment before implementation); this spec
  introduces the Query-restart machinery.
- [x] Experiment: no-summary boundary (anchor = boundary uuid, no summary entry)
- 2026-07-14: Review comments (commit 4eb65a9) folded in after the P9
  experiments (all three cases passed first run; see derisk WORK-LOG):
  rewind mode added to set-context (`--rewind-to` via `resumeSessionAt`;
  `upToMessageId` is a forkSession param and unsuitable); success criteria 7
  (broadcast set-context request) and 8 (rewind) added; uuid-typed fields now
  use `UUID` from node:crypto; duplicate-uuid edge case backed by P3 m4
  evidence; native logicalParentUuid semantics documented in buildTree;
  queued-messages-count-as-busy recorded; SDK↔jsonl read-consistency proposal
  (wait for lastTranscriptUuid, no truncation) added — awaiting user decision.
- 2026-07-14 (later): read-consistency proposal approved (wait, no
  truncation). Rewind mode redefined per review comment: `--rewind-to` accepts
  any assistant uuid in the file with raw-ancestry semantics ("as if the SDK
  let you resume at any uuid"); `resumeSessionAt` is only the fast path when
  the desired chain truncates the active chain, since P9 c shows it gives
  effective-chain (boundary-kept) semantics on playlist members — the
  ancestry-walk semantics there require a no-summary boundary instead.
  Confirmed by user: raw-ancestry is the intended reading ("rewind to what the
  context was when this message first appeared"); the boundary-kept variant
  isn't well-specified when a uuid is on multiple playlists.
- 2026-07-14: Fresh-context reviewer round 1 (agent 3a42a99f). Confirmed
  blocking findings, all resolved with user decisions: (1) no-write rewind vs
  get-messages contradiction → daemon tracks pendingRewindTo and truncates
  get-messages output until the next transcript write (durability caveat
  documented); (2) "boundary ON the walked chain" was incoherent — post-
  boundary entries parent onto the preserved tail, never the boundary —
  replaced with the precise algorithm: last boundary preceding the target in
  file order, relink-map-first walk (equivalent to loader-on-truncated-file;
  needs no tree); (3+4) context-mutation mutex + eligibility predicate
  (idle ∧ no queued ∧ no deliveredPending); reads wait, writes error;
  (5) new `contextChanged` SdkEvent variant, kept out of SdkControlMutation
  (reserved for real SDK controls); (6) buildTree ships raw forest only,
  substructure moved to a follow-up spec; (7) uuid-less entries get no tree
  node; (8) boundary+summary in one write(), boundary first (native order per
  p0b/p0c captures), residual torn-tail risk accepted; (9) criterion 3
  scoped to well-formed playlists; (10) parseSetContextRequest runtime
  validation. Pushed back on: crash-repair protocol (residual window is one
  syscall) and exact-context for strange playlists (non-goal + verification
  error suffice).
- 2026-07-14: Reviewer round 2 — five remaining blockers, all accepted and
  fixed: (1) from-shape counterexample — the relink map alone skips the
  playlist because from-shape post-boundary writes chain synthetic assistant
  → summary → boundary; fixed by extending the map (summary's effective
  parent = uuids[last] in from-shape; boundary transparent), matching p2.b's
  observed [uuids…, summary] order; (2) pendingRewindTo "cleared on next
  transcript write" was not observably implementable — replaced with
  recording the superseded tail uuids and filtering them from get-messages
  (functional, no clearing event, naturally inert after the next turn);
  (3) mutex widened to a Query readers-writer gate covering query, interrupt,
  and all control mutations/reads; (4) rewindTo restricted to the final
  transcript entry of an assistant API message (mid-message siblings like
  thinking entries rejected — untested territory); (5) query-unavailable
  state defined for restart failure; contextChanged broadcast iff the file
  was mutated, even when the restart then fails.
- 2026-07-14: Reviewer round 3 — conditional approval on three small edits,
  all applied: empty-playlist from-shape keeps the summary's raw parent;
  superseded-tail filter lifecycle made explicit (install only on successful
  no-write restart; clear on a later durable boundary append; failed
  non-mutating requests leave it unchanged); problem statement updated to the
  final-assistant-entry restriction. Reviewer confirmed the effective-parent
  map equivalent to loader-on-truncated-file across both shapes, no-summary,
  stacked boundaries, and playlists containing an earlier boundary's summary.
- [x] Reviewer final sign-off: approved 2026-07-14 after one wording fix
  (daemon sketch filter-lifecycle reference aligned with criterion 8).
  Reviewer agent 3a42a99f, archived (revivable by prompting).
- [x] Implementation (start approved by user 2026-07-15). All code landed, `npm run check`
  / lint / 191 tests green: `session-file.ts`, `build-tree.ts` (+ tests),
  sdk-socket.ts types + `parseSetContextRequest` (+ tests), agent-state.ts
  `contextChanged` fold case, daemon.ts restart machinery, request-handlers.ts
  (gate, `effectiveChain`, set-context/get-entries/get-tree handlers + tests),
  sdk-commands.ts CLI wiring. Durability caveat landed as the code comment at
  the superseded-tail filter.

## Implementation-Time Decisions

- 2026-07-15: **Adaptation to the daemon refactor** (main merged daemon.ts →
  src/core/daemon/ modules): the set-context handler lives in
  request-handlers.ts per user instruction; `effectiveChain` + the QueryGate
  live there too (exported for tests). `RequestHandlerDeps` gained
  `getQuery()`/`getTurnQueue()` (the Query/TurnQueue are now mutable slots in
  daemon.ts), `sessionFilePath(sessionId)`, `teardownQuery()`, and
  `restartQuery(resumeSessionId, resumeSessionAt?)`. daemon.ts's reader loop
  ends into `daemonStreamDone`, which teardownQuery suppresses via a
  `tearingDown` flag so an intentional stream end is not treated as shutdown.
  daemon.ts's local sessionFilePath helper was replaced by the session-file.ts
  one, with configDir now resolved from the CHILD's env (persisted env can
  override CLAUDE_CONFIG_DIR), not the daemon's.
- 2026-07-15: **Boundary stamp boilerplate**: `buildBoundaryEntries` writes the
  proven-recipe placeholder values (version "2.1.195", gitBranch "HEAD",
  preTokens 40000, …) rather than live metadata — the agreed signature has no
  params for them and ablation showed only compactMetadata + valid uuids
  matter. Flagged for review.
- 2026-07-15: **SPEC DEVIATION — verification oracle replaced.** Discovered
  during testing: the SDK's `getSessionMessages` does NOT model the loader for
  branch-switch playlists. Its chain selection (sdk.mjs `W6`) applies every
  boundary's relink, then picks the tip as the user/assistant LEAF WITH THE
  LARGEST FILE INDEX across all dangling leaves — so any playlist whose tip
  predates another leaf in file order (abandoned-branch rewinds, resurrecting
  a summarized region) yields the WRONG chain, while the CLI loader honors
  those playlists (P9 a/b, wire-verified). P8 missed this because its
  fixtures' playlists were all tails of the active chain. Consequences:
  (1) post-restart verification now recomputes `effectiveChain` over the
  re-read file instead of calling getSessionMessages — weaker as an
  independent oracle (same model that computed the append), but the wire-level
  truth was derisked and the check still catches torn/failed appends;
  (2) criterion 3's "get-messages returns exactly the new effective context"
  does NOT hold for branch-switch playlists — get-messages still uses
  getSessionMessages and reports the raw-latest-leaf chain there. Pinned by
  the "KNOWN DIVERGENCE" test in request-handlers.test.ts (fails when an SDK
  upgrade fixes it). Open question resolved below (2026-07-15, get-messages
  synthesis).
- 2026-07-15: **get-messages synthesis window (user decision, spec amended,
  NOT yet implemented).** The divergence window is exactly "boundary
  appended, no post-boundary user/assistant entry yet" — verified empirically
  that getSessionMessages agrees with the loader again once the first
  post-boundary turn's entries land (they become the latest-file-index leaf).
  Decision: during that window the daemon synthesizes the get-messages
  response from the session file (expected chain → SessionMessage shape);
  state tracked in the daemon (install on durable boundary append, clear on
  lastTranscriptUuid change, replace on later set-context), unified with the
  superseded-tail filter as one override slot with two mutually exclusive
  variants (filterTail | synthesize). On daemon startup, one session-file
  read reconstructs the synthesize variant (last boundary has no
  post-boundary user/assistant entries besides its own summary) — closing
  the revival window without a file read per get-messages call (passthrough
  get-messages already pays getSessionMessages' own file read; the startup
  read avoids a second parse per call). filterTail stays non-reconstructible
  (criterion 8's durability limitation). Criterion 3, the daemon.ts sketch,
  and the verification bullet updated accordingly.
- 2026-07-15: **Implementation review round 1** (spec reviewer revived).
  Fixed in response: (a) `readSessionEntries` now tolerates only a torn
  FINAL line and throws on malformed earlier lines or non-object values
  (silent skipping would let chain computation and file mutation run against
  incomplete history); (b) criterion 3 and the verification comment
  corrected — the structural check does not detect the CLI's inference-time
  normalization of authoring-rule violations, and no file-reading oracle can
  (the original getSessionMessages oracle read the same file); (c) documented
  that query-unavailable covers only a synchronous `restartQuery` failure —
  an async child-startup failure surfaces as a reader error and exits the
  daemon via the normal stream-death path, with revival reconstructing from
  the file (spec sketch + daemon.ts comment; behavior unchanged, the spec
  text was overconfident); (d) documented the stream-echo assumption behind
  lazy override clearing (every appended user/assistant entry is echoed on
  the stream with its uuid — the same mechanism deliveredMessages
  confirmation already relies on); (e) added a field-for-field parity test:
  synthesized get-messages vs raw getSessionMessages on a tail playlist
  (where the raw SDK picks the right chain), compared after JSON
  serialization; (f) segment-only boundaries (`preservedSegment`, older
  CLIs) documented as unmodeled by effectiveChain; (g) the CLI now runs
  `parseSetContextRequest` client-side, so malformed set-context invocations
  (including bad uuid syntax) fail before a daemon revival. Declined:
  rejecting rewind targets whose entry lacks `message.id` (real assistant
  entries always carry one; with it absent there is nothing to validate
  finality against, and rejecting would refuse unusual-but-valid entries);
  changing effectiveChain tip selection to skip uuid-bearing
  attachment/sidechain entries (every comparison computes both sides with
  the same function, message filters strip non-messages downstream, and
  current CLIs put sidechains in separate files — flagged as a limitation,
  not fixed).
- 2026-07-15: **Implementation review round 2 + sign-off.** Two residual
  blockers fixed: (1) torn-tail tolerance narrowed to an UNTERMINATED final
  line only — a malformed terminated final line throws (once the newline is
  on disk, the whole record before it is too); (2) the IMPLEMENTATION IDEAS
  restart-failure bullet now matches the corrected sync/async distinction.
  Reviewer approved the implementation as on disk; awaiting user review.
- [x] Implement the get-messages override slot (synthesize variant + startup
  reconstruction; rework the existing supersededTail into the slot).
  Implementation notes: the synthesize variant is installed inside
  `restartAndVerify` BEFORE the restart attempt (the append is already
  durable, so get-messages should reflect it even when the restart then
  fails), and it carries the re-read file's `effectiveChain` rather than the
  caller's `expected` — identical on success, and on a verification failure
  get-messages still reflects the loader's actual view. Clearing is lazy:
  each variant records `installedAtLeafUuid` (the hub's `lastTranscriptUuid`
  at install time) and get-messages drops the slot when the current leaf
  differs. Startup reconstruction lives in `createRequestHandler`
  construction (one `readSessionEntries` when the seeded session's file
  exists; `synthesizeWindowChain` detects the open window). The synthesized
  messages mirror the SDK's own mapping (user/assistant only, isMeta and
  isSidechain excluded, `parent_tool_use_id` always null, `timestamp`
  included — present in getSessionMessages' runtime output though absent
  from its declared type). The KNOWN DIVERGENCE test now pins the raw
  `getSessionMessages` behavior directly and asserts that `get-messages`
  synthesizes the loader chain; new tests cover window close on the next
  transcript write and startup reconstruction (open and closed windows).
