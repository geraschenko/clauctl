# Format/tui layering: `main → app → commands → tui → format → core`

Follow-up from `docs/follow-ups/format-tui-layering.md` (decisions and
TDCs from the entry-views review round) and `docs/specs/protocol-layering.md`
(the `DEPENDENCY_DAG` in `.dependency-cruiser.cjs`, which this spec extends
to the whole of `src/`).

# SPEC

## Problem

The cruiser's `DEPENDENCY_DAG` covers only `core/*`. Adding the rows
`tui → [format, core]`, `format → [core]`, `core → []` flags 11 files:

- `format → tui` (6): `tree.ts`, `command.ts`, `entries.ts` import
  `tui/entry-views/entry-view.ts`; `events.ts`, `messages.ts`,
  `sdk-message.ts` import `tui/sdk-render.ts` / `tui/render-types.ts`
  (pure SDK-message → render-shape conversion); `messages.ts` imports
  `READ_ONLY_TOOLS` from `tui/tool-views/tool-view.ts`.
- `core → format | tui` (5): `tail.ts`, `prompt.ts`, `entry-sink.ts` render
  output with `format/`; `entry-sink.ts` also imports `trackToolNames` from
  the tui views; `spawn.ts` and `app.ts` import `tui/attach.ts`.

The second group is not a layering bug in core; it is that `src/core/`
holds CLI commands and the composition root next to library code. Commands
sit above tui and format by nature. Commands also live inside the other two
layers (`tui/attach.ts` exports `attachRoute`, `format/command.ts` exports
`formatRoute`).

Two further defects block `no-circular` / `no-folder-cycles` at `error`:
the tui view registries are cyclic (`tool-views/*.ts ↔ tool-view.ts`,
13 cycles; `entry-views/*.ts ↔ attachment-view.ts`, 7), because the file
that defines the interface also imports every implementation to build the
registry; and `ToolView` mixes plain text with ANSI styling (`claudeStyle`
inside `resultSummary`, `resultBody`, `foldLabel`), so the views cannot move
into format as they are.

## Definitions

- **Layer**: a key of `DEPENDENCY_DAG`. The full order after this spec:
  `main.ts → app.ts → commands → tui → format → core`. `core/*` rows are
  unchanged. `src/test-support/` and the `generated/` directories are not
  keys.
- **Style**: an object mapping every style name to a `(text) => string`
  decorator. `ANSI_STYLE` emits SGR escapes; `PLAIN_STYLE` is the identity.
- **Leaf styling invariant**: format keeps output structured (fields,
  counts, plain strings) as long as possible; measurement and truncation
  (`oneLinePrefix`, `padEndCodePoints`, `.length`) operate on plain text,
  and a `Style` decorator is applied last, to a fragment that is never
  measured again. Consequences: with `PLAIN_STYLE` output is byte-identical
  to today's plain paths; with `ANSI_STYLE`, `stripAnsi(output)` equals the
  `PLAIN_STYLE` output; no tui component needs `stripAnsi` for layout.
  The equality is a property of `Style` decorators only. Links are not a
  decorator: `headerLink` is data, and the consumer decides its rendering
  (tui wraps the visible header text in a zero-width OSC 8 link; a plain
  consumer ignores it, or may later render `text (path)` — a consumer
  choice outside the invariant).
- **Registry split**: within a view barrel, the file named after the
  interface holds the interface (and constants over it); a separate
  `<interface>-for.ts` holds the lookup function and is the only file that
  imports the implementations. Implementations import the interface file,
  never the registry, so the barrel is acyclic.

## Type design

### `src/format/style.ts` (ex `src/tui/claude-style.ts`)

```ts
export const ANSI_STYLE = {
  grey,
  success,
  error,
  white,
  warning,
  bold,
  italic,
  dim,
};
// the generic decorators of today's `claudeStyle`
export type Style = {
  readonly [K in keyof typeof ANSI_STYLE]: (text: string) => string;
};
export const PLAIN_STYLE: Style; // identity for every key of ANSI_STYLE
```

