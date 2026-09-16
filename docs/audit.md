# Auditing: who did what to an agent

Purpose: how clauctl records who mutates an agent and who is attached to
it, and what the records are good for. Code: `src/core/generated/audit.ts`
(caller-source resolution, log writes), `src/core/generated/cli.ts`
(`recordCommandAudit`, the CLI choke point), `src/core/daemon/daemon.ts`
(attach/detach hooks). The design was ported from pictl's
`docs/specs/auditing-and-attach-tracking.md`.

Auditing is cooperative, not a security boundary. Everything is same-user
(sockets are 0600) and any same-user process can speak the protocol
directly; the goal is to explain how an agent got into its current state
when several parties — humans, other agents, scripts — act on it.

## The records

Two append-only JSONL files in the agent directory:

- `audit.jsonl` — one line per event. Command events
  `{ts, source, argv}` record an _attempt_: written after target resolution
  and before the command runs, with no outcome. Attach events
  `{ts, source, event: "attach" | "detach", pid}` record a protocol client
  that identified itself.
- `sources.jsonl` — `{source, firstSeen, comm, cmdline}`, written the first
  time a pid-based source is seen, so a `claude:12345` in the audit log
  can be decoded after the pid is gone. Dedup is read-before-append, so a
  race can duplicate a line; readers dedup by `source`.

Both are opened `O_APPEND` and each event is one write, so concurrent
writers (several CLIs, the daemon) never interleave lines.

## Caller source

A **caller source** is a stable identity for the _managing_ process behind a
command, not the transient CLI process:

- `clauctl:<agent-id>` — the caller has `CLAUCTL_ID` in its environment.
  The daemon sets it on the `claude` process it runs, and shell tools
  inherit it, so commands one clauctl agent issues against another are
  attributed to the issuing agent. Stable across that agent's restarts.
- `<comm>:<pid>` — otherwise, the manager found by walking `/proc`
  ancestry from the CLI's parent past harness shells (`bash`, `sh`, `zsh`,
  `dash`, `fish`, `ksh`), stopping at the first non-shell process or at an
  interactive shell (session leader with a controlling tty). Fresh-shell-
  per-call harnesses like a claude Bash tool therefore share one source
  (`claude:12345`) across many commands; an interactive terminal is its own
  source (`bash:9876`).
- `process:<pid>` — fallback without `/proc` (non-Linux, or a pid that
  vanished mid-walk): the CLI's parent pid, with no metadata.

## Which commands are audited

A route opts in with `audited: true`; the target-resolving wrappers
(`commandOneTarget`/`commandMultiTarget`) write one event per target
before the function runs. Audited today:

- `prompt`, `interrupt`, `set-context`, `archive`;
- SDK control mutations: `set-model`, `set-permission-mode`,
  `set-mcp-permission-mode-override`, `set-max-thinking-tokens`,
  `apply-flag-settings`, `update-settings`, `set-mcp-servers`,
  `toggle-mcp-server`, `reconnect-mcp-server`, `stop-task`,
  `background-tasks`, `rewind-files`, `seed-read-state`;
- `spawn`, which has no target when it starts (the directory does not
  exist yet) and records its own event right after creating it.

Not audited: reads (`get-*`, `status`, `list`, `tail`, `wait`), `gc`, and
`attach` — attaching is recorded by the daemon instead (below), which also
covers non-clauctl clients.

`argv` is recorded verbatim, prompt text included; that is the point. Stdin
prompts record the literal `-`, so long inputs stay out of the log (the
session file has the content).

Implicit revival is not a separate event: an audited command sent to a
dormant agent revives it, and the command line explains why.

## Attach tracking

A protocol client that sends `subscribe` with `attachment: {pid, client}`
is an **attacher**: the daemon appends it to `agent.json`'s `attachments`
(with `connectedAt`), writes an `attach` audit event, and on connection
close removes it and writes `detach`. The daemon resolves the source
itself from the reported pid (`CLAUCTL_ID` from `/proc/<pid>/environ`,
then the same ancestry walk), so foreign clients only need to report a
pid. Observers such as `tail` subscribe without an attachment and are
invisible.

`attachments` is meaningful only while the daemon runs: it is reset on
startup, cleared on clean shutdown, and left stale by a crash. Detach on
shutdown is implied, not audited.

## Disabling

`CLAUCTL_AUDIT=off` (or `0`) stops the process that would write: the CLI
honors its invoking environment; the daemon honors the environment it was
spawned with, frozen at startup, so attach auditing for a running agent
cannot be toggled without a restart.

## Failure behaviour

In the CLI an audit write failure fails the command (a missing agent
directory means the command could not have worked). In the daemon an
attach-audit failure goes to `daemon.log` and is otherwise ignored; auditing
never kills the daemon.

## Non-goals

No enforcement, no outcome or duration recording, no log rotation (the
logs die with the agent directory), no verification of self-reported pids,
no `clauctl` command to view the log.
