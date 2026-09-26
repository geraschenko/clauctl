import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import {
  compareApiMessages,
  type CapturedApiMessages,
} from "./compare-api-messages.ts";
import type {
  ApiContentBlock,
  ApiConversion,
  ApiMessage,
  WireContribution,
} from "./to-api-messages.ts";

const text = (value: string): ApiContentBlock => ({
  type: "text",
  text: value,
});
const user = (...content: ApiContentBlock[]): ApiMessage => ({
  role: "user",
  content,
});
const assistant = (...content: ApiContentBlock[]): ApiMessage => ({
  role: "assistant",
  content,
});
const toolUse = (id: string): ApiContentBlock => ({
  type: "tool_use",
  id,
  name: "Read",
  input: {},
});
const toolResult = (id: string): ApiContentBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content: "ok",
});
const REMINDER = text("<system-reminder>\n# Environment\n</system-reminder>");

/** A conversion whose text contributions are attributed to the messages
 *  they sit in: `contributions[messageIndex]`. */
function conversion(
  messages: ApiMessage[],
  contributions: Record<number, WireContribution[]> = {},
): ApiConversion {
  const byUuid = new Map<UUID, WireContribution>();
  const entryUuidsByMessage = messages.map((): UUID[] => []);
  for (const [messageIndex, list] of Object.entries(contributions)) {
    for (const contribution of list) {
      const uuid =
        `00000000-0000-4000-8000-${String(byUuid.size).padStart(12, "0")}` as UUID;
      byUuid.set(uuid, contribution);
      entryUuidsByMessage[Number(messageIndex)]!.push(uuid);
    }
  }
  return { messages, contributions: byUuid, entryUuidsByMessage };
}

const externalState = (...texts: string[]): WireContribution => ({
  kind: "text",
  texts,
  renderedBy: "external-state",
});

/** A capture of a wire whose history is `messages`; as on the wire, a
 *  trailing user message is merged into the prompt turn, its blocks
 *  preceding `requestTimeBlocks`. */
function capture(
  messages: ApiMessage[],
  requestTimeBlocks: ApiContentBlock[] = [],
  systemTail?: string,
): CapturedApiMessages {
  const trailingUser = messages.at(-1)?.role === "user";
  return {
    apiMessages: trailingUser ? messages.slice(0, -1) : messages,
    promptTurnLeadingBlocks: [
      ...(trailingUser ? messages.at(-1)!.content : []),
      ...requestTimeBlocks,
    ],
    systemTail,
  };
}

test("identical messages: nothing failing; the whole prompt turn is request-time", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const comparison = compareApiMessages(
    capture(history, [REMINDER]),
    conversion(history),
  );
  assert.deepEqual(comparison, {
    tolerated: [],
    failing: [],
    requestTime: { promptTurnBlocks: [REMINDER], systemText: undefined },
  });
});

test("prefix rule: the trailing user is a block-prefix of the prompt turn; the system text a prefix of the tail", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const comparison = compareApiMessages(
    capture(
      history,
      [text("<system-reminder>\natt\n</system-reminder>"), REMINDER],
      "mem\n\natt\n\n# Environment",
    ),
    conversion([
      ...history,
      user(text("<system-reminder>\natt\n</system-reminder>")),
      { role: "system", content: [text("mem\n\natt")] },
    ]),
  );
  assert.deepEqual(comparison.failing, []);
  assert.deepEqual(comparison.requestTime, {
    promptTurnBlocks: [REMINDER],
    systemText: "# Environment",
  });
});

test("a persisted block landing after a request-time one breaks the prefix and fails", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const comparison = compareApiMessages(
    capture(history, [REMINDER, text("att")]),
    conversion([...history, user(text("att"))]),
  );
  assert.deepEqual(comparison.failing, [
    {
      path: "messages[2].content[0]",
      captured: REMINDER,
      synthesized: text("att"),
    },
  ]);
});

