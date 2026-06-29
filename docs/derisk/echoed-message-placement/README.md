# Derisking experiment: where does an echoed user message belong in the stream?

> **Handoff brief for a fresh-context agent.** Read `docs/overview.md` and
> `docs/specs/lifecycle-and-sdk-commands.md` (the "`sdk.sock` stream augmentation"
> section) first. This experiment is **non-blocking**: implementation proceeds with a
> provisional rule (below) and refines it once these findings land.

## Why this matters

clauctl's `sdk.sock` must **augment** the SDK stream with an `EchoedUserMessage`,
because the Claude Agent SDK **does not echo user turns back** (DECISION-6). With
multiple clients on one programmatic connection — and turns that get **queued** while
the agent is busy — the echo has to be inserted at the position that matches the
**idealized session-JSONL ordering**. Insert it in the wrong place and every client's
reconstructed conversation is incoherent (a queued message appears to come before the
output of the turn that was actually still running).

That correct position depends on **undocumented, closed-source `claude` behavior**:
how the `priority` field (`now` / `next` / `later`) and queuing interact with
**inference boundaries** (mid-turn, between tool calls) and **turn boundaries**
(`result`). We need to pin this empirically. This is the RISK-8 spike from
`docs/implementation-plan.md`.

## Prior art (reference, NOT trusted)

muninn's Rust runner already implements an echo-placement scheme — treat it as a
hypothesis to verify, not ground truth (we are not confident it is correct):
- `/home/anton/git/muninn/claude/runner/runner/src/claude_runner_local/handle_message.rs`
  — its rule is **flush-all** pending echoes at a tool-use boundary
  (`StreamEvent` `message_delta` with `stop_reason == "tool_use"`), and **flush-one**
  at each `Result`. Verify this against real captures.
- `/home/anton/git/muninn/claude/runner/runner/src/types/runner_event/runner_event.rs`
  — the event superset (`EchoedUserMessage`, `QueueDepthChanged`, `CompactionStarted`).

## Questions to answer (priority order)

1. **Is `priority` even honored?** Inject two queued user messages with *different*
   `priority` values while the agent is mid-turn. Does their effective ordering differ
   from injection order, or is the field ignored?
2. **What do `now` / `next` / `later` actually do?** Decide between:
   - **Hypothesis A:** `now` interrupts current inference and inserts *ahead of all*
     queued; `next` inserts at the **front** of the queue; `later` at the **back**.
   - **Hypothesis B:** `next` ≈ pi's *steer* (insert at the next **inference**
     boundary), `later` ≈ pi's *follow-up* (insert at the next **turn** boundary);
     always appended, but two queues keyed by boundary type.
3. **Which boundary?** Are queued messages consumed at **inference** boundaries
   (between tool calls — i.e. at a `message_delta` `stop_reason=tool_use` partial), at
   **turn** boundaries (`result`), or both — and under what condition each?
4. **Flush count.** At a boundary, are **all** queued messages consumed, or just the
   next one?
5. **Does `now` actually interrupt** in-flight inference (cancel the current
   assistant turn), or just jump the queue for the next boundary?
6. **Injection-mechanism dependence.** Does any of the above differ between
   **appending to the held-open prompt `AsyncIterable`** and calling
   **`Query.streamInput()`**? Test both — clauctl's daemon will use one, picked by the
   RISK-1 spike, and we must know if priority behaves differently.

## How to run it

The pinned SDK lives at
`node_modules/@anthropic-ai/claude-agent-sdk` (version **0.3.195**). Model the harness
on the `/clear` experiment (`docs/derisk/clear-vs-session-experiment/exp.mjs`): a
single long-lived `query({ prompt: <AsyncIterable of SDKUserMessage> })`, input
iterable held open, advancing on `result`.

Required harness settings:
- **`options.includePartialMessages: true`** — mandatory; the inference-boundary
  signal is the `SDKPartialAssistantMessage` `message_delta` with
  `stop_reason == "tool_use"`. Without partials you cannot see boundary 3.
- **Use the SDK-bundled `claude` binary** (do not point `pathToClaudeCodeExecutable`
  at the system binary) — keeps results tied to the pinned version.
- `options.permissionMode: "bypassPermissions"` (cheap, no prompts) and
  `persistSession` left at its default-on so a JSONL is written.

Experiment shape:
1. Send a turn that triggers a **slow, multi-step tool** so the agent is demonstrably
   *busy* with a window to inject into — e.g. a `Bash` command that lists a large tree
   or `sleep`s a few seconds. (The sleep here is the *agent's tool* simulating real
   latency — this is fine; it is not a sleep in our own code.)
2. **During that window**, inject 2–3 user messages with varying `priority`
   (`now`/`next`/`later`) and recognizable distinct content.
3. Log every message's `type`, `subtype`, `session_id`, `uuid`, and `parent_tool_use_id`,
   plus the raw partial `message_delta` events (with `stop_reason`).
4. After `result`, read the session JSONL under
   `~/.claude/projects/<cwd>/<session_id>.jsonl` and record the **canonical** ordering
   of user vs assistant entries.
5. Repeat the whole thing for **both** injection mechanisms (iterable-append vs
   `streamInput`).

## What to capture (in this directory)

- The harness (`exp.mjs` or similar), inlined like the `/clear` experiment.
- The live event log and the raw partial-stream events.
- The session JSONL(s).
- A table mapping **each injected message → where it landed**: which boundary consumed
  it, its order relative to siblings, and its position in the canonical JSONL.

## Constraints

- Keep all artifacts in this directory; do not modify anything under `~/.claude/`
  except by observing files `claude` itself writes.
- This spends real credits — keep prompts minimal (one busy turn + a few injected
  messages per mechanism). No loops.

## Report back (evidence-first)

For each `priority` value × each injection mechanism: the **insertion boundary**, the
**ordering**, **all-vs-one** flush behavior, and whether `now` **interrupts**. Then a
one-paragraph conclusion: **the echo-placement rule clauctl should implement**, and
**whether muninn's flush-all-at-tool-use / flush-one-at-result logic is correct**. Note
any surprises that affect the `QueueDepthChanged` / idle-model design.
