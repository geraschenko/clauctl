# src/tui — design philosophy: mirror pi

The overriding goal of this directory is LOW MAINTENANCE BURDEN. The TUI is
built on `@earendil-works/pi-tui` and deliberately mirrors the structure of
pi-coding-agent's interactive mode (source: `$PI_REPO`, default
`~/git/earendil-works/pi`, under
`packages/coding-agent/src/modes/interactive/`). claude's TUI is closed
source; pi's is open. So we target claude's _look_ (docs/specs/tui-parity.md)
but borrow _implementation_ from pi, and we do not bend over backwards to
match claude pixel-exactly where that would mean forking a pi component.

## Preference order for rendering code

1. **Import from `@earendil-works/pi-tui`** (e.g. `Markdown`, `Editor`,
   `Container` primitives). Zero maintenance.
2. **Port verbatim from pi-coding-agent.** Copy the file, keep it
   byte-for-byte close to upstream, and register it in
   `scripts/update-ports.sh` `PORTS`.
3. **Pi-inspired.** When the upstream component is entangled with pi's
   in-process state (e.g. its footer needs pi's `AgentSession`), keep pi's
   structure, naming, and call-site shapes, and re-wire only the data.
4. **Custom code**, only where pi has no counterpart (e.g. sdk.sock event
   folding).

## Rules for ported files

- Every port starts with a header comment:
  `// Ported from pi coding-agent <upstream path> @ <version>` followed by a
  complete list of the intentional differences from upstream. If you change a
  ported file, update that list.
- Keep diffs to upstream minimal. Do not reformat, rename, restructure, or
  otherwise "improve" ported code — mirror-diffing against upstream is how
  updates work, and every gratuitous diff becomes a future merge conflict.
- Update procedure: `scripts/update-ports.sh <old-tag> <new-tag>` applies the
  upstream old→new diff to our ports (prettier-normalized so formatting noise
  cancels); conflicts land as `.rej` files for manual resolution against each
  file's intentional-differences list.
- `theme.ts` intentionally exposes pi's theme call-site API (`theme.fg/bg/
  bold/italic/…`, `getMarkdownTheme`) over a fixed dark palette, so ported
  code keeps its pi shape verbatim. Extend the palette rather than changing
  the API.

## Before writing new rendering code

Check pi-coding-agent for an existing component or pattern first
(`packages/coding-agent/src/modes/interactive/components/` and
`core/tools/*.ts` renderers). If a needed component exists upstream but is
entangled, prefer copying it and re-wiring data over writing a parallel
implementation. When claude's look and a pi component genuinely conflict,
don't improvise — record the conflict for triage in
`docs/derisk/tui-parity/diff-catalog.md`.
