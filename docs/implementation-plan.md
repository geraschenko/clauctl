# clauctl — Implementation Plan (DRAFT for review)

> Status: **draft for Anton's review.** This proposes an order of work, surfaces
> the decisions we need *from Anton* (we are not deciding these unilaterally), and
> lists the risks still to be de-risked. Read `docs/overview.md` first.
>
> Convention: **[DECISION-N]** = a choice we need from Anton before/at that step.
> **[RISK-N]** = an open risk; **[SPIKE]** = a throwaway experiment to retire a risk.
>
> Revision: incorporates iteration-1 review (grounded against pictl's actual
> `src/core` and the derisk findings).

## How pictl maps onto clauctl (reuse inventory)

pictl's `src/core/` and `src/format/` are a partial template — but the two pieces
that *look* most reusable (the socket layer and the pty layer) are exactly where
pictl helps least, because **pi serves its own socket and runs in a real pty**,
neither of which clauctl has. Honest inventory:

| pictl | clauctl analog | reuse |
|---|---|---|
| `core/daemon.ts`, `registry.ts`, `lifecycle.ts`, `spawn.ts` | per-agent supervisor daemon + registry + `agent.json` | high (adapt) |
| `core/cli.ts`, `app.ts`, `main.ts`, `targets.ts`, `completion.ts` (+ `@stricli/*`) | CLI wiring, target selection, completion | high |
| `core/attach.ts`, `tail.ts`, `wait.ts`, `until.ts`, `streaming.ts` | monitoring transport | high (but idle *model* is net-new — see [H5]/[RISK-1]) |
| `core/tty-protocol.ts`, `tty-server.ts` (framing, snapshot, late-joiner buffering) | `tty.sock` transport | high |
| `format/*` | `format` over `SDKMessage`s | medium (retarget data model) |
| `core/pi-socket-client.ts`, `rpc-commands.ts` | `sdk.sock` **server** + SDK passthrough | **net-new** — pi *serves* its socket; pictl is only a *client*. clauctl must author the server. |
| `core/pty.ts` + a real pi subprocess pty | drive a pty from clauctl's *own* TUI | **net-new** — clauctl has no Claude pty; it must run a renderer into a pty itself |

The genuinely new engineering: (1) **authoring the `sdk.sock` server** (framing,
fan-out, control-method marshalling, permission round-trip); (2) the **daemon
driving the SDK streaming-input loop** and deriving an idle model; (3) retargeting
format/TUI rendering from pi's tty stream to `SDKMessage`s; (4) the **pty-driving**
half of the TUI.

> **Virtual-pty, honestly scoped.** pictl's proven artifact is "tee a *real
> subprocess's* pty into `@xterm/headless` and serialize it" — the
> serialize/snapshot/late-joiner transport (`tty-server.ts`) ports cleanly. clauctl
> has no subprocess pty, so it must run *its own* TUI renderer into a pty and
> serialize that. That pty-driving model is net-new (see [RISK-5]); only the
> transport half is reused. `pty.ts` itself is just a macOS node-pty chmod shim.

## Decisions (resolved by Anton)

All eight are **answered** — Anton's resolution is recorded inline as `TDC:` after
each. They are no longer open; the Phases, Risks, and the lifecycle spec below are
written to the resolved decisions. Kept here as the decision record + rationale.

Resolution summary: **D1** copy-and-diverge now, monorepo later if overlap proves
high. **D2** one supervisor daemon per agent. **D3** use the user's real permission
mode (no auto-bypass default); interactive popup + non-interactive fallback deferred.
**D4** expose the *full* `Query` surface as subcommands (exclusions commented), plus
`resolveSettings`; see the lifecycle spec. **D5** persist full session-id history
*and* mutable runtime state (model/permission-mode/thinking/MCP/flag-settings) so
respawn is transparent. **D6** daemon serializes all writers and **augments** the
stream (echoes, queue depth, compaction); see the spec. **D7** inherit user+project
settings by default. **D8** `persistSession: true` is a hard invariant.

- **[DECISION-1] Code-sharing strategy with pictl.** (a) **fork & diverge** — copy
  pictl scaffolding, let them drift; (b) **extract a shared package** — pull
  daemon/registry/socket-transport/stricli/format-tree/tty-transport into a common
  lib both depend on; (c) **monorepo**. Highest-leverage decision; shapes
  everything. (a) fastest now, doubles future maintenance; (b)/(c) cost refactoring
  a shipping pictl. *We lean (b) long-term but want your call, and whether to pay
  that cost now or after a fork-and-diverge v1.*
