# The clauctl protocol

Purpose: what the protocol an agent speaks on its `socket` file offers a client
and the philosophy behind it. The
protocol's working definition is
[`src/core/protocol.ts`](../src/core/protocol.ts); this page explains
what the types mean and why the interface has the shape it has. Read
[`architecture.md`](architecture.md) first for where the socket sits.

## What the protocol is

The clauctl protocol is the observation and control interface we wish the Claude Agent
SDK provided. The SDK gives the daemon a `Query`: an async iterator of
`SDKMessage`s plus control methods. That is almost enough to _drive_ an agent
(`set-context` needs a session-file write the SDK has no method for) and not
enough to _observe_ one (below), so the daemon owns the single `Query` and
serves a richer interface on the socket. The clauctl subcommands and the TUI
are clients of this interface.

The protocol is newline-delimited JSON both ways, on two channels:

- The **request channel** is request–reply. A request carries an `id` and gets
  exactly one response with that `id`, visible only to the client that sent
  it.
- The **event channel** is publish–subscribe. A connection that sent
  `subscribe` receives every `AgentEvent` from then on, as pushed `{ event }`
  lines; every subscriber sees every event, including the effects of other
  clients' requests, because every request that mutates the agent emits an
  event. There is no history on this channel: a new subscriber gets a
  **snapshot** (the current `AgentState`) with all earlier events already
  folded in.

Three request layers:

- **subscribe** — the snapshot, then every event from then on.
- **SDK passthrough** — one request per `Query` method (`set-model`,
  `set-permission-mode`, `supported-models`, `usage`, …). Mutations emit
  `controlApplied` so observers see them too.
- **conversation operations** — `prompt`, `interrupt`, `get-entries`,
  `get-context`, `set-context`: the operations that need daemon-side
  logic beyond the SDK.

## Philosophy: observability by snapshot and fold

