# architecture

Purpose: explain how clauctl works under the hood for contributors, AI agents,
and future client authors. This is a **working design document**, not final
user-facing documentation.

## Big picture

clauctl turns a `claude` process into a long-lived agent that can be controlled
through stable local protocols and attached to as a terminal UI.

The main pieces are:

- a `claude` process in programmatic (stream-json) mode, driven through the
  [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview);
- a per-agent clauctl daemon, launched as `clauctl _daemon`, which owns the
  single SDK connection to that process;
- the clauctl protocol, served by the daemon on the agent's `socket`, effectively
  multiplexing that single SDK connection;
- `CLAUCTL_DIR`, a filesystem registry of agent directories;
- `clauctl`, the CLI, which acts as the "shell SDK" for these protocols.

There is no central clauctl daemon. Each agent has its own daemon process.

Claude allows one programmatic connection per session and, in stream-json
mode, has no terminal to attach to, hence the daemon and clauctl's own TUI
(see [`claude-agent-sdk.md`](claude-agent-sdk.md)).

## Spawn flow

`clauctl spawn`:

- creates `$CLAUCTL_DIR/<agent-id>/`, the registry entry for this agent, and
  persists the spawn options in it;
- launches a detached daemon process (`clauctl _daemon --agent-id <id>`) with
  its stdio redirected to `daemon.log`, and waits for a readiness handshake
  over an inherited pipe;
- prints the agent id (and attaches if `--attach`).

The daemon then:

- opens the SDK session in **streaming-input mode**: a held-open input
  iterable feeds successive turns into one warm `claude` process;
- serves the agent's `socket`;
- owns `agent.json`, keeping the current session id, pids, and attachment
  list up to date.

The daemon is solving roughly the same category of problem as tmux or
persistent IDE terminals: a background process owns the session, and frontends
connect and disconnect.

## The clauctl protocol

The agent's `socket` speaks a clauctl-defined protocol (`clauctl-protocol`, version 1):
newline-delimited JSON in both directions, opened by a `hello` record with
protocol/version information. Client requests carry an `id`; server lines with
an `id` are responses, and lines with an `event` are pushed events. The
working definition is [`src/core/protocol.ts`](../src/core/protocol.ts).

