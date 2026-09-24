# Follow-up docs

A doc in this directory is a starting point for a future spec, written by an
agent that is about to lose its context (end of task, auto-compaction). Its
job is to record what that agent knows _now_ so a fresh agent can pick the
work up without rediscovering it.

Rules for writing one:

- **Record, don't research.** Write down the facts already in hand: the
  motivation, the current state of the code (file paths, names, the edges
  or shapes that matter), the decisions already made with the user, and the
  open questions. If more research or derisking is needed, put that in the
  doc as a task ("verify X by doing Y") rather than doing it — the doc must
  be finished before context is lost.
- **Separate decided from undecided.** Say which choices the user has
  already agreed to and which are still open; a fresh agent must not
  re-litigate the former or silently guess the latter.
- **Point at sources.** Name the spec, derisk findings, commit, or code the
  facts came from, so the next agent can check them instead of trusting a
  summary.
- **Keep it short.** It is not the spec: no type design, no work log. When a doc
  grows beyond that, it is time to write the spec (`docs/specs/`, via the spec
  skill) and delete the follow-up doc.
- **Suggest a plan, loosely.** A sketch of phases or a checklist the spec can
  start from is welcome; treat it as one option, not a commitment.

This directory also has short docs that a human may have created when they
noticed some piece of follow-up work that they wanted to remember.
