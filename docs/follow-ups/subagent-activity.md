The TUI doesn't show when subagents are running. I want to be able to see at least the existence of subagents. It'd be even better if you can switch to them, like in the regular claude TUI.

TODO: once the TUI can see task agents and stop one individually (a per-task
stop control wired to the `stop_task` control request — the passthrough's
`stopTask` already exists), declare `perTaskStopAffordance: true` at
initialize. That flips interrupt semantics: with the declaration, an interrupt
only aborts the current turn and spares running background tasks (the user
stops individual ones through the TUI); without it the CLI fails closed and an
interrupt kills all background tasks. Do not declare it before the affordance
actually exists in the TUI. (Option classified "persist" in
src/core/options.ts since SDK 0.3.250.)

## Entry flags relevant to subagent views (surveyed 2026-09-07)

Sources: the bundled CLI binary, `sdk.d.ts`, and a read-only survey of 343
local session files.

- **`isMeta`** — a user entry the CLI synthesized rather than the user
  typing: skill expansions ("Base directory for this skill…"),
  `<local-command-caveat>` plus local-command output, `/loop`-synthesized
  prompts, poll events. The transcript UI hides them and the SDK's
  `getSessionMessages` drops them, but **the assistant sees them**: later
  entries parent onto them (4 931 turns in the survey; every isMeta entry in
  a live session had a child) and the binary's isMeta filters are
  "is this a human prompt" predicates (attribution, `/resume` listing, the
  transcript view), not the resume-chain builder. They belong in the
  context tree; they are a presentation concern only.
