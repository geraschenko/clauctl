// Ported from pi coding-agent src/modes/interactive/components/assistant-message.ts @ 0.80.2-fork.2
//
// Differences from the pi original, kept minimal for mirror-diffing:
// - consumes RenderAssistant (render-types.ts) instead of pi-ai's
//   AssistantMessage — same block shapes, no usage/stopReason fields;
// - the stopReason aborted/error tail section is dropped (interrupt and
//   error rendering is driven by `result`/`interruptSent` events in
//   interactive-mode.ts, not by per-message stop reasons);
// - theme comes from ../theme.ts (fixed palette, same API).

// TDC: Let's make a skill similar in spirit to /home/anton/git/earendil-works/pi/.pi/skills/pi-tee-rebase/SKILL.md with instructions for how to update these ported files. I'd like if we have a generation script which copies them over and applies our little patch, or something like that. Perhaps we should exclude these files from treefmt so that we don't get spurious whitespace diffs that cause headaches when updating. Maybe this is overkill given the small number ported files, but I think we're going to end up with more as we add in things like slash command management and file autocompletion.

// TDC: We should consider using pi-ai's AssistantMessage (and other types) directly so that the diff here is even smaller. When pi runs with an Anthropic backend, it's not using the claude SDK, so pi-ai probably doesn't have exactly what we need, but we should have a look at /home/anton/git/earendil-works/pi/packages/ai/src/api/anthropic-messages.ts.

import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme.ts";
import type { RenderAssistant } from "../render-types.ts";

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
  private lastMessage?: RenderAssistant;
  private hasToolCalls = false;

  constructor(
    message?: RenderAssistant,
    hideThinkingBlock = false,
    markdownTheme: MarkdownTheme = getMarkdownTheme(),
    hiddenThinkingLabel = "Thinking...",
  ) {
    super();

    this.hideThinkingBlock = hideThinkingBlock;
    this.markdownTheme = markdownTheme;
    this.hiddenThinkingLabel = hiddenThinkingLabel;

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
          new Markdown(content.text.trim(), 1, 0, this.markdownTheme),
        );
      } else if (content.type === "thinking" && content.thinking.trim()) {
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
          // Show static thinking label when hidden
          this.contentContainer.addChild(
            new Text(
              theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
              1,
              0,
            ),
          );
          if (hasVisibleContentAfter) {
            this.contentContainer.addChild(new Spacer(1));
          }
        } else {
          // Thinking traces in thinkingText color, italic
          this.contentContainer.addChild(
            new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
              color: (text: string) => theme.fg("thinkingText", text),
              italic: true,
            }),
          );
          if (hasVisibleContentAfter) {
            this.contentContainer.addChild(new Spacer(1));
          }
        }
      }
    }

    this.hasToolCalls = message.content.some((c) => c.type === "toolCall");
  }
}
