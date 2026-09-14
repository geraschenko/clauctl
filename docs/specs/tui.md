# Spec: `_tui` — the sdk.sock-client terminal UI

> Status: **implemented.** (grown from the original scaffold). Read
> `docs/overview.md` and `docs/specs/phase-2-sdk-sock-protocol.md` first — the
> TUI is a pure client of the protocol that phase built. Corresponds to
> "Phase 5 — TUI" in `docs/implementation-plan.md`.

## SPEC (stable requirements)

### Problem statement

Provide an interactive terminal experience — a claude-replacement chat UI — for
a clauctl-managed agent. Claude **will not allow simultaneous programmatic and
interactive connections**, and in programmatic mode `claude` has no pty — it
emits structured JSON, not terminal output. So the TUI cannot attach to a
"real" interactive claude; it must be **reimplemented on top of the augmented
`sdk.sock` stream** the daemon already owns.

### Architecture: `_tui` now, tty.sock later

The command is `clauctl _tui --sdk-socket <path>` — internal (underscore),
taking a raw socket path with **no registry resolution**. Reasoning: the
end-state attach architecture is that the **daemon spawns `_tui` inside a pty**
and proxies the terminal bytes over `tty.sock` using the same protocol pictl
uses. Then _any_ code that speaks the tty protocol — including non-TS clients
such as a Rust ratatui app — implements attachment to our claude TUI with just
a vt100 widget, never reimplementing UI logic. `_tui` is the process whose
stdio _is_ that pty, so it must be spawnable with nothing but a socket path;
it is equally runnable by hand in a terminal, which is how this phase ships
and tests it. (This refines the scaffold's "virtual-pty" decision: no headless
terminal machinery inside the TUI — it is an ordinary terminal program, and
the pty wrapping is entirely the daemon's future concern.)

### Requirements (this phase)

- **`_tui` is a client of `sdk.sock`**: it connects with `SdkSocketClient`,
  subscribes, renders the `SdkEvent` stream, and sends `query` / `interrupt`
  requests. It never opens its own `claude` process.
- **Direct dependency on `@earendil-works/pi-tui`** (pinned exact, like the
  SDK) for rendering, editor, input handling.
- **Rendering** (claude as the reference experience, pi's interactive mode as
  the readable reference implementation):
  - assistant text and thinking, streamed live (markdown);
  - tool calls with collapsed/summarized results;
  - subagent output (`parent_tool_use_id` set) nested under the owning Task
    tool's component;
  - a **pending area** just above the editor: queued messages rendered grey
    (driven by `userMessageQueued`), moved into the transcript at their
    `userMessageDequeued` position — the stream position _is_ the correct
    transcript position (phase-2 queue model);
  - footer: assistant activity, queue depth, model.
- **Keybindings** (mirroring claude): Enter submits a `query`; Esc sends
  `interrupt` while the assistant is non-idle; double Ctrl+C exits the TUI —
  a **detach**, the agent keeps running.
- **On connect**: blank transcript; the subscribe snapshot seeds footer state
  and the pending area. Live events from now.

### Maintainability requirements

Maintainability outranks polish: the goal is that pi/claude UI improvements
can be mirrored by an agent mechanically, and pi-tui version bumps yield free
fixes. Concretely:

- **Ported components carry provenance headers**:
  `// Ported from pi coding-agent src/modes/interactive/components/<file> @ <version>`.
  Mirroring pi later = diff pi's file since that version, apply the delta to
  the port, bump the header. Structure and naming stay deliberately parallel
  to pi's so the diffs apply.
- **Components consume pi-ai-shaped blocks**, not Anthropic SDK shapes. One
  small pure converter (`sdk-render.ts`) holds **all** claude-specificity;
  everything above it stays diffable against pi. The block types are defined
  here (type-only, tiny) — no dependency on `@earendil-works/pi-ai`.
- **`InteractiveMode` mirrors pi's `interactive-mode.ts` in shape** (single event switch
  dispatching to components) at a fraction of the size — everything
  pi-core-specific (extensions, session trees, model registry, settings, auth)
  has no counterpart here.
