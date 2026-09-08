# Findings: where does an echoed user message belong in the stream?

> Evidence-first report for the RISK-8 spike. Answers the README's questions from
> real captures against SDK **0.3.195** / `claude` **2.1.195**, model `sonnet`.
> Harness: `exp.mjs`; renderers: `analyze.mjs` / `summarize.mjs`; raw captures:
> `captures/`. All runs used an isolated `CLAUDE_CONFIG_DIR`
> (`/tmp/clauctl-echo-exp/claude-config`) so nothing touched `~/.claude`. A round-2
> pass (driven by an adversarial review) corrected two overclaims and added the
> mechanism for `next`; see **Reviewer round 2** below. A round-3 pass overturned the
> central "`next`/default is discarded" claim: the message is **not** discarded — it is
> delivered to the model as a `<system-reminder>` inside the pending tool result, just
> never executed as its own turn. See **Round 3** below.

## TL;DR

`priority` governs placement. A user message injected while the agent is **busy**
(mid-turn) is enqueued and consumed by priority, _not_ injection order:

| `priority`      | when it runs                                                                                                                                                                                                                                                     | effect on the running turn                          | becomes                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `now`           | **aborts** the current inference at once, then runs as the next turn                                                                                                                                                                                             | hard interrupt (in-flight tool/inference cancelled) | its own new turn                                                                                                 |
| `later`         | after the current turn's `result`                                                                                                                                                                                                                                | none (turn completes)                               | its own new turn                                                                                                 |
| `next` / _none_ | **as its own turn only if the turn ends before crossing a tool-result handoff** (no-tool turn, or a co-queued `now` ends the turn at that boundary); otherwise **demoted** at the first tool-result handoff to an inline `<system-reminder>` in that tool result | steers the running turn (model's discretion)        | a real turn _iff_ it survived, else one-shot in-context text + a `queued_command` attachment; never its own turn |

The single rule that explains `next`/none: **a `next`/default message is removed from
the execution queue at the first tool→result handoff the turn continues across, and
delivered instead as a `<system-reminder>` appended to that tool result.** The rendered
wrapper (quoted verbatim by the model in `a_next_report`) is: _"The user sent a new
message while you were working: `<prompt>` IMPORTANT: After completing your current
task, you MUST address the user's message above. Do not ignore it."_ Whether the model
acts on it is the model's decision — it is low-authority steering, not a turn. It
executes as its own turn only when the turn _ends_ at (or before) that point — after a
tool-less turn (`x_next_notool`), or when a co-queued `now` aborts the turn at the same
boundary (`g_now_next`). It is **not** specially "rescued" by `now`: inject `now` one
boundary _later_ and the `next` has already been demoted (`h_next_then_now`).

- **Execution order when several survive: strictly `now → next → later`, independent
  of injection order** (`c_mixed` vs `c_perm`). Each distinct priority is its **own**
  turn; they drain sequentially across successive turn boundaries, not in one flush.
- **Same-priority _executing_ messages merge** (FIFO, joined by `\n`) into one turn
  (`now`: `b_now2`; `later`: `b_later2`). Same-priority `next`/none don't merge into
  a turn — they are each demoted, and **both** are delivered at the same handoff as
  **separate, individually-wrapped reminders**, back-to-back in FIFO injection order
  (`b_next2`/`b_none2` token accounting; direct witness `b_next2_report`, 2/2).
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
  `enqueue` per accepted message; `dequeue` when it is executed as a turn; `remove`
  when it is demoted to an inline reminder. **This is the queue's own log** and the
  cleanest signal of what happened — but `remove` means "left the queue", not
  "discarded" (Round 3).
- `last-prompt` — `{leafUuid}`, the tip of the chain at the end.
- `attachment` of `{type: "queued_command", commandMode: "prompt", prompt}` — a
  message that was enqueued but **not executed**; parented into the chain at the
  inference boundary where it was removed.

An **executed** injected message appears as a real `user` text entry, parented to the
chain leaf at the instant it was dequeued. A **demoted** `next`/none message appears
only as the `queued_command` attachment, with no assistant response of its own.
**Caution:** the attachment is _not_ inert transcript metadata — at request-build time
the CLI materializes it into the model's context as a `<system-reminder>` on the
adjacent tool result. Neither the JSONL `user` entry nor the live-stream `tool_result`
shows this rendered text; it exists only in the actual API request (confirmed by the
model quoting it in `a_next_report`, and by per-inference cache-token deltas).

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
- `next` / default = **in-turn steer**: lives in the queue until the **first
  tool→result handoff the turn continues across**, where it is removed from the queue
  and delivered as a `<system-reminder>` inside that tool result — visible to the
  model once, honored at the model's discretion, never a turn of its own. It runs as
  a real turn only if the turn ends before any such handoff — i.e. a **tool-less**
  turn (`x_next_notool` and `x_none_notool` both run it, indistinguishable from
  `x_later_notool`) or a co-queued **`now`** that aborts the turn at that boundary
  (`g_now_next`). See **Reviewer round 2** for the disproof of the earlier "`now`
  rescues `next`" framing, and **Round 3** for the disproof of "discarded".

**Q3 — Which boundary?** By priority. `now` acts at the **inference** boundary
(`message_delta` `stop_reason=tool_use` → its `tool_result`, or the in-flight text
inference) by **aborting** it. `later` acts at the **turn** boundary (`result`). A
non-`now` queue does **not** flush at inference boundaries: `a_later` and
`g_next_later` ran all three tools to completion; only `now` scenarios stopped before
completing all three tools. The tool→result handoff is also where a `next`/default
message is removed from the queue and demoted to an inline reminder.

**Q4 — Flush count.** **Flush-all of the same executing priority, merged into one
turn.** `b_now2` (two `now`) and `b_later2` (two `later`) each produced a _single_
user turn containing both prompts joined by `\n` (`b_later2`'s model even complained
the two merged instructions contradicted each other). Across _different_ priorities
each bucket is its own turn, draining over successive turn boundaries (not one flush).
Within a bucket the merge is FIFO: `b_now2` → `"ALPHA\nBRAVO"`, `b_now2_rev` →
`"BRAVO\nALPHA"`. Same-priority `next`/none do **not** merge into a turn — `b_next2`
and `b_none2` each demoted _both_ messages, delivering both inline at the same
handoff (post-handoff inference created ~280 cache tokens vs the 159 baseline —
a two-reminder-sized bump). `b_next2_report` (2/2) pins the shape: the model quotes
them as **two back-to-back, individually-wrapped reminder messages** in the _same_
tool result (each with its own full "The user sent a new message…" wrapper), in
injection order — not one merged block, and not spread across boundaries.

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
   `later` is **durable** — it survives tool→result handoffs that would demote a `next`
   (`h_later_then_now`: `later` injected at boundary 0 was still queued at boundary 1).
   Place each `later` echo as a new turn after the higher-priority echoes; multiple
   `later`s merge into one.
3. **`next` / _none_ while busy** — **never** emit a regular executed echo unless the
   busy turn is **tool-less** or a `now` is co-queued. In the common (tool-using) case
   the message never runs as a turn — no `result`, no assistant reply of its own; it
   does _not_ merge into a subsequent real turn (`f_next`/`f_none`). But it is **not
   lost**: the CLI delivers it once as a `<system-reminder>` on the tool result at the
   first handoff, and the model may act on it mid-turn. Since that delivery is
   invisible on the live stream, the daemon must synthesize a **distinct steer-type
   echo** (typed to say "injected as a system-reminder into a tool result", not a
   user turn) so observers know the message reached the model. Anchor: demotion
   happens at a tool→result handoff the turn **continues across**, so seeing a
   `tool_result` is not by itself decisive (`g_now_next`: the aborted tool's
   `tool_result` precedes the `result`, yet the `next` executed). The fork is decided
   by what follows the first `tool_result` observed after acceptance: **assistant
   activity** (the turn continued ⇒ demoted; emit the steer echo attached to that
   tool result; multiple pending `next`/none all attach there, individually, in
   injection order) vs the turn's **`result`** (the turn ended at that boundary —
   tool-less remainder or co-queued `now` ⇒ the message executes; emit a normal echo
   as its own turn). (When the agent is **idle**, an ordinary default-priority
   message is a normal turn — the demotion is specific to injecting mid-turn.)
