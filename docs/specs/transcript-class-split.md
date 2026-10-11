# Spec: Split the transcript module

> The user manages all git operations; implementing agents must not
> commit, stage, or otherwise mutate git state.

Follows docs/specs/transcript-barrel-and-banner.md (the barrel and
`Banner`). Precedent: docs/specs/interactive-mode-class-split.md.

## SPEC (stable requirements)

### Problem

`src/tui/transcript/transcript.ts` is about 1180 lines. The renderer
class shares the file with item types, fold-run rendering, the compact
summary component and pure helpers, and its `appendMessage` is one
260-line switch. A reader must open method bodies to see how it works.

### Rule (Anton, 2026-10-09)

A helper moves to its own file when it has a meaning of its own and its
signature makes plain what it does, even with one user. One
responsibility per file. Switch arms are short: they delegate to a
helper, or inline logic only when it is a line or two and obvious.

### Success criteria

1. `TranscriptRenderer` is renamed `Transcript` everywhere outside
   `docs/specs/` (importers: `src/tui/interactive-mode/interactive-mode.ts`,
   `scripts/tui-parity/render-session.ts`, `transcript.test.ts`;
   comments too). `InteractiveMode`'s field stays `transcript`.
2. The files and symbols below exist with exactly this type design, all
   in `src/tui/transcript/`; `index.ts` exports `Transcript` and
   `type Banner` only.
3. `Transcript` keeps no copy of extracted logic.
4. Behaviour is unchanged. All existing tests pass with only the rename
   applied; the new unit tests below pass; `npm run ready` passes.

### Type design (approved 2026-10-11)

`transcript-item.ts`: `ItemKey`, `AssistantItem`, `ToolItem`,
`PlainItem`, `UserTurnItem`, `TranscriptItem` and `isOpenStream` move
here unchanged (exported), with their doc comments.

`transcript-items.ts`: owns the resolved/pending split.

```ts
export type ItemPart = "resolved" | "pending";

/** The transcript's items in order: the resolved part, then the pending
 *  part. */
export class TranscriptItems {
  get resolved(): readonly TranscriptItem[];
  get pending(): readonly TranscriptItem[];
  /** The last item overall: pending's last, else resolved's. */
  last(): TranscriptItem | undefined;
  /** A keyed item into `part`; an open stream's item into pending; any
   *  other unkeyed item behind the pending items if there are any, else
   *  into resolved. Ahead of `before` when `before` is in the target
   *  list, else at its end. */
  insert(item: TranscriptItem, part: ItemPart, before?: TranscriptItem): void;
  /** The pending prefix through the last item keyed `uuid`, plus the
   *  unkeyed items after it up to the next keyed item or open stream,
   *  joins resolved. No-op when no pending item is keyed `uuid`. */
  resolveThrough(uuid: UUID): void;
  /** Removes `item` from pending (no-op if absent); when it was the
   *  pending head, the unkeyed items now at the head join resolved. */
  removePending(item: TranscriptItem): void;
  clear(): void;
}
```

It replaces `resolvedItems`, `pendingItems`, `partFor`, `insertItem`'s
list logic, `resolvePrefix`, and the splice in `discardStream`. The file
comment's paragraph on the two parts (resolution order, unkeyed items,
open streams, the invariant that pending is empty or starts with a keyed
item or an open stream) moves to this class's doc comment; comments
that say "see file comment" for it (`ItemKey.uuid`, `discardStream`)
point to `TranscriptItems` instead. Every `part` parameter that routes
an insertion (`appendMessage`, `addUserTurn`, `addPlain`, `addItem`,
`attachAssistant`, `renderCompactSummary`) becomes `part: ItemPart`.
`rebuild`'s local `addPart` keeps taking items
(`readonly TranscriptItem[]`, from the getters) and still runs once per
part, flushing the fold run at the end of each, even with no pending
boundary drawn: a fold run never spans the two parts. `insertItem` is
removed; its callers call `this.items.insert(item, part,
stream?.item)`.

`time-tracker.ts`:

```ts
/** The previous top-level entry's time, for thinking durations. */
export class TimeTracker {
  /** Seconds from the previous entry to `message` (arrival time when it
   *  has no timestamp); undefined with no previous entry or when time ran
   *  backwards. */
  secondsSincePrevious(message: SDKMessage): number | undefined;
  /** Records `message` as the latest entry; never moves backwards. */
  stamp(message: SDKMessage): void;
}
```

It replaces `lastEntryAtMs`, `entryDeltaSeconds`, `stampEntry` and
`messageTimestampMs` (module-private here). `conversation_reset`
replaces the instance (the field is not readonly). The file comment's
duration rule moves here; `stamp`'s comment keeps the monotonic and
arrival-time rationale.

`thinking.ts`:

```ts
export function hasThinking(rendered: RenderAssistant): boolean;
export function displayThinkingSeconds(seconds: number): number;
/** The collapsed-thinking label of an unfolded assistant item. */
export function hiddenThinkingLabel(seconds: number | undefined): string;
```

`hiddenThinkingLabel` returns the two strings `applyThinkingLabel`
builds today; the ctrl+t divergence comment moves with it.

`system-banner.ts`:

```ts
/** The banner a system message shows: notification text, a non-info
 *  informational message, or a model refusal; undefined otherwise. */
export function systemBanner(
  message: Extract<SDKMessage, { type: "system" }>,
): Banner | undefined;
```

Moves (code and doc comments unchanged, now exported):

- `fold-run.ts`: `isFoldable`, `foldRunComponent`; the file comment's
  fold-run definition moves to `foldRunComponent`'s doc.
- `compact-summary.ts`: `CompactSummaryComponent`, `compactBanner`.
- `entry-user-views.ts`: `entryUserViews`.
- `suppress-no-response.ts`: `suppressNoResponse`.

`transcript.ts` keeps `Transcript` and `StreamingComponent`. Fields:
`items: TranscriptItems` and `timeTracker: TimeTracker` replace the
fields above. New private methods:

```ts
private appendStreamEvent(message: Extract<SDKMessage, { type: "stream_event" }>, part: ItemPart): void;
private appendAssistant(message: Extract<SDKMessage, { type: "assistant" }>, part: ItemPart): void;
/** The block `uuid` leaves `stream`'s partial (once per uuid). */
private finalizeStreamBlock(stream: StreamingComponent, uuid: UUID): void;
private attachToolCall(block: ToolCallBlock, parentToolUseId: string | null,
  uuid: UUID | undefined, part: ItemPart, stream: StreamingComponent | undefined): void;
private appendUser(message: Extract<SDKMessage, { type: "user" }>, part: ItemPart): void;
private appendSystem(message: Extract<SDKMessage, { type: "system" }>, part: ItemPart): void;
/** Forget the old conversation. */
private reset(): void;
private addCompactBoundary(preTokens: unknown, postTokens: unknown, uuid: UUID | undefined, part: ItemPart): void;
/** The interrupt marker as a banner when there is one, else the user
 *  turn of `views`; claims `key` (`firstRender`). */
private addUserContent(marker: string | undefined, views: readonly UserTurnView[],
  key: UUID | undefined, part: ItemPart, outputTarget: UserTurnItem | undefined): void;
private attachHookContext(hookContext: HookAdditionalContext, uuid: UUID | undefined): void;
```

Neither type is named today, and none is introduced: `ToolCallBlock`
stands for `Extract<RenderAssistant["content"][number], { type:
"toolCall" }>` and `HookAdditionalContext` for
`NonNullable<ReturnType<typeof hookAdditionalContext>>`, written inline.

Members not named in this spec stay in `Transcript` unchanged.

Order constraints the extraction keeps:

- `appendAssistant` calls `finalizeStreamBlock` before the
  already-rendered check (`renderedUuids`): a frame whose entry rendered
  first must still take its block out of the stream.
- `appendUser` clears `expectedSummaryUuid` on every top-level user
  frame, replays included, before deciding what to render.

`appendMessage`'s arms each call one of these (`result` stays inline).
`appendEntry` uses `addCompactBoundary`, `attachHookContext` and
`addUserContent`; the user frame path uses `addUserContent`.
`addUserContent` keeps today's claiming rule: a marker claims `key`
always; views claim it only when non-empty (an empty turn leaves `key`
unclaimed). Callers compute `views` eagerly (`userTurnViews` and
`entryUserViews` are pure).

