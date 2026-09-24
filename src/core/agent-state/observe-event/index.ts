/**
 * The fold's only access to a session's stream merge. `observeEvent` is
 * the one observation of an event — stream, nodes and class from
 * protocol.ts, session from `observedSessions`, exclusion from the
 * classification table — and `foldEvent` (next-agent-state.ts) its only
 * caller. The two observations that are not of an event
 * are named operations here; the primitives (`observeOn`, `excludeOn`)
 * stay inside (eslint `no-restricted-imports`).
 */

export { observeEvent, observedSessions } from "./observe-event.ts";
export { rescanSession } from "./rescan-session.ts";
export { excludeResetPrompt } from "./exclude-reset-prompt.ts";
export type { Observation } from "./observe-on.ts";