`ANSI_STYLE` is the single source of the key set. Every `claudeStyle`
import (`tui/components/{tool-execution,footer,user-message,assistant-message}.ts`,
`tui/transcript.ts`, the tool views) becomes `ANSI_STYLE` from
`format/style.ts`; `tui/claude-style.ts` is deleted. The remaining
`claudeStyle` entries are not generic decorators and stay in tui as
module-local constants: the permission-mode palette (`manualMode`,
`planMode`, `acceptEdits`, `autoMode`, `dontAsk`, `bypassPermissions`) in
`tui/components/footer.ts`, its only user; the input-box decorators
(`userGutter`, `userBg`, `promptCode`) in `tui/components/user-message.ts`,
their only user.

### Injection: `ToolViewContext`

Style reaches the tool views only through `ToolViewContext` (below) and
`foldLabel`'s `style` parameter; the TUI passes `ANSI_STYLE`, plain
consumers `PLAIN_STYLE`. No `format` renderer calls a `ToolView` method, so
`MessageFormatOptions` carries no style and there is no `--color` flag: a
flag with nothing to color would be dead plumbing.

### `ToolView` (moved whole; one file per tool)

```ts
export interface ToolViewContext {
  readonly cwd: string | undefined;
  readonly style: Style;
}
export interface ToolView<A> {
  displayName?: string;
  header(args: A, context: ToolViewContext): ToolHeader;
  headerLink?(args: A): string | undefined; // link target (data); tui renders the OSC 8 link
  resultSummary(
    args: A,
    result: RenderToolResult,
    context: ToolViewContext,
  ): string;
  foldLabel?(count: number, style: Style): string;
  resultBody?(
    args: A,
    result: RenderToolResult,
    context: ToolViewContext,
  ): string | undefined;
}
```

The bare `cwd` parameter is replaced by `context` at every call site
(`format/messages.ts`, `format/sdk-message.ts`, `tui/transcript.ts`,
`tui/components/tool-execution.ts`, `tui/components/user-command.ts`).
`ToolHeader`, `READ_ONLY_TOOLS`, `EntryView`, `AttachmentView` are
unchanged. `EntryView` and `AttachmentView` never styled and take no style.

### `trackToolNames` → `src/core/session/track-tool-names.ts`

Signature unchanged: `trackToolNames(entry: SessionEntry, toolNames: Map<string, string>): void`.
It is a fold over session entries (a derived index like `entriesByUuid`)
with owners in three layers — `tui/session-model.ts`, the `format tree`
loader (`format/tree.ts`), `commands/entry-sink.ts` — so its home is the
lowest layer all three import. `collectToolNames` (full re-scan) is deleted;
each owner keeps its map incrementally as entries are ingested.

No other symbol changes. Everything below is relocation.

## Target layout

```
src/main.ts                     bin entry (ex core/main.ts); package.json bin/build → dist/main.js
src/app.ts                      stricli app (ex core/app.ts)
src/commands/                   tail, prompt, spawn, lifecycle, sdk-commands, wait, inspect,
                                entry-sink, main-entry-path (ex core/*.ts);
                                attach.ts (attachRoute, ex tui/attach.ts — the TUI stays there);
                                format.ts (formatRoute, ex format/command.ts)
src/tui/                        interactive components; imports format, core
src/format/                     text from data; imports core
  style.ts                      Style, ANSI_STYLE, PLAIN_STYLE
  sdk-render.ts, render-types.ts, glyphs.ts   ex tui/
  entry-view/                   barrel (ex tui/entry-views/)
    index.ts                    EntryView, entryViewFor, the helpers outsiders use
                                (abnormalStopReason, hasText, isHumanPrompt, isPromptEntry,
                                messageContent, toolResultOnly), and the tool-view surface
                                re-exported (see Implementation-Time Decisions)
    entry-view.ts               EntryView + shared helpers + the per-type views
    entry-view-for.ts           entryViewFor (registry)
    payload.ts                  size helpers shared by entry-view.ts and attachment views
    attachment-view/            nested barrel: index exports AttachmentView, attachmentViewFor;
                                attachment-view.ts (interface), attachment-view-for.ts
                                (registry), per-type views internal
    tool-view/                  nested barrel: index exports ToolView, ToolHeader,
                                ToolViewContext, toolViewFor, READ_ONLY_TOOLS;
                                tool-view.ts (interface + READ_ONLY_TOOLS), tool-view-for.ts
                                (registry), one file per tool
src/core/                       library only; imports nothing above
```

