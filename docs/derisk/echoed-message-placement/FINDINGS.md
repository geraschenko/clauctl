# Findings: where does an echoed user message belong in the stream?

> Evidence-first report for the RISK-8 spike. Answers the README's questions from
> real captures against SDK **0.3.195** / `claude` **2.1.195**, model `sonnet`.
> Harness: `exp.mjs`; renderers: `analyze.mjs` / `summarize.mjs`; raw captures:
> `captures/`. All runs used an isolated `CLAUDE_CONFIG_DIR`
> (`/tmp/clauctl-echo-exp/claude-config`) so nothing touched `~/.claude`. A round-2
> pass (driven by an adversarial review) corrected two overclaims and added the
> mechanism for `next`; see **Reviewer round 2** below.

## TL;DR

`priority` governs placement. A user message injected while the agent is **busy**
(mid-turn) is enqueued and consumed by priority, _not_ injection order:

| `priority`      | when it runs                                                                                                                                                                                  | effect on the running turn                          | becomes                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `now`           | **aborts** the current inference at once, then runs as the next turn                                                                                                                          | hard interrupt (in-flight tool/inference cancelled) | its own new turn                                                                         |
| `later`         | after the current turn's `result`                                                                                                                                                             | none (turn completes)                               | its own new turn                                                                         |
| `next` / _none_ | **only if the turn ends before crossing a tool-result handoff** (no-tool turn, or a co-queued `now` ends the turn at that boundary); otherwise **discarded** at the first tool-result handoff | none                                                | a real turn _iff_ it survived, else an inert `queued_command` attachment, never executed |

The single rule that explains `next`/none: **a `next`/default message is dropped at
the first tool→result handoff the turn continues across.** It survives only when the
turn _ends_ at (or before) that point — so it executes after a tool-less turn
(`x_next_notool`), or when a co-queued `now` aborts the turn at the same boundary
(`g_now_next`). It is **not** specially "rescued" by `now`: inject `now` one boundary
_later_ and the `next` is already gone (`h_next_then_now`).

- **Execution order when several survive: strictly `now → next → later`, independent
  of injection order** (`c_mixed` vs `c_perm`). Each distinct priority is its **own**
  turn; they drain sequentially across successive turn boundaries, not in one flush.
- **Same-priority _executing_ messages merge** (FIFO, joined by `\n`) into one turn
  (`now`: `b_now2`; `later`: `b_later2`). Same-priority `next`/none don't merge —
  they each drop individually (`b_next2`, `b_none2`).
- **Mechanism-independent**: held-open iterable append and `Query.streamInput()`
  behave identically across `now`, `later`, `next`, merge, and mixed cases.
- **Queue operations are invisible on the live SDK stream** — the daemon sees them
  only as downstream `result`/`user`/`assistant` effects. Placement must be
  _modeled_, not observed.
- **An interrupt's `result` subtype depends on what was cancelled**: aborting a
  _tool_ yields `subtype:"success"` (the abort error rides in the `tool_result`,
  `a_now`); aborting a _text inference_ yields `subtype:"error_during_execution"`
  (`x_now_notool`). Either way the `now` message then runs.

## Ground truth: the session JSONL

The transcript (`<config>/projects/<cwd>/<session_id>.jsonl`) is a **parentUuid-linked
chain** — that linkage, not file order, is the canonical conversation the model saw.
Alongside the chain, `claude` writes sidecar entries that are _not_ part of it:

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

- `now` = **interrupt**: abort the in-flight inference immediately (cancel the running
  tool or text generation), end the current turn, run this message as the next turn.
- `later` = **follow-up**: let the turn finish, then run this message as a new turn.
- `next` / default = **fragile steer**: lives in the queue but is **discarded at the
  first tool→result handoff the turn continues across**. It runs as a turn only if the
  turn ends before any such handoff — i.e. a **tool-less** turn (`x_next_notool` and
  `x_none_notool` both run it, indistinguishable from `x_later_notool`) or a co-queued
  **`now`** that aborts the turn at that boundary (`g_now_next`). See **Reviewer round 2** for the disproof of
  the earlier "`now` rescues `next`" framing.