- The claude-specific fold (`stream_event` deltas → partial message) is ours
  alone and gets the queue-model treatment: small, pure, unit-tested.

### Type design

```
src/tui/
  interactive-mode.ts   // InteractiveMode — assembly + event dispatch (mirrors pi's interactive-mode.ts)
  sdk-render.ts         // ALL claude-specificity: SDK messages/events → render model
  render-types.ts       // pi-ai-shaped render block types
  theme.ts              // minimal theme for the ported components
  components/
    assistant-message.ts  // ported: streaming text/thinking markdown
    tool-execution.ts     // ported: tool header, collapsed result, nested subagent children
    user-message.ts       // ported: transcript user turns
    pending-messages.ts   // ours: grey queued-message area above the editor
    footer.ts             // ours (pi-inspired): activity, queue depth, model
```

```ts
// render-types.ts — pi-ai-shaped, defined by us
export type RenderBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
export interface RenderAssistant {
  content: RenderBlock[];
}
export interface RenderToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

// sdk-render.ts — pure, unit-testable without a terminal.
// The streaming unit is one assistant API message (a turn contains several);
// a StreamingMessage is created at each stream_event message_start.
export interface StreamingMessage {
  partial: RenderAssistant; /* per-block accumulation state */
}
export function beginMessage(): StreamingMessage;
export function foldStreamEvent(
  streaming: StreamingMessage,
  event: BetaRawMessageStreamEvent,
): StreamingMessage;
export function renderAssistant(message: SDKAssistantMessage): RenderAssistant;
export function toolResultsOf(message: SDKUserMessage): RenderToolResult[];
export function userText(message: SDKUserMessage): string;

// interactive-mode.ts
export async function runInteractive(client: SdkSocketClient): Promise<void>;
class InteractiveMode {
  constructor(ui: TUI, client: SdkSocketClient, snapshot: StateSnapshot);
  handleEvent(event: SdkEvent): void;
}
```

The name is "interactive mode", mirroring pi — not "attach", which
specifically refers to the future `clauctl attach` (the tty.sock client).

`runInteractive` owns the subscribe ordering: `subscribe(onEvent)` needs the
handler before the snapshot exists, and per the `SdkSocketClient.subscribe`
contract events may be delivered before the snapshot promise settles — so
`runInteractive` buffers events in a closure, awaits the snapshot, constructs
`InteractiveMode` from it, then drains the buffer into `handleEvent` (the same
gating `tail` does).

`InteractiveMode` tracks assistant activity by folding the event stream with
`nextAssistantState` from `assistant-state.ts`, seeded from
`snapshot.assistantState` — **exactly the code the daemon runs**, not a
UI reimplementation. Activity gates Esc (interrupt only when non-idle) and
drives the footer/loader.

CLI: `_tui` command in `app.ts`, hidden, `--sdk-socket <path>` required; it
connects (`SdkSocketClient.connect`) and hands off to `runInteractive`.

Event → UI dispatch (the `InteractiveMode.handleEvent` switch):

| `SdkEvent`                        | UI action                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `userMessageQueued`               | add grey entry to the pending area                                                                              |
| `userMessageDequeued`             | move ids from pending into the transcript as user messages                                                      |
| `sdkMessage: stream_event`        | fold into the live streaming component (created at `message_start`)                                             |
| `sdkMessage: assistant`           | finalize the streaming component with authoritative content; create tool-execution components for its toolCalls |
| `sdkMessage: user`                | attach contained tool results to their tool-execution components                                                |
| `sdkMessage: result`              | loader off; footer update                                                                                       |
| `sdkMessage: system` (init)       | footer: model, session                                                                                          |
| any with `parent_tool_use_id`     | route into the owning tool-execution component (nested)                                                         |
| `interruptSent`, compact boundary | transcript marker / banner                                                                                      |
| `controlApplied`, `compactSent`   | footer refresh / banner as applicable                                                                           |
| any other `SDKMessage` variant    | ignored this pass                                                                                               |

