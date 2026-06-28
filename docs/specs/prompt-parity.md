# SPEC: prompt parity

## Problem statement

`clauctl query` is fire-and-forget: it submits a turn and exits, and the
caller must separately `tail` or `wait` to see what happened. The overview
(prompt-tail-parity-overview.md, "Spec 4") calls for `prompt`: submit input
and stream the turn it causes, rendered by exactly the machinery tail uses,
so the two commands cannot diverge.

The hard part is scoping "the turn it causes". The agent may be busy or the
input queued (`--priority next|later`), so "stream until the first `result`"
would watch someone else's turn conclude. The daemon's queue model already
assigns each accepted message a monotonic id and announces
`userMessageQueued {id, message}` / `userMessageDequeued {delivery, ids}` on
the event stream; what is missing is only the link from _our_ submission to
its id. This spec adds that link: the `query` request's response becomes an
acceptance receipt carrying the id.

## Success criteria

- `clauctl prompt <text>` (renamed from `query`; no back-compat alias)
  submits the input and streams the turn it causes: output is withheld until
  the daemon announces the dequeue of _our_ message, then rendered until that
  turn's `result`. Revival, auditing, and the `--image`/`--priority`/
  `--no-query` flags carry over from `query` unchanged.
- Output selection mirrors tail: `--type messages|entries|events` (messages
  default), `--json`, identical renderers at identical defaults — a finite
  formatted prompt's output is byte-equal to the same invocation's `--json`
  piped through the matching `clauctl format` subcommand, and formatted
  messages end with the `[cursor: <uuid>]` line.
- Subscribe-before-submit: the observation stream is established before the
  input is submitted, so a fast turn cannot be missed.
- `-d`/`--detach` preserves today's fire-and-forget behavior — submit,
  print nothing (the receipt is internal), exit 0; `--no-query` implies it
  (an appended message predicts no `result` to stream).
- The sdk.sock request (renamed `query` → `prompt` alongside the command)
  responds `{ id: number }`, the queue-model id of the accepted message.

## Command surface

```
clauctl prompt <text> [--type messages|entries|events] [--json]
                      [--until <cond>] [--timeout <secs>]
                      [-d|--detach] [--no-query]
                      [--priority now|next|later] [--image <path>]...
```

- No `--since`: prompt streams forward from its own submission
  (`history: "skip"`).
- Default settlement is `--until turn-end`; an explicit `--until` (turn-end,
  idle, `no-activity:<secs>`) replaces it. Conditions are evaluated only
  after our dequeue (see Gating), with one documented exception for
  `no-activity` below.
- `--timeout` bounds the whole invocation from subscription (not from
  dequeue); expiry raises `UntilTimeoutError` → exit 3, matching `wait` —
  unlike tail, prompt has a condition it failed to reach.
- `--detach` (explicit or implied by `--no-query`) combined with `--type`,
  `--json`, `--until`, or `--timeout` is a usage error.

## Gating on the acceptance receipt

1. Subscribe before submitting. For messages/entries this is an
   `AgentObserver` with `{ history: "skip" }`; for events a plain sdk.sock
   subscription. Anything carrying our id necessarily post-dates the
   subscription.
2. Submit on a separate short-lived sdk.sock connection (the observer stays
   purely observational). The response receipt gives `id`.
3. Drop observations and skip condition checks until a
   `userMessageDequeued` event whose `ids` includes our id.
4. From that point render and evaluate the condition. The default turn-end
   condition (next `result` event) is exactly our turn's end: a merged
   same-priority bucket dequeues as one event carrying all its ids and runs
   as a single turn with a single `result`, and `delivery: "steer"` means our
   message joined the running turn, whose `result` ends the stream.
   `delivery: "append"` only arises from `shouldQuery: false`, which implies
   detach, so it is unreachable while streaming.
5. Settle through the existing `UntilSettlement` entry catch-up, so the final
   assistant entry flushes before exit; formatted messages end with the
   cursor line.

