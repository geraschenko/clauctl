# Input slot: InteractiveMode delegates to whatever occupies it

Review feedback on the AskUserQuestion implementation (TDC comments in
commit ad83fc2, `src/tui/interactive-mode.ts`).

## Problems

- `permissionPrompt` field: the name is wrong once it can hold a question
  dialog. It is the component that replaces the editor in `inputSlot` while
  the user answers an ask.
- The component is chosen by "questions undefined ⇒ permission prompt".
  This does not scale to N dialog kinds; building the component for a
  request should be one function dispatching on the request.
- `handleGlobalKey` knows dialog internals (`editingNotes` exemption from
  `app.interrupt`). InteractiveMode should delegate to the slot's occupant:
  the editor, a selector, the permission prompt, or the question prompt.
- The model/effort/tree selectors are not in `inputSlot`; they should be,
  and hide the editor like the dialogs do.

## Decided (Anton, 2026-10-06)

- Do this after the keybindings work (docs/specs/dialog-keybindings.md) and after
  splitting interactive-mode.ts into a directory (interactive-mode-split.md).
- Whether a `permissionResolved` banner shows is decided by the resolved
  request's `toolName` (looked up by `toolUseId` in the pre-event state),
  not by UI state. That part lands in the AskUserQuestion cleanup.

## Decided (Anton, 2026-10-08)

- The input slot becomes a discriminated union of its occupants (editor,
  selectors, permission prompt, question prompt), not a shared interface.
  Each occupant keeps its own callbacks: the permission prompt's
  `onDecide(decision, feedback?)` and the question prompt's
  `onDecide(decision)` need not share a signature
  (docs/specs/permission-amend-allow.md). Task tg c60bca6d.

## Open

- Name for the slot occupant field and the occupant interface (what it
  must expose: render, input handling, whether it consumes Esc, …).
