# Derisking experiment: does `/clear` (or `/new`) change session_id within one process?

## Why this matters
clauctl's data model hinges on this. If a single long-lived `claude` process can span
multiple session_ids (because `/clear`/`/new` starts a fresh conversation in place), then
clauctl must keep **agent id ≠ session id** (like pictl/pi), tracking a *sequence* of
session_ids per agent and updating "current session_id" live from the message stream.

Static evidence already points this way:
- `ExitReason = 'clear' | 'resume' | ...` — the query loop can terminate with reason `clear`.
- `SDKSessionStateChangedMessage` re-broadcasts `session_id`, implying it changes mid-connection.
- Slash commands are exposed in stream-json (`SDKLocalCommandOutputMessage`, `slash_commands` in init).

This experiment confirms the *runtime* behavior the types only hint at.

## The questions to answer (in priority order)
1. **Process survival:** After sending `/clear` (and separately `/new`), does the *same OS
   process* (same PID) stay alive and keep accepting input — or does the query loop exit
   (forcing a fresh `query()` / new process)?
2. **Session id transition:** Does `session_id` in the emitted messages change after `/clear`?
   Capture the before id, the after id, and *which message type* carries the new id
   (`system/init`? `system/session_state_changed`?).
3. **Context reset:** Before clearing, tell the agent a secret ("the password is bananas").
   After `/clear`, ask "what is the password?" — confirm the context was actually wiped
   (distinguishes a true new session from a cosmetic id change).
4. **`/new` vs `/clear`:** Repeat for `/new` if it exists as a command. Note any difference.
5. **Bonus:** Does the old session's transcript JSONL persist under `~/.claude/projects/`
   under the *old* id after the clear? (Confirms old sessions remain resumable.)

## How to run it
The system `claude` binary is at `~/.local/bin/claude` and is already authenticated.

Two viable approaches — pick whichever proves the behavior fastest:

**Approach A — TS SDK streaming-input mode (preferred; closest to what clauctl will do).**
An installed copy of the SDK lives at:
`/home/anton/git/clauctl/node_modules/@anthropic-ai/claude-agent-sdk`
Write a small `.mjs` that calls `query({ prompt: <AsyncIterable of SDKUserMessage> })`, keeps
the input iterable open, and:
  - yields a user message "Remember: the password is bananas."
  - drains assistant output
  - yields the `/clear` command as a user message (slash commands go through the input stream)
  - yields "What is the password?"
  - logs every message's `type`, `subtype`, and `session_id`
Watch whether the generator keeps producing after `/clear` or terminates.

**Approach B — raw CLI stream-json.**
Run `claude --help` to discover exact flags, then drive
`claude --input-format stream-json --output-format stream-json --verbose` by piping
newline-delimited JSON user messages to stdin and reading JSON from stdout. Same sequence.
Track the child PID to answer the survival question directly.

Prefer Approach A. Fall back to B if the SDK harness is fiddly.

## Constraints
- Keep all scratch files in `/tmp/clauctl-derisk/`.
- This consumes the user's Claude subscription/credits — keep it to the minimum prompts
  needed (the secret, the clear, the recall, then `/new` repeat). No loops, no extra turns.
- Do **not** modify anything under `~/.claude/` except by observing files claude itself writes.

## Report back (concise, evidence-first)
For each of `/clear` and `/new`:
- PID before / PID after (survived? yes/no)
- session_id before / after (changed? yes/no) + which message carried the new id
- password recall after clear (remembered? = context NOT reset)
- whether the old transcript JSONL still exists
Then a one-line conclusion: **agent id must be separate from session id (yes/no)** and any
surprises that affect clauctl's respawn model.

## Methodology
How this experiment was actually run, so a future reader can reproduce or trust it:
- We drove the real, already-authenticated system `claude` binary (`~/.local/bin/claude`,
  model `claude-opus-4-8`) in programmatic stream-json mode via the TypeScript Claude Agent
  SDK's streaming-input API: a single long-lived `query({ prompt: <AsyncIterable of
  SDKUserMessage> })` call whose returned `Query` is an async generator of `SDKMessage`s.
- Three turns per run: (1) plant a secret ("the password is bananas"), (2) send a slash
  command (`/clear`, then separately `/new`) as a user message through the input stream,
  (3) ask the agent to recall the password.
- A `ps`-based watcher tracked the spawned child PID across the slash command to determine
  whether the same OS process survived.
- We inspected the emitted message stream for `session_id` on each message and which message
  type carried any new id, and checked `~/.claude/projects/<cwd>/` for per-session transcript
  JSONL files.
- Scratch harness lived in `/tmp/clauctl-derisk/` (exp.mjs, out-*.json, pids-*.log). No
  changes were made under `~/.claude/` except the transcripts claude itself wrote.

## Learnings
- A single long-lived `claude` OS process SURVIVES both `/clear` and `/new` (same PID); the
  SDK generator keeps producing with no terminate or error.
- Both `/clear` and `/new` start a genuinely fresh conversation IN PLACE: conversation
  context is truly wiped (the planted password is not recalled afterward).
- The new session_id is delivered as a SECOND `system/init` message on the same connection —
  NOT via `SDKSessionStateChangedMessage`. No `session_state_changed` message fired for the id
  transition at all. (`session_state_changed` carries idle/running state, not id rollovers.)
- Therefore clauctl's rule: "current session_id" = the most-recent `init.session_id`; treat
  every post-first `system/init` on a connection as a session rollover.
- Because the process survives, NO respawn is needed for a reset — clauctl keeps the one
  process and re-keys the session. (The SDK type `ExitReason = 'clear'` exists but applies to
  non-streaming/`-p` invocations; in streaming-input mode the loop did not exit on `/clear`.)
- Every prior session_id keeps its own `~/.claude/projects/<cwd>/<session_id>.jsonl`, so old
  sessions remain independently resumable by id after a clear.
- `/new` is NOT listed in the init `slash_commands` array (which lists `clear`, `compact`,
  `config`, `context`, …) yet works identically to `/clear` — do not gate valid reset commands
  on that list.
- Top-line conclusion: agent id MUST be separate from session id. One clauctl agent spans a
  sequence of session_ids over its lifetime.