Gate ordering by delivery kind:

- `"turn"` (idle acceptance, or a queued bucket consumed at a `result`): the
  dequeue event is emitted before the CLI can persist our user entry, so our
  own entry always renders.
- `"steer"`: the CLI embeds our text as a `<system-reminder>` inside a tool
  result, and the model emits the steer dequeue only at the _following_
  assistant activity — the persisted tool-result entry carrying our text can
  precede the gate opening and not render. Accepted: the message never runs
  as its own turn anyway, the remainder of the running turn (which our
  steer joined) streams normally, and tool-result entries render as
  summaries at best.

`--type events` output begins at our `userMessageDequeued` event (inclusive —
it is the window's opener); no seed snapshot is emitted (prompt's window
starts at dequeue; `tail --type events` is the snapshot-bearing surface), and
events have no cursor.

### `/compact`

`prompt "/compact"` bypasses the queue model (the daemon emits `compactSent`
with no queued/dequeued pair and the receipt is `undefined`), so id-gating
cannot apply: the gate starts open exactly when the receipt is `undefined` —
no client-side text sniffing, and `/compact`-with-`--image` (array content,
which the daemon treats as a normal query) gates correctly for free. It
streams ungated until the next `result`: compaction
terminates in a `result` event (established: agent-state.ts exits
`compacting` only at the subsequent `result`; until.ts records that a
compaction's terminating result counts as turn-end). A non-idle agent makes
the daemon reject `/compact`; the error surfaces as a normal failure.

## Settlement classification

- Condition met (default turn-end, including after an interrupt — interrupts
  terminate in a `result`) → flush, cursor, exit 0.
- `--timeout` expiry → `UntilTimeoutError` → exit 3.
- Observer failure, or stream close before the condition is met (the daemon
  dying mid-prompt is not conclusive success, unlike tail's dormancy
  reading), or a daemon-side submission error → exit 1.
- Malformed flags, detach conflicts → usage error, exit 2.

A documented wrinkle, accepted as intended: `no-activity:<secs>` runs on the
stream driver's quiet timer, which cannot be gated — a fully stalled agent
can fire it before our message ever dequeues. The condition is about the
agent, not our turn.

## Type Design

Daemon (protocol):

```ts
// event-hub.ts — returns the queue-model id it already computes.
deliverUserMessage(message: SDKUserMessage): number;

// request-handlers.ts "prompt" case — an acceptance receipt; still no
// delivery claim (a demotable message's fate is unknown at accept time).
// "/compact" keeps returning undefined.
return { id: events.deliverUserMessage(message) };
```

Client:

```ts
// src/core/entry-sink.ts (moved verbatim from tail.ts — tail.ts is getting
// large and the sink now has two consumers)
export interface EntrySink {
  push(entry: SessionEntry): void;
  end(): void;
}
export function entrySink(
  context: CommandContext,
  type: "messages" | "entries",
  json: boolean,
): EntrySink;

// src/core/prompt.ts (new; queryCommand, imageBlock, IMAGE_MEDIA_TYPES move
// here from sdk-commands.ts)
const promptFlags = {
  type, json, until, timeout,          // tail's flag builders
  detach,                              // booleanFlag, alias -d
  priority, image, noQuery,            // carried over from query
};

async function promptCommand(
  this: CommandContext,
  flags: PromptFlags,
  text: string,
): Promise<void>;
// dispatch: detach/noQuery → submit and exit;
//   "/compact" → ungated stream; else → gated stream.

/** Opens a short-lived connection, submits, returns the receipt id
 *  (undefined for /compact). Calls ensureAgentRunning upstream. */
async function submitPrompt(
  context: CommandContext,
  agent: AgentRecord,
  flags: PromptFlags,
  text: string,
): Promise<number | undefined>;

/** messages/entries leg: AgentObserver + EntrySink + UntilSettlement,
 *  onEvent gated by a closure boolean flipped by our dequeue event
 *  (starts open when promptId is undefined — the /compact path). */
async function promptObserved(
  context: CommandContext,
  agent: AgentRecord,
  type: "messages" | "entries",
  json: boolean,
  promptId: number | undefined,
  condition: UntilCondition,
  timeoutMs: number | undefined,
): Promise<void>;

/** events leg: plain sdk.sock subscription, same gate, EventFormatter or
 *  TailRecord `--json` framing, no snapshot, no cursor. */
async function promptEvents(
  context: CommandContext,
  agent: AgentRecord,
  json: boolean,
  promptId: number | undefined,
  condition: UntilCondition,
  timeoutMs: number | undefined,
): Promise<void>;
```

The gate is a command-level closure over the receipt id — a boolean flip on
one event kind — not a new class.

## Data Flow

```
promptCommand
  ├─ ensureAgentRunning (revival unchanged from query)
  ├─ detach? → submitPrompt → exit 0
  ├─ subscribe (AgentObserver history:"skip" | sdk.sock for events)
  ├─ submitPrompt (separate connection) → receipt id
  └─ runStream:
       before gate: drop observations, skip conditions
       userMessageDequeued ∋ id: open gate
       after gate: render via EntrySink/EventFormatter; evaluate condition
       condition met → UntilSettlement entry catch-up → flush, cursor, exit 0
```

## Cost

- One extra short-lived sdk.sock connection per prompt (the submit leg).
- The entry stream's subscribe-time full-file scan (canonical filter build),
  as with tail; `history: "skip"` renders none of it.

## Edge cases and non-goals

- Concurrent activity from other clients appears in the stream once the gate
  is open: prompt is an observation window, not an ownership filter
  (overview).
- A fresh agent with no session file: the observer's entry side idles until
  the first init announces one — our turn's entries follow it.
- Non-goals: `--since` on prompt; a `query` back-compat alias; any pictl
  change (Spec 5); filtering the window to "our" messages only.

# IMPLEMENTATION IDEAS

- `queryFlags`/`queryCommand` and the image helpers lift out of
  sdk-commands.ts nearly unchanged; sdk-commands keeps every other
  passthrough. Route registration moves with them (`prompt` stays `common`
  and audited).
- `deliverUserMessage` returning the id needs the queue-model transition's id
  threaded through the EventHub's accept path; `acceptUserMessage` already
  computes it as `state.nextId`.
- The stream-commands tests that spawn `query` rename to `prompt`; new
  prompt tests can reuse tail.test.ts's `withTailAgent` harness (live server
  answering subscribe, plus a `query` responder returning `{ id }`).
