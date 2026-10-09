# Spec: Dialog keybindings and resolved key hints

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

## SPEC (stable requirements)

### Problem

The TUI's dialogs mix configurable keybindings (`tui.select.*`, resolved
through pi-tui's `KeybindingsManager`; see `docs/specs/tui-keybindings.md`)
with hard-coded keys. Hard-coded keys cannot be remapped in
`keybindings.json`, and the footer hints that name them ("Esc to cancel",
"Tab to amend", …) are literals that go wrong as soon as a user remaps
anything. The hard-coded keys are:

- `question-prompt.ts`: `tab`/`right` (next question tab), `shift+tab`/`left`
  (previous question tab), `space` (toggle a multi-select option), `n`
  (open notes; compared as `data === "n"`).
- `permission-prompt.ts`: `tab` (open the amend input).
- `tree-selector.ts`: `backspace` (delete a search character).

### Success criteria

1. Every command key the question dialog, permission dialog and tree
   selector dispatch on resolves through the keybinding registry.
   Exceptions, unchanged: the digit row shortcuts `1`–`9` (positional,
   like printable text) and printable characters typed into text fields
   or the tree selector's search.
2. The new action ids below are remappable in `keybindings.json` and
   appear in `default_bindings` like every other action.
3. Every key hint in these dialogs and in the model/effort selectors is
   rendered from the resolved bindings via `keyLabel`. Under default
   bindings every hint reads exactly as before, except:
   - the multi-question navigation hint reads `Tab/↑/↓ to navigate`
     (native: `Tab/Arrow keys to navigate`, which cannot be derived from
     bindings);
   - the model, effort and tree selector hints read `Esc`/`Enter` instead
     of the raw ids `escape`/`enter`;
   - the free-text row and amend input hints gain the ctrl+g segment
     (criterion 5).
4. A focused text field inside a dialog receives every key the dialog
   is given, except the actions the dialog reserves in that state (see
   Key routing).
5. `app.editor.external` (ctrl+g) edits the text of every dialog text
   input in the external editor: notes (as today), the question dialog's
   free-text row, and the permission dialog's amend input.
