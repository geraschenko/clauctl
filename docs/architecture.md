# architecture

Purpose: explain how clauctl works under the hood for contributors, AI agents,
and future client authors. This is a **working design document**, not final
user-facing documentation.

Question answered: **how does clauctl work?**

## Big picture

clauctl turns a `claude` process into a long-lived agent that can be controlled
through stable local protocols and attached to as a terminal UI.

The main pieces are:

- a `claude` process in programmatic (stream-json) mode, driven through the
  [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview);
- a per-agent clauctl daemon, launched as `clauctl _daemon`, which owns the
  single SDK connection to that process;
- `sdk.sock`, owned by the daemon, exposing clauctl's structured agent
  protocol;
- `CLAUCTL_DIR`, a filesystem registry of agent directories;
- `clauctl`, the CLI, which acts as the "shell SDK" for these protocols.

There is no central clauctl daemon. Each agent has its own daemon process.

Two facts about Claude shape everything else (see
[`claude-agent-sdk.md`](claude-agent-sdk.md) for the full list):

1. **One programmatic connection per session.** Claude does not allow a
   simultaneous interactive and programmatic connection to the same session.
   The daemon therefore owns the only SDK connection, and everything else —
   CLI subcommands, the TUI, embedders — is a client multiplexed through the
   daemon's sockets.
2. **Programmatic Claude has no terminal.** In stream-json mode `claude` emits
   structured JSON, not terminal bytes, so there is no stock TUI to attach to.
   clauctl ships its own TUI, which `clauctl attach` runs directly in the
   caller's terminal as an ordinary `sdk.sock` client.

## Spawn flow

`clauctl spawn`:

- creates `$CLAUCTL_DIR/<agent-id>/`, the registry entry for this agent, and
  persists the spawn options in it;
- launches a detached daemon process (`clauctl _daemon --agent-id <id>`) with
  its stdio redirected to `daemon.log`, and waits for a readiness handshake
  over an inherited pipe;
- prints the agent id (and attaches, with `--attach`).

The daemon then:

- opens the SDK session in **streaming-input mode**: a held-open input
  iterable feeds successive turns into one warm `claude` process;
- serves `sdk.sock`;
- owns `agent.json`, keeping the current session id, pids, and attachment
  list up to date.

The daemon is solving roughly the same category of problem as tmux or
persistent IDE terminals: a background process owns the session, and frontends
connect and disconnect.

## The socket

### `sdk.sock`: the structured agent protocol

`sdk.sock` speaks a clauctl-defined protocol (`clauctl-sdk-socket`, version 1):
newline-delimited JSON in both directions, opened by a `hello` record with
protocol/version information. Client requests carry an `id`; server lines with
an `id` are responses, and lines with an `event` are pushed events.

The request surface has three layers:

- **subscribe** — returns a _seed_ (a complete `AgentState` snapshot) followed
  by the live event stream. Clients maintain the `AgentState` by folding
  events onto the seed with the same fold function the daemon uses (see below).
- **SDK passthrough** — control mutations (`set-model`, `set-permission-mode`,
  `set-mcp-servers`, …) and reads (`supported-models`, `usage`,
  `mcp-server-status`, …) that map 1:1 onto Claude Agent SDK `Query` methods.
  Every `Query` method is covered except the ones that only make sense
  in-process (`close`, `streamInput`, `reinitialize`). Mutations that change
  persistable state also update the persisted options, so the respawn recipe
  stays current.
- **conversation operations** — `prompt`, `interrupt`, `get-context`,
  `get-entries`, `set-context`. These need daemon-side logic beyond the Claude
  Agent SDK (queueing, session-file access, context surgery).

The pushed event stream is a superset of the Claude Agent SDK's: every SDK
message is forwarded verbatim (as `sdkMessage` events), and clauctl adds the
events a client needs to maintain an accurate `AgentState` — the queue events
(`userMessageQueued`/`userMessageDequeued`), `compactSent`, `interruptSent`,
`contextChanged`, and `controlApplied`. See
[`claude-agent-sdk.md`](claude-agent-sdk.md) for why the SDK stream alone is
not enough.

`set-context` is the one request that rewrites history: it appends a
compact-boundary entry to the session file and restarts the SDK session on it.
`get-context` derives the assistant's context from the session file through the
context tree (`docs/session-views.md`), so it needs no daemon state to agree
with what the next turn will see. This [blog post](https://geraschenko.com/blog/claude-context) details how
`set-context` works.

The working definition of this protocol is
[`src/core/sdk-socket.ts`](../src/core/sdk-socket.ts).

### The `AgentState` fold

`AgentState` is the shared answer to "what is this agent doing right now":
activity, current session id, the transcript leaf, queued and delivered user
messages, model/permission/tool state, and usage.

It is maintained by a single pure fold function, `nextAgentState(state, event)`,
exported from the same module that defines the wire types
([`src/core/agent-state.ts`](../src/core/agent-state.ts)). The daemon folds
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
ensures the daemon is running, connects to `sdk.sock`, subscribes, and
renders locally. The TUI is an ordinary `sdk.sock` client with no privileged
access — an embedder that wants to draw its own UI speaks `sdk.sock` itself;
one that wants a terminal view runs `clauctl attach` in a pty it owns.

Each attacher is an independent TUI at its own terminal size; there is no
shared screen. Detach is the remappable `app.detach` keybinding (default
`ctrl+]`) and leaves the agent running. Attachers identify themselves in
their `subscribe` request (`attachment: { pid, client }`), so the daemon
records live attachments in `agent.json` and audits attach/detach events —
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
    sdk.sock
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
config dir (`<config>/projects/<sanitized-cwd>/<session-id>.jsonl`). clauctl
reads these files directly for history: `tail`, the TUI's history replay, and
`get-entries` all consume the session file, deduplicated
first-occurrence-wins into a flat entry list plus a current-leaf pointer.
Entry uuids are durable cursors (`tail --since <uuid>`).

## Lifecycle model

An agent is more than a running process: it is the agent directory plus its
recorded lineage and metadata.

Important states:

- **running**: daemon and `claude` are up; `sdk.sock` accepts connections.
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
  agents — every `sdk.sock` request type has a corresponding subcommand;
- clients that want structured state can speak `sdk.sock` directly — a
  small, versioned, hello-first protocol designed to be implemented outside
  this codebase; clients that need a terminal view run `clauctl attach` in a
  pty they own.

The design goal is that anything a human can do by hand has a corresponding
scriptable operation, without making the agent less interactive or less
attachable.

## Reference material

- exact `sdk.sock` protocol: [`src/core/sdk-socket.ts`](../src/core/sdk-socket.ts);
- exact `agent.json` schema: [`src/core/registry.ts`](../src/core/registry.ts);
- the state fold: [`src/core/agent-state.ts`](../src/core/agent-state.ts);
- what Claude and its SDK actually do: [`claude-agent-sdk.md`](claude-agent-sdk.md);
- prompt tracking: [`user-message-tracking.md`](user-message-tracking.md).
