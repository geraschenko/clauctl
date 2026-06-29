# Spec: Lifecycle & SDK-passthrough commands (v1)

> Status: **scaffold** — captures decisions made so far; to be completed by a
> fresh agent. Read `docs/overview.md` first.

## SPEC (stable requirements)

clauctl's v1 delivers the two core jobs over a daemon-owned connection to each
`claude` process: (1) lifecycle & metadata management, and (2) unfettered SDK
passthrough. No TUI in v1 (see `docs/specs/tui.md`); `format`/`completion` are
specified separately (`docs/specs/convenience-commands.md`).

### Lifecycle commands
- `spawn` — start a new long-lived `claude` process in **streaming-input mode**
  (`query({ prompt: <AsyncIterable> })`), persist its `agent.json`, and bring up
  its `sdk.sock`. Accepts the spawn `Options` (model, permissionMode,
  allowedTools/disallowedTools, mcpServers, systemPrompt, cwd, additionalDirectories,
  env, settingSources, agents, maxTurns, fallbackModel, …).
- `list` — enumerate known agents with status.
- `status` — detailed state of one agent (pid, current session_id, lifecycle
  state, socket paths, recent activity).
- `archive` — retire an agent (stop process, preserve `agent.json` + transcripts
  for the record / later resume).

### Monitoring commands
- `tail` — stream an agent's `SDKMessage`s (follow mode).
- `wait` — block until an agent reaches a condition (e.g. idle / result for the
  current turn). Must use real signals (the message stream / session-state
  events), never polling-with-sleep.
- `attach` (raw) — connect a client to `sdk.sock` to send `SDKUserMessage`s /
  control requests and receive the stream. This is the non-TUI substrate; the rich
  TUI builds on the same socket later.

### SDK passthrough (job 2)

**Principle (DECISION-4): expose the *full* `Query` surface.** Every method of the
`Query` interface (`sdk.d.ts`) gets a subcommand — this is the analog of pictl's
`src/core/rpc-commands.ts`. Anything less is confusing. We expose **nothing else**
from the SDK module (not `query`/`startup`, not other types) **except**
`resolveSettings` (see below). We still *consume* the SDK's parameter types
(`PermissionMode`, `McpServerConfig`, `Settings`, `MessageParam`, …) internally to
parse and validate subcommand arguments — "don't expose" ≠ "don't use".

> **Coverage invariant.** A future reader expects all `Query` methods represented
> 1:1 as subcommands. Therefore **every method that is *not* a plain passthrough
> subcommand must carry a code comment explaining the deviation** at its mapping
> site, so the gap is intentional and obvious, never an oversight.

**Plain passthrough subcommands** (mutations / control):
`interrupt`, `setPermissionMode`, `setMcpPermissionModeOverride`, `setModel`,
`setMcpServers`, `reconnectMcpServer`, `toggleMcpServer`, `applyFlagSettings`,
`reloadPlugins`, `reloadSkills`, `rewindFiles`, `seedReadState`, `stopTask`,
`backgroundTasks`, and the deprecated `setMaxThinkingTokens` (kept because it is
the only *runtime* thinking-level control, which DECISION-5 requires us to change
mid-session and persist; comment the deprecation at the mapping site).

**Plain passthrough subcommands** (reads / introspection — these also back `status`):
`initializationResult`, `supportedCommands`, `supportedModels`, `supportedAgents`,
`mcpServerStatus`, `getContextUsage`, `accountInfo`, `readFile`, and
`usage_EXPERIMENTAL_…` (exposed under a stable alias `usage`; comment that the SDK
method is experimental and the underlying name will change — pin the SDK version).

**Methods deliberately NOT exposed as passthrough** (each requires a comment at its
mapping site explaining why):
- `close()` — terminates the child `claude`; this is **lifecycle-owned** (`archive`/
  stop), not a passthrough a client may call, or it would kill the agent out from
  under the daemon's session tracking.
- `streamInput()` — the daemon's **internal** turn-injection mechanism; the `query`
  subcommand (below) is its ergonomic front. Raw exposure (it takes an
  `AsyncIterable`) is meaningless on a CLI.
- `reinitialize()` — daemon-internal **reconnect** machinery (redelivers pending
  permission requests after a transport gap); part of the respawn/reconnect path,
  not a user subcommand.

