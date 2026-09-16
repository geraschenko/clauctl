# Derisking experiment: does `/clear` (or `/new`) change session_id within one process?

## Why this matters

clauctl's data model hinges on this. If a single long-lived `claude` process can span
multiple session_ids (because `/clear`/`/new` starts a fresh conversation in place), then
clauctl must keep **agent id ≠ session id** (like pictl/pi), tracking a _sequence_ of
session_ids per agent and updating "current session_id" live from the message stream.

Static evidence already points this way:

- `ExitReason = 'clear' | 'resume' | ...` — the query loop can terminate with reason `clear`.
- `SDKSessionStateChangedMessage` re-broadcasts `session_id`, implying it changes mid-connection.
- Slash commands are exposed in stream-json (`SDKLocalCommandOutputMessage`, `slash_commands` in init).

This experiment confirms the _runtime_ behavior the types only hint at.

## The questions to answer (in priority order)

1. **Process survival:** After sending `/clear` (and separately `/new`), does the _same OS
   process_ (same PID) stay alive and keep accepting input — or does the query loop exit
   (forcing a fresh `query()` / new process)?
2. **Session id transition:** Does `session_id` in the emitted messages change after `/clear`?
   Capture the before id, the after id, and _which message type_ carries the new id
   (`system/init`? `system/session_state_changed`?).
3. **Context reset:** Before clearing, tell the agent a secret ("the password is bananas").
   After `/clear`, ask "what is the password?" — confirm the context was actually wiped
   (distinguishes a true new session from a cosmetic id change).
4. **`/new` vs `/clear`:** Repeat for `/new` if it exists as a command. Note any difference.
5. **Bonus:** Does the old session's transcript JSONL persist under `~/.claude/projects/`
   under the _old_ id after the clear? (Confirms old sessions remain resumable.)

## How to run it

The system `claude` binary is at `~/.local/bin/claude` and is already authenticated.

Two viable approaches — pick whichever proves the behavior fastest:

**Approach A — TS SDK streaming-input mode (preferred; closest to what clauctl will do).**
An installed copy of the SDK lives at:
`/home/anton/git/geraschenko/clauctl/node_modules/@anthropic-ai/claude-agent-sdk`
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
- The harness (`exp.mjs`, inlined in this directory) hand-rolls the async iterable with a
  `resolveNext`/`pending` queue and advances to the next user message only when it sees a
  `result` message — so each turn is fully drained before the next prompt is sent, and the
  input stream is held open the whole time.
- `query()` is called with `options.permissionMode: "dontAsk"` (text-only turns, nothing to
  approve) against a scratch `CLAUDE_CONFIG_DIR` from `tests/sdk/harness.ts` and the SDK-bundled
  binary. (The original 2026-08 runs used `bypassPermissions`, the system binary and the real
  `~/.claude`; reruns on 2026-09-11 under the current rules reproduced the findings.)
- The slash command is sent as an ordinary user message whose `content` is the **bare string**
  `"/clear"` (resp. `"/new"`) — no special command envelope; slash commands ride the normal
  input stream.
- Three turns per run: (1) plant a secret ("the password is bananas"), (2) send the slash
  command, (3) ask the agent to recall the password.
- A `ps`-based watcher (run separately; its raw output is in `pids-clear.log` / `pids-new.log`)
  sampled the process table ~2×/sec and recorded the spawned child PID across the slash command
  to determine whether the same OS process survived. The child is identifiable by its argv:
  `/home/anton/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --permission-mode bypassPermissions`.
- We inspected the emitted message stream for `session_id` on each message and which message
  type carried any new id, and checked `~/.claude/projects/<cwd>/` for per-session transcript
  JSONL files.
- Scratch harness originally lived in `/tmp/clauctl-derisk/`; the actual files are now inlined
  in this directory (see **Files** below). No changes were made under `~/.claude/` except the
  transcripts claude itself wrote.

### Follow-up: is the per-turn `system/init` a harness bug?

The main run showed a `system/init` on _every_ turn, not just at connection start, which was
unexpected. We ran two more experiments to find the cause:

1. `exp2-singlesession.mjs` — single session, three plain exchanges, **no** slash command.
   Result (`out-singlesession.json`): a `system/init` fired on all three turns, all carrying
   the **same** session_id (`d2ecca6f…`), context preserved (`bananas` → `BANANAS`). Rules out
   the slash command as the trigger.
2. `exp3-sessionid.mjs` — same as exp2 but attaching `"session_id":"default"` to every user
   message (the Rust SDK does this; our other harnesses do not). Result (`out-sessionid.json`):
   still **three** inits, same id. Rules out the missing `session_id` field as the trigger.
3. Raw binary, **no SDK at all** — two newline-delimited user messages piped straight to
   `claude --input-format stream-json --output-format stream-json --verbose` (`raw-out.jsonl`).
   Result: **two** inits, one per turn, same id, context preserved.