4. **Combined ordering** — when more than one survives, they execute as separate turns
   in priority order `now → next → later`; emit the echoes in that order.

## Is muninn's logic correct?

**No.** muninn's rule — _flush-all pending echoes at every `tool_use` boundary,
flush-one at each `result`_ — is wrong on both halves:

1. **Not every `tool_use` boundary flushes a turn.** Only a queued **`now`** acts at
   an inference boundary, and it does so by **aborting**. A busy turn with no `now`
   sails through every `tool_use` boundary without flushing; default/`next` messages
   sitting in the queue are demoted at the tool→result handoff — their _content_ is
   delivered inline there (which is closer to muninn's intuition than v1/v2 of this
   report credited), but no user turn is created, so an echo emitted there would
   misrepresent the transcript.
2. **`result` is not flush-one.** The entire `later` bucket flushes at the turn
   boundary, **merged into a single turn** (`b_later2`), not one-at-a-time.

The correct model is **priority-bucketed**: `now`→inference-boundary interrupt,
`later`→turn boundary, each executing bucket merged FIFO; `next`/default is an
in-turn steer, delivered inline at the first handoff, that becomes a real turn only
after a tool-less turn or with a co-queued `now`.

## Surprises affecting `QueueDepthChanged` / idle-model design

- **Interrupts are sometimes invisible in the result.** A `now` that aborts a _tool_
  ends with `result subtype:"success"` (`a_now`) — indistinguishable from normal
  completion; but a `now` that aborts a _text_ inference ends with
  `subtype:"error_during_execution"` (`x_now_notool`). Idle/queue tracking can't rely
  on the subtype to detect an interrupt in general; it must remember it injected a
  `now`.