`DEPENDENCY_DAG` rows added: `"main.ts": ["app.ts", "core"]`,
`"app.ts": ["commands", "core"]`, `"commands": ["tui", "format", "core"]`,
`"tui": ["format", "core"]`, `"format": ["core"]`, `"core": []`.
eslint `barrelPatterns` and `barrelImplementation` entries for
`entry-view`, `attachment-view`, `tool-view` (the helper's `src/core/`
prefix becomes a parameter or the patterns are written out — decide at
implementation, no new convention).

## Success criteria

1. `npm run depcruise` passes with the six rows above and with
   `no-circular` and `no-folder-cycles` at `error` (zero violations).
2. `format` subcommand and `tail`/`prompt` output is byte-identical to
   before (existing snapshot tests).
3. A test per styled `ToolView` method asserts
   `stripAnsi(withAnsi) === withPlain`; `src/tui/**` no longer calls
   `stripAnsi` to measure format output (any remaining call is listed in
   the WORK LOG with what it measures and why).
4. `collectToolNames` and `tui/claude-style.ts` no longer exist; no file
   under `src/core/` imports `format/` or `tui/`.
5. `npm run presubmit` green; no behavior change beyond the styling seam.

## Non-goals

- The `sizes` option that removes the size-stripping regexes in
  `format/tree.test.ts` and `tui/components/tree-selector.test.ts`
  (follow-up immediately after this spec; the TDCs stay until then).
- Barrels for `core/session/`, `core/tree/` (namespaces today: 25 and 26
  externally used symbols; revisit once their consumers settle here).
- Any change to `generated/` directories (pictl-synced).

## Steps

Each step ends green (`npm run presubmit`); cruise after each.

1. Add the six DAG rows and flip `no-circular`/`no-folder-cycles` to
   `error`; record the failing edge count as the work list.
2. Commands layer: `src/main.ts`, `src/app.ts`, `src/commands/*`;
   `attachRoute` → `commands/attach.ts`, `formatRoute` →
   `commands/format.ts`; `package.json` bin/build paths; `scripts/` and
   `tests/` import specifiers.
3. `sdk-render.ts`, `render-types.ts` → `format/`; `claude-style.ts` →
   `format/style.ts` with `Style`/`PLAIN_STYLE`.
4. `trackToolNames` → `core/session/track-tool-names.ts`; owners keep the map
   incrementally; delete `collectToolNames`.
5. Views into `format/entry-view/` with the registry split and the
   `ToolViewContext` signature; barrels + eslint patterns; the
   `stripAnsi` equality tests; drop tui's layout `stripAnsi` calls.
6. Answer the remaining TDCs in the moved files (`file.ts:22` "on what
   basis": verify the snippet rendering against a real file-attachment
   entry and record the finding; `attachment-view.ts:1`; `entries.ts:17`;
   `command.ts:16`; `entry-sink.ts:18`) — each is resolved by the moves
   above or answered in the WORK LOG, then removed.

# IMPLEMENTATION IDEAS

- Style injection was chosen over a text/presentation split of `ToolView`
  because the split was already leaky (`resultSummary` bolds counts) and
  because with a `Style` parameter `headerLink` (a link target, i.e. data)
  is the only "presentation" member left — so the interface stays whole.
- The DAG's hierarchy semantics (edge grants descendants; ancestors'
  unlisted contents allowed) mean `core/generated` and `format/generated`
  need no rows.
- Tests obey the DAG; a test that needs a higher layer moves up (as the
  protocol integration tests did).

# WORK LOG

- 2026-09-24: derisk complete (Anton): commands layer + `src/main.ts` /
  `src/app.ts`; style injected through `MessageFormatOptions`; ANSI
  implementation moves to format; leaf styling invariant in scope; `sizes`
  option and `--color` are follow-ups; barrel eslint patterns hand-written.
- Step 1: six rows added, cycle rules at `error`. Work list: 97 violations
  (52 folder cycles, 22 circular, 12 `dag-core`, 11 `dag-format`). The
  cruiser still keyed `core/daemon`, so `protocol-server` had been
  unconstrained since the rename; fixed (no new violations).
