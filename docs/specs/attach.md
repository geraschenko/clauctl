# `clauctl attach` — terminal attach via a daemon-hosted TUI

# SPEC

## Problem statement

clauctl has no `attach` command. Today the interactive UI is reached by
running `clauctl _tui --sdk-socket <path>` directly — each invocation is a
private renderer in the caller's terminal, there is no shared screen, no
attach/detach auditing, and no way for a non-TypeScript client to get a
terminal view without reimplementing the TUI.

pictl already solves this: its daemon runs the interactive process in a pty,
mirrors it into a headless xterm emulator, and serves a `tty.sock` (binary
frame protocol: hello/input/resize/snapshot/output/exit) that `pictl attach`
speaks. Attach/detach events are audited and live attachments are recorded in
agent.json.

clauctl adopts the same architecture, with one structural difference: in
pictl the pty process (pi) _is_ the agent, while in clauctl the agent is the
SDK `query()` living in the daemon and the pty process is `clauctl _tui` — a
disposable renderer speaking sdk.sock like any other client. The daemon
always runs `_tui` in a pty on top of its own sdk.sock; `tty.sock` exists so
clients in other languages can attach by speaking the tty protocol without
reimplementing the TUI.

## Success criteria

- `clauctl attach --target <agent>` connects the local terminal to the
  agent's shared TUI: snapshot render on attach, live bidirectional
  proxying, terminal resize propagation, detach with ctrl+] leaving the
  agent running. Behavior identical to `pictl attach` (same protocol, same
  client code modulo the pictl→clauctl rename).
- Multiple simultaneous attachers see the same screen; pty size is the
  elementwise minimum across attachers (tty-server behavior, unchanged).
- Attach and detach are audited to `<agentDir>/audit.jsonl` as
  `{ts, source, event: "attach"|"detach", pid}` with daemon-side caller
  resolution, exactly as in pictl. The `attach` CLI command is _not_ marked
  `audited: true` (the daemon-side events cover it; a marker would
  double-record).
- Live attachments appear in agent.json (`attachments: AttachmentInfo[]`),
  cleared on daemon startup and clean shutdown.
- The daemon always runs `clauctl _tui --managed` in a pty. If the tui
  exits, the daemon logs and respawns it; repeated rapid crashes stop the
  respawning (see restart policy) while sdk.sock stays fully served — a
  renderer failure never takes down the agent.
- A failed tui is visible: `clauctl list` shows `running (tui failed)` in
  the status column, `clauctl status` shows a `tui: failed at <ts>` line,
  and the crash output itself is broadcast to attachers (it is pty output).
- Under `--managed`, ctrl+c no longer exits the tui (that would kill the
  shared renderer for every attacher); it shows the hint `detach: ctrl+]`.
  Standalone `_tui` (no `--managed`) keeps its double-ctrl+c detach and
  remains available for debugging.
- The tty protocol files are synced verbatim from pictl (the canonical
  copies) via `scripts/sync-from-pictl.mjs`, presubmit-enforced like the
  existing shared files.

## Concrete examples

```
$ clauctl attach -t 3837
# terminal clears, shows the agent's TUI with history, footer, live stream;
# bottom row: "attached to 383702e1-…; detach: ctrl+]"
# user types a prompt, sees the turn stream; presses ctrl+]
detached from 383702e1-…

$ cat ~/.local/share/clauctl/3837…/audit.jsonl
{"ts":"…","source":"bash:12345","event":"attach","pid":23456}
{"ts":"…","source":"bash:12345","event":"detach","pid":23456}

# after the tui crashes 3 times in rapid succession:
$ clauctl list
ID        TAG  STATUS
383702e1  -    running (tui failed)
# agent still answers sdk.sock commands:
$ clauctl query -t 3837 "still there?"   # works
# a new attach retries the tui spawn (and clears tuiFailedAt if it sticks)
```

## Type design

### Synced files (added to `SHARED_FILES` in scripts/sync-from-pictl.mjs)

