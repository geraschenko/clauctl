// Ported from pi coding-agent src/modes/interactive/components/assistant-message.ts @ 0.99.2
//
// Differences from the pi original, kept minimal for mirror-diffing
// (see scripts/update-ports.sh for the update procedure):
// - consumes RenderAssistant (render-types.ts) instead of pi-ai's
//   AssistantMessage — same block/field shapes, minus the request-metadata
//   fields (usage, provider, …) that only exist in-process in pi;
// - theme comes from ../theme.ts (fixed palette, same API);
// - claude-style layout (parity spec): text blocks carry a `●` gutter
//   overlaid on their first line, markdown wraps with no right margin
//   (withClaudeLayout, bottom of file), and outputPad defaults to 2 so
//   continuation/thinking/error lines sit at claude's 2-space indent;
// - no markdown transformers (pi's extension hook; we have no extensions)
//   and hence no `isStreaming` argument to updateContent;
// - no MouseRegion click-to-toggle on thinking runs (needs pi-tui ≥ 0.87;
//   deferred to a general click-to-expand pass).

import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { ANSI_STYLE } from "../../format/style.ts";
import { ASSISTANT_GLYPH } from "../../format/glyphs.ts";
import { getMarkdownTheme, theme } from "../theme.ts";
import type { RenderAssistant } from "../../format/render-types.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
  private contentContainer: Container;
  private hideThinkingBlock: boolean;
  private markdownTheme: MarkdownTheme;
  private hiddenThinkingLabel: string;
  private outputPad: number;
  private lastMessage?: RenderAssistant;
  private hasToolCalls = false;

  constructor(
    message?: RenderAssistant,
    hideThinkingBlock = false,
    markdownTheme: MarkdownTheme = getMarkdownTheme(),
    hiddenThinkingLabel = "Thinking...",
    outputPad = 2,
  ) {
    super();

    this.hideThinkingBlock = hideThinkingBlock;
    this.markdownTheme = markdownTheme;
    this.hiddenThinkingLabel = hiddenThinkingLabel;
    this.outputPad = outputPad;

    // Container for text/thinking content
    this.contentContainer = new Container();
    this.addChild(this.contentContainer);

    if (message) {
      this.updateContent(message);
    }
  }

  override invalidate(): void {
    super.invalidate();
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }

  setHideThinkingBlock(hide: boolean): void {
    this.hideThinkingBlock = hide;
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }

  setHiddenThinkingLabel(label: string): void {
    this.hiddenThinkingLabel = label;
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }

  setOutputPad(padding: number): void {
    this.outputPad = padding;
    if (this.lastMessage) {
      this.updateContent(this.lastMessage);
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.hasToolCalls || lines.length === 0) {
      return lines;
    }

    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] =
      OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    return lines;
  }

  updateContent(message: RenderAssistant): void {
    this.lastMessage = message;

    // Clear content container
    this.contentContainer.clear();

    const hasVisibleContent = message.content.some(
      (c) =>
        (c.type === "text" && c.text.trim()) ||
        (c.type === "thinking" && c.thinking.trim()),
    );

    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }

    // Render content in order
    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i];
      if (content.type === "text" && content.text.trim()) {
        // Assistant text messages with no background - trim the text
        // Set paddingY=0 to avoid extra spacing before tool executions
        this.contentContainer.addChild(
          withClaudeLayout(
            new Markdown(
              content.text.trim(),
              this.outputPad,
              0,
              this.markdownTheme,
            ),
            true,
          ),
        );
      } else if (content.type === "thinking") {
        const thinkingBlocks: string[] = [];
        for (; i < message.content.length; i++) {
          const thinkingContent = message.content[i];
          if (thinkingContent.type !== "thinking") {
            break;
          }
          const thinking = thinkingContent.thinking.trim();
          if (thinking) {
            thinkingBlocks.push(thinking);
          }
        }
        i--;

        if (thinkingBlocks.length === 0) {
          continue;
        }

        // Add spacing only when another visible assistant content block follows.
        // This avoids a superfluous blank line before separately-rendered tool execution blocks.
        const hasVisibleContentAfter = message.content
          .slice(i + 1)
          .some(
            (c) =>
              (c.type === "text" && c.text.trim()) ||
              (c.type === "thinking" && c.thinking.trim()),
          );

        if (this.hideThinkingBlock) {
          // Show one static label for each run of thinking blocks when hidden.
          this.contentContainer.addChild(
            new Text(
              theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
              this.outputPad,
              0,
            ),
          );
        } else {
          // Render each run of thinking blocks as one Markdown section.
          this.contentContainer.addChild(
            withClaudeLayout(
              new Markdown(
                thinkingBlocks.join("\n\n"),
                this.outputPad,
                0,
                this.markdownTheme,
                {
                  color: (text: string) => theme.fg("thinkingText", text),
                  italic: true,
                },
              ),
              false,
            ),
          );
        }
        if (hasVisibleContentAfter) {
          this.contentContainer.addChild(new Spacer(1));
        }
      }
    }

    // Check if incomplete/failed - show after partial content.
    // For aborted/error tool calls, tool execution components show the error.
    // Length stops can happen before a tool call is complete, so surface them here too.
    const hasToolCalls = message.content.some((c) => c.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(
        new Text(
          theme.fg("error", "Response was truncated before completion."),
          this.outputPad,
          0,
        ),
      );
    } else if (!hasToolCalls) {
      if (message.stopReason === "aborted") {
        const abortMessage =
          message.errorMessage && message.errorMessage !== "Request was aborted"
            ? message.errorMessage
            : "Operation aborted";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(
          new Text(theme.fg("error", abortMessage), this.outputPad, 0),
        );
      } else if (message.stopReason === "error") {
        const errorMsg = message.errorMessage || "Unknown error";
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(
          new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0),
        );
      }
    }
  }
}

/**
 * claude's markdown layout: a 2-column left gutter and NO right margin,
 * where pi's Markdown reserves paddingX on both sides. Rendering 2 wider
 * and stripping the trailing pad (always plain spaces appended after the
 * styled content) wraps content at claude's width while keeping visible
 * width ≤ width. With `gutter`, `● ` overlays the first line's two literal
 * padding spaces (outputPad = 2).
 */
function withClaudeLayout(markdown: Markdown, gutter: boolean): Component {
  return {
    render(width: number): string[] {
      const lines = markdown
        .render(width + 2)
        .map((line) => line.replace(/ +$/u, ""));
      if (gutter && lines.length > 0) {
        lines[0] = `${ANSI_STYLE.white(ASSISTANT_GLYPH)} ${lines[0]!.slice(2)}`;
      }
      return lines;
    },
    invalidate(): void {
      markdown.invalidate();
    },
  };
}
