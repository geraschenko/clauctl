# `clauctl`: a claude agent orchestration CLI

[![GitHub](https://img.shields.io/badge/github-geraschenko%2Fclauctl-blue?logo=github)](https://github.com/geraschenko/clauctl)
[![npm](https://img.shields.io/npm/v/@geraschenko/clauctl.svg)](https://www.npmjs.com/package/@geraschenko/clauctl)

`clauctl` lets humans, agents, scripts, and code interact with live claude
agents _simultaneously_, each on their own terms. Humans attach a terminal UI,
and agents/scripts get ergonomic access to the Claude Agent SDK's full
control surface.

Plain `claude` is a great interactive UI, but the agent lives and dies with your
terminal, and nothing else can drive the session while you're in it. The Claude
Agent SDK makes claude programmable, but hands you a single in-process
connection — lifecycle, durability across restarts, observation, multi-client
access, and any UI are yours to build. `clauctl` is that harness, prebuilt: it
turns claude sessions into durable background agents that humans, scripts, and
other agents can address and observe at the same time.

`clauctl` is meant to be minimal and composable. Its main components and
associated subcommands are:

- **Lifecycle management** (`spawn`/`list`/`status`/`archive`/…). Each agent
  runs as a background process, automatically revived when needed. There is no
  central orchestrator; each agent's daemon manages its own entry in an
  [on-disk registry](docs/architecture.md#clauctl_dir-as-the-registry).
- **Prompting** with `prompt`: send a turn and stream the reply, or fire and
  forget with `--detach`, with control over queue placement (`--priority`).
- **CLI wrappers for the full SDK control surface**
  (`interrupt`/`set-model`/`set-permission-mode`/`usage`/…). Every
  Claude Agent SDK command, as a subcommand; reads return JSON.
- **Context surgery** with `set-context`: rewind the conversation or reshape
  the agent's effective context down to hand-picked messages plus a summary.
- **Monitoring** with `tail` and `wait`. `prompt` and `tail` can emit formatted
  messages (default), session entries, or the raw event stream —
  human-readable by default, `--json` for machines. See
  [Getting fancy](#getting-fancy-with-clauctl-prompttailformat).
- **TUI access** with `attach`. clauctl ships its own interactive terminal UI;
  the daemon keeps it running whether or not anyone is attached, and any
  number of terminals can attach to the same screen.

(`clauctl` is the sibling of [`pictl`](https://github.com/geraschenko/pictl),
which does the same job for [pi](https://pi.dev) agents.)

## Installation

```sh
npm install -g @geraschenko/clauctl
clauctl --version
```

`clauctl` drives the version-pinned `claude` CLI bundled inside the Claude
Agent SDK, so you don't need claude installed separately. It uses your
existing claude configuration and credentials, and writes ordinary claude
session transcripts. If you've used claude on this machine you're already set
up; otherwise provide an `ANTHROPIC_API_KEY` in the environment (or install
claude and log in once).

> [!NOTE]
> Linux and macOS only; it uses Unix domain sockets and has no native Windows
> support. Node 22.19 or newer is required.
>
> On Linux, the [`node-pty`](https://github.com/microsoft/node-pty)
> dependency has no prebuilt binary and compiles a native addon during
> install, so you need a C/C++ toolchain and Python: `build-essential` and
> `python3` on Debian/Ubuntu, or the equivalent.

## Quickstart

**Start an agent** and make it the default target for subsequent commands.
Run this from the directory the agent should work in (or pass `--cwd PATH`):

```sh
export CLAUCTL_TARGET="$(clauctl spawn -- --permission-mode auto)"
echo "$CLAUCTL_TARGET"
```

- If you don't set `$CLAUCTL_TARGET`, commands that require a target need
  `--target PREFIX` or `-t PREFIX`. Any unique prefix of the agent id is
  accepted.
- Agents get your normal claude settings (default model, permission mode,
  CLAUDE.md, MCP servers, …); claude-style flags after `--` override them,
  e.g. `clauctl spawn -- --model opus`. `clauctl resolve-settings` shows what
  a spawn would see.
- Permission prompts are not yet implemented in clauctl's TUI — that's why
  the example pins `--permission-mode auto` (a model classifier approves or
  denies instead of prompting); `dontAsk` (deny whatever isn't pre-approved)
  also works.
- To "wrap" an existing claude session, run
  `clauctl spawn -- --resume <session-id>` (NOTE: the agent id is _different_
  from the session id — one agent can span many sessions, e.g. across
  `/clear`).

**Attach to the TUI** in another terminal if you want to follow along
interactively (recommended):

```sh
clauctl attach -t <PREFIX_OF_CLAUCTL_TARGET>
```

- The second terminal doesn't inherit `$CLAUCTL_TARGET`, so pass `-t` with
  any unique prefix of the id printed by `spawn`.
- Detach with `ctrl+]`. Detaching does not stop the agent, and the TUI keeps
  running in the daemon while nobody is attached.
- Multiple terminals can attach at once; they share one screen, sized to the
  smallest attached terminal (like tmux).

**Send commands** to the agent from the first terminal (or wherever you've
set `CLAUCTL_TARGET`):

```sh
clauctl prompt "Say hello. Keep it short"

# SDK control commands return JSON (or nothing, for pure mutations).
clauctl set-permission-mode dontAsk
clauctl get-context-usage

# Set the context to any list of existing entries, with `--rewind-to X` being
# syntactic sugar for "everything that was in context when X was the final
# entry".
# Use `clauctl get-entries | clauctl format entries` to find a uuid.
clauctl set-context [--rewind-to <uuid>] [<uuid>...]
```

Rewinding is also interactive: in an attached TUI, `/tree` draws the session
tree — every branch, compaction, and prior rewind — and lets you pick the
point to rewind to. `clauctl get-entries | clauctl format tree`
prints the same tree. Entry uuids, like agent ids, accept any unique prefix —
the 8-character ids shown in tree and entry listings paste straight into
`--rewind-to` and `tail --since`.

> [!NOTE]
>
> - For all available subcommands (including the many SDK passthroughs hidden
>   from the short help), run `clauctl -H`. Subcommands have their own help,
>   e.g. `clauctl set-model -H`.

**Manage your agents**

```sh
clauctl list [--all] [--cwd PATH]

# Non-destructive. Politely stops the processes and hides the agent from
# default `clauctl list`. Any command that talks to it (prompt, attach,
# SDK control commands) revives it; observation commands do not.
clauctl archive -t <PREFIX_OF_CLAUCTL_TARGET>

# Remove leftovers of failed spawns and corrupt agent dirs.
clauctl gc
```

> [!NOTE]
>
> - The actual session transcripts live in your `~/.claude` as usual;
>   `clauctl status` maps an agent to its session ids.
> - `clauctl`'s agent registry lives in your per-OS user data dir
>   (`~/.local/share/clauctl` on Linux), or wherever `$CLAUCTL_DIR` points if
>   you set it.
> - `clauctl list` shows truncated agent ids (fine for `-t` prefixes); get
>   full ids from `spawn`, `status`, or `list --json`.

**Setup tab completion** with `clauctl completion install` (bash only).

## Getting fancy with `clauctl [prompt|tail|format]`

`clauctl prompt` and `clauctl tail` both show a live agent's activity.
`prompt` sends a message and streams until the end of the assistant turn.
`tail` doesn't send anything; it prints the agent's current context and then
keeps streaming new activity indefinitely. Use `tail --until turn-end` to
return once the current turn (if any) finishes, or `tail --timeout 0` to
print the current context and return immediately.

`clauctl wait --until <cond>` is the output-free version: it just blocks until
the condition is met (conditions are `turn-end`, `idle`, or
`no-activity:<secs>`). With `--timeout`, `wait` exits 3 if the condition
wasn't met in time; `tail --timeout` simply ends the watch and exits 0.

### Machine-readable output

Both `prompt` and `tail` print human-readable, formatted output by default;
add `--json` for machine-readable output. If you want finer control over the
formatting, use `--json` and pipe to `clauctl format`.

### Async prompting

Send a prompt without waiting for the reply with `clauctl prompt --detach`.
Then check back with `tail --until turn-end`, which returns once the current
turn (if any) finishes. Formatted message output ends with a "cursor"
identifying the last entry shown, and `clauctl tail --since <uuid>` returns
everything after it. For example:

```sh
$ clauctl tail -t c8b --until turn-end
...
== assistant ==
You are so smart.

[cursor: 6be9380a-1c3f-4a2e-9d5b-8f7a2c4e6b0d]
```

Then you can send an async message with

```sh
$ clauctl prompt -t c8b -d "Stop being such a boot-licker and write a compiler. No mistakes."
```

The `-d` causes the prompt command to return immediately with no output, but
when you're ready to check back in on this agent, you can see what's happened
since you last looked with

```sh
$ clauctl tail -t c8b --since <cursor-uuid> --until turn-end
== user ==
Stop being such a boot-licker and write a compiler. No mistakes.

== assistant ==
[thinking]
Yes sir. I'll get right on it.
...
```

### Queue placement: `--priority` and `--no-query`

Claude queues prompts that arrive while a turn is running, and
`prompt --priority` controls what happens then:

- `--priority now` — interrupt the running turn and run immediately.
- default (or `--priority next`) — a queued prompt is normally delivered
  _into_ the running turn at the next tool boundary, steering it rather than
  becoming its own turn; if the turn ends first, it runs as its own turn.
- `--priority later` — always wait for the current turn to finish, then run
  as its own turn.

`prompt --no-query` appends text to the transcript without triggering a turn
at all — the agent sees it alongside your next real prompt.

### Messages vs entries (vs events)

clauctl distinguishes _messages_ (the conversation units the model sees) from
_entries_ (the durable session-file records they're derived from). If you need
the greater fidelity of entries, you can get it. You can even stream the raw
SDK event feed, but watch out: that includes incremental updates and other
material that never reaches the session file.

Control what you get from `prompt`/`tail` with `--type`:

- `--type messages` (default): one block per message, the same rendering as
  `clauctl format messages`. `--json` for no formatting.
- `--type entries`: one line per session entry, the same rendering as
  `clauctl format entries`. `--json` for no formatting.
- `--type events`: the live event stream, the same rendering as
  `clauctl format events`. `--json` for no formatting. Events aren't
  persisted, so there is no historical output and `--since` doesn't apply.

Session entries form a _tree_ (branches arise from rewinds and compactions);
`clauctl get-entries | clauctl format tree` shows it, and
`clauctl set-context` lets you move around in it (`--rewind-to`), splice the
context down to chosen entries (`set-context <uuid>...`), or replace it with a
summary (`--summary`). Run `clauctl set-context -H` for the full story.

## Further reading

- **How does clauctl work?** See [`docs/architecture.md`](docs/architecture.md)
  for the agent registry, the daemon, the `sdk.sock` and `tty.sock` protocols,
  and how clauctl expects to interact with other programs.
- **Why is it built this way?** See
  [`docs/claude-agent-sdk.md`](docs/claude-agent-sdk.md) for the empirical
  facts about claude and its SDK that the design is built on.
- For all available subcommands, run `clauctl --help-all`. Subcommands have
  their own help info, e.g. `clauctl format entries --help`.
