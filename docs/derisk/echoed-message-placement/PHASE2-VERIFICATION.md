# Phase-2 verification: the two flagged queue-model assumptions

> Run 2026-07-06 against clauctl itself (not the raw-SDK harness `exp.mjs` used
> for the original FINDINGS). Both assumptions **CONFIRMED**. Raw capture:
> [`captures/phase2-assumptions-tail.jsonl`](captures/phase2-assumptions-tail.jsonl)
> (the full `clauctl tail` stream of the experiment agent — every event below is
> greppable there by `kind` or message text). Total cost ~$0.10 on haiku.

The Phase-2 spec (`docs/specs/phase-2-sdk-sock-protocol.md`, "Flagged
assumptions") shipped with two queue-model rules that were consistent with the
original FINDINGS but never directly captured:

- **A. Interrupt drains**: a `result` terminated by `Query.interrupt()`
  dequeues the next bucket like any other result (if instead claude discarded
  the queue, the daemon's model diverges and `wait-idle` hangs).
- **B. `shouldQuery: false` placement**: no-query messages follow the same
  placement rules as their priority implies — a would-be steer still steers; a
  would-be turn becomes an `append` with no turn of its own — and in both
  cases the content actually enters the agent's context.

## Setup (identical to the success-criteria walkthrough)

```bash
LIVE=/some/scratch/dir
mkdir -p $LIVE/{claude-config,clauctl,work}
cp ~/.claude/.credentials.json $LIVE/claude-config/   # auth for the isolated config dir
alias cc='CLAUCTL_DIR=$LIVE/clauctl CLAUDE_CONFIG_DIR=$LIVE/claude-config node src/core/main.ts'

cc spawn --cwd $LIVE/work --id exp -- --model haiku
cc tail -t exp > $LIVE/tail.jsonl &                   # capture everything
# For the steer half of B the agent needs a multi-tool turn; give it files to Read:
printf 'alpha beta\n%.0s' {1..50} > $LIVE/work/notes1.txt
printf 'gamma delta\n%.0s' {1..50} > $LIVE/work/notes2.txt
```

The `sleep`s below are timing shims to land a message inside a specific window
of a live turn (mid-turn, mid-tool-call); rerunning may need ±1s adjustment if
a model/CLI change alters turn pacing. Verify placement from the tail capture,
not from the sleeps.

## Experiment B — `shouldQuery: false` placement

**B1, would-be-turn becomes append** (tool-less busy turn, so the message can
never be steer-demoted — no tool_result boundary exists):

```bash
cc query -t exp "Write a six-line poem about mountains. Do not use any tools."
sleep 1   # inside the poem turn
cc query -t exp --no-query "Note for later: the codeword is MOSS."
# after the poem's result:
cc query -t exp "In one word: what is the codeword?"
```

Observed (capture, condensed):

```
queued id 1 (poem)            dequeued turn [1]
queued id 2 (MOSS, no-query)                       <- accepted while busy, stays queued
result num_turns=1 (poem)
dequeued append [2]                                <- at the result, delivery "append"
result num_turns=0 ''                              <- zero-cost bookkeeping result, no turn ran
queued id 3 (recall)          dequeued turn [3]
result num_turns=1 'MOSS'                          <- content reached context
```

Pass criteria: no `assistant` message between `dequeued append` and the
`num_turns=0` result (no turn ran for the note), and the recall turn answers
with the note's content.

**B2, would-be-steer stays steer** (multi-tool turn provides the tool_result
boundary that demotes default-priority messages):

```bash
cc query -t exp "Use the Read tool on notes1.txt, then on notes2.txt, then say one word from each."
sleep 1.5   # between turn start and the last tool_result
cc query -t exp --no-query "Note: the animal is OTTER."
# after the result:
cc query -t exp "In one word: what is the animal?"
```

Observed: `queued id 5` → tool_result → `dequeued steer [5]` → second
tool_result → one `result` for the whole turn (no extra result for the note) →
recall turn answers `OTTER`. Same demotion behavior as a querying message
(FINDINGS `b_next2`), delivery confirmed.

## Experiment A — interrupt keeps the queue draining

```bash
cc query -t exp "Write a 500-word essay about oceans. Do not use any tools."
sleep 3     # let the essay turn get going
cc query -t exp --priority later "Say exactly one word: DRAINED"
cc interrupt -t exp
```

Observed (capture, condensed):

```
queued id 10 (essay)          dequeued turn [10]
queued id 11 (DRAINED, later)                      <- queue-resident when the interrupt lands
interruptSent
result subtype=error_during_execution ''           <- the interrupted turn's result
dequeued turn [11]                                 <- the queue drains anyway
result subtype=success 'DRAINED'                   <- the queued turn ran normally
```

Pass criteria: `dequeued turn [11]` immediately follows the interrupted
`result`, and the queued turn produces its own successful `result`. Notable
detail: an interrupt's result has subtype `error_during_execution`; the fold
treats any `result` as the boundary, so nothing special is needed.

## Incidental finding: OAuth expiry mid-run

The copied `.credentials.json` token expired between experiments. Turns then
"completed" instantly with `result` subtype `success` (!) and result text
`Not logged in · Please run /login`. Re-copying fresh credentials fixed it,
and the CLI flushed the stranded messages into the next successful turn
(one result answering all of them). The daemon's queue model and fold stayed
coherent throughout — but a first run of Experiment A silently tested nothing
because both turns finished (as login errors) before the interrupt was sent.
**If rerunning: check result texts for login errors before trusting a run.**