`ansi.ts`, `tty-protocol.ts`, `tty-protocol.test.ts`, `tty-server.ts`,
`tty-server.test.ts`, `pty.ts`, `pty-screen.ts`, `pty-screen.test.ts`,
`attach.ts` — copied from pictl into `src/core/generated/` with the
existing mechanical renames; no new transforms. Their contents are pictl's,
not designed here. `pty-screen.ts` (the PtyScreen class: a process in a pty
mirrored into a headless xterm, with barrier-correct serializeScreen,
hintRoomSequence, and an emulator that survives process exit) is being
factored out of pictl's daemon per pictl's docs/specs/pty-screen.md — this
spec assumes that refactor has landed. Verified compatibilities:

- `attach.ts` imports `./cli.ts`, `./targets.ts`, `./ansi.ts`,
  `./tty-protocol.ts` (all in the shared set, imports stay `./`) and
  `./lifecycle.ts`, `./registry.ts` (rewritten to `../`). clauctl's
  `ensureAgentRunning(agentIdPrefix: string): Promise<AgentRecord>` matches
  pictl's signature.
- The rename turns the hello `client: "pictl attach"` into
  `"clauctl attach"`.
- `attach.ts` exports `attachRoute`; app.ts wires it like other routes.

### Dependencies

`node-pty ^1.0.0`, `@xterm/headless ^5.5.0`,
`@xterm/addon-serialize ^0.14.0` (pictl's ranges).

### src/core/registry.ts

```ts
import { type AttachmentInfo } from "./generated/tty-server.ts";

/** The daemon's terminal-attach socket (generated/tty-server.ts). */
export function ttySocketPath(agentDir: string): string; // join(agentDir, "tty.sock")

export interface AgentRecord {
  // ...existing fields...
  /** Live tty.sock attachers; daemon-owned, reset on startup and shutdown. */
  attachments: AttachmentInfo[];
  // readAgentRecord defaults it (`record.attachments ??= []`, pictl parity)
  // so records written before this field existed still satisfy the type.
  /** Set when the tui host stops respawning after repeated rapid crashes;
   *  absent while the tui is healthy. */
  tuiFailedAt?: string; // ISO 8601
}
```

No `tuiPid`: the tui is a direct node-pty child; the daemon holds the IPty
handle, so liveness and shutdown never need a pid lookup.

### src/core/main-entry-path.ts (new)

```ts
/** Absolute path to clauctl's own CLI entry point, for self-spawning. */
export function mainEntryPath(): string;
```

Moved from spawn.ts (module-private today); spawn.ts and daemon.ts both
import it.

### src/core/daemon.ts

All pty/emulator mechanics live in the synced PtyScreen; the tui host owns
only what is clauctl-specific — the `_tui --managed` spawn configuration,
the restart policy, and delegation to the current PtyScreen. Co-located in
daemon.ts:

```ts
export const RAPID_EXIT_MS = 5_000;
export const MAX_CONSECUTIVE_RAPID_EXITS = 3;

/**
 * Fold one tui exit into the respawn decision. A "rapid" exit is one within
 * RAPID_EXIT_MS of its spawn; MAX_CONSECUTIVE_RAPID_EXITS of them in a row
 * means the tui is broken — stop respawning instead of crash-looping.
 */
export function nextRespawnState(
  consecutiveRapidExits: number,
  spawnedAtMs: number,
  exitedAtMs: number,
): { consecutiveRapidExits: number; respawn: boolean };

/**
 * Runs `clauctl _tui --managed` in a PtyScreen (generated/pty-screen.ts);
 * respawns on exit per nextRespawnState. Each (re)spawn is a fresh
 * PtyScreen; the last one is kept after exit so its screen — including
 * crash output — remains snapshotable while the tui is failed.
 */
class TuiHost {
  constructor(opts: {
    agentId: string;
    sdkSocket: string;
    cwd: string;
    env: Record<string, string>;
    onOutput: (data: string) => void; // wired to ttyServer.broadcastOutput
    /** Called with a timestamp when respawning stops, and with undefined
     *  whenever a respawn is attempted (the failure is cleared at the
     *  attempt, not on survival — if the tui crash-loops again the field
     *  briefly flaps, which self-corrects within the rapid-exit window). */
    onFailedChanged: (failedAt: string | undefined) => void;
    log: (message: string) => void;
  });
  // write/resize/serializeScreen delegate to the current PtyScreen.
  write(data: string): void;
  resize(cols: number, rows: number): void;
  serializeScreen(): Promise<string>;
  /** Wakes a failed host: resets the crash counter and respawns. No-op
   *  while the tui is running. */
  notifyAttach(): void;
  /** Stop respawning and SIGTERM the current pty (daemon shutdown). */
  shutdown(): void;
}
```

Spawn command: `new PtyScreen(process.execPath, [mainEntryPath(), "_tui",
"--sdk-socket", <path>, "--managed"], { cwd, env })` with
`env = childEnv(undefined, agentId)` (process.env + `CLAUCTL_AGENT_ID`; no
persisted SDK env — that is claude-subprocess configuration, not tui
configuration). On every respawn the host broadcasts
`CURSOR_HOME + ERASE_SCREEN` through `onOutput` before wiring the new
PtyScreen's onData: the fresh emulator starts blank, so the clear keeps
attachers in lockstep with it.

Daemon wiring (mirrors pictl's):

- `TtyServer` hooks: `serializeScreen` → `tuiHost.serializeScreen()`;
  `writeInput` → `tuiHost.write`; `resize` → `tuiHost.resize`;
  `onAttach` → `tuiHost.notifyAttach()` + `auditAttachEvent("attach", info)`;
  `onDetach` → `auditAttachEvent("detach", info)`;
  `onAttachmentsChanged` → `record.attachments = attachments;
  queueRecordWrite()`.
- `TuiHost.onFailedChanged` → set/delete `record.tuiFailedAt`;
  `queueRecordWrite()`.
- `auditAttachEvent` is pictl's verbatim: `auditEnabled` gate,
  `resolveCallerSourceForPid(info.pid)`, `recordAuditEvent(agentDir,
  {ts, source, event, pid}, manager)`, failures logged, never fatal
  (all already exported by generated/audit.ts).
- Startup: `record.attachments = []` (a crashed predecessor leaves stale
  entries) and `delete record.tuiFailedAt`; stale `tty.sock` removed
  alongside sdk.sock; after sdk.sock is listening, construct TuiHost +
  TtyServer, `ttyServer.listen(ttySocketPath(agentDir))`, then
  `signalReady` (bind-only readiness, like pictl).
- Shutdown (`cleanupAndExit`): `tuiHost.shutdown()`, `await
  ttyServer.shutdown("agent shut down (code N)")` (exit frames to
  attachers, 1 s flush), `record.attachments = []` + queued write,
  rm tty.sock.

### src/tui/interactive-mode.ts

```ts
const tuiFlags = {
  sdkSocket: requiredStringFlag("Path to the agent's sdk.sock", "path"),
  managed: booleanFlag(
    "Run as the daemon-managed shared renderer (ctrl+c shows the detach hint instead of exiting)",
  ),
};

export async function runInteractive(
  client: SdkSocketClient,
  managed: boolean,
): Promise<void>;
// InteractiveMode's constructor gains the managed flag. In handleGlobalKey,
// managed ctrl+c sets the hint "detach: ctrl+]" (consumed, never finish()).
```

### src/core/inspect.ts

`list`: status column shows `running (tui failed)` when the record has
`tuiFailedAt` and the agent is running. `status`: adds a
`tui:      failed at <ts> (see daemon.log)` line under the same condition.
The `AgentStatus` union is unchanged — tui failure is independent of agent
status.

### Tests

- Synced: tty-protocol.test.ts, tty-server.test.ts run as-is.
- Synced: pty-screen.test.ts covers hintRoomSequence and PtyScreen.
- Hand-written: `nextRespawnState` unit tests; a managed-mode ctrl+c test
  in interactive-mode.test.ts if the existing harness makes it cheap.

## Edge cases

- **Deterministic tui crash** (e.g. a renderer bug triggered by history
  replay): respawn → crash repeats → after MAX_CONSECUTIVE_RAPID_EXITS
  rapid exits the host stops respawning and records `tuiFailedAt`. The
  agent remains fully served on sdk.sock. A later attach retries the spawn
  (`notifyAttach`), which clears `tuiFailedAt` if the tui comes back.
- **tui exits during daemon shutdown**: the shutdown flag suppresses the
  respawn path.
- **Attacher present while the tui is failed**: they see the crash output
  (it was pty output, broadcast before the exit) and a frozen screen; a
  _new_ attach triggers the respawn retry.
- **Revival with stale attachments/tuiFailedAt in agent.json**: reset at
  daemon startup before the first record write.
- **agent.json written before this change** (no `attachments` field):
  `readAgentRecord` defaults it to `[]`.
- **New attacher while the tui is failed**: the snapshot serializes the
  last screen (including the crash trace, which was pty output), then the
  hello's `notifyAttach` respawns — the attacher sees the trace, then the
  clear + fresh tui.
- **Client sends input before hello / oversized or unknown frames**:
  tty-server behavior, unchanged from pictl (drop the client / destroy the
  connection).

## Non-goals

- Changing the tty protocol (e.g. a protocol version in the hello frame) —
  recorded as future pictl work in pictl's
  docs/thoughts/tty-sock-library.md, together with factoring the protocol
  into its own repo.
- pictl-side support for `clauctl:<id>` caller sources (and vice versa).
- Fixing the `_tui` crash in docs/thoughts/tui-crash.md — a separate bug.
- Removing standalone `clauctl _tui` — it stays, for debugging, like
  `_daemon`.
- Auditing the `attach` command through the `audited: true` marker.

# IMPLEMENTATION IDEAS

- Sync order matters for review: land the sync-script change + generated
  files + deps first (mechanical), then registry/daemon/tui changes
  (semantic), then list/status.
- pictl's pty-screen refactor (pictl docs/specs/pty-screen.md) has landed;
  the implemented API matches this spec's assumptions.
- PtyScreen's `onData`/`onExit` are single-listener _setters_; the
  underlying pty handlers are registered in its constructor. TuiHost must
  set its listeners synchronously after construction (no await in between)
  — the same no-gap guarantee pictl's daemon relies on.
- The respawn decision is a pure fold (`nextRespawnState`) so the policy is
  unit-testable without clocks or sleeps; TuiHost supplies real timestamps.
- Research note (2026-07-14): surveyed tmux control mode, wezterm mux,
  ttyd/GoTTY, dtach/abduco/screen, asciinema ALiS, SSH-over-unix-socket —
  no standard tty-over-socket protocol with both TS and Rust client
  libraries exists; hand-rolling is the norm. Keeping our protocol;
  hardening notes live in pictl docs/thoughts/tty-sock-library.md.
- `list` reads agent.json without reviving, so `tuiFailedAt` reflects the
  last daemon write — for a dead daemon it is stale, but list only decorates
  the _running_ status with it, so staleness is invisible.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [ ] Add deps (node-pty, @xterm/headless, @xterm/addon-serialize)
- [x] Confirm pictl's pty-screen refactor has landed
- [ ] Extend SHARED_FILES + run sync (ansi, tty-protocol(+test),
      tty-server(+test), pty, pty-screen(+test), attach)
- [ ] registry.ts: ttySocketPath, AgentRecord.attachments, tuiFailedAt
- [ ] main-entry-path.ts (move from spawn.ts)
- [ ] daemon.ts: nextRespawnState, TuiHost, TtyServer wiring,
      attach auditing, startup/shutdown integration
- [ ] interactive-mode.ts: --managed flag, ctrl+c hint behavior
- [ ] app.ts: wire attachRoute
- [ ] inspect.ts: list/status tui-failed display
- [ ] Tests: nextRespawnState, managed ctrl+c
- [ ] README: node-pty Linux build-toolchain note (pictl README parity —
      no Linux prebuilds at ^1.0.0, install needs build-essential/python3)
- [ ] audit-wiring.test.ts: records it constructs gain `attachments: []`
- [ ] Presubmit green
