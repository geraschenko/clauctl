/**
 * TranscriptRenderer: the single source of truth for transcript content.
 * Live attach (interactive-mode.ts) and render-from-file
 * (scripts/tui-parity/render-session.ts) both render through this class, so
 * the two paths cannot drift. It owns the transcript components — streaming
 * fold, tool components, user/assistant blocks, banners — while the caller
 * keeps everything that is not transcript content: pending/status/queue
 * areas, replay dedupe bookkeeping, and autocomplete side effects.
 *
 * Top-level content is kept as an ordered item list and the container's
 * children are rebuilt from it on every change, because the collapsed view
 * folds runs of thinking + read-only tools into single lines ("Thought for
 * 4s, read 2 files (ctrl+o to expand)") that must disband when either
 * toggle expands and re-form when both collapse — a fold run is a maximal
 * consecutive sequence of finalized thinking-only assistant messages and
 * readOnly tools with non-error results; text blocks, non-readOnly tools,
 * errors, and visible user turns end runs. Thinking durations follow
 * claude's session-file rule (validated empirically): a thinking message's
 * duration is its timestamp minus the previous entry's timestamp; live
 * messages carry no timestamp, so arrival time — the same clock the CLI
 * stamps entries with — stands in.
 */

import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type {
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { entryToSessionMessage } from "../core/session-file.ts";
import type { PathNode } from "../core/tree.ts";
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
import { toolViewFor, type ToolView } from "./tool-views/tool-view.ts";
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
  /** For headerArg path abbreviation (per-tool views). */
  private cwd: string | undefined;
  private toolsExpanded = false;
  private compactSummaryExpanded = false;
  private showThinking = false;
  private readonly compactSummaries: CompactSummaryComponent[] = [];
  /** Previous top-level entry's timestamp (thinking-duration rule). */
  private lastEntryAtMs: number | undefined;

  constructor(container: Container) {
    this.container = container;
  }

  /**
   * Fold one SDK message into transcript components: stream events drive the
   * streaming component; a finalized assistant message replaces it; user
   * messages only resolve tool results (unknown toolCallId → dropped;
   * parent_tool_use_id-routed content renders nested under the owning
   * component). Live user PROMPT text does NOT render here — it is echoed at
   * dequeue via appendUserTurn.
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
          this.streaming.set(key, { component, state: beginMessage(), item });
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
        const rendered = suppressNoResponse(renderAssistant(message));
        const thinkingSeconds =
          message.parent_tool_use_id === null && hasThinking(rendered)
            ? this.entryDeltaSeconds(message)
            : undefined;
        if (message.parent_tool_use_id === null) {
          this.stampEntry(message);
        }
        const live = this.streaming.get(key);
        if (live !== undefined) {
          live.component.updateContent(rendered);
          if (live.item !== undefined) {
            live.item.rendered = rendered;
            live.item.thinkingSeconds = thinkingSeconds;
          }
          this.streaming.delete(key);
        } else {
          // No partials seen (e.g. subscribed mid-message): render whole.
          const component = this.newAssistantComponent(rendered);
          const item = this.attachAssistant(
            component,
            message.parent_tool_use_id,
          );
          if (item !== undefined) {
            item.rendered = rendered;
            item.thinkingSeconds = thinkingSeconds;
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
        }
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
        this.lastEntryAtMs = undefined;
        this.addBanner("conversation reset");
        break;
      case "system": {
        // init and status carry only state, which the caller's fold covers;
        // they render nothing. commands_changed is a caller side effect.
        if (message.subtype === "local_command_output") {
          // Steered `!` output: the CLI's own rendering (embedded ANSI
          // passes through the ⎿ block), attached to the preceding command.
          this.attachCommandOutput(message.content);
        } else if (message.subtype === "compact_boundary") {
          this.addBanner("context compacted");
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

  /**
   * Render a user turn's visible content, one component per view. Called by
   * replay (user path nodes) and by InteractiveMode's dequeue echo, so live
   * and replayed prompts share one rendering.
   */
  appendUserTurn(message: SDKUserMessage): void {
    for (const view of userTurnViews(message)) {
      this.appendUserView(view);
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
   *  with none (or one already holding output), as a standalone ⎿ block.
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

  private addCompactSummary(text: string): void {
    const component = new CompactSummaryComponent(text);
    component.setExpanded(this.compactSummaryExpanded);
    this.compactSummaries.push(component);
    this.addPlain(component);
  }

  /**
   * Replay one history node through the exact live pipeline: boundary nodes
   * render the banner their live compact_boundary event would; user prompts
   * render via appendUserTurn THEN append (tool-result resolution;
   * result-only messages have no visible views); assistant → append.
   * Session-entry metadata that entryToSessionMessage drops (cwd, and later
   * isCompactSummary) is read from the entry here. A SessionMessage carries
   * every field its SDKMessage variant requires, so the cast is a narrowing
   * of `message: unknown`, not a fabrication.
   */
  appendPathNode(node: PathNode): void {
    if (node.entry.subtype === "compact_boundary") {
      this.addBanner("context compacted");
      return;
    }
    if (typeof node.entry.cwd === "string") {
      this.cwd = node.entry.cwd;
    }
    // Slash commands and their stdout can live in system/local_command
    // entries (empirical: /login, /context; others arrive as user
    // messages), which entryToSessionMessage drops.
    if (
      node.entry.type === "system" &&
      node.entry.subtype === "local_command" &&
      typeof node.entry.content === "string"
    ) {
      for (const view of userTurnViewsFromText(node.entry.content)) {
        this.appendUserView(view);
      }
      return;
    }
    if (node.entry.isCompactSummary === true) {
      const content = (node.entry.message as { content?: unknown } | undefined)
        ?.content;
      if (typeof content === "string") {
        this.addCompactSummary(content);
        return;
      }
    }
    const message = entryToSessionMessage(node.entry);
    if (message === undefined) {
      return;
    }
    const sdkMessage = message as SessionMessage & SDKMessage;
    if (sdkMessage.type === "user") {
      this.appendUserTurn(sdkMessage);
    }
    this.append(sdkMessage);
  }

  /** cwd for headerArg path abbreviation; InteractiveMode feeds it from
   *  AgentState.cwd, appendPathNode from entry.cwd. */
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

  private stampEntry(message: SDKMessage): void {
    this.lastEntryAtMs = messageTimestampMs(message) ?? Date.now();
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
        : `Thought for ${Math.floor(item.thinkingSeconds)}s (ctrl+t to show)`,
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

function isFoldable(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "plain":
    case "command":
      return false;
    case "tool":
      return (
        item.view?.readOnly === true &&
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
  const toolCounts = new Map<ToolView<unknown>, number>();
  for (const item of run) {
    if (item.kind === "assistant" && item.rendered !== undefined) {
      if (hasThinking(item.rendered)) {
        sawThinking = true;
        if (item.thinkingSeconds !== undefined) {
          sawDuration = true;
          thinkingSeconds += item.thinkingSeconds;
        }
      }
    } else if (item.kind === "tool" && item.view !== undefined) {
      toolCounts.set(item.view, (toolCounts.get(item.view) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  if (sawThinking) {
    parts.push(
      sawDuration
        ? `Thought for ${claudeStyle.bold(`${Math.floor(thinkingSeconds)}s`)}`
        : "Thought",
    );
  }
  for (const [view, count] of toolCounts) {
    parts.push(view.foldLabel(count));
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