What the protocol offers — the request surface (subscribe, SDK passthrough,
conversation operations), the event stream, `AgentState`, and the philosophy
behind them — is [`protocol.md`](protocol.md). `set-context`,
the one request that restarts the SDK session, is explained in this
[blog post](https://geraschenko.com/blog/claude-context).

### The `AgentState` fold

`AgentState` is the shared answer to "what is this agent doing right now":
activity, current session id, the transcript leaf, queued and delivered user
messages, model/permission/tool state, and usage.

It is maintained by a single pure fold function, `nextAgentState(state, event)`,
exported from the same module that defines the wire types
([`src/core/agent-state/agent-state.ts`](../src/core/agent-state/agent-state.ts)). The daemon folds
every event before broadcasting it; every subscriber folds the identical
function over the events it receives. There is no separate client-side state
model to drift out of sync.

The SDK's live stream does not echo user prompts, so the daemon synthesizes
queue events itself and maintains the **prompt-visibility invariant**: every
accepted prompt is visible in exactly one of `queuedMessages` (accepted, not
yet handed to the SDK), `deliveredMessages` (handed over, not yet in the
transcript), or the transcript at-or-before `leaf`. See
[`user-message-tracking.md`](user-message-tracking.md) for why this exists and
its accepted limitations.

### Terminal attach

`clauctl attach` runs clauctl's TUI directly in the caller's terminal: it
ensures the daemon is running, connects to `socket`, subscribes, fetches
history with `get-entries`, and renders locally, keeping its own rolling
session trees from the event stream (`SessionModel`,
[`session-views.md`](session-views.md)). The TUI is an ordinary protocol client with no privileged
access — an embedder that wants to draw its own UI speaks the protocol itself;
one that wants a terminal view runs `clauctl attach` in a pty it owns.

Detach is the remappable `app.detach` keybinding (default
`ctrl+]`) and leaves the agent running. Attachers identify themselves in
their `subscribe` request (`attachment: { pid, client }`), so the daemon
records live attachments in `agent.json` and audits attach/detach events
([`audit.md`](audit.md)) —
the connection close counts as detach, catching killed attachers. Observers
like `tail` subscribe without an attachment and stay invisible.

When the daemon shuts down deliberately (archive, stream end), it emits a
`shutdown` event before teardown, so attachers can report "agent shut down"
instead of a lost connection; an unannounced socket close means the daemon
crashed.

## `CLAUCTL_DIR` as the registry

clauctl persists the registry under `$CLAUCTL_DIR`, defaulting to the per-OS
user data directory (via
[`env-paths`](https://www.npmjs.com/package/env-paths), e.g.
`~/.local/share/clauctl` on Linux). The registry is the directory tree itself:

```text
$CLAUCTL_DIR/
  <agent-id>/
    agent.json
    spawn-options.json
    socket
    daemon.log
    audit.jsonl / sources.jsonl
    archived / revive.lock (marker files)
```

There is no central registry daemon and no central index file. Commands
discover agents by reading directories: an agent is "running" if its recorded
daemon pid is alive, with marker files distinguishing the dormant flavors.

`agent.json` is daemon-owned metadata. Its exact schema is expected to
evolve; the working source reference is
[`src/core/registry.ts`](../src/core/registry.ts). The important invariants:

- the daemon is the only writer, and writes are atomic
  (temp file + fsync + rename);
- it records enough to inspect and revive the agent: pids, the spawn
  options' persistable subset, and every Claude session id this agent has
  been associated with;
- session _contents_ are Claude's responsibility, not clauctl's —
  `agent.json` records the association, the transcripts live in Claude's
  own config directory.

## Agent id ≠ session id

A clauctl **agent** is the long-lived controllable slot; a Claude
**session id** names conversation state within it. One agent spans a sequence
of session ids over its lifetime: `/clear` and `/new` wipe the context and
start a new session id **in the same process**. The daemon detects a rollover
by observing a changed session id on the stream (not by counting `init`
messages, which fire every turn) and appends it to the `sessions` list in
`agent.json`.

Each session id has its own append-only transcript JSONL under Claude's
config dir (`<config>/projects/<sanitized-cwd>/<session-id>.jsonl`). The
daemon follows the current file live and merges it with the SDK stream
([`stream-merging.md`](stream-merging.md)); clients never read the files —
`tail`, the TUI's history replay and `get-entries` are all served from the
daemon's resident view, deduplicated first-occurrence-wins, as a flat entry
list plus a current-leaf pointer. Entry uuids are durable cursors
(`tail --since <uuid>`). Only a dormant agent's `tail` reads the file
directly.

## Lifecycle model

An agent is more than a running process: it is the agent directory plus its
recorded lineage and metadata.

Important states:

- **running**: daemon and `claude` are up; `socket` accepts connections.
- **dormant**: the agent directory exists, but the processes are gone.
- **archived**: dormant and hidden from normal `clauctl list` (visible with
  `--all`). `clauctl archive` stops the agent politely first; nothing is
  deleted.

Commands that _talk to_ the agent — `prompt`, `attach`, and all SDK
passthrough subcommands — transparently revive a dormant (or archived) agent:
a new daemon is spawned with the persisted options plus
`resume: <last session id>`, so it comes back mid-conversation as if never
interrupted. Revival is serialized per agent with an exclusive lock file so
concurrent commands do not race to start two daemons.

Commands that _observe_ — `list`, `status`, `tail`, `wait` — never revive.
`tail` reads a dormant agent's session file directly; `wait` treats
dormancy as satisfying any condition.

Code-valued spawn options (`hooks`, `canUseTool`, in-process MCP servers) are
not serializable and therefore not part of the respawn recipe; the persisted
subset is exactly the serializable one.

## clauctl as the shell SDK

clauctl is meant to be the language-neutral shell interface to this system.

- humans use it directly, non-interactively or with `clauctl attach`;
- agents and scripts use it to spawn, discover, prompt, and monitor other
  agents — every protocol request type has a corresponding subcommand;
- clients that want structured state can speak the protocol directly — a
  small, versioned, hello-first protocol designed to be implemented outside
  this codebase; clients that need a terminal view run `clauctl attach` in a
  pty they own.

The design goal is that anything a human can do by hand has a corresponding
scriptable operation, without making the agent less interactive or less
attachable.

## Reference material

- exact protocol definition: [`src/core/protocol.ts`](../src/core/protocol.ts);
- exact `agent.json` schema: [`src/core/registry.ts`](../src/core/registry.ts);
- the state fold: [`src/core/agent-state/agent-state.ts`](../src/core/agent-state/agent-state.ts);
- the protocol and its philosophy: [`protocol.md`](protocol.md);
- merging the SDK stream with the session file: [`stream-merging.md`](stream-merging.md);
- the three views of a session: [`session-views.md`](session-views.md);
- what Claude and its SDK actually do: [`claude-agent-sdk.md`](claude-agent-sdk.md);
- prompt tracking: [`user-message-tracking.md`](user-message-tracking.md);
- who did what to an agent: [`audit.md`](audit.md).