- Step 2: commands layer in place; `package.json` bin/build → `dist/main.js`.
  Tests moved with their subjects; `tail.test.ts`, `prompt.test.ts`,
  `stream-commands.test.ts` drive the CLI through `app` and sit at `src/`
  (nothing below `main.ts` may import `app.ts`; `src/*.test.ts` is not a DAG
  key). Two non-registry cycles cleared: `launchDaemon` → its own
  `commands/launch-daemon.ts` (lifecycle → spawn → attach → lifecycle), and
  `SetContextDeps` declared in `set-context.ts` with `RequestHandlerDeps
extends` it (set-context ↔ request-handlers). After: 19 circular, 12
  folder, 10 `dag-format`; 789 tests green.
- Step 3: `sdk-render.ts`, `render-types.ts`, `style.ts` in `format/`;
  `Style`/`ANSI_STYLE`/`PLAIN_STYLE`; `MessageFormatOptions.style`
  (defaults and test fixtures use `PLAIN_STYLE`). Footer's mode palette is a
  local `sgr256(color)` helper; user-message's three decorators are local
  consts. `tui/glyphs.ts` → `format/glyphs.ts` (entry views use it).
- Step 4: `core/session/track-tool-names.ts` (+ test); `collectToolNames` gone;
  `format tree` folds the map in one loop over the snapshot's entries.
- Step 5: views under `format/entry-view/` with nested `attachment-view/`
  and `tool-view/` barrels, registries in `*-for.ts`. `ToolViewContext`
  wired through `tool-execution.ts` (`{ cwd, style: ANSI_STYLE }`),
  `transcript.ts` (`foldLabel(count, ANSI_STYLE)`), and `entry-view.ts`
  (`PLAIN_STYLE` for the plain tool-call header). `messages.ts` and
  `sdk-message.ts` never called view methods (the spec's call-site list
  was over-inclusive: they import `READ_ONLY_TOOLS` only). The one tui
  layout `stripAnsi` (`tool-execution.ts` header prefix width) is now
  computed from the plain parts; `src/tui/**` non-test code has zero
  `stripAnsi` calls. `wrapHeaderArg`'s test moved to
  `tool-execution.test.ts` (its only user is tui). The equality test covers
  every styled method: Edit summary/body/fold, Read summary/fold, Write
  summary/body. `npm run depcruise`: **0 violations** (213 modules) with
  `no-circular` and `no-folder-cycles` at `error`; 790 tests green; every
  presubmit step green except `sync --check` (completion.ts, see below).
- Step 6: TDCs resolved — `entries.ts`, `command.ts` (views live in format;
  the answer is this spec), `attachment-view.ts:1` (barrel exposes
  `AttachmentView` + `attachmentViewFor`: yes), `entry-view.ts` barrel
  comment (layout is the one it proposed), `entry-sink.ts`. `file.ts:22`:
  verified against the three `file` attachments in
  `docs/derisk/stream-classification/captures/session.jsonl` — the payload
  is `{type:"file", filename, content:{type:"text", file:{filePath,
content}}}` (a Read-shaped block, i.e. what the model sees), which is
  `fileText`'s last branch; the `snippet` and string-`content` branches are
  the CLI's `edited_text_file` shapes and remain unverified live. The
  `sizes` TDCs (`tree.test.ts:86`, `tree-selector.test.ts:263`) stay for
  the follow-up.
- Review round (fresh-context reviewer): `barrelImplementation` now spreads
  `barrelPatterns` — a flat-config override replaces the global
  `no-restricted-imports`, so `entry-view.ts` could have bypassed the nested
  barrels (`./tool-view/edit.ts`) unflagged; probed with `eslint --stdin`
  before and after. `SetContextDeps` moved above `SetContextShared`'s doc
  comment (it had been inserted between the comment and its interface).
  Stale `tui/` paths in three comments and `api-context-view.md` fixed.
  `tool-view.test.ts`: the `stripAnsi` wrappers around `PLAIN_STYLE` output
  were no-ops and removed; the invariant test is the file's only
  `stripAnsi` call. Open (Anton): `MessageFormatOptions.style` has no reader
  — `messages.ts`/`sdk-message.ts` never reach a `ToolView`, so the field is
  plumbing for `--color` only; drop it (YAGNI) or keep it as the seam.