Conclusion: a per-turn `system/init` is genuine `claude` CLI stream-json behavior — every input
user message begins a new turn whose output stream opens with a fresh `init`. It is not a JS-SDK
bug, not a harness artifact, and not affected by the `session_id` field.

Why the Rust SDK (`claude-agent-sdk-rs`) appears not to show this: its idiomatic reader
`receive_response()` breaks at the first `ResultMessage`, handing back exactly one turn at a time
(`[init, assistant…, result]`), so each turn's leading `init` reads as "the start of this
response" rather than a surprising duplicate. Our JS harness reads every turn in one continuous
`for await`, so the inits stack up and look anomalous. Same underlying stream — the continuous
reader `receive_messages()` would show the repeated inits on the Rust side too. (Older `claude`
versions may have behaved differently.)

### Follow-up: where does a prompt queued behind `/clear` land? (exp4, SDK 0.3.258)

`docs/specs/query-pending-list.md` attributes a dequeued prompt to the fold's
`querySessionId`, which only moves at the new session's `system/init`. If the `/clear`
turn's `result` (the dequeue signal) could precede that init, a prompt queued behind
`/clear` would be attributed to the old session while its entry lands in the new file.
`exp4-prompt-across-clear.mjs` runs turn A, then pushes stamped `/clear` and B back to
back (so B is queued while the reset runs), then C. Stream order and per-file placement
are in `captures/exp4-report.json`; pinned by `tests/sdk/clear-session.test.ts`.

Stream order across the reset turn: `command_lifecycle CLEAR started` →
`conversation_reset` (old session_id; `new_conversation_id` is a third id, matching
neither session) → `system/init` (S2) → `result` (S2) → `command_lifecycle CLEAR
completed` → `B started` → `init` (S2) → … So the new init precedes the reset turn's
result: B is dequeued after `querySessionId` has moved, and its entry is in S2's file.

But the `/clear` prompt itself is dequeued on S1 (it was idle-submitted while S1 was
current), while its `<command-name>/clear</command-name>` user entry is written to S2's
file (after a `<local-command-caveat>` entry). S1's file records only the enqueue of
CLEAR, no dequeue and no user entry. A fold that puts the reset command's dequeued prompt
on S1's query pending list therefore never sees S1 settle.

## Files

- `exp.mjs` — the `/clear` + `/new` harness (run as `node exp.mjs /clear clear` and
  `node exp.mjs /new new`).
- `exp4-prompt-across-clear.mjs` — stamped prompt queued behind `/clear`;
  `captures/exp4-S1.jsonl`, `exp4-S2.jsonl` (both session files), `exp4-events.jsonl`
  (full query stream), `exp4-report.json` (slimmed order + per-file user/queue entries).
- `exp2-singlesession.mjs` — single-session follow-up, no slash command, no `session_id` field.
- `exp3-sessionid.mjs` — single-session follow-up that adds `session_id:"default"` per message.
- `captures/out-clear.json`, `out-new.json` — slimmed message logs for each slash-command run
  (type/subtype/session_id plus assistant text and result text).
- `captures/out-singlesession.json`, `out-sessionid.json` — message logs for the two follow-ups.
- `captures/raw-out.jsonl` — raw CLI output (no SDK) proving the per-turn `init` at the binary level.
- `pids-clear.log`, `pids-new.log` — raw `ps` watcher output proving the child PID was stable.

## Learnings

- A single long-lived `claude` OS process SURVIVES both `/clear` and `/new` (same PID); the
  SDK generator keeps producing with no terminate or error.
- Both `/clear` and `/new` start a genuinely fresh conversation IN PLACE: conversation
  context is truly wiped (the planted password is not recalled afterward).
- The new session_id is delivered via a fresh `system/init` message on the same connection —
  NOT via `SDKSessionStateChangedMessage`. No `session_state_changed` message fired for the id
  transition at all. (`session_state_changed` carries idle/running state, not id rollovers.)
- IMPORTANT (corrected): a `system/init` fires on **every turn**, not just at connection start
  or on a reset. Confirmed at the raw-CLI level with no SDK involved (`raw-out.jsonl`): each
  input user message begins a new turn that opens with a fresh `init` carrying the _same_
  session_id. So the presence of a post-first `init` does NOT by itself mean a rollover happened.
- Therefore clauctl's rule: "current session_id" = the most-recent `init.session_id`; a session
  rollover is when an `init`'s `session_id` **differs** from the current one. Detect rollovers by
  comparing ids, never by counting inits. (A respawn of the binary will likewise emit an `init`;
  it may carry the same id, e.g. on resume, or a new one — same comparison rule applies.)
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
- (exp4) `conversation_reset.new_conversation_id` is NOT the new transcript's id; only the
  following `init` is. The new init precedes the reset turn's `result`, so a prompt queued
  behind `/clear` is dequeued after the rollover and lands in the new file. The reset command's
  own user entry also lands in the new file, although the command was dequeued from the old
  session — the one prompt whose query-side observation and file-side entry disagree on session.
