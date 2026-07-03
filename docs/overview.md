# clauctl — Project Overview

> The authoritative description of _what_ clauctl is, _why_ it exists, and the
> foundational decisions every spec in `docs/specs/` builds on. Start here.

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
   subcommands, ergonomically but without hiding capability.

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

**Where Rust still lives:** at the **socket boundary**. The `sdk.sock` and
`tty.sock` protocols (below) are stable, owned-by-us interfaces. Embedding a
clauctl agent in a Rust app (e.g. a ratatui TUI) means writing a thin Rust client
struct that speaks those socket protocols — no reimplementation of the control
plane. That is the low-burden, high-leverage place for Rust.

## How the Claude Agent SDK actually works

These facts are load-bearing for the architecture and were established by reading
the SDK's shipped type definitions (`sdk.d.ts`) and by direct experiment (see
`docs/derisk/clear-vs-session-experiment/`).

- **The `claude` binary is the real authority.** Both the TypeScript and Python
  SDKs are thin wrappers that **spawn the `claude` CLI** and exchange
  newline-delimited JSON over its stdio (`--input-format stream-json
  --output-format stream-json`). The TS SDK is the most current/complete wrapper
  and the one clauctl depends on. (`Options.pathToClaudeCodeExecutable` lets us
  point at a chosen `claude` binary; the npm package also bundles a version-pinned
  one.)