The `SDKMessage` union has ~36 variants (status, task notifications, hook
events, rate limits, …); this pass renders the conversation-bearing ones
above and deliberately drops the rest. `SDKUserMessageReplay` is ignored
(the queued/dequeued events are our echo mechanism, DECISION-6). Many of the
dropped variants will eventually want some rendering (status banners, task
notifications, rate limits, …) — this spec keeps the set narrow to derisk
and get a working skeleton, not because they are out of scope forever.

### Success criteria

1. Interactive multi-turn conversation with a live agent through
   `clauctl _tui --sdk-socket <path>`.
2. Assistant text streams incrementally (not per-message pops).
3. Tool calls render with their results; a Task subagent's activity renders
   nested under the Task tool component.
4. A message sent (from a second terminal, via `clauctl query`) while the
   agent is busy appears grey in the pending area, then moves into the
   transcript at its dequeue position.
5. Esc interrupts the current turn; queued messages continue draining
   (phase-2 verified daemon behavior) and the TUI stays coherent.
6. Double Ctrl+C exits; the agent keeps running; re-running `_tui` connects
   again (blank transcript, footer/pending correct from the snapshot).
7. The `sdk-render.ts` fold has unit tests (stream-event sequences → expected
   `RenderAssistant` states), runnable without a terminal.

### Non-goals (this phase; explicitly deferred, not dropped)

- **tty.sock / pty embedding** — the end-state described above; this phase
  must not preclude it (hence `_tui --sdk-socket`), but builds none of it.
- **Permission prompting** (`canUseTool` surfacing to a TUI client) — needs a
  daemon-protocol design of its own; lower risk than the TUI substrate.
- **History**: transcript replay on connect (a `get-messages`-like mechanism).
  A usable daily-driver TUI needs this; it is the next protocol addition.
- **Slash commands** — none in this pass.
- **Multi-viewer arbitration** — multiple subscribed TUIs already work via
  daemon fan-out; nothing arbitrates who may send input.

## IMPLEMENTATION IDEAS (evolving)

- **Plan: prototype-in-place.** Build the prototype directly in `src/tui/`
  with the type design above, then harden it into the real thing; update this
  spec with learnings between the two. The prototype resolves the squishy
  parts marked below.
- **Prototype-resolves** (deliberately under-specified above):
  - the internal accumulation state of `StreamingTurn` (per-content-block
    index bookkeeping for text/thinking deltas; tool-input JSON deltas can be
    ignored until the complete `assistant` message arrives);
  - whether pi-tui `Container` nesting renders the subagent-under-Task case
    acceptably, or the nested view needs its own component;
  - stock pi-tui `Editor` vs pi's `CustomEditor` behaviors — start stock;
  - theme minimalism: how little theming the ported components tolerate;
  - loader/spinner placement while working, and how `result`
    errors/`error_during_execution` render.
- **pi sources to port from** (read: reference, then port with provenance):
  `pi/packages/coding-agent/src/modes/interactive/components/`
  `assistant-message.ts` (147 lines), `tool-execution.ts` (377),
  `user-message.ts`, `footer.ts` (246), `diff.ts` if tool-result diffs are
  wanted early. The pi repo is at `/home/anton/git/earendil-works/pi`.
- **Streaming impedance note**: pi's renderers receive a fully-reconstructed
  partial `AssistantMessage` on every delta (`message_update`); our stream
  carries raw API deltas (`stream_event`, `includePartialMessages` is an
  invariant in `options.ts`). `foldStreamEvent` reconstructs the same
  "full partial" shape, so ported components see what they expect.
- **Feasibility evidence** (2026-07-06 assessment): pi's interactive TUI is
  not socket-attachable (in-process `AgentSession`, ~52 members, no seam) —
  forking it was rejected; its render components are cleanly decoupled and
  consume blocks that map ~1:1 to Anthropic's (`toolCall`≈`tool_use`).
  `@earendil-works/pi-tui` is a standalone MIT npm package (0.80.3, deps:
  `marked` + a width lib) — usable directly.
- **Protocol adequacy**: if the sdk.sock protocol proves insufficient for the
  TUI, change the protocol — it exists to serve exactly this client.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- [x] `npm install -E @earendil-works/pi-tui`; smoke-test a minimal TUI app
      under our node/type-stripping setup.
