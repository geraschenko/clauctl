# clauctl — Implementation Plan (DRAFT for review)

> Status: **draft for Anton's review.** This proposes an order of work, surfaces
> the decisions we need _from Anton_ (we are not deciding these unilaterally), and
> lists the risks still to be de-risked. Read `docs/overview.md` first.
>
> Convention: **[DECISION-N]** = a choice we need from Anton before/at that step.
> **[RISK-N]** = an open risk; **[SPIKE]** = a throwaway experiment to retire a risk.
>
> Revision: incorporates iteration-1 review (grounded against pictl's actual
> `src/core` and the derisk findings).

## How pictl maps onto clauctl (reuse inventory)

pictl's `src/core/` and `src/format/` are a partial template — but the two pieces
that _look_ most reusable (the socket layer and the pty layer) are exactly where
pictl helps least, because **pi serves its own socket and runs in a real pty**,
neither of which clauctl has. Honest inventory:

| pictl                                                                              | clauctl analog                                        | reuse                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `core/daemon.ts`, `registry.ts`, `lifecycle.ts`, `spawn.ts`                        | per-agent supervisor daemon + registry + `agent.json` | high (adapt)                                                                                    |
| `core/cli.ts`, `app.ts`, `main.ts`, `targets.ts`, `completion.ts` (+ `@stricli/*`) | CLI wiring, target selection, completion              | high                                                                                            |
| `core/attach.ts`, `tail.ts`, `wait.ts`, `until.ts`, `streaming.ts`                 | monitoring transport                                  | high (but idle _model_ is net-new — see [H5]/[RISK-1])                                          |
| `core/tty-protocol.ts`, `tty-server.ts` (framing, snapshot, late-joiner buffering) | `tty.sock` transport                                  | high                                                                                            |
| `format/*`                                                                         | `format` over `SDKMessage`s                           | medium (retarget data model)                                                                    |
| `core/pi-socket-client.ts`, `rpc-commands.ts`                                      | `sdk.sock` **server** + SDK passthrough               | **net-new** — pi _serves_ its socket; pictl is only a _client_. clauctl must author the server. |
| `core/pty.ts` + a real pi subprocess pty                                           | drive a pty from clauctl's _own_ TUI                  | **net-new** — clauctl has no Claude pty; it must run a renderer into a pty itself               |

The genuinely new engineering: (1) **authoring the `sdk.sock` server** (framing,
fan-out, control-method marshalling, permission round-trip); (2) the **daemon
driving the SDK streaming-input loop** and deriving an idle model; (3) retargeting
format/TUI rendering from pi's tty stream to `SDKMessage`s; (4) the **pty-driving**
half of the TUI.

> **Virtual-pty, honestly scoped.** pictl's proven artifact is "tee a _real
> subprocess's_ pty into `@xterm/headless` and serialize it" — the
> serialize/snapshot/late-joiner transport (`tty-server.ts`) ports cleanly. clauctl
> has no subprocess pty, so it must run _its own_ TUI renderer into a pty and
> serialize that. That pty-driving model is net-new (see [RISK-5]); only the
> transport half is reused. `pty.ts` itself is just a macOS node-pty chmod shim.

## Decisions (resolved by Anton)

All eight are **answered**. They are no longer open; the Phases, Risks, and the
lifecycle spec are written to these resolutions. Kept here as the decision record

- rationale.

* **[DECISION-1] Code-sharing strategy with pictl — copy & diverge now.** The menu
  was (a) **fork & diverge** (copy pictl scaffolding, let them drift), (b) **extract
  a shared package** (daemon/registry/socket-transport/stricli/format-tree/tty-
  transport in a common lib), (c) **monorepo**. **Decision: (a) for now** — copy and
  diverge. If overlap proves high and both tools prove useful, move to a monorepo
  later. We avoid paying the shared-package/refactor-a-shipping-pictl cost up front.
