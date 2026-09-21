import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { joinedPrompt } from "./joined-prompt.ts";

function prompt(
  content: string | ContentBlockParam[],
  overrides: Partial<SDKUserMessage> = {},
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...overrides,
  };
}

const image: ContentBlockParam = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AAAA" },
};

test("an empty run has no prompt", () => {
  assert.equal(joinedPrompt([]), undefined);
});

test("a single message is returned as is", () => {
  const only = prompt("one");
  assert.equal(joinedPrompt([only]), only);
});

test("all-string content joins with newlines under the last member's identity", () => {
  const joined = joinedPrompt([
    prompt("one", { uuid: "u1" as never, priority: "next" }),
    prompt("two", { uuid: "u2" as never, priority: "later" }),
  ]);
  assert.equal(joined?.uuid, "u2");
  assert.equal(joined?.priority, "later");
  assert.equal(joined?.message.content, "one\ntwo");
});

test("mixed content becomes one block array: strings lifted, arrays spliced", () => {
  const joined = joinedPrompt([
    prompt("one"),
    prompt([image, { type: "text", text: "two" }]),
    prompt("three"),
  ]);
  assert.deepEqual(joined?.message.content, [
    { type: "text", text: "one" },
    image,
    { type: "text", text: "two" },
    { type: "text", text: "three" },
  ]);
});
