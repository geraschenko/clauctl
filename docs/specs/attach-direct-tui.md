# `clauctl attach` runs the TUI directly

Supersedes docs/specs/attach.md (the daemon-hosted-TUI architecture this
spec removes).

# SPEC

## Problem statement

`clauctl attach` currently connects to a daemon-hosted shared renderer: the
daemon runs `clauctl _tui --managed` inside a PtyScreen (headless xterm) and
serves its screen over tty.sock; the attach client proxies bytes and
intercepts the detach key at the tty level. This architecture — adopted from
pictl, where the pty process (pi) _is_ the agent — is a wart in clauctl,
where the TUI is already a pure sdk.sock client:

- The detach key is a hardcoded tty-level byte intercept (0x1d), invisible
  to `/keybindings` and unremappable.
- The attach hint lives outside the TUI (drawn over the snapshot's bottom
  row via hintRoomSequence), which desyncs the fullscreen renderer's
  absolute rows — the recorded hint-row off-by-1 (tui-fullscreen.md WORK
  LOG, 2026-08-21).
- All attachers share one screen at the elementwise-minimum size.
- The daemon carries a pty, a terminal emulator, a frame protocol, a
  crash-loop policy, and a native dependency (node-pty) solely to host a
  renderer that any terminal can run itself.

