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
2. **Echo augmentation** — the daemon synthesizes `EchoedUserMessage` events
   with `delivery: "turn" | "steer"` per the echo-placement rule
   (`docs/derisk/echoed-message-placement/FINDINGS.md`, Round 3).
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
serves its purpose) and `QueueDepthChanged` is dropped (queue depth is
derivable — observers run the same `nextAssistantState` fold from the
snapshot).

### Event set

```
SdkEvent =
  | echoedUserMessage { message: SDKUserMessage, delivery: "turn" | "steer" }
  | compactSent       { message: SDKUserMessage }
  | interruptSent
  | controlApplied    { request: SdkControlMutation }
  | sdkMessage        { message: SDKMessage }
```

- `echoedUserMessage` replaces Phase 1's `turnAccepted`. `message` is the exact
  `SDKUserMessage` pushed to the SDK — it natively carries `priority` and
  `shouldQuery`, which observers need to apply the placement rule.
  `delivery: "steer"` means the CLI demoted the message to an in-turn
  `<system-reminder>`; it never runs as its own turn.
- `compactSent` gains the pushed message (observers could not previously see
  `/compact <instructions>` text).
- `controlApplied` is emitted after **every successful mutating passthrough**
  (every `SdkControlMutation`; `interrupt` keeps its own state-relevant event).
  The payload is the request as received — the same trigger and payload as
  DECISION-5's persist-on-mutation, so observers track option changes exactly
  as the record does. Reads emit nothing.
- `sdkMessage` forwards **everything, including partials**
  (`stream_event`). Deviation from the scaffold ("consumed internally, not
  forwarded"): `tail` is explicitly raw, a future TUI wants partials, and the
  Phase-3 formatted `tail` is where filtering will live. No filtering in this
  phase.

### Echo placement (deferred fork resolution)

`now`, `later`, and idle-time default turns have certain delivery: echo
immediately at acceptance with `delivery: "turn"`.

A `next`/default turn accepted **while busy** is demote-*able*: it becomes a
steer in the common tool-using case but runs as a real turn if the busy turn
is tool-less or a co-queued `now` ends the turn at the same boundary
(FINDINGS `c_perm`). Delivery is therefore **not knowable at acceptance**; the
daemon defers the echo until the fork resolves. With partials on, resolution
follows within moments, so the deferral has almost no cost. Resolution rules,
watching the SDK stream after acceptance — the FINDINGS rule is "what follows
the first tool_result **after acceptance**", so the tool-result marker is
tracked **per pending message**, not globally (a message accepted between a
tool_result and the following assistant activity has not seen its own
boundary yet and must wait for the next one):

- A user message carrying `tool_result` blocks ⇒ mark `toolResultSeen` on
  every currently pending message.
- Assistant activity (`assistant` or `stream_event`) ⇒ resolve the **marked**
  pending messages as `steer`, in injection order; unmarked ones stay pending.
- The turn's `result` ⇒ resolve **all** pending as `turn` (covers both the
  tool-less busy turn and the co-queued-`now` case). This includes a `result`
  terminated by `interrupt()` — an assumption, not a captured fact: FINDINGS
  `c_perm` shows a queued `next` executing after a `now`-abort ended the turn
  (an interrupt-like abort), but `Query.interrupt()` itself was never
  captured. If claude instead discards the queue on interrupt, `queueDepth`
  leaks and `wait-idle` hangs; verify against reality if symptoms appear.

**Ordering rule**: resolved echoes are emitted *before* the triggering
message's own event.** For the steer case this anchors the echoes adjacent to
their tool result. For the turn case this is load-bearing for state
correctness: emitting the `result` first would fold to a transient `idle`
(queueDepth 1→0) before the echo re-raises it, firing `wait-idle` waiters
spuriously between two turns. Echo-first folds 1→2→1 and the state stays
busy. This ordering looks backwards (an echo preceding the previous turn's
`result`) and **must carry a prominent comment in the emission code** so a
future reader doesn't "fix" it and reintroduce the transient idle.
TDC: On reflection, I really don't like this. Conceptually, the echoed messages occur _after_ the triggering event. Rather than inverting the order to avoid accidental idle state, why don't we just transition the assistant state to "pending" in this situation. The semantics of "pending" is exactly that we _predict_ that the SDK will soon show activity but it has not been empirically confirmed yet. This amounts to simply moving the decrement of queueDepth until _after_ we determine the next activity in src/core/assistant-state.ts. What do you think?

