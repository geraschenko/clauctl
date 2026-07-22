# Spec: TUI /effort command

> Status: draft, awaiting review. The user manages all git operations;
> implementing agents must not commit, stage, or otherwise mutate git
> state.

## SPEC (stable requirements)

### Problem

There is no way to set the reasoning effort level from the TUI, even
though everything below the TUI already exists: the socket protocol has
the `apply-flag-settings` passthrough mutation, the daemon resolves
effort on `controlApplied` emission, the agent-state fold tracks
`effortLevel`, and the footer displays it. Only the command surface is
missing.

### Success criteria

1. Bare `/effort` opens a selector (same look and lifecycle as `/model`)
   listing the current model's supported effort levels; picking one
   applies it via `apply-flag-settings`. The footer updates from the
   `controlApplied` fold — no optimistic update.
2. `/effort <level>` sets the level directly after validating it against
   the current model's supported levels; an invalid level banners with
   the valid ones. The CLI runtime silently accepts unknown values
   (observed: `effortLevel: "superduper"` round-trips without error and
   falls back through the settings cascade), so validation is on us —
   the TUI's per-model check plus the daemon backstop of criterion 3.
3. The daemon rejects an `apply-flag-settings` mutation whose
   `effortLevel` is not in the `EffortLevel` union (null passes — it is
   the documented clear), failing the request with
   `invalid effortLevel "…"; valid: low, medium, high, xhigh, max`. This
   closes the non-TUI path (`clauctl apply-flag-settings` with a typo
   previously succeeded silently and put the garbage on the footer via
   the controlApplied fold). Other settings keys stay unvalidated.
4. `"max"` is offered when the model reports it. The SDK's
   `Settings.effortLevel` type omits `"max"`, but the CLI runtime accepts
   and applies it through the settings layer (verified 2026-07-21:
   `apply-flag-settings {"effortLevel":"max"}` on a live session →
   `CLAUDE_EFFORT=max`); the protocol type is widened accordingly.
5. A model without effort support (e.g. haiku: no
   `supportedEffortLevels`), or a current model that cannot be matched in
   `supported-models`, banners and opens no selector. Explicit levels
   only — no "default"/clear entry (`effortLevel: null` stays a CLI-only
   affordance).
6. `/effort` appears in slash-command autocomplete, and the open selector
   participates in `handleGlobalKey`'s `selectorOpen` guard so
   escape/ctrl+c reach it as `tui.select.cancel`.

### Behavior

