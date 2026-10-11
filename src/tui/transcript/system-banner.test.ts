import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { systemBanner } from "./system-banner.ts";

type SystemMessage = Extract<SDKMessage, { type: "system" }>;

/** systemBanner reads only the fields each subtype's banner shows. */
const system = (fields: Record<string, unknown>): SystemMessage =>
  ({ type: "system", ...fields }) as unknown as SystemMessage;

test("a notification shows its text", () => {
  assert.deepEqual(
    systemBanner(system({ subtype: "notification", text: "hi" })),
    {
      text: "hi",
    },
  );
});

test("an informational message shows unless its level is info", () => {
  const at = (level: string): SystemMessage =>
    system({ subtype: "informational", level, content: "note" });
  assert.equal(systemBanner(at("info")), undefined);
  assert.deepEqual(systemBanner(at("warning")), { text: "note" });
});

test("a refusal joins its content, category, explanation and fallback", () => {
  assert.deepEqual(
    systemBanner(
      system({
        subtype: "model_refusal_fallback",
        content: "refused",
        api_refusal_category: "cyber",
        api_refusal_explanation: "why",
        fallback_model: "other",
      }),
    ),
    {
      text: "refused — category: cyber — why — falling back to other",
      color: "error",
    },
  );
  assert.deepEqual(
    systemBanner(
      system({
        subtype: "model_refusal_no_fallback",
        content: "refused",
        api_refusal_category: null,
      }),
    ),
    { text: "refused", color: "error" },
  );
});

test("other subtypes show nothing", () => {
  assert.equal(systemBanner(system({ subtype: "init" })), undefined);
});
