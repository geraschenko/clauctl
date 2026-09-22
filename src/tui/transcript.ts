/**
 * TranscriptRenderer: the single source of truth for transcript content.
 * Live attach (interactive-mode.ts) and render-from-file
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
 * The transcript is two item lists, resolved then pending
 * (docs/specs/query-pending-list/phase-1.5-render-at-resolution.md). A
 * query message renders into the pending part; an entry, which the caller
 * delivers only once the merge resolved its uuid, into the resolved part.
 * `resolve(uuid)` moves the pending prefix through the items keyed `uuid`
 * — items of one `append` call share its uuid and are contiguous — and the
 * unkeyed items after them (banners: query-side notices that resolve as
 * soon as nothing unresolved precedes them; they join the resolved part
 * directly when the pending part is empty), stopping at the next keyed
 * item or open stream. A stream's item is never keyed (the `message_start`
 * names only the API `message.id`, shared by every block of the response)
 * and stays pending, blocking the move, until `message_stop` drops it; a
 * file-only entry resolving while it streams lands above it, in file
 * order. The pending part is therefore empty or starts with a keyed item
 * or an open stream's item.
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
 * toggle expands and re-form when both collapse — a fold run is a maximal
 * consecutive sequence of finalized thinking-only assistant messages and
 * READ_ONLY_TOOLS calls with non-error results; text blocks, other tools,
 * errors, and visible user turns end runs. Thinking durations follow
 * claude's session-file rule (validated empirically): a thinking message's
 * duration is its timestamp minus the previous entry's timestamp; live
 * messages carry no timestamp, so arrival time — the same clock the CLI
 * stamps entries with — stands in.
 */

import type { UUID } from "node:crypto";
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type {
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  entryToSessionMessage,
  queuedCommandPrompt,
  queuedCommandSourceUuid,
  type SessionEntry,
} from "../core/session/file.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import {
  isOutputView,
  outputText,
  UserTurnComponent,
} from "./components/user-turn.ts";
import { claudeStyle } from "./claude-style.ts";
import {
  beginMessage,
  foldStreamEvent,
  renderAssistant,
  toolResultsOf,
  userTurnViews,
  userTurnViewsFromText,
  withoutBlock,
  type StreamingMessage,
  type UserTurnView,
} from "./sdk-render.ts";
import { formatTokens } from "./components/footer.ts";
import {
  READ_ONLY_TOOLS,
  toolViewFor,
  type ToolView,
} from "./tool-views/tool-view.ts";
import { getMarkdownTheme, theme, type ThemeColor } from "./theme.ts";
import type { RenderAssistant, RenderToolResult } from "./render-types.ts";

interface ItemKey {
  /** The uuid the item rendered under (`renderedUuids`' key); undefined
   *  for an unkeyed item (see file comment). Several items can share a
   *  uuid: every message has one uuid and (assistant) one content block,
   *  but `appendMessage` makes a top-level item per thing the user can
   *  fold or expand — a tool_use message yields its assistant item plus a
   *  tool item — so a uuid keys a contiguous run of one or more items. */
  uuid: UUID | undefined;
}

interface AssistantItem extends ItemKey {
  kind: "assistant";
  component: AssistantMessageComponent;
  /** Undefined while streaming; streaming components never fold. */
  rendered?: RenderAssistant;
  /** Timestamp-delta duration; undefined when unavailable/non-monotonic. */
  thinkingSeconds?: number;
}

interface ToolItem extends ItemKey {
  kind: "tool";
  name: string;
  component: ToolExecutionComponent;
  view: ToolView<unknown> | undefined;
  result?: RenderToolResult;
}

interface PlainItem extends ItemKey {
  kind: "plain";
  component: Component;
}

/** A user turn's views as one component (prompt text, command, output). */
interface UserTurnItem extends ItemKey {
  kind: "userTurn";
  component: UserTurnComponent;
}

type TranscriptItem = AssistantItem | ToolItem | PlainItem | UserTurnItem;

/** A stream's item: the only unkeyed assistant item there is (subagent
 *  streams are nested, not items). */
const isOpenStream = (item: TranscriptItem): boolean =>
  item.kind === "assistant" && item.uuid === undefined;

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

function hasThinking(rendered: RenderAssistant): boolean {
  return rendered.content.some(
    (block) => block.type === "thinking" && block.thinking.trim() !== "",
  );
}