**Q3 — Which boundary?** By priority. `now` acts at the **inference** boundary
(`message_delta` `stop_reason=tool_use` → its `tool_result`, or the in-flight text
inference) by **aborting** it. `later` acts at the **turn** boundary (`result`). A
non-`now` queue does **not** flush at inference boundaries: `a_later` and
`g_next_later` ran all three tools to completion; only `now` scenarios stopped before
completing all three tools. The tool→result handoff is also where a `next`/default
message is _removed_.

**Q4 — Flush count.** **Flush-all of the same executing priority, merged into one
turn.** `b_now2` (two `now`) and `b_later2` (two `later`) each produced a _single_
user turn containing both prompts joined by `\n` (`b_later2`'s model even complained
the two merged instructions contradicted each other). Across _different_ priorities
each bucket is its own turn, draining over successive turn boundaries (not one flush).
Within a bucket the merge is FIFO: `b_now2` → `"ALPHA\nBRAVO"`, `b_now2_rev` →
`"BRAVO\nALPHA"`. Same-priority `next`/none do **not** merge — `b_next2` and `b_none2`
each dropped _both_ messages as separate inert attachments.

**Q5 — Does `now` interrupt?** Yes, hard, and at whichever boundary it lands.
`a_now` aborted `sleep 4` after ~1.4 s with `<error>Command was aborted before
completion</error>` (vs ~5.6 s to complete), ending the turn before tools 2–3.
`h_now_b1` (now injected during the _second_ tool) aborted tool-2 — so the interrupt
hits **whichever inference is in flight**, and the tool count before the interrupt
just depends on the injection boundary (1 for `a_now`, 2 for `h_now_b1`/
`h_later_then_now`, 0 for `x_now_notool`). The interrupted turn never reaches `DONE`;
every non-`now` scenario ran all **three** tools and reached `DONE`.
**Correction (round 2):** the interrupted turn's `result` subtype depends on what was
aborted — a tool abort still reports `subtype:"success"` (`a_now`), but aborting a
_text_ inference reports `subtype:"error_during_execution"` (`x_now_notool`). So an
interrupt is sometimes, but not always, invisible in the result.

**Q6 — Injection-mechanism dependence.** None. Via `streamInput()`: `e_next_stream` /
`e_later_stream` / `e_mixed_stream` reproduced `a_next` / `a_later` / `c_mixed`, and
round-2 additions `e_now_stream` / `e_now2_stream` reproduced `a_now` / `b_now2`
(interrupt and same-priority merge) — identical result counts, ordering, drops, and
merges. clauctl may pick either mechanism on RISK-1 grounds without affecting echo
placement.

## The placement rule clauctl should implement

The daemon knows what it injected and with what priority, but **cannot see the queue
operations live**. It must predict the JSONL position from priority + observed
boundaries:

1. **`now`** — the current turn is interrupted; on the next observed `tool_result`
   (an abort error) or the early `result`, place the echo as a **new turn** parented
   to the chain leaf at that point. Multiple `now`s injected before that boundary →
   **one** echo, contents joined by `\n` in injection order.
2. **`later`** — at a turn boundary, but **only after every higher-priority surviving
   bucket has drained**, not necessarily at the _next_ `result`. With a co-queued
   `now`, the order is `now`-turn then `later`-turn (`g_now_later`, `h_later_then_now`,
   `c_mixed`); `later` does **not** fire at the interrupted turn's early `result`.
   `later` is **durable** — it survives tool→result handoffs that would drop a `next`
   (`h_later_then_now`: `later` injected at boundary 0 was still queued at boundary 1).
   Place each `later` echo as a new turn after the higher-priority echoes; multiple
   `later`s merge into one.
3. **`next` / _none_ while busy** — **do not** emit an executed echo unless the busy
   turn is **tool-less** or a `now` is co-queued. In the common (tool-using) case the
   message is silently recorded as an inert `queued_command` and never runs — it does
   _not_ merge into a subsequent real turn (`f_next`/`f_none`). Safest: treat
   default/`next`-while-busy as **unsupported**, and reject/warn/remap to `now`/`later`.
   (When the agent is **idle**, an ordinary default-priority message is a normal turn —
   the drop is specific to injecting mid-turn.)
4. **Combined ordering** — when more than one survives, they execute as separate turns
   in priority order `now → next → later`; emit the echoes in that order.

## Is muninn's logic correct?

**No.** muninn's rule — _flush-all pending echoes at every `tool_use` boundary,
flush-one at each `result`_ — is wrong on both halves:

1. **Not every `tool_use` boundary flushes.** Only a queued **`now`** acts at an
   inference boundary, and it does so by **aborting**. A busy turn with no `now` sails
   through every `tool_use` boundary without flushing; default/`next` messages sitting
   in the queue are _dropped_ at the tool→result handoff, not flushed.
2. **`result` is not flush-one.** The entire `later` bucket flushes at the turn
   boundary, **merged into a single turn** (`b_later2`), not one-at-a-time.

The correct model is **priority-bucketed**: `now`→inference-boundary interrupt,
`later`→turn boundary, each executing bucket merged FIFO; `next`/default is a fragile
steer that survives only a tool-less turn or a co-queued `now`.

## Surprises affecting `QueueDepthChanged` / idle-model design

- **Interrupts are sometimes invisible in the result.** A `now` that aborts a _tool_
  ends with `result subtype:"success"` (`a_now`) — indistinguishable from normal
  completion; but a `now` that aborts a _text_ inference ends with
  `subtype:"error_during_execution"` (`x_now_notool`). Idle/queue tracking can't rely
  on the subtype to detect an interrupt in general; it must remember it injected a
  `now`.
- **Silent drops leak queue depth.** A `next`/default message injected while busy is
  `enqueue`d then `remove`d with **no** `result` and **no** output. Because the
  `queue-operation` `remove` is **not** on the live stream, a depth counter that
  increments on inject would never decrement. The daemon must model this drop itself
  (or forbid the case). This is the strongest argument for clauctl restricting queued
  turns to `now`/`later` and never default/`next` while busy.
- **`queued_command` attachments accumulate** in the transcript permanently and are
  never executed — relevant if anything reconstructs conversation state from the JSONL.

## Scenario → outcome map

`now` cases interrupt the in-flight inference (tool count before interrupt = injection
boundary; never reach DONE); others complete (3 tools, DONE). "exec" = executed as a
real turn; "inert" = recorded as `queued_command`, never run.

| scenario           | injected (priority)                         | result count | outcome                                                                                                               |
| ------------------ | ------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `exp0`             | none                                        | 1            | baseline: 3 sequential `tool_use` boundaries → DONE                                                                   |
| `a_none`           | ALPHA(none)                                 | 1            | ALPHA **inert**; turn completes                                                                                       |
| `a_next`           | ALPHA(next)                                 | 1            | ALPHA **inert**; turn completes                                                                                       |
| `a_now`            | ALPHA(now)                                  | 2            | tool-1 **aborted**; ALPHA exec as turn 2                                                                              |
| `a_later`          | ALPHA(later)                                | 2            | turn completes; ALPHA exec after                                                                                      |
| `b_now2`           | ALPHA(now), BRAVO(now)                      | 2            | merged `"ALPHA\nBRAVO"`, one turn                                                                                     |
| `b_now2_rev`       | BRAVO(now), ALPHA(now)                      | 2            | merged `"BRAVO\nALPHA"` (FIFO)                                                                                        |
| `b_later2`         | ALPHA(later), BRAVO(later)                  | 2            | merged into one turn (model flags contradiction)                                                                      |
| `c_mixed`          | ALPHA(later), BRAVO(now), CHARLIE(next)     | 4            | exec `BRAVO → CHARLIE → ALPHA`                                                                                        |
| `c_mixed2`         | (repro of c_mixed)                          | 4            | identical → **deterministic**                                                                                         |
| `c_perm`           | CHARLIE(next), ALPHA(later), BRAVO(now)     | 4            | exec `BRAVO → CHARLIE → ALPHA` (injection order irrelevant)                                                           |
| `g_now_next`       | BRAVO(now), CHARLIE(next) (both @b0)        | 3            | exec `BRAVO → CHARLIE` — `now` ends the turn at b0, so `next` survives                                                |
| `g_next_later`     | CHARLIE(next), ALPHA(later)                 | 2            | CHARLIE **inert**; ALPHA exec (later does not save next)                                                              |
| `g_now_later`      | BRAVO(now), ALPHA(later)                    | 3            | exec `BRAVO → ALPHA`                                                                                                  |
| `f_next`           | ALPHA(next) + real follow-up turn           | 2            | ALPHA **inert** even though a real turn followed                                                                      |
| `f_none`           | ALPHA(none) + real follow-up turn           | 2            | ALPHA **inert** even though a real turn followed                                                                      |
| `e_*_stream`       | next/later/mixed/now/now² via `streamInput` | —            | identical to iterable equivalents (incl. interrupt + merge)                                                           |
| `b_next2`          | ALPHA(next), BRAVO(next)                    | 1            | **both inert** (no merge)                                                                                             |
| `b_none2`          | ALPHA(none), BRAVO(none)                    | 1            | **both inert** (no merge)                                                                                             |
| `h_next_then_now`  | CHARLIE(next)@b0, BRAVO(now)@b1             | 2            | CHARLIE **inert** (dropped at tool-1 handoff); only BRAVO exec — **`now` does not rescue `next`**                     |
| `h_now_b1`         | BRAVO(now)@b1                               | 2            | tool-2 aborted; interrupt generalizes past first boundary                                                             |
| `h_later_then_now` | ALPHA(later)@b0, BRAVO(now)@b1              | 3            | `later` **survives** tool-1 handoff; `now` aborts tool-2; exec `BRAVO → ALPHA` — `later` durable + drains after `now` |
| `x_next_notool`    | ALPHA(next), **no-tool** turn               | 2            | essay completes (40/40); ALPHA exec after — `next` survives a tool-less turn                                          |
| `x_none_notool`    | ALPHA(none), no-tool turn                   | 2            | identical to `x_next_notool` — default ≡ next here                                                                    |
| `x_later_notool`   | ALPHA(later), no-tool turn                  | 2            | identical to `x_next_notool`                                                                                          |
| `x_now_notool`     | ALPHA(now), no-tool turn                    | 2            | essay **never produced**; first result `error_during_execution`; ALPHA exec                                           |