The `query` response returns immediately with no delivery claim — with
deferred resolution the daemon does not know the delivery at accept time, and
blocking the response until the next boundary could hang the CLI for minutes.
The echo on the stream is the truth. (Deviation from the scaffold's "`query`
should surface that distinction to the caller"; queuing is native for claude,
so accept-and-observe is the model.)

### Assistant-state fold

`turnAccepted` disappears; delivery is explicit on the echo, so the demotion
special-casing leaves the fold:

- `echoedUserMessage` with `delivery: "turn"` → `queueDepth + 1`; `idle` →
  `pending`.
- `echoedUserMessage` with `delivery: "steer"` → state unchanged.
- `controlApplied` → state unchanged.
- `compactSent`, `interruptSent`, `sdkMessage` → as in Phase 1.

The invariant `activity === "idle" ⇒ queueDepth === 0` and the `result`
decrement rule are unchanged.

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

| subcommand | args/flags |
| --- | --- |
| `set-permission-mode` | `<mode>` (exists) |
| `set-mcp-permission-mode-override` | `<server> <default\|auto\|clear>` (`clear` → `null`) |
| `set-model` | `[--model <m>]` (exists) |
| `set-max-thinking-tokens` | `<n\|clear>` `[--thinking-display summarized\|omitted\|clear]` |
| `apply-flag-settings` | `<json-or-path>` (inline-JSON-or-file, like `--mcp-config`) |
| `set-mcp-servers` | `<json-or-path>` (same parse) |
| `toggle-mcp-server` | `<server> <enabled\|disabled>` |
| `reconnect-mcp-server` | `<server>` |
| `stop-task` | `<task-id>` |
| `background-tasks` | `[--tool-use-id <id>]` |
| `rewind-files` | `<user-message-id> [--dry-run]` |
| `seed-read-state` | `<path> <mtime>` |
| `reload-plugins`, `reload-skills` | — |
| `interrupt` | (exists) |
| `initialization-result`, `supported-commands`, `supported-models`, `supported-agents`, `mcp-server-status`, `get-context-usage`, `usage`, `account-info` | — |
| `read-file` | `<path> [--max-bytes <n>] [--base64]` |

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

export type EchoDelivery = "turn" | "steer";

export type SdkEvent =
  | { kind: "echoedUserMessage"; message: SDKUserMessage; delivery: EchoDelivery }
  | { kind: "compactSent"; message: SDKUserMessage }
  | { kind: "interruptSent" }
  | { kind: "controlApplied"; request: SdkControlMutation }
  | { kind: "sdkMessage"; message: SDKMessage };

export type TurnPriority = "now" | "next" | "later";

// TDC: The separation between SdkControlMutation and SdkControlRead is speculative, right? We don't actually know which query methods mutate internal state, but we're making an educated guess, and sending a controlApplied event just for those that we think mutate state. Is that correct?

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

`src/core/echo-resolver.ts` (new; pure, unit-tested):