- **Silent demotions leak queue depth.** A `next`/default message injected while busy
  is `enqueue`d then `remove`d with **no** `result` and **no** turn of its own. The
  `queue-operation` `remove` is **not** on the live stream, and neither is the
  rendered `<system-reminder>` (the live `tool_result` shows only the raw tool
  output), so a depth counter that increments on inject would never decrement. The
  daemon must model this demotion itself: never count a demoted message in
  `queueDepth`, and synthesize its steer-type echo from the daemon's own bookkeeping
  (placement rule §3), since no stream event will ever announce it.
- **`queued_command` attachments accumulate** in the transcript permanently and are
  never executed as turns — but each **was shown to the model once**, rendered as a
  `<system-reminder>` at the boundary where it sits. Anything reconstructing
  conversation state from the JSONL must decide whether to surface them; ignoring
  them hides context the model actually saw (and may have acted on).

## Scenario → outcome map

`now` cases interrupt the in-flight inference (tool count before interrupt = injection
boundary; never reach DONE); others complete (3 tools, DONE). "exec" = executed as a
real turn; "steer" = removed from the queue at a tool→result handoff, delivered once
inline as a `<system-reminder>` on that tool result (plus a `queued_command`
transcript attachment), never run as its own turn. (Rows below predating Round 3 said
"inert" here; the queue/turn observations stand, only the delivery interpretation
changed.)

