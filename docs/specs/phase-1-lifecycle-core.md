# Spec: Phase 1 — Lifecycle Core (initial implementation)

> Status: **ready to implement.** Read `docs/overview.md` first, then the broader
> `docs/specs/lifecycle-and-sdk-commands.md` (this doc is the implementation-ready
> carve-out of that scaffold's lifecycle half). Grounded against pictl's `src/core/`
> and the SDK `Options`/`Query` types at **0.3.195**.

## SPEC (stable requirements)

Phase 1 delivers the durable-agent substrate: create a long-lived `claude` process,
persist everything needed to talk to it and respawn it, track its session rollovers
and idle state, and stop it cleanly. It does **not** open `sdk.sock` to clients
(Phase 2), stream to `tail`/`wait` (Phase 3), or run a TUI (Phase 5). Turns are
injected by the daemon itself, which is also the **2a spike** (RISK-1): proving the
daemon-shape SDK loop, the 4-state idle model, and clean teardown.

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

Internal: **`_daemon`** (the per-agent supervisor). Transparent revival of a dormant
agent (`ensureAgentRunning` + `revive.lock`) is ported from pictl and exercised by
respawn; the commands that *implicitly* revive (passthrough, attach) land in Phase 2.

### On-disk layout (pictl scheme)

```
$CLAUCTL_DIR/<agentId>/
  agent.json     # daemon-only writer; atomic write+fsync+rename
  sdk.sock       # bound in Phase 2; path reserved now
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
There is no separate "runtime state" blob — the merged runtime state *is*
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

**Bucket 4 — respawn** (set at respawn only, not persisted as config):
`resume = currentSessionId`. `continue`, `forkSession`, `resumeSessionAt`, `sessionId`
are **not** used — respawn continues the *same* session.
TDC: Note that sessionId can be set by the user when they first spawn with the --resume claude flag. This allows users to "wrap" existing claude sessions in a clauctl agent.

### `spawn` conveys Options by parsing `claude`-style flags

The SDK's `initialize()` is a fixed **Options → argv** function (invariants hardcoded;
each modeled field → its flag; `extraArgs: Record<string,string|null>` is the generic
`--flag [value]` escape hatch appended last). clauctl's `spawn` therefore accepts
**`claude`-style flags** and maps them to `Options` — the *inverse* of that table:

- Flags the SDK models **and clauctl reads/merges/persists** (`--model`,
  `--permission-mode`, `--mcp-config`, `--thinking`, `--settings`, repeatable
  `--add-dir`, …) → their **first-class `Options` field** (bucket 1). Repeatable and
  structured flags *must* use the field, not `extraArgs` (unique keys can't repeat).
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

TDC: note that clauctl should follow pictl's lead and set CLAUCTL_AGENT_ID in the env when it spawns/respawns a claude instance.

### Daemon: the SDK loop, session tracking, idle model, persistence

The per-agent daemon (ported from pictl `daemon.ts`, but net-new internals — no pty,
an in-process `Query` instead) is the sole `agent.json` writer. It:

1. Reads `spawn-options.json` (or, on respawn, the existing `persistedOptions`), builds
   the full `Options`, and opens `query({ prompt: heldOpenIterable })`.
2. Tracks **`currentSessionId`** = the most-recent `system/init.session_id`, detecting a
   rollover **only when an init's `session_id` differs** (an `init` fires every turn —
   never count inits; `/compact` stays in-session). Appends new sessions to history,
   dedup-on-reannounce, and captures `claudeCodeVersion` from `init`.
3. Derives the **4-state idle model** (below).
4. **Persists mutable runtime state on mutation** (DECISION-5): whenever a control
   method changes a merge field, folds the new value into `persistedOptions` and queues
   an `agent.json` write. (In Phase 1 the daemon issues these itself; in Phase 2 they
   arrive from `sdk.sock` clients.)
5. Tears down via `query.close()` on SIGTERM/SIGINT and confirms no orphaned child
   `claude` (RISK-3 — verified by this spike). `close()` is synchronous/`void`.

Agent.json writes are serialized through a promise chain (pictl pattern); session and
merge events can arrive faster than a write completes.

### Idle / activity model (4-state)

There is no `idle` `SDKStatus`; the daemon derives it. `state` and `queueDepth` are
**independent** and must not be conflated (`state` = SDK evidence; `queueDepth` = our
own echo bookkeeping, since the SDK never echoes user turns back).

```ts
type AgentActivity = 'idle' | 'pending' | 'working' | 'compacting';
interface IdleState { activity: AgentActivity; queueDepth: number; }  // TDC: why "Idle"? This is just state. Maybe AssistantState or ClaudeState?
const isBusy = (s: IdleState) => s.activity !== 'idle' || s.queueDepth > 0;

// TDC: why "Idle"? These are just events
type IdleEvent =
  | { kind: 'turnAccepted' }      // we injected a runnable turn (now / later / idle-default)
  | { kind: 'compactSent' }       // /compact issued while Idle
  | { kind: 'interruptSent' }
  | { kind: 'sdkMessage'; message: SDKMessage };

function nextIdleState(state: IdleState, event: IdleEvent): IdleState;  // pure
```

Transitions (pinned empirically by this spike):

- accept a turn ⇒ **Pending** (`queueDepth` counts only turns the echo-placement rule
  says will actually run — never a dropped `next`/default-while-busy).
- first `SDKAssistantMessage` for the turn ⇒ **Working** (unless Compacting).
- `result` ⇒ **Idle** (and if Compacting, compaction is now done); decrement `queueDepth`.
- `/compact` (only valid when **Idle**; never as a queued turn) ⇒ **Compacting** on
  send. `SDKCompactBoundaryMessage` arrives when compaction *finishes*, so Compacting is
  exited by the subsequent `result`, not the boundary message.
- `interrupt()` — state unchanged when *sent*; ⇒ **Idle** only on the terminating
  `result` (subtype alone doesn't flag the interrupt — the daemon remembers it sent one).

TDC: Make sure these transitions properly integrate the findings from docs/derisk/echoed-message-placement/FINDINGS.md. If a message was sent with priority "later", then shouldn't `result` move us into state Pending? Conceptually I think it's the same sort of state: a turn has been accepted and we predict the assistant should start working, but haven't gotten confirmation from the SDK.

### Respawn (RISK-3)

Recipe = **merged `persistedOptions` + `resume: currentSessionId`** in a fresh process.
Requirements (all must hold — from `docs/derisk/resume-persistence/FINDINGS.md`):

1. **Same config dir + cwd.** `resume` finds the transcript by config dir; the MCP
   disable state is keyed `.claude.json`→`projects[<resolved-cwd>].disabledMcpServers`.
   Both travel with persisted `env`+`cwd`, so re-passing `persistedOptions` satisfies
   this. ("Same cwd" = the path the CLI *resolves* to — worktrees resolve to the git
   main path.)
2. **Re-pass merged `Options`.** `resume` restores the *conversation* but only some
   *session config*: it drops `permissionMode` and dynamic `mcpServers` (must merge),
   carries `model` (merge anyway so clauctl owns it explicitly). Merge is correct even
   if the SDK asymmetry flips on a bump (RISK-6).
3. **Re-apply after init** the runtime controls with **no `Options` path**:
   `setMcpPermissionModeOverride(server, mode)` per server (ephemeral, persisted
   nowhere). MCP *re-enable* likewise needs `toggleMcpServer(x, true)` (a *disable* is
   free via config-dir).

### Runtime control → persistence mechanism (from FINDINGS)

Record the args of **every state-mutating control call as it is made** — that single
discipline covers both readable and unreadable fields; never rely on read-back for the
unreadable ones.

| control call | mechanism | `Options` target |
| --- | --- | --- |
| `setModel` | merge (redundant but owned) | `model` |
| `setPermissionMode` | **merge** | `permissionMode` (+ dangerous-skip flag for `bypassPermissions`) |
| `setMcpServers` | **merge** (dynamic set only) | `mcpServers` |
| `setMaxThinkingTokens` | **merge + normalize** | `thinking` (`ThinkingConfig`), *not* deprecated `maxThinkingTokens` |
| `applyFlagSettings` | **merge + normalize** | `settings` (cumulative shallow-merge; `null` clears; track it — no read-back) |
| `setMcpPermissionModeOverride` | **re-apply** after init | none |
| `toggleMcpServer(x,false)` | **config-dir** (persists in `.claude.json`) | none; re-enable via `toggleMcpServer(x,true)` |

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

- Spawn an agent, inject several turns from the daemon, observe correct streaming
  `SDKMessage`s and correct **Idle → Pending → Working → Idle** transitions across a
  tool-using turn, a subagent turn, an `interrupt`, and a `max_turns` hit.
- Issue `/compact`; confirm **Compacting** entered on send and exited on the subsequent
  `result`, session id unchanged.
- Issue `/clear`; confirm the daemon detects the session_id change and updates
  `currentSessionId` while the same process keeps serving.
- `close()` on teardown leaves **no orphaned child `claude`**.
- Kill the daemon and respawn; confirm the agent resumes the current session with its
  *merged* runtime state (mutated `model`/`permissionMode`/`mcpServers` reproduced,
  mcp override re-applied), not spawn defaults.
- `list`/`status`/`archive`/`gc` behave against on-disk state.

TDC: how will you inject this stuff when clauctl only has lifecycle commands? Do we need to at minimum implement some form of the `query` subcommand in sdk-commands.ts (and maybe also set-model and set-permission-mode), mirroring pictl's rpc-commands.ts? We can flesh it out in phase 2.

## IMPLEMENTATION IDEAS (evolving)

- **Reuse pictl structure with deltas:** `registry.ts` ports almost verbatim (new
  `AgentRecord`); `spawn.ts`'s `launchDaemon` fd-3 ready-barrier ports verbatim
  (`DaemonLaunch = { agentDir, agentId, cwd, resume, tag? }`); `daemon.ts` keeps the
  shape (sole writer, serialized write chain, SIGTERM→SIGTERM-forward, ready signal) but
  the internals are net-new — an in-process `Query` and the idle model replace the
  pty/xterm machinery.
- **The `claude`-flag → `Options` parser** is the inverse of `sdk.mjs`'s `initialize()`
  argv builder (extracted and pinned to 0.3.195). Keep it a small explicit table beside
  the `OPTION_BUCKETS` table; unmodeled flags fall through to `extraArgs`.
- **`OPTION_BUCKETS` exhaustiveness** is the RISK-6 drift guard — do not replace it with
  a hand-written `PersistedOptions` interface (that rots silently).
- **`nextIdleState` is pure** — the daemon owns the `IdleState` and feeds it events; the
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

## Open questions for the implementing agent

- `spawn`'s exact `claude`-flag coverage: which flags get a first-class field vs. the
  `extraArgs` tail (the merge/persist set is fixed; the long tail is a judgment call).
- `claudePid` feasibility (see above) — resolved by the 2a spike.
- Whether `spawn` should accept resume/fork directly (attach to an existing session_id)
  in v1 — leaning no; respawn is the only resume path.
