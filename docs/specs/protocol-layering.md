# Protocol layering: acyclic `protocol/`, `agent-state/`, `protocol-client/`

Follow-up from the entry-views review round and the first dependency-cruiser
run (2026-09-24). Context: `docs/follow-ups/format-tui-layering.md` (the
wider tui → format → core layering, done separately),
`docs/follow-ups/barrel-boundary-eslint-generator-spec.md` (barrel
convention this spec follows: public surface in `index.ts`, siblings
import each other directly, never their own barrel).

# SPEC

## Problem

`npx dependency-cruise src --include-only "^src"` reports 89 `no-circular`
violations (type-only edges count: `tsPreCompilationDeps`). Every path runs
through one of:

1. `core/agent-state/agent-state.ts` defines the `AgentState` type _and_
   `nextAgentState`, which imports the fold pieces that import the type.
2. `core/agent-state/session-state.ts` holds the `SessionState` type and two
   fold steps over `AgentState` (`withSession`, `withoutFile`), so the two
   type files import each other.
3. `core/protocol.ts` (876 lines) mixes the wire schema with runtime code
   that depends on agent-state (`ProtocolClient` runs `nextAgentState`;
   `eventClass`/`eventStream` call `classOf`), while the fold needs
   `type AgentEvent` from it.
4. `core/session/file.ts` imports `SetContextResponse` from protocol for
   `buildBoundaryEntries`, dragging `tree/nodes → session/file → protocol`
   into every agent-state cycle.

The fix is structural: three sibling barrels with one dependency direction.

## Definitions

- **Wire type**: a type whose values cross the daemon socket (events,
  requests, responses, and everything they embed — including `AgentState`,
  `SessionState`, `MergeStream`, `TrackerAnomaly`, `AgentActivity`, which
  are the subscribe payload).
- **Fold**: `nextAgentState` and its pieces (`fold-*.ts`, `with-*.ts`,
  `observe-event/`), plus the selectors and classification over
  `AgentState`.
- **Barrel**: a directory whose only external import surface is
  `index.ts` (pure re-exports).

## Target layout

```
core/protocol/            wire schema + pure helpers over it; imports only
                          node/sdk types, core/session, core/tree, core/uuid
core/agent-state/         the fold; → protocol
core/protocol-client/     ProtocolClient, connectWithRetry; → protocol, agent-state
core/protocol-server/     ex-`daemon/`; → protocol, agent-state
```

Dependency order (an eslint/cruiser rule enforces it, see Success
criteria): `protocol ← agent-state ← {protocol-client, protocol-server} ← everything
else`. No barrel imports a barrel to its right.

### `core/protocol/` (new barrel; `protocol.ts` deleted)