- Review round 2 (Anton, `1ff8bb6`): `tool-names.ts` → `track-tool-names.ts`
  (file named after its function). `ToolExecutionComponent.headerPrefix(style)`
  replaces `styledHeaderPrefix` + a hand-built plain twin: the wrap width is
  `headerPrefix(PLAIN_STYLE).length`, the rendered line uses `ANSI_STYLE`.
  Open: moving the entry predicates (`isHumanPrompt`, `isPromptEntry`,
  `hasText`, `toolResultOnly`, `abnormalStopReason`, `messageContent`) to
  `core/session/` needs `contentBlocks`/`extractTextContent`/`hasContentBlock`
  below format — they live in `format/generated/text.ts` (pictl).
- pictl moved `text.ts` to its `src/core/`: the sync's format set is gone,
  `core/generated/text.ts` serves all 21 importers, `sync --check` and the
  full presubmit are green. That unblocked the entry predicates:
  `core/session/entry-predicates.ts` (`isHumanPrompt`, `isPromptEntry`,
  `hasText`, `toolResultOnly`, `abnormalStopReason`, with the `isHumanPrompt`
  tests) and `messageContent` beside the other accessors in
  `core/session/file.ts`; the `entry-view` barrel exports views only.
- Decisions (Anton): `MessageFormatOptions.style` dropped — `format`
  renderers never reach a `ToolView`, so it was unread (SPEC amended: no
  `--color`, style flows through `ToolViewContext` only). The per-type
  split of `entry-view.ts` is dropped from the Target layout.
- **`completion.ts` (pictl-synced) imported `../app.ts`**, the `app ↔
completion` cycle and, after the move, an unresolvable import. Anton: edit
  the generated file now and upstream the same refactor to pictl afterwards
  (`sync --check` is red until then). `completionRoute` became a function of
  a thunk `() => Application<CommandContext>` — the route is part of the app
  it completes, so the app cannot exist yet when the route is built.
  `app.ts` annotates `app: Application<CommandContext>` to break the
  resulting inference cycle.
- **`payload.ts` stays at `format/entry-view/payload.ts`**, not inside
  `attachment-view/`: `entry-view.ts` uses `jsonLength`/`recordCharCount`
  too, and a nested barrel's implementation may import its parent's
  siblings (`../payload.ts`), the reverse would need the nested barrel to
  export helpers that are not views.
- **One outer barrel**: eslint's `**/entry-view/*` pattern also matches
  `entry-view/tool-view/index.ts`, so outsiders import
  `format/entry-view/index.ts`, which re-exports the tool-view surface
  (`ToolView`, `ToolHeader`, `ToolViewContext`, `toolViewFor`,
  `READ_ONLY_TOOLS`, `collapsedOutputSummary`). `attachment-view/` is used
  by `entry-view.ts` only. `barrelImplementation` takes the `src/`-relative
  directory (`core/protocol`, `format/entry-view/tool-view`).
- **Tests obey the DAG**: `tail/prompt/stream-commands.test.ts` at `src/`;
  `wrapHeaderArg` test in tui.
- Follow-up (sizes TDCs) done: `TreeFormatOptions { filter, width,
omitUuids, sizes }` is the one options type for `treeLines` (which now
  applies the filter itself; `toolNames` stays a data parameter),
  `formatSnapshotDocument` and the `/tree` selector's `TreeLines`. `format
tree --omit-uuids`, `--sizes/--no-sizes` (tri-state via pictl's new
  `optionalBooleanFlag`; absent → settings). Settings moved to
  `core/settings.ts` (+ `core/config-dir.ts`), gaining the nested `tree:
{ showSizes }` component slice; `format tree` reads them and prints their
  warnings to stderr. Both size-stripping test regexes are gone.
- 2026-09-25 review round (Anton, `46b4a9a`): `treeLines` takes an
  arbitrary row predicate again — `TreeLineOptions { filter: (id, entry) =>
  boolean, width, omitUuids, sizes }`; `formatSnapshotDocument` keeps
  `TreeFormatOptions { filter: FilterMode }` and builds the predicate via
  `passesFilter`, as does the selector's `TreeLines` for `"conversation"`.
  `format tree` reads settings only when `--sizes/--no-sizes` is absent.
  `InteractiveMode` takes `ClauctlSettings`, `TreeSelectorComponent` takes
  `TreeSettings` (neither picks fields apart for its callee). `tree.test.ts`
  has one `render(input, options)` (`sizes` defaults false).
