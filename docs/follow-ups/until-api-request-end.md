# `--until` condition: the end of the current API request's tool results

## Motivation

tg-worker (`~/git/geraschenko/tg-worker/docs/design.md`) records where to
resume a task automatically. When an agent runs a `tg` command that creates
a task or switches away from one, a detached `tg` post-hook waits for a
point in the agent's session and records it as the task's cursor. Decided
with Anton (2026-10-08): that point is the **final `tool_result` answering
the API response that contained the `tg` call**. That is where the CLI
inserts a queued user message (`src/core/protocol-server/queue-model.ts`:
`currentApiMessageId`, `toolResultSeen`), so a rewind to it plus a prompt
reads like the queued message the agent would have received anyway.

## Current state

- Conditions are instantiated in `src/core/until.ts` (`turn-end`, `idle`,
  `quiescent`, `input-needed`, `no-activity:<secs>`) over the shared engine
  in `src/core/generated/until-engine.ts`. The engine is synced from another
  repo; a grammar change goes to its source first.
- `wait`, `tail --until` and `prompt` consume the conditions through
  `runStream`.

## To decide

- Name (e.g. `request-end`) and whether it is met at the seed when no API
  response is open.
- Which API response it refers to when called from inside a tool call: the
  one in progress when the wait starts. Verify that a `clauctl wait` run as
  a detached child of the agent's own Bash tool call observes that response
  as current.
- Behaviour when the response has no tool calls, or the turn is
  interrupted before all results arrive (probably: met at the turn's end).