| scenario           | injected (priority)                         | result count | outcome                                                                                                               |
| ------------------ | ------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `exp0`             | none                                        | 1            | baseline: 3 sequential `tool_use` boundaries → DONE                                                                   |
| `a_none`           | ALPHA(none)                                 | 1            | ALPHA **steer**; turn completes                                                                                       |
| `a_next`           | ALPHA(next)                                 | 1            | ALPHA **steer**; turn completes                                                                                       |
| `a_next_report`    | ALPHA(next), report-everything busy prompt  | 1            | ALPHA **steer** — model quotes the delivered `<system-reminder>` verbatim in its reply (delivery witness, Round 3)    |
| `a_now`            | ALPHA(now)                                  | 2            | tool-1 **aborted**; ALPHA exec as turn 2                                                                              |
| `a_later`          | ALPHA(later)                                | 2            | turn completes; ALPHA exec after                                                                                      |
| `b_now2`           | ALPHA(now), BRAVO(now)                      | 2            | merged `"ALPHA\nBRAVO"`, one turn                                                                                     |
| `b_now2_rev`       | BRAVO(now), ALPHA(now)                      | 2            | merged `"BRAVO\nALPHA"` (FIFO)                                                                                        |
| `b_later2`         | ALPHA(later), BRAVO(later)                  | 2            | merged into one turn (model flags contradiction)                                                                      |
| `c_mixed`          | ALPHA(later), BRAVO(now), CHARLIE(next)     | 4            | exec `BRAVO → CHARLIE → ALPHA`                                                                                        |
| `c_mixed2`         | (repro of c_mixed)                          | 4            | identical → **deterministic**                                                                                         |
| `c_perm`           | CHARLIE(next), ALPHA(later), BRAVO(now)     | 4            | exec `BRAVO → CHARLIE → ALPHA` (injection order irrelevant)                                                           |
| `g_now_next`       | BRAVO(now), CHARLIE(next) (both @b0)        | 3            | exec `BRAVO → CHARLIE` — `now` ends the turn at b0, so `next` survives                                                |
| `g_next_later`     | CHARLIE(next), ALPHA(later)                 | 2            | CHARLIE **steer**; ALPHA exec (later does not save next)                                                              |
| `g_now_later`      | BRAVO(now), ALPHA(later)                    | 3            | exec `BRAVO → ALPHA`                                                                                                  |
| `f_next`           | ALPHA(next) + real follow-up turn           | 2            | ALPHA **steer**; not re-executed by the real follow-up turn                                                           |
| `f_none`           | ALPHA(none) + real follow-up turn           | 2            | ALPHA **steer**; not re-executed by the real follow-up turn                                                           |
| `e_*_stream`       | next/later/mixed/now/now² via `streamInput` | —            | identical to iterable equivalents (incl. interrupt + merge)                                                           |
| `b_next2`          | ALPHA(next), BRAVO(next)                    | 1            | **both steer** (delivered together inline; no turn)                                                                   |
| `b_next2_report`   | ALPHA(next), BRAVO(next), report prompt     | 1            | **both steer** — model quotes two back-to-back individually-wrapped reminders in tool-1's result, injection order     |
| `b_none2`          | ALPHA(none), BRAVO(none)                    | 1            | **both steer** (delivered together inline; no turn)                                                                   |
| `h_next_then_now`  | CHARLIE(next)@b0, BRAVO(now)@b1             | 2            | CHARLIE **steer** (demoted at tool-1 handoff); only BRAVO exec — **`now` does not rescue `next`**                     |
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
   already removed (demoted) before `now` fires — only the `now` runs. The real rule:
   `next`/default is removed from the queue at the first tool→result handoff the turn
   crosses (round 3: demoted to an inline reminder, not discarded); it
   survives only if the turn _ends_ there. `now`-co-queued-at-the-same-boundary
   (`g_now_next`) and tool-less turns (`x_next_notool`) are the two ways that happens.
2. **"Interrupts always report `success`" was false in general.** Only tool aborts do
   (`a_now`); a text-inference abort reports `error_during_execution` (`x_now_notool`).
3. **Determinism was over-claimed from a single repeat.** Re-ran the load-bearing
   scenarios; results below.

Also added to close coverage gaps the reviewer flagged: same-priority `next`/none
(`b_next2`/`b_none2` — both demoted, no merge), `now`/merge via `streamInput`
(`e_now_stream`/`e_now2_stream`), and interrupt at a non-first boundary (`h_now_b1`).

Open scope caveats (untested, stated as such): only `sonnet` / SDK 0.3.195; only Bash
and tool-less turn shapes; `next`/none always injected at the first boundary except
the staged `h_*`; idle-time (not mid-turn) default messages are normal turns, not
tested exhaustively here. Also untested: a `next`/none injected into a tool-**using**
turn _after its last tool's result_ (during the final text inference) — the rule
predicts it executes as a real turn (no handoff remains to demote it at), but no
scenario covers that shape; the verified execute cases are tool-less turns
(`x_next_notool`/`x_none_notool`) and a co-queued `now` (`g_now_next`).

### Determinism

Each load-bearing scenario was run **5×** total (original + 4 repeats); every repeat
reproduced the same outcome:

- `a_now` 5/5 → interrupt (1 tool), `ALPHA` executes.
- `a_next` 5/5 → `ALPHA` never a turn, turn completes (3 tools).
- `c_mixed` 5/5 → exec order `BRAVO → CHARLIE → ALPHA`.
- `h_next_then_now` 5/5 → `CHARLIE` never a turn, only `BRAVO` executes.
- `a_next_report` 3/3 → `ALPHA` delivered as an in-context `<system-reminder>` (the
  model quotes the identical wrapper text in every run), never a turn.
- `b_next2_report` 2/2 → both delivered in tool-1's result as two separately-wrapped
  reminders, injection order, never turns.

(Raw: `captures/`, plus the repeat log referenced in the harness. The queue mechanics
are CLI behavior, not model sampling, consistent with this stability.)