- **The TS SDK is closed-source, but its types are public.** The "headers" are the
  `.d.ts` files shipped inside the npm package
  (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`), which are far ahead of the public
  docs. Treat `sdk.d.ts` (+ the bundled `sdk.mjs` for behavior) as the
  ground-truth reference.
- **Long-lived sessions = streaming-input mode.** `query()` takes
  `prompt: string | AsyncIterable<SDKUserMessage>`. Passing an `AsyncIterable`
  opens a long-lived session: the returned `Query` is an
  `AsyncGenerator<SDKMessage>` that _also_ carries control methods —
  `interrupt()`, `setModel()`, `setPermissionMode()`, `setMcpServers()`,
  `streamInput()`, `backgroundTasks()`, `stopTask()`, `close()`. This is the TS
  analog of Python's `ClaudeSDKClient` (the docs under-document it). clauctl uses
  this mode; a daemon keeps the input iterable open and feeds successive turns
  into the same warm process.
- **Stateless resume/fork** is also available via `Options.resume` (session UUID),
  `continue`, `forkSession`, and `resumeSessionAt` — used to reconstruct a session
  from its persisted transcript in a _fresh_ process (e.g. after a crash).

## Data model: agent id ≠ session id

**An agent is not a session.** A single long-lived `claude` process (one clauctl
**agent**) spans a _sequence_ of Claude **session_ids** over its lifetime. This
was confirmed empirically (`docs/derisk/clear-vs-session-experiment/`):

- `/clear` and `/new` start a genuinely fresh conversation **in place** — context
  is wiped, a new session_id begins — while the **same OS process survives**
  (same PID, generator keeps producing). No respawn is required for a reset.
- A `system/init` fires on **every turn** (confirmed at the raw-CLI level), so its
  mere presence is not a rollover. A reset shows up as an `init` whose `session_id`
  **differs** from the current one — delivered via `system/init`, **not**
  `SDKSessionStateChangedMessage`.
- Every prior session_id keeps its own transcript JSONL under
  `~/.claude/projects/<cwd>/<session_id>.jsonl` and stays independently resumable.

**Consequences for clauctl:**

- The agent is clauctl's durable unit, identified by a clauctl-assigned **agent
  id**. session_id is Claude's per-conversation unit and is **mutable** over an
  agent's life.
- The daemon's stream reader tracks `currentSessionId` = the most-recent
  `init.session_id`, and detects a rollover **by id change** — never by counting
  inits (an `init` fires every turn). (`session_state_changed` is for idle/running
  state, _not_ id transitions.)
- `/new` is not listed in the init `slash_commands` array yet behaves like
  `/clear`; do not gate valid reset commands on that list.

### Per-agent persistence (`agent.json`)

Each agent has a directory holding everything needed to talk to it, attach to it,
and respawn it transparently. `agent.json` stores:

- The **serialized spawn `Options`** (the serializable subset: `model`,
  `permissionMode`, `allowedTools`/`disallowedTools`, `mcpServers`, `systemPrompt`,
  `cwd`, `additionalDirectories`, `env`, `settingSources`, `agents`, `maxTurns`,
  `fallbackModel`, …).
- The **current session_id** (live-updated from the latest `system/init`), and as
  much session history as is useful.
- Lifecycle metadata (agent id, pid, status, socket paths, timestamps).

**Respawn recipe** = persisted `Options` + `resume: currentSessionId`, so a killed
agent comes back as if never interrupted.

> **Caveat — code-valued options.** `canUseTool`, `hooks`, and in-process
> `createSdkMcpServer` tools are _live code_, not serializable config. They are
> clauctl's own logic and are re-supplied by clauctl on (re)spawn, not stored in
> `agent.json`. Process-based MCP servers (stdio/http) _are_ serializable and are
> stored.

## Architecture: the daemon and two sockets

Claude **will not allow simultaneous programmatic and interactive connections** to
one session. So clauctl's daemon owns the _single_ programmatic connection to each
`claude` process, and everything else — CLI subcommands, the eventual TUI, any
embedder — is a **client** that multiplexes through clauctl. This mirrors pictl's
daemon + per-agent socket model.

Each agent exposes two unix sockets in its directory:

- **`sdk.sock`** — the raw, structured SDK protocol. Clients send
  `SDKUserMessage`s and control requests and receive the `SDKMessage` stream. This
  is the analog of pictl's `pi.sock` and the substrate for scripting, the
  passthrough subcommands, and the TUI. It is where job (2) is realized.
- **`tty.sock`** — a **language-agnostic presentation boundary** for embeddable
  UIs. Its purpose: implement the interactive UI _once_ and embed it in any
  language by speaking a socket protocol, rather than reimplementing a UI per host
  (e.g. embedding a clauctl agent inside a Rust ratatui app).

> **Important difference from pictl.** pictl's `tty.sock` proxies a _real pty_ —
> pi has a terminal. **Claude in programmatic mode has no pty** (it emits
> structured JSON), and by the constraint above we cannot open a real interactive
> `claude` alongside the programmatic one. So `tty.sock` for clauctl cannot proxy
> Claude's terminal; it must carry a presentation layer clauctl synthesizes.
>
> **Design: virtual-pty.** clauctl runs its own SDK-stream-driven TUI, renders it
> into a _headless/virtual_ terminal, and proxies those terminal bytes over
> `tty.sock`. Embedders need only a vt100 widget — preserving pictl's "implement
> once, embed anywhere" property and keeping the two projects symmetric (both
> embedders speak "terminal over `tty.sock`"). This is what `attach` serves.
>
> We rejected the alternative of shipping a structured _view model_ over `tty.sock`
> for embedders to draw natively: an embedder that wants to render its own UI can
> already just talk to `sdk.sock` directly. Virtual-pty doesn't preclude that — but
> `attach` gives you _our_ TUI over `tty.sock`, not a draw-it-yourself feed.
>
> The "TUI → virtual pty" mechanism is unbuilt in both projects and is the main open
> risk; it does not block v1 (which is SDK-stream-only).

## Roadmap & scope

**v1 (initial implementation):**

- Lifecycle: `spawn`, `list`, `status`, `archive`.
- Monitoring: `tail`, `wait` (and a raw `attach` onto `sdk.sock`).
- SDK passthrough subcommands (job 2) over `sdk.sock`.
- Convenience: `completion`, `format`.

**Later:**

- The `sdk.sock`-based interactive **TUI** (possibly adapting pi's TUI), and
  the `tty.sock` presentation boundary for cross-language embedding.

## Reference repositories (local checkouts)

Two sibling repos are referenced throughout these docs and are required reading for
implementation:

- **pictl** — `/home/anton/git/geraschenko/pictl/` — the sibling control plane we
  copy-and-diverge from (DECISION-1). Its `src/core/` (daemon, registry, lifecycle,
  spawn, cli/app/main, attach/tail/wait, tty transport) and `src/format/` are the
  scaffolding template; `rpc-commands.ts` is the shape reference for SDK passthrough.
- **muninn runner** — `/home/anton/git/muninn/claude/runner/runner/` — a Rust Claude
  runner that already solved stream augmentation and state tracking. **Reference, not
  authority** (we do not trust it is correct). Key files: `src/types/runner_event/`
  (event superset), `src/claude_runner_local/handle_message.rs` (echo placement),
  `src/types/runner_state_tracker.rs` (idle/compacting state).

## Document map

- `docs/overview.md` — this document (project goal, philosophy, foundational decisions).
- `docs/derisk/` — empirical investigations that de-risk the design
  (`clear-vs-session-experiment/` = done; `echoed-message-placement/` = a pending,
  non-blocking handoff brief for the `priority`/echo-placement spike;
  `resume-persistence/` = a pending handoff brief for which `Options` survive a cold
  `resume`, gating the `agent.json` merge set).
- `docs/specs/lifecycle-and-sdk-commands.md` — v1: lifecycle + SDK passthrough.
- `docs/specs/phase-1-lifecycle-core.md` — the implementation-ready Phase-1 carve-out
  (registry, daemon, assistant-state model, respawn, minimal `sdk.sock` command channel).
- `docs/specs/tui.md` — the `sdk.sock`-based TUI and `tty.sock` boundary.
- `docs/specs/convenience-commands.md` — `format` and `completion`.
