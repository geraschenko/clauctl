# Spec: The input slot and its occupants

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

Task tg c60bca6d. Starts from docs/follow-ups/input-slot-dialogs.md and
the five `TDC:` comments in `src/tui/interactive-mode/interactive-mode.ts`.

## SPEC (stable requirements)

### Problem

`InteractiveMode` knows too much about the components that replace the
editor:

- `permissionPrompt` names a field that also holds the question prompt.
- `syncPermissionPrompt` builds the dialog inline and picks the component
  by "questions undefined ⇒ permission prompt".
- `handleGlobalKey` reads dialog internals: `capturesEscape`, and
  `instanceof PermissionPromptComponent` plus `.dialog.planFilePath` to
  route ctrl+g.
- The model, effort and tree selectors mount in `statusContainer`, above
  the editor, which stays visible. Each has its own field, its own
  `close…` method and its own check in `handleGlobalKey`.

### Model (Anton, 2026-10-10)

The input slot shows exactly one **occupant**: the prompt editor, a
selector, or an ask prompt. Apart from three global keys (detach,
tools.expand, thinking.toggle), every key reaches the occupant through
focus, and the occupant handles it. An occupant that must be able to
interrupt the agent, cycle the permission mode or edit text externally
gets a callback for that ability. `InteractiveMode` decides which
occupant is in the slot and dispatches on the occupant's `kind`. It
knows nothing else about an occupant beyond pushing it data
(`pendingCount`, the tree selector's warning).

The editor differs from other occupants in one way only: its instance
lives in a field across occupancies, so text typed before an ask arrived
survives it.

A component with many actions takes them as one callback object, whose
definition lists what that component can do. Components with two
callbacks (the selectors) keep them positional.

### Success criteria

1. **One occupant.** The slot (`inputSlot`) holds exactly one component
   at a time, and `InteractiveMode` tracks it in one field,
   `inputSlotOccupant`. The selectors mount in the slot, replacing the
   editor; `statusContainer` holds only the activity loader.
2. **Keys by focus.** `handleGlobalKey` consumes only `app.detach`,
   `app.tools.expand` and `app.thinking.toggle`, and clears the hint text
   on every other key. Every other key goes to whatever pi-tui dispatches
   it to: the focused occupant, unless the fullscreen renderer's own
   listener or its focused transcript-search overlay takes it first (as
   today, that listener runs before ours).
3. **Occupants own their keys.**
   - `PromptEditor` handles `app.interrupt` (unless its autocomplete
     popup is showing, or the `interrupt` action reports nothing to
     interrupt: then the key reaches pi-tui's `Editor` as today, e.g.
     cancelling its jump mode), `app.permissionMode.cycle`,
     `app.editor.external` and `app.clear`.
   - `PermissionPromptComponent` handles `app.interrupt` outside its
     amend input, and `app.editor.external` on a plan dialog in rows
     mode (`editPlan`) as well as in the amend input (`editText`, as
     today).
   - `QuestionPromptComponent` handles `app.interrupt` outside notes
     mode, on every row including the free-text row. Its
     `app.editor.external` handling (notes and the free-text row) is
     unchanged.
   - The selectors are unchanged (the tree selector's first Esc clears a
     non-empty search; Esc otherwise cancels).
   - `capturesEscape` is deleted from both prompts.
4. **One dispatch from ask to occupant.** `askPromptOccupant` is the only
   place that maps a pending ask to an occupant.
5. **Last selector command wins.** The commands that open a selector
   (bare `/model`, bare `/effort`, `/tree`) each supersede any selector
   fetch still pending, at command entry, whether or not they end up
   mounting anything (`/tree` with no session file still supersedes).
   Mounting an ask prompt supersedes it too. A superseded fetch mounts
   nothing, but its failure still shows its banner (Anton: the user may
   have moved on because something seemed wrong). The direct forms
   (`/model NAME`, `/effort LEVEL`) open no selector, so they neither
   supersede nor are superseded; `/effort LEVEL` validates and sends
   whatever occupies the slot by the time its fetch returns.
6. **Behaviour is otherwise unchanged**, except for the changes listed
   below. All existing tests pass with only constructor-call updates;
   `npm run ready` passes.

### Behaviour changes (approved)

- A selector replaces the editor instead of showing above it.
- `app.permissionMode.cycle` (shift+tab) works only while the editor is
  the occupant. Today it also works with a selector open. (The question
  prompt needs shift+tab for its tabs.)
- Esc while the editor's autocomplete popup is showing closes the popup
  instead of interrupting a busy agent (as pi does).
- `/model` then `/tree` (before the model list arrives): today both
  selectors could show; now the tree selector shows and the model list is
  dropped. `/model` then `/effort` likewise shows only the effort
  selector.

Consequences of the approved model, found in review:

- While the fullscreen transcript search has focus, shift+tab and
  ctrl+c (clear) no longer act on the editor; today `handleGlobalKey`
  applied them regardless of focus. (ctrl+g there is already search's
  `searchNext`.)
- Conflicting user bindings: see Edge cases.
- `/model`, then an ask arrives and resolves before the model list
  does: today the selector then opens; now the ask's mount superseded
  it. A second bare `/model` while the first fetch is pending: today
  ignored; now it refetches and the first result is dropped.
- `/effort LEVEL` whose fetch returns while an ask prompt is up: today
  dropped silently; now it validates and sends (it mounts nothing).
- Interrupt, permission-mode cycle and ctrl+g now clear the hint text;
  today, being consumed globally, they did not.
- A plan edit finishing after its ask lost the head no longer remounts
  the newer head's prompt (losing its in-progress state); see Data flow.

### Type design

`src/tui/components/prompt-editor.ts` (new):

```ts
/** What the prompt editor can do beyond editing text. */
export interface PromptEditorActions {
  /** app.interrupt; false when there is nothing to interrupt, and the
   *  key then reaches pi-tui's Editor. */
  interrupt(): boolean;
  cyclePermissionMode(): void; // app.permissionMode.cycle
  editExternally(): void; // app.editor.external
  onCleared(): void; // app.clear, after the editor emptied itself
}

/** The editor the user types prompts into, with the app actions that
 *  apply while it occupies the input slot. */
export class PromptEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, actions: PromptEditorActions);
  override handleInput(data: string): void;
}
```

`app.clear` is the editor's own text operation: it adds non-blank text to
its history, empties itself, then calls `onCleared`. `onSubmit` stays
pi-tui's `Editor.onSubmit` property.

`src/tui/components/permission-prompt.ts`:

```ts
export interface PermissionPromptActions {
  decide(decision: PermissionResult, feedback?: string): void;
  editText(text: string): Promise<string | undefined>;
  editPlan(planFilePath: string): void;
  interrupt(): void;
}

export class PermissionPromptComponent extends Container implements Focusable {
  pendingCount: number;
  constructor(
    dialog: PermissionDialog, // now private
    pendingCount: number,
    actions: PermissionPromptActions,
  );
  // capturesEscape: deleted
}
```

`src/tui/components/question-prompt.ts`:

```ts
export interface QuestionPromptActions {
  decide(decision: PermissionResult): void;
  editText(text: string): Promise<string | undefined>;
  interrupt(): void;
}

export class QuestionPromptComponent extends Container implements Focusable {
  pendingCount: number;
  constructor(
    input: AskUserQuestionInput,
    titleSuffix: string | undefined,
    pendingCount: number,
    actions: QuestionPromptActions,
  );
  // capturesEscape: deleted
}
```

`src/tui/interactive-mode/interactive-mode.ts`:

```ts
/** What the input slot shows: the prompt editor, or what replaces it. */
type InputSlotOccupant =
  | { kind: "editor" }
  | { kind: "modelSelector"; selector: ModelSelectorComponent }
  | { kind: "effortSelector"; selector: EffortSelectorComponent }
  | { kind: "treeSelector"; selector: TreeSelectorComponent }
  | {
      kind: "permissionPrompt";
      toolUseId: string;
      prompt: PermissionPromptComponent;
    }
  | {
      kind: "questionPrompt";
      toolUseId: string;
      prompt: QuestionPromptComponent;
    };

class InteractiveMode {
  private readonly editor: PromptEditor;
  private inputSlotOccupant: InputSlotOccupant = { kind: "editor" };
  /** Identifies the latest selector command whose fetch is in flight;
   *  a fetch result mounts only while its token is still this one. */
  private pendingSelectorRequest: object | undefined;

  /** Swap the slot's component for the occupant's, focus it, render. */
  private occupyInputSlot(occupant: InputSlotOccupant): void;
  /** Was syncPermissionPrompt. No ask pending: clear `planEdits`, and
   *  restore the editor if (only if) an ask prompt occupies the slot.
   *  Head unchanged: update `pendingCount`. Else `showAskPrompt`. */
  private syncAskPrompt(state: AgentState): void;
  /** Mount the head ask's prompt (superseding any selector fetch); also
   *  the remount after a plan edit. */
  private showAskPrompt(asks: readonly PendingAsk[]): void;
  /** The occupant for an ask: question prompt for AskUserQuestion
   *  (`askUserQuestionInput` defined), permission prompt otherwise. */
  private askPromptOccupant(
    ask: PendingAsk,
    pendingCount: number,
  ): Extract<InputSlotOccupant, { kind: "permissionPrompt" | "questionPrompt" }>;
  /** Send `interrupt`; failures ignored, as today. */
  private interrupt(): void;
}
```

Removed from `InteractiveMode`: the fields `permissionPrompt`,
`promptedToolUseId`, `modelSelector`, `treeSelector`, `effortSelector`,
`modelSelectorPending`, `effortSelectorPending`; the methods
`syncPermissionPrompt` (renamed), `closeModelSelector`,
`closeEffortSelector`, `closeTreeSelector` (a selector closes with
`occupyInputSlot({ kind: "editor" })`). `openPlanEditor(toolUseId,
planFilePath)` keeps its signature; see Data flow for what a finished
edit does.

`askUserQuestionInput` (`src/tui/question-dialog.ts`) is unchanged: its
tool-name check is the dispatch, and it hands back the typed input in
the same step.

Unchanged: the selector components, `layout.ts`'s structure
(`TuiParts.inputSlot`'s doc comment now says it holds the occupant).

### Data flow

Occupant transitions, all through `occupyInputSlot`:

| From          | Event                                               | To             |
| ------------- | --------------------------------------------------- | -------------- |
| editor        | `/tree` (synchronous; supersedes a pending fetch)   | treeSelector   |
| editor        | `/model` fetch returns, token current               | modelSelector  |
| editor        | `/effort` fetch returns, token current              | effortSelector |
| any selector¹ | pick or cancel                                      | editor         |
| any           | `syncAskPrompt`: new head ask (clears the token)    | ask prompt     |
| ask           | `syncAskPrompt`: head unchanged → `pendingCount`    | (same)         |
| ask           | plan edited (`openPlanEditor`)                      | ask prompt     |
| ask           | `syncAskPrompt`: no ask pending (`planEdits` clear) | editor         |

¹ `modelSelector`, `effortSelector` or `treeSelector`. A tree pick goes through `confirmTreePick` as today.

A selector's pick and cancel callbacks only run while it has focus, so
it is always the current occupant when it closes; no token is needed on
the close side.

Outcomes with no transition: a selector fetch that fails (banner,
superseded or not) or succeeds after being superseded; `/tree` with no session file (banner);
`/effort LEVEL` (banner or send); a tree pick while busy (hint).

The selector token: a selector command creates a fresh token and stores
it in `pendingSelectorRequest` (or, for `/tree`, clears it). Its fetch
callbacks first check identity. Success: if `pendingSelectorRequest` is
no longer their token they do nothing; else they clear it and mount.
Failure: clear it only if it is still their token; banner either way.

A finished external edit, whatever occupies the slot by then:

- prompt text (`openExternalPromptEditor`): `editor.setText` on the
  persistent editor, as today; no focus change, so an ask prompt that
  arrived meanwhile keeps the slot and the text waits underneath.
- plan (`openPlanEditor`): the edit is stored in `planEdits` only if
  `toolUseId` is still among `allPendingAsks(agentState)` (a resolved
  ask does not regain an entry); the prompt is remounted
  (`showAskPrompt`) only if the occupant is that ask's prompt. A
  still-pending ask that lost the head shows the edit when it regains
  it, as today.

Callback wiring (`InteractiveMode` → occupant):

- editor: `interrupt` → `interrupt()` and true, or false when
  `isIdle(agentState)` (no ask can be pending while the editor is the
  occupant); `cyclePermissionMode`
  → `cyclePermissionMode()`; `editExternally` →
  `openExternalPromptEditor()` with failures bannered, as today;
  `onCleared` → the "detach with …" hint.
- permission prompt: `decide` → `sendPermissionResponse(toolUseId, …)`;
  `editText` → `editTextExternally`; `editPlan` → `openPlanEditor(toolUseId, …)`
  with failures bannered; `interrupt` → `interrupt()`.
- question prompt: `decide`, `editText`, `interrupt` likewise.

### Cost

Nothing material at runtime: one object per occupancy change. Review
should concentrate on key routing (criterion 3), where the global
listener's checks become per-component key handling, and on the
supersede rule (criterion 5).

### Edge cases

- Ask prompt key order: `app.interrupt` is checked before
  `tui.select.cancel`, so in rows/selection mode Esc interrupts while
  ctrl+c sends the dialog's `cancelDecision` / `CANCEL_DENY`, as today.
  In the amend input and notes mode both leave the input mode, as today.
- `PromptEditor` with the autocomplete popup showing passes
  `app.interrupt` to `Editor`, which closes the popup when the key is
  also `tui.select.cancel` (as with the default Esc).
- When a user binds a global action and an occupant action to the same
  chord, the global action wins. Today the order was mixed (interrupt
  and mode cycle preceded tools/thinking; clear and ctrl+g preceded
  detach).
- The question prompt's free-text row forwards keys to its input; the
  interrupt check comes before that forwarding (Esc on that row
  interrupts today).
- `contextChanged` with the tree selector open: `setWarning` on the
  `treeSelector` occupant, as today.
- A `/model` fetch completing while an ask prompt is up: dropped (the
  prompt's mount superseded it); the existing test keeps passing.

### Non-goals

- The class split and the slash-command registry
  (docs/specs/interactive-mode-class-split.md,
  docs/follow-ups/slash-command-registry.md).
- The tree selector's planned full-view redesign; that is a layout
  question, not an occupant one.
- Callback objects for the selectors (two callbacks each).

## IMPLEMENTATION IDEAS

- `PromptEditor.handleInput`: check the four app keybindings via
  `getKeybindings()` (as the prompts do), `app.interrupt` only when
  `!this.isShowingAutocomplete()`, then `super.handleInput(data)`.
- Prompts: in the non-text-input branch of `handleInput`, check
  `app.interrupt` first. `PermissionPromptComponent` rows mode: on
  `app.editor.external`, call `editPlan(dialog.planFilePath)` when the
  dialog has one.
- The global ctrl+g logic (`promptOpen && planFilePath === undefined →
  fall through`) disappears: occupants that do not handle ctrl+g just
  ignore it.
- Tests:
  - update constructor calls in `permission-prompt.test.ts` and
    `question-prompt.test.ts`;
  - `interactive-mode.permission.test.ts`: the two Esc tests keep their
    assertions (they now exercise the components' own handling);
  - new, routing (default keys): `PromptEditor` Esc busy interrupts,
    idle falls through (jump mode cancelled), with autocomplete showing
    closes the popup; a selector replaces the editor and Esc restores it
    with its text intact; ctrl+g on a plan dialog calls `editPlan`;
    Esc interrupts from permission rows and from the question prompt's
    free-text row;
  - new, deferred operations: `/model` then `/tree` leaves the tree
    selector up after the model list arrives; `/model`, ask arrives and
    resolves, model list arrives → no selector; a superseded fetch's
    failure still adds its banner and leaves a newer token in place; `/effort LEVEL` returning under an ask
    prompt still sends; a plan edit finishing after its ask lost the
    head does not remount the new head's prompt.
- Docs: delete `docs/follow-ups/input-slot-dialogs.md` (this spec
  supersedes it). (`interactive-mode-class-split.md` already points
  here and at `slash-command-registry.md`.)
- Remove the five TDCs as their points are addressed.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] `PromptEditor` (components/prompt-editor.ts)
- [x] Permission/question prompts: actions objects, own `app.interrupt`,
      permission prompt's plan ctrl+g; `capturesEscape` deleted
- [x] `InteractiveMode`: occupant union, `occupyInputSlot`,
      `syncAskPrompt`/`showAskPrompt`/`askPromptOccupant`, selector token,
      `handleGlobalKey` reduced to the three global keys, `openPlanEditor`
      store/remount rule; all five TDCs gone
- [x] `npm run ready`: 940 pass
- [x] New tests: prompt-editor.test.ts (Esc busy / idle via jump mode /
      autocomplete); permission-prompt.test.ts (plan ctrl+g);
      question-prompt.test.ts (Esc from option and free-text rows);
      interactive-mode.permission.test.ts (selector replaces editor, the
      four token tests, plan-edit remount). Plan-edit test
      mutation-checked: an unconditional remount fails it.
- [x] Deleted docs/follow-ups/input-slot-dialogs.md, references in
      ask-user-question.md and permission-amend-allow.md repointed here;
      layout.ts `inputSlot` doc comment
- [x] Critical review (review.md); fixes below; `npm run ready`: 951 pass

## Implementation-Time Decisions (2026-10-10)

- **Two component tests now cancel with ctrl+c, not Esc** (departure
  from criterion 6's "only constructor-call updates"). They fed Esc to
  a prompt directly and expected `cancelDecision`; in the app Esc never
  got there (the global interrupt consumed it first). With the prompts
  owning `app.interrupt`, Esc in a unit test now does what it does in
  the app, so the tests use ctrl+c (`tui.select.cancel`'s other default,
  the key that reaches `cancelDecision` in the app) and the permission
  test also asserts Esc interrupts. Added `KEY.ctrlC`.
- **`occupantComponent(occupant, editor)`** is a module-level function
  in interactive-mode.ts (the editor instance is the one occupant whose
  component is not in the union value).
- **`/model` then `/tree` is tested without a session file** (departure
  from the IMPLEMENTATION IDEAS wording "leaves the tree selector up"):
  the harness has no file session model, and criterion 5 says `/tree`
  supersedes even when it mounts nothing, so the test asserts the
  "no session file" banner and no model selector.
- **The plan-edit test types into the newer prompt while the external
  editor (`EDITOR=true`) runs**, standing in for the newer prompt's
  in-progress state; the test harness keeps delivering keys during
  `ui.stop`, which a real terminal would not.
- **Review fixes:** `openExternalPromptEditor` and `openPlanEditor`
  report their own failures as a banner (as `editTextExternally`
  already did), so the editor's `editExternally` and the prompt's
  `editPlan` wiring don't each repeat the catch. The comment on why an
  ask is interruptible with the main loop idle moved from
  `handleGlobalKey` to the prompts' `interrupt` wiring.
- **Anton's review (commit 4e76ce9 TDCs):** `selector` split into
  `modelSelector` and `effortSelector` variants (kinds name what an
  occupant is, not whether `InteractiveMode` treats them alike);
  `occupantComponent` returns each variant's field in its own case. The
  `openExternalPromptEditor` doc no longer cites a WORK LOG; the
  events-while-editing fact moved to `editFileInExternalEditor`, where
  every external-editor path shares it.
- **Doc comments revised after approval** (the type design above keeps
  the approved text): `syncAskPrompt` states its contract (show the head
  ask's prompt, or give the slot back to the editor; call on every state
  change) instead of its steps; `pendingSelectorRequest` explains why
  the token is an object compared by identity rather than a boolean
  (Anton's review question).
