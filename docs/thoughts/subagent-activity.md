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
