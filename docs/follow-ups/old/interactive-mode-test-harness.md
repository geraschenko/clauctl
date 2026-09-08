# `InteractiveMode` test harness

Deferred from docs/specs/query-pending-list/phase-1-rebuild.md. There is
no unit-level harness for src/tui/interactive-mode.ts (a fake
`ProtocolClient` + fake `TUI`), so the attach paths the spec describes —
fetch failure on attach, the scan-window rebuild, the startup warnings —
run only as manual smoke on an isolated config. `TranscriptRenderer` and
`SessionModels` are covered; the glue between them and the socket is not.

Shape: a scripted `ProtocolClient` (subscribe response + pushed events
from fixtures) and a `TUI` whose container's rendered text is asserted,
driven the way `scripts/tui-parity/render-session.ts` drives the renderer
from a file. Worth doing before the next change to interactive-mode.ts
that is not a pure rendering tweak.