test("a system text that is a prefix but not followed by the separator fails", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const comparison = compareApiMessages(
    capture(history, [], "attachment\n\nrest"),
    conversion([...history, { role: "system", content: [text("attach")] }]),
  );
  assert.equal(comparison.failing.length, 1);
  assert.equal(comparison.failing[0]!.path, "messages[2].content[0]");
});

test("parallel-order: tool_use and tool_result permutations are tolerated and reported; other blocks stay put", () => {
  const comparison = compareApiMessages(
    capture([
      user(text("a")),
      assistant(text("t"), toolUse("b"), toolUse("a")),
      user(toolResult("b"), toolResult("a"), text("r")),
    ]),
    conversion([
      user(text("a")),
      assistant(text("t"), toolUse("a"), toolUse("b")),
      user(toolResult("a"), toolResult("b"), text("r")),
    ]),
  );
  assert.deepEqual(comparison.failing, []);
  assert.deepEqual(
    comparison.tolerated.map((difference) => [
      difference.tolerance,
      difference.path,
    ]),
    [
      ["parallel-order", "messages[1].content"],
      ["parallel-order", "messages[2].content"],
    ],
  );
});

test("external-state-text excuses only the contribution's span of a block; the surrounding text must agree", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const delta = "The following tools are available: x";
  const excused = compareApiMessages(
    capture([
      ...history,
      user(text("env\n\nThe following tools are available: y\n\nend")),
    ]),
    conversion([...history, user(text(`env\n\n${delta}\n\nend`))], {
      2: [externalState(delta)],
    }),
  );
  assert.deepEqual(excused.failing, []);
  assert.deepEqual(excused.tolerated, [
    {
      tolerance: "external-state-text",
      path: "messages[2].content[0]",
      captured: text("The following tools are available: y"),
      synthesized: text(delta),
    },
  ]);
  const surroundingsDiffer = compareApiMessages(
    capture([...history, user(text(`env\n${delta}\n\nend`))]),
    conversion([...history, user(text(`env\n\n${delta}\n\nend`))], {
      2: [externalState(delta)],
    }),
  );
  assert.deepEqual(surroundingsDiffer.tolerated, []);
  assert.equal(surroundingsDiffer.failing.length, 1);
});

test("a multi-text contribution is excused text by text, both texts at once; a changed join shifts into an adjacent span and is reported", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const texts = ["Called the Read tool", "Result: guess"];
  const synthesized = [
    ...history,
    {
      role: "system" as const,
      content: [text("m\n\nCalled the Read tool\nResult: guess")],
    },
  ];
  const joined = compareApiMessages(
    capture([
      ...history,
      {
        role: "system",
        content: [text("m\n\nCalled the Read tool\nResult: real")],
      },
    ]),
    conversion(synthesized, { 2: [externalState(...texts)] }),
  );
  assert.deepEqual(joined.failing, []);
  assert.deepEqual(
    joined.tolerated.map((difference) => difference.captured),
    [text("Result: real")],
  );
  const alteredJoin = compareApiMessages(
    capture([
      ...history,
      {
        role: "system",
        content: [text("m\n\nCalled the Read tool\n\nResult: guess")],
      },
    ]),
    conversion(synthesized, { 2: [externalState(...texts)] }),
  );
  // The join is a literal between two wildcards; the extra newline is
  // taken up by the second span (visible in `tolerated`, not failing).
  assert.deepEqual(alteredJoin.failing, []);
  assert.deepEqual(
    alteredJoin.tolerated.map((difference) => difference.captured),
    [text("\nResult: guess")],
  );
  const bothChanged = compareApiMessages(
    capture([
      ...history,
      {
        role: "system",
        content: [text("m\n\nCalled the Grep tool\nResult: real")],
      },
    ]),
    conversion(synthesized, { 2: [externalState(...texts)] }),
  );
  assert.deepEqual(bothChanged.failing, []);
  assert.deepEqual(
    bothChanged.tolerated.map((difference) => difference.captured),
    [text("Called the Grep tool"), text("Result: real")],
  );
});

