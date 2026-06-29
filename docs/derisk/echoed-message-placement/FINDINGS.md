# Findings: where does an echoed user message belong in the stream?

> Evidence-first report for the RISK-8 spike. Answers the README's questions from
> real captures against SDK **0.3.195** / `claude` **2.1.195**. Harness: `exp.mjs`;
> renderer: `analyze.mjs`; raw captures: `captures/`. All runs used an isolated
> `CLAUDE_CONFIG_DIR` (`/tmp/clauctl-echo-exp/claude-config`) so nothing touched
> `~/.claude`. Model: `sonnet`.

## TL;DR

`priority` **is honored** and is the whole story. A user message injected while the
agent is **busy** (mid-turn) is enqueued and consumed by priority, not by injection
order:

| `priority`      | consumed at                              | effect on running turn            | becomes |
| --------------- | ---------------------------------------- | --------------------------------- | --- |
| `now`           | next **inference** boundary (interrupt)  | **aborts** the in-flight tool, ends the turn early | its own new turn |
| `later`         | next **turn** boundary (`result`)        | none (turn runs to completion)    | its own new turn |
| `next` / *none* | next inference boundary — **removed**    | none                              | inert `queued_command` attachment, **never executed** — *unless* a `now` is also queued, in which case it runs |

- **Execution order, when several flush together: strictly `now → next → later`,
  independent of injection order.** Each distinct priority becomes its **own** turn.
- **Same-priority messages merge** (FIFO, joined by `\n`) into a **single** turn.
- **Mechanism-independent**: held-open iterable append and `Query.streamInput()`
  behave identically in every case tested.
- **Queue operations are invisible on the live SDK stream** — the daemon sees them
  only as their downstream `result`/`user`/`assistant` effects. Placement must be
  *modeled*, not observed.

## Ground truth: the session JSONL

The transcript (`<config>/projects/<cwd>/<session_id>.jsonl`) is a **parentUuid-linked
chain** — that linkage, not file order, is the canonical conversation the model saw.
Alongside the chain, `claude` writes sidecar entries that are *not* part of it:

- `queue-operation` — `{operation: "enqueue"|"dequeue"|"remove", content?}`. One
  `enqueue` per accepted message; `dequeue` when it is executed; `remove` when it is
  discarded. **This is the queue's own log** and the cleanest signal of what happened.
- `last-prompt` — `{leafUuid}`, the tip of the chain at the end.
- `attachment` of `{type: "queued_command", commandMode: "prompt", prompt}` — a
  message that was enqueued but **not executed**; parented into the chain at the
  inference boundary where it was removed.

An **executed** injected message appears as a real `user` text entry, parented to the
chain leaf at the instant it was dequeued. A **dropped** `next`/none message appears
only as the inert `queued_command` attachment, with no assistant response.

## Per-question answers

**Q1 — Is `priority` honored?** Yes, decisively. `c_mixed` injected
`[ALPHA:later, BRAVO:now, CHARLIE:next]` in that order and they executed
`BRAVO → CHARLIE → ALPHA`. `c_perm` injected the same set in a different order
(`[next, later, now]`) and executed identically `BRAVO → CHARLIE → ALPHA`. Effective
order tracks **priority**, not injection order.

**Q2 — What do `now`/`next`/`later` do?** Neither README hypothesis is right as
stated. The real model:
- `now` = **interrupt**: abort the running tool, end the current turn, run this
  message as the next turn.
- `later` = **follow-up**: let the turn finish, then run this message as a new turn.
- `next` = **conditional steer**: only runs if a `now` is co-queued (forcing an
  inference-boundary flush); otherwise it is **dropped**. It is *not* a general
  "insert at next inference boundary" primitive.

**Q3 — Which boundary?** Both, by priority. `now` is consumed at an **inference**
boundary (`message_delta` `stop_reason=tool_use` → its `tool_result`). `later` is
consumed at the **turn** boundary (`result`). A non-`now` queue does **not** flush at
inference boundaries — `a_later` and `g_next_later` both ran all three tools to
completion; only the `now` scenarios stopped after one tool.

**Q4 — Flush count.** **Flush-all of the same priority, merged into one turn.**
`b_now2` (two `now`) and `b_later2` (two `later`) each produced a *single* user turn
containing both prompts joined by `\n` (`b_later2`'s model even complained the two
merged instructions contradicted each other). Across *different* priorities, each
bucket is its own turn. Within a bucket the merge is FIFO: `b_now2` →
`"ALPHA\nBRAVO"`, `b_now2_rev` → `"BRAVO\nALPHA"`.

**Q5 — Does `now` interrupt?** Yes, hard. The in-flight tool is **aborted**: in
`a_now` the `sleep 4` tool returned `<error>Command was aborted before
completion</error>` after ~1.4 s (vs ~5.6 s when it completes normally), the turn
ended immediately, and tools 2–3 never ran. Every `now` scenario ran exactly **one**
tool and never reached `DONE`; every non-`now` scenario ran **three** and reached
`DONE`. Note: the aborted turn still emits a normal `result` `subtype:"success"`
(`is_error:false`) — an interrupt is **not** distinguishable from normal completion by
the result alone.

**Q6 — Injection-mechanism dependence.** None. `e_next_stream` / `e_later_stream` /
`e_mixed_stream` (via `streamInput()`) reproduced `a_next` / `a_later` / `c_mixed`
(via iterable append) exactly — same result counts, same `BRAVO → CHARLIE → ALPHA`
order, same drop of `next`. clauctl may pick either mechanism on RISK-1 grounds
without affecting echo placement.

## The placement rule clauctl should implement

The daemon knows what it injected and with what priority, but **cannot see the queue
operations live**. It must predict the JSONL position from priority + observed
boundaries:

1. **`now`** — on the next observed inference boundary (a `stream_event`
   `message_delta` with `stop_reason=tool_use`, followed by its `tool_result`),
   place the echo as a **new turn** parented to that `tool_result`. Expect the current
   turn to be cut short: the in-flight tool's `tool_result` will be an abort error and
   a `result` arrives early. Multiple `now`s injected before that boundary → **one**
   echo, contents joined by `\n` in injection order.
2. **`later`** — on the next `result`, place the echo as a **new turn** parented to
   that turn's final assistant message. Multiple `later`s → one merged echo.
3. **`next` / *none*** — **do not** emit an executed echo. While the agent is busy,
   such a message is silently recorded as an inert `queued_command` and never runs
   (confirmed it does *not* merge into a subsequent real turn — `f_next`/`f_none`).
   Treat it as **unsupported while busy**: reject it, warn, or remap to `now`/`later`.
   (When the agent is **idle**, an ordinary default-priority message is a normal turn —
   the drop is specific to injecting mid-turn.)
4. **Combined flush ordering** — emit `now`-echo, then `next`-echo (only if a `now`
   rescued it), then `later`-echo; each distinct priority is its own echo/turn.

## Is muninn's logic correct?

**No.** muninn's rule — *flush-all pending echoes at every `tool_use` boundary,
flush-one at each `result`* — is wrong on both halves:

1. **Not every `tool_use` boundary flushes.** Only a queued **`now`** triggers an
   inference-boundary flush (and it does so by aborting). A busy turn with no `now`
   sails through every `tool_use` boundary without flushing; default/`next` messages
   sitting in the queue are *dropped* there, not flushed.
2. **`result` is not flush-one.** The entire `later` bucket flushes at the turn
   boundary, **merged into a single turn** (`b_later2`), not one-at-a-time.

The correct model is **priority-bucketed**: `now`→inference-boundary interrupt,
`later`→turn boundary, each bucket merged FIFO; `next` is a conditional steer gated on
a co-queued `now`.

## Surprises affecting `QueueDepthChanged` / idle-model design

- **Interrupts are invisible in the result.** An aborted (`now`) turn ends with
  `result subtype:"success"`. Idle/queue tracking can't infer the interrupt from the
  stream; it must remember it injected a `now`.
- **Silent drops leak queue depth.** A `next`/default message injected while busy is
  `enqueue`d then `remove`d with **no** `result` and **no** output. Because the
  `queue-operation` `remove` is **not** on the live stream, a depth counter that
  increments on inject would never decrement. The daemon must model this drop itself
  (or forbid the case). This is the strongest argument for clauctl restricting queued
  turns to `now`/`later` and never default/`next` while busy.
- **`queued_command` attachments accumulate** in the transcript permanently and are
  never executed — relevant if anything reconstructs conversation state from the JSONL.

## Scenario → outcome map

`now` cases interrupt (1 tool, no DONE); others complete (3 tools, DONE). "exec" =
executed as a real turn; "inert" = recorded as `queued_command`, never run.

| scenario      | injected (priority)                    | result count | outcome |
| ------------- | -------------------------------------- | ------------ | --- |
| `exp0`        | none                                   | 1 | baseline: 3 sequential `tool_use` boundaries → DONE |
| `a_none`      | ALPHA(none)                            | 1 | ALPHA **inert**; turn completes |
| `a_next`      | ALPHA(next)                            | 1 | ALPHA **inert**; turn completes |
| `a_now`       | ALPHA(now)                             | 2 | tool-1 **aborted**; ALPHA exec as turn 2 |
| `a_later`     | ALPHA(later)                           | 2 | turn completes; ALPHA exec after |
| `b_now2`      | ALPHA(now), BRAVO(now)                 | 2 | merged `"ALPHA\nBRAVO"`, one turn |
| `b_now2_rev`  | BRAVO(now), ALPHA(now)                 | 2 | merged `"BRAVO\nALPHA"` (FIFO) |
| `b_later2`    | ALPHA(later), BRAVO(later)             | 2 | merged into one turn (model flags contradiction) |
| `c_mixed`     | ALPHA(later), BRAVO(now), CHARLIE(next)| 4 | exec `BRAVO → CHARLIE → ALPHA` |
| `c_mixed2`    | (repro of c_mixed)                     | 4 | identical → **deterministic** |
| `c_perm`      | CHARLIE(next), ALPHA(later), BRAVO(now)| 4 | exec `BRAVO → CHARLIE → ALPHA` (injection order irrelevant) |
| `g_now_next`  | BRAVO(now), CHARLIE(next)              | 3 | exec `BRAVO → CHARLIE` (now rescues next) |
| `g_next_later`| CHARLIE(next), ALPHA(later)            | 2 | CHARLIE **inert**; ALPHA exec (later does not rescue next) |
| `g_now_later` | BRAVO(now), ALPHA(later)               | 3 | exec `BRAVO → ALPHA` |
| `f_next`      | ALPHA(next) + real follow-up turn      | 2 | ALPHA **inert** even though a real turn followed |
| `f_none`      | ALPHA(none) + real follow-up turn      | 2 | ALPHA **inert** even though a real turn followed |
| `e_*_stream`  | next / later / mixed via `streamInput` | 1/2/4 | identical to iterable equivalents |

## Reproduce

```bash
cd docs/derisk/echoed-message-placement
export CLAUDE_CONFIG_DIR=/tmp/clauctl-echo-exp/claude-config   # isolated; needs .credentials.json
node exp.mjs <scenario>      # writes captures/<scenario>-events.json + -session-*.jsonl
node analyze.mjs <scenario>  # renders live timeline + canonical chain
```
