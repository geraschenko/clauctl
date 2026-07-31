# `clauctl`: a claude agent orchestration CLI

`clauctl` lets humans, agents, scripts, and code interact with live claude
agents _simultaneously_, each on their own terms. Humans attach a terminal UI,
and agents/scripts get ergonomic (but unfettered) access to the full Claude
Agent SDK surface.

`clauctl` is meant to be minimal and composable. Its main components and
associated subcommands are:

- **Lifecycle management** (`spawn`/`list`/`status`/`archive`/…). Each agent
  runs as a background process, automatically revived when needed. There is no
  central orchestrator; each agent's daemon manages its own entry in an
  [on-disk registry](docs/architecture.md#clauctl_dir-as-the-registry).
- **Prompting** with `prompt`: send a turn and stream the reply, or fire and
  forget with `--detach`, with control over queue placement (`--priority`).
- **CLI wrappers for the full SDK control surface**
  (`interrupt`/`set-model`/`set-permission-mode`/`usage`/…). Everything the
  Claude Agent SDK can do, as a subcommand. Returns JSON.
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
session transcripts.

> [!NOTE]
> Linux and macOS only; it uses Unix domain sockets and has no native Windows
> support. Node 22.19 or newer is required.
>
> On Linux, the [`node-pty`](https://github.com/microsoft/node-pty)
> dependency has no prebuilt binary and compiles a native addon during
> install, so you need a C/C++ toolchain and Python: `build-essential` and
> `python3` on Debian/Ubuntu, or the equivalent.

## Quickstart

**Start an agent** and make it the default target for subsequent commands:

```sh
export CLAUCTL_TARGET="$(clauctl spawn)"
echo "$CLAUCTL_TARGET"
```

- If you don't set `$CLAUCTL_TARGET`, commands that require a target need
  `--target PREFIX` or `-t PREFIX`. Any unique prefix of the agent id is
  accepted.
- If you want to pass claude-style flags, put them after `--` when you spawn,
  like this: `clauctl spawn -- --model opus --permission-mode auto`.
  To "wrap" an existing claude session, run
  `clauctl spawn -- --resume <session-id>` (NOTE: the agent id is _different_
  from the session id — one agent can span many sessions, e.g. across
  `/clear`).
- Permission prompts are not yet implemented in clauctl's TUI, so pick a
  permission mode that doesn't require interactive approval (like `auto`
  above, or `dontAsk`).

**Attach to the TUI** in another terminal if you want to follow along
interactively (recommended):

```sh
clauctl attach -t <PREFIX_OF_CLAUCTL_TARGET>
```

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
clauctl usage
clauctl get-context-usage

# Inspect the session tree, then reshape the context.
clauctl get-entries | clauctl format tree

# Note: use real entry uuids from your actual session here; see the
# output of `format tree` above.
clauctl set-context --rewind-to <uuid>
```

> [!NOTE]
>
> - For all available subcommands (including the many SDK passthroughs hidden
>   from the short help), run `clauctl -H`. Subcommands have their own help,
>   e.g. `clauctl set-model -H`.

**Manage your agents**

```sh
clauctl list [--all] [--cwd PATH]

# Non-destructive. Politely stops the processes and hides the agent from
# default `clauctl list`. Any later command directed at it revives it.
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
