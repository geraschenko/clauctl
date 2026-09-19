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
 * tool results, an `assistant` frame finalizes or discards the stream it
 * owns). Streams are owned by API `message.id`, not transcript uuid: the
 * two sides are delayed independently, so the stream open at a key need
 * not belong to the message being finalized. `itemsByUuid` lets a resolved
 * entry re-render its frame's item in place (`replaceContent`).
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
import { UserCommandComponent } from "./components/user-command.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { claudeStyle } from "./claude-style.ts";
import {
  beginMessage,
  foldStreamEvent,
  renderAssistant,
  toolResultsOf,
  userTurnViews,
  userTurnViewsFromText,
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

interface AssistantItem {
  kind: "assistant";
  component: AssistantMessageComponent;
  /** Undefined while streaming; streaming components never fold. */
  rendered?: RenderAssistant;
  /** Timestamp-delta duration; undefined when unavailable/non-monotonic. */
  thinkingSeconds?: number;
}

interface ToolItem {
  kind: "tool";
  name: string;
  component: ToolExecutionComponent;
  view: ToolView<unknown> | undefined;
  result?: RenderToolResult;
}

interface PlainItem {
  kind: "plain";
  component: Component;
}

interface CommandItem {
  kind: "command";
  component: UserCommandComponent;
  /** The slash command (e.g. "/compact"); undefined for bash passthrough
   *  and standalone output blocks. */
  command: string | undefined;
  hasOutput: boolean;
}

type TranscriptItem = AssistantItem | ToolItem | PlainItem | CommandItem;

interface StreamingComponent {
  component: AssistantMessageComponent;
  state: StreamingMessage;
  /** The top-level item to finalize; undefined for subagent streams. */
  item: AssistantItem | undefined;
  /** The API message id from `message_start`: the stream's owner. */
  apiMessageId: string;
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
  /** Ordered top-level transcript content; container children derive from
   *  it on every rebuild. */
  private readonly items: TranscriptItem[] = [];
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
  /** Replacement lookup for `replaceContent`. */
  private readonly itemsByUuid = new Map<UUID, AssistantItem>();
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
   * is that message.
   */
  append(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event": {
        const key = message.parent_tool_use_id ?? "";
        if (message.event.type === "message_start") {
          const component = this.newAssistantComponent(undefined);
          const item = this.attachAssistant(
            component,
            message.parent_tool_use_id,
          );
          this.streaming.set(key, {
            component,
            state: beginMessage(),
            item,
            apiMessageId: message.event.message.id,
          });
          break;
        }
        const live = this.streaming.get(key);
        if (live !== undefined) {
          live.state = foldStreamEvent(live.state, message.event);
          live.component.updateContent(live.state.partial);
        }
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
        if (
          message.parent_tool_use_id === null &&
          this.renderedUuids.has(message.uuid)
        ) {
          // The entry rendered this message; a stream still open for it is
          // the provisional rendering the entry superseded.
          if (ownStream !== undefined) {
            this.discardStream(key, ownStream);
          }
          break;
        }
        const rendered = suppressNoResponse(renderAssistant(message));
        const thinkingSeconds =
          message.parent_tool_use_id === null && hasThinking(rendered)
            ? this.entryDeltaSeconds(message)
            : undefined;
        if (message.parent_tool_use_id === null) {
          this.stampEntry(message);
        }
        let item: AssistantItem | undefined;
        if (ownStream !== undefined) {
          ownStream.component.updateContent(rendered);
          item = ownStream.item;
          this.streaming.delete(key);
        } else {
          // No partials of this message seen (subscribed mid-message, or the
          // entry outran its stream): render whole.
          const component = this.newAssistantComponent(rendered);
          item = this.attachAssistant(component, message.parent_tool_use_id);
        }
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
                name: block.name,
                component: tool,
                view: toolViewFor(block.name),
              };
              this.toolItems.set(block.id, item);
              this.items.push(item);
            } else {
              parent.addSubagentChild(tool);
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
            this.renderCompactSummary(message.uuid, message.message.content);
          } else if ((message as { isReplay?: boolean }).isReplay !== true) {
            // The CLI writes `isReplay: false` on frames the SDK type
            // declares without the field.
            const views = userTurnViews(message);
            if (views.length > 0 && this.firstRender(message.uuid)) {
              for (const view of views) {
                this.appendUserView(view);
              }
            }
          }
        }
        // A subagent's user frames (its task prompt) are not this
        // conversation's turns; only their tool results land here.
        for (const result of toolResultsOf(message)) {
          this.toolComponents.get(result.toolCallId)?.updateResult(result);
          const item = this.toolItems.get(result.toolCallId);
          if (item !== undefined) {
            item.result = result;
          }
        }
        this.rebuild();
        break;
      }
      case "conversation_reset":
        // The old conversation is no longer this surface's transcript.
        this.items.length = 0;
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
            this.attachCommandOutput(message.content);
          }
        } else if (message.subtype === "compact_boundary") {
          const anchorUuid =
            message.compact_metadata.preserved_messages?.anchor_uuid;
          this.expectedSummaryUuid =
            anchorUuid === message.uuid ? undefined : anchorUuid;
          if (this.firstRender(message.uuid)) {
            this.addBanner(
              compactBanner(
                message.compact_metadata.pre_tokens,
                message.compact_metadata.post_tokens,
              ),
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

  private appendUserView(view: UserTurnView): void {
    switch (view.kind) {
      case "prompt":
      case "contextTag":
        this.addPlain(new UserMessageComponent(view.text));
        break;
      case "slashCommand":
        this.addCommand(
          view.args === "" ? view.command : `${view.command} ${view.args}`,
          view.command,
        );
        break;
      case "bashInput":
        this.addCommand(`! ${view.command}`, undefined);
        break;
      case "commandOutput":
        this.attachCommandOutput(view.text);
        break;
      case "bashOutput": {
        const parts = [view.stdout, view.stderr].filter(
          (part) => part.trim() !== "",
        );
        if (parts.length > 0) {
          this.attachCommandOutput(parts.join("\n"));
        }
        break;
      }
    }
  }

  private addCommand(line: string, command: string | undefined): void {
    const component = new UserCommandComponent(line);
    component.setExpanded(this.toolsExpanded);
    this.items.push({ kind: "command", component, command, hasOutput: false });
    this.rebuild();
  }

  /** Command output renders under the immediately preceding command block;
   *  with none (or one already holding output), as a standalone ⤷ block.
   *  /compact's transient stdout is hidden — claude does (observed on the
   *  failed-compact capture), and the success path renders the boundary
   *  banner + full summary instead. */
  private attachCommandOutput(text: string): void {
    const last = this.items.at(-1);
    if (last?.kind === "command" && !last.hasOutput) {
      if (last.command === "/compact") {
        return;
      }
      last.hasOutput = true;
      last.component.setOutput(text);
      this.rebuild();
      return;
    }
    const component = new UserCommandComponent(undefined);
    component.setOutput(text);
    component.setExpanded(this.toolsExpanded);
    this.items.push({
      kind: "command",
      component,
      command: undefined,
      hasOutput: true,
    });
    this.rebuild();
  }

  /** The summary's user message carries its text as a plain string. */
  private renderCompactSummary(uuid: UUID, content: unknown): void {
    if (typeof content === "string" && this.firstRender(uuid)) {
      const component = new CompactSummaryComponent(content);
      component.setExpanded(this.compactSummaryExpanded);
      this.compactSummaries.push(component);
      this.addPlain(component);
    }
  }

  /**
   * Render one session entry as `append` renders its query message:
   * boundary entries render the compact_boundary banner; user prompts
   * render their views THEN append (tool-result resolution; result-only
   * messages have no visible views); assistant → append; a steered prompt's
   * `queued_command` attachment renders as a user turn (it has no
   * sdkMessage twin).
   * Session-entry metadata that entryToSessionMessage drops (cwd) is read
   * from the entry here. A SessionMessage carries every field its
   * SDKMessage variant requires, so the cast is a narrowing of `message:
   * unknown`, not a fabrication.
   */
  appendEntry(entry: SessionEntry): void {
    if (entry.subtype === "compact_boundary") {
      const metadata = entry.compactMetadata as
        { preTokens?: unknown; postTokens?: unknown } | undefined;
      if (this.firstRender(entry.uuid)) {
        this.addBanner(
          compactBanner(metadata?.preTokens, metadata?.postTokens),
        );
      }
      return;
    }
    if (typeof entry.cwd === "string") {
      this.cwd = entry.cwd;
    }
    // Slash commands and their stdout can live in system/local_command
    // entries (empirical: /login, /context; others arrive as user
    // messages), which entryToSessionMessage drops.
    if (
      entry.type === "system" &&
      entry.subtype === "local_command" &&
      typeof entry.content === "string"
    ) {
      if (this.firstRender(entry.uuid)) {
        for (const view of userTurnViewsFromText(entry.content)) {
          this.appendUserView(view);
        }
      }
      return;
    }
    // A steered prompt's only transcript record; it reads as the user turn
    // it was, keyed by the prompt's own uuid (`source_uuid`).
    const steeredPrompt = queuedCommandPrompt(entry);
    if (steeredPrompt !== undefined) {
      if (this.firstRender(queuedCommandSourceUuid(entry) ?? entry.uuid)) {
        for (const view of userTurnViewsFromText(steeredPrompt)) {
          this.appendUserView(view);
        }
      }
      return;
    }
    if (entry.isCompactSummary === true && entry.uuid !== undefined) {
      this.renderCompactSummary(
        entry.uuid,
        (entry.message as { content?: unknown } | undefined)?.content,
      );
      return;
    }
    const message = entryToSessionMessage(entry);
    if (message === undefined) {
      return;
    }
    const sdkMessage = message as SessionMessage & SDKMessage;
    if (sdkMessage.type === "user") {
      const views = userTurnViews(sdkMessage);
      if (views.length > 0 && this.firstRender(sdkMessage.uuid)) {
        for (const view of views) {
          this.appendUserView(view);
        }
      }
    }
    this.append(sdkMessage);
  }

  /** Re-render the item keyed under `uuid` from its entry (an assistant
   *  frame carries `stop_reason: null`; its entry the final value). Tool
   *  items are keyed by tool call id and untouched. No-op without an
   *  item or an assistant rendering of the entry. */
  replaceContent(uuid: UUID, entry: SessionEntry): void {
    const item = this.itemsByUuid.get(uuid);
    const message = entryToSessionMessage(entry) as
      (SessionMessage & SDKMessage) | undefined;
    if (item === undefined || message?.type !== "assistant") {
      return;
    }
    const rendered = suppressNoResponse(renderAssistant(message));
    item.rendered = rendered;
    item.component.updateContent(rendered);
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

  /** Drop an open stream's provisional component and top-level item. */
  private discardStream(key: string, stream: StreamingComponent): void {
    this.streaming.delete(key);
    const componentIndex = this.assistantComponents.indexOf(stream.component);
    if (componentIndex !== -1) {
      this.assistantComponents.splice(componentIndex, 1);
    }
    if (stream.item !== undefined) {
      const itemIndex = this.items.indexOf(stream.item);
      if (itemIndex !== -1) {
        this.items.splice(itemIndex, 1);
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
    for (const item of this.items) {
      if (item.kind === "command") {
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
   *  surface, so banners survive rebuilds). */
  addBanner(text: string, color: ThemeColor = "dim"): void {
    this.addPlain(new Text(theme.fg(color, text), 1, 1));
  }

  private addPlain(component: Component): void {
    this.items.push({ kind: "plain", component });
    this.rebuild();
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
   *  under the owning subagent tool (undefined). */
  private attachAssistant(
    component: AssistantMessageComponent,
    parentToolUseId: string | null,
  ): AssistantItem | undefined {
    const parent = this.parentTool(parentToolUseId);
    if (parent !== undefined) {
      parent.addSubagentChild(component);
      return undefined;
    }
    const item: AssistantItem = { kind: "assistant", component };
    this.items.push(item);
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
    for (const item of this.items) {
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
    case "command":
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
