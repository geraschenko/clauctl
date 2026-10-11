# Spec: Split the InteractiveMode class

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

Starts from docs/follow-ups/interactive-mode-class-split.md (deleted when
this spec lands). Comes after the input-slot task (docs/specs/input-slot.md).

## SPEC (stable requirements)

### Problem

`src/tui/interactive-mode/interactive-mode.ts` is about 1230 lines. Units
with a meaning of their own sit inside the class, so a reader must open
method bodies to see how it works.

### Rule (Anton, 2026-10-09)

`interactive-mode.ts` should shrink, and a reader should see how it works
from the names and signatures of what it contains. A helper moves to its
own file when it has a meaning of its own and its signature makes plain
what it does, even with one user. `resolutionBanner` is the model case.

### Success criteria

1. The six extractions below exist with exactly the approved type design;
   each new file lives in `src/tui/interactive-mode/` (internal to the
   barrel; `index.ts` unchanged).
2. `InteractiveMode` keeps no copy of extracted logic: it calls the new
   symbols and acts on what they return.
3. Behaviour is unchanged except for the one approved change below.
4. New unit tests (listed in IMPLEMENTATION IDEAS) pass; all existing
   tests pass unchanged; `npm run ready` passes.

### Behaviour change (approved)

- `/keybindings`: the "defaults refresh skipped" warning is shown when the
  flow finishes (with the other returned banners), so it lands after any
  agent events that arrived while the editor ran; today it is added
  before the editor opens.

### Type design (approved 2026-10-10)

`permission-mode-cycle.ts`:

```ts
/** The mode after the agent's current one: default, plan, acceptEdits,
 *  auto, then any other modes the agent has reported, without repeats. */
export function nextPermissionMode(state: AgentState): PermissionMode;
```

`cyclePermissionMode` keeps the request and its failure banner.

`effort-levels.ts`:

```ts
export type EffortLevelsLookup =
  | { kind: "unknownModel" }
  | { kind: "noEffortLevels" }
  | { kind: "levels"; model: ModelInfo; levels: EffortLevel[] };
export function effortLevelsOf(
  models: readonly ModelInfo[],
  currentModel: string | undefined,
): EffortLevelsLookup;
```

`model` is there for the invalid-level banner's `displayName`. The
comment on matching both `value` and `resolvedModel` moves here.
`handleEffortCommand` switches on `kind`, calling `effortLevelsOf` where
it reads `this.agentState.model` today: when the models fetch returns,
after the selector-token check, not at submit.

`held-live-events.ts`:

```ts
/** Live events held back while history replays, so live output cannot
 *  interleave with or precede the replayed transcript. */
export class HeldLiveEvents {
  hold(event: AgentEvent, state: AgentState): void;
  /** Once `position` events are held: the state they folded to
   *  (`seed` when position is 0). */
  stateAtCut(position: number, seed: AgentState): Promise<AgentState>;
  /** Everything held, in arrival order. */
  readonly events: readonly (readonly [AgentEvent, AgentState])[];
}
```

`InteractiveMode`: `liveEventsDuringReplay`, `cutAwaiter`, `bufferedUpTo`
and `stateAtCut` are replaced by one field,
`heldLiveEvents: HeldLiveEvents | undefined`, created at construction
(`reloadHistory` runs once); `reloadHistory`'s own reset (`= []`) is
dropped. The release order stays as today: `applySnapshot` while still
replaying, then take `events`, set the field to `undefined`, and only
then `applyState` each held event (held events are not observed or
rendered again). `stateAtCut` returns a promise that resolves directly
to the cut state (no extra internal `await`), so the wait costs no more
microtask turns than `bufferedUpTo` did. It supports one outstanding
wait, the only caller's; its doc comment says so. "Replaying"
is `heldLiveEvents !== undefined` (`handleEvent`, `onResolved`,
`onContextChanged`). The cut-wait comment (`eventsBefore` runs ahead of
the pump; a shutdown inside the cut is never held, so the wait stays
pending) moves to `stateAtCut`. `reloadHistory` passes `this.agentState`
as `seed`: nothing folds into it while events are held, so it is still
the seed state.