- [x] `render-types.ts` + `sdk-render.ts` with unit tests (fold first).
- [x] Port components with provenance headers; minimal `theme.ts`.
- [x] `interactive-mode.ts` + hidden `_tui` command in `app.ts`.
- [x] Live test against a haiku agent (success criteria 1–6).
- [x] Update this spec with prototype learnings; harden.

### 2026-07-06 — spec written

Derisk findings folded in from the phase-3 assessment (pi TUI coupling
analysis, RPC-mode investigation, pi-tui standalone viability). Decisions:
`_tui --sdk-socket` command shape for future pty/tty.sock wrapping (user);
claude as UX reference, no slash commands this pass (user); components
consume pi-ai-shaped blocks via one converter for mirror-maintainability
(agreed); prototype built in-place in `src/tui/` (user). Deferred:
tty.sock, permissions, history, slash commands.

Review TDCs (3404ef5) resolved: renamed `AttachMode`/`runAttach`/
`attach-mode.ts` → `InteractiveMode`/`runInteractive`/`interactive-mode.ts`
("attach" is reserved for the future `clauctl attach` tty.sock client; the
pi parallel is clearer), and prose "attach" → "connect" where it meant
connecting to the socket; noted that the dropped `SDKMessage` variants are
narrow-for-derisking, not out of scope forever.

### 2026-07-06 — prototype built (work-log items 1–4)

pi-tui 0.80.3 installed pinned-exact; loads and renders headlessly under
node 23 type-stripping, and `tsc --noEmit` (nodenext) resolves its `.d.ts`
files cleanly. Fold implemented with 11 unit tests; all ported/new
components + `interactive-mode.ts` + `_tui` compile, lint, and pass
`npm test` (78 tests).

#### Implementation-Time Decisions

- **Provenance version is the fork's**: headers say `@ 0.80.2-fork.2` —
  the pi checkout is the user's fork of coding-agent; mirror-diffs should
  run against it, not upstream.
- **tool-execution port keeps only pi's generic fallback path.** pi's
  component dispatches to per-tool `renderCall`/`renderResult` definitions
  from its extension/tool registry — all pi-core-entangled. The port keeps
  the fallback (name + args JSON + output on a pending/success/error
  background) and adds two things of ours: collapsed truncation of args
  (4 lines) and output (6 lines), and an indented sub-container for
  subagent nesting (`addSubagentChild`).
- **assistant-message port drops the stopReason/error tail section**: our
  `RenderAssistant` has no stop reason; interrupt and turn-error banners
  are driven by `interruptSent`/`result` events in interactive-mode.
  _Superseded by the 2026-07-08 review resolution below: stopReason is now
  preserved and the tail section is restored verbatim._
- **theme.ts hardcodes pi's dark.json palette** behind pi's exact call-site
  API (`theme.fg/bg/bold/italic`, `getMarkdownTheme`), so ported code is
  line-for-line diffable; no theme system, no light mode this pass.
- **`tuiRoute` is co-located in interactive-mode.ts** (repo convention:
  each module exports its route; app.ts only assembles).
- **runInteractive exits on `Promise.race([mode.done, client.waitClosed()])`**
  — double Ctrl+C detaches, and a daemon-side close also ends the TUI
  instead of hanging it.
- **Snapshot-seeded pending entries render as placeholders**
  (`(queued message N)`): `StateSnapshot` carries only `{id, shouldQuery}`
  per queued entry, not the message text. Candidate protocol addition
  alongside history replay: include queued message content in the snapshot.

### 2026-07-06 — live test (success criteria 1–6): PASS

