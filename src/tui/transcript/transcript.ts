/**
 * Transcript: the single source of truth for transcript content.
 * Live attach (interactive-mode/interactive-mode.ts) and render-from-file
 * (scripts/tui-parity/render-session.ts) both render through this class, so
 * the two paths cannot drift. It owns the transcript components — streaming
 * fold, tool components, user/assistant blocks, banners — while the caller
 * keeps everything that is not transcript content: pending/status/queue
 * areas and autocomplete side effects.
 *
 * Each uuid's visible content renders once (`renderedUuids`), whichever
 * side delivers it first — the query stream's frame or the session file's
 * entry; the loser still does its non-content work (a `user` frame resolves
 * tool results, an `assistant` frame takes its block out of the stream it
 * owns). Streams are owned by API `message.id`, not transcript uuid: the
 * two sides are delayed independently, so the stream open at a key need
 * not belong to the message arriving. A stream renders a whole response's
 * partials; the CLI files each content block as its own `assistant`
 * message, which renders as its own item ahead of the stream and leaves
 * the partial (`StreamingComponent.finalizedUuids`); `message_stop` drops
 * the stream. `itemsByUuid` lets a resolved entry re-render its frame's
 * item in place (`replaceItem`).
 *
 * The transcript is two item lists, resolved then pending: see
 * `TranscriptItems`.
 *
 * A compaction summary's entry says so (`isCompactSummary`); its frame
 * carries no flag, so a boundary frame's `preserved_messages.anchor_uuid`
 * names the summary frame expected immediately after it (the anchor is
 * the boundary itself when there is none: a rewind, a bare wipe).
 *
 * Top-level content is kept as an ordered item list and the container's
 * children are rebuilt from it on every change, because the collapsed view
 * folds runs of thinking + read-only tools into single lines ("Thought for
 * 4s, read 2 files (ctrl+o to expand)") that must disband when either
 * toggle expands and re-form when both collapse (fold runs:
 * `foldRunComponent`). Thinking durations: `TimeTracker`.
 */

import type { UUID } from "node:crypto";
import { type Component, Container } from "@earendil-works/pi-tui";
import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  entryToSessionMessage,
  hookAdditionalContext,
  queuedCommandSourceUuid,
  type SessionEntry,
} from "../../core/session/file.ts";
import { hookContextDisplayText } from "../../core/protocol/index.ts";
import { interruptMarkerText } from "../../core/session/entry-predicates.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { PendingBoundaryComponent } from "../components/pending-boundary.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import {
  isOutputView,
  outputText,
  UserTurnComponent,
} from "../components/user-turn.ts";
import {
  beginMessage,
  foldStreamEvent,
  renderAssistant,
  toolResultsOf,
  userTurnViews,
  withoutBlock,
  type StreamingMessage,
  type UserTurnView,
} from "../../format/sdk-render.ts";
import { toolViewFor } from "../../format/entry-view/index.ts";
import { bannerComponent, type Banner } from "./banner.ts";
import { CompactSummaryComponent, compactBanner } from "./compact-summary.ts";
import { entryUserViews } from "./entry-user-views.ts";
import { foldRunComponent, isFoldable } from "./fold-run.ts";
import { suppressNoResponse } from "./suppress-no-response.ts";
import { hasThinking, hiddenThinkingLabel } from "./thinking.ts";
import { systemBanner } from "./system-banner.ts";
import { TimeTracker } from "./time-tracker.ts";
import { TranscriptItems, type ItemPart } from "./transcript-items.ts";
import {
  type AssistantItem,
  type ToolItem,
  type TranscriptItem,
  type UserTurnItem,
} from "./transcript-item.ts";
import type { RenderAssistant } from "../../format/render-types.ts";

interface StreamingComponent {
  component: AssistantMessageComponent;
  state: StreamingMessage;
  /** The top-level item to drop at `message_stop`; undefined for subagent
   *  streams. */
  item: AssistantItem | undefined;
  /** The API message id from `message_start`: the stream's owner. */
  apiMessageId: string;
  /** Uuids of the response's `assistant` messages seen so far, from either
   *  side: the CLI emits one per content block, in block order, between
   *  the block's `content_block_start` and `content_block_stop`
   *  (tests/sdk/stream-classification.test.ts), so the count is the next
   *  block index to leave the partial. */
  finalizedUuids: Set<UUID>;
}

