# Spec: Phase 1 — Lifecycle Core (initial implementation)

> Status: **ready to implement.** Read `docs/overview.md` first, then the broader
> `docs/specs/lifecycle-and-sdk-commands.md` (this doc is the implementation-ready
> carve-out of that scaffold's lifecycle half). Grounded against pictl's `src/core/`
> and the SDK `Options`/`Query` types at **0.3.195**.

## SPEC (stable requirements)

Phase 1 delivers the durable-agent substrate: create a long-lived `claude` process,
persist everything needed to talk to it and respawn it, track its session rollovers
and idle state, and stop it cleanly. It includes only a **minimal `sdk.sock`**
(request/response command channel — no stream fan-out, no augmentation; the full
protocol is Phase 2), does not stream to `tail`/`wait` (Phase 3), and has no TUI
(Phase 5). Building the daemon's SDK loop is also the **2a spike** (RISK-1): proving
the daemon-shape loop, the 4-state assistant-state model, and clean teardown.

### Commands (v1 lifecycle surface)

- **`spawn`** — create an agent dir, launch its daemon, which starts a long-lived
  `claude` in streaming-input mode (`query({ prompt: <AsyncIterable> })`), persists
  `agent.json`, and (Phase 2) binds `sdk.sock`. Prints the agent id. `spawn` exits
  only after the daemon signals ready (fd-3 barrier, no sleeps).
- **`list`** — enumerate agents with socket-free status (running / dormant /
  archived), hiding archived by default.
- **`status`** — one agent's detail from on-disk state: id, cwd, tag, current
  session_id, full session history, daemon pid, lifecycle status, `claudeCodeVersion`.
  (Live idle-state and the SDK introspection reads that also back `status` arrive with
  `sdk.sock` in Phase 2; Phase 1 `status` is pid/registry-derived.)
- **`archive`** — stop the process politely (wait until Idle, SIGTERM the daemon,
  SIGKILL escalation), mark the dir hidden from `list`, preserve `agent.json` +
  transcripts for later resume.
- **`gc`** — remove tombstoned / corrupt agent dirs.

**Minimal SDK command channel** (just enough to exercise the success criteria; the
analog of pictl's `rpc-commands.ts`, fleshed out to the full `Query` surface in
Phase 2): `query` (send a turn; `--priority`), `interrupt`, `set-model`,
`set-permission-mode`. These speak a minimal request/response protocol over
`sdk.sock`; the daemon's `SDKMessage` stream is _not_ fanned out to clients in
Phase 1 (observe via `daemon.log` + `agent.json`).

Internal: **`_daemon`** (the per-agent supervisor). Transparent revival of a dormant
agent (`ensureAgentRunning` + `revive.lock`) is ported from pictl and exercised by
respawn; the remaining commands that _implicitly_ revive land in Phase 2.

### On-disk layout (pictl scheme)

```
$CLAUCTL_DIR/<agentId>/
  agent.json     # daemon-only writer; atomic write+fsync+rename
  sdk.sock       # minimal command channel in Phase 1; full protocol in Phase 2
  daemon.log     # daemon stdio
  archived       # CLI-written marker (races-free vs daemon)
  tombstone      # gc marker
  revive.lock    # O_EXCL revival serialization
```

`CLAUCTL_DIR` = `process.env.CLAUCTL_DIR ?? envPaths("clauctl", { suffix: "" }).data`.
The socket-path-length guard is ported (`sdk.sock` is shorter than pictl's `tty.sock`,
so the limit is easier to satisfy). `agentIdError` (safe single path segment) is ported
verbatim.

### `agent.json` / `AgentRecord`

The one substantive change from pictl: `piBin`/`spawnArgs` become a persisted
`Options` subset that is **mutated in place by the DECISION-5 runtime-state merge**.
There is no separate "runtime state" blob — the merged runtime state _is_
`persistedOptions`.

```ts
interface SessionHistoryEntry {
  sessionId: string;
  /** $CLAUDE_CONFIG_DIR/projects/<cwd>/<sessionId>.jsonl — for Phase-3 tail. */
  sessionFile: string;
}

interface AgentRecord {
  id: string;
  createdAt: string;
  cwd: string;
  tag?: string;

  /** Bucket-1 Options, serializable; mutated in place by the DECISION-5 merge. */
  persistedOptions: PersistedOptions;

  /** Full history, dedup-on-reannounce (pictl rule). currentSessionId = last entry. */
  sessions: SessionHistoryEntry[];

  daemonPid: number;
  /** child `claude` pid — best-effort, not on the Query surface; never depended on. */
  claudePid?: number;
  /** claude_code_version from system/init; respawn-across-upgrade diagnostics (RISK-6). */
  claudeCodeVersion?: string;

  /** Derived from path, not persisted (pictl pattern). */
  agentDir: string;
}
```

`readAgentRecord` validates `id: string`, `daemonPid: number`, `sessions: []`, and
`persistedOptions` present; corrupt/missing verdicts unchanged from pictl. `agentDir`
is stripped on write, repopulated on read.

### Options handling — four buckets + drift guard

Every field of the SDK `Options` type is classified into exactly one bucket. The
implementation encodes this as an **exhaustive `Record<keyof Options, OptionBucket>`**,
so an SDK bump that adds or removes a field **breaks the build until it is
classified** — this is the RISK-6 tripwire.

```ts
type OptionBucket = 'persist' | 'code' | 'invariant' | 'respawn';
const OPTION_BUCKETS: Record<keyof Options, OptionBucket> = { /* every field */ };
type PersistedOptionKey =
  { [K in keyof Options]: (typeof OPTION_BUCKETS)[K] extends 'persist' ? K : never }[keyof Options];
type PersistedOptions = Pick<Options, PersistedOptionKey>;
```

**Bucket 1 — persist** (round-tripped in `agent.json`; the serializable config):
`model`, `fallbackModel`, `permissionMode`, `allowedTools`, `disallowedTools`,
`tools`, `toolAliases`, `agent`, `agents`, `cwd`, `additionalDirectories`, `env`,
`extraArgs`, `betas`, `enableFileCheckpointing`, `toolConfig`, `forwardSubagentText`,
`thinking`, `effort`, `maxThinkingTokens`, `maxTurns`, `maxBudgetUsd`, `taskBudget`,
`mcpServers` (serializable entries only — in-process `SdkMcpServer` entries stripped at
write time), `planModeInstructions`, `plugins`, `promptSuggestions`,
`agentProgressSummaries`, `sandbox`, `settings`, `managedSettings`, `settingSources`,
`skills`, `strictMcpConfig`, `allowDangerouslySkipPermissions`, `supportedDialogKinds`,
`systemPrompt`, `title`.

**Bucket 2 — code** (never persisted; re-supplied by clauctl every (re)spawn):
`abortController`, `canUseTool`, `hooks`, `onElicitation`, `onUserDialog`,
`sessionStore`, `sessionStoreFlush`, `stderr`, `spawnClaudeCodeProcess`, and any
in-process `SdkMcpServer` entries inside `mcpServers`.

**Bucket 3 — invariant** (clauctl sets these; not user-tunable):
`persistSession: true` (DECISION-8), `outputFormat: 'stream-json'`,
`includePartialMessages: true` (echo-boundary detection), **`includeHookEvents: true`**
(surface hook lifecycle in the stream; clients filter what they don't want),
`pathToClaudeCodeExecutable` unset + `executable`/`executableArgs` unset (SDK-bundled
binary + default runtime), `loadTimeoutMs` unset (no `sessionStore`), `debug`/`debugFile`
diagnostics. `permissionPromptToolName` is **reserved unset in v1**: per DECISION-3 the
interactive round-trip is deferred, so v1 sets **neither** `canUseTool` nor
`permissionPromptToolName` (the SDK throws if both are set; the mode auto-decides).

**Bucket 4 — respawn** (set by clauctl, not persisted as config):
`resume = currentSessionId` on every respawn. Exception at _initial_ spawn: the user
may pass the `--resume <session-id>` claude flag (→ `Options.resume`) to **wrap an
existing claude session** in a new clauctl agent; the first `system/init` then
announces that session id and seeds the history. `continue`, `forkSession`,
`resumeSessionAt`, `sessionId` are **not** used — respawn continues the _same_
session, it does not fork or start fresh.

### `spawn` conveys Options by parsing `claude`-style flags

The SDK's `initialize()` is a fixed **Options → argv** function (invariants hardcoded;
each modeled field → its flag; `extraArgs: Record<string,string|null>` is the generic
`--flag [value]` escape hatch appended last). clauctl's `spawn` therefore accepts
**`claude`-style flags** and maps them to `Options` — the _inverse_ of that table:

- Flags the SDK models **and clauctl reads/merges/persists** (`--model`,
  `--permission-mode`, `--mcp-config`, `--thinking`, `--settings`, repeatable
  `--add-dir`, …) → their **first-class `Options` field** (bucket 1). Repeatable and
  structured flags _must_ use the field, not `extraArgs` (unique keys can't repeat).
- Any remaining `claude` flag the `Options` type does not model → the **`extraArgs`
  tail**, forwarded verbatim.
- Invariant flags (`--output-format`, `--input-format`, `--verbose`,
  `--include-partial-messages`, `--include-hook-events`, `--no-session-persistence`)
  are **not** user-settable — clauctl owns them (bucket 3); reject/ignore attempts to
  set them.

`spawn` assembles the bucket-1 `PersistedOptions`, then conveys it to the daemon via a
**transient `spawn-options.json` in the agent dir** that the daemon reads and folds
into the `agent.json` it writes (preserving "daemon is the sole `agent.json` writer").
The daemon adds bucket-2 code + bucket-3 invariants at spawn to build the full
`Options` for `query()`.

The daemon sets **`CLAUCTL_AGENT_ID`** in the child env on every (re)spawn (pictl's
`PI_AGENT_ID` pattern). `Options.env`, when set, **replaces** the subprocess env
entirely, so the daemon builds the env as
`{ ...process.env, ...persistedOptions.env, CLAUCTL_AGENT_ID: agentId }`.

### Daemon: the SDK loop, session tracking, assistant state, persistence

The per-agent daemon (ported from pictl `daemon.ts`, but net-new internals — no pty,
an in-process `Query` instead) is the sole `agent.json` writer. It:

1. Reads `spawn-options.json` (or, on respawn, the existing `persistedOptions`), builds
   the full `Options`, and opens `query({ prompt: heldOpenIterable })`.
2. Tracks **`currentSessionId`** = the most-recent `system/init.session_id`, detecting a
   rollover **only when an init's `session_id` differs** (an `init` fires every turn —
   never count inits; `/compact` stays in-session). Appends new sessions to history,
   dedup-on-reannounce, and captures `claudeCodeVersion` from `init`.
3. Derives the **4-state assistant state** (below).
4. **Persists mutable runtime state on mutation** (DECISION-5): whenever a control
   method changes a merge field, folds the new value into `persistedOptions` and queues
   an `agent.json` write. (In Phase 1 the daemon issues these itself; in Phase 2 they
   arrive from `sdk.sock` clients.)
5. Tears down via `query.close()` on SIGTERM/SIGINT and confirms no orphaned child
   `claude` (RISK-3 — verified by this spike). `close()` is synchronous/`void`.

Agent.json writes are serialized through a promise chain (pictl pattern); session and
merge events can arrive faster than a write completes.

### Assistant state (4-state)

There is no `idle` `SDKStatus`; the daemon derives the assistant's state. `activity`
and `queueDepth` are **independent** and must not be conflated (`activity` = SDK
evidence; `queueDepth` = our own echo bookkeeping, since the SDK never echoes user
turns back).

```ts
type AssistantActivity = 'idle' | 'pending' | 'working' | 'compacting';
interface AssistantState { activity: AssistantActivity; queueDepth: number; }
const isBusy = (s: AssistantState) => s.activity !== 'idle' || s.queueDepth > 0;

// The augmented event stream (DECISION-6): every SDK message, plus the events the
// SDK should emit so an observer can follow what is happening. The tracker consumes
// exactly the stream Phase-2 `sdk.sock` clients will see.
type SdkEvent =
  // A runnable turn was injected. `priority` as sent (absent = idle-time default);
  // `now` while busy means the current turn's terminating `result` arrives early —
  // the tracker needs this, and observers can't apply the placement rule without it.
  | { kind: 'turnAccepted'; priority?: 'now' | 'later' }
  | { kind: 'compactSent' }       // /compact issued while Idle
  | { kind: 'interruptSent' }
  | { kind: 'sdkMessage'; message: SDKMessage };

function nextAssistantState(state: AssistantState, event: SdkEvent): AssistantState;  // pure
```

Transitions (pinned empirically by this spike; integrates the echo-placement
findings, `docs/derisk/echoed-message-placement/FINDINGS.md`):

- accept a turn while **Idle** ⇒ **Pending**. Accept a runnable turn while busy
  (`now`, or a queued `later`) ⇒ increment `queueDepth`. `queueDepth` counts only
  turns the echo-placement rule says will actually run as turns — never a
  `next`/default-while-busy, which the CLI demotes to an in-turn `<system-reminder>`
  steer that produces no `result`.
- first `SDKAssistantMessage` for the turn ⇒ **Working** (unless Compacting).
- `result` ⇒ decrement `queueDepth` for the completed turn; then **Pending** if
  `queueDepth > 0` (a surviving queued turn — e.g. a `later` — is predicted to run
  next, but the SDK hasn't confirmed it started), else **Idle**. If it was Compacting,
  the compaction is now done (same Pending-vs-Idle rule applies). Conceptually Pending
  always means: a turn is accepted and predicted to run, without SDK confirmation yet.
- `/compact` (only valid when **Idle**; never as a queued turn) ⇒ **Compacting** on
  send. `SDKCompactBoundaryMessage` arrives when compaction _finishes_, so Compacting is
  exited by the subsequent `result`, not the boundary message.
- `interrupt()` — state unchanged when _sent_; the transition happens at the
  terminating `result` per the rule above (subtype alone doesn't flag the interrupt —
  the daemon remembers it sent one).

The `result` rule gives the invariant `activity === 'idle' ⇒ queueDepth === 0`, so
`isBusy` reduces to `activity !== 'idle'`; the defensive two-clause definition is kept
in case the tracker's beliefs and the stream ever disagree.

### Respawn (RISK-3)

Recipe = **merged `persistedOptions` + `resume: currentSessionId`** in a fresh process.
Requirements (all must hold — from `docs/derisk/resume-persistence/FINDINGS.md`):

1. **Same config dir + cwd.** `resume` finds the transcript by config dir; the MCP
   disable state is keyed `.claude.json`→`projects[<resolved-cwd>].disabledMcpServers`.
   Both travel with persisted `env`+`cwd`, so re-passing `persistedOptions` satisfies
   this. ("Same cwd" = the path the CLI _resolves_ to — worktrees resolve to the git
   main path.)
2. **Re-pass merged `Options`.** `resume` restores the _conversation_ but only some
   _session config_: it drops `permissionMode` and dynamic `mcpServers` (must merge),
   carries `model` (merge anyway so clauctl owns it explicitly). Merge is correct even
   if the SDK asymmetry flips on a bump (RISK-6).
3. **Re-apply after init** the runtime controls with **no `Options` path**:
   `setMcpPermissionModeOverride(server, mode)` per server (ephemeral, persisted
   nowhere). MCP _re-enable_ likewise needs `toggleMcpServer(x, true)` (a _disable_ is
   free via config-dir).

### Runtime control → persistence mechanism (from FINDINGS)

Record the args of **every state-mutating control call as it is made** — that single
discipline covers both readable and unreadable fields; never rely on read-back for the
unreadable ones.

| control call                   | mechanism                                   | `Options` target                                                              |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `setModel`                     | merge (redundant but owned)                 | `model`                                                                       |
| `setPermissionMode`            | **merge**                                   | `permissionMode` (+ dangerous-skip flag for `bypassPermissions`)              |
| `setMcpServers`                | **merge** (dynamic set only)                | `mcpServers`                                                                  |
| `setMaxThinkingTokens`         | **merge + normalize**                       | `thinking` (`ThinkingConfig`), _not_ deprecated `maxThinkingTokens`           |
| `applyFlagSettings`            | **merge + normalize**                       | `settings` (cumulative shallow-merge; `null` clears; track it — no read-back) |
| `setMcpPermissionModeOverride` | **re-apply** after init                     | none                                                                          |
| `toggleMcpServer(x,false)`     | **config-dir** (persists in `.claude.json`) | none; re-enable via `toggleMcpServer(x,true)`                                 |

**`thinking` normalization:** `setMaxThinkingTokens(null,…)` → omit `thinking` /
`{type:'adaptive'}`; `n===0` → `{type:'disabled'}`; `n>0` →
`{type:'enabled',budgetTokens:n}` (but Opus 4.6+ collapses nonzero to adaptive on/off —
store the budget, don't expect round-trip fidelity). `display` only on
`adaptive`/`enabled`; a concrete value → `thinking.display`, `null` → omit.

### Registry function signatures (ported from pictl, renamed)

`clauctlBaseDir`, `agentDirPath`, `agentIdError`, `agentJsonPath`, `sdkSocketPath`,
`tombstonePath`, `archivedPath`, `reviveLockPath`, `daemonLogPath`,
`socketPathLengthError(agentDir, platform?)`, `readAgentRecord`, `writeAgentRecord`,
`listAgentIds(prefix?)`, `resolveAgentId` (exact-or-unique-prefix), `loadAgent`,
`isPidAlive`, `classifyAgentDir` → `RegistryStatus`
(`tombstoned|corrupt|archived|dormant|running`). All behavior-identical to pictl
except the `AgentRecord` shape and `readAgentRecord`'s field validation.

### Success criteria

- Spawn an agent, send several turns via the `query` subcommand, observe correct
  streaming `SDKMessage`s and correct **Idle → Pending → Working → Idle** transitions
  across a tool-using turn, a subagent turn, an `interrupt`, and a `max_turns` hit.
- Issue `/compact`; confirm **Compacting** entered on send and exited on the subsequent
  `result`, session id unchanged.
- Issue `/clear`; confirm the daemon detects the session_id change and updates
  `currentSessionId` while the same process keeps serving.
- `close()` on teardown leaves **no orphaned child `claude`**.
- Kill the daemon and respawn; confirm the agent resumes the current session with its
  _merged_ runtime state (mutated `model`/`permissionMode`/`mcpServers` reproduced,
  mcp override re-applied), not spawn defaults.
- `list`/`status`/`archive`/`gc` behave against on-disk state.

The criteria are driven end-to-end through the minimal `sdk.sock` command channel
(`query`, `interrupt`, `set-model`, `set-permission-mode` in `sdk-commands.ts` —
mirroring pictl's `rpc-commands.ts`); the merge-persistence criterion in particular
needs `set-model`/`set-permission-mode` to mutate runtime state before the kill.

## IMPLEMENTATION IDEAS (evolving)

- **Reuse pictl structure with deltas:** `registry.ts` ports almost verbatim (new
  `AgentRecord`); `spawn.ts`'s `launchDaemon` fd-3 ready-barrier ports verbatim
  (`DaemonLaunch = { agentDir, agentId, cwd, resume, tag? }`); `daemon.ts` keeps the
  shape (sole writer, serialized write chain, SIGTERM→SIGTERM-forward, ready signal) but
  the internals are net-new — an in-process `Query` and the assistant-state tracker replace the
  pty/xterm machinery.
- **The `claude`-flag → `Options` parser** is the inverse of `sdk.mjs`'s `initialize()`
  argv builder (extracted and pinned to 0.3.195). Keep it a small explicit table beside
  the `OPTION_BUCKETS` table; unmodeled flags fall through to `extraArgs`.
- **`OPTION_BUCKETS` exhaustiveness** is the RISK-6 drift guard — do not replace it with
  a hand-written `PersistedOptions` interface (that rots silently).
- **`nextAssistantState` is pure** — the daemon owns the `AssistantState` and feeds it events; the
  transition body is validated by the 2a spike before it's trusted. Keep raw stream
  captures under `docs/derisk/` per the derisk convention.
- **`claudePid`** is best-effort: the `Query` surface exposes no pid. Populate only if
  the spike finds it trivially (e.g. the daemon's sole child); otherwise drop the field.
  Teardown never depends on it — `query.close()` + `daemonPid` only.

## WORK LOG

- Spec derived from the Phase-1 type-design discussion, grounded on pictl `src/core/`,
  the SDK `Options`/`Query`/`SDKMessage` types and `initialize()` argv builder at
  0.3.195.
- Options partition, merge map, and respawn requirements pinned by
  `docs/derisk/resume-persistence/FINDINGS.md` (2026-07-02). Echo-placement /
  `--priority` (RISK-8) resolved in `docs/derisk/echoed-message-placement/FINDINGS.md`
  (referenced by the Phase-2 `sdk.sock` spec).
- 2026-07-03: full implementation skeleton written under `src/core/` (registry,
  options, assistant-state, sdk-socket, spawn, daemon, lifecycle, inspect,
  sdk-commands, plus the pictl cli/targets/completion/main ports); `tsc` and eslint
  green, CLI help runs. Unit tests and the 2a spike are still pending.
- 2026-07-03: unit tests added (`registry.test.ts` ported from pictl;
  `assistant-state.test.ts` covering the transition table and the
  idle-implies-empty-queue invariant; `options.test.ts` covering first-class
  mappings, `--flag=value`, `extraArgs` fallthrough, and rejected flags); 46 tests,
  presubmit green.
- 2026-07-03: 2a spike run against an isolated `CLAUDE_CONFIG_DIR`/`CLAUCTL_DIR`
  (haiku, minimal turns). Verified: spawn; turns via `query`; Idle → Pending →
  Working → Idle; `/compact` (Compacting entered on send, exited on `result`,
  session unchanged, re-announce deduped); `/clear` rollover appended to session
  history; `interrupt` (result `error_during_execution`, back to Idle);
  `set-permission-mode` merged into `persistedOptions` and reproduced across
  archive → revive; revival resumed the same session with full context; archive
  left no orphaned `claude`; `list`/`status` correct; `gc` removed
  tombstoned/corrupt dirs and spared the archived agent. Not exercised (credit
  economy): tool-using/subagent turns, `max_turns`, `set-model` (mechanically
  identical to `set-permission-mode`). The spike found one design bug — see the
  ready-barrier decision below.
- 2026-07-03: post-implementation critical review. Two fixes: daemon teardown now
  awaits the SDK stream's end (child exit) before `process.exit`, so the SDK's
  SIGKILL-escalation timer survives long enough to fire on a SIGTERM-ignoring
  claude (the spike had shown the child briefly outliving the daemon); the
  `/compact` detection matches only `/compact` or `/compact <args>`, not arbitrary
  `/compact*` prefixes. Verified with a zero-credit spawn/archive cycle: spawn
  returns promptly, both daemon and claude are dead immediately after archive.
  Presubmit green (46 tests).
- 2026-07-04: user-review round (`e53146e`) landed four changes. (1) **Event bus**:
  the daemon's assistant state is now updated only by `EventBus.emit`, which
  serializes the `SdkEvent` to the observation channel (daemon.log) and folds it
  into the tracker in one step — an applied-but-never-emitted event (the reviewed
  bug) is structurally unrepresentable, and daemon.log's format is now the
  `SdkEvent` stream itself (Phase-2 fan-out = more sinks on the same bus; longer
  term the log shrinks to exceptional events once fan-out exists). (2) **`SdkEvent`
  moved to `sdk-socket.ts`** — it is protocol, not tracker internals. (3) Tracker
  comments corrected per the round-3 echo-placement findings (`next`/default while
  busy is _demoted to an in-turn steer_, not merged/discarded; `now` does not clear
  the queue — evidence cited inline); Phase 2's `EchoedUserMessage` gains
  `delivery: "turn" | "steer"`. (4) **Shared pictl files are now generated**:
  `scripts/sync-from-pictl.mjs` produces `src/core/generated/{cli,completion,
  targets,util,version}.ts` from pictl's canonical copies (rename + import rewrite
  - prettier + DO-NOT-MODIFY header); presubmit runs `--check` so drift fails the
    build. Also: derisk capture files excluded from treefmt (raw evidence); `q`
    renamed `claudeQuery`. Verified end-to-end with one haiku turn (spawn → query →
    archive; daemon.log is pure event stream + two exceptional lines). Pending: pictl
    handoff (`/tmp/pictl-handoff.md`) for daemon-argv derivability and `wait_idle`
    RPC; clauctl mirrors once pictl lands.

### Implementation-Time Decisions

- **`queueDepth` includes the in-flight turn (and a pending compaction).** The spec's
  transition list reads as if only turns accepted _while busy_ are counted, but the
  `result` rule (decrement, then Pending iff `queueDepth > 0`) mispredicts under that
  reading: idle → accept → accept-`later` → first `result` would land on Idle with the
  `later` turn still due to run. Counting every accepted-but-not-completed runnable
  unit — the running turn, queued `later`/`now` turns, and a sent `/compact` — makes
  the `result` rule correct and yields the `activity === 'idle' ⇒ queueDepth === 0`
  invariant. Signatures unchanged.
- **`wait-idle` added to the minimal `sdk.sock` request set.** `archive`'s polite stop
  ("wait until Idle") needs an idle signal, and the no-sleeps rule forbids polling.
  The daemon answers the request when the tracker reaches Idle (immediately if already
  Idle); the timeout stays client-side. Alternative rejected: a `state` request polled
  by the CLI.
- **`OPTION_BUCKETS` is `as const satisfies Record<keyof Options, OptionBucket>`.**
  The spec's literal `const OPTION_BUCKETS: Record<keyof Options, OptionBucket>`
  annotation would widen every entry to the `OptionBucket` union, making
  `PersistedOptionKey` resolve to `never`. `satisfies` keeps the exhaustiveness check
  (the RISK-6 tripwire) while preserving the per-key literals the mapped type needs.
  Also `-?` in the mapped type, else optional keys inject `undefined` into the union.
- **The fd-3 ready barrier is socket-bound only, not first-`system/init`** (spike
  finding, 2026-07-03). The initial implementation strengthened pictl's barrier to
  also wait for the first `system/init`, assuming init arrives at startup. It does
  not: in streaming-input mode claude announces itself only when the first user turn
  arrives. Consequences observed in the spike: `spawn` blocked indefinitely, and
  revival deadlocked outright (the reviving CLI holds the turn that would trigger
  init while waiting for ready). Ready is now `sdk.sock` listening, matching pictl;
  session history is seeded by whichever init arrives first. Side effect: a fresh
  agent's `sessions` is empty until its first turn.
- **`claudePid` is not populated.** Nothing on the `Query` surface exposes the child
  pid, and the only capture point (`spawnClaudeCodeProcess`) would replace the SDK's
  own spawn path — not "trivially available" per the spec's criterion. The optional
  field stays on `AgentRecord`; teardown never depended on it (`query.close()` +
  `daemonPid` only). Revisit only if the 2a spike surfaces a need.

## Open questions for the implementing agent

- `spawn`'s exact `claude`-flag coverage: which flags get a first-class field vs. the
  `extraArgs` tail (the merge/persist set is fixed; the long tail is a judgment call).
- `claudePid` feasibility (see above) — resolved by the 2a spike.
- ~~Whether `spawn` should accept resume directly~~ — resolved: initial spawn accepts
  the `--resume <session-id>` claude flag to wrap an existing session (see bucket 4).
  Fork (`--fork-session`) remains out of scope for v1.