* **[DECISION-2] Daemon model — one supervisor daemon per agent.** Mirrors pictl
  (`daemon.ts`: "the per-agent daemon. One per agent."). The alternative (one process
  hosting every agent's `Query` in-process) is **rejected** for crash isolation: one
  SDK throw or one runaway agent would take down the fleet, and each `Query` holds a
  child `claude` process plus non-serializable closures.
* **[DECISION-3] Permission posture — use the user's real permission mode.** Auto-
  `bypassPermissions` is **not** an acceptable default (the derisk harness used it only
  for cheap, prompt-free runs). v1 assumes the permission mode auto-decides every
  request (e.g. `auto` or `bypassPermissions`). The interactive permission popup — the
  `canUseTool` round-trip from the daemon to an attached client/TUI and back, with a
  non-interactive fallback — is a **future version**, deferred, not built in v1.
* **[DECISION-4] SDK-passthrough scope — expose the _full_ `Query` surface.** Every
  `Query` method becomes a subcommand (the analog of pictl's `rpc-commands.ts`);
  anything less is confusing, and exceptions require a very good reason **and** a
  comment at the mapping site. We do **not** expose non-`Query` SDK functions (`query`,
  `startup`) or other types — **except `resolveSettings`** — though we still consume
  the parameter types internally. Adds a `query` subcommand that appends an
  `SDKUserMessage` to the held-open prompt iterable, with `--image` (like `pictl
  prompt`), `--priority`, and `--no-query`. Full mapping + exclusions in the lifecycle
  spec.
* **[DECISION-5] Identity & on-disk layout — pictl scheme + full history + runtime
  state.** Mirror pictl's agent-id scheme, `--tag` targeting, and `env-paths` state
  dir. Store the **full session-id history** (not just the current id). Critically,
  also persist **mutable runtime state** changed mid-session — permission mode,
  thinking level, model, MCP overrides, applied flag settings — so a daemon restart is
  transparent: the user experiences "the session was running the whole time," not a
  revert to spawn defaults. (pictl has this same gap.)
* **[DECISION-6] Concurrent writers — daemon serializes; the stream is augmented.**
  All commands serialize through the daemon: multiple clients on the one programmatic
  connection are fine, the daemon picks them up and interleaves them (no single-writer
  lock, no reject). Because the SDK **does not echo user messages back**, clients can't
  see each other's input and the conversation reads as nonsense — so `sdk.sock`
  **cannot simply forward** `claude`'s stdout; the daemon must **augment** the stream
  (echoes, queue depth, compaction state). Augmentation set in the lifecycle spec.
  References (treated as _reference, not authority_): muninn's
  `runner/src/types/runner_event/runner_event.rs` (event superset) and
  `runner/src/claude_runner_local/handle_message.rs` (where echoes are inserted).
* **[DECISION-7] `settingSources` default — inherit user + project settings.** A
  spawned agent behaves as if the user ran `claude` on the CLI with the same env and
  settings (user `~/.claude` + project `CLAUDE.md`), **not** the SDK's isolated default
  (which loads no filesystem settings and no project `CLAUDE.md`).
* **[DECISION-8] `persistSession: true` is a hard invariant.** Respawn-via-`resume`
  depends on the per-session transcript JSONL existing; `persistSession: false`
  disables it.

## Proposed order of work

### Phase 0 — Scaffolding & the load-bearing daemon↔SDK spike

> **Spikes 2 and 2b share one harness.** Both must spawn with
> **`includePartialMessages: true`** and drive **non-trivial turn shapes** — a
> tool-using turn, a subagent turn, an `interrupt`, and a `max_turns` hit — not just
> plain text. The 4-state idle model and the echo-flush boundaries are only
> observable on those shapes (the tool-use boundary is a `message_delta` partial with
> `stop_reason=tool_use`); a text-only harness would derisk the wrong thing. Both
> spikes (and clauctl itself) use the **SDK-bundled `claude` binary**, not the system
> one — so the pinned SDK version controls both the wrapper and the CLI behavior.
> Keep the experiment + raw captures under `docs/derisk/` (like the `/clear`
> experiment) so the findings are preserved and auditable. Keep prompts minimal
> (credits).
>
> **Phase-0 exit criteria:** RISK-1 retired when the daemon-context loop demonstrably
> (a) injects turns, (b) emits the correct 4-state transitions across all the turn
> shapes above, and (c) tears down via `close()` with no orphaned child `claude`.
> RISK-8 retired when `--priority` semantics and the flush rule (which queued
> messages flush at which boundary) are pinned by captured evidence, enough to
> specify echo placement.

1. Pin scaffolding from pictl (package.json, tsconfig, eslint/treefmt, stricli
   `app`/`cli`/`main`, `env-paths`) — copy & diverge per [DECISION-1]. **Pin the SDK
   exactly** (`@anthropic-ai/claude-agent-sdk` `0.3.195`, no caret): symbol presence
   varies across versions and job 2 targets a known `Query` shape (see [RISK-6]).
2. **[SPIKE → RISK-1]** Prove the _daemon_ shape of the SDK loop. The derisk harness
   already proved the **single-client** primitive (held-open async iterable, advance
   on `result`). This spike extends it to the daemon context and pins three things:
   (i) the turn-injection mechanism (held-open iterable + queue, vs `Query.streamInput`);
   (ii) the **4-state idle model** — there is no `idle` `SDKStatus`; derive
   **Idle → Pending → Working → Compacting** (`EchoedUserMessage`→Pending,
   `assistant`→Working, `result`→Idle, `/compact`→Compacting; `busy = state != Idle
   || queueDepth > 0`). Idle/streaming/compacting is expected to be tricky; muninn's
   `runner/src/types/runner_state_tracker.rs` is a Rust reference (not trusted
   wholesale). See the lifecycle spec; (iii) clean teardown (`Query.close()` is
   synchronous/`void` — verify it doesn't orphan the child `claude`).
   2b. **[SPIKE → RISK-8] Derisk `--priority`/queue ordering** (pure SDK, no daemon —
   like the `/clear` derisk). The SDK is closed-source and this behavior is _not_
   documented; it determines **where `EchoedUserMessage` must be inserted**, so D6 is
   blocked until we know it empirically. Questions to answer with experiments:
   - What do `priority: 'now' | 'next' | 'later'` actually do? Hypothesis A: `now`
     interrupts current inference and inserts ahead of all queued; `next` inserts at
     the **front** of the queue; `later` at the **back**. Hypothesis B: `next` ≈ pi's
     _steer_ (insert at the next **inference** boundary) and `later` ≈ pi's
     _follow-up_ (insert at the next **turn** boundary) — always appended, but two
     queues keyed by boundary type.
   - Does `claude` insert queued messages at **inference** boundaries (mid-turn,
     between tool calls), at **turn** boundaries (`result`), or both — and when?
   - At a boundary, are **all** queued messages flushed, or just the next one?
     muninn's `handle_message.rs` flush logic (flush-all at tool-use boundary,
     flush-one at `result`) is a **reference, not trusted** — verify it against real
     stream captures. Keep prompts minimal (credits). **Handoff brief:
     `docs/derisk/echoed-message-placement/README.md`** (a fresh agent can run this
     independently; it is non-blocking).

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
   **`tail` is tricky:** the SDK has no sane analogs of pi's `get-messages` /
   `get-entries`. A `get-entries`-equivalent can read the session's JSONL file
   directly, but a `get-messages`-equivalent is harder — it requires figuring out
   which of those entries are **currently in context** for the agent. Needs design.

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
  injection mechanism, the derived idle model, and clean teardown. _Retire in
  Phase 0._ Highest priority.
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
- **[RISK-6] SDK/protocol drift.** Closed, versioned stream-json protocol; symbol
  presence varies across SDK versions (we verified three control methods absent in
  0.2.x but present in **0.3.195 / claudeCodeVersion 2.1.195**, our pinned target).
  Pin the SDK exactly (no caret); clauctl uses the **SDK-bundled `claude` binary**
  (not the system one), so one pinned SDK version fixes both wrapper and CLI. Define
  how we track breaking changes on bump.
- **[RISK-7] Subagents/tasks/MCP surface.** SDK exposes task notifications,
  subagents, MCP management. **DECISION-4 resolved: expose the full `Query` surface**,
  so these ship as subcommands (`backgroundTasks`/`stopTask`/`setMcpServers`/…), not
  deferred. Risk is now scope/testing breadth, not whether to include them.
- **[RISK-8] `--priority`/queue ordering is undocumented and gates D6 echo placement.**
  Where `EchoedUserMessage` must be inserted depends on how `claude` queues and flushes
  prioritized messages at inference/turn boundaries — unknown, closed-source. _Retire
  in Phase 0 ([SPIKE 2b])_ before building the `sdk.sock` augmentation. muninn is a
  reference we do not yet trust.

## Open questions for Anton (consolidated)

All eight DECISIONs are resolved (see the resolution summary above). The remaining
open item is now an **empirical** unknown, not a choice for Anton:

- **[RISK-8] `--priority`/queue ordering** — must be derisked in Phase 0 ([SPIKE 2b])
  before the `sdk.sock` echo-augmentation can be implemented correctly.
