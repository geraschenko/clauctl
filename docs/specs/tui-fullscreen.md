# TUI Fullscreen Mode (pi-tui 0.84.2)

> Status: **implemented.**

# SPEC

## Problem statement

clauctl's TUI renders as an unbounded document on the main terminal buffer
(pi-tui 0.80.10's only mode). pi-tui 0.84 introduced renderer selection:
`TuiMainScreen` (current behavior) and `TuiAltScreen` (alternate buffer,
terminal-height viewport, application-owned scrolling with a fixed input
dock). We want clauctl to upgrade to pi-tui 0.84.2 and render fullscreen by
default, with the mode persisted in a new `settings.json` alongside
`keybindings.json`.

## Success criteria

1. `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` are both at
   0.84.2; the existing suite and `npm run presubmit` pass.
2. With no `settings.json` (or `"tuiMode": "fullscreen"`), the TUI runs in
   the alternate screen: the transcript scrolls in its own region while
   status, pending messages, editor, hint, and footer stay docked at the
   bottom.
3. With `"tuiMode": "regular"`, behavior is identical to today.
4. An unreadable/invalid `settings.json` falls back to fullscreen with a
   startup warning banner (same pattern as keybindings warnings); it never
   prevents startup.
5. On stop in fullscreen mode, the previous main-screen contents are
   restored cleanly (no transcript dump into scrollback). This includes the
   external-editor suspend path: suspending in fullscreen must not print the
   document into the main buffer (a deliberate divergence from pi v0.84.2,
   whose suspend calls bare `stop()` and leaves a transcript dump behind the
   alt screen).
6. Fullscreen transcript navigation (`tui.altScreen.*`: page/home/end,
   prompt jumps, search) works with the default bindings and is remappable
   through the existing `keybindings.json` machinery; the new action ids
   appear in `default_bindings` after a `/keybindings` refresh with no code
   changes (they arrive via the `TUI_KEYBINDINGS` spread).
7. Selecting text with the mouse in fullscreen and releasing copies to the
   clipboard via `copyToClipboard`; search matches render with pi's
   dark-theme styling.
8. Smoke tests (manual, in tmux, via `clauctl attach`): mouse-wheel
   passthrough through PtyScreen, attach repaint of the alt buffer, hint-row
   behavior, external editor suspend/resume (`ctrl+g` and `/keybindings`),
   transcript search, resize, detach/reattach.

## Type design

New module `src/tui/settings.ts` (read style mirrors `keybindings.ts`):

```ts
import type { TuiMode } from "@earendil-works/pi-tui";

export interface ClauctlSettings {
  tuiMode: TuiMode; // "regular" | "fullscreen"
}

/** <clauctlConfigDir()>/settings.json */
export function settingsPath(): string;

/**
 * Never throws. Missing file → defaults ({ tuiMode: "fullscreen" }).
 * Unparseable file, non-object root, unknown keys, or bad values →
 * warning(s) + default for the affected field(s).
 */
export function readSettings(path: string): {
  settings: ClauctlSettings;
  warnings: string[];
};
```

`src/tui/interactive-mode.ts` changes (signatures; `TUI` is now type-only in
pi-tui, `new TUI(...)` no longer compiles):

```ts
// runInteractive signature unchanged:
export async function runInteractive(
  client: SdkSocketClient,
  managed: boolean,
): Promise<void>;
// Internally: readSettings(settingsPath()) → warnings join startupWarnings;
// renderer construction replaces `new TUI(new ProcessTerminal())`:
//   regular:    new TuiMainScreen(terminal, undefined, logDirectory)
//   fullscreen: new TuiAltScreen(terminal, undefined, logDirectory, {
//                 searchMatchStyle, searchCurrentMatchStyle, copySelection })
// where logDirectory = dirname(flags.sdkSocket)  — plumbed from the _tui
// route into runInteractive (exact plumbing: see IMPLEMENTATION IDEAS).
// Stop: ui.stop({ preserveScreen: ui.mode === "fullscreen" }).

// InteractiveMode: constructor param and `ui` field stay typed `TUI`.
// Fullscreen layout is built by a pure, exported builder (testable without
// a terminal, like parseModelCommand); mounting is either/or per renderer
// (mountParts below).

export interface TuiParts {
  chatContainer: Container;
  statusContainer: Container;
  pendingMessages: Component;
  editor: Component;
  hintText: Component;
  footer: Component;
}
export interface FullscreenLayout {
  /** The component handed to TuiAltScreen.setLayoutRoot. */
  layoutRoot: VStack;
  transcriptScrollView: ScrollView;
}
export function buildFullscreenLayout(parts: TuiParts): FullscreenLayout;
// Module-private, both drawing on one ordering source (dockEntries):
//   dockEntries(parts): StackEntry[] — dock order + fullscreen sizing
//   mountParts(ui, parts) — viewport: setLayoutRoot(buildFullscreenLayout);
//                           regular: flat addChild (chat, then dock order)
```

`scripts/tui-parity/capture.ts`: the harness pins an isolated
`CLAUCTL_CONFIG_DIR` (`<clauctlDir>/config`) with
`settings.json = { tuiMode: "regular" }`, rewritten every run — parity
compares against native claude's main-buffer document, and captures must
not inherit the developer's real settings/keybindings.

`src/tui/external-editor.ts`: `editFileInExternalEditor`'s signature is
unchanged; its suspend becomes
`ui.stop({ preserveScreen: ui.mode === "fullscreen" })` so a fullscreen
suspend restores the pre-TUI screen instead of dumping the document
(success criterion 5).

`src/tui/theme.ts`: two palette additions (pi dark.json values), no API
change — `searchMatchBg` in `BG_COLORS`, `searchMatchText` in `FG_COLORS`.

No other symbols are added, removed, or changed. Components keep receiving
the concrete renderer instance through the `TUI` interface (both renderers
satisfy it; `Editor` and `Loader` constructors are unchanged in 0.84.2).

## Data flow

- Startup: `_tui` route → `runInteractive` → `readSettings` (warnings →
  `startupWarnings` banners) → renderer choice → `InteractiveMode`.
- Layout: mounting is either/or per renderer (`mountParts`) — regular mode
  mounts the flat document exactly as today; a viewport renderer instead
  gets the explicit layout root (pi mounts both unconditionally only
  because its runtime mode switching moves components between renderers —
  a non-goal here). Fullscreen builds

  ```
  root VStack
  ├─ ScrollView(chatContainer, { follow: "end", primary: true,
  │                              overscroll: "chain" })
  │    basis: 0, grow: 1, shrink: 1, minSize: 1
  └─ dock VStack                          basis: "auto", shrink: 1, minSize: 1
     ├─ statusContainer                   shrink: 1, minSize: 0
     ├─ pendingMessages                   shrink: 1, minSize: 0
     ├─ editor                            shrink: 1, minSize: 3
     ├─ hintText                          shrink: 1, minSize: 0
     └─ footer                            shrink: 1, minSize: 1
  ```

  (same visual order as today's flat mount). The `ScrollView` wraps
  `chatContainer` persistently; `reloadHistory`'s `chatContainer.clear()`
  keeps working unchanged because the container instance is never replaced.

- Input: `TuiAltScreen` registers its own viewport input listener in its
  constructor (before our `handleGlobalKey` listener), so fullscreen
  navigation keys are consumed there; search enter/escape/ctrl+g are only
  consumed while the search overlay is focused, so they do not shadow
  `app.interrupt`, editor submit, or `app.editor.external`.
- Shutdown: `runInteractive`'s `finally` calls
  `ui.stop({ preserveScreen: ui.mode === "fullscreen" })` — alt screen exits
  without printing the document; regular mode stops exactly as today.

## Cost

- Fullscreen renders viewport-sized diffs every frame instead of
  incremental bottom-region repaints, and the daemon's headless xterm
  (PtyScreen) now maintains an alternate buffer. Both are negligible at
  terminal sizes; no measurable memory or compute concern.
- The real cost is behavioral risk concentrated in the managed pty chain
  (PtyScreen serialization of the alt buffer, mouse-mode passthrough, the
  attach client's hint row) — hence the explicit smoke-test list in the
  success criteria.

## Edge cases

- Invalid `tuiMode` value (e.g. `"tuiMode": "full"`) → warning banner +
  fullscreen default.
- `settings.json` exists but is unparseable / non-object root → single
  warning + all defaults.
- Unknown top-level keys in `settings.json` → per-key warning, ignored
  (forward compatibility is _not_ a goal; warn like keybindings does for
  unknown action ids).
- Narrow/short terminals: dock `minSize` entries keep the editor (3 rows)
  and footer (1 row) alive; selectors/loader in `statusContainer` shrink the
  transcript region, not the editor.
- Home/End/PageUp/PageDown intentionally move from the editor to the
  transcript viewport in fullscreen (pi's design; ctrl-modified aliases
  remain on the editor via the 0.84.2 default bindings).

## Non-goals (follow-up specs)

This spec deliberately excludes the following; they are recorded here as the
starting point for subsequent specs:

1. **`/settings` command** — a menu for editing `settings.json` from inside
   the TUI.
2. **`clauctl attach` runs the TUI directly** — retire the daemon-hosted
   PtyScreen/tty.sock renderer where possible (keep tty.sock only where
   other-language SDKs require it). Benefits: detach becomes a real,
   remappable keybinding instead of a tty-level 0x1d intercept; the attach
   hint line becomes TUI-owned instead of a pty-screen hack
   (`hintRoomSequence`), which currently fights the fullscreen footer for
   the bottom row.
3. **Runtime mode switching** — pi's `Proxy<TUI>` + capture/restore +
   listener-rebind machinery. Deferred: the persisted setting plus
   reattach covers mode changes, and follow-up (2) makes reattach cheap.
4. **Hint-row fix** — if smoke tests show the attach hint misrendering over
   the fullscreen footer, document the symptom; the fix lands in pictl (the
   `PtyScreen`/attach code is generated from pictl) or via follow-up (2),
   not in this spec.
5. **`openUrl` (link opening from the transcript viewport)** — pi wires
   `openBrowser`, which pi-coding-agent does not export; likely resolved by
   having pi export it.

# IMPLEMENTATION IDEAS

## Upstream reference

Pi repo at tag `v0.84.2` (`/home/anton/git/earendil-works/pi`, read-only;
use `git show v0.84.2:<path>`). Key files:

- `packages/tui/src/tui.ts` — `TUI` interface, `TuiBase`, `isViewportTUI`,
  `TuiStopOptions`.
- `packages/tui/src/tui-alt-screen.ts` — `TuiAltScreen`,
  `TuiAltScreenOptions`, viewport input handling.
- `packages/tui/src/components/scroll-view.ts`, `v-stack.ts` — layout
  primitives.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` —
  `createInteractiveTui`, `init()` layout construction,
  `mountInteractiveTui`, `stopInteractiveTui` (the model for our
  composition).

## API facts established during derisking

- The only hard break in 0.80.10 → 0.84.2 for clauctl's import surface:
  `TUI` became a type-only export. `Container`, `Text`, `Editor`, `Loader`,
  `ProcessTerminal`, `matchesKey`, `KeybindingsManager`,
  `getKeybindings`/`setKeybindings`, `TUI_KEYBINDINGS` type shapes, and
  pi-coding-agent's `initTheme` are unchanged.
- `TuiBase` ctor: `(terminal, showHardwareCursor?, logDirectory?)`.
  `logDirectory` is debug-only: `pi-crash.log` (once, on a fatal render
  invariant) and `pi-debug.log` (only under `PI_DEBUG_REDRAW=1`). Default is
  `~/.pi/agent`, which is unacceptable for clauctl → pass
  `dirname(sdkSocket)` (the agent directory).
- `TuiAltScreenOptions` used here: `searchMatchStyle`,
  `searchCurrentMatchStyle`, `copySelection`. Pi's styling to copy:

  ```ts
  const styleSearchMatch = (text) =>
    theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
  searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
  searchCurrentMatchStyle: (text) =>
    theme.bold(theme.inverse(styleSearchMatch(text))),
  ```

  `copySelection: async (text) => { try { await copyToClipboard(text);
return true; } catch { return false; } }` with `copyToClipboard` imported
  from `@earendil-works/pi-coding-agent` (already exported there).

- `tui.altScreen.searchNext/searchPrevious/searchClose` are gated on the
  search overlay being _focused_; `tui.altScreen.search` (ctrl+shift+f) is
  global. `getConflicts()` inspects only user-configured bindings, so the
  default-level escape/enter/ctrl+g overlaps produce no warnings.
- `TuiAltScreen.stop({ preserveScreen: true })` exits the alt screen and
  shows the cursor without printing; without it, the full rendered document
  is replayed into main-screen scrollback.
- Without an explicit layout root, `TuiAltScreen` scrolls the whole
  document (no fixed dock) — the layout root is what produces pi-style
  fixed input.

## Plumbing logDirectory

`runInteractive(client, managed)` has no socket path today. Options:
add a `logDirectory` (or `sdkSocket`) parameter to `runInteractive`, or
read it from the client. Prefer an explicit parameter from the `_tui`
route (`dirname(flags.sdkSocket)`) — explicit data flow, no client API
change. Exact choice finalized at implementation, it's internal wiring.
(Resolved: explicit third parameter; see Implementation-Time Decisions.)

## Suggested sequence

1. Bump both deps to 0.84.2, `npm install`, review lockfile diff as code.
2. Mechanical migration: `new TUI(new ProcessTerminal())` →
   `new TuiMainScreen(...)`; `npm run check` + full suite green. Commit
   point: pure upgrade, zero behavior change.
3. `settings.ts` + tests (read/parse/warning cases, mirroring
   keybindings.test.ts style).
4. Renderer selection + alt-screen options + theme colors.
5. Layout root construction + `isViewportTUI` gate + stop semantics.
6. Composition tests (mode selection, layout shape), `npm run presubmit`.
7. Manual smoke tests in tmux per success criterion 8. Use an isolated
   config dir (`CLAUCTL_CONFIG_DIR`) per the TUI harness safety
   constraints.

## Testing notes

- `readSettings` is pure I/O + parse → direct unit tests with temp files,
  like `readKeybindingsConfig`'s tests.
- Layout composition: unit-test `buildFullscreenLayout` directly (scroll
  view wraps `chatContainer` with follow/primary/overscroll options; dock
  order and minSize entries) — no terminal or client fakes needed. Keep the
  assertion surface small; the layout engine itself is pi-tui's tested code.
- PtyScreen alt-buffer serialization and mouse passthrough are empirical:
  verify during smoke testing, not unit tests.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## 2026-08-20 — spec written

Derisking discussion resolved:

- Mode scope: persisted `settings.json` next to `keybindings.json`,
  default fullscreen. No CLI flag, no daemon plumbing.
- Exit/detach: clean restore (`preserveScreen: true` in fullscreen).
  Managed-mode `stop()` only runs at daemon shutdown anyway; non-managed
  matters mostly as the future default `clauctl attach` path.
- Runtime switching, `/settings`, attach-runs-TUI, hint-row fix, `openUrl`:
  follow-ups (see Non-goals).
- Search keybinding overlap concern dismissed with evidence (focus-gated).
- `logDirectory` → agent dir (`dirname(sdkSocket)`).

Critique pass (same day):

- Verified all needed pi-tui index exports at v0.84.2 (`TuiMode`,
  `isViewportTUI`, `ScrollView`, `VStack`, renderers).
- Found that pi's own external-editor suspend calls bare `ui.stop()`,
  which in fullscreen dumps the document into the main buffer. Decision:
  diverge — `preserveScreen` on fullscreen suspend (criterion 5).
- Added `buildFullscreenLayout` (pure, exported) to the type design for
  terminal-free layout tests; field named `layoutRoot` after pi-tui's
  `setLayoutRoot` vocabulary.

Tasks:

- [x] Dep bump + mechanical `TuiMainScreen` migration, suite green
- [x] `src/tui/settings.ts` + tests
- [x] Renderer selection, alt-screen options, theme colors
- [x] Fullscreen layout root + stop semantics
- [x] Composition tests + presubmit
- [x] tmux smoke tests (criterion 8) — owner rebuilt and manually verified
      2026-08-20; findings below (hint-row off-by-1, upstream copy issue)

## 2026-08-20 — implementation

- Dep bump 0.80.10 → 0.84.2. Lockfile diff reviewed: pi transitive deps
  added (`pi-client`, `pi-protocol`, `pi-telemetry`, `grok-mermaid`),
  dropped (`@mistralai/mistralai`, otel semantic-conventions, zod),
  bumped (`openai`, `typebox`, `undici`, `protobufjs`, `brace-expansion`);
  all resolve to registry.npmjs.org. The only source change the upgrade
  itself forced was `new TUI(...)` → `new TuiMainScreen(...)` — suite green
  at that point (589 tests) before any fullscreen work.
- Search colors resolved from pi dark.json: `searchMatchBg` `#3a3a4a`
  (selectedBg), `searchMatchText` `#d4d4d4` (text).
- `buildFullscreenLayout` asserts in tests via public surface only
  (`children`, `primary`, `overscroll`, `isFollowingEnd`); Stack entry
  options (minSize/grow) are protected in pi-tui, deliberately not
  asserted — the layout engine is upstream's tested code.
- Full `npm run presubmit` green (598 tests).

## Implementation-Time Decisions

- **`runInteractive` gained a third parameter `logDirectory: string`**
  (route passes `dirname(flags.sdkSocket)`). The spec's type-design block
  said "signature unchanged" while IMPLEMENTATION IDEAS deferred the exact
  plumbing; the explicit parameter won because it keeps data flow visible
  in the signature instead of threading the socket path through the client.
- **Layout built only inside the `isViewportTUI` gate**, not
  unconditionally as the spec snippet sketched. Building it in regular mode
  would wrap `chatContainer` in an orphan ScrollView (ScrollView pushes the
  child into its `children`) for no benefit.
- **tui-parity harness pinned to regular mode** (was: capture.ts set
  `CLAUCTL_DIR` but not `CLAUCTL_CONFIG_DIR`, so parity captures read the
  developer's real `settings.json` and would render fullscreen under the
  new default). Resolved per review: `ensureClauctlConfigDir()` writes
  `settings.json = { tuiMode: "regular" }` into an isolated
  `CLAUCTL_CONFIG_DIR` on every run. Side effect (intended): captures no
  longer inherit the developer's real keybindings.json either.

## 2026-08-20 — review round (TDC comments in 4f00c81)

- **Mount unification**: the flat addChild list and buildFullscreenLayout
  double-specified the component order. Replaced with one ordering source —
  module-private `dockEntries(parts)` — consumed by both the fullscreen
  dock VStack and the regular-mode flat mount, behind a single
  `mountParts(ui, parts)` composition point. Mounting is now either/or per
  renderer: pi mounts both only because runtime switching moves the same
  components between renderers (a recorded non-goal). Verified against
  pi-tui source that a viewport renderer with a layout root never consults
  flat children (`render`/`getMountedRoots` use the root exclusively).
- **pi-crash.log / ~/.pi/agent defaults in pi-tui**: agreed these are
  app-specific leakage in a general-purpose renderer (TuiBase defaults
  logDirectory to `$PI_CODING_AGENT_DIR ?? ~/.pi/agent`; TuiMainScreen
  hardcodes the `pi-debug.log`/`pi-crash.log` names, and the PI_TUI_DEBUG
  dump hardcodes `/tmp/tui`). clauctl sidesteps it by always passing
  logDirectory explicitly. Handoff for the upstream fix written to
  `pi/docs/handoff-tui-log-paths.md` (in the pi monorepo) for a pi agent
  to pick up.

## 2026-08-21 — smoke-test findings (owner-run)

Core fullscreen behavior works: layout, transcript scrolling, mouse-wheel
passthrough through PtyScreen/attach, detach/reattach. Two findings:

- **Hint-row off-by-1 (the predicted `hintRoomSequence` conflict; feeds
  follow-up spec 2, attach-runs-TUI-directly).** In fullscreen the footer
  always occupies the pty's bottom row, so on attach the hint-room hack
  scrolls the replayed snapshot by one line; the alt-screen renderer's
  subsequent absolute-row updates then land one row off on the attacher's
  terminal. Observed symptoms (sample: /tmp/hint_row): (a) after
  detach/reattach, typing overwrites the editor's bottom border row and
  duplicates the line being typed; (b) scrolling up after attach eats the
  editor's top border until a typed line break forces a repaint. Root
  cause is in pictl-generated attach/pty-screen code (`hintRoomSequence`,
  written for document-mode content where the bottom row can be vacated);
  fix belongs in pictl or is mooted by attach running the TUI directly.
- **Selection copy is an upstream pi issue, not clauctl's.** Select shows
  "Copied!" but nothing reaches the paste buffer; identical behavior in
  regular pi. Selection also only works inside tmux (outside tmux mouse
  selection doesn't engage at all); shift+select inside tmux reaches the
  middle-click buffer via the terminal's native path. Candidate for a pi
  handoff (likely `copyToClipboard`'s Linux tool fallback vs. the
  tmux/no-`$DISPLAY` environment); not tracked further here.

Hint-row fix decision (same day): considered replacing the attach client's
bottom-row hint with a TUI-side toast (`TuiAltScreen.flash()` is public
pi-tui API; frame-composited, so no off-by-1 by construction) driven by a
new daemon→TUI "attached" event over sdk.sock, with `hintRoomSequence`
suppression as a per-client tty-protocol parameter in pictl. Rejected as
interim work: most of it is throwaway once `clauctl attach` runs the TUI
directly (follow-up spec 2), which dissolves the snapshot/hint machinery
wholesale. Decision: fix via follow-up 2 only; managed fullscreen attach
stays visibly off-by-1 until then.