| file                 | contents (existing symbols, signatures unchanged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`           | re-exports of everything below that is used outside the barrel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `version.ts`         | `PROTOCOL_NAME`, `PROTOCOL_VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `agent-event.ts`     | `MessageDelivery`, `AgentEvent`, `Unstamped`, `AgentEventRecord`, `eventNodes`, `eventUuid`, `sdkMessageOf`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `agent-state.ts`     | `AgentActivity`, `AgentState` (type only; doc comment moves with it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `session-state.ts`   | `SessionState`, `MergeStream`, `MERGE_STREAMS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tracker-anomaly.ts` | `TrackerAnomaly` (type only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `messages.ts`        | request/response pairs, kept together because `ProtocolRequest`/`ProtocolResponse` are paired unions: `TurnPriority`, `SubscribeAttachment`, `FlagSettings`, `SdkControlMutation`, `SdkControlApplied`, `SdkControlRead`, `SetContextRequest`, `SetContextResponse`, `EntryPayload`, `ENTRY_PAYLOADS`, `GetEntriesSnapshotRequest`, `GetEntriesByUuidsRequest`, `isGetEntriesByUuids`, `GetEntriesResponse`, `GetContextResponse`, `ProtocolRequest`, `ProtocolRequestRecord`, `ProtocolResponse`, `AgentEventSubscription`, `parseWireTreeNodeRef`, `parseSetContextRequest` |

`protocol.test.ts` splits alongside (`protocol/agent-event.test.ts`,
`protocol/messages.test.ts`). No file in `protocol/` imports agent-state,
protocol-client, daemon, format or tui.

### `core/agent-state/` (existing barrel, functions only)

| file                        | change                                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                  | re-exports functions only; adds `eventClass`, `eventStream` from `classification.ts`. It does **not** re-export the wire types: every importer of `AgentState`/`SessionState`/`MergeStream`/`TrackerAnomaly`/`AgentActivity`/`MERGE_STREAMS` is repointed to `protocol/index.ts` |
| `agent-state.ts`            | deleted (the type is in `protocol/agent-state.ts`)                                                                                                                                                                                                                               |
| `next-agent-state.ts` (new) | `nextAgentState(state: AgentState, event: AgentEvent): AgentState` and its seed `initialAgentState(): AgentState`, moved verbatim with the piece imports and the fold's header comment. Named after the thing it provides (barrel file convention: file name = main export)      |
| `session-state.ts`          | keeps `freshSessionState()`; `withSession`, `withoutFile` move to `with-session.ts` (new, same signatures)                                                                                                                                                                       |
| `tracker-anomaly.ts`        | keeps `anomalyReport`, `labeledAnomaly`                                                                                                                                                                                                                                          |
| `classification.ts`         | gains `eventClass(event: AgentEvent): string`, `eventStream(event: AgentEvent): MergeStream` (moved from protocol.ts)                                                                                                                                                            |

The pieces are external to `protocol/`, so they import its types through
`../protocol/index.ts`.

### `core/protocol-client/` (new barrel)

| file                 | contents                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `index.ts`           | re-exports `ProtocolClient`, `connectWithRetry`                                                    |
| `protocol-client.ts` | `ProtocolClient` class, moved verbatim (`PositionedResponse`, `PendingRequest` stay private to it) |
| `connect.ts`         | `connectWithRetry`, moved verbatim                                                                 |

### `core/session/file.ts`

`buildBoundaryEntries` (and its three tests in `file.test.ts`) move to
`core/daemon/set-context.ts` / `set-context.test.ts`, its only caller. The
session-file module no longer imports protocol.

## Success criteria

1. `npx dependency-cruise src --include-only "^src"` reports zero
   `no-circular` violations among `core/protocol/`, `core/agent-state/`,
   `core/protocol-client/`, `core/protocol-server/`; `.dependency-cruiser.cjs`
   enforces the dependency order above at `error` via `DEPENDENCY_DAG`
   (`no-circular` itself stays `warn` until the format-tui-layering
   follow-up clears the remaining cycles). `npm run presubmit` runs the
   cruiser in validate mode.
2. `eslint.config.js` barrel patterns cover `protocol/` and
   `protocol-client/` like `agent-state/` (external deep imports and
   self-import through `index.ts` rejected) until the generator replaces
   them.
3. `npm run check`, `npm run lint`, `npm test` green; no behavior change
   (pure relocation — no signature changes, no logic edits).
4. No file outside a barrel imports a non-`index.ts` file of that barrel.
5. Every moved symbol's doc comment moves with it; header comments of
   `protocol.ts` are split by topic, not duplicated.

## Cost

None at runtime (relocation). Review cost concentrates in: the split of
`protocol.ts` (a 876-line diff; review by symbol table above), and the
importer churn (~31 files for agent-state types, ~29 for protocol.ts —
mechanical `sed`, verify by `check`).

## Non-goals

- The tui/format layering, view moves and tui registry cycles
  (`format-tui-layering.md`).
- Any change to wire semantics, the fold, or the client's behavior.

# IMPLEMENTATION IDEAS

- Order: (1) `buildBoundaryEntries` → set-context (removes the
  `session/file → protocol` edge, shortens every cycle); (2)
  `next-agent-state.ts` + `with-session.ts`; (3) wire types → `protocol/`
  with the `protocol.ts` split and `protocol-client/`; (4) cruiser rules
  to `error` + presubmit hook. Cruise after each step; the count should
  fall monotonically.
- Discovery commands used: `npx dependency-cruise src --include-only "^src"
--output-type json` then list distinct cycles by sorted member set;
  `--output-type archi` for the layer view.
- Importer rewrite: `sed 's#core/protocol\.ts"#core/protocol/index.ts"#'`
  variants per relative depth; `tsc` catches misses.
- Decision log (2026-09-24, chat): layout A (three siblings) over nesting
  agent-state under protocol or protocol-client — the daemon runs the same
  fold, so the fold is shared, not client-side; wire _types_ move into
  protocol (option "c") rather than tolerating type-only cycles with
  `viaOnly: { dependencyTypesNot: ["type-only"] }`, so the graph is
  strictly acyclic without a lint exception.
- ESM/`nodenext`: specifiers stay `…/index.ts`; directory imports are not
  resolvable at runtime.

## Verify before step 3

- `StreamSubscription` (used by `AgentEventSubscription`) and whatever
  `parseWireTreeNodeRef` imports must not import protocol back; if they do,
  they belong in `protocol/` too.
- Enumerate `protocol.ts`'s importers per symbol before the split so each
  `index.ts` re-export list is exact (no `export *`).

## Open (not in SPEC until decided)

- (decided 2026-09-24) `core/daemon/` → `core/protocol-server/`, done in
  the review round below; `daemon.ts` (the process entry) keeps its name.
- (decided 2026-09-24) `next-agent-state.ts` is kept even though the
  wire-type move alone makes the graph acyclic: barrel files are named
  after the thing they provide, so `agent-state.ts` would misname a file
  whose main export is `nextAgentState`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] 2026-09-24 — `agent-state/index.ts` introduced as the barrel surface
      (was `agent-state.ts`); 31 importers repointed; eslint patterns updated;
      test imports siblings directly. Did not reduce the cycle count (cycles
      were not through the barrel) — led to this spec.
- [x] Step 1 (2026-09-24): `buildBoundaryEntries` → `daemon/set-context.ts`;
      the three tests (incl. the append/read round-trip, which builds its
      entries with it) → `set-context.test.ts`. Cruiser: 89 → 82.
- [x] Step 2 (2026-09-24): `next-agent-state.ts` (fold + header comment;
      `agent-state.ts` keeps the two types until step 3); `with-session.ts`;
      eslint's `observeEvent` exception follows `foldEvent`; comments naming
      "agent-state.ts" as the fold repointed. Cruiser: 82 → 39.
- [x] Step 3 (2026-09-24): `protocol/` and `protocol-client/` barrels as
      tabled; `agent-state/index.ts` exports functions only. Cruiser: 39 → 22.
      Deviations from the SPEC tables:
  - `AgentEventSubscription` lives in `protocol-client/protocol-client.ts`,
    not `messages.ts`: it is `StreamSubscription<AgentEvent, AgentState>`
    and events embed `SdkControlApplied` (messages), so placing it in
    messages would make `agent-event.ts ↔ messages.ts` a type-only cycle.
    Its only user is `ProtocolClient.subscribe`; not re-exported.
  - `protocol.test.ts` had no `agent-event` tests: the parse tests are
    `protocol/messages.test.ts`, the client tests (subscribe seed, hello,
    drain, close) are `protocol-client/protocol-client.test.ts`.
  - The ex-`protocol.ts` header comment (record shapes on the wire) heads
    `messages.ts`; `agent-event.ts` has no file comment beyond `AgentEvent`'s.
- [x] Step 4 (2026-09-24), partial: three `forbidden` layer rules at
      `error` in `.dependency-cruiser.cjs` (`from.pathNot` excludes test files:
      tests are unlayered — `protocol-client.test.ts` drives a real
      `daemon/protocol-server`); `npm run depcruise` in presubmit after lint;
      eslint barrel patterns for `protocol/`, `protocol-client/` via a
      `barrelImplementation(dir)` helper. **Not done: `no-circular` → error.**
      The 22 remaining cycles are all outside this spec's Non-goals: tui
      `tool-views/*` and `entry-views/*` registries (13 + 7,
      `format-tui-layering.md`), `core/app.ts ↔ generated/completion.ts`,
      `core/lifecycle ↔ core/spawn ↔ tui/attach`, `daemon/request-handlers ↔
daemon/set-context` (`RequestHandlerDeps` type). Decision (Anton):
      leave `no-circular` at `warn`; flip to `error` when the
      format-tui-layering work clears the rest.
- Review round (2026-09-24, 9891a78):
  - The hand-written layer rules are replaced by rules generated from a
    `DEPENDENCY_DAG` table in `.dependency-cruiser.cjs`: keys are `src/`
    directories or files, values the keys each may import; a key may not
    import another key without a direct edge (`dag-<node>` rules at
    `error`). Nodes today: `core/{protocol, agent-state, protocol-client,
daemon, session, tree}` and the leaf files `uuid.ts`,
    `stream-merge.ts`, `to-non-nullable-usage.ts`, `options.ts`,
    `registry.ts`. Not nodes yet (unconstrained as sources and targets):
    `core/generated`, the loose `core/*.ts`, `format`, `tui` — so
    "protocol imports nothing outside itself" holds only among the nodes
    until format-tui-layering adds the rest.
  - `no-folder-cycles` (`scope: 'folder'`, dependency-cruiser's
    barrel-level cycle check) at `warn`: 59 folder cycles today, nearly all
    through the loose `src/core/*.ts` ↔ `format` ↔ `tui` knot; one is
    `daemon ↔ protocol-client` caused solely by `protocol-client.test.ts`
    (folder scope cannot exclude test files), resolved below.
  - Tests obey the DAG (Anton: no pass for tests). The two integration
    tests that cross the client/server edge moved out of their barrels to
    `src/core/protocol-client.test.ts` and `src/core/protocol-server.test.ts`
    (loose `core/*.ts` is not a node), which also removes the
    `daemon ↔ protocol-client` folder cycle. Daemon tests' `UUID_PATTERN`
    use added the edge `core/daemon → core/uuid.ts`.
  - `core/daemon/` renamed to `core/protocol-server/` (import specifiers,
    `DEPENDENCY_DAG`, living docs; historical specs keep the old paths).
    Barrel (Anton's review): `index.ts` exports `internalRoutes`,
    `startProtocolServer`, `RESPONSE_SENT` — all that non-test and test code
    imports. `scripts/diagnostic/tracker-memory.ts` assembles internals
    directly; `scripts/` is outside the eslint barrel rules by
    construction. `tests/sdk/steer-parallel-tools.test.ts` replayed its
    capture through `queue-model.ts`; SDK tests measure SDK behaviour, so
    it now asserts the stream-level boundary the queue model assumes (new
    `message.id` after every tool_result) directly. `session/` (25
    externally used symbols) and `tree/` (26)
    are namespaces, not interfaces; barrel them, or split `tree/`, after
    format-tui-layering settles their consumers.
  - The DAG is hierarchical: an edge to a key grants its descendants and a
    key may import its ancestors' unlisted contents, so `tui → format →
core` rows can be added above the `core/*` rows once
    format-tui-layering clears the 11 files that violate them today.
  - `toNonNullableUsage` → `src/core/to-non-nullable-usage.ts` (used by
    `agent-state/query-message.ts` and `tree/context-tree.ts`; no longer
    re-exported from agent-state).
  - `sdk-passthrough.ts`: the `isControlMutation`/`isControlRead` guards and
    their exhaustiveness records join the unions they guard in
    `protocol/messages.ts` (re-exported); the Query dispatch
    (`applyMutation`, `persistedOptionsAfter`, `runRead`) moves to
    `daemon/sdk-passthrough.ts`, next to its only caller, keeping the
    SDK-upgrade locality the file header promises (and the
    `sdk-commands.test.ts` coverage parse of that file).
