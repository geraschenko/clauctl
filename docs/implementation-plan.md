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

## Decisions we need from Anton

These gate the work and we will **not** pick them for you:

- **[DECISION-1] Code-sharing strategy with pictl.** (a) **fork & diverge** — copy
  pictl scaffolding, let them drift; (b) **extract a shared package** — pull
  daemon/registry/socket-transport/stricli/format-tree/tty-transport into a common
  lib both depend on; (c) **monorepo**. Highest-leverage decision; shapes
  everything. (a) fastest now, doubles future maintenance; (b)/(c) cost refactoring
  a shipping pictl. *We lean (b) long-term but want your call, and whether to pay
  that cost now or after a fork-and-diverge v1.*
- **[DECISION-2] Daemon model — confirm, don't re-open.** pictl is unambiguously
  **one supervisor daemon per agent** (`daemon.ts`: "the per-agent daemon. One per
  agent."). We recommend clauctl mirror this; the alternative (one process hosting
  every agent's `Query` in-process) is **rejected** for crash isolation — one SDK
  throw or one runaway agent would take down the fleet, and each `Query` holds a
  child `claude` process plus non-serializable closures. We need you to **confirm
  per-agent supervisor**, or tell us why not.
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
- **[DECISION-4] v1 SDK-passthrough scope.** Proposal to react to: v1 ships
  send-a-turn + core control methods (`interrupt`, `setModel`, `setPermissionMode`,
  slash commands incl. `/clear`,`/new`,`/compact`) and defers the long tail (MCP
  management, hooks config, `backgroundTasks`/`stopTask`, subagent/task controls).
  Which capabilities are must-have for *your* v1 usage?
- **[DECISION-5] Identity & on-disk layout.** Mirror pictl's agent-id scheme,
  `--tag` targeting, and `env-paths` state dir? Plus clauctl-specifics: do we store
  `currentSessionId` only, or the full session-id *history* per agent?
- **[DECISION-6] Concurrent writers on `sdk.sock`.** One programmatic connection,
  potentially many clients. When two clients submit a turn at once: single-writer
  lock, queue/interleave, or reject? (Also surfaces in the TUI spec.) Affects the
  socket protocol design.
- **[DECISION-7] `settingSources` default = isolation posture.** When
  `settingSources` is omitted, the SDK loads **no** filesystem settings and does
  **not** read project `CLAUDE.md`. Should a spawned clauctl agent inherit the
  user's `~/.claude` settings + project `CLAUDE.md`, or run isolated by default?
  This changes what the agent *is*.
- **[DECISION-8] Require `persistSession: true`.** Respawn-via-`resume` depends on
  the per-session transcript JSONL existing; `persistSession: false` disables it.
  Confirm clauctl treats persisted sessions as a hard invariant.

## Proposed order of work

### Phase 0 — Scaffolding & the load-bearing daemon↔SDK spike
1. Resolve **[DECISION-1]**; stand up scaffolding accordingly (package.json,
   tsconfig, eslint/treefmt, stricli `app`/`cli`/`main`, `env-paths`) mirroring pictl.
2. **[SPIKE → RISK-1]** Prove the *daemon* shape of the SDK loop. The derisk harness
   already proved the **single-client** primitive (held-open async iterable, advance
   on `result`). This spike extends it to the daemon context and pins three things:
   (i) the turn-injection mechanism (held-open iterable + queue, vs `Query.streamInput`);
   (ii) the **idle/turn-complete model** — there is no `idle` `SDKStatus`; "turn done"
   = `result` for the last-submitted turn, "idle" = that plus no queued turn (daemon
   bookkeeping); (iii) clean teardown (`Query.close()` is synchronous/`void` — verify
   it doesn't orphan the child `claude`).

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
7. **Design & build the `sdk.sock` server protocol** (this is the largest net-new
   chunk, not a port): wire/framing, client→daemon control+turns, daemon→clients
   `SDKMessage` fan-out + late-joiner replay, the **permission round-trip**
   sub-protocol ([DECISION-3]), and the **writer policy** ([DECISION-6]).
8. Implement subcommands mapping to `Query` control methods + send-turn + slash
   commands, scoped by **[DECISION-4]**.

### Phase 3 — Monitoring (`tail`, `wait`, raw `attach`)
9. Reuse `tail`/`attach`/`streaming` transport; `wait` keys off the Phase-0 idle
   model (no sleeps). Define the on-disk/over-wire `SDKMessage` record format.

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
  callback; an interactive decision must reach a client/TUI and back. Net-new;
  blocks non-bypass modes. Couples to [DECISION-3].
- **[RISK-5] TUI → virtual pty.** The net-new half of the tty.sock plan (driving a
  pty from our own renderer); transport half is reused from pictl.
- **[RISK-6] SDK/protocol drift.** Closed, versioned stream-json protocol; pin a
  `claude` binary version and define how we track breaking changes.
- **[RISK-7] Subagents/tasks/MCP surface.** SDK exposes task notifications,
  subagents, MCP management; v1 likely defers these (confirm via [DECISION-4]).

## Open questions for Anton (consolidated)
Beyond the eight DECISIONs above:
- **[DECISION-1]** is the only one with a real menu we can't narrow further without
  you: do we pay the shared-package extraction cost now, or fork-and-diverge for v1
  and extract later? (Note: per-agent daemon model and "author the sdk.sock server"
  are now settled facts, not open questions — pictl answered them.)