- **Level source**: the `supported-models` read, matching
  `agentState.model` against `ModelInfo.value` or
  `ModelInfo.resolvedModel` (the state field holds a `set-model` request
  value or the SDK init message's resolved id, depending on history).
  The offered levels are exactly the matched model's
  `supportedEffortLevels ?? []` — empty or missing means unsupported.
- **Banners** (distinct messages, distinct causes): unmatched or unset
  model → "cannot determine effort levels for the current model";
  matched but unsupported → "current model does not support effort
  levels"; invalid direct-set level → "invalid effort level X; <model>
  supports: <levels>"; failed `supported-models` or
  `apply-flag-settings` request → error banner with the cause.
- Both `/effort` forms share one entry point (`handleEffortCommand`,
  optionally carrying the direct-set level) because both need the same
  `supported-models` read for validation.
- Effort applies from the next query; nothing about the in-flight turn
  changes. Setting the level the model already uses is a no-op the
  daemon/CLI handle; the TUI does not special-case it.

### Type design

`src/core/sdk-socket.ts` — widen once at the protocol type instead of
per-sender casts:

```ts
/**
 * The `applyFlagSettings` payload: `null` clears a key, a value replaces
 * it. effortLevel is widened beyond Settings' type: the Settings file
 * schema omits "max", but the CLI runtime accepts and applies it
 * (verified 2026-07-21 via CLAUDE_EFFORT on a live session).
 */
export type FlagSettings = Omit<
  { [K in keyof Settings]?: Settings[K] | null },
  "effortLevel"
> & { effortLevel?: EffortLevel | null };
```

`SdkControlApplied`'s apply-flag-settings override becomes structurally
identical to the mutation shape and collapses to a plain reuse; its doc
comment (daemon resolves `effortLevel: null` to the concrete post-clear
level at emission) moves with it.

`src/core/sdk-passthrough.ts` — two changes in the apply-flag-settings
case: the criterion-3 validation before the SDK call —

```ts
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
// a present, non-null settings.effortLevel outside the set → throw; the
// error fails the request back to its sender (CLI or TUI), and no
// controlApplied is emitted, so the fold never sees garbage
```

— and one localized cast where the widened value meets the SDK's
narrower `applyFlagSettings` signature, commented with the
runtime-accepts-max rationale.

New component `src/tui/components/effort-selector.ts`, mirroring
`ModelSelectorComponent` (SelectList + header hint from
`getKeybindings().getKeys("tui.select.cancel")`):

```ts
export class EffortSelectorComponent extends Container implements Focusable {
  focused: boolean;
  constructor(
    levels: EffortLevel[], // already filtered to the current model
    onSelect: (level: EffortLevel) => void,
    onCancel: () => void,
  );
  handleInput(data: string): void; // delegates to the SelectList
}
```

`src/tui/interactive-mode.ts`:

```ts
/** Same first-token parse as parseModelCommand; `level` undefined means
 *  bare `/effort` (open the menu). */
export function parseEffortCommand(
  text: string,
): { level: string | undefined } | null;

class InteractiveMode {
  private effortSelector?: EffortSelectorComponent;
  /** True from `/effort` submit until the supported-models read settles. */
  private effortSelectorPending = false;
  /**
   * Fetch supported-models and resolve the current model's levels
   * (banners per Behavior on any failure). Bare form: open the selector.
   * With `level`: validate against the resolved levels and send — the
   * one place a typo can surface. Not named open…Selector: the
   * direct-set path never opens one.
   */
  private handleEffortCommand(level?: string): void;
  private closeEffortSelector(): void; // model-selector lifecycle mirror
  private sendSetEffort(level: EffortLevel): void; // apply-flag-settings
}
```

`submit()` gains the `parseEffortCommand` intercept (beside the `/model`
one); `handleGlobalKey`'s `selectorOpen` gains `effortSelector`;
`autocomplete.ts` `LOCAL_COMMANDS` gains
`{ name: "effort", description: "set the reasoning effort level" }`.

### Edge cases

- `/effort` while a selector is already open: unreachable in practice
  (the editor is unfocused), and `handleEffortCommand` has the same
  existing/pending early-return as the other selectors.
- `supported-models` read rejects: pending flag cleared, error banner —
  same shape as the model selector's failure path.
- `agentState.model` undefined (never seeded, no set-model yet): the
  unmatched-model banner; no selector.
- The direct-set form validates case-sensitively; levels are the SDK's
  lowercase literals and the banner lists them.

### Non-goals

- No keyboard chord for the selector (pi's `app.model.select` analogue);
  `/effort` is the only entry point until chords prove necessary. Same
  deliberate omission for `/model` and `/tree` chords
  (`app.model.select`, `app.session.tree`) — revisit together if wanted.
- No `effortLevel: null` (clear-to-cascade) entry in the selector.
- Daemon validation covers only `effortLevel` (the one field we widen
  beyond the SDK type); other settings keys pass through unvalidated as
  before.
- No display of the _actual_ (post-resolution) effort level; the footer
  keeps showing the last valid requested level. Cascade fallbacks and
  silent model downgrades stay invisible — deferred to
  `docs/thoughts/actual-effort-display.md` (needs daemon hook
  registration and a new event kind; the fold-only approach turned out
  not to exist, since no SDK stream message carries effort).
- No display changes: the footer already renders `effortLevel`.

## IMPLEMENTATION IDEAS

- `EffortLevel` imports from `@anthropic-ai/claude-agent-sdk` (exported
  type alias).
- Selector items: `{ value: level, label: level }` — no descriptions
  (the SDK's per-level prose lives on a doc comment, not `ModelInfo`).
- `sendSetEffort` mirrors `sendSetModel`: `void request(...).catch` →
  error banner.
- Validation test home: `request-handlers.test.ts` already exercises the
  mutation → controlApplied path with fixtures, so the
  invalid-effortLevel rejection (request fails, no controlApplied
  emitted) fits there; a pure unit test on the passthrough case works
  too if it is exported testably.
- Tests (`node --test`, colocated): `parseEffortCommand` unit tests
  mirroring the `parseModelCommand` cases (exact token, argument
  trimming, non-command text, bare form); autocomplete count bump in
  `autocomplete.test.ts`. Selector/read plumbing is TUI-lifecycle glue,
  manually verified like the other selectors.
- Manual verification: `/effort` menu on a max-capable model shows max;
  `/effort low` then footer shows `low`; `/effort superduper` banners;
  `/effort` on haiku banners; escape and ctrl+c cancel the selector.

## WORK LOG

**Instructions**: Update this section during each work session. Add new
tasks, mark completed ones with [x], document decisions and problems
encountered.

- 2026-07-21: derisked with Anton (grew out of the keybindings spec's
  pi-action audit): direct set allowed; levels from the current model;
  "max" included where supported (runtime verified via CLAUDE_EFFORT
  despite the Settings type); no clear/default entry; banner for
  unsupported models; separate spec doc. Type design approved
  2026-07-21.
- 2026-07-21: verification hardened by counterfactual: with
  `effortLevel: "superduper"` applied, CLAUDE_EFFORT read `medium` — the
  var reports a resolved level, not an echo of the raw setting, so the
  earlier `max` reading was real post-resolution state. Invalid values
  are silently dropped into the cascade (no error anywhere), confirming
  criterion 2's TUI-side validation rationale. (Why the fallback was
  `medium` rather than the documented `high` default is unexplained;
  irrelevant to this spec.)
- 2026-07-21: scope amended with Anton: daemon-side effortLevel
  validation added (criterion 3) after the superduper experiment showed
  the whole chain accepts garbage silently. Actual-effort display was
  considered for this spec but deferred to
  `docs/thoughts/actual-effort-display.md` once investigation showed no
  SDK stream message carries effort — the hook-callback machinery it
  needs (daemon hook registration, new effortResolved event, mid-turn
  clobber corner) outweighs a fold tweak.
- [ ] `FlagSettings` widening + `SdkControlApplied` collapse
      (sdk-socket.ts) + passthrough cast
- [ ] daemon effortLevel validation (sdk-passthrough.ts) + test
- [ ] `EffortSelectorComponent`
- [ ] `parseEffortCommand` + intercept + selector lifecycle + guard
- [ ] autocomplete entry
- [ ] tests, typecheck, lint, treefmt
- [ ] manual TUI verification (user)