export class Transcript {
  private readonly container: Container;
  /** Ordered top-level transcript content; container children derive
   *  from it on every rebuild. */
  private readonly items = new TranscriptItems();
  /** Live streaming component per parent_tool_use_id ("" = top level). */
  private readonly streaming = new Map<string, StreamingComponent>();
  /** ALL tool components (top-level and subagent-nested), for result
   *  resolution, nesting, and the expand toggle. */
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  /** Top-level tool items only (fold bookkeeping). */
  private readonly toolItems = new Map<string, ToolItem>();
  private readonly assistantComponents: AssistantMessageComponent[] = [];
  /** Uuids whose visible content is on screen: a top-level item, a
   *  command-output attachment, or hook context under its tool. A prompt's entry keys the run's last
   *  member; a steer's attachment keys its `source_uuid`. */
  private readonly renderedUuids = new Set<UUID>();
  /** Replacement lookup for `replaceItem` and the parent lookup of a
   *  command-output entry (`parentUserTurnItem`), whose command may have
   *  resolved long before — hence a map over both parts, kept for the
   *  conversation's lifetime. */
  private readonly itemsByUuid = new Map<UUID, AssistantItem | UserTurnItem>();
  /** For header path abbreviation (per-tool views). */
  private cwd: string | undefined;
  private toolsExpanded = false;
  private compactSummaryExpanded = false;
  private showThinking = false;
  private readonly compactSummaries: CompactSummaryComponent[] = [];
  /** The last boundary frame's anchor, until the next top-level user
   *  frame (see file comment). */
  private expectedSummaryUuid: UUID | undefined;
  private timeTracker = new TimeTracker();

  /** Drawn between the two parts on every rebuild when the
   *  `showResolvedBoundary` setting asks for it. */
  private readonly pendingBoundary: PendingBoundaryComponent | undefined;

  constructor(container: Container, showResolvedBoundary = false) {
    this.container = container;
    this.pendingBoundary = showResolvedBoundary
      ? new PendingBoundaryComponent()
      : undefined;
  }

  /**
   * Fold one SDK message into transcript components: stream events drive the
   * streaming component; a finalized assistant message replaces the stream
   * it owns (API message id) or renders whole; a user message renders as
   * the compact summary its boundary frame announced, else its turn (prompt
   * text, slash command) unless the CLI marked it a replay (command
   * output), then resolves tool results (unknown toolCallId → dropped;
   * parent_tool_use_id-routed content renders nested under the owning
   * component). The CLI never echoes a prompt; the daemon's dequeue echo
   * is that message. Query-side: the items land in the pending part.
   */
  append(message: SDKMessage): void {
    this.appendMessage(message, "pending");
  }

  /** `append` with the part its keyed items join: the pending part for a
   *  query message, the resolved part for an entry's (`appendEntry`). */
  private appendMessage(message: SDKMessage, part: ItemPart): void {
    switch (message.type) {
      case "stream_event":
        this.appendStreamEvent(message, part);
        break;
      case "assistant":
        this.appendAssistant(message, part);
        break;
      case "user":
        this.appendUser(message, part);
        break;
      case "conversation_reset":
        this.reset();
        break;
      case "system":
        this.appendSystem(message, part);
        break;
      case "result": {
        if (message.is_error) {
          this.addBanner({ text: `turn failed: ${message.subtype}` });
        }
        break;
      }
      default:
        // The remaining top-level variants (rate-limit and tool-progress
        // bookkeeping, user-message replays, …) carry no transcript content;
        // user-facing text arrives as one of the messages handled above.
        break;
    }
  }

  private appendStreamEvent(
    message: Extract<SDKMessage, { type: "stream_event" }>,
    part: ItemPart,
  ): void {
    const key = message.parent_tool_use_id ?? "";
    if (message.event.type === "message_start") {
      const component = this.newAssistantComponent(undefined);
      const item = this.attachAssistant(
        component,
        message.parent_tool_use_id,
        undefined, // uuid
        part,
        undefined, // stream
      );
      this.streaming.set(key, {
        component,
        state: beginMessage(),
        item,
        apiMessageId: message.event.message.id,
        finalizedUuids: new Set(),
      });
      return;
    }
    const live = this.streaming.get(key);
    if (live === undefined) {
      return;
    }
    if (message.event.type === "message_stop") {
      // The response's end: every block has left the stream for its
      // own item (StreamingComponent.finalizedUuids), so what remains
      // is at most blocks the render model dropped.
      this.discardStream(key, live);
      return;
    }
    live.state = foldStreamEvent(live.state, message.event);
    live.component.updateContent(live.state.partial);
  }

