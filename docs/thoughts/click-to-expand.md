# Click-to-expand for every collapsible transcript element

Today the transcript has two global toggles and nothing finer: `ctrl+o`
flips `toolsExpanded` (tool output, user-command output, compact
summaries) and `ctrl+t` flips `showThinking`. Expanding one tool result
expands all of them. pi 0.87 added per-element left-click toggling via
`MouseRegion`; we dropped that hunk in the 0.80.10 → 0.87.1 port
migration (see `assistant-message.ts` header) because our pi-tui is 0.84.2.

## Findings (2026-09-22, pi-tui 0.87.1 source)

- `MouseRegion(child, handler)` is a transparent wrapper: renders the
  child, forwards mouse events to it first, then runs `handler` if the
  child didn't handle them. `Container.handleMouse` hit-tests children by
  their last rendered height, so wrapping is all a leaf component needs.
- **Mouse reporting is only enabled by `TuiAltScreen`** (`?1000/1002/
  1004/1006h` on enter; `options.mouse ?? true`). `TuiMainScreen` never
  turns it on, so in regular mode clicks stay with the terminal (text
  selection) and no `handleMouse` fires. Click-to-expand is a
  fullscreen-only feature unless we add main-screen mouse tracking, which
  would break native selection — not worth it.
- pi's pattern (tool-execution, compaction-summary, branch-summary,
  skill-invocation): the component owns `expanded`; the click handler
  calls `this.setExpanded(!this.expanded)`; the global toggle calls
  `setExpanded(global)` on every component and so **overwrites per-item
  state**. Only `assistant-message` uses an override map
  (`thinkingVisibilityOverrides: Map<runIndex, boolean>`) because its
  `hideThinkingBlock` flag is applied per render; the map is cleared when
  the global flips. Both converge on the same semantics: a global toggle
  resets all per-item choices.
- pi-tui and pi-coding-agent bumped to 0.87.1 (done 2026-09-22). The 0.85.0 breaking change
  (env-var defaults removed) was a no-op for us: `PI_HARDWARE_CURSOR` /
  `PI_CLEAR_ON_SHRINK` defaulted to false and we never documented them;
  `createTui` now passes `false` explicitly.

## Inventory of collapsibles

| Element                                 | Component                                                     | State today                                          |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| Tool call args/result                   | `ToolExecutionComponent.setExpanded`                          | global `toolsExpanded`                               |
| Nested subagent tools                   | child `ToolExecutionComponent`s via `addSubagentChild`        | inherit parent's set                                 |
| User `!`/slash command output           | `UserCommandComponent.setExpanded` via `UserTurnComponent`    | global `toolsExpanded`                               |
| Compact summary                         | `CompactSummaryComponent.setExpanded`                         | global `toolsExpanded` (`setCompactSummaryExpanded`) |
| Thinking runs                           | `AssistantMessageComponent.setHideThinkingBlock`              | global `showThinking`                                |
| Folded runs of read-only tools/thinking | `foldRunComponent` one-liner, rebuilt in `Transcript.rebuild` | exists only while both globals are collapsed         |

The fold line is the odd one: it is not a component with state but a
stateless line regenerated from the run each `rebuild()`, and a run's
membership changes as items resolve. Clicking it should unfold that run
(show its items individually, each still collapsed), which needs a
per-run identity that survives rebuild — e.g. the uuid of the run's first
item.

## Sketch

1. ~~Bump pi-tui to 0.87.1~~ done.
2. Re-apply the dropped `assistant-message.ts` hunk from
   `git -C $PI_REPO show v0.87.1:…/assistant-message.ts` (the update-ports
   patch in `/tmp` is gone; regenerate with `scripts/update-ports.sh
   v0.87.1 v0.87.1` — no-op diff — or copy by hand). Remove the header
   difference line.
3. Wrap each collapsible's content in `MouseRegion` with the same
   left-click → `setExpanded(!expanded)` handler. Since
   `Transcript.setToolsExpanded` already fans out `setExpanded(global)`,
   pi's overwrite semantics fall out for free; no override map needed
   outside assistant-message.
4. Fold lines: give `foldRunComponent` a click handler that records the
   run's first-item uuid in a `Transcript.unfoldedRuns: Set<string>`;
   `rebuild()` skips folding a run whose first item is in the set;
   `setToolsExpanded`/`setShowThinking` clear the set.
5. Update the `(ctrl+o to expand)` hint text? Claude's hint mentions only
   the key; in fullscreen we could append "or click". Parity spec says
   follow claude — leave the text.

## Open questions

- Should a click on a _collapsed_ fold line unfold to individually
  collapsed items (one step) or straight to expanded items (two steps at
  once)? pi has no fold lines, so no precedent. One step matches the
  key-toggle mental model (`ctrl+o` = one level).
- `ToolExecutionComponent` for subagent parents: does a click on the
  parent header expand the parent only or the whole subtree? pi expands
  the clicked component only.
- Regular mode: document in `docs/specs/tui.md` that click-to-expand is
  fullscreen-only, or is main-screen mouse tracking worth a spike? The
  terminal's own selection is the cost; pi made the same call.
