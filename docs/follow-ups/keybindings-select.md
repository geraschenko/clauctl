# Configurable selection keybindings

`src/tui/components/question-prompt.ts` (and others) match raw keys with
`matchesKey` alongside configurable keybindings. Review feedback (TDC in
commit ad83fc2):

- Add configurable default keybindings named by semantics, not keystrokes,
  under `tui.select` — e.g. `tui.select.next`, `tui.select.previous` — for
  actions taken while a selection dialog is up.
- Footer hints ("↑/↓ to navigate", "Esc to cancel", …) should show the keys
  actually configured, not hard-coded text.
- Audit every `matchesKey` call outside tests (10 at the time of writing:
  `grep -rn matchesKey src --include=*.ts`) and move them to keybindings.

## Decided (Anton, 2026-10-06)

- All of the above. Order: after the AskUserQuestion cleanup, before
  interactive-mode-split.md.

## Open

- Full list of `tui.select.*` actions and their defaults; check pi-tui's
  existing `tui.*` ids first so nothing is duplicated.
