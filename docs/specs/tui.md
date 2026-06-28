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

- **Possibly adapt pictl's own TUI** rather than build from scratch (the projects
  are kept close intentionally). Open question whether pictl's TUI can be retargeted
  from pi's tty stream to clauctl's `SDKMessage` stream.
- **`tty.sock` semantics — two candidate designs** (decision deferred to build
  time; **(a) preferred**):
  - **(a) Virtual-pty:** clauctl runs its own SDK-stream-driven TUI, renders it
    into a *headless/virtual terminal*, and proxies those terminal bytes over
    `tty.sock`. Embedders need only a vt100 terminal widget. Preserves pictl's
    "implement once, embed anywhere" property and keeps the two projects
    symmetric (both embedders speak "terminal over `tty.sock`").
  - **(b) Structured view-model:** `tty.sock` carries a rendered view model that
    each embedder draws natively. No synthetic terminal, but more per-language
    work and loses the single-UI property.
- The mapping from `SDKMessage` variants → rendered UI (assistant text, partial
  messages, tool calls/results, permission prompts via `canUseTool`, task
  notifications, status banners, session rollovers on new `system/init`) is the
  core of the render model and should be a single source of truth shared by the
  TUI and any embedder.

## WORK LOG
- (empty) — initial scaffold.

## Open questions / risks
- **Main risk:** the "TUI → virtual pty → proxy bytes + pipe input/resize back"
  mechanism in design (a) is **unbuilt in both pictl and clauctl**. Prototype
  before committing.
- Can pictl's TUI be reused, or is the `SDKMessage` model different enough to
  warrant a fresh render layer?
- Input/resize/control event protocol over `tty.sock`.
- How permission prompts (`canUseTool`) surface interactively through the daemon
  to a TUI client.
- Multiple simultaneous viewers of one agent (shared session, who can send input).
