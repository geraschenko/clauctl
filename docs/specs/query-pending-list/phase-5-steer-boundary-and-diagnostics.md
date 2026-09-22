# Phase 5: steer boundary, anomaly diagnostics, output attach, merge divider

> Follow-up to phases 1.5–4 (docs/specs/query-pending-list/), from the
> two tracker anomalies of 2026-09-22 in Anton's session (bundles
> `anomaly-2026-09-22T01-03-13-906Z.json`, `…T19-21-56-242Z.json`) and
> the phase-1.5 deferred item "Command output attachment". Status:
> **IMPLEMENTED** (2026-09-22); see WORK LOG for deviations.

Five independent items, one commit each (Plan):

1. Steer dequeue at the API-response boundary (queue-model.ts) — a bug.
2. Anomaly banner names the bundle and asks for a report — every anomaly
   becomes a `trackerAnomaly` event carrying its bundle path.
3. Anomaly bundle ring without stream events — diagnostics.
4. Command output attaches to its command by `parentUuid` — a bug.
5. `showResolvedBoundary` setting: a divider between the transcript's
   resolved and pending parts — debugging aid, off by default.

## Problem

**1.** `queue-model.ts` marks a queued demotable message at the first
`tool_result` after its acceptance and dequeues it as a steer at the next
assistant activity (an `assistant` frame or a `stream_event`). The CLI
absorbs the steer only after the **last** `tool_result` of the API
response that issued the calls: bundle 19:21Z — response
`msg_011CfK27kR` had 14 `tool_use` blocks filed interleaved with their
results; the `queued_command` attachment (`source_uuid 4a1547bb`) follows
the 14th result, but the daemon's dequeue was emitted at the second block,
~10 shared nodes early, so the merge saw the two streams disagree on the
order of `4a1547bb` and the response's nodes → head-mismatch. The batch
probe (docs/derisk/queued-batches/) only had single-tool responses, so
"next assistant activity" and "next response" were indistinguishable.

**2.** The TUI banner says `tracker anomaly <detail>` and nothing else. The
daemon writes a bundle (`AnomalyRecorder.write`) and logs its path, but
the user sees neither; an anomaly should tell the user it is a clauctl
bug, where the evidence is, and whom to send it to.

**3.** The bundle's ring of 50 event summaries held 42 and 38
`stream_event` summaries in the two bundles. Stream events carry no uuid
the merge relates to anything (query-only, resolved in their own step),
so they only push the useful context out.

**4.** `TranscriptRenderer.addUserTurn` attaches an output-only user turn
(a `system/local_command` stdout entry) to the **last** item overall when
that is a user turn with a command. The entry names its command: its
`parentUuid` is the command entry's uuid, which is the stamped echo uuid
keying the command's user-turn item. Under the two-part transcript the
last item can be a pending item unrelated to the command (phase 1.5
IMPLEMENTATION IDEAS, "Command output attachment").

**5.** Nothing shows where the resolved part ends and the pending part
begins; understanding the merge from the TUI means inferring it.

## Success criteria

1. A steer queued during a response with N tool calls dequeues after the
   Nth `tool_result`, at the first `assistant` frame of the next response
   — the file's placement (attachment after the last result, before the
   next assistant entry). Unit tests on queue-model.ts; one LIVE probe
   with parallel tool calls (Tests).
2. Every anomaly banner reads
   `tracker anomaly <detail> — this shouldn't happen; details in <bundle
   path>; contact Anton (geraschenko@gmail.com) to help fix it`, in the
   TUI and in `clauctl tail` output.
3. Bundle rings contain no `stream_event` and no subagent-traffic
   summaries; an `assistant` summary carries the API `message.id`, an
   entry summary its `parentUuid`.
4. A command's stdout entry attaches to the user turn keyed by its
   `parentUuid` wherever that item is; with no such item it renders
   standalone. The query-side `local_command_output` frame (no parent
   reference) keeps the last-item rule.
5. `settings.json` `"showResolvedBoundary": true` draws a full-width yellow
   rule between the resolved and pending parts on every rebuild (at the
   end when nothing is pending); default `false` draws nothing.

## Type Design

### 1. queue-model.ts

```ts
export interface QueueModelState {
  queued: QueuedMessage[];
  /** `message.id` of the last top-level `assistant` frame: the response
   *  in progress. A frame with another id opens the next response. */
  currentApiMessageId: string | undefined;
}
// INITIAL_QUEUE_MODEL_STATE gains `currentApiMessageId: undefined`.
```

`observeSdkMessage` arms:

- `user` with `tool_result`, top level only: mark, as today.
- `assistant`, top level only: `boundary = message.message.id !==
  state.currentApiMessageId`; when `boundary`, emit one `steer` dequeue per
  marked demotable entry (as today) and set `currentApiMessageId`. Not a
  boundary → no events.
