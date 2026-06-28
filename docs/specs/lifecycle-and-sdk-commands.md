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
`close`. Also: sending slash commands (e.g. `/clear`, `/new`, `/compact`) as user
messages through the input stream.

### Data-model requirements (load-bearing — see overview + derisk)
- **agent id ≠ session id.** One agent spans a sequence of session_ids.
- The daemon's stream reader MUST treat **every post-first `system/init`** on a
  connection as a session rollover and update `agent.json.currentSessionId`. Do not
  rely on `SDKSessionStateChangedMessage` for id transitions (it carries
  idle/running state only).
- `/clear` and `/new` do **not** kill the process; no respawn on reset.
- **Respawn** (after crash/daemon restart) = persisted `Options` +
  `resume: currentSessionId`, reproducing behavior as if uninterrupted.

### Success criteria
- Spawn an agent, send several turns, observe correct streaming responses.
- Issue `/clear`; confirm the daemon updates `currentSessionId` from the new
  `system/init` while the same process keeps serving.
- Kill the daemon (or the process) and respawn; confirm the agent resumes the
  current session transparently.
- All SDK control methods reachable via subcommands.

## IMPLEMENTATION IDEAS (evolving)

- **Reuse pictl's structure**: daemon, per-agent directory + unix-socket model,
  and stricli-based CLI. Mirror pictl's layout (e.g. its `src/core/` daemon and
  socket logic) and adapt the RPC layer to the SDK.
- pictl's `src/core/rpc-commands.ts` is the conceptual analog of clauctl's SDK
  passthrough layer — but the interface is entirely different (SDK `Query` control
  methods + `SDKMessage` stream vs pi RPC). Mirror the *shape*, not the calls.
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
- `wait` semantics: which precise stream signal denotes "turn complete" / "idle"
  (`result` message? `session_state_changed: idle`?).
- How `attach`/fan-out handles backpressure and late joiners (replay vs live-tail).
- Whether `spawn` should support resume/fork directly (attach to an existing
  session_id) in v1.
