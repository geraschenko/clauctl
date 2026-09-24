# `clauctl attach` — terminal attach via a daemon-hosted TUI

> **SUPERSEDED** by [attach-direct-tui.md](attach-direct-tui.md):
> `clauctl attach` now runs the TUI directly in the caller's terminal as an
> `sdk.sock` client, and the entire tty.sock stack this spec describes
> (TuiHost, TtyServer, the frame protocol, `_tui --managed`) has been
> removed. Kept as a historical record of the daemon-hosted-TUI design.

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
`env = childEnv(undefined, agentId)` (process.env + `CLAUCTL_ID`; no
persisted SDK env — that is claude-subprocess configuration, not tui
configuration). On every respawn the host broadcasts
`CURSOR_HOME + ERASE_SCREEN` through `onOutput` before wiring the new
PtyScreen's onData: the fresh emulator starts blank, so the clear keeps
attachers in lockstep with it.

Daemon wiring (mirrors pictl's):

- `TtyServer` hooks: `serializeScreen` → `tuiHost.serializeScreen()`;
  `writeInput` → `tuiHost.write`; `resize` → `tuiHost.resize`;
  `onAttach` → `tuiHost.notifyAttach()` + `auditAttachEvent(...)`;
  `onDetach` → `auditAttachEvent(...)`;
  `onAttachmentsChanged` → `record.attachments = attachments;
  queueRecordWrite()`.
- `TuiHost.onFailedChanged` → set/delete `record.tuiFailedAt`;
  `queueRecordWrite()`.
- `auditAttachEvent(agentDir, enabled, event, info, log)` is shared from
  pictl via generated/audit.ts: `enabled` gate,
  `resolveCallerSourceForPid(info.pid)`, `recordAuditEvent(agentDir,
  {ts, source, event, pid}, manager)`, failures logged, never fatal.
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
- Fixing the `_tui` crash in docs/follow-ups/tui-crash.md — a separate bug.
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

- [x] Add deps (node-pty, @xterm/headless, @xterm/addon-serialize)
- [x] Confirm pictl's pty-screen refactor has landed
- [x] Extend SHARED_FILES + run sync (ansi, tty-protocol(+test),
      tty-server(+test), pty, pty-screen(+test), attach)
- [x] registry.ts: ttySocketPath, AgentRecord.attachments, tuiFailedAt
- [x] main-entry-path.ts (move from spawn.ts)
- [x] daemon.ts: nextRespawnState, TuiHost, TtyServer wiring,
      attach auditing, startup/shutdown integration
- [x] interactive-mode.ts: --managed flag, ctrl+c hint behavior
- [x] app.ts: wire attachRoute
- [x] inspect.ts: list/status tui-failed display
- [x] Tests: nextRespawnState (daemon.test.ts). Managed ctrl+c test skipped:
      interactive-mode.test.ts only exercises pure functions — an
      InteractiveMode test needs TUI + SdkSocketClient mocks, which the spec
      made conditional on being cheap; it is not.
- [x] README: created README.md (per review: modeled on pictl's, only
      covering built functionality, deliberately short); includes the
      node-pty Linux build-toolchain note.
- [x] audit-wiring.test.ts + registry.test.ts: record literals gain
      `attachments: []`
- [x] Presubmit green (126 tests, incl. the 25 synced
      tty-protocol/tty-server/pty-screen tests)
- [x] End-to-end smoke test (temp CLAUCTL_DIR): spawn → tty.sock served,
      `attachments: []` in agent.json; scripted hello+resize client receives
      the TUI snapshot (editor + idle footer); attach/detach audited to
      audit.jsonl with pid-resolved source; 3 rapid tui kills → tuiFailedAt
      set, `list` shows `running (tui failed)`, `status` shows the tui line,
      daemon.log logs "not respawning until the next attach"; a slow exit
      resets the counter (observed); new attach → respawn + tuiFailedAt
      cleared; SIGTERM → both sockets removed, attachments cleared, no
      leaked children.

## Implementation-Time Decisions

- **TuiHost ctor drops the spec's `agentId` opt** — it was unused: the spawn
  command line doesn't take an agent id, and the env already carries
  CLAUCTL_ID (the caller builds it with `childEnv(undefined, agentId)`).
- **TuiHost tracks `tuiExited` and drops `write`/`resize` after exit** — the
  pty fd is gone, and node-pty raises on writes to a dead pty; the frozen
  crash screen has nothing to receive them anyway. `serializeScreen` stays
  live (PtyScreen's emulator survives exit). The same flag guards
  `shutdown()`'s SIGTERM (don't signal an already-dead pty). pictl has no
  counterpart because pi's exit immediately tears the daemon down.
- **`TuiHostOptions` is a named interface, not a parameter property** — Node's
  strip-only type-stripping (`node --test` on .ts) rejects TypeScript
  parameter properties (`constructor(private readonly opts: {...})`), so the
  options object is an explicit field assigned in the constructor body.
- **`tuiHost`/`ttyServer` are deferred `let` slots with an eslint
  `prefer-const` disable** — cleanupAndExit must exist before sdk.sock is
  bound (early failure paths call it), but the tui can only be constructed
  after (it connects to sdk.sock). The rule can't see the read-before-assign
  closure pattern.
- **Exit frames are sent after the claude stream drains** — cleanupAndExit
  calls `ttyServer.shutdown("agent shut down (code N)")` inside the existing
  post-`readerDone` teardown, so attachers get the exit frame once the agent
  is actually gone (matching the message), not at SIGTERM receipt.
- **TuiHost re-applies the last size to every fresh PtyScreen** (review
  finding): TtyServer caches the applied min size and only calls the resize
  hook when it _changes_, so a respawned tui — whose pty starts at the 80×24
  default — would otherwise keep rendering at 80×24 for attachers whose min
  size is unchanged (the common reattach-after-failure case). TuiHost.resize
  records the size; spawnTui re-applies it.
- **`nextRespawnState` became `nextConsecutiveRapidExits`** (review): the
  spec's `respawn` field was derivable from the returned counter, so the
  fold now returns just the count and the single caller compares it against
  MAX_CONSECUTIVE_RAPID_EXITS at the decision point.
- **daemon.ts split into `src/core/daemon/`** (review): the file had grown
  past 900 lines. Logical units now live in their own modules —
  `turn-queue.ts` (TurnQueue), `event-bus.ts` (EventBus), `tui-host.ts`
  (TuiHost + the crash-loop fold, with `tui-host.test.ts`), `sdk-server.ts`
  (startSdkServer, SdkConnection, RESPONSE_SENT), and `daemon.ts` (the
  `_daemon` command: startup classification, wiring, teardown). app.ts
  imports `./daemon/daemon.ts` directly; no barrel file.