TDC: Let's copy and diverge for now. If overlap is high and the tools are proving useful, we'll move to monorepo.
- **[DECISION-2] Daemon model — confirm, don't re-open.** pictl is unambiguously
  **one supervisor daemon per agent** (`daemon.ts`: "the per-agent daemon. One per
  agent."). We recommend clauctl mirror this; the alternative (one process hosting
  every agent's `Query` in-process) is **rejected** for crash isolation — one SDK
  throw or one runaway agent would take down the fleet, and each `Query` holds a
  child `claude` process plus non-serializable closures. We need you to **confirm
  per-agent supervisor**, or tell us why not.
TDC: Agreed, one daemon per agent.
- **[DECISION-3] Permission posture for spawned agents (security).** clauctl
  supplies `canUseTool`/`permissionMode`. Two coupled sub-questions:
  - **[3a] Default mode.** The derisk harness used `bypassPermissions` (cheap, no
    prompts). Is **auto-bypass an acceptable default** for spawned agents (requires
    `allowDangerouslySkipPermissions: true`), or must v1 ship the interactive
    round-trip first? This is a safety default; we will not choose it by omission.
  - **[3b] If interactive:** permission decisions must round-trip from the daemon's
    `canUseTool` callback to an attached client/TUI and back — a request/response
    sub-protocol on `sdk.sock` with timeout + "no client attached" fallback.
    pictl gives us **nothing** here (pi handles its own approvals), so this is
    net-new and blocks any non-bypass mode in v1.
TDC: bypass permissions is *not* an acceptable default. We should use the user's actual permission mode. To start with, we can assume the permission mode makes a decision for every request (e.g. "auto" or "bypassPermissions"). Making a permission popup in the UI and deciding what to do if non-interactive is something we can do in a future version.
- **[DECISION-4] v1 SDK-passthrough scope.** Proposal to react to: v1 ships
  send-a-turn + core control methods (`interrupt`, `setModel`, `setPermissionMode`,
  slash commands incl. `/clear`,`/new`,`/compact`) and defers the long tail (MCP
  management, hooks config, `backgroundTasks`/`stopTask`, subagent/task controls).
  Which capabilities are must-have for *your* v1 usage?
TDC: we should expose the *full* SDK surface of the Query type, making exceptions only if there's a very good reason to do so. In terms of what can be targeted at a given agent, we should implement all method of Query (https://code.claude.com/docs/en/agent-sdk/typescript#query-object) as subcommands; this is the analog of pictl's src/core/rpc-commands.ts. Keeping anything less than the full SDK surface is confusing. However, we don't need to keep the SDK function outside of the Query object (e.g. `query` and `startup`) and we don't need any of the types aside from Query. Read the documentation, and highlight anything outside of Query that you think clauctl should expose, or anything within Query that you think clauctl should not expose. I think we should have a `query` subcommand which adds a SDKUserMessage to the prompt iterator used when constructing the Query object. Note that this means we'll need to give the user the ability to add text content and images with `--image`, like pictl prompt does. Does that make sense?
- **[DECISION-5] Identity & on-disk layout.** Mirror pictl's agent-id scheme,
  `--tag` targeting, and `env-paths` state dir? Plus clauctl-specifics: do we store
  `currentSessionId` only, or the full session-id *history* per agent?
TDC: full session id history, like pictl does. Note that we also need to store anything required to resume state (pictl needs to fix this too, btw). For example, if the permission mode, thinking level, or model changes, we have to persist that in agent.json so that if the daemon is shut down and then restarted later, the effect for the user is that the session was just running the whole time.
- **[DECISION-6] Concurrent writers on `sdk.sock`.** One programmatic connection,
  potentially many clients. When two clients submit a turn at once: single-writer
  lock, queue/interleave, or reject? (Also surfaces in the TUI spec.) Affects the
  socket protocol design.
TDC: all commands are serialized through the daemon. So multiple commands coming in on the socket from multiple clients is fine; the daemon picks them up and interleaves them. Note that the claude agent SDK is kind of shitty and doesn't echo user messages back. This is a huge problem for clients, because it means that they can't see what other clients send, which makes the conversation look non-sensicle. This means that the messages sent on sdk.sock cannot simply forward the output from claude's stdout stream. See /home/anton/git/muninn/claude/runner/runner/src/types/runner_event/runner_event.rs for a superset of the various messages we'll have to augment the stream with. Not all of these are critical, but you'll have to look carefully and run the decisions by me. Message is obviously critical (those are regular SDK messages), EchoedUserMessage is critical (but we can drop the type parameter), and I think QueueDepthChanged might be necessary to figure out where to insert the echoed messages, or for clients to be able to figure out if the agent is running vs idle. I think CompactionStarted may also be critical for the client to be able to tell if the agent is in the middle of compaction. See claude/runner/runner/src/claude_runner_local/handle_message.rs for logic around where to insert the echoed messages.
- **[DECISION-7] `settingSources` default = isolation posture.** When
  `settingSources` is omitted, the SDK loads **no** filesystem settings and does
  **not** read project `CLAUDE.md`. Should a spawned clauctl agent inherit the
  user's `~/.claude` settings + project `CLAUDE.md`, or run isolated by default?
  This changes what the agent *is*.
TDC: inherit user and project settings by default. The behavior should be as if the user ran claude on the command line with all the same env variables and settings.
- **[DECISION-8] Require `persistSession: true`.** Respawn-via-`resume` depends on
  the per-session transcript JSONL existing; `persistSession: false` disables it.
  Confirm clauctl treats persisted sessions as a hard invariant.
TDC: yes.

## Proposed order of work

### Phase 0 — Scaffolding & the load-bearing daemon↔SDK spike
1. Resolve **[DECISION-1]**; stand up scaffolding accordingly (package.json,
   tsconfig, eslint/treefmt, stricli `app`/`cli`/`main`, `env-paths`) mirroring pictl.
2. **[SPIKE → RISK-1]** Prove the *daemon* shape of the SDK loop. The derisk harness
   already proved the **single-client** primitive (held-open async iterable, advance
   on `result`). This spike extends it to the daemon context and pins three things:
   (i) the turn-injection mechanism (held-open iterable + queue, vs `Query.streamInput`);
   (ii) the **4-state idle model** — there is no `idle` `SDKStatus`; derive
   **Idle → Pending → Working → Compacting** (`EchoedUserMessage`→Pending,
   `assistant`→Working, `result`→Idle, `/compact`→Compacting; `busy = state != Idle
   || queueDepth > 0`). See the lifecycle spec; (iii) clean teardown (`Query.close()`
   is synchronous/`void` — verify it doesn't orphan the child `claude`).
TDC: idle/streaming/compacting may be tricky. See /home/anton/git/muninn/claude/runner/runner/src/types/runner_state_tracker.rs for a reference implementation in rust.
2b. **[SPIKE → RISK-8] Derisk `--priority`/queue ordering** (pure SDK, no daemon —
   like the `/clear` derisk). The SDK is closed-source and this behavior is *not*
   documented; it determines **where `EchoedUserMessage` must be inserted**, so D6 is
   blocked until we know it empirically. Questions to answer with experiments:
   - What do `priority: 'now' | 'next' | 'later'` actually do? Hypothesis A: `now`
     interrupts current inference and inserts ahead of all queued; `next` inserts at
     the **front** of the queue; `later` at the **back**. Hypothesis B: `next` ≈ pi's
     *steer* (insert at the next **inference** boundary) and `later` ≈ pi's
     *follow-up* (insert at the next **turn** boundary) — always appended, but two
     queues keyed by boundary type.
   - Does `claude` insert queued messages at **inference** boundaries (mid-turn,
     between tool calls), at **turn** boundaries (`result`), or both — and when?
   - At a boundary, are **all** queued messages flushed, or just the next one?
   muninn's `handle_message.rs` flush logic (flush-all at tool-use boundary,
   flush-one at `result`) is a **reference, not trusted** — verify it against real
   stream captures. Keep prompts minimal (credits).

### Phase 1 — Lifecycle core (`spawn`, `list`, `status`, `archive`)
3. `agent.json` schema + registry (adapt `registry.ts`/`lifecycle.ts`); per-agent
   supervisor daemon per **[DECISION-2]**.
4. `spawn` persists serializable `Options` (+ [DECISION-7]/[DECISION-8] posture) and
   brings up the connection.
5. **Session-rollover tracking**: `currentSessionId` = most-recent `init.session_id`;
   detect a rollover **only when an init's `session_id` differs** from the current
   one (an `init` fires every turn — never count inits; `/compact` stays in-session).
6. **Respawn**: persisted `Options` + `resume: currentSessionId`. **[SPIKE → RISK-3]**
   verify cold respawn (kill the process, not just `/clear`) restores behavior, and
   that `close()`/kill doesn't orphan the child.

### Phase 2 — Author the `sdk.sock` server + passthrough (job 2)
> Depends on **[SPIKE → RISK-8]** below: echo placement is undefined until the
> `--priority`/queue-ordering behavior is known.
7. **Design & build the `sdk.sock` server protocol** (this is the largest net-new
   chunk, not a port): wire/framing, client→daemon control+turns, daemon→clients
   **augmented** stream (DECISION-6 — forward `SDKMessage`/`SdkError`; synthesize
   `EchoedUserMessage`/`QueueDepthChanged`/`CompactionStarted`/`SdkClientConnected`/
   `PermissionModeChanged`) + late-joiner replay. Requires **`includePartialMessages:
   true`** at spawn (the daemon consumes partials internally to find tool-use
   boundaries where echoes flush). Writer policy is settled: the **daemon serializes
   and interleaves** all clients (no lock). The interactive permission round-trip is
   **deferred** (DECISION-3) — leave protocol room, don't build it.
8. Implement subcommands for the **full `Query` surface** (DECISION-4): all methods
   1:1, with `close`/`streamInput`/`reinitialize` deliberately not exposed (each
   commented), plus the `query` send-turn subcommand (`--image`/`--priority`/
   `--no-query`) and slash commands. See the lifecycle spec for the exact mapping.

### Phase 3 — Monitoring (`tail`, `wait`, raw `attach`)
9. Reuse `tail`/`attach`/`streaming` transport; `wait` keys off the Phase-0 idle
   model (no sleeps). Define the on-disk/over-wire `SDKMessage` record format.
TDC: note that tail is going to be somewhat tricky, because claude agent sdk doesn't have sane analogs of pi's get-messages and get-entries methods, so we'll have to figure it out. get-entries can read from the session's jsonl file, but get-messages is trickier because it requires figuring out which of those entries are actually currently in context for the agent.

### Phase 4 — Convenience (`completion`, `format`)
10. `completion` via `@stricli/auto-complete` (near-free).
11. `format`: retarget `format/*` to `SDKMessage` variants; share the render model
    with the future TUI.

### Phase 5 — TUI (post-v1, separate spec)
12. Per `docs/specs/tui.md`: reuse `tty-server` transport; **[SPIKE → RISK-5]**
    prototype the net-new "SDK-stream TUI → pty → serialize" half first.

## Risk register

- **[RISK-1] Daemon driving streaming-input mode + idle model.** Single-client
  primitive is proven by the derisk harness; the open parts are the daemon-context
  injection mechanism, the derived idle model, and clean teardown. *Retire in
  Phase 0.* Highest priority.
- **[RISK-2] One programmatic connection, many clients.** Turn serialization
  ([DECISION-6]) + fan-out + late-joiner replay.
- **[RISK-3] Respawn fidelity.** `resume` + persisted `Options` restoring an agent
  as-if-uninterrupted is only partly derisked (clear, not cold kill). `close()` is
  synchronous and may orphan the child `claude` — verify.
- **[RISK-4] Permission/hook round-trip over a socket.** `canUseTool` is a daemon
  callback; an interactive decision must reach a client/TUI and back. **Deferred by
  DECISION-3** (v1 assumes the mode auto-decides); leave protocol room, don't build.
- **[RISK-5] TUI → virtual pty.** The net-new half of the tty.sock plan (driving a
  pty from our own renderer); transport half is reused from pictl.
- **[RISK-6] SDK/protocol drift.** Closed, versioned stream-json protocol; pin a
  `claude` binary version and define how we track breaking changes.
- **[RISK-7] Subagents/tasks/MCP surface.** SDK exposes task notifications,
  subagents, MCP management. **DECISION-4 resolved: expose the full `Query` surface**,
  so these ship as subcommands (`backgroundTasks`/`stopTask`/`setMcpServers`/…), not
  deferred. Risk is now scope/testing breadth, not whether to include them.
- **[RISK-8] `--priority`/queue ordering is undocumented and gates D6 echo placement.**
  Where `EchoedUserMessage` must be inserted depends on how `claude` queues and flushes
  prioritized messages at inference/turn boundaries — unknown, closed-source. *Retire
  in Phase 0 ([SPIKE 2b])* before building the `sdk.sock` augmentation. muninn is a
  reference we do not yet trust.

## Open questions for Anton (consolidated)
All eight DECISIONs are resolved (see the resolution summary above). The remaining
open item is now an **empirical** unknown, not a choice for Anton:
- **[RISK-8] `--priority`/queue ordering** — must be derisked in Phase 0 ([SPIKE 2b])
  before the `sdk.sock` echo-augmentation can be implemented correctly.
