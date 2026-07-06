# Spec: Phase 2 — the full `sdk.sock` protocol

> Status: **approved design, ready to implement.** Carved out of
> `lifecycle-and-sdk-commands.md` (which remains the decision record for
> DECISION-4/5/6 and the echo-placement FINDINGS); where the two disagree, this
> doc wins — each deviation is called out inline with its rationale.
> Prerequisite reading: `phase-1-lifecycle-core.md` (the daemon, EventBus,
> assistant-state fold, and minimal protocol this phase grows).

## SPEC

### Problem statement

Phase 1's `sdk.sock` is request/response only: the event stream is observable
solely through daemon.log, only four SDK controls are exposed, and a second
client cannot see another client's turns (the SDK never echoes user messages
back — DECISION-6). Phase 2 delivers the full protocol:

1. **Stream fan-out** — any client can subscribe to the daemon's augmented
   `SdkEvent` stream over `sdk.sock`, starting from a state snapshot.
2. **Queue augmentation** — the daemon models the CLI's message queue and
   synthesizes `userMessageQueued`/`userMessageDequeued` events per the
   placement rule (`docs/derisk/echoed-message-placement/FINDINGS.md`,
   Round 3), so observers see every accepted message and where it lands.
3. **Full `Query` passthrough** (DECISION-4) — every `Query` method as a
   subcommand, plus `query --image/--no-query` and `resolve-settings`.
4. **`tail`** — the raw stream watcher (the Phase-3 formatted `tail` will build
   on it).
5. **daemon.log shrink** — with fan-out in place, the log stops mirroring the
   full event stream and carries only exceptional `[daemon]` lines.

### Protocol

Framing is unchanged: newline-delimited JSON on `sdk.sock`, hello record on
connect. The hello `version` **stays 1** — nothing is released, there are no
deployed clients to negotiate with.

Three record shapes flow daemon→client, distinguished structurally:

- **hello** — `{ type: "hello", protocol, version }`, first line on connect.
- **response** — `{ id, ok, data? } | { id, ok: false, error }` (has `id`).
- **event** — `{ event: SdkEvent }` (`SdkEventRecord`; no `id`), pushed only on
  connections that sent `subscribe`.

`subscribe` turns the connection into a subscriber: the response's `data` is a
`StateSnapshot`, and every event emitted after it follows as an
`SdkEventRecord` line until the connection closes. Snapshot and sink
attachment are atomic (same synchronous emit path), so no event is lost or
duplicated between them. **There is no history replay** — a subscriber starts
at "now"; conversation history is Phase-3 territory (a `get-messages`-style
read of the session JSONL). This supersedes the scaffold's "late-joiner
replay". The scaffold's `SdkClientConnected` event is dropped (the snapshot
serves its purpose) and `QueueDepthChanged` is dropped (queue state is
derivable — observers run the same `nextAssistantState` fold from the
snapshot).

### Event set

```
SdkEvent =
  | userMessageQueued   { id: number, message: SDKUserMessage }
  | userMessageDequeued { delivery: "turn" | "steer" | "append", ids: number[] }
  | compactSent         { message: SDKUserMessage }
  | interruptSent
  | controlApplied      { request: SdkControlMutation }
  | sdkMessage          { message: SDKMessage }
```

- `userMessageQueued`/`userMessageDequeued` replace Phase 1's `turnAccepted`
  (see "Queue model" below). `id` is daemon-assigned at acceptance; dequeues
  reference ids explicitly, so out-of-order dequeuing (a `next` cutting ahead
  of a `later`) is unambiguous. `message` is the exact `SDKUserMessage` pushed
  to the SDK — it natively carries `priority` and `shouldQuery`, which
  observers need to interpret placement.
- `compactSent` gains the pushed message (observers could not previously see
  `/compact <instructions>` text).
- `controlApplied` is emitted after **every successful mutating passthrough**
  (every `SdkControlMutation`; `interrupt` keeps its own state-relevant event).
  The mutation/read split classifies each `Query` method by its _documented_
  semantics in `sdk.d.ts` (the `set*`/`apply`/`toggle`/`reconnect`/`stop`/
  `background`/`rewind`/`seed`/`reload*` family changes session state; the
  rest are declared getters) — an educated classification, not knowledge of
  hidden internals; a misclassification costs a missing or superfluous event,
  nothing worse. The payload is the request as received — the same trigger
  and payload as DECISION-5's persist-on-mutation, so observers track option
  changes exactly as the record does. Reads emit nothing.
