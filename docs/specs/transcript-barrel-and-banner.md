# Spec: Transcript barrel, then a Banner type

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

Origin: Anton's review of the class split (commit cb8698a): the `TDC` on
`Banner` in `src/tui/interactive-mode/keybindings-commands.ts` asks why a
banner type lives with keybindings. A banner is a transcript concept, and
`src/tui/transcript.ts` (1178 lines) is too large to absorb more, so it
becomes a barrel first. Precedent: docs/specs/interactive-mode-split.md.

## SPEC (stable requirements)

Two logical changes, in order; each passes `npm run ready` on its own, so
Anton can review and commit step 1 before step 2.

### Step 1: pure move

1. `src/tui/transcript.ts` → `src/tui/transcript/transcript.ts` and
   `src/tui/transcript.test.ts` → `src/tui/transcript/transcript.test.ts`,
   verbatim. The only edits to moved code are import paths and path
   references in code comments.
2. New `src/tui/transcript/index.ts` (header comment, then
   `export { TranscriptRenderer } from "./transcript.ts";`).
3. One way in: code outside `src/tui/transcript/` imports only
   `index.ts`; files inside import siblings. `eslint.config.js`:
   - add to `barrelPatterns`:
     `group: ["**/transcript/*", "!**/transcript/index.ts"]`, message
     "Import transcript/index.ts; the siblings are implementation.";
   - add `barrelImplementation("tui/transcript")`.
     No other `transcript/` directory exists in `src/` or `scripts/`
     (checked 2026-10-10).
4. Importers switch to `transcript/index.ts`; both import only
   `TranscriptRenderer`: `src/tui/interactive-mode/interactive-mode.ts`,
   `scripts/tui-parity/render-session.ts`.
5. Comments elsewhere name the file bare (`transcript.ts` in
   `src/format/sdk-render.ts`, `src/format/entry-view/tool-view/tool-view.ts`,
   `src/core/settings.ts`, `transcript.test.ts`); the file keeps that
   name, so they stay. Specs in `docs/specs/` are historical and stay as
   they are; so do captured outputs in `scripts/tui-parity/out/`.
6. All tests keep their names and bodies; `npm run ready` passes.

### Step 2: Banner

Type design (approved 2026-10-10):

```ts
// src/tui/transcript/banner.ts
/** A transcript notice; dim unless `color` says otherwise. */
export interface Banner {
  text: string;
  color?: ThemeColor;
}
/** The component that shows `banner`. */
export function bannerComponent(banner: Banner): Component;
```

- `bannerComponent` replaces the module function `bannerText(text,
  color = "dim")` in `transcript.ts`; same rendering, the default now
  lives here.
- `index.ts` also exports `type Banner`.
- `TranscriptRenderer.addBanner(banner: Banner, uuid?: UUID): void`
  replaces `addBanner(text, color = "dim", uuid?)`. Its doc comment
  stays, minus "dim" as a fixed property.
- `InteractiveMode`:
  - `private addBanner(banner: Banner): void` replaces
    `addBanner(text, color = "dim")`;
  - `addBanners(banners: readonly Banner[])` stays (it also requests the
    render);
  - `addEventBanner(text: string, uuid: UUID)` keeps taking text;
  - the `SessionModels` callback becomes
    `(message) => this.addBanner({ text: message })`.
- `keybindings-commands.ts`: imports `Banner` from
  `../transcript/index.ts`; its local `Banner` and the TDC go.
  "keybindings reloaded" is `{ text: "keybindings reloaded" }` (no
  color). `keybindings-commands.test.ts` imports `type Banner` from
  `../transcript/index.ts` too, and its two "keybindings reloaded"
  expectations drop `color: "dim"`.
- Call sites drop an explicit `"dim"`: `{ text }` only.
- Unchanged: `resolutionBanner`, `anomalyReport` and `compactBanner`
  return text; their callers wrap it.

### Data flow

Unchanged: a banner's color is decided where it is created; the
transcript renders it in transcript order.

### Cost

None at runtime. Review effort concentrates on step 2's ~40 mechanical
call-site edits (28 in interactive-mode.ts, 6 in the transcript, 6 in
transcript tests); step 1 is verbatim.

### Non-goals

- Extracting helpers or splitting `TranscriptRenderer` (item types, fold
  runs, compact summary): the follow-up, after Anton reviews the move.
- Changing `SessionModels`' banner callback type or the text-returning
  banner functions.

## IMPLEMENTATION IDEAS

- Step 1: `git mv` is a git mutation — use plain `mv` and let Anton stage.
- Step 1: run `npm run lint` to confirm the barrel rule fires on a deep
  import (temporarily, then revert) and that no other `transcript/` path
  trips it.
- Step 2: grep `addBanner(` across `src/` and `scripts/` to find every
  call site; the typechecker catches any missed positional call.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Type design approved by Anton (2026-10-10)
- [x] Critique pass (2026-10-10): confirmed the two importers (both
      `TranscriptRenderer` only) and no other `transcript/` path; bare
      `transcript.ts` comment references stay (name unchanged); dropped
      "one-line" from `Banner`'s doc (banners can wrap); added the
      keybindings test's `Banner` import.
- [x] Anton approved the spec; step 1 implemented (2026-10-11). The
      moved files differ from HEAD only in import lines; a temporary deep
      import of `transcript/transcript.ts` from interactive-mode.ts
      tripped the new lint rule (reverted). Old-path mentions remain only
      in `docs/specs/` and `docs/follow-ups/old/` (historical).
      `npm run ready`: 969 tests pass. Awaiting Anton's review and commit.
- [x] Step 1 committed by Anton.
- [x] Step 2 implemented (2026-10-11): `transcript/banner.ts`; all call
      sites take `Banner`; the keybindings-commands TDC is gone. No
      explicit `"dim"` remains. `bannerText`'s doc comment (minus
      "one-line") moved to `bannerComponent`. `npm run ready`: 969 tests
      pass. Awaiting Anton's review.

## Implementation-Time Decisions

- **Every `bannerText` call became `bannerComponent({ text })`**,
  including the ones that bypass `addBanner` (interrupt markers via
  `addPlain`, the compact boundary, the collapsed compact summary).