6. Default behaviour is otherwise unchanged except in the question dialog:
   - on the free-text ("Other") row, Tab and Shift+Tab do nothing (they
     switched tabs before);
   - on the free-text row and in notes mode, a raw LF (`\n`, e.g.
     Ghostty's shift+enter) submits, because pi `Input` submits on LF
     regardless of bindings.

### Action set

Added to `CLAUCTL_KEYBINDINGS` and the `Keybindings` augmentation in
`src/tui/keybindings.ts`:

| Action id                  | Default                 | Meaning                                    |
| -------------------------- | ----------------------- | ------------------------------------------ |
| `app.question.nextTab`     | `["tab", "right"]`      | Show the next question tab                 |
| `app.question.previousTab` | `["shift+tab", "left"]` | Show the previous question tab             |
| `app.question.toggle`      | `space`                 | Toggle the focused multi-select option     |
| `app.question.notes`       | `n`                     | Open the notes input (preview layout only) |
| `app.permission.amend`     | `tab`                   | Open the amend input on the focused row    |

Namespace rule: `tui.*` ids are defined by pi-tui for its own components
(`Editor`, `Input`, `SelectList`); `app.*` ids are defined by the
application, and a component's own actions sit under
`app.<component>.*` (pi-coding-agent's precedent: `app.tree.*`,
`app.models.*`). Generic selection actions stay on
`tui.select.{up,down,pageUp,pageDown,confirm,cancel}`. Text-field keys
stay on pi `Input`'s own bindings: `tui.input.submit`, `tui.select.cancel`
(its `onEscape`), `tui.editor.*`.

Overlapping defaults (`tab` in `app.question.nextTab`,
`app.permission.amend` and `tui.input.tab`; `shift+tab` in
`app.question.previousTab` and `app.permissionMode.cycle`) are not
conflicts: pi-tui reports conflicts among user overrides only, and the
actions are never live at the same time (`handleGlobalKey` skips
`app.permissionMode.cycle` while a dialog is open).

### Key labels

`keyLabel(keybindings, keybinding)` returns the display form of the
action's **first** resolved key, or `undefined` when the action has no
keys. Display form:

| Key                           | Label                                  |
| ----------------------------- | -------------------------------------- |
| `escape`, `esc`               | `Esc`                                  |
| `enter`, `return`             | `Enter`                                |
| `tab`                         | `Tab`                                  |
| `space`                       | `Space`                                |
| `up`, `down`, `left`, `right` | `↑`, `↓`, `←`, `→`                     |
| anything else, incl. chords   | unchanged (`ctrl+g`, `shift+tab`, `n`) |

Hints are built from segments; a segment whose label is `undefined` is
omitted, and the rest are joined as before (`" · "` in dialogs). A hint
names the binding that actually handles the key in the current state —
e.g. on the free-text row and in notes mode, "Enter to select" uses
`tui.input.submit`, because Enter goes to the text input there.

Under default bindings:

| Where                           | Hint                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Question, one question          | `Enter to select · ↑/↓ to navigate · Esc to cancel`                                 |
| Question, several questions     | `Enter to select · Tab/↑/↓ to navigate · Esc to cancel`                             |
| Question, preview layout        | `… · n to add notes · Esc to cancel`                                                |
| Question, notes mode            | `Enter to select · Esc to go back · ctrl+g to edit in your editor`                  |
| Permission, Tab-amend dialogs   | `Esc to cancel · Tab to amend`                                                      |
| Permission, plan dialog         | `Esc to cancel · ctrl+g to edit the plan`                                           |
| Question, free-text row focused | `Enter to select · ↑/↓ to navigate · ctrl+g to edit in your editor · Esc to cancel` |
| Permission, amend input         | `Enter to send · Esc back to the options · ctrl+g to edit in your editor`           |
| Tree selector                   | `pick a tree entry (Enter to rewind, Esc to cancel)`                                |
| Model / effort selector         | `select model (Esc to cancel)` / `select effort level (Esc to cancel)`              |

The "several questions" navigation segment is the labels of
`app.question.nextTab`, `tui.select.up`, `tui.select.down` joined by `/`
(undefined ones dropped); with one question, or while the free-text row
is focused (where tab keys go to the input), it uses only up/down. In
the tree and model/effort selectors, the parenthesised list omits
undefined segments and is dropped entirely when empty.

The preview layout's "Notes: press n to add notes" placeholder uses the
`app.question.notes` label; when that action is unbound the line reads
`Notes:`.

The `←  …  →` arrows framing the question tab bar are decoration copied
from native, not a hint, and stay literal.

### Key routing

`handleGlobalKey` runs before the focused dialog and keeps its current
precedence (interrupt, tools/thinking toggles, detach, …); this spec
governs only the keys it passes on. While a dialog has a focused text
input, the dialog checks only its reserved actions for that state and
forwards every other key to the input. pi `Input` does not report
whether it handled a key, so child-first routing with bubbling is not
available; the reserved set is the dialog's declaration of what it
keeps.

| State                             | Reserved by the dialog                               | Input handlers                                                    |
| --------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Question: free-text ("Other") row | `tui.select.{up,down,cancel}`, `app.editor.external` | `onSubmit` commits the row (today's confirm on that row)          |
| Question: notes mode              | `app.editor.external`                                | `onSubmit` = today's notes-mode confirm; `onEscape` → select mode |
| Permission: amend input           | `app.editor.external`                                | existing `onSubmit` / `onEscape`                                  |

`app.editor.external` in a text input opens the input's text in the
external editor (as notes mode does today) and, when the editor returns
text, replaces the input's value with it — updating the answer on the
free-text row as typing would. This is new for the free-text row and the
amend input (native has no equivalent; a deliberate improvement). On the
plan dialog, ctrl+g on the option rows still edits the plan file; with
the amend input open it edits the amend text. `handleGlobalKey` already
passes ctrl+g through in both states (it defers while the amend input
`capturesEscape`, and returns undefined for a question dialog).

Consequences: on the free-text row, left/right move the text cursor,
Tab/Shift+Tab do nothing (pi `Input` drops keys it has no binding for),
and the input's own editing bindings apply.

Answer state follows the input text, and a submit acts on the current
text: an `onSubmit` fired during forwarding sees the typed text in the
answer, and nothing after the forwarded call overwrites what the submit
did (a multi-select toggle, a tab switch, advancing past the last
question's notes).

Question dialog outside those states dispatches on
`tui.select.{cancel,up,down,confirm}`, `app.question.{nextTab,previousTab}`
(only with more than one question), digit shortcuts,
`app.question.toggle` (multi-select option rows) and `app.question.notes`
(preview layout), in today's order and with today's conditions.

The permission dialog replaces `matchesKey(data, "tab")` with
`app.permission.amend`; the tree selector replaces
`matchesKey(data, "backspace")` with `tui.editor.deleteCharBackward`
(the binding pi `Input` uses for the same edit). After this change no
`matchesKey` call remains in `src/` outside tests.

### Type design

`src/tui/keybindings.ts`:

```ts
declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    // …existing app.* ids…
    "app.question.nextTab": true;
    "app.question.previousTab": true;
    "app.question.toggle": true;
    "app.question.notes": true;
    "app.permission.amend": true;
  }
}

export const CLAUCTL_KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  // …existing app.* entries…
  "app.question.nextTab": { defaultKeys: ["tab", "right"], description: "…" },
  "app.question.previousTab": { defaultKeys: ["shift+tab", "left"], description: "…" },
  "app.question.toggle": { defaultKeys: "space", description: "…" },
  "app.question.notes": { defaultKeys: "n", description: "…" },
  "app.permission.amend": { defaultKeys: "tab", description: "…" },
} satisfies KeybindingDefinitions;

/** The first key bound to `keybinding`, as hints display it; undefined
 *  when the action is unbound. */
export function keyLabel(
  keybindings: KeybindingsManager,
  keybinding: Keybinding,
): string | undefined;

/** `"<key> <text>"` for each `[keybinding, text]` hint segment, dropping
 *  unbound actions; the caller joins them. */
export function keyHints(
  keybindings: KeybindingsManager,
  segments: ReadonlyArray<readonly [Keybinding, string]>,
): string[];
```

`KeybindingsManager` and `Keybinding` become value/type imports from
pi-tui as needed. Callers pass `getKeybindings()`.

Changed, no new public symbols:

- `QuestionPromptComponent`: constructor wires `onSubmit` on each
  `otherInputs[i]` and `onSubmit`/`onEscape` on each `notesInputs[i]`.
  `handleInput` follows Key routing; `hint()` uses `keyHints` (and `keyLabel`
  for the navigation segment); the notes placeholder uses `keyLabel`. The `matchesKey` import goes.
- `PermissionPromptComponent`: the constructor gains a trailing
  `editText: (text: string) => Promise<string | undefined>` parameter,
  the same callback `QuestionPromptComponent` already takes;
  `syncPermissionPrompt` passes `(text) => this.editTextExternally(text)`
  to both. `handleInput` / `render`: amend action, ctrl+g in the amend
  input, and hints as above. The `matchesKey` import goes.
- `TreeSelectorComponent.handleInput` / `render`: backspace and hint as
  above. The `matchesKey` import goes.
- `ModelSelectorComponent`, `EffortSelectorComponent` constructors: hint
  via `keyHints`.

### Data flow

Unchanged: key → `handleGlobalKey` → focused dialog → reserved action, or
forwarded to the focused `Input`. Hints read the global manager at render
time (model/effort selectors at construction, as today).

### Cost

Negligible: a few map lookups per render. Review effort belongs on the
new action ids — they become part of users' `keybindings.json` and are
expensive to rename.

### Edge cases

- Unbound action (`[]` in `keybindings.json`): its hint segment
  disappears and its keys no longer trigger it — except that pi `Input`
  still submits on raw LF with `tui.input.submit` unbound.
- An `app.question.*` / `app.permission.amend` remap onto a key
  `handleGlobalKey` consumes (e.g. `ctrl+o`) never reaches the dialog;
  the hint still shows it. Same as any existing remap onto a global key.
- A user override making `app.question.nextTab` collide with a reserved
  free-text-row action (e.g. `down`): on that row the reserved action
  wins; elsewhere today's dispatch order decides. Conflict banners cover
  overlaps among user overrides only, as today.
- Remapping `tui.select.confirm` does not change how the free-text row or
  notes input commit; they follow `tui.input.submit`, as every text field
  does.

### Non-goals

- Digit shortcuts stay hard-coded.
- Per-component key namespaces with links to shared defaults
  (`app.question.up` → `tui.select.up`) and components receiving their
  prefix-stripped subtree: future work, recorded in
  `docs/follow-ups/config-compilation.md`.
- The interactive-mode TDCs (dialog slot naming, delegation) belong to
  `docs/follow-ups/interactive-mode-split.md`.
- Hints outside the dialogs above (e.g. interactive-mode's detach
  banner) keep their current rendering.

## IMPLEMENTATION IDEAS

- `keyLabel`'s display map is a module-level `Record<string, string>`;
  unmapped keys pass through.
- The notes-mode confirm body moves into a private method called by the
  notes inputs' `onSubmit`.
- pi `Input` has no `onChange`, so today's answer sync runs after
  forwarding (`setAnswer` from `getValue()`). With submits now firing
  inside the forwarded call, the post-forward sync runs only when the
  input's value changed, for the question index captured before
  forwarding: a key either edits or submits, never both. Test: multi-select
  Other deselected via Enter stays deselected; Enter in the last
  question's notes advances to the Submit tab without throwing.
- Existing tests in `question-prompt.test.ts` and
  `interactive-mode.permission.test.ts` install
  `new KeybindingsManager(CLAUCTL_KEYBINDINGS, {})` globally; remap tests
  can `setKeybindings` a manager with user bindings and restore the
  default afterwards.
- Tests to add: `keyLabel` display forms and the unbound case
  (`keybindings.test.ts`); remapped `app.question.nextTab` switches tabs
  and changes the hint; left/right on the free-text row move its cursor;
  Tab there is a no-op; Enter there commits via `onSubmit`; remapped
  `app.permission.amend` opens the amend input.
- Doc updates in `tui-keybindings.md`: action-set table gains the five
  ids; criterion 1 loses the backspace exception (printable search input
  stays exempt); criterion 5 points at `keyLabel`.
- Remove both TDCs in `question-prompt.ts`; delete
  `docs/follow-ups/keybindings-select.md` once implemented (this spec is
  the record); update the tree selector's `handleInput` comment.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] `keybindings.ts`: five ids + `keyLabel`, with tests
- [x] `question-prompt.ts`: key routing, hints, ctrl+g on the free-text row, TDCs removed
- [x] `permission-prompt.ts`: `app.permission.amend`, hints, ctrl+g in the amend input (`editText` ctor param)
- [x] `tree-selector.ts`, `model-selector.ts`, `effort-selector.ts`: hints, backspace
- [x] `tui-keybindings.md` updates; `docs/follow-ups/keybindings-select.md` deleted, references in `ask-user-question.md` and `input-slot-dialogs.md` repointed here
- [x] `npm run ready` (939 tests pass)

## Implementation-Time Decisions (2026-10-09)

- **Answer sync on text change, no submit flag.** `forwardToInput` syncs
  the answer only when the input's value changed across the forwarded
  key. pi `Input` either edits or submits for a given key, never both, so
  a submit's effects (multi-select toggle, tab switch) are never
  overwritten, and no flag is needed. `setAnswer` and the two sync
  helpers take an explicit question index, because the external-editor
  callback resolves after the active tab may have changed.
- **Existing test changed:** "revisiting a tab keeps the Type something
  text cursor at its end" pressed Tab on the free-text row; it now leaves
  the row first (criterion 6).
- **`KEY.left`/`KEY.right`** added to the shared `src/test-support/keys.ts`.
- **`keyHints` added to the type design** (Anton, review of the first
  implementation): the "segments → labelled strings, drop unbound" builder
  had been inlined in the question, permission and tree hints, against
  the approved no-helper design. It is now `keyHints` in `keybindings.ts`,
  used by every hint, including the model and effort selectors.