  private appendAssistant(
    message: Extract<SDKMessage, { type: "assistant" }>,
    part: ItemPart,
  ): void {
    const live = this.streaming.get(message.parent_tool_use_id ?? "");
    // A mismatch is the file side lagging, not an error: the query
    // stream finalizes A before opening B, but A's entry can arrive
    // after B's message_start opened the stream at this key.
    const ownStream =
      live?.apiMessageId === message.message.id ? live : undefined;
    if (ownStream !== undefined) {
      this.finalizeStreamBlock(ownStream, message.uuid);
    }
    if (
      message.parent_tool_use_id === null &&
      this.renderedUuids.has(message.uuid)
    ) {
      return; // the entry rendered this message
    }
    const rendered = suppressNoResponse(renderAssistant(message));
    const thinkingSeconds =
      message.parent_tool_use_id === null && hasThinking(rendered)
        ? this.timeTracker.secondsSincePrevious(message)
        : undefined;
    if (message.parent_tool_use_id === null) {
      this.timeTracker.stamp(message);
    }
    // A top-level item is keyed by the message; a stream's item never is.
    const uuid = message.parent_tool_use_id === null ? message.uuid : undefined;
    const item = this.attachAssistant(
      this.newAssistantComponent(rendered),
      message.parent_tool_use_id,
      uuid,
      part,
      ownStream,
    );
    if (item !== undefined) {
      item.rendered = rendered;
      item.thinkingSeconds = thinkingSeconds;
    }
    if (message.parent_tool_use_id === null) {
      this.renderedUuids.add(message.uuid);
      if (item !== undefined) {
        this.itemsByUuid.set(message.uuid, item);
      }
    }
    for (const block of rendered.content) {
      if (block.type === "toolCall") {
        this.attachToolCall(
          block,
          message.parent_tool_use_id,
          uuid,
          part,
          ownStream,
        );
      }
    }
    this.rebuild();
  }

  /** The block `uuid` leaves `stream`'s partial (once per uuid, whichever
   *  side delivers the message first). */
  private finalizeStreamBlock(stream: StreamingComponent, uuid: UUID): void {
    if (stream.finalizedUuids.has(uuid)) {
      return;
    }
    stream.state = withoutBlock(stream.state, stream.finalizedUuids.size);
    stream.finalizedUuids.add(uuid);
    stream.component.updateContent(stream.state.partial);
  }

  private attachToolCall(
    block: Extract<RenderAssistant["content"][number], { type: "toolCall" }>,
    parentToolUseId: string | null,
    uuid: UUID | undefined,
    part: ItemPart,
    stream: StreamingComponent | undefined,
  ): void {
    const tool = new ToolExecutionComponent(
      block.name,
      block.arguments,
      this.cwd,
    );
    tool.setExpanded(this.toolsExpanded);
    this.toolComponents.set(block.id, tool);
    const parent = this.parentTool(parentToolUseId);
    if (parent === undefined) {
      const item: ToolItem = {
        kind: "tool",
        uuid,
        name: block.name,
        component: tool,
        view: toolViewFor(block.name),
      };
      this.toolItems.set(block.id, item);
      this.items.insert(item, part, stream?.item);
    } else if (stream === undefined) {
      parent.addSubagentChild(tool);
    } else {
      parent.addSubagentChildBefore(tool, stream.component);
    }
  }

