The TUI doesn't show when subagents are running. I want to be able to see at least the existence of subagents. It'd be even better if you can switch to them, like in the regular claude TUI.

TODO: once the TUI can see task agents and stop one individually (a per-task
stop control wired to the `stop_task` control request — the passthrough's
`stopTask` already exists), declare `perTaskStopAffordance: true` at
initialize. That flips interrupt semantics: with the declaration, an interrupt
only aborts the current turn and spares running background tasks (the user
stops individual ones through the TUI); without it the CLI fails closed and an
interrupt kills all background tasks. Do not declare it before the affordance
actually exists in the TUI. (Option classified "persist" in
src/core/options.ts since SDK 0.3.250.)