- `stream_event`: no longer a trigger (the `assistant` frame for block 0
  precedes `content_block_stop 0`, and the hub already places a steer
  dequeue before its trigger, so partials add nothing).
- `result`: unchanged.

"Top level" = `parent_tool_use_id === null` (the field exists on user,
assistant and stream_event frames; subagent traffic has a string). See
Edge cases for why subagent frames are ignored in both arms.

### 2. Every anomaly is a `trackerAnomaly` event with its bundle path

Responsibilities: the daemon detects anomalies (its fold for
merge-error/head-mismatch, its tracker for the rest), writes the bundle
and reports each one as a `trackerAnomaly` event; clients handle
`trackerAnomaly` events only. `AgentState.anomaly` becomes fold-internal:
"this fold detected an anomaly" — read by the hub, by nobody else.

```ts
// protocol.ts, AgentEvent
// An anomaly the daemon detected — by its fold (merge errors,
// head-mismatch: the event after the one whose fold raised it) or by its
// tracker (follower failure, malformed line, classification at the dedup
// site, awaiting-anchor) — with the diagnostic bundle it wrote. Clients
// react to this event; the fold only observes its node.
| {
    kind: "trackerAnomaly";
    uuid: UUID;
    stream: MergeStream;
    anomaly: TrackerAnomaly;
    bundlePath: string;
  }

// protocol.ts
export type Unstamped<E> = E extends { uuid: UUID }
  ? Omit<E, "uuid" | "bundlePath">
  : E;
```

- agent-state.ts fold: `case "trackerAnomaly": return observeEvent(state,
  event);` — no `withAnomalies`. `eventNodes`/`eventStream`/`eventClass`/
  `excludedFromOther`/`observeEvent` arms unchanged.
- `EventHub`: one private `reportAnomaly(event: Unstamped<trackerAnomaly>,
  before: AgentState): void` — `bundlePath = this.anomalies.write(
  event.anomaly, before, this.state)`, log, `applyEvent({...event, uuid,
  bundlePath})`. Callers: `emit`'s `trackerAnomaly` arm (`before =
  this.state`; the classification site at `observeSdkMessage` calls it
  too instead of `applyEvent` directly); and `applyEvent` after the sinks
  of an event whose fold set `state.anomaly`, with
  `{kind: "trackerAnomaly", stream: "query", anomaly: state.anomaly}` and
  the pre-fold state as `before`. Nested `applyEvent`, depth 2 at most:
  the report's own fold drops the anomalies of its observation (a report
  on a stream with no session yet would otherwise raise `merge-error: no
  session`, which the hub would report, whose fold would raise it again —
  unbounded).
- interactive-mode.ts `applyState`: banner on `event.kind ===
  "trackerAnomaly"`, text per Success criterion 2; the `state.anomaly`
  read goes. format/events.ts: the annotation gains the path and the
  contact text.
- docs/protocol.md `trackerAnomaly` row: reworded per the comment above;
  session-tracker.md "Anomalies"/"Anomaly bundles" likewise.

### 3. anomaly-bundle.ts

```ts
interface EventSummary {
  kind: AgentEvent["kind"];
  type?: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  /** assistant frames and entries: the API `message.id` (a response's
   *  blocks share it). */
  apiMessageId?: string;
  /** entries: the file's parent link. */
  parentUuid?: string;
}
```

`record(event)` returns without recording when `event.kind ===
"sdkMessage"` and the message is a `stream_event` or subagent traffic
(`isSubagentTraffic`, classification.ts). `ANOMALY_CONTEXT_EVENTS` stays
50. session-tracker.md "Anomaly bundles" updated.

### 4. transcript.ts

```ts
/** One user-turn item for `views` under `uuid`. Views that are all output
 *  attach to `outputTarget` when it has a command to hold them; else
 *  render as a standalone output turn. */
private addUserTurn(
  views: readonly UserTurnView[],
  uuid: UUID | undefined,
  part: TranscriptItem[],
  outputTarget: UserTurnItem | undefined,
): void
```

Callers:

- `appendEntry`: `outputTarget = itemsByUuid.get(entry.parentUuid)` when
  that is a `userTurn` item (`SessionEntry.parentUuid: UUID | null`;
  `null` → no target).
- `append` (`user` frame, `local_command_output` frame): the last item
  overall when it is a user turn (today's rule, moved to the call site:
  `lastItem()` helper returning `pendingItems.at(-1) ??
  resolvedItems.at(-1)`).
- `itemsByUuid` keeps its user-turn entries (the TODO at its declaration
  is resolved the other way: the parent lookup needs resolved items;
  rewrite the comment).

### 5. Pending-boundary divider

```ts
// settings.ts
export interface ClauctlSettings {
  tuiMode: TuiMode;
  showResolvedBoundary: boolean;
}
// DEFAULT_SETTINGS.showResolvedBoundary = false; readSettings accepts a
// boolean, warns otherwise (same shape as the tuiMode arm).

