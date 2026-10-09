# Spec: Split interactive-mode.ts into a directory with a barrel

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

## SPEC (stable requirements)

### Problem

`src/tui/interactive-mode.ts` is 1520 lines: the `InteractiveMode` class
(~1150 lines) plus module-level helpers for startup, layout, local
command parsing and permission banners. Turn it into a directory,
`src/tui/interactive-mode/`, behind a barrel (`index.ts`). The
directory structure follows the repo's existing barrels (e.g.
`src/core/protocol-client/`, enforced by `eslint.config.js`).

Guiding rule (Anton, 2026-10-09): `interactive-mode.ts` should shrink,
and a reader should be able to see how it works from the names and
signatures of what it contains. A helper moves to its own file when it
has a meaning of its own and its signature makes plain what it does,
even if it has only one user. This step applies the rule to
module-level code only. The class itself is re-evaluated after the move
(see Non-goals).

### Success criteria

1. **Pure move.** Runtime behaviour does not change. Every declaration
   (body, signature, its existing comments) and every test (name, body)
   moves verbatim. The only edits to moved code are:
   - import paths and import lists;
   - adding `export` to a symbol that is now used from another file;
   - re-attaching the `dockEntries` doc comment, which currently sits
     above `resolutionBanner`, to `dockEntries`;
   - the class file header: its sentence "this file owns layout,
     keybindings, and the AgentEvent → component dispatch" drops
     "layout", which `layout.ts`'s header claims instead;
   - path references in code comments (criterion 4).

   Beyond moved code, the change consists of: the new files' header
   comments, `index.ts`, the import in `src/commands/attach.ts`
   (`../tui/interactive-mode.ts` → `../tui/interactive-mode/index.ts`),
   the eslint entries below, and the two follow-up doc edits in
   IMPLEMENTATION IDEAS.
2. **One way in.** Code outside `src/tui/interactive-mode/` imports it
   only through `index.ts`, and `eslint` enforces this the same way it
   does for the other barrels. Files inside the directory import their
   siblings, never `index.ts`.
3. **Tests move with the code they test.** The 13 tests today (six
   command-parser tests and one layout test in
   `interactive-mode.test.ts`, six in
   `interactive-mode.permission.test.ts`) exist after the move with the
   same names and bodies; only import paths change. `npm run ready`
   passes.
4. **Living references follow.** Every code comment in `src/` and
   `scripts/` that names our `interactive-mode.ts` by path names the new
   file. Exceptions, left as they are: the preserved TDCs (criterion 5),
   mentions of pi's `interactive-mode.ts` (e.g. the class header), and
   the captured outputs in `scripts/tui-parity/out/`. Specs in
   `docs/specs/` are historical and are left alone.
5. **Five TDCs move as is.** The five `TDC:` comments in the class move
   with it unchanged; the input-slot task (tg c60bca6d) handles them.

### Layout

```
src/tui/interactive-mode/
  index.ts                             barrel
  run-interactive.ts                   runInteractive; createTui (private)
  interactive-mode.ts                  class InteractiveMode; type InteractiveOutcome
  resolution-banner.ts                 resolutionBanner
  layout.ts                            TuiParts, FullscreenLayout, buildFullscreenLayout,
                                       mountParts; dockEntries (private)
  local-commands.ts                    parseModelCommand, parseEffortCommand
  layout.test.ts                       ┐ the tests of interactive-mode.test.ts,
  local-commands.test.ts               ┘ split by subject
  interactive-mode.permission.test.ts  moved from src/tui/
```

`src/tui/interactive-mode.ts` and `src/tui/interactive-mode.test.ts`
are deleted.

### Type design

There are no new symbols and no signature changes. Each symbol moves to
the file shown below, and the table records where `export` is added:

| Symbol                                    | File                   | Exported                          |
| ----------------------------------------- | ---------------------- | --------------------------------- |
| `runInteractive`                          | `run-interactive.ts`   | yes, and from the barrel          |
| `createTui`                               | `run-interactive.ts`   | no                                |
| `InteractiveMode`                         | `interactive-mode.ts`  | yes (as today); not from barrel   |
| `InteractiveOutcome`                      | `interactive-mode.ts`  | yes, and from the barrel (`type`) |
| `resolutionBanner`                        | `resolution-banner.ts` | yes (new)                         |
| `TuiParts`, `FullscreenLayout`            | `layout.ts`            | yes (as today)                    |
| `buildFullscreenLayout`                   | `layout.ts`            | yes (as today)                    |
| `mountParts`                              | `layout.ts`            | yes (new)                         |
| `dockEntries`                             | `layout.ts`            | no                                |
| `parseModelCommand`, `parseEffortCommand` | `local-commands.ts`    | yes (as today)                    |

`index.ts`:

```ts
export { runInteractive } from "./run-interactive.ts";
export type { InteractiveOutcome } from "./interactive-mode.ts";
```

`InteractiveOutcome` stays with the class, not with `runInteractive`.
The class produces it (`done: Promise<InteractiveOutcome>`), and
`run-interactive.ts` imports the class, so putting the type in
`run-interactive.ts` would create a type-only import cycle, which
dependency-cruiser's `no-circular` rule still reports.

The class is not exported from the barrel because nothing outside the
directory uses it; its one test moves inside.

Imports inside the directory:

- `run-interactive.ts` imports `interactive-mode.ts`.
- `interactive-mode.ts` imports `layout.ts`, `resolution-banner.ts`
  and `local-commands.ts`.