`keybindings-commands.ts`:

```ts
export interface Banner { text: string; color: ThemeColor }
/** `/keybindings`: refresh defaults, edit, promote edited defaults, reload. */
export function editKeybindings(
  ui: TUI,
  keybindings: KeybindingsManager,
): Promise<Banner[]>;
/** `/reload-keybindings`: re-read the config into the live manager. */
export function reloadKeybindings(keybindings: KeybindingsManager): Banner[];
```

No banner type exists today (`Transcript.addBanner` takes `text, color`),
so `Banner` lives here, beside its one producer; it moves upstream when a
second producer appears. Both functions read the editor command and
`keybindingsPath()` themselves, as today. The existing doc comments on
`openKeybindingsEditor` / `reloadKeybindings` move with the code (the
"TUI suspended" wording becomes "TUI stopped").

`input-slot-occupant.ts`: `InputSlotOccupant` and `occupantComponent`
move here unchanged and are exported, plus

```ts
export type AskPromptOccupant = Extract<
  InputSlotOccupant,
  { kind: "permissionPrompt" | "questionPrompt" }
>;
```

`ask-prompt.ts`:

```ts
/** What an ask prompt can have InteractiveMode do, for the ask it shows. */
export interface AskPromptHandlers {
  respond(toolUseId: string, decision: PermissionResult, feedback?: string): void;
  editText(text: string): Promise<string | undefined>;
  editPlan(toolUseId: string, planFilePath: string): void;
  interrupt(): void;
}
/** The prompt for `ask`: the question prompt when
 *  `askUserQuestionInput(ask.request)` is defined, the permission prompt
 *  otherwise. */
export function askPromptOccupant(
  ask: PendingAsk,
  pendingCount: number,
  cwd: string | undefined,
  editedPlan: string | undefined,
  handlers: AskPromptHandlers,
): AskPromptOccupant;
```

`InteractiveMode` gains `private readonly askPromptHandlers:
AskPromptHandlers`, built once in the constructor; the comment on why an
ask is interruptible with the main loop idle stays on its `interrupt`.
`showAskPrompt` calls `askPromptOccupant(head, asks.length,
this.agentState.cwd, this.planEdits.get(toolUseId), this.askPromptHandlers)`.
The private method `askPromptOccupant` is removed.

### Data flow

Unchanged, except the `/keybindings` banner timing above. Callers add
the returned banners in order, then request one render
(`editFileInExternalEditor` still restarts and re-renders the TUI
itself). `editKeybindings` returns banners in the order they arise: the
refresh warning, the nonzero-exit warning or the promotion warnings /
promotion error, then `reloadKeybindings`' banners; an early return
keeps what accumulated before it. "keybindings reloaded" stays dim.

### Cost

No material runtime cost: the handlers object and the `HeldLiveEvents`
instance are built once; the banner arrays are per command.

### Comments that move or stay

- Moves: the `InputSlotOccupant` doc comment; the `value`/`resolvedModel`
  matching comment; the keybindings doc comments (the reload one names
  `editKeybindings` instead of `openKeybindingsEditor`); the cut-wait
  comment.
- Stays in `interactive-mode.ts`: `handleEvent`'s shutdown-bypass and
  observe-before-hold comments; `cyclePermissionMode`'s comment on the
  request (no optimistic footer update); the interruptible-while-idle
  comment, on `askPromptHandlers.interrupt`.

### Non-goals

- The slash-command registry (docs/follow-ups/slash-command-registry.md,
  no task).
- Renaming `reloadHistory` or other members not listed.

## IMPLEMENTATION IDEAS

