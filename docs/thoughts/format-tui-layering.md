# Layering: tui → format → core, views into format, barrels

Follow-up from the entry-views review round (`git show 06208c5`, TDCs in
`src/core/entry-sink.ts`, `src/format/command.ts`, `src/format/entries.ts`,
`src/tui/entry-views/entry-view.ts`, `src/tui/entry-views/attachment-view.ts`).
Spec context: `docs/specs/entry-views.md`.

## Decided

- Dependency direction is **tui → format** (tui is interactivity and
  styling; format is text from data) and **nothing imports tui from core**.
  Enforce with an eslint rule.
- The entry/tool/attachment views (`src/tui/entry-views/`,
  `src/tui/tool-views/`) move into `src/format/`; their text-only parts are
  format code. The move is the moment to barrelize them, following
  `docs/thoughts/barrel-boundary-eslint-generator-spec.md` (public interface
  in `index.ts`, no deep imports from outside, no self-import through the
  barrel from inside) so the later generator is a no-op migration.
- Barrel layout: `entry-view/` (public: `EntryView`, `entryViewFor`, plus
  whatever `format/tree.ts` still needs after the toolNames change below —
  enumerate before writing) with nested `tool-view/` and `attachment-view/`
  barrels. `attachment-view/` exposes only `AttachmentView` and
  `attachmentViewFor`; the per-type views and `payload.ts` are internal.
- Tool-name tracking leaves the views: the owner of the entry stream keeps
  the `tool_use id → name` map incrementally (`trackToolNames` per ingested
  entry) and hands it to consumers; `collectToolNames` (a full re-scan) is
  deleted. `SessionModel` (`src/tui/session-model.ts`, owns `byUuid`) is the
  TUI owner; the `format tree` snapshot path needs the same at its loader.
  Home for `trackToolNames`: core/session, next to entry ingestion.

## Current state (facts)

Edges that violate the decided order, all pre-existing except the
entry-views ones:

- core → tui: `core/spawn.ts`, `core/app.ts` → `tui/attach.ts` (composition
  roots); `core/entry-sink.ts` → `tui/entry-views/entry-view.ts`
  (`trackToolNames`).
- core → format: `core/entry-sink.ts` → `format/messages.ts`.
- format → tui: `format/messages.ts`, `format/sdk-message.ts`,
  `format/events.ts` → `tui/sdk-render.ts` / `tui/render-types.ts` (pure
  SDK-message → render-shape conversion, nothing TUI-specific);
  `format/messages.ts` → `READ_ONLY_TOOLS` from `tui/tool-views/tool-view.ts`;
  `format/tree.ts`, `format/entries.ts`, `format/command.ts` →
  `tui/entry-views/entry-view.ts`.
- tui → format: 4 files (fine).

`ToolView` (`src/tui/tool-views/tool-view.ts`) is mixed: `displayName`,
`header`, `resultSummary`, `foldLabel` are text; `headerLink` and
`resultBody` are presentation (`edit.ts`, `read.ts`, `write.ts` use
`claudeStyle` in `resultBody` diffs). `EntryView` and `AttachmentView` are
pure text.

`src/format/generated/text.ts` is pictl-synced; `oneLinePrefix`,
`formatSize`, `padEndCodePoints` are being moved there (immediate fix) and
Anton upstreams.

## Open questions

1. Where do `core/spawn.ts`/`core/app.ts` → `tui/attach` go: move the
   composition root out of core, or an explicit exception list in the rule?
2. Is `core → format` allowed (entry-sink → messages)? If the order is
   strictly tui → format → core, `entry-sink.ts` is not core code.
3. `ToolView` split: one interface with the presentation methods optional,
   implemented in format, and the TUI decorates? Or two registries (format
   `ToolView` text; tui `ToolPresentation` with `headerLink`/`resultBody`)
   keyed by tool name? The second keeps format free of `claudeStyle`; the
   first keeps one file per tool. Decide with the spec.
4. `sdk-render.ts`/`render-types.ts`: format or core?
5. Tests that strip the size column with a regex (`format/tree.test.ts`
   `render`, `tui/components/tree-selector.test.ts` `withoutSize`) exist
   because sizes are baked into every rendered line. Anton expects a
   `--no-sizes` flag / user setting soon; a `sizes` option on
   `treeLines`/`formatSnapshotDocument`/the selector removes the regexes.
   Put it in this spec or its own.

## Plan sketch

1. Decide the layer order and exceptions (questions 1–2); add the eslint
   rule with the current violations listed, so it fails until each is fixed.
2. Move `sdk-render`/`render-types`; move `READ_ONLY_TOOLS` with them or
   into the tool-view barrel.
3. Tool-name map into the stream owners; delete `collectToolNames`.
4. Split `ToolView`; move views into `src/format/` as barrels.
5. `sizes` option; delete the test regexes.
