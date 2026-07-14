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
- `set-context` — append a boundary (+ optional summary) and restart the
  `Query` so it takes effect.

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

TDC: a successful set-context must also emit an event so that watchers of sdk.sock (e.g. an attached tui) know that the context has been updated. In pictl, this is a tree-navigated event. Here the context manipulation is potentially more complicated, so I guess the simplest thing to do is broadcast the `set-context` request message, similar to how we broadcast controlApplied in clauctl/src/core/daemon.ts.

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

clauctl get-entries   # raw jsonl entries
clauctl get-tree      # resolved forest
```

TDC: There's a really important case we forgot to cover, which is navigation back without a summary. Maybe this should be exposed as `clauctl set-context --rewind-to <uuid>`? In those cases, we don't need to synthesize a boundary entry at all. We can just restart the Query with upToMessageId set to the last assistant message in the options. Some additional nuances for when we add `/tree` navigation to the tui:
* When the user selects a message from the conversational tree, what we get is a TreeNode target, not an entry uuid. If the target is `viaBoundary`, then we have to create a new boundary with uuid list set to a prefix of the boundary that created the TreeNode. If the target is not `viaBoundary`, then we can use this simpler rewind trick that doesn't invovle modifying the session file.
* upToMessageId is required to be an assistant message uuid. If the user selects a user message uuid, the expected behavior is that we set upToMessageId to the immediately previous assistant message, and prefill the input box with the target user message text. Conceptually, the user is saying "I want to rewind to the point where I said this, but edit my message".
We need to add this to our derisking experiments. I'm pretty sure it will work.

## Type design

```ts
// src/core/sdk-socket.ts — new SdkRequest union members
| { type: "get-entries" }   // response data: SessionEntry[]
| { type: "get-tree" }      // response data: SessionTree
| {
    type: "set-context";
    /** Ordered; becomes compactMetadata.preservedMessages.uuids (and allUuids). */
    uuids: string[];
    /** Omitted → no summary entry is written and anchor is forced to "boundary". */
    summaryText?: string;
    /** "summary" (default): summary first, then uuids (up_to shape).
     *  "boundary": uuids first, then summary (from shape). */
    anchor?: "summary" | "boundary";
  }

/** Response data for set-context. */
export interface SetContextResult {
  boundaryUuid: string;
  summaryUuid?: string;
}
```

```ts
// src/core/session-file.ts (new) — jsonl location, read, and append.
// (importSessionToStore/@alpha could read for us, but direct file access
// avoids the alpha dependency and we need the path for appending anyway —
// documented in code comments.)