test("external-state-text is attributed by provenance: the same text in another message, or twice in its own, is not excused", () => {
  const delta = "The following tools are available: x";
  const elsewhere = compareApiMessages(
    capture([user(text("y")), assistant(text("b")), user(text(delta))]),
    conversion([user(text(delta)), assistant(text("b")), user(text(delta))], {
      2: [externalState(delta)],
    }),
  );
  assert.deepEqual(
    elsewhere.failing.map((difference) => difference.path),
    ["messages[0].content[0]"],
  );
  const twice = compareApiMessages(
    capture([
      user(text("a")),
      assistant(text("b")),
      user(text("y"), text(delta)),
    ]),
    conversion(
      [user(text("a")), assistant(text("b")), user(text(delta), text(delta))],
      { 2: [externalState(delta)] },
    ),
  );
  assert.equal(twice.tolerated.length, 0);
  assert.equal(twice.failing.length, 1);
  // A whitespace-only text folds to nothing: never located, never looped.
  const blank = compareApiMessages(
    capture([user(text("a")), assistant(toolUse("t")), user(toolResult("t"))]),
    conversion(
      [user(text("a")), assistant(toolUse("t")), user(toolResult("t"))],
      { 2: [externalState(" \n")] },
    ),
  );
  assert.deepEqual(blank, {
    tolerated: [],
    failing: [],
    requestTime: { promptTurnBlocks: [], systemText: undefined },
  });
});

test("external-state-text reaches text folded into a tool_result's string and array content", () => {
  const delta = "The following tools are available: x";
  const history = [user(text("a")), assistant(toolUse("t"))];
  const folded = compareApiMessages(
    capture([
      ...history,
      user({ ...toolResult("t"), content: `ok\n\n${delta.replace("x", "y")}` }),
    ]),
    conversion(
      [...history, user({ ...toolResult("t"), content: `ok\n\n${delta}` })],
      { 2: [externalState(`${delta}\n`)] },
    ),
  );
  assert.deepEqual(folded.failing, []);
  assert.deepEqual(
    folded.tolerated.map((difference) => difference.path),
    ["messages[2].content[0]"],
  );
  const arrayContent = (text: string) => ({
    ...toolResult("t"),
    content: [
      { type: "text", text: "ok\n" },
      { type: "text", text },
    ],
  });
  const parts = compareApiMessages(
    capture([...history, user(arrayContent(delta.replace("x", "y")))]),
    conversion([...history, user(arrayContent(delta))], {
      2: [externalState(delta)],
    }),
  );
  assert.deepEqual(parts.failing, []);
  assert.deepEqual(
    parts.tolerated.map((difference) => difference.path),
    ["messages[2].content[0].content[1]"],
  );
});

test("system tail: an external-state text is a wildcard in the prefix match; the request-time boundary survives; a trailing wildcard is undecidable", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const delta = "The following tools are available: x";
  const bounded = compareApiMessages(
    capture(history, [], `${delta.replace("x", "y")}\n\nmem\n\n# Environment`),
    conversion(
      [...history, { role: "system", content: [text(`${delta}\n\nmem`)] }],
      { 2: [externalState(delta)] },
    ),
  );
  assert.deepEqual(bounded.failing, []);
  assert.equal(bounded.requestTime.systemText, "# Environment");
  assert.deepEqual(
    bounded.tolerated.map((difference) => difference.captured),
    [text(delta.replace("x", "y"))],
  );
  const trailing = compareApiMessages(
    capture(history, [], `mem\n\n${delta}\n\n# Environment`),
    conversion(
      [...history, { role: "system", content: [text(`mem\n\n${delta}`)] }],
      { 2: [externalState(delta)] },
    ),
  );
  assert.equal(trailing.failing.length, 1);
  assert.equal(trailing.failing[0]!.path, "messages[2].content[0]");
  assert.equal(
    trailing.requestTime.systemText,
    `mem\n\n${delta}\n\n# Environment`,
  );
});