## Round 3: "discarded" was wrong — demoted, not dropped

An interactive `claude` session reproducing `a_next` by hand
(`~/.claude/projects/-home-anton-git-geraschenko-clauctl/6ba82c07-…-b235c33a331d.jsonl`)
showed the **same** queue mechanics as every SDK capture (`enqueue` → `remove`,
`queued_command` attachment, no ALPHA turn) — yet the model's reply explicitly
discussed the ALPHA instruction. The message had been **delivered**.

**The methodological flaw in rounds 1–2:** the busy prompt ordered the model to
"reply with the single word DONE", and the witness for "did the message arrive" was
whether the model obeyed it ("reply with exactly the word ALPHA"). A model that saw
the message but ignored it — because it was firmly mid-task, and because the delivery
wrapper looks like prompt injection inside a tool result — is indistinguishable from
a model that never saw it. "Not executed" was conflated with "not delivered".

**Evidence that delivery happens in the SDK path too:**

1. **Token accounting.** The rendered reminder is invisible in both the JSONL and the
   live stream, but it costs input tokens. In `exp0` (no injection) the inference
   after tool-1's result created **159** cache tokens; in `a_next` (and `a_none`,
   `g_next_later`, `h_next_then_now`) the same inference created **219** (+60 ≈ one
   wrapped prompt); in `b_next2`/`b_none2` (two demoted messages) it created
   **~280** (+120 ≈ two). Zero-create runs are full prompt-cache hits from identical
   earlier runs, not absence.
2. **Direct witness: `a_next_report`.** Same injection as `a_next`, but the busy
   prompt asks the model to report anything it saw along the way. 3/3 runs: the model
   quotes the wrapper verbatim — _"The user sent a new message while you were
   working: Reply with exactly the word ALPHA and nothing else. IMPORTANT: After
   completing your current task, you MUST address the user's message above. Do not
   ignore it."_ — locating it "inside a `<system-reminder>` in the tool result for
   the first Bash call". (All three runs also flagged it as a suspected prompt
   injection and declined to comply — a live demonstration that compliance is at the
   model's discretion.)
3. **Multi-message shape: `b_next2_report`.** Two `next` messages, report prompt.
   2/2 runs: the model quotes **two back-to-back reminders in tool-1's result**, each
   with its own full wrapper, in injection order (ALPHA then BRAVO) — same handoff,
   separate wrappers, no merging.

**Corrected claim:** a `next`/default message injected mid-turn is **demoted**, not
discarded: at the first tool→result handoff it leaves the queue (`remove`) and is
rendered once into the model's context as a `<system-reminder>` on that tool result,
with wrapper text that _instructs_ the model to address it after the current task.
It never becomes its own turn — no `dequeue`, no `user` entry, no `result` — and the
delivery is invisible on the live SDK stream (the streamed `tool_result` carries only
the raw tool output; verified in `a_next_report-events.json`).

**What this changes for clauctl:** the _severity framing_ flips — this is not a
Claude bug that loses messages; it is deliberate steer-style delivery (the wrapper
text proves intent). And it changes the echo design: since the delivered content
demonstrably influences the running turn while being invisible on the live stream,
the daemon **must synthesize an echo for it** — but a **distinct steer-type** event
(typed "injected as a system-reminder into a tool result"), never a regular
executed-turn echo, since no user turn exists in the canonical chain. See the
placement rule §3 for the anchor/fork logic. "The CLI silently drops your message"
is no longer an accurate description.

**Claims from rounds 1–2 that survive unchanged:** everything about `now` (interrupt,
abort semantics, result subtypes), `later` (durable, turn-boundary, merge), priority
ordering, mechanism-independence, and the execute-vs-not fork for `next`/none
(`g_now_next`, `x_*_notool` are genuine `dequeue` + real-turn executions — re-verified
in the raw captures). Only the fate of the non-executing branch was misread.

```bash
cd docs/derisk/echoed-message-placement
node exp.mjs <scenario>        # writes captures/<scenario>-events.json + <scenario>-session.jsonl
                               # (scratch CLAUDE_CONFIG_DIR via tests/sdk/harness.ts; permissionMode "auto")
node analyze.mjs <scenario>    # renders live timeline + canonical chain
node summarize.mjs <scenario>  # one-line outcome (exec/steer/tools/interrupt)
```
