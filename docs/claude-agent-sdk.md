# How clauctl uses the Claude Agent SDK

Purpose: the empirical ground truths about `claude` and the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) that
clauctl's architecture is built on. Many of these are under-documented or
undocumented upstream; they were established by reading the SDK's shipped
type definitions and by direct experiment (see [`derisk/`](derisk/) for the
experiments), against `@anthropic-ai/claude-agent-sdk` 0.3.x in mid-2026 —
they are empirical, and SDK upgrades can invalidate them. If clauctl does
something in a roundabout way, the reason is usually on this page; what
clauctl does about each fact is in [`protocol.md`](protocol.md)
and the deep dives it links.

Each fact notes what pins it: a test under `tests/sdk/` that runs against
the live SDK, or a derisk experiment only (no regression test).

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
there is no stock `claude` TUI to attach to (hence clauctl's own TUI).

## An unset `permissionMode` overrides the settings files

`query()` with `permissionMode` unset spawns the CLI with
`--permission-mode default`, overriding `permissions.defaultMode` from every
settings file: inside the SDK the flag is
`permissionMode ?? (internal.resolvePermissionModeInCli ? undefined : "default")`
and the internal switch is never set for public callers. The daemon
therefore resolves the settings cascade itself and always passes the mode
explicitly. Pinned by `tests/sdk/permission-mode.test.ts`.

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
sequence of session ids, tracked in `agent.json`, and why the socket has a
`sessionFileChanged` event.

The reset turn on the query stream: `conversation_reset` (old session id;
its `new_conversation_id` is **not** the new transcript id) → `init` with
the new id → the reset turn's `result`. So a prompt queued behind `/clear`
is dequeued after the rollover and its entry lands in the new file; the
reset command's own entry lands in the new file too, although it was
dequeued from the old session. Pinned by `tests/sdk/clear-session.test.ts`
(evidence: `derisk/clear-vs-session-experiment/`, exp4). If the
`new_conversation_id` assertion ever fails, the "wait for `init`" rollover
detection in the daemon can be revisited.

## Transcripts are files, and they are readable

Each session id has an append-only transcript JSONL at
`<claude-config-dir>/projects/<sanitized-cwd>/<session-id>.jsonl`, where
`<sanitized-cwd>` is the working directory with every non-alphanumeric
character replaced by `-`. Entries have uuids and parent uuids, forming a
tree; the conversation is a path through it.

Three quirks matter:

- **Repersisted duplicates.** The CLI sometimes rewrites entries it has
  already written (e.g. re-persisting dropped-from-context history around
  compaction), occasionally with mutated payloads
  ([`derisk/cli-history-repersistence/FINDINGS.md`](derisk/cli-history-repersistence/FINDINGS.md)).
  clauctl resolves a duplicated uuid in two deliberately different ways: for
  canonical display and streaming, the **first** occurrence supplies both
  position and content, so each entry is emitted exactly once; for
  reconstructing what claude will actually load, the loader model
  ([`src/core/tree/loader.ts`](../src/core/tree/loader.ts)) is
  **last**-wins, mirroring claude's own uuid-keyed loading. Pinned by
  experiment only.
- **Compact boundaries.** Compaction writes a `compact_boundary` entry that
  splices a summarized prefix out of the effective context. Reconstructing
  "what the model currently sees" means following boundary links, not just
  walking parent pointers. clauctl's context surgery (`set-context`) writes
  the same kind of boundary entry the CLI itself uses; the loading model it
  relies on is `derisk/compact-boundary-injection/FINDINGS.md`, pinned by
  `tests/sdk/compact-boundary-suite.test.ts`.
- **`getSessionMessages()` is not the context.** This module-level SDK
  function returns the user/assistant chain, but not attachment entries.
  [`session-views.md`](session-views.md) explains what clauctl reads
  instead; [`protocol.md`](protocol.md) has more details on
  why we don't use `getSessionMessages`.

The file is the durable record and the daemon follows it live; the query
stream is Claude's live view. Neither is complete and they are not
synchronized — the file lags the stream by a flush — which is the problem
[`stream-merging.md`](stream-merging.md) solves. The classification of which
stream carries which entry class lives there, pinned by
`tests/sdk/stream-classification.test.ts`.

## The live stream omits user prompts

The SDK's message stream does not echo the user messages you feed in, and
prompts injected while a turn is running ("steering") appear in the file
only as a `queued_command` attachment. The CLI's prompt queue
(enqueue/dequeue/reorder) is likewise invisible live. A client that wants to
display the full conversation — including what was just typed — cannot get
it from the stream alone; the daemon models the queue itself
([`user-message-tracking.md`](user-message-tracking.md)). Pinned by
`tests/sdk/stream-classification.test.ts` (a stamped `SDKUserMessage.uuid`
becomes the file's user entry; a steer surfaces only as the attachment).

## Queued prompts coalesce by run

When several prompts wait in the CLI's queue, the file records them by
placement: a prompt absorbed into a running turn (a "steer") is always its
own `queued_command` attachment; an append (`shouldQuery: false`) is
always its own `user` entry; and within a same-priority bucket, a maximal
run of consecutive querying prompts becomes **one** `\n`-joined `user`
entry whose uuid is the run's **last** member (the other members' uuids
never reach the file); if any member has block-form content, the entry is
instead one block array — strings lifted to text blocks, arrays spliced,
no separator. The CLI dequeues one run per `result` and re-ranks the
queue at each: a higher-priority prompt accepted while a bucket is
mid-drain runs before the bucket's remaining runs. A `now` prompt is an
interrupt (`derisk/echoed-message-placement/FINDINGS.md`, priority
table): the aborted turn still ends
with a `result`, its `command_lifecycle` reports `cancelled`, and its
user entry stays in the file with no reply. This is the rule the daemon's
queue model
([`user-message-tracking.md`](user-message-tracking.md)) has to mirror.
Pinned by
`tests/sdk/queued-batches.test.ts`; evidence in
[`derisk/queued-batches/`](derisk/queued-batches/README.md).

## An interrupt aborts the turn, not the queue

`Query.interrupt()` and a `now` prompt abort only the running turn: every
prompt waiting in the queue survives and is dequeued after the aborted
`result` by the coalescing rule above (a `now` prompt runs first, a
prompt queued before it right after, unsteered; a `later` prompt runs at
once when it is the only one waiting). The interrupt receipt names the
survivors in `still_queued` — provided the CLI has acknowledged them:
an interrupt issued in the same tick as a push races the enqueue. A
`/command` sent with `now` interrupts and runs expanded like any
command. Pinned by `tests/sdk/interrupt-queue.test.ts`.

## Slash commands are turns of their own

A prompt whose **string** content starts with `/` is a command — built-in,
custom, or unknown alike — and is exempt from both rules above: pushed
while a turn runs it is never steered, and queued next to other prompts
it is never merged (a command between two texts of one bucket splits it
into three runs). It waits in the queue and runs as its own turn after
the running turn's `result`, expanded the way an interactive `/command`
is (a `<command-name>` user entry; a built-in may expand to its alias,
`/cost` → `/usage`, and writes its `local_command` stdout; a custom
command adds an `isMeta` user entry with the expanded prompt; an unknown
one writes only `local_command` system entries — the name and "Unknown
command" — no user entry, and its lifecycle still completes). The
content's shape is the whole predicate: a plain text that mentions a
`/command`, and a `/command` carried as a text **block**, are ordinary
prompts, steered verbatim and unexpanded. `system/init.slash_commands`
is not that predicate — it lists names without the slash and omits
`cost`, which the CLI runs anyway. Pinned by
`tests/sdk/steer-slash-command.test.ts` and
`tests/sdk/session-id-option.test.ts`.

## The session id may be chosen by the caller

`Options.sessionId` makes a fresh session use the caller's uuid: the
first `system/init` announces it. The session file does not exist until
the first turn is processed — absent while the process idles before its
first prompt and still absent at that turn's `init`; present at its
`result` — so a file follower started at spawn must wait for the file
without a deadline. Pinned by `tests/sdk/session-id-option.test.ts`.

## Hooks never reach the query stream

`hook_*` messages exist in `sdk.d.ts` but have never been observed on the
query stream or in the file; hooks run, and only their effects are visible.
Pinned by `tests/sdk/stream-classification.test.ts`.
