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
  <uuid>`: any assistant uuid in the session file; context becomes that
  message and its ancestry). Rewind mode is a semantic, not a mechanism: it
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
2. `clauctl get-tree` returns a forest in which, on a fixture with one branch
   point and one boundary: both branches appear; the boundary node is a child
   of the last pre-compaction message (`logicalParentUuid`); the summary and
   relinked `uuids` chain appear under the boundary's graft structure; a
   message on both a raw branch and a boundary chain appears as two nodes with
   the same `entryUuid`.
3. `clauctl set-context <uuids...>` on an idle daemon: appends the boundary
   (+ summary when `--summary` given), restarts the `Query` resuming the same
   session id, and afterwards `get-messages` returns exactly the new effective
   context (summary if any + the listed messages — modulo the documented
   whole-API-message granularity: `getSessionMessages` includes same-message
   sibling entries; see FINDINGS.md P8). The next turn's user entry
   parents onto the last uuid of the list (up_to/no-summary) or the synthetic
   assistant (from-shape).
4. `set-context` with a uuid not in the file fails with a clear error and does
   not restart the query.
5. `set-context` while the assistant is busy fails with a clear error (caller
   can `wait-idle` first).
6. Existing daemon behavior (event stream, queueing, get-messages) works after
   a `set-context` restart.
7. A successful `set-context` broadcasts an event on sdk.sock so watchers
   (e.g. an attached TUI) know the context changed: the `set-context` request
   message itself is broadcast, mirroring how `controlApplied` is broadcast in
   `src/core/daemon.ts`.
8. `clauctl set-context --rewind-to <uuid>` on an idle daemon accepts any
   assistant uuid in the session file; afterwards `get-messages` returns that
   message and its ancestry: the raw `parentUuid` walk from the target, with a
   boundary's relink still applied when the boundary is ON the walked chain
   (so rewinding to a post-compaction message keeps its summary; rewinding to
   a boundary playlist member follows the member's raw ancestry — the
   summarized region comes back). When the desired chain is a truncation of
   the current active chain, nothing is written to disk (`resumeSessionAt`);
   otherwise a no-summary boundary is appended.

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
appeared" — find the target and walk its `parentUuid` ancestry (loader
semantics: a boundary on the walked chain still relinks). This is the only
well-specified reading: the alternative "truncate the effective chain, keeping
boundary effects" breaks down once a uuid sits on multiple boundary playlists
(which boundary's view wins?), whereas every entry has exactly one raw
ancestry. Callers who want a specific boundary's view of a message address it
through that boundary (TreeNode `viaBoundary` → prefix boundary, below). The SDK option that exists,
`resumeSessionAt`, implements something narrower — truncation of the current
EFFECTIVE chain — and the two disagree on boundary playlist members:
`resumeSessionAt` there keeps the boundary's summary and seals the summarized
region (P9 c), while the raw ancestry walk never crosses the boundary and
resurrects that region. (`upToMessageId` is a `forkSession()` param minting a
NEW session id with fresh uuids — wrong tool for a daemon that keeps one
session.) So the handler computes the desired chain itself and dispatches:

- Desired chain == current active chain truncated at the target (target at or
  after the last boundary's summary, or no boundary in effect) →
  `resumeSessionAt`, no file mutation (P2 d).
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
- Target not `viaBoundary` → rewind mode: raw-ancestry semantics, which is
  exactly what the raw tree node depicts. (The duplicate-node design earns its
  keep here: a playlist member's raw node means "resurrect my raw history",
  its viaBoundary node means "keep the compaction".)
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
// Rewind mode: any assistant uuid in the file; context = its raw-ancestry
// walk (loader semantics). Dispatch (see Concrete examples): resumeSessionAt
// when the desired chain truncates the active chain, else a no-summary
// boundary is appended.
| { type: "set-context"; rewindTo: UUID }

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
  /** Payloads by uuid; duplicated tree nodes share one payload. */
  entries: Record<UUID, SessionEntry>;
}

/** Forest semantics: raw parentUuid edges give the base forest; each boundary
 *  node is attached as a child of its logicalParentUuid entry; the boundary's
 *  relinked chain (summary + uuids per anchor shape) hangs under it as
 *  DUPLICATE nodes (same entryUuid, new TreeNode). Relink cycles are unrolled
 *  linearly: a uuid revisited within one boundary chain gets another duplicate
 *  node. Exact node/edge details for boundary substructure to be finalized (see
 *  IMPLEMENTATION IDEAS).
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
//   async function restartQuery(resumeSessionId: string): Promise<void>
// set-context handler sequence (asserts idle, else error):
//   leaf-on-disk wait → end turnQueue / close query → await child exit →
//   [boundary mode only: buildBoundaryEntries + appendSessionEntries] →
//   restartQuery(sessionId, rewindTo?) → verify via getSessionMessages →
//   broadcast the set-context request (criterion 7) → SetContextResult
// Rewind mode first computes the desired chain (raw parentUuid walk from
// rewindTo, loader semantics) and compares it to the active chain truncated
// at rewindTo: equal → restartQuery with resumeSessionAt: rewindTo, no file
// mutation; different → build + append a no-summary boundary listing the
// computed chain, then a plain restart. The chain computation shares logic
// with build-tree.ts.
```