  private appendUser(
    message: Extract<SDKMessage, { type: "user" }>,
    part: ItemPart,
  ): void {
    if (message.parent_tool_use_id === null) {
      this.timeTracker.stamp(message);
      const expectedSummaryUuid = this.expectedSummaryUuid;
      this.expectedSummaryUuid = undefined;
      if (message.uuid !== undefined && message.uuid === expectedSummaryUuid) {
        this.renderCompactSummary(message.message.content, message.uuid, part);
      } else if ((message as { isReplay?: boolean }).isReplay !== true) {
        // The CLI writes `isReplay: false` on frames the SDK type
        // declares without the field.
        this.addUserContent(
          interruptMarkerText(message),
          userTurnViews(message),
          message.uuid,
          part,
          this.lastUserTurnItem(),
        );
      }
    }
    // A subagent's user frames (its task prompt) are not this
    // conversation's turns; only their tool results land here.
    this.applyToolResults(message);
    this.rebuild();
  }

  /** Forget the old conversation: it is no longer this surface's
   *  transcript. */
  private reset(): void {
    this.items.clear();
    this.streaming.clear();
    this.toolComponents.clear();
    this.toolItems.clear();
    this.assistantComponents.length = 0;
    this.compactSummaries.length = 0;
    this.renderedUuids.clear();
    this.itemsByUuid.clear();
    this.expectedSummaryUuid = undefined;
    this.timeTracker = new TimeTracker();
    this.addBanner({ text: "conversation reset" });
  }

  private appendSystem(
    message: Extract<SDKMessage, { type: "system" }>,
    part: ItemPart,
  ): void {
    // init and status carry only state, which the caller's fold covers;
    // they render nothing. commands_changed is a caller side effect.
    // Other subtypes (session_state_changed, hook and task lifecycle, …)
    // are operational chatter with no transcript content.
    if (message.subtype === "local_command_output") {
      // Steered `!` output: the CLI's own rendering (embedded ANSI
      // passes through the ⤷ block), attached to the preceding command.
      if (this.firstRender(message.uuid)) {
        this.addUserTurn(
          [{ kind: "commandOutput", text: message.content }],
          message.uuid,
          part,
          this.lastUserTurnItem(),
        );
      }
    } else if (message.subtype === "compact_boundary") {
      const anchorUuid =
        message.compact_metadata.preserved_messages?.anchor_uuid;
      this.expectedSummaryUuid =
        anchorUuid === message.uuid ? undefined : anchorUuid;
      this.addCompactBoundary(
        message.compact_metadata.pre_tokens,
        message.compact_metadata.post_tokens,
        message.uuid,
        part,
      );
    } else {
      const banner = systemBanner(message);
      if (banner !== undefined) {
        this.addBanner(banner);
      }
    }
  }

  private addCompactBoundary(
    preTokens: unknown,
    postTokens: unknown,
    uuid: UUID | undefined,
    part: ItemPart,
  ): void {
    if (this.firstRender(uuid)) {
      this.addPlain(
        bannerComponent({ text: compactBanner(preTokens, postTokens) }),
        uuid,
        part,
      );
    }
  }

  /** The interrupt marker as a banner when there is one, else the user
   *  turn of `views`; claims `key` (`firstRender`) for a marker always,
   *  for views only when there are any. */
  private addUserContent(
    marker: string | undefined,
    views: readonly UserTurnView[],
    key: UUID | undefined,
    part: ItemPart,
    outputTarget: UserTurnItem | undefined,
  ): void {
    if (marker !== undefined) {
      if (this.firstRender(key)) {
        this.addPlain(bannerComponent({ text: marker }), key, part);
      }
    } else if (views.length > 0 && this.firstRender(key)) {
      this.addUserTurn(views, key, part, outputTarget);
    }
  }

  /** The message's tool_result blocks onto their tool components (unknown
   *  toolCallId → dropped) and top-level tool items. */
  private applyToolResults(
    message: Extract<SDKMessage, { type: "user" }>,
  ): void {
    for (const result of toolResultsOf(message)) {
      this.toolComponents.get(result.toolCallId)?.updateResult(result);
      const item = this.toolItems.get(result.toolCallId);
      if (item !== undefined) {
        item.result = result;
      }
    }
  }