The interface is built around one promise: **a client that connects late
loses nothing.** It never sees past events; anything it needs from the past
is either already folded into the `AgentState` it receives or retrievable
with `get-entries`. This is exactly true of `AgentState` and approximately
true of the rest: the session file cannot reconstruct the SDK stream (a
turn's `result`, the `stream_event`s), and we do not try.

- **Snapshot, then fold.** `subscribe` answers with the daemon's
  `AgentState` and streams every later event. The client applies
  `nextAgentState(state, event)` — the fold exported by
  [`src/core/agent-state/agent-state.ts`](../src/core/agent-state/agent-state.ts) — to each event.
  The daemon maintains its own state with the same function over the same
  stream, so a subscriber's state is the daemon's, not an approximation of
  it. There is no client-side state model to drift.
- **Everything goes through the protocol.** Every interaction with an agent
  — the TUI, `tail`, `prompt`, an embedder — is an ordinary client. Nobody
  looks for the underlying `claude` process or reads the session file
  directly; anything anyone could want from the agent is meant to be served
  here.
- **Durable.** A restarted daemon (crash or upgrade) picks up where it was: it
  rebuilds `AgentState` by folding the session file, and a client that
  attaches then and one that watched from the start converge on the same
  state. `claude` itself is not durable, so two things are lost on purpose:
  an activity of `working` at the crash is `idle` after it (the turn died
  with the process), and prompts still queued at the crash are dropped
  (`claude` does not re-queue them).
- **Multiple clients.** Any number of clients may be connected at once, and
  each sees the others' activity on the event channel. Responses are private
  to the requester; mutations are public as events.

The clauctl protocol and its tricky implementation details in the daemon exist
entirely because the Claude Agent SDK does not have these properties natively:

- **The SDK does not echo user prompts.** This is a problem even with a single
  client, because the client must model when a steering prompt (sent while
  the assistant is working) appears in the assistant's context.[^delivery]
  The daemon models this ([`user-message-tracking.md`](user-message-tracking.md),
  [`queue-model.ts`](../src/core/daemon/queue-model.ts)), so clients get
  `userMessageQueued` when a prompt is accepted and `userMessageDequeued`
  when it enters the assistant's context.
- **The SDK cannot reconstruct the assistant's context.** The natural
  candidate, `getSessionMessages` (a module-level SDK function, not a `Query`
  method), does not represent what the next turn will send: it omits
  attachment entries (so a steered prompt is invisible), drops the `isMeta`
  entries the assistant does see, reports the wrong chain when the file ends
  in a boundary (`derisk/compact-boundary-injection/FINDINGS.md`, P9),
  applies every boundary it meets rather than the last one, skips an invalid
  playlist where the loader aborts, and does no cut or reparenting, so
  excluded siblings stay in. The daemon models the context instead; clients
  request it with `get-context`, or keep a rolling view by feeding the event
  stream to [`context-tree.ts`](../src/core/tree/context-tree.ts) (as the
  TUI's `SessionModel` does).
- **Modeling the context is not possible from the SDK alone.** Some
  information exists only in the session jsonl:
  - The conversation history when resuming a session. The SDK's `SessionStore`
    (an `@alpha` mirror adapter) does not help: its `append` sees only what
    the subprocess writes (clauctl's own boundary appends bypass it), its
    `load()` is entangled with resume, and it offers nothing for a dormant
    agent (`derisk/session-store-entry-observation/FINDINGS.md`,
    `specs/canonical-session-entry-stream.md`).
  - `attachment` entries: file contents when a prompt `@`-includes a file,
    harness-generated reminders, hook output, tool-listing deltas, and the
    `queued_command` record of a steered prompt. The catalog is
    [`derisk/attachment-types/FINDINGS.md`](derisk/attachment-types/FINDINGS.md).
  - `parentUuid`, which strings entries into the assistant's context.
  - Other per-entry fields: `isMeta`, `isSidechain`, `isCompactSummary`,
    `cwd`, `version`, `gitBranch`, `promptId`, `toolUseResult`, `effort`,
    `isAbortedMidStream`.
  - Whole entry classes: prompts (ours and the CLI's `<command-name>`
    entries), local-command input entries, `system/{stop_hook_summary,
turn_duration, api_error, away_summary, informational, model_*_fallback}`,
    and the uuid-less sidecar classes (`queue-operation`, `last-prompt`,
    `permission-mode`, `mode`, `ai-title`, `custom-title`, `file-history-*`,
    `agent-*`, `atis-latch`). The full class table is in
    [`stream-merging.md`](stream-merging.md).
- **The SDK stream and the jsonl file are not synchronized.** The file
  typically lags the SDK by a few hundred milliseconds. clauctl sends
  everything out as soon as it is available and lets a client that needs the
  two correlated do so ([`stream-merge.ts`](../src/core/stream-merge.ts),
  [`stream-merging.md`](stream-merging.md)): `AgentState` tells the client
  which SDK messages the file has not yet caught up to, and which uuids each
  fold step resolved (`SessionState.resolved`).
- **One `Query` spans multiple session files.** `/clear` and `/new` start a
  new session id in the same process. This is why a clauctl agent id is not
  a claude session id. The daemon follows the
  switch and emits `sessionFileChanged`. (Subagents have their own session
  files as well; out of scope until
  [`thoughts/subagent-activity.md`](thoughts/subagent-activity.md).)
- **The SDK cannot rewrite the assistant's context.** clauctl's `set-context`
  (and the TUI's `/tree`) shuts down the `Query`, appends a
  `compact_boundary` to the session file, and restarts the `Query` on it
  ([blog post](https://geraschenko.com/blog/claude-context)).

See also [`claude-agent-sdk.md`](claude-agent-sdk.md).

## The event stream

`AgentEvent` has three kinds of member.

**`sdkMessage`**: the **query stream**: every `SDKMessage` the `Query`
yields, forwarded verbatim, with one exception: when the query stream repeats
a uuid, only the first copy is forwarded.

**`sessionEntry`**: the **file stream**: one event per canonical[^dups]
entry of the tracked session file, in file order, as soon as the daemon reads
the line. Every entry includes the daemon's class decision (`expectsSdkMessage`:
whether the query stream also carries it) so no subscriber re-classifies. Each
event also carries daemon-computed facts a client would otherwise need a tree
for: the context leaf after this entry, the last assistant's usage/model, and
the boundaries still waiting for an anchor.

**Daemon bookkeeping**: everything else, each covering a gap in the SDK:

| event                                      | the gap it closes                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `userMessageQueued`, `userMessageDequeued` | the query stream never echoes a prompt and the CLI's queue is invisible live; the daemon models the queue and announces acceptance and consumption. [`user-message-tracking.md`](user-message-tracking.md) is the full account. |
| `compactSent`, `interruptSent`             | `/compact` and `interrupt` are requests the daemon makes; the stream shows their effects, not the requests.                                                                                                                     |
| `controlApplied`                           | a passthrough mutation succeeded; observers learn the new model/mode/settings without polling.                                                                                                                                  |
| `contextChanged`                           | a compact boundary completed (native or `set-context`) and the context leaf moved; the SDK has no set-context and no event for either.                                                                                          |
| `sessionFileChanged`                       | `/clear`/`/new` start a new session id in the same process; the file follower moved to the new file and every client resets its per-file model.                                                                                 |
| `scanComplete`                             | the file follower has delivered every line the file held when opened; what follows is live.                                                                                                                                     |
| `sessionAppended`                          | the daemon appended this entry itself (`set-context`): its query-stream `SDKMessage` form, one event per entry in file order, emitted before the file stream delivers the entries so the fold can expect them.                  |
| `trackerAnomaly`                           | the daemon observed something its model of the CLI says cannot happen; the fold sets `AgentState.anomaly` (see stream merging).                                                                                                 |
| `shutdown`                                 | a deliberate stop, so a lost connection without it means a crash.                                                                                                                                                               |

## `AgentState`

The fold's output: activity (`idle`/`pending`/`working`/`compacting`,
derived — the SDK has no idle status), the predictive model/permission mode/effort for the
next query, the CLI version, `cwd`, the prompt queue (`queuedMessages`,
keyed by the uuid the daemon stamps on each prompt), and a `SessionState` per session file this daemon
lifetime has seen, keyed by session id, with `querySessionId` (the file the
query stream is on) and `fileSessionId` (the file the follower is on).

Two invariants a client can rely on:

- **Prompt visibility.** Every accepted prompt is in exactly one of
  `queuedMessages`, the query session's merge pending on `query` (dequeued,
  its entry not yet filed), or the transcript. Each transition is one fold
  step, so no state shows a prompt twice or not at all (see
  [`user-message-tracking.md`](user-message-tracking.md)).
- **Activity.** `activity === "idle"` implies no querying prompt remains
  queued; the fold never passes through a spurious idle between a finished
  turn and the queued turn that runs next.

**What the merge does not hide.** The two streams are unsynchronized; a
client sees a message on one before its twin on the other, in either
order. `SessionState.merge` (a `MergeState`, [`stream-merging.md`](stream-merging.md))
tracks which uuids are still pending on which stream, and a session is
**settled** when nothing is pending on the query side and no boundary
awaits its anchor. Requests that read the file (`get-entries`,
`get-context`, `set-context`) wait for settlement inside the daemon, so a
client that only makes requests never sees the seam.[^settlement] A client that
folds events reads what each step resolved from `SessionState.resolved`
(the resolutions of the event just folded, empty on every other state) and
what is still pending from the merge state.

## Requests

- **`subscribe`** — the current `AgentState`, then the live stream. No
  history replay: a subscriber starts at "now". An `attachment` marks the
  connection as an attacher (recorded in `agent.json`, audited); observers
  like `tail` subscribe bare.
- **`prompt`** — accept a prompt into the queue with a priority
  (`now`/`next`/`later`) or as a `shouldQuery: false` append. Answered at
  acceptance; progress arrives as events.
- **`interrupt`** — the SDK's interrupt, announced as `interruptSent`.
- **`get-entries`** — the canonical entries of the current session, as
  `payload: "uuids"` (identities, no file read) or `"full"` (complete entries),
  optionally after a `since` cursor, plus the current leaf. Also a payload
  lookup for a list of known uuids. Answered from the daemon's resident index
  once the session is settled;[^settlement] the file is read only for the
  payloads. Clients build trees locally — a nested wire tree would overflow
  `JSON.stringify` on long sessions.
- **`get-context`** — the assistant's context at an occurrence (default:
  the current leaf), from the context tree ([`session-views.md`](session-views.md)).
  Derived from the file, not from the `Query`, so it agrees with what the
  next turn will see even after a `set-context`.
- **`set-context`** — rewrite the effective context: append a compact
  boundary naming the preserved uuids (or `rewindTo` an occurrence), restart
  the `Query` on it. The one request that restarts the `Query`.
- **SDK passthrough** — every `Query` method that makes sense out of
  process; mutations also update the persisted spawn options so a revived
  agent keeps them.

`get-entries --since` is the catch-up primitive: a client that holds
entries up to some uuid asks for everything after it (`tail --since`,
`clauctl get-entries --since`; the TUI does not reconnect today — it exits
when the connection is lost). The handoff between snapshot and stream needs
no cursor: the daemon computes the snapshot and writes the response without
yielding, so every `sessionEntry` a client received before the response is
in the snapshot and every one after it is not (`eventsBefore` on the
response is that count).

## Building on it

The stream carries every entry, every SDK message, and the leaf; that is
everything a client needs to keep the three views of a session
([`session-views.md`](session-views.md)) as rolling trees, and to render
a transcript with no file access. The TUI does exactly this
(`src/tui/session-model.ts`), and so does anything else that speaks the
socket.

## Implementation

- [`stream-merging.md`](stream-merging.md) — how the query and file
  streams are correlated: the classification table, `MergeState`,
  settlement, anomalies, the startup scan and the session switch.
- [`user-message-tracking.md`](user-message-tracking.md) — the prompt
  queue model and why the daemon tracks prompts itself.
- [`session-views.md`](session-views.md) — the three views and how the
  daemon and the TUI keep them.
- [`claude-agent-sdk.md`](claude-agent-sdk.md) — the empirical facts about
  the SDK and the CLI the above is built on.
- Code: `src/core/protocol.ts` (protocol), `src/core/agent-state/agent-state.ts`
  (fold), `src/core/daemon/event-hub.ts` (broadcast and settlement),
  `src/core/daemon/session-tracker.ts` (the resident file view),
  `src/core/session/entry-stream.ts` (the follower),
  `src/core/stream-merge.ts` (the merge library),
  `src/core/daemon/queue-model.ts` (the prompt queue).

## Footnotes

[^delivery]: Roughly: every queued prompt is bundled into the next tool result of
    the current assistant turn, or delivered at the end of the turn,
    whichever comes first. `SDKUserMessage` complicates this with a
    `priority` that can make a prompt interrupt the assistant or defer it to
    the end of the turn (not just the next tool result), and a `shouldQuery`
    that, when false, appends the prompt _without_ triggering a turn.

[^dups]: The CLI sometimes re-persists an entry it already wrote, always right
    after a compact boundary and not always byte-identically: of 237 pairs in
    `derisk/cli-history-repersistence/FINDINGS.md`, the copies differed in
    `gitBranch`, `toolUseResult`, `promptId`, attachment payload, `usage`,
    and twice in `parentUuid` (the boundary's relink baked into the raw
    pointer). The daemon keeps the first copy and drops the rest.

[^settlement]: Settlement is stronger than these reads need: waiting for
    everything pending at request time to resolve would do. Not the leaf alone,
    though — a boundary's anchor and shared entries that are not leaf-eligible
    can still be in flight behind a resolved leaf.
