# Permission prompt derisk findings

Probes run 2026-09-08 against SDK 0.3.258 / claude 2.1.258, haiku, scratch
config (tests/sdk/harness.ts rules). `probe.mjs` captures what the SDK hands
`canUseTool` (out/<scenario>.json; every ask denied). `capture-dialogs.mjs`
captures native claude's dialog in tmux (out/<scenario>.claude.{txt,ansi};
every dialog cancelled).

## What `canUseTool` receives over stdio

- `title` is never set. `displayName` (tool's user-facing name: `Greet` for
  `mcp__probe__greet`, else the tool name) and `description` (Bash
  description / file basename / url) are.
- `suggestions` shapes seen: `addRules` allow (destination `localSettings`
  for Bash command + WebFetch domain + MCP whole-tool; `session` for Read
  outside cwd), `addDirectories` (session), `setMode acceptEdits` (session).
  One ask can carry all three (Bash touching a path outside cwd).
  In-cwd Edit/Write: `setMode acceptEdits` only. AskUserQuestion and
  ExitPlanMode: no suggestions.
- `decisionReason` text seen: "Path is outside allowed working directories".
  `blockedPath` set for the outside-cwd Bash case. `agentID` set for asks
  from a subagent (toolUseID is the subagent's tool_use id).
- No `suppress_always_allow_rule`/`default_to_no`/`matched_ask_rule` seen.
- Auto mode DOES escalate: `rm -rf <dir outside cwd>` under
  `permissionMode: "auto"` produced an ask (same payload as default mode);
  plain `ls -la` asked in neither mode.
- Without `canUseTool`, asks are terminal denials (`result.permission_denials`).
- The SDK aborts a pending `canUseTool` via the CLI's
  `control_cancel_request` (options.signal); on resume the CLI can resurface
  parked asks (`processPendingPermissionRequests`).

## Native dialog (2.1.258, 100 cols)

Layout: rule line, title, body, question, numbered rows (`❯ 1. Yes`), hint
line. Title/body/question are per tool:

| tool            | title            | body                                                                | question                                                                           | row 2                                                                                                             |
| --------------- | ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Bash            | `Bash command`   | command, description                                                | `Do you want to proceed?`                                                          | `Yes, and always allow access to <dir> from this project`                                                         |
| Edit            | `Edit file`      | path + line-numbered diff between `╌` rules                         | `Do you want to make this edit to a.txt?`                                          | `Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)` |
| Write           | `Create file`    | path + numbered content                                             | `Do you want to create b.txt?`                                                     | same as Edit                                                                                                      |
| Read            | `Read file`      | `Read(<path>)`                                                      | `Do you want to proceed?`                                                          | `Yes, allow reading from <dir> during this session`                                                               |
| WebFetch        | `Fetch`          | `url:`/`prompt:` + "Claude wants to fetch content from example.com" | `Do you want to allow Claude to fetch this content?`                               | `Yes, and don't ask again for example.com`                                                                        |
| ExitPlanMode    | `Ready to code?` | "Here is Claude's plan:" + plan markdown                            | `Claude has written up a plan and is ready to execute. Would you like to proceed?` | rows: `Yes, auto-accept edits` / `Yes, manually approve edits` / `Tell Claude what to change` (input)             |
| AskUserQuestion | header checkbox  | question + option rows with descriptions                            | —                                                                                  | `Type something.` / `Chat about this`                                                                             |

Row 3 is plain `No` with hint `Esc to cancel · Tab to amend` (Tab opens a
feedback input) — except WebFetch, which still shows the older
`No, and tell Claude what to do differently (esc)`. Row-2 label is derived
from the suggestions (claude picks one label even when three suggestions
are present; the binary's label function combines read paths / write paths
/ command prefixes / setMode / addDirectories).

Deny semantics (binary): feedback text becomes the deny `message`
(`E.feedback ?? "User denied permission"`); claude's own plain-No message is
"The user doesn't want to proceed with this tool use. The tool use was
rejected (eg. if it was a file edit, the new_string was NOT written to the
file). STOP what you are doing and wait for the user to tell you how to
proceed."

## Background-subagent ask (probe-bg-subagent.mjs, out/subagent-bg.json)

Streaming-input Query, `Agent` with `run_in_background`. Timeline (ms):
`result` (top-level turn, success) at 4284 → subagent `assistant`
tool_use:Bash at 4603 → **ask at 4612**, `agentID` set, after the top-level
result. Held 5 s, then denied. After the deny: subagent `user`
(tool_result) → subagent `assistant` text → `background_tasks_changed`,
`task_updated` (status completed), `task_notification` → **`system/init`**
→ a top-level assistant turn → `result`. The CLI delivers the task
notification as a turn of its own with no prompt from the host, so the
resolution is followed by a normal init…result cycle.

`--push` variant (out/subagent-bg-push.json): a prompt pushed 1 s after
the ask arrived ran at once — `init` 16 ms after the push, `result` 0.8 s
later, all while the ask was still held (denied 5 s after that result).
A pending subagent ask does not block the main agent's loop; only the
asking tool use waits.

## Stopping a task under a pending ask (tests/sdk/task-stop-under-ask.test.ts)

SDK 0.3.280 / claude 2.1.280. Background subagent's Bash ask held
unanswered, then the task stopped two ways (timelines in
out/subagent-bg-interrupt.json, out/subagent-bg-kill.json; the test pins
the ordering at every SDK bump):

- `interrupt()` with the main loop idle (top-level `result` already seen):
  ask `signal` aborted at 7253 ms → `background_tasks_changed`,
  `task_updated {status: killed}`, `task_notification {status: stopped}`
  at 7254–7255 ms → the subagent's tool_result carries the plain-deny
  text → `interrupt()` resolves.
- `TaskStop` from the main agent (prompt pushed while the ask pends; the
  turn ran at once, ToolSearch → TaskStop): same order — abort at 10819 ms,
  task events at 10819–10820 ms, TaskStop's own result after.

The abort always precedes the task's terminal events, so a host that
cancels the ask on abort has already dropped it by the time the task is
removed; a killed task never strands an ask.