/** One parsed jsonl line, verbatim. Known fields typed, everything else kept. */
export interface SessionEntry {
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

/** The CLI's project-directory encoding: cwd with [^a-zA-Z0-9] → "-". */
export function projectKey(cwd: string): string;

/** <configDir>/projects/<projectKey>/<sessionId>.jsonl. configDir is explicit:
 *  the caller resolves it the same way the CLI child does (CLAUDE_CONFIG_DIR
 *  from the child's env if set, else ~/.claude). */
export function sessionFilePath(configDir: string, cwd: string, sessionId: string): string;

export function readSessionEntries(filePath: string): SessionEntry[];

/** Builds boundary (+ summary) entries and appends them. Pure construction
 *  split from the write so tests can inspect entries without a filesystem. */
export function buildBoundaryEntries(params: {
  sessionId: string;  // TDC: UUID?
  cwd: string;
  uuids: string[];  // TDC: UUID[]?
  summaryText?: string;
  anchor: "summary" | "boundary";
  /** Recorded as the boundary's logicalParentUuid (tree anchoring). */
  logicalParentUuid: string | null;
}): { entries: SessionEntry[]; result: SetContextResult };

export function appendSessionEntries(filePath: string, entries: SessionEntry[]): void;

/** Resolves when an entry with this uuid is in the file (fs.watch + predicate;
 *  covers the ~100–180 ms flush lag after the SDK result message). */
export function waitForEntryOnDisk(filePath: string, uuid: string, timeoutMs?: number): Promise<void>;
```

```ts
// src/core/build-tree.ts (new)
import { SessionEntry } from "./session-file.js";

export interface TreeNode {
  // TDC: Why are we using string instead of UUID for uuid types? The sdk uses UUID.
  entryUuid: string;  // TDC: UUID?
  children: TreeNode[];
  /** Set when the edge to this node's parent comes from a boundary relink
   *  rather than the entry's raw parentUuid. */
  viaBoundary?: string;  // TDC: UUID?
}

export interface SessionTree {
  roots: TreeNode[];
  /** Payloads by uuid; duplicated tree nodes share one payload. */
  entries: Record<string, SessionEntry>;
}

/** Forest semantics: raw parentUuid edges give the base forest; each boundary
 *  node is attached as a child of its logicalParentUuid entry; the boundary's
 *  relinked chain (summary + uuids per anchor shape) hangs under it as
 *  DUPLICATE nodes (same entryUuid, new TreeNode). Relink cycles are unrolled
 *  linearly: a uuid revisited within one boundary chain gets another duplicate
 *  node. Exact node/edge details for boundary substructure to be finalized (see
 *  IMPLEMENTATION IDEAS). */
// TDC: What is the "logicalParentUuid"? When we're doing something like regular compaction, I guess it should be the last message before the compaction. When we're doing suffix summarization, I guess we don't need a boundary at all because we can use the upToMessageId trick above. When we do make an unusual boundary, I guess the logical parent should be the parent of the anchorUuid (when different from the boundary) or the parent of the first preserved uuid (when anchorUuid matches the boundary? If we use this rule, we have to make sure that our summary message get the correct parentUuid so that the constructed trees are correct. We should also confirm that we get sensible trees for native compaction and for the "from" and "up_to" cases (for "from", the logical parent is the parent of the first message in the summarized segment, and for "up_to", the logical parent is the last message of the summarized segment).
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
//   buildBoundaryEntries + appendSessionEntries → restartQuery(sessionId) →
//   verify via getSessionMessages → SetContextResult
```

```ts
// src/core/sdk-commands.ts — CLI wiring
// get-entries, get-tree: bareRequestCommand.
// set-context: parameterized command; positional uuids, --summary <text>,
// --anchor <summary|boundary> (follows existing parameterized patterns).
```

## Edge cases

- `set-context` while busy → error (criterion 5). No implicit waiting.
- Unknown uuid in `uuids` → error before any file mutation (criterion 4).
  (A missing/duplicate uuid that reached the loader would silently produce a
  summary-only context — validated up front instead.)
- Empty `uuids` with `summaryText` → allowed: context becomes the summary
  alone. Empty `uuids` without `summaryText` → error (nothing to load).
- `anchor: "summary"` without `summaryText` → error (nothing to anchor on).
- Duplicate uuids in the list → error (loader silently skips the relink).
TDC: Really? I thought duplicate uuids in the list is acceptable. Did we verify experimentally that the loader silently skips?
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

- **Assumption to verify before implementation** (deliberately deferred): a
  boundary with NO summary entry and `anchorUuid` = the boundary's own uuid
  loads correctly (pure-navigation case). Every derisk experiment had a
  summary entry. One p2-style experiment; if it fails, fall back to writing a
  stub summary entry and make `summaryText` effectively defaulted.
  TDC: We should be able to do this without injecting a boundary at all; see above.
- Boundary entry construction mirrors the known-working recipe
  (FINDINGS.md): `type:"system"`, `subtype:"compact_boundary"`,
  `parentUuid:null`, `logicalParentUuid` = current active leaf,
  `compactMetadata.trigger:"manual"`, `preservedMessages:{anchorUuid, uuids,
  allUuids}`; summary entry `type:"user"`, `parentUuid` = boundary uuid,
  `isCompactSummary:true`. Fields like preTokens/postTokens are not
  individually ablated — keep writing plausible values.
  TDC: wait a second, we get to just *set* logicalParentUuid in the message we create. Of course. Ok, that answers my question above.
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
  TDC: to enforce some kind of consistency between SDK and jsonl, should we waitForEntryOnDisk with the last entry uuid, then read the jsonl file, and only return everything up to and including that last entry uuid?
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
- [ ] Experiment: no-summary boundary (anchor = boundary uuid, no summary entry)
- [ ] Implementation
