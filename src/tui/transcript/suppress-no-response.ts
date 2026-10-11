import type { RenderAssistant } from "../../format/render-types.ts";

/** The CLI synthesizes an assistant "No response requested." after local
 *  commands; claude never shows it (observed on the /compact capture).
 *  Normalized to an empty message so nothing renders. */
export function suppressNoResponse(rendered: RenderAssistant): RenderAssistant {
  const suppress =
    rendered.content.length > 0 &&
    rendered.content.every((block) => block.type === "text") &&
    rendered.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim() === "No response requested.";
  return suppress ? { ...rendered, content: [] } : rendered;
}