test("tolerances compose: a permuted tool_use next to an external-state text in one message", () => {
  const delta = "The following tools are available: x";
  const comparison = compareApiMessages(
    capture([
      user(text("a")),
      assistant(toolUse("b"), toolUse("a")),
      user(
        toolResult("a"),
        toolResult("b"),
        text(
          "<system-reminder>\nThe following tools are available: y\n</system-reminder>",
        ),
      ),
    ]),
    conversion(
      [
        user(text("a")),
        assistant(toolUse("a"), toolUse("b")),
        user(
          toolResult("a"),
          toolResult("b"),
          text(`<system-reminder>\n${delta}\n</system-reminder>`),
        ),
      ],
      { 2: [externalState(`<system-reminder>\n${delta}\n</system-reminder>`)] },
    ),
  );
  assert.deepEqual(comparison.failing, []);
  assert.deepEqual(
    comparison.tolerated.map((difference) => difference.tolerance),
    ["parallel-order", "external-state-text"],
  );
});

test("empty-system-message: a captured system message with no content is dropped; a non-empty extra one fails", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const empty = compareApiMessages(
    capture([
      user(text("a")),
      { role: "system", content: [] },
      assistant(text("b")),
    ]),
    conversion(history),
  );
  assert.deepEqual(empty.failing, []);
  assert.deepEqual(empty.tolerated, [
    {
      tolerance: "empty-system-message",
      path: "messages[1]",
      captured: { role: "system", content: [] },
      synthesized: undefined,
    },
  ]);
  const extra = compareApiMessages(
    capture([
      user(text("a")),
      { role: "system", content: [text("notice")] },
      assistant(text("b")),
    ]),
    conversion(history),
  );
  assert.equal(extra.failing.length, 2);
  assert.equal(extra.failing[0]!.path, "messages[1].role");
});

test("negative: a dropped user message, a reordered text block and an altered snapshot text fail", () => {
  const snapshot = text("<system-reminder>\nsnap\n</system-reminder>");
  const dropped = compareApiMessages(
    capture([
      user(text("a")),
      assistant(text("b")),
      user(text("c")),
      assistant(text("d")),
    ]),
    conversion([user(text("a")), assistant(text("b")), assistant(text("d"))]),
  );
  assert.deepEqual(
    dropped.failing.map((difference) => difference.path),
    ["messages[2].role", "messages[3]"],
  );
  const reordered = compareApiMessages(
    capture([
      user(text("a")),
      assistant(text("b")),
      user(toolResult("x"), snapshot, text("p")),
    ]),
    conversion([
      user(text("a")),
      assistant(text("b")),
      user(toolResult("x"), text("p"), snapshot),
    ]),
  );
  assert.deepEqual(
    reordered.failing.map((difference) => difference.path),
    ["messages[2].content[1]", "messages[2].content[2]"],
  );
  const altered = compareApiMessages(
    capture([
      user(text("a")),
      assistant(text("b")),
      user(toolResult("x"), snapshot),
    ]),
    conversion(
      [
        user(text("a")),
        assistant(text("b")),
        user(
          toolResult("x"),
          text("<system-reminder>\nsnip\n</system-reminder>"),
        ),
      ],
      {
        2: [
          {
            kind: "text",
            texts: ["<system-reminder>\nsnip\n</system-reminder>"],
            renderedBy: "snapshot",
          },
        ],
      },
    ),
  );
  assert.deepEqual(
    altered.failing.map((difference) => difference.path),
    ["messages[2].content[1]"],
  );
  assert.deepEqual(altered.tolerated, []);
});

test("a synthesized message beyond the captured tail fails", () => {
  const history = [user(text("a")), assistant(text("b"))];
  const comparison = compareApiMessages(
    capture(history),
    conversion([...history, user(text("att")), assistant(text("extra"))]),
  );
  assert.deepEqual(comparison.failing, [
    {
      path: "messages[2].content[0]",
      captured: undefined,
      synthesized: text("att"),
    },
    {
      path: "messages[3]",
      captured: undefined,
      synthesized: assistant(text("extra")),
    },
  ]);
});
