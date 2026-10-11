import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Banner } from "./banner.ts";

/** The banner a system message shows: notification text, a non-info
 *  informational message, or a model refusal; undefined otherwise. */
export function systemBanner(
  message: Extract<SDKMessage, { type: "system" }>,
): Banner | undefined {
  if (message.subtype === "notification") {
    return { text: message.text };
  }
  if (message.subtype === "informational") {
    return message.level === "info" ? undefined : { text: message.content };
  }
  if (
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
    return { text: parts.join(" — "), color: "error" };
  }
  return undefined;
}