  /** One user-turn item for `views` under `uuid`. Views that are all
   *  output (a command's stdout arrives as its own message) attach to
   *  `outputTarget` when it has a command to hold them, else render as a
   *  standalone output turn. */
  private addUserTurn(
    views: readonly UserTurnView[],
    uuid: UUID | undefined,
    part: ItemPart,
    outputTarget: UserTurnItem | undefined,
  ): void {
    if (views.every(isOutputView)) {
      const texts = views.map(outputText).filter((text) => text !== undefined);
      if (texts.length === 0) {
        return;
      }
      if (outputTarget?.component.attachOutput(texts.join("\n")) === true) {
        this.rebuild();
        return;
      }
    }
    const component = new UserTurnComponent(views, this.toolsExpanded);
    const item: UserTurnItem = { kind: "userTurn", uuid, component };
    this.addItem(item, part);
    if (uuid !== undefined) {
      this.itemsByUuid.set(uuid, item);
    }
  }

  /** The output target of a query-side output frame, which carries no
   *  parent: the last item overall, when it is a user turn. */
  private lastUserTurnItem(): UserTurnItem | undefined {
    const last = this.items.last();
    return last?.kind === "userTurn" ? last : undefined;
  }

  /** The output target of an entry: the user turn its `parentUuid` names
   *  (the command it answers), wherever that item now is. */
  private parentUserTurnItem(entry: SessionEntry): UserTurnItem | undefined {
    const parent =
      entry.parentUuid === undefined || entry.parentUuid === null
        ? undefined
        : this.itemsByUuid.get(entry.parentUuid);
    return parent?.kind === "userTurn" ? parent : undefined;
  }

  /** The summary's user message carries its text as a plain string. */
  private renderCompactSummary(
    content: unknown,
    uuid: UUID,
    part: ItemPart,
  ): void {
    if (typeof content === "string" && this.firstRender(uuid)) {
      const component = new CompactSummaryComponent(content);
      component.setExpanded(this.compactSummaryExpanded);
      this.compactSummaries.push(component);
      this.addPlain(component, uuid, part);
    }
  }

  /**
   * Render one session entry as `append` renders its query message:
   * boundary entries render the compact_boundary banner; a
   * `hook_additional_context` attachment renders under the tool it names
   * (docs/specs/permission-amend-allow.md, Transcript display); a user entry, or
   * one with no message of its own (a steered prompt's `queued_command`
   * attachment, a local command), renders as a user turn
   * (`addUserContent`); anything else → `appendMessage`. Session-entry
   * metadata that entryToSessionMessage drops (cwd) is read from the entry
   * here. A SessionMessage carries every field its SDKMessage variant
   * requires, so the cast is a narrowing of `message: unknown`, not a
   * fabrication. File-side: the items land in the resolved part, so the
   * caller delivers an entry only once its uuid resolved (`resolve`, the
   * history rebuild).
   */
  appendEntry(entry: SessionEntry): void {
    const part = "resolved";
    if (entry.subtype === "compact_boundary") {
      const metadata = entry.compactMetadata as
        { preTokens?: unknown; postTokens?: unknown } | undefined;
      this.addCompactBoundary(
        metadata?.preTokens,
        metadata?.postTokens,
        entry.uuid,
        part,
      );
      return;
    }
    this.trackCwd(entry);
    if (entry.isCompactSummary === true && entry.uuid !== undefined) {
      this.renderCompactSummary(
        (entry.message as { content?: unknown } | undefined)?.content,
        entry.uuid,
        part,
      );
      return;
    }
    const hookContext = hookAdditionalContext(entry.attachment);
    if (hookContext !== undefined) {
      this.attachHookContext(hookContext, entry.uuid);
      return;
    }
    const message = entryToSessionMessage(entry) as
      (SessionMessage & SDKMessage) | undefined;
    if (message !== undefined && message.type !== "user") {
      this.appendMessage(message, part);
      return;
    }
    // A steered prompt's attachment is keyed by the prompt's own uuid.
    const key = queuedCommandSourceUuid(entry) ?? entry.uuid;
    this.addUserContent(
      message?.type === "user" ? interruptMarkerText(entry) : undefined,
      entryUserViews(entry, message),
      key,
      part,
      this.parentUserTurnItem(entry),
    );
    if (message !== undefined) {
      this.timeTracker.stamp(message);
      this.applyToolResults(message);
    }
    this.rebuild();
  }