- One logical change per extraction, each passing `npm run ready`.
- Tests (new files beside the new modules):
  - `nextPermissionMode`: dedup of observed modes already in the base
    cycle; wraps from the last mode to `default`; unknown current mode.
  - `effortLevelsOf`: unknown model, model without levels, levels;
    matching via `resolvedModel`.
  - `HeldLiveEvents`: `stateAtCut` resolves at once when enough events
    are held, later when they arrive; position 0 returns the seed; the
    state returned is the one at the cut, not the latest held.
  - `askPromptOccupant`: AskUserQuestion ask → `questionPrompt`; other
    ask → `permissionPrompt` whose title carries the task suffix; a
    decision reaches `respond` with the ask's `toolUseId` (and feedback);
    ctrl+g on a plan dialog reaches `editPlan` with the `toolUseId`.
  - `editKeybindings` / `reloadKeybindings` (signatures unchanged; the
    test points `CLAUCTL_CONFIG_DIR` at a temp dir and sets `EDITOR`,
    restoring both, as interactive-mode.permission.test.ts does for
    `EDITOR`): no editor command → the "set $EDITOR" warning only;
    editor exits nonzero → the "changes not applied" warning, no reload;
    a fatal read keeps the live bindings and returns the error banner;
    a clean reload returns dim "keybindings reloaded"; read warnings
    come back as "keybindings: …" warnings.
- Delete docs/follow-ups/interactive-mode-class-split.md; repoint
  references (grep the docs).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Type design approved by Anton (2026-10-10)
- [x] Critique pass (2026-10-10): pinned the `HeldLiveEvents` seed and
      the dropped reset; `Banner` co-located (no existing type).
- [x] Reviewer pass (pictl 66e7bb66): pinned the release order (field
      cleared before held state applies), the no-extra-await `stateAtCut`,
      the single waiter, the effort lookup's timing, banner order, the
      discriminator wording, and comment placement; widened the
      ask-prompt tests. Not taken: integration tests of `reloadHistory`
      with a nonzero cut (existing behaviour, untested today, outside a
      move-only refactor; the `HeldLiveEvents` unit tests cover the new
      seam).
- [x] Decisions (Anton, 2026-10-10): add the keybindings tests (via the
      environment, signatures unchanged); keep `syncAskPrompt`'s
      ask-prompt kind check inline (no `isAskPromptOccupant`).
- [x] Implementation started (2026-10-10). Done, each typechecked with its
      tests green: permission-mode-cycle, effort-levels, held-live-events.
- [x] keybindings-commands, input-slot-occupant, ask-prompt, with tests;
      deleted docs/follow-ups/interactive-mode-class-split.md and
      repointed docs/specs/input-slot.md (non-goals) and
      docs/follow-ups/slash-command-registry.md to this spec.
      interactive-mode.ts: 1233 → about 1020 lines. `npm run ready`:
      969 tests pass.
- [x] Self-review (2026-10-10): wrapped `askPromptOccupant`'s handler
      passes in arrows (no unbound methods); dropped a restating doc
      comment on `addBanners`. Awaiting Anton's review.

## Implementation-Time Decisions

- **Stubs step skipped.** The spec is extractions of existing code, so
  each module was written whole and typechecked on its own instead of
  stubbing all six first.
- **`handleEffortCommand` uses `kind !== "levels"` with one ternary
  banner** rather than a three-way switch: the two failure kinds differ
  only in wording, and the narrowing leaves `model`/`levels` in scope.
- **`HeldLiveEvents.events` is a getter** over a private array, so the
  class alone appends to it.
- **`InteractiveMode.addBanners(banners)`** shows a command's returned
  banners and requests one render; both keybindings commands use it.
- **Two comment rewordings:** "buffered shutdown" / "buffered release"
  became "held shutdown" / "the release of held events" in
  `handleEvent` and `applyState`, matching the new type's terminology.
- **`askPromptHandlers.respond` passes `feedback` through even when
  undefined**, as `sendPermissionResponse` received it before; the
  ask-prompt test pins that shape.