### Data flow

Unchanged.

### Cost

None at runtime: two small objects per transcript; no extra passes.
Review effort concentrates on `TranscriptItems` (the resolution
invariant) and the merged duplicates.

### Non-goals

- Changing `appendEntry`'s or `resolve`'s behaviour or public API (other
  than the rename).
- Renaming `addBanner`, `append`, `appendEntry`, `resolve`.

## IMPLEMENTATION IDEAS

- Steps, each passing `npm run ready`: (1) rename; (2) verbatim moves of
  item types, fold run, compact summary, entry views, suppress, thinking
  helpers; (3) `TimeTracker`; (4) `TranscriptItems`; (5) the
  `appendMessage`/`appendEntry` helpers and `systemBanner`.
- New tests beside the new modules:
  - `TranscriptItems`: keyed item to its part; unkeyed to resolved when
    pending is empty, behind pending otherwise; open stream to pending;
    `before` in the target list, in the other list, and absent (the last
    two append); `resolveThrough` moves trailing unkeyed items, stops at
    a keyed item and at an open stream, moves through the last of
    several items sharing the uuid, and is a no-op for an unknown uuid;
    `removePending` of an absent item (no-op), a non-head item (nothing
    resolves), and the head (unkeyed items behind it resolve, stopping
    at an open stream).
  - `TimeTracker`: no previous → undefined; delta in seconds; backwards
    → undefined; `stamp` never moves backwards; a missing or invalid
    timestamp uses arrival time.
  - `systemBanner`: notification; informational info vs warning;
    refusal with category, explanation and fallback; other subtype →
    undefined.
- Plain `mv`/new files only; no git commands.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Type design approved by Anton (2026-10-11): `TimeTracker`;
      `TranscriptItems`/`ItemPart`; item types in `transcript-item.ts`,
      separate from `transcript-items.ts`.
- [x] Reviewer pass (pictl c61daadb): behaviour and imports confirmed
      (no cycles; every list operation expressible). Applied: `ItemPart`
      only for routing parameters, `addPart` keeps per-part flushing;
      "see file comment" references retargeted; unlisted members stay;
      `insertItem` inlined into `items.insert`; two order constraints
      pinned; edge-case tests added.
- [x] Anton approved the spec (2026-10-11).
- [x] Step 1 rename done (also docs/follow-ups/large-sessions.md;
      docs/follow-ups/old/ left as historical). ready: 969 pass.
- [x] Step 2 moves done: transcript-item.ts, thinking.ts (with
      `hiddenThinkingLabel`), compact-summary.ts, entry-user-views.ts,
      suppress-no-response.ts, fold-run.ts. transcript.ts 1177 → 941
      lines. ready: 969 pass. Fold-run definition moved to
      `foldRunComponent`'s doc during step 4.
- [x] Step 3 TimeTracker (+5 tests; duration rule moved from the file
      comment). ready: 974 pass.
- [x] Step 4 TranscriptItems (+12 tests). `insert`'s part lookup is
      inline (a private `list(part)` would be a one-call-site one-liner).
      `discardStream` keeps its original order (component splice, then
      `removePending`). ready: 986 pass.
- [x] Step 5 helpers and `systemBanner` (+4 tests). transcript.ts
      ends at 867 lines (was 1177). ready: 990 pass. Decisions:
      `finalizeStreamBlock`'s doc carries the moved inline comment (once
      per uuid, whichever side first; the block renders ahead of the
      stream); `appendSystem`'s "other subtypes" comment moved to the
      top with the init/status note; `appendEntry`'s doc pointed at a
      nonexistent `appendUserEntry`, now `addUserContent`.
- [x] Implementation review (reviewer c61daadb): no behavioural
      regression; eager `userTurnViews`/`lastUserTurnItem` confirmed pure.
      Applied: `finalizeStreamBlock`'s doc no longer claims the block
      renders (its caller may return early; the file comment says it);
      the arrival-time test mocks `Date.now` and asserts exact seconds
      for both methods. Open: criterion 1 literally covers
      docs/follow-ups/old/ (transcript-order.md,
      interactive-mode-test-harness.md still say `TranscriptRenderer`);
      left as historical (Anton, 2026-10-11).