**The `query` subcommand** (the user-facing way to send a turn) appends an
`SDKUserMessage` to the daemon's held-open prompt iterable (Phase-0 spike decides
iterable-append vs `Query.streamInput`). `SDKUserMessage.message` is a `MessageParam`
(`content: string | ContentBlockParam[]`), so:
- `--image <path>` adds an `image` content block beside the text, exactly like
  `pictl prompt` (read → base64 → block).
- `--priority now|next|later` sets `SDKUserMessage.priority` (**behavior unknown —
  see the queue-ordering spike in the plan; this gates echo placement**).
- `--no-query` sets `shouldQuery: false` (append to transcript without triggering an
  assistant turn).

**One non-`Query` export we DO expose: `resolveSettings()`** → resolves the
*effective* settings without spawning a process. Serves DECISION-7 (inherit
user+project settings): lets `spawn`/`status` show exactly what configuration an
agent will see. (`filterEscalatingDefaultMode` is used **internally** to honor
DECISION-3's real-permission-mode posture — not a subcommand.)

**Slash commands** ride the normal input stream as ordinary user messages: `/clear`
and `/new` roll the session id (new conversation in place), whereas `/compact` stays
in the **same** session (emits `SDKCompactBoundaryMessage`); the rollover detector
must not treat compact as a new session.

### `sdk.sock` stream augmentation (DECISION-6)

The SDK **does not echo user turns back**, so multiple clients on one programmatic
connection cannot see each other's input and the conversation reads as nonsense.
`sdk.sock` therefore **cannot just forward** `claude`'s stream — the daemon must
*augment* it. Event set for v1 (modeled on `muninn`'s `RunnerEvent`, treated as a
**reference, not authority**):

- **forward:** `Message` (the `SDKMessage` stream), `SdkError`, optionally `Stderr`.
- **synthesize:** `EchoedUserMessage` (the missing echo — emitted when *any* client's
  turn is accepted; drop muninn's `<T>` metadata param), `QueueDepthChanged`,
  `CompactionStarted`, `SdkClientConnected` (on every (re)connect/respawn),
  `PermissionModeChanged` (so clients reflect the effective mode).
- **defer (future):** `PermissionRequest`/`PermissionResponse` (only needed for the
  interactive permission round-trip, deferred by DECISION-3), `FreezeDetected`
  (liveness watchdog). Leave protocol room.
- **not a stream event:** `HistoryEntry` is JSONL deserialization (the Phase-3
  `tail` path), not a live augmentation — keep it separate.

**Echo placement requires partial messages.** Detecting the tool-use turn boundary
(where queued echoes flush) is done by watching `SDKPartialAssistantMessage`
stream events for `message_delta` with `stop_reason == "tool_use"`. So **`spawn`
must set `includePartialMessages: true`**, and the daemon consumes those partials
*internally* (does not forward them) for boundary detection. **Exactly where each
echo lands depends on the unknown `--priority` semantics — see the queue-ordering
spike (plan [RISK-8]); this is the gating unknown for D6.**

### Idle / activity model (4-state)

There is no `idle` `SDKStatus`. The daemon derives a 4-state machine (from muninn's
`runner_state_tracker`, again a reference): **Idle → Pending → Working → Compacting**.
- `EchoedUserMessage` ⇒ Pending (queued, not yet running).
- `SDKAssistantMessage` ⇒ Working (unless Compacting).
- `result` ⇒ Idle (and if it was Compacting, the compaction is done).
- `CompactionStarted` (synthesized when `/compact` is sent) ⇒ Compacting.
- `busy = state != Idle || queueDepth > 0`.

This refines the earlier "idle = saw `result` + no queued turn" into the Idle-vs-
**Pending** distinction clients need. `wait` keys off this model. Pin it in Phase 0.

### Data-model requirements (load-bearing — see overview + derisk)
- **agent id ≠ session id.** One agent spans a sequence of session_ids.
- A `system/init` fires on **every turn** (confirmed at the raw-CLI level), so its
  presence is NOT a rollover signal. The daemon tracks `currentSessionId` = the
  most-recent `init.session_id`, and detects a rollover **only when an init's
  `session_id` differs** from the current one — compare ids, never count inits. Do
  not rely on `SDKSessionStateChangedMessage` for id transitions (it carries
  idle/running state only).
- `/clear` and `/new` do **not** kill the process; no respawn on reset.
- **Respawn** (after crash/daemon restart) = persisted `Options` +
  `resume: currentSessionId`, reproducing behavior as if uninterrupted.
- **Persist mutable runtime state, not just spawn `Options` (DECISION-5).** Anything
  a client changes *mid-session* via a control method — `permissionMode`, model,
  thinking level, MCP overrides, applied flag settings — must be written back to
  `agent.json` as it changes. On respawn the agent must come up in that *current*
  state, so the user's experience is "the session was running the whole time," not
  "it reverted to spawn defaults." (pictl has this same gap.) Store the full
  session-id **history**, not just the current id.
- **Settings posture (DECISION-7): inherit by default.** A spawned agent behaves as
  if the user ran `claude` on the CLI with the same env and settings — i.e.
  `settingSources` includes user + project (`CLAUDE.md`), not the SDK's isolated
  default. `resolveSettings` lets us show what that resolves to.
- **Permission posture (DECISION-3): use the user's real permission mode**, never an
  auto-`bypassPermissions` default. v1 assumes the mode auto-decides every request
  (e.g. `auto` or `bypassPermissions`); the interactive permission popup + the
  non-interactive fallback are a **future version** (the round-trip and
  `PermissionRequest`/`Response` augmentation are deferred, not built in v1).
- **`persistSession: true` is a hard invariant (DECISION-8)** — respawn-via-`resume`
  depends on the per-session transcript JSONL existing.

### Success criteria
- Spawn an agent, send several turns, observe correct streaming responses.
- Issue `/clear`; confirm the daemon detects the id change and updates
  `currentSessionId` while the same process keeps serving.
- Kill the daemon (or the process) and respawn; confirm the agent resumes the
  current session transparently.
- All SDK control methods reachable via subcommands.

## IMPLEMENTATION IDEAS (evolving)

- **Reuse pictl's structure**: per-agent supervisor daemon (pictl is
  one-daemon-per-agent), per-agent directory + unix-socket model, and stricli-based
  CLI. Mirror pictl's layout (e.g. its `src/core/` daemon and CLI wiring).
- **`sdk.sock` is net-new server code, NOT a port of `pi-socket-client.ts`.** In
  pictl, *pi itself* serves the socket (`pi --rpc-socket`) and the daemon is a
  *client* of it (`pi-socket-client.ts`). The SDK gives clauctl only an in-process
  `Query` over stdio — so clauctl's daemon must **author** the `sdk.sock` server:
  wire format, request framing, control-method marshalling, `SDKMessage` fan-out,
  and the permission round-trip. `rpc-commands.ts` is a shape reference at best.
- The daemon holds the open `AsyncIterable` input and the `Query` async generator;
  `sdk.sock` clients are multiplexed onto it (single programmatic connection
  constraint).
- `agent.json` stores only the serializable subset of `Options`. Code-valued
  options (`canUseTool`, `hooks`, `createSdkMcpServer` tools) are clauctl's own and
  re-supplied on spawn/respawn.
- Consider how multiple concurrent `sdk.sock` clients share one stream
  (broadcast/fan-out) and how input turns from different clients are serialized.

## WORK LOG
- (empty) — initial scaffold created from overview + derisk decisions.

## Open questions for the implementing agent
- Exact `agent.json` schema and on-disk directory layout (align with pictl) — must
  now include the full session-id history **and** the mutable runtime state from
  DECISION-5 (current model, permission mode, thinking level, MCP overrides, applied
  flag settings).
- Where agents live on disk (root dir, naming).
- **Queue/priority semantics (gates D6 echo placement)** — how `--priority`
  (`now`/`next`/`later`) maps to insertion point and inference/turn boundaries. Must
  be derisked (plan [RISK-8]) before the echo-insertion logic is correct; muninn's
  approach is a reference we do not yet trust.
- How `attach`/fan-out handles backpressure and late joiners (replay vs live-tail).
- Whether `spawn` should support resume/fork directly (attach to an existing
  session_id) in v1.

Resolved since the scaffold: the idle model is the **4-state** machine above (not a
bare `result`-watch); concurrent writers are **serialized through the daemon**
(DECISION-6) — no single-writer lock, the daemon interleaves.