- Nothing imports `index.ts` except code outside the directory
  (`src/commands/attach.ts`).

### Lint and dependency rules

- `eslint.config.js`:
  - add to `barrelPatterns`, like the existing entries:
    `group: ["**/interactive-mode/*", "!**/interactive-mode/index.ts"]`,
    message "Import interactive-mode/index.ts; the siblings are
    implementation.";
  - add `barrelImplementation("tui/interactive-mode")`.
- `.dependency-cruiser.cjs`: no change. The `tui` node of the
  dependency graph already covers its subdirectories. Once both tests
  have moved, nothing in `src/tui/` outside the new directory imports
  it, so the `no-folder-cycles` rule holds.
- `package.json` (test glob `src/**/*.test.ts`), the tsconfigs and
  `treefmt.toml` name no paths that change.

### Cost

Nothing changes at runtime. The cost is in review: Anton has to confirm
that nothing was edited along the way. These help:

- The class file keeps roughly three quarters of the old file's lines,
  so git should report it as a rename.
- The new files are untracked until Anton stages them, so a plain
  `git diff` misses them. After `git add -N src/tui/interactive-mode/`
  (Anton's step), `git diff -M --color-moved` shows the renames and
  separates moved lines from changed ones.
- Before handing over, the implementer compares each moved declaration
  and test against its original, preserving order and multiplicity and
  allowing only criterion 1's enumerated edits. `npm run ready` verifies
  the imports.

### Edge cases

- `interactive-mode.permission.test.ts` constructs `InteractiveMode`
  directly; inside the directory it imports `./interactive-mode.ts`,
  as `barrelImplementation` requires.
- Comments that say "interactive-mode" without `.ts` (e.g. in
  `model-selector.ts`, `tree-selector.ts`) still name the directory, so
  they stay unchanged. `src/format/render-types.ts` refers to pi's
  `interactive-mode`, not ours.

### Non-goals

- Splitting the `InteractiveMode` class. TypeScript has no partial
  classes, so moving methods out means rewriting them as functions over
  injected dependencies, which is a refactor. That is re-evaluated after
  this move under the guiding rule.
- Anything the input-slot task (tg c60bca6d) covers: the slot
  occupant, dialog construction, delegating `handleGlobalKey`, and the
  TDCs.
- Updating specs in `docs/specs/`.

## IMPLEMENTATION IDEAS

- Create the new files and move each symbol's text exactly as it is:
  cut and paste whole, never retype.
- Header comments:
  - `index.ts` follows the protocol-client barrel's wording ("The
    interactive-mode directory's only import surface …").
  - `layout.ts` receives the class header's sentence that the file owns
    layout.
  - The class file keeps the rest of its existing header: assembly and
    event dispatch, keybindings, and the AgentEvent → component
    dispatch.
- Code comments to repoint:
  - `src/tui/keybindings.ts` ("the TUI lives in interactive-mode.ts");
  - `src/tui/transcript.ts` ("Live attach (interactive-mode.ts)");
  - `scripts/tui-parity/render-session.ts` ("cf. interactive-mode.ts
    replay").

  Re-grep at implementation time for any others.
- Docs:
  - delete `docs/follow-ups/interactive-mode-split.md`;
  - in `docs/follow-ups/input-slot-dialogs.md`, point the "after
    splitting interactive-mode.ts (interactive-mode-split.md)" reference
    at this spec.
- External imports follow their users, e.g. `resolution-banner.ts`
  imports `PLAIN_DENY_MESSAGE` from `../permission-dialog.ts`, and
  `layout.ts` imports `FitWidth` from `../components/fit-width.ts`;
  `tsc` and eslint's unused-import checks find any misplaced one.
- Check the result:
  - `npm run ready`;
  - audit `grep -rn "interactive-mode\.ts" src scripts`: every match
    is a new path or one of criterion 4's exceptions;
  - the 13 test names from criterion 3 all still run;
  - the declaration-by-declaration comparison from Cost.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Create the directory files and move the symbols
- [x] Split `interactive-mode.test.ts`; move the permission test
- [x] `eslint.config.js` barrel entries; `attach.ts` import
- [x] Repoint code comments; update the follow-up docs
- [x] `npm run ready`: 940 tests pass, the same as before; the 13 moved
      tests run from their new files
- [x] Declaration-by-declaration comparison against `HEAD`: every moved
      block (11 source ranges, 3 test ranges) is verbatim, apart from the
      `export` added to `mountParts` and `resolutionBanner`

## Implementation-Time Decisions (2026-10-09)

- **How the code was moved.** A script cut each symbol out of the
  original by line range, so no text was retyped. Each new file kept only
  the original import specifiers whose names its body uses. A name that
  appears only in a comment fooled that filter five times; eslint's
  `no-unused-vars` flagged each case and they were removed.
- **The comment in `keybindings.ts` names the directory, not a file.**
  Wiring the keybinding manager into the TUI now spans two files:
  `run-interactive.ts` (startup) and `interactive-mode.ts` (reload,
  global keys). So the comment says `interactive-mode/`.
- **Specs that point at the deleted follow-up stay as they are.**
  `ask-user-question.md` and `dialog-keybindings.md` still name
  `docs/follow-ups/interactive-mode-split.md`; specs are historical.
- **Only `layout.ts` and `run-interactive.ts` have file headers.**
  `resolution-banner.ts` and `local-commands.ts` hold one or two
  documented functions, so a header there would only repeat the doc
  comments (AGENTS.md: no comments a reviewer would skip).
