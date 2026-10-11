# A registry for local slash commands

Split out of the class split (docs/specs/interactive-mode-class-split.md; Anton,
2026-10-09): this is a task of its own.

## Problem

The TUI's local slash commands are parsed in two ways that don't match:

- `InteractiveMode.submit` (`src/tui/interactive-mode/interactive-mode.ts`)
  matches `/tree`, `/keybindings` and `/reload-keybindings` with ad-hoc
  regexes;
- `src/tui/interactive-mode/local-commands.ts` parses `/model` and
  `/effort`, each with its own function.

There's no single list of the local commands, their arguments, or their
descriptions. Autocomplete (`TuiAutocompleteProvider`) needs that list
too.

## Direction (Anton, 2026-10-09)

Add a proper registry of slash commands. Take inspiration from how pi
registers and parses commands:

- `@earendil-works/pi-coding-agent`'s `core/slash-commands.ts` (built-in
  commands);
- `registerCommand` in `core/extensions/types.ts` and
  `core/agent-session.ts` (commands registered by extensions).

## Open

- Everything in the design: registration shape, argument parsing,
  autocomplete integration, and how a command reaches the code that runs
  it.
- Order relative to the class split. Both come after the input-slot task
  (tg c60bca6d).