  /** The hook's context under the tool it names (dropped when that tool
   *  is unknown); claims `uuid` (`firstRender`). */
  private attachHookContext(
    hookContext: NonNullable<ReturnType<typeof hookAdditionalContext>>,
    uuid: UUID | undefined,
  ): void {
    const tool = this.toolComponents.get(hookContext.toolUseId);
    if (tool !== undefined && this.firstRender(uuid)) {
      tool.addHookContext(
        hookContextDisplayText(hookContext.hookName, hookContext.context),
      );
      const item = this.toolItems.get(hookContext.toolUseId);
      if (item !== undefined) {
        item.hasHookContext = true;
      }
      this.rebuild();
    }
  }

  private trackCwd(entry: SessionEntry): void {
    if (typeof entry.cwd === "string") {
      this.cwd = entry.cwd;
    }
  }

  /**
   * The merge resolved `uuid`. The pending prefix through the last item
   * keyed `uuid` (its run; `ItemKey.uuid`), plus the unkeyed items after
   * it up to the next keyed item or open stream, joins the resolved part.
   * `entry` then re-renders the item whose content may differ between
   * frame and entry — the assistant item, or the user turn a dequeue echo
   * rendered ahead of the file (`replaceItem`; a tool item's call and
   * result are the same on both sides); with no such item it runs through
   * `appendEntry`, which renders what the frame did not and applies the
   * entry's tool results.
   */
  resolve(uuid: UUID, entry: SessionEntry | undefined): void {
    this.items.resolveThrough(uuid);
    if (entry !== undefined) {
      // Branch on an item keyed `uuid`, not on `renderedUuids`: a user
      // frame's entry still carries the tool results only the file has.
      const item = this.itemsByUuid.get(uuid);
      if (item === undefined) {
        this.appendEntry(entry);
      } else {
        this.replaceItem(item, entry);
      }
    }
    // No rebuild for the move alone: the container is the concatenation
    // of the two parts, which the move leaves unchanged.
  }

  /** Re-render `item`, the frame's rendering of `entry`'s uuid, from the
   *  entry: what the file records can differ from what the stream carried.
   *  No-op for an assistant item whose entry is not an assistant message. */
  private replaceItem(
    item: AssistantItem | UserTurnItem,
    entry: SessionEntry,
  ): void {
    this.trackCwd(entry);
    const message = entryToSessionMessage(entry) as
      (SessionMessage & SDKMessage) | undefined;
    if (item.kind === "userTurn") {
      this.replaceUserTurn(item, entry, message);
    } else if (message?.type === "assistant") {
      this.replaceAssistant(item, message);
    }
  }

  /** An assistant frame carries `stop_reason: null`; its entry the final
   *  value. */
  private replaceAssistant(
    item: AssistantItem,
    message: Extract<SDKMessage, { type: "assistant" }>,
  ): void {
    const rendered = suppressNoResponse(renderAssistant(message));
    item.rendered = rendered;
    item.component.updateContent(rendered);
    this.rebuild();
  }

  /** A user turn's entry is the file's record of the dequeue echo (a merged
   *  run's joined text, a steer's attachment) and carries the tool results
   *  only the file has. */
  private replaceUserTurn(
    item: UserTurnItem,
    entry: SessionEntry,
    message: (SessionMessage & SDKMessage) | undefined,
  ): void {
    const views = entryUserViews(entry, message);
    if (views.length > 0) {
      item.component.updateContent(views);
    }
    if (message?.type === "user") {
      this.applyToolResults(message);
    }
    this.rebuild();
  }

  /** True when `uuid`'s content is not yet on screen, claiming it; an
   *  absent uuid has nothing to claim and always renders. */
  private firstRender(uuid: UUID | undefined): boolean {
    if (uuid === undefined) {
      return true;
    }
    if (this.renderedUuids.has(uuid)) {
      return false;
    }
    this.renderedUuids.add(uuid);
    return true;
  }

  /** Drop a stream's component and top-level item at the response's end.
   *  The banners the item held back resolve once it is gone (`TranscriptItems`:
   *  the pending part never starts with an unkeyed item). */
  private discardStream(key: string, stream: StreamingComponent): void {
    this.streaming.delete(key);
    const componentIndex = this.assistantComponents.indexOf(stream.component);
    if (componentIndex !== -1) {
      this.assistantComponents.splice(componentIndex, 1);
    }
    if (stream.item !== undefined) {
      this.items.removePending(stream.item);
    }
    this.rebuild();
  }