```ts
// src/core/sdk-commands.ts — CLI wiring
// get-entries, get-tree: bareRequestCommand.
// set-context: parameterized command; positional uuids, --summary <text>,
// --anchor <summary|boundary>, or --rewind-to <uuid> (mutually exclusive with
// the boundary-mode arguments; follows existing parameterized patterns).
```

## Edge cases

- `set-context` while busy → error (criterion 5). Queued messages count as
  busy. No implicit waiting.
- Unknown uuid in `uuids` → error before any file mutation (criterion 4).
  (A missing/duplicate uuid that reached the loader would silently produce a
  summary-only context — validated up front instead.)
- Empty `uuids` with `summaryText` → allowed: context becomes the summary
  alone. Empty `uuids` without `summaryText` → error (nothing to load).
- `anchor: "summary"` without `summaryText` → error (nothing to anchor on).
- Duplicate uuids in the list → error. Verified experimentally (P3 m4): a
  duplicated uuid makes the loader silently skip the whole relink, leaving a
  summary-only context.
- `rewindTo` that is not an assistant uuid in the file → error before
  teardown. (The uuid must exist to compute its ancestry; requiring an
  assistant entry keeps the chain answer-terminated — the TUI maps
  user-message targets to the previous assistant itself.)
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
- get-tree boundary substructure needs a working session together: how the
  anchor shapes map to nodes (e.g. up_to: boundary → summary → uuid chain;
  from: boundary → uuid chain → summary), whether the synthetic
  "No response requested." assistant (a real on-disk entry after the first
  post-boundary turn) needs special handling, and how stacked boundaries nest
  (last one wins for loading; earlier ones still render). The `buildTree`
  signature above is fixed; node arrangement details may evolve.
- Restart machinery: the stream-consumption loop, queue model, and
  trackedState in daemon.ts are built around a single `claudeQuery`. The
  restart must rewire the consumption loop onto the new Query and keep the
  EventBus/subscribers untouched. A TurnQueue generator cannot be restarted
  after ending — restartQuery creates a fresh TurnQueue too. Audit which
  pieces are per-Query vs per-daemon before extracting `startQuery`.
- Restart failure (CLI child fails to come up after append): the boundary is
  already on disk and is picked up by any later resume, so recovery = retry
  the restart; report the error to the caller either way. No rollback of the
  appended entries.
- Post-restart verification: `getSessionMessages` was cross-validated against
  the wire (P8) — equal at whole-API-message granularity. Use it to assert the
  first message is the summary (when given) and the tail matches `uuids`;
  divergence returns an error but the file mutation is not rolled back
  (subsequent `set-context` can fix it; boundaries stack, last wins).
- Idle definition: reuse the daemon's existing assistantState/whenIdle
  machinery; `set-context` also needs "leaf on disk", which
  `waitForEntryOnDisk` covers using `trackedState.lastTranscriptUuid`.
- Graceful teardown: end the prompt stream (TurnQueue must expose/allow
  ending), await generator completion — the SDK's cleanup awaits child exit
  (verified in P7: ~12 ms, no surviving child process).
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
- [ ] Implementation
