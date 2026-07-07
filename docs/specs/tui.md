# Spec: `_tui` — the sdk.sock-client terminal UI

> Status: **phase-3 spec** (grown from the original scaffold). Read
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
uses. Then *any* code that speaks the tty protocol — including non-TS clients
such as a Rust ratatui app — implements attachment to our claude TUI with just
a vt100 widget, never reimplementing UI logic. `_tui` is the process whose
stdio *is* that pty, so it must be spawnable with nothing but a socket path;
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
    `userMessageDequeued` position — the stream position *is* the correct
    transcript position (phase-2 queue model);
  - footer: assistant activity, queue depth, model.
- **Keybindings** (mirroring claude): Enter submits a `query`; Esc sends
  `interrupt` while the assistant is non-idle; double Ctrl+C exits the TUI —
  a **detach**, the agent keeps running.
- **On attach**: blank transcript; the subscribe snapshot seeds footer state
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
- **`AttachMode` mirrors `interactive-mode.ts` in shape** (single event switch
  dispatching to components) at a fraction of the size — everything
  pi-core-specific (extensions, session trees, model registry, settings, auth)
  has no counterpart here.
- The claude-specific fold (`stream_event` deltas → partial message) is ours
  alone and gets the queue-model treatment: small, pure, unit-tested.

### Type design

TDC: let's change "attach-mode"/AttachMode/runAttach to "interactive-mode"/InteractiveMode/runInteractive. "attach" specifically refers to `clauctl attach`, which will come later. This is just regular interactive mode, and it makes the parallel to pi clearer.
```
src/tui/
  attach-mode.ts        // AttachMode — assembly + event dispatch (mirrors interactive-mode.ts)
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
export interface RenderAssistant { content: RenderBlock[]; }
export interface RenderToolResult { toolCallId: string; content: string; isError: boolean; }

// sdk-render.ts — pure, unit-testable without a terminal.
// The streaming unit is one assistant API message (a turn contains several);
// a StreamingMessage is created at each stream_event message_start.
export interface StreamingMessage { partial: RenderAssistant; /* per-block accumulation state */ }
export function beginMessage(): StreamingMessage;
export function foldStreamEvent(streaming: StreamingMessage, event: BetaRawMessageStreamEvent): StreamingMessage;
export function renderAssistant(message: SDKAssistantMessage): RenderAssistant;
export function toolResultsOf(message: SDKUserMessage): RenderToolResult[];
export function userText(message: SDKUserMessage): string;

// attach-mode.ts
export async function runAttach(client: SdkSocketClient): Promise<void>;
class AttachMode {
  constructor(ui: TUI, client: SdkSocketClient, snapshot: StateSnapshot);
  handleEvent(event: SdkEvent): void;
}
```

`runAttach` owns the subscribe ordering: `subscribe(onEvent)` needs the
handler before the snapshot exists, and per the `SdkSocketClient.subscribe`
contract events may be delivered before the snapshot promise settles — so
`runAttach` buffers events in a closure, awaits the snapshot, constructs
`AttachMode` from it, then drains the buffer into `handleEvent` (the same
gating `tail` does).

`AttachMode` tracks assistant activity by folding the event stream with
`nextAssistantState` from `assistant-state.ts`, seeded from
`snapshot.assistantState` — **exactly the code the daemon runs**, not a
UI reimplementation. Activity gates Esc (interrupt only when non-idle) and
drives the footer/loader.

CLI: `_tui` command in `app.ts`, hidden, `--sdk-socket <path>` required; it
connects (`SdkSocketClient.connect`) and hands off to `runAttach`.

Event → UI dispatch (the `AttachMode.handleEvent` switch):

| `SdkEvent` | UI action |
|---|---|
| `userMessageQueued` | add grey entry to the pending area |
| `userMessageDequeued` | move ids from pending into the transcript as user messages |
| `sdkMessage: stream_event` | fold into the live streaming component (created at `message_start`) |
| `sdkMessage: assistant` | finalize the streaming component with authoritative content; create tool-execution components for its toolCalls |
| `sdkMessage: user` | attach contained tool results to their tool-execution components |
| `sdkMessage: result` | loader off; footer update |
| `sdkMessage: system` (init) | footer: model, session |
| any with `parent_tool_use_id` | route into the owning tool-execution component (nested) |
| `interruptSent`, compact boundary | transcript marker / banner |
| `controlApplied`, `compactSent` | footer refresh / banner as applicable |
| any other `SDKMessage` variant | ignored this pass |

The `SDKMessage` union has ~36 variants (status, task notifications, hook
events, rate limits, …); this pass renders the conversation-bearing ones
above and deliberately drops the rest. `SDKUserMessageReplay` is ignored
(the queued/dequeued events are our echo mechanism, DECISION-6).
TDC: Note that we will eventually want to implement some kind of rendering for a bunch of those other message variants. This spec is keeping it narrow so that we can derisk and get a working skeleton.

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
6. Double Ctrl+C exits; the agent keeps running; re-running `_tui` attaches
   again (blank transcript, footer/pending correct from the snapshot).
7. The `sdk-render.ts` fold has unit tests (stream-event sequences → expected
   `RenderAssistant` states), runnable without a terminal.

### Non-goals (this phase; explicitly deferred, not dropped)

- **tty.sock / pty embedding** — the end-state described above; this phase
  must not preclude it (hence `_tui --sdk-socket`), but builds none of it.
- **Permission prompting** (`canUseTool` surfacing to a TUI client) — needs a
  daemon-protocol design of its own; lower risk than the TUI substrate.
- **History**: transcript replay on attach (a `get-messages`-like mechanism).
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

- [ ] `npm install -E @earendil-works/pi-tui`; smoke-test a minimal TUI app
      under our node/type-stripping setup.
- [ ] `render-types.ts` + `sdk-render.ts` with unit tests (fold first).
- [ ] Port components with provenance headers; minimal `theme.ts`.
- [ ] `attach-mode.ts` + hidden `_tui` command in `app.ts`.
- [ ] Live test against a haiku agent (success criteria 1–6).
- [ ] Update this spec with prototype learnings; harden.

### 2026-07-06 — spec written

Derisk findings folded in from the phase-3 assessment (pi TUI coupling
analysis, RPC-mode investigation, pi-tui standalone viability). Decisions:
`_tui --sdk-socket` command shape for future pty/tty.sock wrapping (user);
claude as UX reference, no slash commands this pass (user); components
consume pi-ai-shaped blocks via one converter for mirror-maintainability
(agreed); prototype built in-place in `src/tui/` (user). Deferred:
tty.sock, permissions, history, slash commands.
