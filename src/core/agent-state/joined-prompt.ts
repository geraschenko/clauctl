import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

/** The one message claude writes for a merged run: the last member
 *  (uuid, origin, priority, shouldQuery) with the run's content joined the
 *  way claude joins it — all strings → `\n`-joined; otherwise one block
 *  array, strings lifted to text blocks, arrays spliced. Undefined for an
 *  empty run (an observer that held none of the run's messages). */
export function joinedPrompt(
  messages: readonly SDKUserMessage[],
): SDKUserMessage | undefined {
  const last = messages.at(-1);
  if (last === undefined || messages.length === 1) return last;
  const contents = messages.map((message) => message.message.content);
  const content: string | ContentBlockParam[] = contents.every(
    (part) => typeof part === "string",
  )
    ? contents.join("\n")
    : contents.flatMap((part) =>
        typeof part === "string" ? [{ type: "text", text: part }] : part,
      );
  return { ...last, message: { ...last.message, content } };
}
