# clauctl — Project Overview

> _Why_ clauctl exists and the foundational decisions from the project's
> start, which every spec in `docs/specs/` builds on. For what clauctl is
> today read `README.md` and [`architecture.md`](architecture.md).

## What clauctl is

clauctl is a control-plane CLI and background daemon for managing long-lived
**Claude agent processes**. It owns the lifecycle and metadata of `claude`
processes and exposes the Claude Agent SDK's capabilities through ergonomic
subcommands.

It is the sibling of **pictl**, which does the same job for **pi** agents.
The two are part of one vision for agentic engineering, and we deliberately keep
their implementations close — sharing structure (daemon, socket logic, stricli
completion) wherever the underlying agent interfaces allow.

clauctl mirrors the **philosophy** of pictl, **not** its interface. pictl talks
to pi over pi's RPC; clauctl talks to Claude over the Claude Agent SDK. These
interfaces are completely different, so the surface commands differ — but the two
jobs are identical:

1. **Lifecycle & metadata** — spawn, track, monitor, persist, resume, and archive
   Claude processes, surviving daemon or process restarts transparently.
2. **Unfettered SDK passthrough** — expose _all_ SDK functionality through
   subcommands, ergonomically but without hiding capability, plus the
   methods we _wish_ the SDK exposed (`get-context`, `set-context`).

## Language: TypeScript

clauctl is written in **TypeScript**, like pictl.

The governing rule: **a control-plane CLI is written in its SDK's native
language.** pictl follows pi (TS); clauctl follows the Claude Agent SDK (TS).

Rationale (the author's general preference is Rust, so this was a deliberate
override):

- **Coupling to the source of truth.** clauctl's job (2) is "expose _all_ SDK
  functionality." That functionality is most complete and most current in the
  TypeScript SDK, and critically, only the TS SDK exposes the SDK's in-process
  callbacks — `hooks`, `canUseTool`, and `createSdkMcpServer` tools — as live
  code the CLI calls back into. Any non-TS path would force clauctl to either
  depend on `claude-agent-sdk-rs` (a maintenance burden the author explicitly
  wants to avoid, and which structurally lags the TS protocol) or reimplement the
  versioned, undocumented stream-json control protocol by hand and chase it every
  release. Both make clauctl perpetually trail the SDK's coverage — the one thing
  job (2) cannot afford.
- **Reuse.** pictl's daemon, per-agent socket model, and stricli-based subcommand
  completion transfer directly. Patterns and fixes flow both ways.

**Where Rust still lives:** at the **socket boundary**. The clauctl
protocol (below) is a stable, owned-by-us interface. Embedding a clauctl
agent in a Rust app (e.g. a ratatui TUI) means writing a thin Rust client
struct that speaks that protocol — no reimplementation of the control
plane — or running `clauctl attach` in a pty the app owns for a ready-made
terminal view. That is the low-burden, high-leverage place for Rust.

## How the Claude Agent SDK actually works

The facts the architecture rests on — the `claude` binary is the authority,
streaming-input mode, session ids roll over in place — are in
[`claude-agent-sdk.md`](claude-agent-sdk.md).

## Data model: agent id ≠ session id

An agent is not a session: one clauctl agent spans a sequence of Claude
session ids, and `agent.json` holds what is needed to talk to it, attach to
it, and respawn it. See [`architecture.md`](architecture.md), "Agent id ≠
session id" and "`CLAUCTL_DIR` as the registry".

## Architecture: the daemon and socket

Claude **will not allow simultaneous programmatic and interactive connections** to
one session. So clauctl's daemon owns the _single_ programmatic connection to each
`claude` process, and everything else — CLI subcommands, the TUI, any
embedder — is a **client** that multiplexes through clauctl. This mirrors pictl's
daemon + per-agent socket model.

Each agent exposes a unix socket in its directory — `socket`, the analog of
pictl's `pi.sock` — over which clients send requests and observe events (the clauctl protocol,
[docs/protocol.md](docs/protocol.md)).

Clauctl's interactive TUI is an ordinary protocol client that `clauctl attach`
runs directly in the caller's terminal (`docs/specs/attach-direct-tui.md`). An
embedder that wants to render its own UI speaks the protocol; one that wants a
ready-made terminal view runs `clauctl attach` in a pty it owns — standard pty
infrastructure exists in every language, gives per-pane sizing for free, and is
uniform with pictl (`pictl attach` in a pty works the same way). An earlier
design served a daemon-hosted shared TUI over a custom `tty.sock` frame protocol
(`docs/specs/attach.md`, superseded); the pty-of-`attach` approach replaces that
custom protocol with one every terminal already speaks.

## Reference repository (local checkout)

**pictl** — `/home/anton/git/geraschenko/pictl/` — the sibling control plane we
copy-and-diverge from (DECISION-1). Its `src/core/` (daemon, registry, lifecycle,
spawn, cli/app/main, attach/tail/wait, tty transport) and `src/format/` are the
scaffolding template; `rpc-commands.ts` is the shape reference for SDK passthrough.