- `sdkMessage` forwards **everything, including partials**
  (`stream_event`). Deviation from the scaffold ("consumed internally, not
  forwarded"): `tail` is explicitly raw, a future TUI wants partials, and the
  Phase-3 formatted `tail` is where filtering will live. No filtering in this
  phase.

### Queue model

The CLI's queue operations are invisible on the live stream, but its placement
behavior is deterministic (FINDINGS), so the daemon **models the queue**: it
knows every accepted message, its priority, and the drain rules, and emits
`userMessageQueued` at acceptance and `userMessageDequeued` when the model
says the CLI consumed messages. Events are emitted in true order — queued at
acceptance, dequeued immediately **after** the SDK message that triggered the
dequeue — and observers reconstruct the conversation from dequeue events
alone.

Model transitions:

- **Accept while idle** — the message runs immediately: emit
  `userMessageQueued` + `userMessageDequeued` back-to-back (`delivery:
  "turn"`, or `"append"` for a `shouldQuery: false` message).
- **Accept while busy** — emit `userMessageQueued` only. A `next`/default
  message is _demotable_ (subject to the CLI's demote-vs-execute fork); `now`
  and `later` are not.
- **A user message carrying `tool_result` blocks** ⇒ mark `toolResultSeen` on
  every currently queued demotable message. The FINDINGS rule is "what
  follows the first tool_result **after acceptance**", so the marker is per
  message, not global — a straggler accepted between a tool_result and the
  following assistant activity has not seen its own boundary and must wait
  for the next one.
- **Assistant activity** (`assistant` or `stream_event`) ⇒ dequeue the
  **marked** demotable messages as `delivery: "steer"` (ids in injection
  order): the CLI removed them from the queue and delivered them as
  `<system-reminder>`s inside that tool result; they never run as turns.
- **`result`** ⇒ dequeue the highest-priority bucket present — priority order
  `now` → `next`/default → `later` — **all of it, as one merged turn**
  (FINDINGS: same-priority executing messages merge FIFO into a single turn,
  so the whole bucket is one predicted `result`). `delivery: "turn"`, unless
  every message in the bucket has `shouldQuery: false`, in which case
  `"append"` (the content enters the transcript with no turn of its own).
  Remaining buckets drain at subsequent `result`s.

Explicit merge handling fixes a latent Phase-1 bug: two `later`s queued while
busy count as two under a per-message `queueDepth`, but they run merged as
_one_ turn with _one_ `result` — the Phase-1 fold would strand `queueDepth`
at 1 and never reach idle. Here the merged dequeue carries both ids and
predicts exactly one `result`.

**Flagged assumptions** — both verified live on 2026-07-06; methodology,
exact commands, pass criteria, and the raw tail capture are in
`docs/derisk/echoed-message-placement/PHASE2-VERIFICATION.md`:

- A `result` terminated by `interrupt()` dequeues like any other: FINDINGS
  `c_perm` shows a queued `next` executing after a `now`-abort ended the turn
  (an interrupt-like abort), but `Query.interrupt()` itself was never
  captured. **Verified**: interrupting a running turn with a `later` queued
  produced `result (error_during_execution)` → `dequeued turn` → the queued
  turn's own `result` — the queue keeps draining, so `wait-idle` cannot hang
  on an interrupt.
- `shouldQuery: false` messages follow the same queueing/dequeuing rules as
  their priority implies: one that would dequeue as `steer` still steers; one
  that would dequeue as its own turn becomes `"append"` instead (per the SDK
  doc: appended to the transcript, merged into the next querying message).
  **Verified** both halves: a no-query message sent mid-tool-turn dequeued
  `steer` at its boundary; one sent during a tool-less turn dequeued `append`
  at the `result` with only a zero-turn (`num_turns: 0`) bookkeeping result.
  In each case the next querying turn recalled the message's content, proving
  it entered context.

The `query` response returns immediately with no delivery claim — the daemon
does not know a demotable message's fate at accept time, and blocking the
response until the next boundary could hang the CLI for minutes. The
queued/dequeued events on the stream are the truth. (Deviation from the
scaffold's "`query` should surface that distinction to the caller"; queuing
is native for claude, so accept-and-observe is the model.)

### Assistant-state fold

`turnAccepted` disappears. The fold tracks the queue explicitly, and
`pending`'s meaning — _predicted_ activity, not yet confirmed by SDK evidence
— now covers both a dequeued turn that has not shown output and queued
messages awaiting their boundary. Let **Q** = the number of queued entries
with `shouldQuery === true` (only those predict a future `result`):

- `userMessageQueued` → append `{ id, shouldQuery }`; if `shouldQuery` and
  `idle` → `pending`.
- `userMessageDequeued` → remove the ids; activity unchanged (`"turn"`
  dequeues arrive after a `result` that already set `pending`; `"steer"` and
  `"append"` have no activity of their own).
- `result` → `pending` iff Q > 0, else `idle`. The bucket the CLI consumes at
  this boundary is still in the fold's queue (its dequeue event follows the
  `result`), so remaining work is counted, not guessed — no transient idle,
  no spurious `wait-idle` wake.
- First `assistant` message (outside compacting) → `working`, as in Phase 1.
- `compactSent` → `compacting` (no queue entry; its terminating `result`
  follows the rule above). `interruptSent`, `controlApplied` → state
  unchanged.
- Invariant: `activity === "idle"` ⇒ Q === 0 (entries with `shouldQuery ===
  false` may remain queued while idle).

### daemon.log shrink

The EventBus no longer mirrors the stream to stdout. daemon.log carries only
the `[daemon]`-prefixed exceptional lines (session rollovers, stream end,
startup/teardown errors). The Phase-1 `TODO(Phase 2+)` in daemon.ts is
resolved by this phase. Consequence, accepted: events emitted while no
subscriber is connected are observable only through their effects (state
snapshot, agent.json, session JSONL).

### Commands

**Passthrough subcommands** — flat kebab-case, one per request type, each
target-taking and transparently reviving (like Phase 1's four). Reads print
their response `data` as JSON. The coverage invariant from DECISION-4 holds:
every `Query` method is a subcommand except `close`/`streamInput`/
`reinitialize`, each carrying a comment at the mapping site explaining the
exclusion; `usage` is the stable alias for
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (commented);
`set-max-thinking-tokens` is deprecated SDK-side but kept as the only runtime
thinking control (commented).

| subcommand                                                                                                                                               | args/flags                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `set-permission-mode`                                                                                                                                    | `<mode>` (exists)                                              |
| `set-mcp-permission-mode-override`                                                                                                                       | `<server> <default\|auto\|clear>` (`clear` → `null`)           |
| `set-model`                                                                                                                                              | `[--model <m>]` (exists)                                       |
| `set-max-thinking-tokens`                                                                                                                                | `<n\|clear>` `[--thinking-display summarized\|omitted\|clear]` |
| `apply-flag-settings`                                                                                                                                    | `<json-or-path>` (inline-JSON-or-file, like `--mcp-config`)    |
| `set-mcp-servers`                                                                                                                                        | `<json-or-path>` (same parse)                                  |
| `toggle-mcp-server`                                                                                                                                      | `<server> <enabled\|disabled>`                                 |
| `reconnect-mcp-server`                                                                                                                                   | `<server>`                                                     |
| `stop-task`                                                                                                                                              | `<task-id>`                                                    |
| `background-tasks`                                                                                                                                       | `[--tool-use-id <id>]`                                         |
| `rewind-files`                                                                                                                                           | `<user-message-id> [--dry-run]`                                |
| `seed-read-state`                                                                                                                                        | `<path> <mtime>`                                               |
| `reload-plugins`, `reload-skills`                                                                                                                        | —                                                              |
| `interrupt`                                                                                                                                              | (exists)                                                       |
| `initialization-result`, `supported-commands`, `supported-models`, `supported-agents`, `mcp-server-status`, `get-context-usage`, `usage`, `account-info` | —                                                              |
| `read-file`                                                                                                                                              | `<path> [--max-bytes <n>] [--base64]`                          |

**`query`** gains:

- `--image <path>` (repeatable) — each read → base64 → `ImageBlockParam`
  beside the text; the request's `content` becomes `ContentBlockParam[]`.
- `--no-query` — sets `shouldQuery: false` (append to transcript without
  triggering a turn).

**`tail <target>`** — connects **without reviving** (a dormant or archived
agent is an error naming the state, with a hint that sending it a command,
e.g. `clauctl query`, revives it). Subscribes, prints `{"snapshot": …}` then
each `SdkEventRecord` line verbatim until the daemon closes the socket or the
user interrupts. Raw JSONL is the only mode in this phase; when the formatted
`tail` lands (Phase 3+) this behavior moves behind `tail --raw`.

**`resolve-settings [--cwd <dir>]`** — target-less and client-side only:
calls the SDK's `resolveSettings({ cwd })` (default: process cwd) and prints
the `ResolvedSettings` JSON — what a spawn at that cwd would see (DECISION-7).

### Persistence (DECISION-5)

Mutations persist into `agent.json` as in Phase 1, extended to the full map:

- `set-model` → `persistedOptions.model`
- `set-permission-mode` → `permissionMode` (+ `allowDangerouslySkipPermissions`
  when entering bypass)
- `set-max-thinking-tokens` → `maxThinkingTokens` (`thinkingDisplay` has no
  `Options` home; accepted as lost across respawn)
- `apply-flag-settings` → `settings`, cumulative shallow-merge with `null`
  clearing a key. If the persisted `settings` is a **path string** (spawned
  via `--settings <file>`), the first apply reads and parses that file, then
  merges; from then on the merged object is what persists.
- `set-mcp-servers` → `mcpServers` (all entries arrived over JSON, so all are
  serializable by construction)
- All other mutations persist nothing (transient session state).

### Type design

`src/core/sdk-socket.ts` (revised protocol types):

```ts
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  McpServerConfig,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantState } from "./assistant-state.ts";

export type MessageDelivery = "turn" | "steer" | "append";

export type SdkEvent =
  | { kind: "userMessageQueued"; id: number; message: SDKUserMessage }
  | { kind: "userMessageDequeued"; delivery: MessageDelivery; ids: number[] }
  | { kind: "compactSent"; message: SDKUserMessage }
  | { kind: "interruptSent" }
  | { kind: "controlApplied"; request: SdkControlMutation }
  | { kind: "sdkMessage"; message: SDKMessage };

export type TurnPriority = "now" | "next" | "later";

/** Query mutations except interrupt; each maps 1:1 to a Query method and emits controlApplied. */
export type SdkControlMutation =
  | { type: "set-permission-mode"; mode: PermissionMode }
  | { type: "set-mcp-permission-mode-override"; serverName: string; mode: "default" | "auto" | null }
  | { type: "set-model"; model?: string }
  | { type: "set-max-thinking-tokens"; maxThinkingTokens: number | null; thinkingDisplay?: "summarized" | "omitted" | null }
  | { type: "apply-flag-settings"; settings: { [K in keyof Settings]?: Settings[K] | null } }
  | { type: "set-mcp-servers"; servers: Record<string, McpServerConfig> }
  | { type: "toggle-mcp-server"; serverName: string; enabled: boolean }
  | { type: "reconnect-mcp-server"; serverName: string }
  | { type: "stop-task"; taskId: string }
  | { type: "background-tasks"; toolUseId?: string }
  | { type: "rewind-files"; userMessageId: string; dryRun?: boolean }
  | { type: "seed-read-state"; path: string; mtime: number }
  | { type: "reload-plugins" }
  | { type: "reload-skills" };

/** Query reads; response `data` is the method's return value. */
export type SdkControlRead =
  | { type: "initialization-result" }
  | { type: "supported-commands" }
  | { type: "supported-models" }
  | { type: "supported-agents" }
  | { type: "mcp-server-status" }
  | { type: "get-context-usage" }
  | { type: "usage" }
  | { type: "account-info" }
  | { type: "read-file"; path: string; maxBytes?: number; encoding?: "utf-8" | "base64" };

export type SdkRequest =
  | { type: "query"; content: string | ContentBlockParam[]; priority?: TurnPriority; shouldQuery?: false }
  | { type: "interrupt" }
  | { type: "wait-idle" }
  | { type: "subscribe" }
  | SdkControlMutation
  | SdkControlRead;

/** A pushed stream event on a subscribed connection; no `id`, unlike responses. */
export interface SdkEventRecord {
  event: SdkEvent;
}

/** What a subscriber starts from; no history replay. */
export interface StateSnapshot {
  assistantState: AssistantState;
  sessionId?: string;
}

export class SdkSocketClient {
  // existing: connect, request, waitClosed, isClosed, close
  /** Sends subscribe; onEvent fires for every SdkEventRecord after the snapshot. */
  subscribe(onEvent: (event: SdkEvent) => void): Promise<StateSnapshot>;
}
```

`src/core/assistant-state.ts` (revised fold state):

```ts
export type AssistantActivity = "idle" | "pending" | "working" | "compacting";

/** An accepted-but-not-yet-dequeued message, as the fold tracks it. */
export interface QueuedEntry {
  id: number;
  /** Normalized SDK field (`shouldQuery !== false`) — whether this message predicts a future result. */
  shouldQuery: boolean;
}

export interface AssistantState {
  activity: AssistantActivity;
  queued: QueuedEntry[];
}

export const INITIAL_ASSISTANT_STATE: AssistantState;
export const isBusy: (state: AssistantState) => boolean;
export function nextAssistantState(state: AssistantState, event: SdkEvent): AssistantState;
```

`src/core/queue-model.ts` (new, replacing nothing — the CLI-queue model; pure,
unit-tested):

```ts
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkEvent } from "./sdk-socket.ts";

/** One accepted-but-not-yet-dequeued message in the modeled CLI queue. */
export interface QueuedMessage {
  id: number;
  message: SDKUserMessage;
  /** A tool_result has been observed since THIS message's acceptance. */
  toolResultSeen: boolean;
}

export interface QueueModelState {
  nextId: number;
  queued: QueuedMessage[];
}

export const INITIAL_QUEUE_MODEL_STATE: QueueModelState;

/**
 * Subject to the demote fork: priority next/default. Demotability also
 * requires acceptance while busy, but every entry *resident* in the queue was
 * accepted while busy (idle acceptance dequeues immediately), so for queued
 * messages this is purely a function of priority.
 */
function isDemotable(message: SDKUserMessage): boolean;

export interface QueueTransition {
  state: QueueModelState;
  /** Events to emit, in order, immediately after the triggering occurrence. */
  events: SdkEvent[];
}

/** Accept a turn from a client; emits userMessageQueued (plus the immediate dequeue when idle). */
export function acceptUserMessage(
  state: QueueModelState,
  message: SDKUserMessage,
  busy: boolean,
): QueueTransition;

/** Fold an observed SDK message into the model; emits any dequeues it implies. */
export function observeSdkMessage(
  state: QueueModelState,
  message: SDKMessage,
): QueueTransition;
```

`src/core/daemon.ts` (EventBus and server revisions):

```ts
class EventBus {
  // constructor no longer takes a sink
  emit(event: SdkEvent): void; // serializes once as an SdkEventRecord line, writes to every sink
  subscribe(sink: (serializedEventRecord: string) => void): () => void; // returns unsubscribe
  get assistantState(): AssistantState;
  whenIdle(): Promise<void>;
}

/** Per-connection handle so subscribe can attach a sink and unhook it on close. */
interface SdkConnection {
  write(line: string): void;
  onClose(cleanup: () => void): void;
}

function startSdkServer(
  socketPath: string,
  handleRequest: (request: SdkRequestRecord, connection: SdkConnection) => Promise<unknown>,
): Server;
```

`src/core/tail.ts` (new): `tail` as `commandOneTarget`, no flags; loads the
agent and checks `isPidAlive(daemonPid)` itself (no `ensureAgentRunning` — by
design it must not revive).

Dependency notes: the daemon's `query` handler calls `acceptUserMessage`
(with `busy` from the EventBus state) and emits the returned events; the
stream reader threads every `SDKMessage` through `observeSdkMessage`, emits
the message's own `sdkMessage` event, then emits any dequeues the model
returned (dequeues follow their trigger). Every `SdkControlMutation` handler
calls its `Query` method, emits `controlApplied`, then persists per the map
above. `nextAssistantState` consumes the queued/dequeued events instead of
`turnAccepted`.

### Edge cases

- **Steer anchoring is positional**: steer dequeues are emitted at the first
  assistant activity after the tool result, so they land adjacent to their
  anchor, in injection order.
- **Straggler acceptance**: a demotable message accepted after a tool_result
  but before the following assistant activity is _not_ dequeued with that
  group (its `toolResultSeen` is false); it waits for its own boundary — the
  next tool_result+assistant handoff, or the turn's `result`.
- **Undequeued messages at daemon shutdown** are dropped with the connection —
  they were handed to the SDK; whether claude delivered them is not ours to
  guarantee mid-teardown.
- **Subscriber backpressure**: sinks are fire-and-forget socket writes; a slow
  subscriber buffers in its socket, never blocks the daemon or other clients.
- **`/compact` routing is unchanged** (idle-only, `compactSent`); it is not a
  queued user message.
- **`wait-idle` correctness**: at a `result`, the about-to-run bucket is still
  in the fold's queue (its dequeue event follows), so the fold moves to
  `pending`, never through a transient `idle` — `wait-idle` cannot resolve
  between a busy turn and a queued turn that will run next.

### Non-goals

- Interactive permission round-trip (`canUseTool` → client → back) — deferred
  by DECISION-3; the protocol leaves room (new request/record types), nothing
  is built.
- History replay / `get-messages`, formatted `tail`, `wait` — Phase 3.
- Protocol version negotiation — hello stays version 1 until release.
- Exposing `close`/`streamInput`/`reinitialize` (commented at mapping site).

### Success criteria

1. `clauctl tail` on a running agent prints the snapshot record, then live
   events; a `query` from a second terminal appears on the tail as a
   `userMessageQueued` (and its dequeue) followed by the turn's `sdkMessage`
   stream.
2. Steer demotion is observable: a default-priority `query` sent mid-tool-turn
   yields `userMessageQueued` at acceptance and a
   `userMessageDequeued { delivery: "steer" }` adjacent to the anchoring tool
   result, with no extra `result` for it.
3. The demote-vs-execute fork is correct: a default-priority `query` sent
   during a tool-less busy turn yields a `userMessageDequeued { delivery:
   "turn" }` after the busy turn's `result`, and a concurrent
   `archive --timeout` (wait-idle) does not fire between the two turns.
4. Merge accounting is correct (unit-tested): two `later` messages queued
   while busy produce one `userMessageDequeued` carrying both ids, and the
   fold reaches `idle` after their single `result`.
5. Every `Query` method is reachable as a subcommand (coverage invariant:
   the three exclusions are commented); reads print JSON.
6. `set-model`/`set-permission-mode`/`apply-flag-settings`/`set-mcp-servers`
   emit `controlApplied` on the stream and persist per the DECISION-5 map.
7. `query --image` sends an image block claude describes; `query --no-query`
   appends without triggering a turn.
8. `tail` on a dormant agent errors without reviving it; daemon.log of a fresh
   agent contains only `[daemon]` lines (no event stream).
9. `resolve-settings` prints the effective settings for a cwd without
   spawning anything.
10. `npm run presubmit` passes (tsc, eslint, sync --check, treefmt, all
    tests, including new queue-model and fold unit tests).

## IMPLEMENTATION IDEAS (evolving)

- **Fold/model split**: `nextAssistantState` stays a pure fold over emitted
  events; the queue model is a _pre-emission_ state machine deciding what to
  emit and when. Keeping them separate keeps both unit-testable without a
  daemon. The daemon remains the only place they meet.
- `subscribe` handler: capture the snapshot and attach the sink in the same
  synchronous section as the response write; `emit` is synchronous, so no gap.
- The `usage` alias and `set-max-thinking-tokens` deprecation comments go at
  the daemon's `switch` arms (the mapping site), matching the coverage
  invariant's convention.
- CLI-side image reading mirrors `pictl prompt` (read → base64 → block);
  media type by extension.
- `SdkRequestRecord` parsing on the server stays structural (no validation
  layer); unknown `type` falls through the exhaustive `switch` to an error
  response.
- `SdkSocketClient.subscribe` is single-use per client (a second call is a
  programming error); requests may still be sent on a subscribed connection.
  `dispatchLine` routes structurally — records with `id` resolve pending
  requests, records with `event` go to `onEvent` — so the event callback
  never sees responses.
- Test seams: queue-model scenarios replay the FINDINGS captures' shapes —
  `c_perm` drain order (now → next → later, each its own turn), `b_next2`
  group demotion, same-priority merge, straggler acceptance between
  tool_result and assistant, idle-time accept (queued+dequeued pair), and the
  `shouldQuery: false` variants (steer stays steer; solo turn becomes
  append). Fold tests extend `assistant-state.test.ts` to the new event kinds
  and the merge-leak regression (criterion 4).

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-04: Spec written after two derisk rounds + type-design approval.
  Key decisions: deferred fork-resolved echoes (emit-before-trigger ordering);
  no history replay (snapshot-on-subscribe); `QueueDepthChanged`/
  `SdkClientConnected` dropped; generic `controlApplied`; log shrink in this
  phase; `tail` raw-only and non-reviving; `query` response makes no delivery
  claim; partials forwarded unfiltered; `apply-flag-settings` reads a
  path-string `settings` file before first merge; hello stays version 1.
- 2026-07-04 (critique pass): two revisions. (1) `toolResultSeen` moved from
  resolver-global to per-pending-message — a global flag would wrongly
  resolve a message accepted between a tool_result and the following
  assistant activity ("straggler") with the earlier group. (2) Documented the
  interrupt assumption: a `result` terminated by `interrupt()` resolves
  pending deferred echoes as `turn`, backed by the `c_perm` now-abort analogy
  but not by a direct capture.
- 2026-07-06 (Anton's review round): the echo design replaced wholesale by
  the **queue model**. Anton rejected the emit-echo-before-trigger ordering
  inversion (conceptually backwards); working his fold-deferral idea through
  led to acceptance-time events plus explicit dequeues: `userMessageQueued
  { id, message }` at acceptance, `userMessageDequeued { delivery, ids }`
  after the trigger, with daemon-assigned ids making cross-priority dequeue
  order unambiguous. "Echo" terminology purged (it wrongly implied insertion
  point). Fold reworked to track queued entries; `result` → pending iff
  querying messages remain queued — no ordering inversion needed. Found and
  fixed a latent Phase-1 leak: same-priority merged turns produce one
  `result` for N accepted messages; the merged dequeue carries all ids.
  Anton's `shouldQuery: false` rule: no-query messages follow normal
  queue/dequeue placement; would-be-steer stays steer, would-be-turn becomes
  `append`; Q counts querying messages only. Flagged assumptions for optional
  empirical derisk: interrupt keeps the queue draining; no-query placement.
  TDC 2 resolved (mutation/read split = classification by documented
  semantics, low misclassification cost); TDC 3 resolved (`dispatchLine`
  routes structurally; `onEvent` never sees responses).
- 2026-07-06 (implementation, session 1): core landed and unit-tested —
  sdk-socket.ts protocol types + client `subscribe`/event routing;
  queue-model.ts; assistant-state.ts fold rework; daemon.ts (EventBus
  fan-out + log shrink, full Query passthrough with controlApplied +
  DECISION-5 persistence, subscribe handler, queue-model threading);
  sdk-commands.ts full subcommand set incl. `query --image/--no-query` and
  `resolve-settings`; tail.ts. `tsc` clean, 67 tests pass (new
  queue-model.test.ts + rewritten assistant-state.test.ts, incl. the
  criterion-4 merge regression). Remaining: lint/fmt/presubmit, and the
  live success-criteria walkthrough (1–3, 5–9).

  ## Implementation-Time Decisions

  - **`RESPONSE_SENT` sentinel for subscribe**: the server's generic respond
    path runs in a microtask after the handler resolves; an event emitted in
    that window would hit the wire before the response line. The subscribe
    handler therefore writes its own response synchronously (snapshot capture,
    response write, sink attach in one synchronous section) and returns a
    sentinel telling the server not to respond again.
  - **Client-side ordering is the subscriber's job**: `SdkSocketClient`
    delivers events synchronously from the data handler while the subscribe
    response resolves via microtask, so onEvent can fire before `subscribe()`
    settles. Rather than fragile microtask-ordering tricks in the client,
    `tail` gates its output on the snapshot line (buffer, print snapshot,
    flush) — the only consumer needing strict stdout order.
  - **`handleSessionInit` split out of `handleMessage`** so the reader's
    emit-then-observe sequencing (sdkMessage event first, then any dequeues
    the model implies) reads linearly.

- 2026-07-06 (Anton's second review round, a702d57): `QueuedEntry.querying`
  renamed to `shouldQuery` (the SDK's own term, normalized to a defaulted
  boolean). `QueuedMessage.demotable` replaced by a derived `isDemotable(
  message)` — valid because every queue-resident entry was accepted while
  busy, so demotability reduces to priority alone; the invariant is stated at
  the function.

- 2026-07-06 (implementation review round, 621bca3): to shrink the surface
  that changes when the SDK changes, the Query passthrough moved out of
  daemon.ts into a new `sdk-passthrough.ts` (`isControlMutation`,
  `applyMutation`, `runRead`, and `persistedOptionsAfter` — the DECISION-5
  persistence map, including `mergeFlagSettings`). The SDK-churn zone is now
  exactly three sibling files: sdk-socket.ts (wire types), sdk-passthrough.ts
  (daemon dispatch), sdk-commands.ts (CLI); daemon.ts and the state machines
  never name individual Query methods. `MUTATION_TYPES` is a
  `Record<SdkControlMutation["type"], true>` so a new mutation variant is a
  compile error at the guard. Also split the subscribe handler's
  sink-attach into an explicit `unsubscribe` variable (Anton's TDC: the
  one-liner read as "subscribe on close"; subscription is immediate, onClose
  only registers the cleanup). Presubmit green; 67/67 tests.

- 2026-07-06 (live walkthrough): all success criteria verified against a real
  agent (isolated `CLAUCTL_DIR` + `CLAUDE_CONFIG_DIR` with copied
  `.credentials.json`, haiku, ~$0.10 total). Highlights: (1) tail shows
  snapshot → queued/dequeued pair → sdkMessage stream; (2) mid-tool-turn
  default query dequeued `steer` adjacent to its anchoring tool_result, one
  `result` total; (3) tool-less busy turn: follow-up dequeued `turn` after the
  first `result`, and a concurrent `archive --timeout` completed only after
  the second turn — the snapshot taken mid-turn correctly showed
  `pending` with the follow-up in `queued`; (6) all four mutations emitted
  `controlApplied` and persisted per DECISION-5; (7) `--image` described the
  generated PNG; `--no-query` appended with no turn; (8) dormant tail errored
  without reviving; daemon.log contained only `[daemon]` lines (plus node
  type-stripping warnings from running `.ts` source). Observed SDK detail
  worth knowing: a `shouldQuery: false` append still elicits a zero-cost
  bookkeeping `result` (`num_turns: 0`, empty text) from the CLI; the fold
  handles it (idle → idle, Q === 0).

- 2026-07-06 (assumption experiments): both flagged assumptions verified live
  (same sandbox, haiku). Full methodology and the raw capture:
  `docs/derisk/echoed-message-placement/PHASE2-VERIFICATION.md`. Interrupt: a queued `later` dequeued as `turn`
  immediately after the interrupted turn's `result` (subtype
  `error_during_execution`) and ran normally — the queue drains through
  interrupts. shouldQuery:false: mid-tool-turn no-query dequeued `steer`;
  during a tool-less turn it dequeued `append` at the `result` (zero-turn
  bookkeeping result only); both were recalled verbatim by the next querying
  turn. Incidental observation: when the copied OAuth token expired mid-run,
  turns "succeeded" instantly with result text "Not logged in · Please run
  /login" (subtype `success`!) — after refreshing credentials, the CLI
  flushed the affected messages into the next turn. The fold and queue model
  stayed coherent throughout.
