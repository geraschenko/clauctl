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
Expose the `Query` control surface and message stream as ergonomic subcommands
over `sdk.sock`. Known control methods to surface (from `sdk.d.ts`):
`streamInput` (send a user turn), `interrupt`, `setPermissionMode`, `setModel`,
`setMcpServers`, `setMcpPermissionModeOverride`, `backgroundTasks`, `stopTask`,
`close`. Also: sending slash commands as user messages through the input stream —
note `/clear` and `/new` roll the session id (new conversation in place), whereas
`/compact` stays in the **same** session (emits `SDKCompactBoundaryMessage`); the
rollover detector must not treat compact as a new session.

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
- Exact `agent.json` schema and on-disk directory layout (align with pictl).
- Where agents live on disk (root dir, naming).
- `wait` semantics: the derisk harness advanced turns on the `result` message, so
  "turn complete" = `result` for the last-submitted turn. There is no `idle`
  `SDKStatus`; "idle" is daemon-derived bookkeeping (saw `result`, no turn queued).
  Pin this model in Phase 0.
- How `attach`/fan-out handles backpressure and late joiners (replay vs live-tail).
- Whether `spawn` should support resume/fork directly (attach to an existing
  session_id) in v1.