- The receipt is parsed defensively (`typeof data.id === "number"`) — the
  daemon is ours, so a malformed receipt is an internal error, not a usage
  error.

# WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] 2026-07-30: Derisk round. Decisions (Anton): the query response
      becomes an acceptance receipt `{ id }` (the queue model's id), and
      prompt gates output + condition checks on the `userMessageDequeued`
      carrying that id — correlation by id, not connection ordering, so
      AgentObserver stays purely observational and submission uses a
      separate connection. `--no-query` implies `--detach`; detach ×
      wait-flags is a usage error. `--until`/`--timeout` accepted; timeout
      expiry exits 3 (like wait, unlike tail). EntrySink moves to its own
      module. `prompt "/compact"` streams ungated until the next result.
      The ungateable pre-dequeue `no-activity` quiet timer is accepted as
      intended. Compaction-ends-in-result cited from agent-state.ts/until.ts
      rather than re-probed.
- [x] 2026-07-30: Critique pass. Corrected the gate-ordering claim: the
      steer path embeds the prompt text in a tool-result entry that can
      precede the steer dequeue event, so it may not render — documented as
      accepted rather than claimed impossible. Switched `/compact` detection
      to receipt-is-undefined (no client-side text sniffing). Made explicit
      that a detached prompt prints nothing (the receipt is internal).
- [x] Owner review of this draft (approved 2026-07-30, including the
      steer-path rendering caveat and receipt-based `/compact` detection).
- [x] 2026-07-30: Implementation. Daemon receipt (`AcceptTransition`,
      `deliverUserMessage(): number`, `{ id }` response), entry-sink.ts
      extraction, prompt.ts with both gated legs, query route removed
      (tail's revival hint now names `clauctl prompt`). prompt defaults
      `--until` to turn-end (`flags.until ?? { kind: "turn-end" }`); tail
      deliberately does not — the request/response-vs-observation asymmetry
      recorded in tail-parity.md's work log. Tests: 9 new
      in prompt.test.ts (detach/no-query, usage errors, both legs' gates,
      `/compact` ungated, timeout→3, close→1, malformed receipt),
      request-handlers query test now asserts the receipt. Presubmit green
      (564). Live smoke in an isolated CLAUCTL_DIR sandbox: gated messages
      leg rendered exactly our turn with cursor; a third submission's
      events leg opened at `userMessageDequeued ids:[3]` inclusive with no
      snapshot; detach printed nothing; `query` unregistered.
- [x] 2026-07-30: Review round 1 (commit b2fcc09). The sdk.sock request
      type renamed `query` → `prompt` end to end (SdkRequest, the daemon
      handler case, the TUI submit path, tests; the receipt error message
      now says "malformed prompt receipt"). The legs' `submit` parameter
      renamed for the action it defers (Anton settled on `submitPromptFn`,
      breaking the shadow with the module function); call sites pass the
      arrow inline so no second name for the same action exists. It stays a
      callback rather than a promise: a promise is already-running work, and
      the submission must not start before the subscription exists.
- [x] 2026-07-30: Critical review pass. Verified the success criteria,
      settlement classification, and data flow against the implementation;
      confirmed the pre-gate settlement claim (an entry observation cannot
      settle while `UntilSettlement.target` is unset, and only a withheld
      sdk-side condition fire can set it). Findings were doc-only: two
      comments left saying "query" for the renamed wire request
      (queue-model.ts's AcceptTransition doc, request-handlers.ts's origin
      note) and the harness ITD still naming `onQuery`; all fixed.
- [x] Owner review of the implementation.

## Implementation-Time Decisions

- **`submitPromptFn` callback instead of a `promptId` parameter.**
  `promptObserved`/`promptEvents` take `submitPromptFn: () => Promise<number
  | undefined>` rather than the spec's pre-computed `promptId`: runStream owns
  calling `subscribe()`, so a pre-computed receipt would have forced
  submission before the subscription existed, violating
  subscribe-before-submit. The legs wrap the client so `subscribe()` runs
  observer/client subscribe, then `submit()`, then hands runStream the
  subscription — the receipt lands in the gate closure before any event is
  consumed. `submitPrompt` also drops the spec's unused `context` parameter.
- **`acceptUserMessage` returns `AcceptTransition`** (`QueueTransition` +
  `id`) so the hub reads the id from where it is assigned instead of
  duplicating the `nextId` convention.
- **Pre-gate settlement feeding is per source.** Entry observations are fed
  to `UntilSettlement.observe` pre-gate (consumption tracking only — the
  catch-up must not wait for an entry that already streamed past, the steer
  caveat) while sdk observations are not (a pre-gate `result` from someone
  else's turn must not fire the condition). Post-gate both flow normally.
- **The gate-opening dequeue**: the events leg writes it (inclusive, per
  spec) and evaluates the condition on it; the observed leg returns false on
  it — a dequeue cannot end our turn.
- **Prompt tests own their harness.** prompt.test.ts adapts tail.test.ts's
  live-server pattern (adding an `onPrompt` responder and post-subscribe
  entry appends) rather than exporting the harness across test files —
  matching the existing stream-commands/tail precedent of per-file
  harnesses. Determinism note recorded on the harness: the subscribe
  response's events are pumped before the separate prompt connection's round
  trip completes, so sdk events precede any entries `onPrompt` appends.