// transcript.ts
export class TranscriptRenderer {
  constructor(container: Container, showResolvedBoundary = false);
}
```

`rebuild`: after the resolved part's items (fold run flushed), when
`showResolvedBoundary`, add a `PendingBoundaryComponent` (`Component` from `@earendil-works/pi-tui`,
in src/tui/components/): `render(width)` returns `"─".repeat(width)` in
`theme.fg("warning", …)` with one blank line above and below; its own
class because the width is only known at render (the same construction
pi-tui's editor uses for the input box border: `editor.js`
`this.borderColor("─")` then `horizontal.repeat(width)`). Then the
pending part. interactive-mode.ts passes
`settingsRead.settings.showResolvedBoundary`; render-session.ts and the
tests use the default.

## Data Flow

1. Steer: `tool_result` (top level) marks queued demotables →
   `assistant` frames of the same response: nothing → first `assistant`
   frame of the next response (`message.id` differs): hub places the steer
   dequeues before that frame (unchanged hub rule) → file: attachment
   before that response's first entry. Merge: dequeue node precedes the
   response's nodes on both streams.
2. Anomaly, fold-detected: event E folds → `state.anomaly` set →
   `record(E)` → sinks(E) → `reportAnomaly` → `write` → path →
   `applyEvent(trackerAnomaly)` → its fold observes the node, `anomaly`
   cleared → sinks. Daemon-detected: `emit(trackerAnomaly)` →
   `reportAnomaly` → the same from `write` on. TUI:
   `applyState(trackerAnomaly)` → banner with path (its own fold of E set
   `state.anomaly` too; unread). `clauctl tail`: annotation with path.
3. Output attach: entry `system/local_command` (stdout only) resolves →
   `appendEntry` → `entryUserViews` all output → `itemsByUuid.get(parentUuid)`
   → `attachOutput` on that item, else standalone item in the resolved
   part.
4. Divider: `rebuild` → resolved items → divider → pending items.

## Cost

- Steer: one string comparison per assistant frame; one field in the
  queue state.
- Anomaly event: one extra event per fold-detected anomaly on the wire
  and in every client's fold; daemon-detected ones cost nothing new.
  Anomalies are rare by definition.
- Ring: fewer records per fold; two more optional strings per summary.
- Attach: one map lookup per output entry (map already existed).
- Divider: one component per rebuild when enabled; nothing when off.

## Edge cases

- **Synthetic assistants** (`model: "<synthetic>"`, e.g. "No response
  requested." after a local command, API-error messages) carry a
  `message.id` (uuid-shaped) and count as a response boundary: the file
  places a steer's attachment after them like any other response.
- **Subagent traffic** (`parent_tool_use_id` string): ignored by both
  queue-model arms. A steer bundles with the next outgoing API request of
  the agent it is directed at — the main agent — so a subagent's requests
  and tool results cannot absorb it (Anton, review 118b5f7); they matter
  only in that the subagent's final response triggers the main agent's
  next request: its `Task` result is a top-level `tool_result` followed by
  a top-level response, the boundary the steer waits for.
- **Steer accepted between the last `tool_result` and the next frame**:
  its `toolResultSeen` is false at the boundary, so it waits for the next
  response's first `tool_result` and boundary — today's straggler rule,
  unchanged (queue-model.test.ts "straggler").
- **Two anomalies in consecutive folds**: two bundles, two
  `trackerAnomaly` events, two banners — each names its own bundle.
- **`stream` of a fold-detected report**: the anomaly involves both
  streams (its detail names them); the field only picks the session model
  that records the excluded uuid-only node. `"query"` — the daemon's own
  observation, like `shutdown`.
- **Output entry whose `parentUuid` names no item** (history rebuild from
  trees where the command was pruned; a command the TUI never rendered):
  standalone output turn, as today's fallback.
- **Divider with nothing pending**: drawn after the last resolved item —
  "all resolved" is itself information.
- **Divider and fold runs**: the divider ends a run (flush before it), so
  a run never spans the parts. That is already true: a pending item is
  keyed and the resolved part's last run cannot include it.

## Non-goals

- Unknown `/command` head-mismatch handling (session-tracker-follow-ups.md).
- The 01:03Z synthetic-assistant anomaly (an `assistant` entry with no
  query twin after a manual `/compact`); Anton is reproducing it with the
  rebuilt binary. Fix in a later phase once the CLI behavior is pinned.
- Ring size changes beyond the filter.
- A `/settings` command or in-TUI toggle for the divider.

## Tests

- queue-model.test.ts: "stream_event counts as assistant activity" →
  replaced by "later blocks of one response do not steer; the next
  response's first frame does" (two assistant frames sharing an id with a
  tool_result between, then a frame with a new id); "subagent frames
  neither mark nor steer"; "a synthetic assistant is a boundary".
- tests/sdk/steer-parallel-tools.test.ts (LIVE, haiku): prompt asking for
  three parallel `Bash` `sleep` calls, a stamped steer pushed at the first
  `tool_use`; assert the attachment's file position (after the third
  `tool_result` entry, before the next assistant entry) and that
  `observeSdkMessage` fed the captured query events emits the steer
  dequeue exactly at the next response's first `assistant` frame.
- agent-state.test.ts: folding `trackerAnomaly` leaves `state.anomaly`
  undefined (existing test inverted).
- event-hub test (existing anomaly test): a daemon-detected emit reaches
  sinks once, with a `bundlePath` that exists; an event whose fold
  raises a head-mismatch is followed by exactly one `trackerAnomaly`
  whose `bundlePath` exists and whose bundle's `sessionsBefore` is the
  pre-fold state.
- anomaly-bundle.test.ts: stream events and subagent frames are not
  recorded; `apiMessageId`/`parentUuid` present.
- transcript.test.ts: "output entry attaches to its parent command even
  when a pending item follows"; "output entry with unknown parent renders
  standalone"; "showResolvedBoundary draws the rule between the parts and
  at the end when nothing is pending".
- settings.test.ts: `showResolvedBoundary` parsed; non-boolean warns.
- interactive-mode: banner text on `trackerAnomaly`, none from
  `state.anomaly` alone (existing anomaly banner test updated).

## Plan

1. Item 1 + tests + LIVE probe; docs/claude-agent-sdk.md steer placement
   sentence ("after the last tool_result of the response").
2. Item 3 (ring) — small, independent.
3. Item 2 (anomaly report) — protocol, fold, hub, TUI, format,
   docs/protocol.md, session-tracker.md.
4. Item 4 (attach) — transcript + tests; phase-1.5 IMPLEMENTATION IDEAS
   note closed.
5. Item 5 (divider) — settings, transcript, interactive-mode.
6. Presubmit; WORK LOG.

# IMPLEMENTATION IDEAS

- Anton (2026-09-22): "of course the steer must go after all the tool
  results from calls in the same API message" — the trigger is a new
  response, not new activity. Option considered and rejected:
  `message_stop` (needs partials; couples queue timing to
  `includePartialMessages`); `result` (too late for mid-turn steers).
- Anton (2026-09-22): the daemon owns detection and always reports with a
  `trackerAnomaly` event; clients handle only those events. Rejected
  alternatives: a separate `anomalyRecorded` event (a second kind carrying
  the same anomaly; the TUI would banner from two sources); `bundlePath`
  on `TrackerAnomaly` itself (threads through `withAnomalies` for no
  gain — the path is the report's, not the anomaly's). Assumption kept:
  daemon and client folds raise the same anomalies for the same events,
  so a client-only anomaly cannot exist; if one ever does it is now
  silent — name it here.

# WORK LOG

- [x] Anton reviews this spec (d10e712: `showResolvedBoundary`; the daemon
      reports every anomaly as a `trackerAnomaly` event).
- [x] Item 1: queue-model.ts + tests; LIVE probe
      tests/sdk/steer-parallel-tools.test.ts (3 parallel Bash sleeps: the
      attachment follows the third `tool_result`); claude-agent-sdk.md.
- [x] Item 3: anomaly-bundle.ts ring filter + `apiMessageId`/`parentUuid`;
      anomaly-bundle.test.ts.
- [x] Item 2. Deviations from §2: `reportAnomaly(stream, anomaly, foldInput)`
      takes the pieces, not an unstamped event, and names the state the
      anomalous fold started from `foldInput` (review 118b5f7: a tracker-
      detected anomaly has no failing fold, so its callers pass the
      current state — "before" misled there); `labeledAnomaly` (tracker-
      anomaly.ts) prefixes a tracker-detected anomaly's detail with its kind
      at the report sites, so `anomalyReport` prints "tracker anomaly <kind>:
      <detail>" for fold- and tracker-detected anomalies alike. Found in
      tests: the report's own fold _can_ raise an anomaly (`merge-error: no
  session` on a stream with no session yet), which the hub would report
      again without end — the `trackerAnomaly` arm drops its observation's
      anomalies (§2 amended).
- [x] Item 4: `addUserTurn(…, outputTarget)`; `parentUserTurnItem(entry)`
      and `lastUserTurnItem()` in place of the spec's `lastItem()` (both
      callers want the user turn, not the item); phase-1.5 note closed.
- [x] Item 5: settings, `PendingBoundaryComponent`, `rebuild` per part,
      interactive-mode wiring.
- [x] Presubmit green.
- [ ] Anton: manual `/compact` reproduction of the 01:03Z synthetic-
      assistant anomaly with the new bundle format.