- **`origin`** — the CLI's own "who sent this" verdict on user entries,
  written from 2.1.190 on: `{kind: "human"}` on every prompt the user
  typed, skill invocations (`<command-message>…<command-args>`) included;
  `{kind: "task-notification"}` on subagent-completion injections. Absent
  on command echoes (`<command-name>`, `<local-command-stdout>`), shell-mode
  echoes (`<bash-input>`/`<bash-stdout>`), `[Request interrupted by user]`,
  typed `/compact …` text, and on prompts sent through the SDK's plain
  string input path (clauctl smoke tests) — and on everything before
  2.1.190, so absence is not a verdict. The field is stamped by the host,
  not the CLI (sdk.d.ts: "a host wrapping keyboard input must stamp
  {kind:'human'} explicitly"); clauctl stamps it in request-handlers.ts.
  `promptSource: "sdk"` is the CLI's delivery-path record, present on
  human and test prompts alike. `isMeta` is a different predicate
  ("synthesized, hidden from the transcript view"): command echoes are not
  isMeta, so "user, not isMeta, has text" over-reports human prompts.
  (Survey of 344 local files, 2026-09-07.)
- **`isSidechain`** — subagent transcript entries. The current CLI writes
  them to separate files, `<project>/<sessionId>/subagents/agent-<id>.jsonl`
  (root `parentUuid: null`, `isSidechain: true`, `agentId`); every entry of
  a main session file is `isSidechain: false`. Older CLIs interleaved them
  in the main file, which is why legacy filters exist (seed, message
  mapping). The main agent never sees sidechain entries — it sees the Task
  tool's `tool_result`. Stream-side, subagent traffic carries
  `parent_tool_use_id`; the daemon forwards it to sinks but the
  agent-state fold skips it — deliberately, since the session tracker
  (docs/specs/session-tracker.md) merges the query stream with the main
  file only, and a subagent uuid observed there would never meet its
  entry. Viewing subagent activity means reading the `subagents/` files,
  not filtering the main file; tracking subagent state means a merge per
  subagent file, routed by `parent_tool_use_id`, in the same shape as the
  main one.
- **`/btw` (side question)** — the CLI forks the current context
  in-process (`forkOrigin: "btw"`, query source `side_question`), answers
  in the fork, and discards it; nothing enters the main conversation. In the
  CLI's control protocol `side_question` is a `control_request` kind with
  progress messages ("currently only side_question"), but `sdk.d.ts`
  exposes no `Query` method for it — only the progress message type.
  Implementable routes: `forkSession(sessionId, {upToMessageId})` plus a
  one-shot `query({resume: fork})`, or `query({resume, forkSession: true})`.
  Whether the raw `side_question` control request is reachable through
  `Query` needs a probe.

## Direction (2026-09-19)

The agent-state fold skips every query message with a string
`parent_tool_use_id` — user, assistant and their `stream_event`s alike
(`fold-sdk-message.ts`): none of their ids can meet an entry in the main
file, and their usage describes the subagent's context. Showing subagent
activity means one more `SessionModel` per subagent, with the subagent's
SDK messages (routed by `parent_tool_use_id`) feeding its query stream
and a separate file follower over `subagents/agent-<id>.jsonl` feeding
its file stream — the same merge shape as the main session, not a filter
over the main file.

## Facts and hypotheses from the permission-prompt derisk (2026-09-29)

Source: docs/derisk/permission-prompt/probe-bg-subagent.mjs, FINDINGS.md
"Background-subagent ask", and a subagent file it produced.

- **Identity is `agentId`, not a session id.** Every entry of
  `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` carries the
  _main_ session's `sessionId`, plus `agentId`, `isSidechain: true`,
  `parentAgentId: null` (depth 1). Subagent SDK frames also carry the
  main `session_id`. `agentId` equals `system/task_started.task_id`, and
  the frames' `parent_tool_use_id` equals `task_started.tool_use_id`; a
  `canUseTool` ask from a subagent carries `agentID` = the same id. So
  routing is exact, keyed by task, and a subagent cannot live in
  `AgentState.sessions` (UUID-keyed, routed by `session_id`).
- **Lifecycle** is the task lifecycle: `task_started` (description,
  `subagent_type`, `is_backgrounded`, `spawn_depth`, `task_type`
  `local_agent`; also `local_bash`, `mcp_task`, `local_workflow`, and
  `ambient` tasks sdk.d.ts says to exclude from activity indicators) →
  `task_updated` patches (`status`, `is_backgrounded`) →
  `task_notification` (`completed | failed | stopped`). Foreground
  subagents emit the same messages. After a background task finishes the
  CLI runs an unprompted `init → turn → result` delivering the
  notification; a prompt pushed while a background subagent is running
  (or blocked on an ask) runs immediately as a turn — the main loop is
  not blocked. `AgentState.tasks: TaskState[]` (permission-prompt spec)
  is the task map this note builds on; the per-task `SessionState` is
  the field to add there.
- **Hypothesis: steering a subagent.** The CLI TUI can send a prompt to
  a running subagent; sdk.d.ts exposes no `Query` method for it, but the
  input `SDKUserMessage` shape has `parent_tool_use_id: string | null`.
  Probe: push a user message with `parent_tool_use_id = <the Task
  tool_use id>` while the subagent runs and check whether it lands in
  the subagent's file (`agent-<id>.jsonl`) rather than the main one.
- **`forwardSubagentText`** (`Options`, documented default false): only
  tool_use/tool_result blocks of subagents are forwarded otherwise. The
  probe saw subagent thinking/text frames without setting it, so either
  the default moved or the daemon's invariant options cover it — verify
  before relying on the query side for a nested transcript.

### Tricky implementation bits for a per-task SessionState

1. **Follower per task.** `TrackedSessionLog` owns one follower and one
   file switch (`sessionFilePath(sessionId: UUID)`); a task needs its own
   follower over `subagents/agent-<id>.jsonl`, started at `task_started`
   (the file may not exist yet — same "seed file absent" handling as the
   main session) and closed after `task_notification`.
2. **Routing on the wire and in the fold.** `sessionEntry`,
   `sessionFileChanged`, `scanComplete`, `sdkMessage` resolve their
   session by `session_id` in `observeEvent`; task-scoped events need a
   `taskId` discriminator, and the fold, `eventNodes`/`excludedFromOther`,
   settlement selectors and anomaly bundles a second lookup path
   (`tasks[i].session` instead of `sessions[id]`).
3. **Classification of sidechain files.** The subagent file is mostly
   `attachment` entries (16 of 20 lines in the probe's file); whether
   `excludedFromQuery`/`excludedFromSession` hold for sidechain files is
   unverified — a wrong table produces an anomaly bundle per subagent.
   Derisk with the compact-boundary-style file survey before coding.
4. **Settlement.** `settled()`/`whenSettled` and set-context's quiet
   wait must either include task files or exclude them deliberately;
   set-context restarts the Query, which kills every task, so quiescence
   (no live tasks) is the guard — `isQuiescent` in the permission spec.
