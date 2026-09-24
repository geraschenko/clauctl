import type {
  NonNullableUsage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The API's usage object with nulls removed, as NonNullableUsage promises:
 * the numeric token counters are defaulted to 0 (arithmetic over them never
 * sees a hole); other null fields are dropped rather than given made-up
 * non-null values. Also used to coerce usage objects read back from session
 * file entries (tree/context-tree.ts).
 */
export function toNonNullableUsage(
  usage: SDKAssistantMessage["message"]["usage"],
): NonNullableUsage {
  return {
    ...Object.fromEntries(
      Object.entries(usage).filter(([, value]) => value !== null),
    ),
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  } as NonNullableUsage;
}