## Reviewer round 2 (what an adversarial review changed)

A fresh-context reviewer (read-only) challenged the v1 conclusions. Three corrections
resulted, each backed by a new experiment:

1. **"`now` rescues `next`" was a surface description, not a mechanism.** v1 said a
   co-queued `now` makes `next` run. `h_next_then_now` disproves the causal framing:
   inject `next` at boundary 0 and `now` one boundary _later_, and the `next` is
   already removed (inert) before `now` fires — only the `now` runs. The real rule:
   `next`/default is dropped at the first tool→result handoff the turn crosses; it
   survives only if the turn _ends_ there. `now`-co-queued-at-the-same-boundary
   (`g_now_next`) and tool-less turns (`x_next_notool`) are the two ways that happens.
2. **"Interrupts always report `success`" was false in general.** Only tool aborts do
   (`a_now`); a text-inference abort reports `error_during_execution` (`x_now_notool`).
3. **Determinism was over-claimed from a single repeat.** Re-ran the load-bearing
   scenarios; results below.

Also added to close coverage gaps the reviewer flagged: same-priority `next`/none
(`b_next2`/`b_none2` — both drop, no merge), `now`/merge via `streamInput`
(`e_now_stream`/`e_now2_stream`), and interrupt at a non-first boundary (`h_now_b1`).

Open scope caveats (untested, stated as such): only `sonnet` / SDK 0.3.195; only Bash
and tool-less turn shapes; `next`/none always injected at the first boundary except
the staged `h_*`; idle-time (not mid-turn) default messages are normal turns, not
tested exhaustively here.

### Determinism

Each load-bearing scenario was run **5×** total (original + 4 repeats); every repeat
reproduced the same outcome:

- `a_now` 5/5 → interrupt (1 tool), `ALPHA` executes.
- `a_next` 5/5 → `ALPHA` inert, turn completes (3 tools).
- `c_mixed` 5/5 → exec order `BRAVO → CHARLIE → ALPHA`.
- `h_next_then_now` 5/5 → `CHARLIE` inert, only `BRAVO` executes.

(Raw: `captures/`, plus the repeat log referenced in the harness. The queue mechanics
are CLI behavior, not model sampling, consistent with this stability.)

## Reproduce

```bash
cd docs/derisk/echoed-message-placement
export CLAUDE_CONFIG_DIR=/tmp/clauctl-echo-exp/claude-config   # isolated; needs .credentials.json
node exp.mjs <scenario>        # writes captures/<scenario>-events.json + -session-*.jsonl
node analyze.mjs <scenario>    # renders live timeline + canonical chain
node summarize.mjs <scenario>  # one-line outcome (exec/inert/tools/interrupt)
```