```ts
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EchoDelivery } from "./sdk-socket.ts";

export interface PendingEcho {
  message: SDKUserMessage;
  /** A tool_result has been observed since THIS message's acceptance. */
  toolResultSeen: boolean;
}

export interface EchoResolverState {
  pending: PendingEcho[]; // unresolved next/default-while-busy, injection order
}

export const INITIAL_ECHO_RESOLVER_STATE: EchoResolverState;

/** A next/default turn accepted while busy: echo deferred until the fork resolves. */
export function deferEcho(
  state: EchoResolverState,
  message: SDKUserMessage,
): EchoResolverState;

export interface EchoResolution {
  state: EchoResolverState;
  /** When set, the daemon emits these echoes BEFORE forwarding the observed message. TDC: let's make this _after_ */
  resolved?: { delivery: EchoDelivery; messages: SDKUserMessage[] };
}

export function observeSdkMessage(
  state: EchoResolverState,
  message: SDKMessage,
): EchoResolution;
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

Dependency notes: the daemon's `query` handler calls `deferEcho` (busy
`next`/default) or emits the echo directly; the stream reader threads every
`SDKMessage` through `observeSdkMessage` and emits any resolved echoes before
the message's own `sdkMessage` event; every `SdkControlMutation` handler
calls its `Query` method, emits `controlApplied`, then persists per the map
above. `nextAssistantState` consumes `echoedUserMessage` instead of
`turnAccepted`.

### Edge cases

- **Steer echo anchoring is positional**: steers are emitted before the first
  assistant activity after the tool result, so they land adjacent to their
  anchor; multiple pending `next`/defaults resolve together, in injection
  order, individually (one echo event each).
- **Straggler acceptance**: a `next`/default accepted after a tool_result but
  before the following assistant activity is *not* resolved with that group
  (its `toolResultSeen` is false); it waits for its own boundary — the next
  tool_result+assistant handoff, or the turn's `result`.
- **Unresolved echoes at daemon shutdown** are dropped with the connection —
  the messages were handed to the SDK; whether claude delivered them is not
  ours to guarantee mid-teardown.
- **Subscriber backpressure**: sinks are fire-and-forget socket writes; a slow
  subscriber buffers in its socket, never blocks the daemon or other clients.
- **`/compact` routing is unchanged** (idle-only, `compactSent`); it is not an
  `echoedUserMessage`.
- **`wait-idle` and the deferred turn echo**: the echo-before-`result`
  ordering guarantees no transient idle, so `wait-idle` cannot resolve between
  a busy turn and a queued turn that will run next.

### Non-goals

- Interactive permission round-trip (`canUseTool` → client → back) — deferred
  by DECISION-3; the protocol leaves room (new request/record types), nothing
  is built.
- History replay / `get-messages`, formatted `tail`, `wait` — Phase 3.
- Protocol version negotiation — hello stays version 1 until release.
- Exposing `close`/`streamInput`/`reinitialize` (commented at mapping site).

### Success criteria

1. `clauctl tail` on a running agent prints the snapshot record, then live
   events; a `query` from a second terminal appears on the tail as an
   `echoedUserMessage` followed by the turn's `sdkMessage` stream.
2. Steer demotion is observable: a default-priority `query` sent mid-tool-turn
   yields an echo with `delivery: "steer"` positioned adjacent to the
   anchoring tool result, and no extra `result` for it.
3. The deferred-turn fork is correct: a default-priority `query` sent during a
   tool-less busy turn yields a `delivery: "turn"` echo emitted before the
   busy turn's `result`, and a concurrent `archive --timeout` (wait-idle) does
   not fire between the two turns.
4. Every `Query` method is reachable as a subcommand (coverage invariant:
   the three exclusions are commented); reads print JSON.
5. `set-model`/`set-permission-mode`/`apply-flag-settings`/`set-mcp-servers`
   emit `controlApplied` on the stream and persist per the DECISION-5 map.
6. `query --image` sends an image block claude describes; `query --no-query`
   appends without triggering a turn.
7. `tail` on a dormant agent errors without reviving it; daemon.log of a fresh
   agent contains only `[daemon]` lines (no event stream).
8. `resolve-settings` prints the effective settings for a cwd without
   spawning anything.
9. `npm run presubmit` passes (tsc, eslint, sync --check, treefmt, all tests,
   including new echo-resolver and fold unit tests).

## IMPLEMENTATION IDEAS (evolving)

- **Fold/resolver split**: `nextAssistantState` stays a pure fold over emitted
  events; the echo resolver is a *pre-emission* state machine deciding what to
  emit and when. Keeping them separate keeps both unit-testable without a
  daemon.
- The emission-ordering comment (echo before triggering event) belongs at the
  daemon's stream-reader emission site *and* in `observeSdkMessage`'s doc
  comment — the invariant spans both.
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
  programming error); requests may still be sent on a subscribed connection —
  responses and events interleave, distinguished by `id`.
  TDC: does this mean that the onEvent callback sees responses as well as events? I don't think we want that, but maybe it's a moot point since I don't expect anything outside of clauctl to use SdkSocketClient.
- Test seams: echo-resolver scenarios replay the FINDINGS captures' message
  shapes (steer after tool_result+assistant, turn on tool-less result,
  co-queued now, straggler acceptance between tool_result and assistant);
  fold tests extend `assistant-state.test.ts` to the new event kinds.

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
  resolver-global to per-pending-message (`PendingEcho`) — a global flag would
  wrongly resolve a message accepted between a tool_result and the following
  assistant activity ("straggler") with the earlier group. (2) Documented the
  interrupt assumption: a `result` terminated by `interrupt()` resolves
  pending deferred echoes as `turn`, backed by the `c_perm` now-abort analogy
  but not by a direct capture.
