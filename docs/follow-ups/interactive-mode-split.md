# Split interactive-mode.ts into a directory

`src/tui/interactive-mode.ts` is ~1500 lines. Turn it into
`src/tui/interactive-mode/` with a barrel (`index.ts`) exposing the public
interface; see `.dependency-cruiser.cjs` and `eslint.config.js` for how the
existing barrels are declared and enforced.

## Decided (Anton, 2026-10-06)

- Do it as a pure move (no behaviour change) in its own commit, after the
  keybindings work and before the input-slot refactor
  (input-slot-dialogs.md).

## Open

- How to cut the file (e.g. the parse helpers, `resolutionBanner`/dock
  layout, event dispatch, key handling).
