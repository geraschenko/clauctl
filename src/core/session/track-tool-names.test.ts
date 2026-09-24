import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "./file.ts";
import { trackToolNames } from "./track-tool-names.ts";

test("trackToolNames records well-formed tool_use blocks only", () => {
  const call: SessionEntry = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "tool_use", id: 7, name: "Bad", input: {} },
        { type: "text", text: "hi" },
      ],
    },
  };
  const toolNames = new Map<string, string>();
  trackToolNames(call, toolNames);
  trackToolNames({ type: "user", message: { content: "x" } }, toolNames);
  assert.deepEqual([...toolNames], [["t1", "Bash"]]);
});
