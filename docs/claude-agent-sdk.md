# How clauctl uses the Claude Agent SDK

Purpose: the empirical ground truths about `claude` and the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) that
clauctl's architecture is built on. Many of these are under-documented or
undocumented upstream; they were established by reading the SDK's shipped
type definitions and by direct experiment (see [`derisk/`](derisk/) for the
experiments). If clauctl does something in a roundabout way, the reason is
usually on this page.

## The `claude` binary is the real authority

Both the TypeScript and Python SDKs are wrappers that **spawn the `claude` CLI**
and exchange newline-delimited JSON over its stdio (`--input-format stream-json
--output-format stream-json`). The TS SDK is the most current and complete
wrapper, and the only one that exposes the SDK's in-process callbacks (`hooks`,
`canUseTool`, in-process MCP servers) as live code.

The TS SDK is closed-source, but its "headers" are public: the `.d.ts` files
shipped inside the npm package (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`)
are far ahead of the published docs. Treat `sdk.d.ts` (plus the bundled
`sdk.mjs` for behavior) as the ground-truth reference.

## Long-lived sessions = streaming-input mode

`query()` takes `prompt: string | AsyncIterable<SDKUserMessage>`. Passing an
`AsyncIterable` opens a long-lived session: the returned `Query` is an
`AsyncGenerator<SDKMessage>` that also carries control methods
(`interrupt()`, `setModel()`, `setPermissionMode()`, `setMcpServers()`, …).
clauctl's daemon uses this mode — it keeps the input iterable open and feeds
successive turns into the same warm process.

Stateless reconstruction is also available: `Options.resume` (a session id),
`forkSession`, and `resumeSessionAt` rebuild a session from its persisted
transcript in a fresh process. This is clauctl's revival recipe for dormant
agents.

## One programmatic connection, and no terminal

Claude does not allow simultaneous programmatic and interactive connections
to one session, and in programmatic mode there is no pty — `claude` emits
structured JSON, not terminal bytes.

Consequences: whoever holds the SDK connection is the _only_ party talking
to the agent (hence clauctl's daemon-owns-the-connection architecture), and
there is no stock `claude` TUI to attach to (hence clauctl's own TUI,
rendered into a pty).

## Session ids roll over in place

- `/clear` and `/new` start a genuinely fresh conversation **in the same OS
  process**: context is wiped and a new session id begins, but the same
  process keeps producing. No respawn is involved in a reset.
- A `system`/`init` message fires on **every turn**, so its presence means
  nothing by itself. A reset is detected by an `init` whose `session_id`
  **differs** from the current one — never by counting inits.
- Every prior session id keeps its own transcript and stays independently
  resumable.

This is why a clauctl agent id is not a session id: one agent spans a
sequence of session ids, tracked in `agent.json`.

## Transcripts are files, and they are readable

Each session id has an append-only transcript JSONL at
`<claude-config-dir>/projects/<sanitized-cwd>/<session-id>.jsonl`, where
`<sanitized-cwd>` is the working directory with every non-alphanumeric
character replaced by `-`. Entries have uuids and parent uuids, forming a
tree; the conversation is a path through it.

Two quirks matter:

- **Repersisted duplicates.** The CLI sometimes rewrites entries it has
  already written (e.g. re-persisting dropped-from-context history around
  compaction), occasionally with mutated payloads
  ([`derisk/cli-history-repersistence/FINDINGS.md`](derisk/cli-history-repersistence/FINDINGS.md)).
  clauctl resolves a duplicated uuid in two deliberately different ways: for
  canonical display and streaming, the **first** occurrence supplies both
  position and content, so each entry is emitted exactly once; for
  reconstructing what claude will actually load, the loader model
  ([`src/core/tree/loader.ts`](../src/core/tree/loader.ts)) is
  **last**-wins, mirroring claude's own uuid-keyed loading.
- **Compact boundaries.** Compaction writes a `compact_boundary` entry that
  splices a summarized prefix out of the effective context. Reconstructing
  "what the model currently sees" means following boundary links, not just
  walking parent pointers. clauctl's context surgery (`set-context`) writes
  the same kind of boundary entry the CLI itself uses.

clauctl leans on these files heavily: session history for `tail`,
`get-entries`, and the TUI's replay ultimately comes from the transcript, not
from asking the SDK. The intended division of labor: the daemon reads the
transcript and serves it over `sdk.sock`, and clients of the daemon — the TUI
included — replay history through `get-entries` rather than touching the
files. Direct file access is meant to be limited to the daemon and
`AgentObserver`
([`src/core/agent-observer.ts`](../src/core/agent-observer.ts)) — the merged
events-plus-entries subscription that `tail` and `prompt` are built on, which
also works on dormant agents that have no daemon to ask. `AgentObserver` is
essentially the observation interface we wish the SDK had provided.

## The live stream omits user prompts

The SDK's message stream does not echo the user messages you feed in, and
prompts injected while a turn is running ("steering") never appear in the
SDK's own transcript queries. A client that wants to display the full
conversation — including what was just typed — cannot get it from the stream
alone. clauctl's daemon therefore tracks prompt visibility itself; see
[`user-message-tracking.md`](user-message-tracking.md).

This generalizes: the event stream served on `sdk.sock` is a superset of the
SDK's. Every Claude Agent SDK message is forwarded verbatim (as `sdkMessage`
events), and clauctl adds the events we determined a client needs to
accurately maintain `AgentState` — the queue events
(`userMessageQueued`/`userMessageDequeued`), `compactSent`, `interruptSent`,
`contextChanged`, and `controlApplied`.
