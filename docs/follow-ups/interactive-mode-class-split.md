# Split the InteractiveMode class

After the move into `src/tui/interactive-mode/`
(docs/specs/interactive-mode-split.md), the class in
`src/tui/interactive-mode/interactive-mode.ts` is still about 1200 lines.

## Rule (Anton, 2026-10-09)

`interactive-mode.ts` should shrink, and a reader should be able to see
how it works from the names and signatures of what it contains. A
helper moves to its own file when it has a meaning of its own and its
signature makes plain what it does, even if it has only one user.
`resolutionBanner` is the model case.

## Agreed directions (Anton, 2026-10-09)

- `nextPermissionMode(state: AgentState): PermissionMode`: the pure core
  of `cyclePermissionMode`.
- The effort-level lookup in `handleEffortCommand`: given the supported
  models and the current model, return one of three outcomes: the model
  is unknown, the model has no effort levels, or the model's levels.
- The replay buffer: `liveEventsDuringReplay`, `cutAwaiter`,
  `bufferedUpTo` and `stateAtCut` form one unit with one job, buffering
  live events until history replay reaches its snapshot cut, and could
  be its own small class.
- The `/keybindings` flow: `openKeybindingsEditor` and
  `reloadKeybindings`.
- Local slash commands: today `submit` matches `/tree`, `/keybindings`
  and `/reload-keybindings` with ad-hoc regexes, and
  `local-commands.ts` parses `/model` and `/effort`. The right solution
  is a proper slash-command registry. Look at how pi registers and
  parses commands (pi-coding-agent's slash commands and extension
  command registration) for inspiration.

## Not here

Dialog construction, the selectors, the input slot occupant and the
delegation in `handleGlobalKey` belong to the input-slot task
(docs/follow-ups/input-slot-dialogs.md, tg c60bca6d).

## Open

- Order relative to the input-slot task.
- Whether the slash-command registry is its own task.
