# Spec: permission asks on the CLI surface

> Status: **implemented 2026-10-05; review rounds 1–2 done (2026-10-06).** Follow-up to
> docs/specs/permission-prompt.md (TUI dialog). Derisk artifacts:
> `docs/derisk/permission-cli/` (`probe-session-state.mjs`, timelines under
> `out/<scenario>.json`).

# SPEC

## Problem

An agent stopped on a permission ask is `activity: "working"` (main-agent
ask) or idle with a live task (a task's ask), so every CLI wait that
assumes the agent eventually stops on its own misbehaves:

- `archive` waits for `idle` and hangs (or times out) on a main-agent ask.
- `prompt` streams until `turn-end` and hangs on an ask. Worse, `turn-end`
  is wrong even without asks: a background subagent outlives the turn's
  `result` and later runs a notification turn the caller never sees.
- `wait`/`tail --until` hang on an ask without saying why.
- Nothing on the CLI can answer an ask, and nothing but `tail`'s snapshot
  line says an agent is waiting on one.

## Definitions

- **Unresolved tool use**: a `tool_use` block seen in an assistant frame
  whose `tool_result` has not arrived, tracked per agent: the main
  agent's, or the live task whose `toolUseId` is the frame's
  `parent_tool_use_id`. A
  background tool call (`Agent`/`Bash` with `run_in_background`) gets its
  `tool_result` at once and continues as a **task**; a foreground call
  stays unresolved until it finishes.
- **Input needed**: no message will be produced without outside input.
  Formally (`isInputNeeded`): every live task has a pending ask or an
  unresolved tool use (else it is generating); every unresolved tool use,
  the main agent's or a task's, is either asking or a live task's spawning
  call (a foreground `Agent` call, nested ones included); and the main
  agent is `isIdle` or has an unresolved tool
  use of its own (it waits on tools rather than generating). An idle agent
  with no tasks and no unresolved tool use is input-needed (so `quiescent`
  implies `input-needed`).
- **Stopped on an ask** (`isStoppedOnAsk`): input needed and at least one
  ask pending — the agent cannot progress until someone answers.

Why not the CLI's own `system/session_state_changed`: it is emitted only
under the undocumented `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, its
`idle` equals our `quiescent`, and its `requires_action` is session-wide
("some ask pends"): the main agent streamed text and finished a `result`
while it held (probe `bg-ask`, `fg-ask`).

## Success criteria

1. `wait`, `tail`, and `prompt` accept `--until input-needed`.
2. **Exit 4.** Every `--until` wait (`wait`, `tail --until`, `prompt`)
   exits 4 as soon as the agent is stopped on an ask — at the seed or on
   any later event — with the pending asks listed on stderr. The ask wins
   over the condition (`--until input-needed` included): exit 0 means
   "prompt next", exit 4 means "answer with `permission-response` next".
   A script waiting on a human answer instead follows `tail --type events`
   until the asks are resolved.
3. **`prompt`.** The default `--until` is `input-needed`, so a caller
   using the default never needs a cursor to see every message. If the
   agent is stopped on an ask (any ask, a background task's included) at
   the seed, the prompt is **not submitted** and the command exits 4. An
   ask arriving after the gate opens stops it with exit 4; one arriving
   after submission but before the gate exits 5 ("prompt queued; stopped on
   a permission ask:", `QueuedBehindAskError`): the prompt runs once the ask
   is answered (a prompt queued behind a main-agent ask is never dequeued).
   After the gate opens, the messages/entries legs wait for the log to
   settle like a met condition, so the asking `tool_use` is printed;
   before it, nothing of ours has printed and the stop is immediate.
4. **`archive`** waits for `input-needed`; if any ask is pending it sends
   `interrupt` (aborts every ask; kills an asking background task —
   verified in tests/sdk/task-stop-under-ask.test.ts) and then waits for
   `quiescent`, then SIGTERMs. One `--timeout` budget covers both waits;
   expiry keeps today's "still busy after Ns; not archived", exit 1.
   `capture-dialogs.ts` stops denying over the socket before archiving.
5. **`permission-response`.** `clauctl permission-response -t <agent> --tool-use-id <id>
<json-or-path>` sends the raw SDK `PermissionResult` (inline JSON or a
   file) as the answer to that ask. `--tool-use-id` is required. Prints
   nothing; a not-pending ask or malformed decision is the daemon's error
   (exit 1). It answers AskUserQuestion too (an allow with
   `updatedInput.answers`; both arrive through `canUseTool`).
   `--feedback <text>` attaches allow feedback, the request's `feedback`
   field (docs/specs/permission-amend-allow.md).
6. **`status`** connects to a live daemon, takes the subscribe seed, and
   prints `input-needed: yes|no` plus one indented `pendingAskLines` line
   per pending ask; `--json` gains `inputNeeded` and `pendingAsks: {
   taskId?: string; request: PermissionRequest }[]`. An
   unreachable daemon prints a warning and omits them.
7. The fold tracks unresolved tool uses: a slow foreground sibling running
   next to an asking tool keeps `input-needed` false until its result
   arrives.
8. SDK tests (`tests/sdk/input-needed.test.ts`) pin the stream facts the
   selector relies on (Type design, last section).

## Type design

### Protocol — `src/core/protocol/`

```ts
// agent-state.ts
export interface TaskState {
  …existing…
  /** The first task_started's spawning call (kept across SendMessage
   *  resumes) = its frames' parent_tool_use_id. */
  readonly toolUseId?: string;
  /** Live while pending/running/paused; an ended task stays until the
   *  query session changes. */
  readonly status: NonNullable<SDKTaskUpdatedMessage["patch"]["status"]>;
  /** Emptied, like pendingPermissions, when the task ends. */
  readonly unresolvedToolUses: readonly string[];
}
export interface AgentState {
  …existing…
  /** The main agent's tool uses awaiting their tool_result, arrival order. */
  readonly unresolvedToolUses: readonly string[];
}
// initialAgentState(): unresolvedToolUses: []

// messages.ts — the "permission-response" request, unchanged (renamed to
// can-use-tool and back during review; see WORK LOG)
| { type: "permission-response"; toolUseId: string; decision: PermissionResult };

// version.ts
export const PROTOCOL_VERSION = 4;
```

### Fold — `src/core/agent-state/`

```ts
// with-unresolved-tools.ts (new); foldSdkMessage calls it on every message.
/** tool_use blocks join, tool_result blocks leave, the unresolved tool
 *  uses of the frame's agent (main, or the live task its
 *  parent_tool_use_id names); frames of no live task are not tracked. */
export function withUnresolvedTools(
  state: AgentState,
  message: SDKMessage,
): AgentState;
```

Stale-entry guards (a `tool_result` that never arrives would keep
`input-needed` false forever): the main agent's top-level `result` empties
`AgentState.unresolvedToolUses` (a turn cannot end with its own tool uses
open); a task's list empties when it ends (terminal `task_updated`, or a
`task_notification` on a live task, `stopped` → `killed`). A query session
change (`/clear`, resume elsewhere) clears `tasks`.

`task_started` for a known `taskId` (`SendMessage` resumes it) sets it
`running` and keeps its `toolUseId`, `pendingPermissions` and
`unresolvedToolUses`, replacing the other fields.

### Selectors — `src/core/agent-state/selectors.ts`

```ts
/** pending, running or paused; replaces raw `tasks` reads in the
 *  selectors, footer.ts and format/events.ts. */
export const liveTasks = (state: AgentState): readonly TaskState[];
/** Definitions, "Input needed"; one pass over live tasks, then the main
 *  agent's unresolved tool uses. */
export const isInputNeeded = (state: AgentState): boolean;
/** Cannot progress until someone answers an ask. */
export const isStoppedOnAsk = (state: AgentState): boolean =>
  isInputNeeded(state) &&
  (state.pendingPermissions.length > 0 || liveTasks(state).length > 0);
```

### Until — `src/core/until.ts`, `src/app.ts`

```ts
stateConditions: { idle: isIdle, quiescent: isQuiescent, "input-needed": isInputNeeded }

/** app.ts maps it to exit 4. Message: "stopped on a permission ask:" + pendingAskLines. */
export class StoppedOnAskError extends Error {
  constructor(state: AgentState);
}
```

The stopped-on-ask check stays in clauctl (not in pictl's synced
until-engine): each `--until` handler checks `isStoppedOnAsk` first,
then the condition.

### Formatting — `src/format/events.ts`

```ts
/** One `[pending permission <toolUseId>: <tool summary>]` line per pending
 *  ask (allPendingAsks order, a task's suffixed `(task <taskId>)`) —
 *  extracted from agentStateChunk, which keeps using it. */
export function pendingAskLines(state: AgentState): string[];
```

### Commands — `src/commands/`

- `wait.ts`, `tail.ts` (`tailEvents`): handler returns stop on condition
  met or `isStoppedOnAsk`; the latter throws `StoppedOnAskError` after
  `runStream` returns. Only with `--until` (bare `tail` unchanged).
- `tail.ts` `UntilSettlement`: `observe`/`metAtSeed` also latch on
  `isStoppedOnAsk` (checked before the condition) and expose
  `readonly stoppedOnAsk: boolean` once settled; `tailLive` and
  `promptLive` throw `StoppedOnAskError` when it is set (implemented as
  `throwIfStoppedOnAsk()`; see Implementation-Time Decisions).
- `prompt.ts`: default condition `{kind: "state", name: "input-needed"}`.
  The `subscribe` wrappers check `isStoppedOnAsk(subscription.seed)`
  before `submitPromptFn` and skip submission when it holds; `onSeed`
  then stops and the command throws `StoppedOnAskError`. `onEvent` checks
  `isStoppedOnAsk` before the gate.
- `lifecycle.ts`: `waitUntilIdle` → `waitForCondition(client, condition,
deadline)`; `stopRunningAgent` waits for `input-needed`, and when
  `allPendingAsks(state).length > 0` (from `StreamResult.state`) sends
  `interrupt` and waits for `quiescent` with the remaining budget
  (implemented as one stream, `waitUntilStoppable`; see
  Implementation-Time Decisions).
- `sdk-commands.ts`: `"permission-response": commandOneTarget<{toolUseId:
string}, [string]>` (required `--tool-use-id`, positional
  `<json-or-path>`); `parseSettingsArg` generalized to
  `parseJsonObjectArg(value: string, what: string): Record<string,
unknown>` for its three users.
- `inspect.ts`: `AgentProbe` gains `inputNeeded?: boolean` and
  `pendingAsks?: string[]` (from `pendingAskLines`), filled for a live pid
  from one subscribe seed; the file header's "no live socket probing"
  is updated.
- `src/tui/interactive-mode.ts`: request type renamed only.

### SDK tests — `tests/sdk/input-needed.test.ts`

1. A foreground subagent's `task_started` has `is_backgrounded: false` and
   `tool_use_id` = the Agent call; its ask carries `agentID`.
2. A sibling issued after an asking tool gets its `tool_result` only after
   the ask resolves.
3. A background subagent outlives the top-level `result`, then a
   notification turn (`init` … `result`) follows.
4. `SendMessage` to a finished subagent re-emits `task_started` with the
   same `task_id` (and the SendMessage call as `tool_use_id`); the resumed
   subagent's frames still carry the first Agent call as
   `parent_tool_use_id`, and SendMessage's `tool_result` arrives before
   the resumed subagent's tool results.
5. An interrupt mid-tool yields a `tool_result` for every unresolved tool
   use (else a stale entry blocks `input-needed`).
6. A background Bash yields `task_started` and an immediate `tool_result`.
7. A subagent can launch its own subagent: the nested Agent call's frame
   has the outer Agent call as `parent_tool_use_id`, and the nested task's
   `task_started` names the nested call.
8. (a) A background nested subagent outlives its parent, which ends
   first. (b) Stopping a task ends its nested task. Haiku often disobeys
   8a's prompt, so 8a runs on sonnet and first asserts the prompt was
   followed (outer subagent in the foreground, nested one ran Bash), failing
   with "model did not follow the prompt" otherwise.

## Data flow

```
CLI frames ─► hub fold: tasks, asks, unresolvedToolUses ─► snapshot + events
  ─► client runStream fold ─► handler: isStoppedOnAsk? → exit 4, asks on stderr
                                       condition met? → exit 0
  ─► caller: clauctl permission-response ─► "permission-response" request ─► broker.respond
  ─► permissionResolved + resumed frames ─► next prompt/wait
```

## Cost

- `unresolvedToolUses` rides every snapshot: the tool uses in flight (a
  handful).
- `isInputNeeded` builds one small set per event in every client running
  an until-wait (one pass over tasks, one over unresolved tool uses);
  `isStoppedOnAsk` adds a length check. `prompt` and `--until
  input-needed` evaluate it twice per event (stop check, then condition).
- `status` opens one socket per live target (concurrently), each bounded
  by `SOCKET_CONNECT_DEADLINE_MS` for connect and again for the seed.

## Edge cases and non-goals

- **Known non-goal: waiting through a human answer.** Exit 4 is
  fail-fast; a script that wants to wait while a TUI user answers follows
  `tail --type events` instead.
- **Dormant agents**: `wait`'s and `tail`'s dormant paths are unchanged
  (no live asks); `status` shows no input-needed line for them.
- **Mixed versions** are rejected at connect (protocol 4).
- **Never-ending background tasks** (a dev server, a paused task) keep
  `input-needed` false, so `prompt`'s default and `archive` wait until
  `--timeout` (forever without one). Kept as defined (Anton, 2026-10-05).
- **`SendMessage` to a still-running foreground subagent** re-emits
  `task_started` with the SendMessage call's id, so the original Agent
  call stops being task-backed and `input-needed` stays false until it
  resolves. Needs parallel tool calls; not handled.
- **A stop on an ask that then fails to settle** (socket close or
  `--timeout` during the settle wait) still exits 4: the ask was observed.
- **Deferred — immediate follow-up spec: AskUserQuestion TUI dialog**
  (options with descriptions, multi-select, free text, as captured in
  `docs/derisk/permission-prompt/out/askuser.claude.txt`). Its CLI answer
  already works through `permission-response`.

# IMPLEMENTATION IDEAS

- Probe timelines (haiku, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for
  the second round): `main`, `bg-ask`, `bg-noask`, `parallel`,
  `parallel-read-first`, `fg-ask`. Results were emitted in tool_use order;
  with the Read issued first, its result arrived before the Bash ask.
- `SendMessage`-resumed subagents: `task_started.tool_use_id` is the
  SendMessage call, while the subagent's frames keep the original Agent
  call's `parent_tool_use_id` — `TaskState.toolUseId` does not link a
  resumed task to its frames. `isInputNeeded` does not need that link.
- SDK test 2 depends on haiku issuing the asking tool first; prompt
  wording from probe `parallel`.
- Exit 4 in the `wait`/`tail` handlers can be a shared helper in
  `until.ts` if the three call sites look identical.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- 2026-10-05: Derisked with Anton (probe `docs/derisk/permission-cli/`);
  type design approved; spec written.
- 2026-10-05 critique: `prompt`'s default `input-needed` cannot fire
  before its own turn starts — an accepted querying prompt makes
  `activity` `pending` (next-agent-state.ts activity model), so `isIdle`
  is false from acceptance on.
- 2026-10-05: Anton approved; stale-entry guards decided (clear main-owned
  entries at `result`, all on Query replacement — Type design, Fold).
  `docs/follow-ups/permission-cli.md` deleted, references repointed here.
- 2026-10-05: Implemented. Anton chose ask-before-condition (Option A).
  Unit tests: fold + selector case table (input-needed.test.ts); wait,
  tail, permission-response, status (stream-commands.test.ts); archive
  (lifecycle.test.ts). SDK tests 1–6 pass (SDK 0.3.280, haiku); case 5
  split into a running tool (interrupted at its first `tool_progress`,
  ~30 s in) and a pending ask.
- 2026-10-05: Review round 2 implemented (see "Review round 2"): exit 5,
  structured `pendingAsks`, per-task unresolved tool uses, ended tasks
  kept until the query session changes, `liveTasks`, renames. Unit tests
  updated (input-needed.test.ts, agent-state.test.ts, prompt.test.ts,
  stream-commands.test.ts). SDK tests not rerun: they assert raw stream
  facts, which the fold refactor does not change.
- 2026-10-05: SDK case 4 extended, case 7 added (both pass). Case 4
  confirms the per-task design; case 7 refutes "subagents cannot launch
  subagents" (open question 5). README Quickstart no longer pins a
  permission mode.
- 2026-10-06: Open question 5 decided and implemented: nested-aware
  `isInputNeeded` plus four selector cases. SDK cases 8a/8b added and
  passing (8a failed once when haiku did not follow its instructions).
- 2026-10-06: 8a failed again on haiku (outer subagent backgrounded,
  nested one skipped Bash). It now runs on sonnet behind a prompt-followed
  check; 3/3 passes. Full SDK file otherwise green.

## Implementation-Time Decisions

- **Query-replacement guard → "no live task" guard** (superseded in
  round 2 by per-task lists emptied when the task ends). No event marks a
  Query replacement (`restartQuery` emits nothing the fold sees), so a
  literal clear needs a new `AgentEvent` kind. Instead
  `withoutOrphanedSubagentToolUses` drops subagent entries when the last
  task leaves (every subagent frame belongs to a live task), and
  `withoutMainToolUses` drops main entries at `result`. `set-context`
  restarts only when quiescent, so both guards have fired before any
  replacement. Two extra exports in `with-tool-uses.ts`. _Flagged for
  Anton._
- **Duplicate `task_started` fix at the call site**, not in `withTask`:
  the ask folds update `pendingPermissions` through `withTask`, so
  `withTask` cannot keep the old list. The `task_started` fold carries
  the live task's asks over.
- **`StoppedOnAskError` lives in `src/commands/stopped-on-ask.ts`**, not
  `core/until.ts`: its message uses `pendingAskLines` (`src/format/`),
  and `core/` never imports `format/`.
- **`untilStop(met, state): "met" | "stoppedOnAsk" | undefined`** in
  `stopped-on-ask.ts`: the one stop rule shared by `wait`, `tailEvents`,
  `UntilSettlement`, and `promptEvents` (the shared helper IMPLEMENTATION
  IDEAS anticipated). `UntilSettlement` exposes `throwIfStoppedOnAsk()`
  instead of a public `stoppedOnAsk` field: both callers only throw, and
  the error needs the settled state the settlement already holds.
- `prompt` pre-gate stop: before our dequeue nothing of ours has printed,
  so the stop throws at once (no settle wait).
- **`archive`: one two-phase stream (`waitUntilStoppable`)** instead of
  `waitForCondition` twice: a `ProtocolClient` subscribes once, and one
  stream gives one `--timeout` budget for free. The handler sends
  `interrupt` (awaited; async handlers are supported) on reaching
  input-needed with asks, then waits for quiescent.
- `status` prints `input-needed: yes|no` then the `pendingAskLines`
  (indented) rather than `ask: <id> <summary>` — one ask format
  everywhere. Probed in `status` only (`withInputNeeded`); `list` stays
  registry-only.
- `pendingAskLines(state, options = DEFAULT_MESSAGE_FORMAT_OPTIONS)`:
  `askDetail` needs `maxToolArgChars`; the snapshot passes its options.

- **Ask before condition (Anton, Option A).** Criterion 2 originally
  checked the condition first, contradicting criterion 3 (`prompt`'s
  default `input-needed` would exit 0 on an ask). Anton chose: a pending
  ask wins over every condition; criterion 2 reworded, `untilStop`
  checks `isStoppedOnAsk` first.

- **Post-implementation review fixes.** `archive` interrupts each _new_
  set of asks (tracked by tool use id) and otherwise waits for
  input-needed, which with no ask pending equals quiescent. This replaces
  the interrupt-once latch, which hung when a prompt queued behind the
  ask asked again after the interrupt. A failed interrupt warns and
  SIGTERMs (teardown cancels the asks). `status` bounds the subscribe
  reply by `SOCKET_CONNECT_DEADLINE_MS`. The orphaned-subagent guard also
  runs at `result`, so subagent entries folded with no live task do not
  persist. `UntilSettlement`'s exit-4 message lists the asks at the stop,
  not at settlement. `isInputNeeded` is single-pass;
  `isStoppedOnAsk` checks for asks by length (input-needed implies every
  task asks).

- **Round 2: a task's asks are emptied when it ends**, like its tool
  uses. Removing the task dropped them before; an ended task's ask can no
  longer be answered. `withPermissionRequested` routes only to live
  tasks (an ask naming an ended task is the existing anomaly).
- **Round 2: a task's tool use stalls only on that task's own asks**, so
  `isInputNeeded` stays one pass over live tasks. **Wrong: SDK case 7
  shows subagents can launch subagents.** Replaced by the open question 5
  rule (Definitions).
- **Round 2: a `task_notification` changes only a live task**: one that
  arrives after a terminal `task_updated` does not overwrite its status.
- **Round 2: `pendingAskLine(request, taskId)`** (format/events.ts) is
  shared by `pendingAskLines` and the status text output, which formats
  the probe's structured `pendingAsks`.
- **Round 2: exit 5 is `QueuedBehindAskError extends StoppedOnAskError`**,
  header "prompt queued; stopped on a permission ask:". Both extend
  pictl's `ExitCodeError` (synced `core/generated/util.ts`) and carry
  their `exitCode` (4, overridden to 5); `determineExitCode` returns an
  `ExitCodeError`'s `exitCode`, else 1.

## Open questions for Anton (from the review)

5. ~~Nested subagents are never input-needed~~ — decided: the rule
   below, now in Definitions. Ended tasks are ignored even when they have
   a live child; `parentTaskId` (display only) is deferred to
   docs/follow-ups/subagent-activity.md. Original analysis (SDK case 7): An outer
   task waiting on an asking nested task has no ask of its own, so
   "every live task has a pending ask" fails, as it did before round 2.
   Proposed definition: a live task blocks input-needed if it has neither
   an ask nor an unresolved tool use (it is generating). Every unresolved
   tool use of any agent must be an ask or a live task's spawning call. One
   pass over live tasks collects the stalled set and the unresolved ids,
   then one check over those ids.

6. ~~Never-ending background tasks~~ — decided: keep as defined
   (Edge cases).
7. ~~`prompt` exit 4 ambiguous about submission~~ — decided: exit 5
   when queued (Review round 2).
8. ~~`status --json` `pendingAsks` as strings~~ — decided: structured
   (Review round 2).
9. ~~Naming~~ — decided: `StoppedOnAskError` in `stopped-on-ask.ts`
   (was `InputNeededError` in `input-needed.ts`), message header
   "stopped on a permission ask:".

## Review round 2 (Anton, d7d832d) — decisions

- Request + subcommand renamed back to `permission-response` (pairs with
  permission request). `PROTOCOL_VERSION` stays 4: the snapshot shape
  changed since 0.2.1 regardless of the name.
- Exit 5: `prompt` stopped on an ask after its prompt was queued (exit 4
  = not submitted). `status --json` `pendingAsks?: { taskId?: string;
  request: PermissionRequest }[]`.
- `foldSdkMessage`: tool accounting called unconditionally
  (`withUnresolvedTools`); `withQueryEvidence` → `withModelAndUsage`;
  reassign `state` instead of `stateWithEvidence`.
- `lifecycle.ts`: `interruptNewAsks(state)` side effect split from the
  predicate `isInputNeeded && !isStoppedOnAsk`;
  `waitUntilStoppable` → `interruptAsksUntilStoppable`.
- `a = b != c` handler expressions → statements.
- AGENTS.md naming rule added (noun phrases; adjectives read as booleans).
- **Per-task unresolved tool uses; tasks kept until the session changes**
  (approved type design): `TaskState.status:
  NonNullable<SDKTaskUpdatedMessage["patch"]["status"]>` (a
  `task_notification` on a still-running task maps `stopped` → `killed`);
  `TaskState.toolUseId` stays the first `task_started`'s call (a
  re-announce no longer replaces it) = its frames' `parent_tool_use_id`;
  `TaskState.unresolvedToolUses: readonly string[]` (cleared when the
  task ends); `AgentState.unresolvedToolUses: readonly string[]` is
  main-agent only (cleared at `result`); `UnresolvedToolUse` deleted. One
  selector `liveTasks(state)` (running/paused/pending) replaces raw
  `tasks` reads in isQuiescent, isInputNeeded, allPendingAsks, footer,
  events. A session change (`/clear`, resume elsewhere) clears `tasks`.
  Earlier sketch: `TaskState` keeps its metadata after it ends
  (for docs/follow-ups/subagent-activity.md), gains the Agent call id its
  frames carry as `parent_tool_use_id` and its own unresolved tool uses;
  `AgentState.unresolvedToolUses` becomes main-agent only. Removes the
  orphan guard and the parentToolUseId check in `isInputNeeded`.

## Tasks

- [x] Types + stubs compile (protocol, fold, selectors, until, format)
- [x] Fold: `withToolUseFrame`, guards, `withTask` duplicate id
- [x] Fold unit tests
- [x] Selectors `isInputNeeded`/`isStoppedOnAsk`
- [x] Selector case table
- [x] `StoppedOnAskError`, exit 4
- [x] Round 2: `QueuedBehindAskError`, exit 5 (`prompt` only)
- [x] Round 2: structured `status --json` `pendingAsks`
- [x] Round 2: per-task fold, `liveTasks`, session change clears tasks
- [x] `wait`/`tail --until`
- [x] `UntilSettlement`; `prompt` default + refusal
- [x] `archive` (`lifecycle.ts`); drop capture-dialogs workaround
- [x] `permission-response` command
- [x] `status` live probe
- [x] Command unit tests
- [x] SDK tests `tests/sdk/input-needed.test.ts`