  /** cwd for header path abbreviation; InteractiveMode feeds it from
   *  AgentState.cwd, appendEntry from entry.cwd. */
  setCwd(cwd: string | undefined): void {
    this.cwd = cwd;
  }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.toolComponents.values()) {
      tool.setExpanded(expanded);
    }
    for (const item of [...this.items.resolved, ...this.items.pending]) {
      if (item.kind === "userTurn") {
        item.component.setExpanded(expanded);
      }
    }
    this.rebuild();
  }

  setCompactSummaryExpanded(expanded: boolean): void {
    this.compactSummaryExpanded = expanded;
    for (const component of this.compactSummaries) {
      component.setExpanded(expanded);
    }
    this.rebuild();
  }

  setShowThinking(show: boolean): void {
    this.showThinking = show;
    for (const component of this.assistantComponents) {
      component.setHideThinkingBlock(!show);
    }
    this.rebuild();
  }

  /** A notice in transcript order (also the caller's banner surface, so
   *  banners survive rebuilds). Keyed by `uuid` when the banner renders an
   *  event, so `resolve(uuid)` moves it; unkeyed it resolves with whatever
   *  precedes it. */
  addBanner(banner: Banner, uuid?: UUID): void {
    this.addPlain(bannerComponent(banner), uuid, "pending");
  }

  private addPlain(
    component: Component,
    uuid: UUID | undefined,
    part: ItemPart,
  ): void {
    this.addItem({ kind: "plain", uuid, component }, part);
  }

  private addItem(item: TranscriptItem, part: ItemPart): void {
    this.items.insert(item, part);
    this.rebuild();
  }

  private newAssistantComponent(
    rendered: RenderAssistant | undefined,
  ): AssistantMessageComponent {
    const component = new AssistantMessageComponent(
      rendered,
      !this.showThinking,
    );
    this.assistantComponents.push(component);
    return component;
  }

  /** Add an assistant component as a top-level item (returned) or nested
   *  under the owning subagent tool (undefined); ahead of `stream`'s
   *  component when given. */
  private attachAssistant(
    component: AssistantMessageComponent,
    parentToolUseId: string | null,
    uuid: UUID | undefined,
    part: ItemPart,
    stream: StreamingComponent | undefined,
  ): AssistantItem | undefined {
    const parent = this.parentTool(parentToolUseId);
    if (parent !== undefined) {
      if (stream === undefined) {
        parent.addSubagentChild(component);
      } else {
        parent.addSubagentChildBefore(component, stream.component);
      }
      return undefined;
    }
    const item: AssistantItem = { kind: "assistant", uuid, component };
    this.items.insert(item, part, stream?.item);
    this.rebuild();
    return item;
  }

  private parentTool(
    parentToolUseId: string | null,
  ): ToolExecutionComponent | undefined {
    return parentToolUseId === null
      ? undefined
      : this.toolComponents.get(parentToolUseId);
  }

  /** Rebuild the container's children from the item list, folding runs of
   *  foldable items into single lines while both toggles are collapsed.
   *  The pending boundary ends a run: it is drawn even with nothing
   *  pending ("all resolved" is itself information). */
  private rebuild(): void {
    this.container.clear();
    const folding = !this.toolsExpanded && !this.showThinking;
    let run: TranscriptItem[] = [];
    const flush = (): void => {
      if (run.length > 0) {
        const line = foldRunComponent(run);
        if (line !== undefined) {
          this.container.addChild(line);
        }
        run = [];
      }
    };
    const addPart = (part: readonly TranscriptItem[]): void => {
      for (const item of part) {
        if (folding && isFoldable(item)) {
          run.push(item);
          continue;
        }
        flush();
        if (item.kind === "assistant") {
          this.applyThinkingLabel(item);
        }
        this.container.addChild(item.component);
      }
      flush();
    };
    addPart(this.items.resolved);
    if (this.pendingBoundary !== undefined) {
      this.container.addChild(this.pendingBoundary);
    }
    addPart(this.items.pending);
  }

  /** The collapsed-thinking one-liner an individually-rendered (unfolded)
   *  assistant shows in place of its thinking. */
  private applyThinkingLabel(item: AssistantItem): void {
    if (this.showThinking) {
      return;
    }
    item.component.setHiddenThinkingLabel(
      hiddenThinkingLabel(item.thinkingSeconds),
    );
  }
}
