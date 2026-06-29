# Spec: sdk.sock-based TUI & tty.sock embedding boundary

> Status: **scaffold** — captures decisions made so far; to be completed by a
> fresh agent. Read `docs/overview.md` first. This is post-v1.

## SPEC (stable requirements)

Provide an interactive terminal experience for a clauctl-managed Claude agent,
built **on top of `sdk.sock`** (the structured `SDKMessage` stream + control
requests), plus a **language-agnostic embedding boundary** (`tty.sock`) so the UI
can be embedded in other languages without reimplementation.

### Why this is non-trivial (constraint)

Claude **will not allow simultaneous programmatic and interactive connections**,
and in programmatic mode `claude` has **no pty** — it emits structured JSON, not
terminal output. So the TUI cannot attach to a "real" interactive Claude. It must
be **reimplemented on top of the SDK stream** that the daemon already owns.

### Requirements

- The TUI is a **client of `sdk.sock`**: it renders the `SDKMessage` stream and
  sends `SDKUserMessage`s / control requests back. It does not open its own
  `claude` process.
- `tty.sock` exposes the interactive presentation over a stable, documented
  protocol so a thin client in any language (notably a **Rust ratatui** app) can
  embed a clauctl agent.
- An `attach` UX that drops the user into the TUI for a chosen agent.

### Success criteria

- Interactive multi-turn conversation with a live agent through the TUI.
- A non-TS embedder (Rust) drives the same UI purely by speaking the `tty.sock`
  protocol — no UI logic reimplemented.

## IMPLEMENTATION IDEAS (evolving)

- **Possibly adapt pi's TUI** rather than build from scratch (the projects
  are kept close intentionally). Open question whether pi's TUI can be retargeted
  to claude's `SDKMessage` stream.
- **`tty.sock` semantics — decided: virtual-pty.** clauctl runs its own
  SDK-stream-driven TUI, renders it into a _headless/virtual terminal_, and proxies
  those terminal bytes over `tty.sock`. Embedders need only a vt100 terminal widget,
  which preserves pictl's "implement once, embed anywhere" property and keeps the two
  projects symmetric (both embedders speak "terminal over `tty.sock`"). This is what
  `attach` serves. We rejected the alternative of shipping a structured _view model_
  for each embedder to draw natively: an embedder that wants to draw its own UI can
  already talk to `sdk.sock` directly. Virtual-pty doesn't preclude that — but
  `attach` serves _our_ TUI over `tty.sock`, not a draw-it-yourself feed.
- The mapping from `SDKMessage` variants → rendered UI (assistant text, partial
  messages, tool calls/results, permission prompts via `canUseTool`, task
  notifications, status banners, session rollovers on new `system/init`) is the
  core of the render model and should be a single source of truth shared by the
  TUI and any embedder.

## WORK LOG

- (empty) — initial scaffold.

## Open questions / risks

- **Main risk:** the "TUI → virtual pty → proxy bytes + pipe input/resize back"
  mechanism is **unbuilt in both pi/pictl and clauctl**. Prototype before committing.
- Can pi's TUI be reused, or is the `SDKMessage` model different enough to
  warrant a fresh render layer?
- Input/resize/control event protocol over `tty.sock`.
- How permission prompts (`canUseTool`) surface interactively through the daemon
  to a TUI client.
- Multiple simultaneous viewers of one agent (shared session, who can send input).
