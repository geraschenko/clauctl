# Phase 0: `src/core/agent-state/` directory split

> Work log for phase 0 of docs/specs/query-pending-list.md (Type Design,
> "Phase 0"). Status: **implemented, awaiting commit** (2026-09-18).

## Scope

A pure move: `src/core/agent-state.ts` (807 lines) becomes the directory
`src/core/agent-state/` laid out as the spec's file table, with
`agent-state.ts` the only file imported from outside it, enforced by an
ESLint `no-restricted-imports` rule. Every symbol keeps its name,
signature and doc comment; every test keeps its assertions. No behaviour
change; committed on its own before phase 1.

Out of scope: any change the later phases make (`SessionState.resolved`,
`deliveredMessages` removal, the dequeue fold). If a move tempts a
cleanup, note it under Deferred below instead.

## Plan

1. Create the directory and split the source by the spec's table. Each
   sibling gets exactly the imports it uses; the header comment of the
   old file (the fold's contract: "anomaly describes the event just
   folded", the prompt-visibility bookkeeping) moves to
   `agent-state/agent-state.ts` unchanged. Symbols that are private today
   and needed by a sibling become exports of their sibling (not of
   `agent-state.ts`): `observeOn`, `withSession`, `withoutFile`,
   `withAnomalies`, `foldQueryMessage`, the fold functions, `isQuerying`,
   `queryingCount`, `MERGE_STREAMS`, `EMPTY_MERGE`.
2. `agent-state/agent-state.ts` defines `AgentState`, `AgentActivity`,
   `initialAgentState`, `nextAgentState`, `foldEvent` (the switch),
   `withObservedPermissionMode` (used by two cases only) and re-exports
   the public surface: `MergeStream`, `TrackerAnomaly`, `SessionState`,
   `freshSessionState`, `querySession`, `leaf`, `lastUsage`, `settled`,
   `sessionSettled`, `describeSession`, `SETTLE_TIMEOUT_MS`, `isIdle`,
   `classOf`, `excludedFromSession`, `excludedFromQuery`,
   `toNonNullableUsage` — exactly today's export list, verified by
   diffing `grep ^export` before and after.
3. Move `src/core/agent-state.test.ts` to
   `src/core/agent-state/agent-state.test.ts`; its imports become
   `./agent-state.ts`. Tests of a sibling's private helper (if any) may
   import the sibling directly — the lint rule allows imports from
   inside the directory.
4. Repoint the 26 importers (`grep -rl 'agent-state\.ts"' src tests`,
   excluding the directory itself): `../agent-state.ts` →
   `../agent-state/agent-state.ts`, etc.
5. `eslint.config.js`: add the spec's `no-restricted-imports` rule to
   the existing rules block. Verify it fires by temporarily importing a
   sibling from `src/core/tail.ts`, then revert.
6. Docs that name the path (`docs/architecture.md`, `docs/protocol.md`,
   `docs/stream-merging.md`, `docs/user-message-tracking.md`, and the
   specs that reference `src/core/agent-state.ts`): update the path
   text only where it points a reader at the file; leave historical
   spec text alone.
7. `npm run presubmit` (treefmt quirk: re-run once if it reports
   reformatting). Then hand Anton the file list; the move is
   `git add -A src/core/agent-state src/core/agent-state.ts …` on his
   side (the old files are deleted from the working tree, not
   `git mv`ed — git is read-only for the agent).

## Implementation-Time Decisions

- `withObservedPermissionMode` lives in its own sibling,
  `observed-permission-mode.ts` (not in the spec's table). Plan step 2
  put it in `agent-state.ts`, but `fold-sdk-message.ts` (init/status)
  needs it too, and importing it from `agent-state.ts` would make the
  switch file and a fold import each other at runtime. Type-only
  imports of `AgentState` from `./agent-state.ts` are the siblings'
  only back-references; they are erased, so the runtime graph is
  acyclic.
- The extracted case signatures:
  `foldUserMessageQueued(state, id, message)`,
  `foldUserMessageDequeued(state, event)` (the dequeue reads `ids` and
  `delivery`, mirroring `foldSessionEntry`'s `Extract<AgentEvent, …>`
  parameter), `foldSdkMessage(state, message)`. The case comments moved
  with their bodies.
- Two comments said "header comment" / "the activity invariant above",
  which no longer resolve from a sibling; both now say
  "(agent-state.ts header)". No other comment text changed.
- The 27th importer is `scripts/diagnostic/tracker-memory.ts` (the plan's
  grep covered `src`/`tests` only; `npm run check` found it).
- `docs/stream-merging.md` points at `classification.ts` for the two
  predicates (a reader pointer, not an import); the other docs point at
  `agent-state/agent-state.ts`.
- `MERGE_STREAMS` is exported from `session-state.ts` (its
  `freshSessionState` needs the empty merge; `observe-on.ts` needs the
  stream list); `EMPTY_MERGE` stays private there.

## Deferred

_(none)_

## Verification

- Runtime export names of `agent-state/agent-state.ts` equal the old
  file's (`Object.keys` of both modules diffed: identical); the five type
  exports (`AgentActivity`, `AgentState`, `MergeStream`, `SessionState`,
  `TrackerAnomaly`) checked by hand.
- `git diff -M --stat` reports the test file as a rename (3 import lines
  changed).
- Lint rule verified to fire: a temporary
  `import { observeOn } from "./agent-state/observe-on.ts"` in
  `src/core/tail.ts` produced the `no-restricted-imports` error; reverted.
- Presubmit green (679 tests); one treefmt re-run for the reformatted
  import lines, as expected.

# WORK LOG

- [x] Steps 1–7 done 2026-09-18
- [x] Anton commits phase 0 (2026-09-18)