The embedding use case that justified tty.sock ("clients in other languages
attach by speaking the tty protocol") is better served by running
`clauctl attach` in a pty the embedder owns: standard pty infrastructure
exists in every language, gives per-pane sizing for free, and is uniform
with pictl (`pictl attach` in a pty works today).

`clauctl attach` therefore runs the TUI directly in the caller's terminal
as an sdk.sock client, and the tty.sock stack is removed.

## Success criteria

1. `clauctl attach --target <agent>` (and `spawn --attach`) runs the
   interactive TUI in the caller's terminal: `ensureAgentRunning`, connect
   sdk.sock, `runInteractive`. Each attacher is an independent TUI at its
   own terminal size.
2. Detach is a registry action `app.detach` (default `ctrl+]`), remappable
   via keybindings.json and listed by `/keybindings`. The `app.clear` hint
   renders the live binding, not a hardcoded string.
3. The daemon announces shutdown: a new `{ kind: "shutdown", reason }`
   SdkEvent is emitted before teardown, so an attacher (and `tail`) can
   distinguish a deliberate shutdown (e.g. archive → SIGTERM) from a daemon
   crash (socket close with no announcement).
4. Attach tracking and auditing survive: `subscribe` gains an optional
   `attachment: { pid, client }` self-identification. The daemon records
   identified subscribers in `record.attachments` (cleared on startup and
   clean shutdown, as today) and audits `attach`/`detach` events to
   audit.jsonl with the same daemon-side `/proc` caller resolution.
   Connection close counts as detach, so kill -9'd attachers are recorded.
   `tail` subscribes bare and stays invisible, as today.
5. The tty.sock stack is deleted: tty-service, TuiHost (+ crash-loop
   policy and `record.tuiFailedAt`), tty.sock binding/cleanup, and the
   generated files `attach.ts`, `ansi.ts`, `tty-protocol(.test).ts`,
   `tty-server(.test).ts`, `pty.ts`, `pty-screen(.test).ts` leave the sync
   manifest and the repo. Dependencies `node-pty`, `@xterm/headless`,
   `@xterm/addon-serialize` are dropped.
6. The `_tui` subcommand is removed: `attach` is now exactly `_tui` plus
   lifecycle, nothing spawns `_tui` anymore (only TuiHost did), and its old
   role as the only private renderer is `attach`'s normal behavior.
7. docs/specs/attach.md is marked superseded by this spec.

Prerequisite (upstream): pictl's `auditAttachEvent` parameter changes from
`AttachmentInfo` to structural `{ pid: number }` so generated/audit.ts no
longer imports tty-server.ts (handoff: pictl
docs/handoff-audit-attach-pid.md).

## Concrete examples

```
$ clauctl attach -t 3837
# the TUI opens in this terminal, fullscreen (settings.json), at this
# terminal's own size; a second attacher elsewhere gets its own view
# user presses ctrl+] (or their remapped app.detach):
detached from 383702e1-…

# meanwhile, from another shell:
$ clauctl archive -t 3837
# the attached terminal restores its screen and prints:
agent 383702e1-… shut down (SIGTERM)

$ cat <agentDir>/audit.jsonl
{"ts":"…","source":"bash:12345","event":"attach","pid":23456}
{"ts":"…","source":"bash:12345","event":"detach","pid":23456}

# daemon crash (no shutdown event before the socket closed):
connection to agent daemon lost   # exit code 1
```

## Type design

### src/tui/attach.ts (new, clauctl-owned; replaces generated/attach.ts)

```ts
/** oneTarget → ensureAgentRunning → TTY check →
 *  SdkSocketClient.connect(sdkSocketPath(agentDir)) →
 *  runInteractive(client, agentDir) → print the outcome message. */
export async function attach(this: CommandContext): Promise<void>;

export const attachRoute = { attach: attachCommand } as const; // common: true
```

Outcome messages and exit codes (matching today's finish() codes):
`detached` → `detached from <id>` (0); `shutdown` → `agent <id> <reason>`
(0); `connectionLost` → `connection to agent daemon lost` (1, thrown as an
error). Non-TTY stdin/stdout throws, as today. spawn.ts's `--attach`
imports `attach` from here; app.ts imports `attachRoute` from here.

### src/tui/interactive-mode.ts

```ts
export type InteractiveOutcome =
  | { kind: "detached" }                 // app.detach pressed
  | { kind: "shutdown"; reason: string } // daemon shutdown event received
  | { kind: "connectionLost" };          // socket closed unannounced

export async function runInteractive(
  client: SdkSocketClient,
  logDirectory: string,
): Promise<InteractiveOutcome>;
```

- The `_tui` route (`tuiRoute`, `tuiFlags`) is deleted; attach.ts is
  `runInteractive`'s only caller. `InteractiveMode`'s constructor becomes
  `(ui, client, seed, startupWarnings)` and its `managed` field is deleted.
- `InteractiveMode.done: Promise<InteractiveOutcome>` — resolved
  `{kind:"detached"}` by the `app.detach` handler in `handleGlobalKey`
  (replacing the `!managed && matchesKey(data, "ctrl+]")` branch),
  `{kind:"shutdown", reason}` by `handleEvent` on the shutdown event.
- `runInteractive` resolves `connectionLost` when the socket closes without
  `done` having settled. `subscribe` passes
  `{ pid: process.pid, client: "clauctl attach" }`.
- The `app.clear` hint uses `keybindings.getKeys("app.detach")` to render
  the live binding.

### src/tui/keybindings.ts

```ts
declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    // ...existing...
    "app.detach": true;
  }
}
// CLAUCTL_KEYBINDINGS gains:
"app.detach": {
  defaultKeys: "ctrl+]",
  description: "Detach from the agent (it keeps running)",
},
```

### src/core/sdk-socket.ts

```ts
/** subscribe's optional self-identification; attachers send it, tail does not. */
export interface SubscribeAttachment {
  pid: number;
  client: string;
}

// SdkRequest's subscribe variant:
| { type: "subscribe"; attachment?: SubscribeAttachment }

// SdkEvent gains:
| { kind: "shutdown"; reason: string }

// SdkSocketClient:
async subscribe(attachment?: SubscribeAttachment): Promise<SdkEventSubscription>;
```

Additive protocol change; SDK_SOCKET_VERSION stays 1 (the existing
version warning covers mismatched builds).

### src/core/registry.ts

```ts
/** A live attached TUI (an sdk.sock subscriber that identified itself). */
export interface AttachmentInfo {
  pid: number;
  client: string;
  connectedAt: string; // ISO 8601
}
```

Moved from generated/tty-server.ts, minus `size` (sizes are per-terminal
now; the daemon never sees them). `ttySocketPath` and
`AgentRecord.tuiFailedAt` are removed; `attachments` keeps its semantics
(daemon-owned, reset on startup and clean shutdown).

### src/core/daemon/request-handlers.ts

```ts
// CreateRequestHandlerOptions gains:
/** Register a live attacher; returns the deregister, wired to connection
 *  close. Implemented by daemon.ts (record write + audit). */
registerAttachment(info: SubscribeAttachment): () => void;
```

The subscribe case validates `attachment` when present (pid a number,
client a string; anything else rejects the request), calls
`registerAttachment`, and wires the deregister to `connection.onClose`
alongside the existing unsubscribe.

### src/core/daemon/daemon.ts

```ts
// registerAttachment implementation: build AttachmentInfo with
// connectedAt = now, push to record.attachments + queueRecordWrite +
// auditAttachEvent(agentDir, auditEnabled, "attach", { pid }, log);
// the deregister removes the entry, queues a write, audits "detach".

const cleanupAndExit = (code: number, reason: string): void => { ... };
// Emits events.emit({ kind: "shutdown", reason }) first, before any
// teardown, so subscribers get the line ahead of the socket close.
```

Reasons at the call sites: `shut down (SIGTERM)`, `shut down (SIGINT)`,
`exited (claude stream ended)`, `crashed (claude stream failed)`; early
startup-failure paths pass a startup reason (no subscribers exist to hear
it). tty-service startup/teardown, both tty.sock `rm`s, and the
attachments/tui-failure callbacks are deleted (attachment writes now go
through `registerAttachment`; the startup `record.attachments = []` reset
and the shutdown clear remain).

### src/core/agent-state.ts, src/core/daemon/event-hub.ts, src/format/events.ts

- `nextAgentState` passes `shutdown` through unchanged (total fold).
- `EventHub.emit`'s Extract union gains `"shutdown"` (no queue-model
  involvement).
- format/events.ts renders it as one line, so `tail` reports the shutdown.

### src/core/inspect.ts

The `running (tui failed)` list decoration and the `tui:` status line are
removed with `tuiFailedAt`.

### Deletions

- `src/core/daemon/tty-service.ts`, `tui-host.ts`, `tui-host.test.ts`
- `src/core/generated/`: `attach.ts`, `ansi.ts`, `tty-protocol.ts` (+test),
  `tty-server.ts` (+test), `pty.ts`, `pty-screen.ts` (+test) — and their
  entries in scripts/sync-from-pictl.mjs
- package.json: `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`

## Data flow

Attach: `clauctl attach` → `ensureAgentRunning` (spawns/revives the
daemon) → `SdkSocketClient.connect` →
`subscribe { attachment: { pid, client: "clauctl attach" } }` → the daemon
registers the attachment (record write + audit) and streams events → the
TUI renders locally at the terminal's own size. `app.detach` resolves
`done` → `runInteractive` restores the screen (`preserveScreen` in
fullscreen) → attach prints `detached from <id>`; the daemon sees the
connection close, deregisters, audits `detach`.

Shutdown: signal (or stream end) → `cleanupAndExit(code, reason)` → the
hub emits `{ kind: "shutdown", reason }` to all subscriber sinks →
teardown proceeds (queue close, stream drain, socket close) → the TUI's
`handleEvent` resolves `done` with the reason → attach prints it. A crash
skips the event; the attacher sees only the close → `connectionLost`.

## Cost

- **Process per attacher**: each attached terminal runs a full node TUI
  process; the daemon-hosted renderer amortized this to one. Embedders
  showing many panes pay it per visible pane (mitigable by spawning attach
  lazily — reattach is snapshot-free).
- **Cold start instead of snapshot**: attach renders from the subscribe
  seed + transcript instead of receiving a screen dump — exactly today's
  TUI-respawn path.
- Everything else is deletion (~2k lines of generated code, the native
  node-pty dependency, the daemon's pty/emulator).

## Edge cases

- **Daemon crash / kill -9**: no shutdown event; attachers get
  `connectionLost` (exit 1). Stale `record.attachments` are reset at the
  next daemon startup (existing behavior, unchanged).
- **Attacher kill -9'd**: the daemon sees the connection close →
  deregister + `detach` audit. (Client-side auditing could not do this;
  daemon-side registration is why.)
- **Old daemon, new client**: the daemon ignores the unknown `attachment`
  field — attach works, untracked; the hello version warning already
  flags mismatched builds.
- **Malformed `attachment` in a subscribe request**: the request is
  rejected with an error (untrusted JSON is validated, not cast).
- **Shutdown-event delivery is best-effort**: the line is written to the
  socket before teardown, but a process exit races kernel buffers; a lost
  line degrades to `connectionLost`, never to a hang.
- **agent.json from an older build** (`tuiFailedAt` present): the unknown
  field is ignored and dropped on the next record write.
- **Two attachers prompt concurrently**: both are ordinary sdk.sock
  clients; the queue model already serializes turns. Independent view
  state (scroll, expanded tools) per attacher is intended.
- **Non-Linux `/proc`**: audit caller resolution falls back to
  `process:<pid>` (existing audit.ts behavior, unchanged).
- **Daemon shutdown with live attachers**: no `detach` audit events are
  emitted for them — parity with today (TtyServer.shutdown suppresses the
  detach hooks); the shutdown record write clears `attachments`. A socket
  close racing teardown may still audit a detach; harmless either way.

## Non-goals

- Migrating pictl (or pictl-rs's tty_client/AttachPane) to pty-based
  embedding — a pictl decision; `pictl attach` in a pty already works.
- Shared-screen mirroring across attachers (deliberately dropped — it was
  a consequence of the single hosted renderer, not a requirement).
- A TUI-side "attached to <id>" startup banner or toast.
- The remaining tui-fullscreen follow-ups (`/settings` command, runtime
  mode switching, `openUrl`).

# IMPLEMENTATION IDEAS

- Order for review: (1) upstream pictl auditAttachEvent change + resync;
  (2) protocol + daemon side (shutdown event, subscribe attachment,
  registerAttachment); (3) TUI side (app.detach, InteractiveOutcome,
  attach command); (4) deletions (tty stack, deps, sync manifest);
  (5) docs (attach.md superseded banner, daemon-architecture.md tty.sock
  references).
- `runInteractive`'s race: `done` vs `waitClosed` vs the event pump. The
  pump ending (queue closed on socket close) and `waitClosed` both mean
  `connectionLost` unless `done` already settled; pump errors still
  propagate. Resolve the outcome after the race by checking whether `done`
  settled — e.g. race `done` against `waitClosed().then(() => fallback)`.
- The shutdown event arrives through the pump; `handleEvent` resolving
  `done` and the subsequent socket close race benignly — `done` settles
  first in wire order because the event line precedes the close.
- `app.clear`'s CLAUCTL_KEYBINDINGS description ("Detach from the agent
  (press twice)") is stale either way; update it while touching the hint.
- audit-wiring.test.ts exercises attach auditing via tty hooks today;
  rework it against `registerAttachment`. registry/record tests drop
  `tuiFailedAt` fixtures.
- The tui-parity harness's `--clauctl-in-tmux` path runs `clauctl attach`
  in tmux; it inherits the direct-TUI behavior unchanged (and no longer
  renders through the daemon's emulator).
- Derisk findings (2026-08-24): tty-protocol consumers inside this repo:
  only generated/attach.ts. `ansi.ts` users outside the dropped set: only
  tui-host.ts (also dropped). `KeybindingsManager.getKeys` exists in
  pi-tui for rendering the live detach binding. pictl call sites of
  `auditAttachEvent` pass `AttachmentInfo`, structurally compatible with
  `{ pid: number }`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-08-24: Derisk complete. Decisions: full tty.sock removal (embedding
  runs `clauctl attach` in an embedder-owned pty; uniform with pictl);
  attach tracking/audit preserved via subscribe self-identification (2a);
  detach becomes remappable `app.detach`; crash-loop policy and
  `tuiFailedAt` die with the hosted renderer; shutdown announced via a new
  SdkEvent; attach.md marked superseded. Upstream prerequisite handed off:
  pictl auditAttachEvent → `{ pid: number }`.
- 2026-08-24 review (TDC): `_tui` is removed rather than kept as a
  debugging entry — nothing spawns it once TuiHost is gone, and `attach` is
  `_tui` plus lifecycle. This also dropped the `attachmentClient` parameter
  `runInteractive` had grown to keep `_tui`'s audit label honest.
- 2026-08-24: Implementation complete. Order as planned: resync (only
  audit.ts changed — the upstream `{ pid: number }` signature landed
  exactly as the handoff specified), protocol + daemon, TUI, deletions,
  docs. Presubmit green (572 tests; the usual treefmt first-run
  reformat). Not yet done: a live smoke (spawn → attach → detach →
  archive-while-attached) needs an interactive terminal.

## Implementation-Time Decisions

- **`runInteractive` races `done` against the pump only** (no
  `waitClosed`): the event queue closes when the socket does — after
  draining, since close() keeps received events — so pump-end subsumes
  waitClosed and arrives strictly after any shutdown event was handled.
  Racing waitClosed directly could misreport an announced shutdown as
  connectionLost (the close event can fire before the pump's microtask
  processes the queued shutdown line).
- **Deregister idempotence via array identity**: the shutdown path
  reassigns `record.attachments = []`, so a connection-close deregister
  racing teardown finds its entry gone (indexOf −1) and skips the detach
  audit — the "no detach audits on daemon shutdown" edge case falls out
  without a teardown flag.
- **audit-wiring.test.ts needed no rework**: it covers command auditing
  only (the tty attach hooks were never under test there). Attach
  registration is covered by new request-handlers.test.ts cases instead:
  register + deregister-on-close, malformed-attachment rejection before
  any side effect, and bare subscribe staying invisible.
- **Docs**: the live tty.sock prose was in architecture.md and
  overview.md (both rewritten); daemon-architecture.md is a completed
  historical spec and was left as a record, like attach.md (which got the
  superseded banner).
- `tail` renders the shutdown event as `[agent <reason>]`, matching the
  attach exit message's phrasing.
- `app.clear`'s description became "Clear the editor input" (it never
  detached; the detach description lives on `app.detach` now).
- **Review fixes** (post-implementation pass): (1) the shutdown event is
  handled in `handleEvent` before the history-replay buffer — it is
  terminal and order-independent, and a buffered shutdown whose socket
  close beat the buffer release would misreport as connectionLost;
  (2) `readAgentRecord` sheds `tuiFailedAt` from older records —
  `writeAgentRecord` persists the whole parsed record, so without the
  read-side delete the stale field would survive every rewrite, contrary
  to the spec's "dropped on the next write" edge case.
