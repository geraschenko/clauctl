# Derisk experiment rules

## Telemetry policy: probes run with nonessential traffic disabled

Every probe that runs the Claude Code CLI or SDK (spawned or in-process)
MUST set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

Rationale: probes deliberately put sessions into error-shaped states —
crashing a session between tool call and result, inserting compaction
boundaries with malformed or duplicated playlists, and similar surgery.
The CLI streams telemetry events and error reports for what it perceives
as organic error conditions; a probe campaign would look upstream like an
account hitting unusual failures at scale. We don't want to trip alarms
on the Claude Code team's dashboards or get the account classified as a
problem case.

Why this variable and not `DISABLE_TELEMETRY`: essential-traffic mode is
strictly stronger. `DISABLE_TELEMETRY` suppresses the tengu event stream
but leaves ERROR REPORTING on (gated by
`DISABLE_ERROR_REPORTING || essential-traffic`), and error reports are
exactly the channel probe-induced failures would land in.
Essential-traffic mode suppresses both, plus other nonessential network
traffic (gateway discovery, quota probes, feature-flag fetches).

Implementation: `tests/sdk/harness.ts` sets it at module scope;
`compact-boundary-injection/harness.mjs` re-exports from it, covering all
probes that import either (directly or via `round2.mjs`) — both CLI
spawns (`baseEnv` spreads `process.env`) and in-process SDK calls. New
experiment harnesses in other subdirectories must do the equivalent.

## Permission policy: never `bypassPermissions`

No probe or SDK test may pass `permissionMode: "bypassPermissions"` (or
`allowDangerouslySkipPermissions`). Choose by whether the probe needs
the tool calls to actually run:

- results not needed → `permissionMode: "dontAsk"` (auto-denies
  anything not pre-approved);
- results needed → `permissionMode: "auto"` (classifier approves or
  denies; no interactive prompt).