function messageTimestampMs(message: SDKMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== "string") {
    return undefined;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

export class TranscriptRenderer {
  private readonly container: Container;
  /** Ordered top-level transcript content, resolved part then pending
   *  part (see file comment); container children derive from both on
   *  every rebuild. */
  private readonly resolvedItems: TranscriptItem[] = [];
  private readonly pendingItems: TranscriptItem[] = [];
  /** Live streaming component per parent_tool_use_id ("" = top level). */
  private readonly streaming = new Map<string, StreamingComponent>();
  /** ALL tool components (top-level and subagent-nested), for result
   *  resolution, nesting, and the expand toggle. */
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  /** Top-level tool items only (fold bookkeeping). */
  private readonly toolItems = new Map<string, ToolItem>();
  private readonly assistantComponents: AssistantMessageComponent[] = [];
  /** Uuids whose visible content is on screen: a top-level item or a
   *  command-output attachment. A prompt's entry keys the run's last
   *  member; a steer's attachment keys its `source_uuid`. */
  private readonly renderedUuids = new Set<UUID>();
  /** Replacement lookup for `replaceItem`.
   *  TODO: a lookup is always of a pending item now (an open stream stays
   *  pending; file comment), so a scan of the pending part may make this
   *  map (which grows for the conversation's lifetime) unnecessary. */
  private readonly itemsByUuid = new Map<UUID, AssistantItem | UserTurnItem>();
  /** For headerArg path abbreviation (per-tool views). */
  private cwd: string | undefined;
  private toolsExpanded = false;
  private compactSummaryExpanded = false;
  private showThinking = false;
  private readonly compactSummaries: CompactSummaryComponent[] = [];
  /** The last boundary frame's anchor, until the next top-level user
   *  frame (see file comment). */
  private expectedSummaryUuid: UUID | undefined;
  /** Previous top-level entry's timestamp (thinking-duration rule). */
  private lastEntryAtMs: number | undefined;

  constructor(container: Container) {
    this.container = container;
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
    this.appendMessage(message, this.pendingItems);
  }

  /** `append` with the part its keyed items join: the pending part for a
   *  query message, the resolved part for an entry's (`appendEntry`). */
  private appendMessage(message: SDKMessage, part: TranscriptItem[]): void {
    switch (message.type) {
      case "stream_event": {
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
          break;
        }
        const live = this.streaming.get(key);
        if (live === undefined) {
          break;
        }
        if (message.event.type === "message_stop") {
          // The response's end: every block has left the stream for its
          // own item (StreamingComponent.finalizedUuids), so what remains
          // is at most blocks the render model dropped.
          this.discardStream(key, live);
          break;
        }
        live.state = foldStreamEvent(live.state, message.event);
        live.component.updateContent(live.state.partial);
        break;
      }
      case "assistant": {
        const key = message.parent_tool_use_id ?? "";
        const live = this.streaming.get(key);
        // A mismatch is the file side lagging, not an error: the query
        // stream finalizes A before opening B, but A's entry can arrive
        // after B's message_start opened the stream at this key.
        const ownStream =
          live?.apiMessageId === message.message.id ? live : undefined;
        // The message is one block of the response its stream renders:
        // the block leaves the partial (once, whichever side delivers the
        // message first) and renders as its own item ahead of the stream.
        if (
          ownStream !== undefined &&
          !ownStream.finalizedUuids.has(message.uuid)
        ) {
          ownStream.state = withoutBlock(
            ownStream.state,
            ownStream.finalizedUuids.size,
          );
          ownStream.finalizedUuids.add(message.uuid);
          ownStream.component.updateContent(ownStream.state.partial);
        }
        if (
          message.parent_tool_use_id === null &&
          this.renderedUuids.has(message.uuid)
        ) {
          break; // the entry rendered this message
        }
        const rendered = suppressNoResponse(renderAssistant(message));
        const thinkingSeconds =
          message.parent_tool_use_id === null && hasThinking(rendered)
            ? this.entryDeltaSeconds(message)
            : undefined;
        if (message.parent_tool_use_id === null) {
          this.stampEntry(message);
        }
        // A top-level item is keyed by the message; a stream's item never is.
        const uuid =
          message.parent_tool_use_id === null ? message.uuid : undefined;
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
            const tool = new ToolExecutionComponent(
              block.name,
              block.arguments,
              this.cwd,
            );
            tool.setExpanded(this.toolsExpanded);
            this.toolComponents.set(block.id, tool);
            const parent = this.parentTool(message.parent_tool_use_id);
            if (parent === undefined) {
              const item: ToolItem = {
                kind: "tool",
                uuid,
                name: block.name,
                component: tool,
                view: toolViewFor(block.name),
              };
              this.toolItems.set(block.id, item);
              this.insertItem(item, part, ownStream);
            } else if (ownStream === undefined) {
              parent.addSubagentChild(tool);
            } else {
              parent.addSubagentChildBefore(tool, ownStream.component);
            }
          }
        }
        this.rebuild();
        break;
      }
      case "user": {
        if (message.parent_tool_use_id === null) {
          this.stampEntry(message);
          const expectedSummaryUuid = this.expectedSummaryUuid;
          this.expectedSummaryUuid = undefined;
          if (
            message.uuid !== undefined &&
            message.uuid === expectedSummaryUuid
          ) {
            this.renderCompactSummary(
              message.message.content,
              message.uuid,
              part,
            );
          } else if ((message as { isReplay?: boolean }).isReplay !== true) {
            // The CLI writes `isReplay: false` on frames the SDK type
            // declares without the field.
            const views = userTurnViews(message);
            if (views.length > 0 && this.firstRender(message.uuid)) {
              this.addUserTurn(views, message.uuid, part);
            }
          }
        }
        // A subagent's user frames (its task prompt) are not this
        // conversation's turns; only their tool results land here.
        this.applyToolResults(message);
        this.rebuild();
        break;
      }
      case "conversation_reset":
        // The old conversation is no longer this surface's transcript.
        this.resolvedItems.length = 0;
        this.pendingItems.length = 0;
        this.streaming.clear();
        this.toolComponents.clear();
        this.toolItems.clear();
        this.assistantComponents.length = 0;
        this.compactSummaries.length = 0;
        this.renderedUuids.clear();
        this.itemsByUuid.clear();
        this.expectedSummaryUuid = undefined;
        this.lastEntryAtMs = undefined;
        this.addBanner("conversation reset");
        break;
      case "system": {
        // init and status carry only state, which the caller's fold covers;
        // they render nothing. commands_changed is a caller side effect.
        if (message.subtype === "local_command_output") {
          // Steered `!` output: the CLI's own rendering (embedded ANSI
          // passes through the ⤷ block), attached to the preceding command.
          if (this.firstRender(message.uuid)) {
            this.addUserTurn(
              [{ kind: "commandOutput", text: message.content }],
              message.uuid,
              part,
            );
          }
        } else if (message.subtype === "compact_boundary") {
          const anchorUuid =
            message.compact_metadata.preserved_messages?.anchor_uuid;
          this.expectedSummaryUuid =
            anchorUuid === message.uuid ? undefined : anchorUuid;
          if (this.firstRender(message.uuid)) {
            this.addPlain(
              bannerText(
                compactBanner(
                  message.compact_metadata.pre_tokens,
                  message.compact_metadata.post_tokens,
                ),
              ),
              message.uuid,
              part,
            );
          }
        } else if (message.subtype === "notification") {
          this.addBanner(message.text);
        } else if (message.subtype === "informational") {
          if (message.level !== "info") {
            this.addBanner(message.content);
          }
        } else if (
          message.subtype === "model_refusal_fallback" ||
          message.subtype === "model_refusal_no_fallback"
        ) {
          const parts = [message.content];
          if (
            message.api_refusal_category !== undefined &&
            message.api_refusal_category !== null
          ) {
            parts.push(`category: ${message.api_refusal_category}`);
          }
          if (
            message.api_refusal_explanation !== undefined &&
            message.api_refusal_explanation !== null
          ) {
            parts.push(message.api_refusal_explanation);
          }
          if (message.subtype === "model_refusal_fallback") {
            parts.push(`falling back to ${message.fallback_model}`);
          }
          this.addBanner(parts.join(" — "), "error");
        }
        // Other system subtypes (session_state_changed, hook and task
        // lifecycle, …) are operational chatter with no transcript content.
        break;
      }
      case "result": {
        if (message.is_error) {
          this.addBanner(`turn failed: ${message.subtype}`);
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
   *  output (a command's stdout arrives as its own message) attach to the
   *  immediately preceding user turn when it has a command to hold them,
   *  else render as a standalone output turn. */
  private addUserTurn(
    views: readonly UserTurnView[],
    uuid: UUID | undefined,
    part: TranscriptItem[],
  ): void {
    if (views.every(isOutputView)) {
      const texts = views.map(outputText).filter((text) => text !== undefined);
      if (texts.length === 0) {
        return;
      }
      const last = this.pendingItems.at(-1) ?? this.resolvedItems.at(-1);
      if (
        last?.kind === "userTurn" &&
        last.component.attachOutput(texts.join("\n"))
      ) {
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

  /** The summary's user message carries its text as a plain string. */
  private renderCompactSummary(
    content: unknown,
    uuid: UUID,
    part: TranscriptItem[],
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
   * boundary entries render the compact_boundary banner; a user entry, or
   * one with no message of its own (a steered prompt's `queued_command`
   * attachment, a local command), renders as a user turn
   * (`appendUserEntry`); anything else → `appendMessage`. Session-entry
   * metadata that entryToSessionMessage drops (cwd) is read from the entry
   * here. A SessionMessage carries every field its SDKMessage variant
   * requires, so the cast is a narrowing of `message: unknown`, not a
   * fabrication. File-side: the items land in the resolved part, so the
   * caller delivers an entry only once its uuid resolved (`resolve`, the
   * history rebuild).
   */
  appendEntry(entry: SessionEntry): void {
    const part = this.resolvedItems;
    if (entry.subtype === "compact_boundary") {
      const metadata = entry.compactMetadata as
        { preTokens?: unknown; postTokens?: unknown } | undefined;
      if (this.firstRender(entry.uuid)) {
        this.addPlain(
          bannerText(compactBanner(metadata?.preTokens, metadata?.postTokens)),
          entry.uuid,
          part,
        );
      }
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
    const message = entryToSessionMessage(entry) as
      (SessionMessage & SDKMessage) | undefined;
    if (message !== undefined && message.type !== "user") {
      this.appendMessage(message, part);
      return;
    }
    // A steered prompt's attachment is keyed by the prompt's own uuid.
    const key = queuedCommandSourceUuid(entry) ?? entry.uuid;
    const views = entryUserViews(entry, message);
    if (views.length > 0 && this.firstRender(key)) {
      this.addUserTurn(views, key, part);
    }
    if (message !== undefined) {
      this.stampEntry(message);
      this.applyToolResults(message);
    }
    this.rebuild();
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
    const last = this.pendingItems.findLastIndex((item) => item.uuid === uuid);
    if (last !== -1) {
      this.resolvePrefix(last + 1);
    }
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

  /** The pending items before `end`, plus the unkeyed ones after them up
   *  to the next keyed item or open stream, join the resolved part. */
  private resolvePrefix(end: number): void {
    while (
      end < this.pendingItems.length &&
      this.pendingItems[end]!.uuid === undefined &&
      !isOpenStream(this.pendingItems[end]!)
    ) {
      end += 1;
    }
    this.resolvedItems.push(...this.pendingItems.splice(0, end));
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
   *  The banners the item held back resolve once it is gone (file comment:
   *  the pending part never starts with an unkeyed item). */
  private discardStream(key: string, stream: StreamingComponent): void {
    this.streaming.delete(key);
    const componentIndex = this.assistantComponents.indexOf(stream.component);
    if (componentIndex !== -1) {
      this.assistantComponents.splice(componentIndex, 1);
    }
    if (stream.item !== undefined) {
      const itemIndex = this.pendingItems.indexOf(stream.item);
      if (itemIndex !== -1) {
        this.pendingItems.splice(itemIndex, 1);
        if (itemIndex === 0) {
          this.resolvePrefix(0);
        }
      }
    }
    this.rebuild();
  }

  /** cwd for headerArg path abbreviation; InteractiveMode feeds it from
   *  AgentState.cwd, appendEntry from entry.cwd. */
  setCwd(cwd: string | undefined): void {
    this.cwd = cwd;
  }

  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.toolComponents.values()) {
      tool.setExpanded(expanded);
    }
    for (const item of [...this.resolvedItems, ...this.pendingItems]) {
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

  /** A dim one-line notice in transcript order (also the caller's banner
   *  surface, so banners survive rebuilds). Keyed by `uuid` when the
   *  banner renders an event, so `resolve(uuid)` moves it; unkeyed it
   *  resolves with whatever precedes it. */
  addBanner(text: string, color: ThemeColor = "dim", uuid?: UUID): void {
    this.addPlain(bannerText(text, color), uuid, this.pendingItems);
  }

  private addPlain(
    component: Component,
    uuid: UUID | undefined,
    part: TranscriptItem[],
  ): void {
    this.addItem({ kind: "plain", uuid, component }, part);
  }

  private addItem(item: TranscriptItem, part: TranscriptItem[]): void {
    this.insertItem(item, part, undefined);
    this.rebuild();
  }

  /** `item` into its part (`partFor`), ahead of `stream`'s item when the
   *  two share that part (a finalized block ahead of the rest of its
   *  response), else at the end. */
  private insertItem(
    item: TranscriptItem,
    part: TranscriptItem[],
    stream: StreamingComponent | undefined,
  ): void {
    const target = this.partFor(item, part);
    const index = stream?.item === undefined ? -1 : target.indexOf(stream.item);
    if (index === -1) {
      target.push(item);
    } else {
      target.splice(index, 0, item);
    }
  }

  /** Where a new item goes: a keyed item to `part`; an open stream's item
   *  to the pending part; any other unkeyed one behind the pending items
   *  if there are any, else straight into the resolved part (see file
   *  comment). */
  private partFor(
    item: TranscriptItem,
    part: TranscriptItem[],
  ): TranscriptItem[] {
    if (item.uuid !== undefined) {
      return part;
    }
    return this.pendingItems.length > 0 || isOpenStream(item)
      ? this.pendingItems
      : this.resolvedItems;
  }

  /** Thinking-duration rule: this entry's timestamp minus the previous
   *  entry's; undefined when either is missing or time ran backwards. */
  private entryDeltaSeconds(message: SDKMessage): number | undefined {
    const at = messageTimestampMs(message) ?? Date.now();
    if (this.lastEntryAtMs === undefined || at < this.lastEntryAtMs) {
      return undefined;
    }
    return (at - this.lastEntryAtMs) / 1000;
  }

  /** Monotonic: a message's second arrival (its entry after its frame, or
   *  the reverse) must not move the baseline back behind a later entry.
   *  Only assistant messages carry a timestamp; the rest stamp arrival
   *  time, so a delta across a rebuild measures the replay, not the
   *  session. */
  private stampEntry(message: SDKMessage): void {
    const at = messageTimestampMs(message) ?? Date.now();
    this.lastEntryAtMs = Math.max(this.lastEntryAtMs ?? at, at);
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
   *  component when given (`insertItem`). */
  private attachAssistant(
    component: AssistantMessageComponent,
    parentToolUseId: string | null,
    uuid: UUID | undefined,
    part: TranscriptItem[],
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
    this.insertItem(item, part, stream);
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
   *  foldable items into single lines while both toggles are collapsed. */
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
    for (const part of [this.resolvedItems, this.pendingItems]) {
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
    }
    flush();
  }

  /** The collapsed-thinking one-liner an individually-rendered (unfolded)
   *  assistant shows in place of its thinking. `ctrl+t` where claude says
   *  `ctrl+o`: decided divergence (we split the two toggles). */
  private applyThinkingLabel(item: AssistantItem): void {
    if (this.showThinking) {
      return;
    }
    item.component.setHiddenThinkingLabel(
      item.thinkingSeconds === undefined
        ? "Thinking… (ctrl+t to show)"
        : `Thought for ${displayThinkingSeconds(item.thinkingSeconds)}s (ctrl+t to show)`,
    );
  }
}

/** A compaction summary as claude 2.1.211 shows it: a dim "Compacted
 *  (ctrl+o to see full summary)" line while collapsed, the markdown-rendered
 *  summary when expanded. */
class CompactSummaryComponent implements Component {
  private readonly collapsedView: Component;
  private readonly expandedView: Component;
  private expanded = false;

  constructor(text: string) {
    this.collapsedView = new Text(
      theme.fg("dim", "Compacted (ctrl+o to see full summary)"),
      1,
      1,
    );
    const container = new Container();
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(text, 2, 0, getMarkdownTheme()));
    this.expandedView = container;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return (this.expanded ? this.expandedView : this.collapsedView).render(
      width,
    );
  }
}

/** The views a session entry contributes to a user turn: a user message's
 *  text, a steered prompt's `queued_command` attachment, a
 *  system/local_command entry (slash commands and their stdout can live
 *  there — empirical: /login, /context; others arrive as user messages —
 *  which entryToSessionMessage drops). Empty otherwise. */
function entryUserViews(
  entry: SessionEntry,
  message: (SessionMessage & SDKMessage) | undefined,
): UserTurnView[] {
  if (
    entry.type === "system" &&
    entry.subtype === "local_command" &&
    typeof entry.content === "string"
  ) {
    return userTurnViewsFromText(entry.content);
  }
  const steeredPrompt = queuedCommandPrompt(entry);
  if (steeredPrompt !== undefined) {
    // A steer's attachment is the prompt verbatim; a `/command` is never
    // steered (tests/sdk/steer-slash-command.test.ts), so no expansion.
    return [{ kind: "prompt", text: steeredPrompt }];
  }
  return message?.type === "user" ? userTurnViews(message) : [];
}

function bannerText(text: string, color: ThemeColor = "dim"): Text {
  return new Text(theme.fg(color, text), 1, 1);
}

/** "context compacted (156k → 12k tokens)". Unknown-typed so replayed
 *  entries' compactMetadata needs no narrowing at the call site; counts are
 *  omitted when the boundary does not carry them (clauctl-injected
 *  boundaries write only preTokens). */
function compactBanner(preTokens: unknown, postTokens: unknown): string {
  if (typeof preTokens !== "number") {
    return "context compacted";
  }
  const pre = formatTokens(preTokens);
  return typeof postTokens === "number"
    ? `context compacted (${pre} → ${formatTokens(postTokens)} tokens)`
    : `context compacted (${pre} tokens)`;
}

/** The CLI synthesizes an assistant "No response requested." after local
 *  commands; claude never shows it (observed on the /compact capture).
 *  Normalized to an empty message so nothing renders. */
function suppressNoResponse(rendered: RenderAssistant): RenderAssistant {
  const suppress =
    rendered.content.length > 0 &&
    rendered.content.every((block) => block.type === "text") &&
    rendered.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim() === "No response requested.";
  return suppress ? { ...rendered, content: [] } : rendered;
}

/** Whole seconds for a "Thought for Ns" label, as claude 2.1.258 shows
 *  them: floored, with a 1s minimum for sub-second durations (observed in
 *  parity captures; all multi-second durations matched the floor). */
function displayThinkingSeconds(seconds: number): number {
  return Math.max(1, Math.floor(seconds));
}

function isFoldable(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "plain":
    case "userTurn":
      return false;
    case "tool":
      return (
        READ_ONLY_TOOLS.has(item.name) &&
        item.result !== undefined &&
        !item.result.isError
      );
    case "assistant": {
      if (item.rendered === undefined) {
        return false; // streaming
      }
      const visibleText = item.rendered.content.some(
        (block) => block.type === "text" && block.text.trim() !== "",
      );
      const visibleStop =
        item.rendered.stopReason === "length" ||
        item.rendered.stopReason === "error" ||
        item.rendered.stopReason === "aborted";
      return !visibleText && !visibleStop;
    }
  }
}

/**
 * One fold run as a single line — "Thought for 4s, read 2 files, searched
 * for 1 pattern (ctrl+o to expand)" — grey with bold numbers, capitalized
 * when there is no thinking clause; undefined when the run has nothing to
 * say (only empty assistant messages).
 */
function foldRunComponent(run: TranscriptItem[]): Component | undefined {
  let thinkingSeconds = 0;
  let sawThinking = false;
  let sawDuration = false;
  const toolCounts = new Map<string, number>();
  for (const item of run) {
    if (item.kind === "assistant" && item.rendered !== undefined) {
      if (hasThinking(item.rendered)) {
        sawThinking = true;
        if (item.thinkingSeconds !== undefined) {
          sawDuration = true;
          thinkingSeconds += item.thinkingSeconds;
        }
      }
    } else if (item.kind === "tool") {
      toolCounts.set(item.name, (toolCounts.get(item.name) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  if (sawThinking) {
    parts.push(
      sawDuration
        ? `Thought for ${claudeStyle.bold(`${displayThinkingSeconds(thinkingSeconds)}s`)}`
        : "Thought",
    );
  }
  for (const [name, count] of toolCounts) {
    // Foldable tools without a bespoke view (claude's fold phrasing for
    // them is unattested in the parity captures) get a generic clause.
    parts.push(
      toolViewFor(name)?.foldLabel?.(count) ??
        `used ${name} ${count} time${count === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  let line = parts.join(", ");
  if (!sawThinking) {
    line = line.charAt(0).toUpperCase() + line.slice(1);
  }
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(` ${claudeStyle.grey(`${line} (ctrl+o to expand)`)}`, 1, 0),
  );
  return container;
}