Run against a sandboxed haiku agent (isolated `CLAUCTL_DIR`/
`CLAUDE_CONFIG_DIR`, PHASE2-VERIFICATION recipe), driving `_tui` inside a
tmux session and asserting on `capture-pane` output plus a parallel
`clauctl tail` capture. Verified: (1) multi-turn conversation; (2) text
streams incrementally — a capture mid-turn shows a partial thinking block;
(3) tool calls render with results attached (error results exercised via
permission denials), and a subagent's forwarded output renders indented
under the owning Agent tool; (4) a `clauctl query` from a second terminal
while busy appears in the pending area (`queued: 1` in the footer) and
moves into the transcript at its dequeue position; (5) Esc mid-essay:
`interrupted` banner, `turn failed: error_during_execution` banner, queued
`later` message drains and answers; (6) first Ctrl+C shows the detach hint,
second exits; daemon stays up; re-running `_tui` reconnects with a blank
transcript and snapshot-seeded footer, and conversation continues.

#### Implementation-Time Decisions (live test)

- **`forwardSubagentText` moved from bucket persist → invariant `true`**
  (options.ts, plus the bucket lists in the phase-1 and umbrella specs).
  Without it the stream carries only subagent tool_use/tool_result frames —
  no `parent_tool_use_id` assistant/stream_event messages — so success
  criterion 3's nested transcript is unreachable. This is the spec's
  "if the protocol proves insufficient, change it" clause in action, and it
  mirrors the reasoning that made `includePartialMessages` and
  `includeHookEvents` invariant: the augmented stream is the full
  observable record; clients filter what they don't want.
  `--forward-subagent-text` added to spawn's REJECTED_FLAGS accordingly.
  **Flagged for user review**: this reclassifies an option the phase-1
  bucketing had marked user-tunable.
- **Review-pass fixes**: `Editor.submitValue` already clears the editor on
  submit (redundant `setText("")` removed); `system`/`compact_boundary`
  messages render a "context compacted" banner (the dispatch table's
  "compact boundary" row — previously only the `compactSent` half was
  handled); subagent indent guards against widths < 3.

### 2026-07-08 — review comments (d24f349) resolved

- **stopReason preserved** (TDC above): `RenderAssistant` gains
  `stopReason?`/`errorMessage?` using pi-ai's names and `StopReason` union;
  `sdk-render.ts` maps the API's `stop_reason` onto it (`refusal` →
  `"error"` with an errorMessage, token/context limits → `"length"`).
  The port's aborted/error tail section is restored verbatim — one listed
  difference fewer. The API never reports aborted/errored turns per-message,
  so today the tail renders only on `refusal`.
- **pi-ai types not adopted**: pi-ai's `AssistantMessage` requires
  request-metadata (`api`, `provider`, `usage` with costs, `timestamp`) the
  converter would have to fabricate; matching field names in our own
  render-types buys the same mirror-diffability without the dependency.
- **No user/assistant text-variant split in `RenderBlock`**: user text never
  enters `RenderBlock` (it reaches `UserMessageComponent` as a string via
  `userText`), mirroring pi-ai's separate `UserMessage` type.
- **Porting maintenance**: `scripts/update-ports.sh` (copies both pi tags'
  files to a temp dir, formats them with our prettier so formatting noise
  cancels, applies the old→new diff to our ports, bumps the header pins)
  plus the `update-ports` skill (`.claude/skills/update-ports/`) documenting
  the procedure and conflict policy. Ported files stay repo-formatted; no
  treefmt exclusion. Verified against a real v0.80.2-fork.2 → v0.80.3 diff
  (applies with one expected conflict in our modified header/import region).
- **`controlApplied` now updates the footer**: `set-model` and
  `set-permission-mode` reflect immediately; the footer also shows the
  permission mode from `system`/`init` when it isn't `default`.
- **More system subtypes render**: `notification`, `informational`
  (level ≠ info), and the model-refusal fallback/no-fallback messages
  render as banners (refusals in error color). Remaining variants are
  operational chatter with no transcript content.
- **`waitClosed` doc corrected**: the daemon closes sdk.sock only while
  shutting the agent down, so only the detach path leaves the agent
  running.
- **Comment audit** (rejected-plan/future-plan comments) across `src/`:
  removed the "not 'attach'" naming note, the stale phase-forward comments
  in tail.ts/inspect.ts/daemon.ts, and "reserved in v1" phrasing in
  options.ts; `_tui`'s route doc now describes the current role (internal
  sdk.sock client) instead of the future pty/tty.sock wrapping.
