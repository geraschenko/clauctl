import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import type { SessionEntry } from "../../core/session/file.ts";
import { toApiMessages, type ApiConversionInputs } from "./to-api-messages.ts";

const MODEL = "claude-haiku-4-5-20251001";
const DEFAULT: ApiConversionInputs = {
  forceMidConversationSystem: false,
  model: MODEL,
};
const MID_CONVERSATION_SYSTEM: ApiConversionInputs = {
  forceMidConversationSystem: true,
  model: MODEL,
};

let counter = 0;
function uuid(): UUID {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}` as UUID;
}

function user(
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "user",
    uuid: uuid(),
    message: { role: "user", content },
    ...extra,
  };
}

function assistant(
  content: unknown[],
  options: { id?: string; model?: string } = {},
): SessionEntry {
  return {
    type: "assistant",
    uuid: uuid(),
    message: {
      role: "assistant",
      id: options.id ?? `msg_${counter}`,
      model: options.model ?? MODEL,
      content,
    },
  };
}

function attachment(payload: Record<string, unknown>): SessionEntry {
  return {
    type: "attachment",
    uuid: uuid(),
    attachment: payload,
    rendered: null,
  };
}

const reminder = (text: string) =>
  attachment({ type: "total_tokens_reminder", text });
const toolUse = { type: "tool_use", id: "toolu_1", name: "Read", input: {} };
const toolResult = {
  type: "tool_result",
  tool_use_id: "toolu_1",
  content: "ok",
};

test("native: attachment after a tool result folds into the tool_result's string content; a later prompt follows", () => {
  const entries = [
    user("read it"),
    assistant([toolUse]),
    user([toolResult]),
    reminder("t1"),
    user("next"),
  ];
  const { messages, contributions } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "read it" }] },
    { role: "assistant", content: [toolUse] },
    {
      role: "user",
      content: [
        {
          ...toolResult,
          content: "ok\n\n<system-reminder>\nt1\n</system-reminder>",
        },
        { type: "text", text: "next" },
      ],
    },
  ]);
  assert.deepEqual(contributions.get(entries[3]!.uuid!), {
    kind: "text",
    texts: ["<system-reminder>\nt1\n</system-reminder>"],
    renderedBy: "fallback",
  });
  assert.deepEqual(contributions.get(entries[4]!.uuid!), { kind: "message" });
});

test("native: attachment after a tool result with array content joins that array with a seam newline", () => {
  const arrayResult = {
    ...toolResult,
    content: [{ type: "text", text: "ok" }],
  };
  const { messages } = toApiMessages(
    [
      user("read it"),
      assistant([toolUse]),
      user([arrayResult]),
      reminder("t1"),
    ],
    DEFAULT,
  );
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      {
        ...toolResult,
        content: [
          { type: "text", text: "ok\n" },
          { type: "text", text: "<system-reminder>\nt1\n</system-reminder>" },
        ],
      },
    ],
  });
});

// The prompt merge joins the seam texts with a newline (`mergeUserContent`).
test("native: an attachment following a plain prompt is placed before the prompt", () => {
  const entries = [
    user("a"),
    assistant([{ type: "text", text: "b" }]),
    user("c"),
    reminder("t"),
  ];
  const { messages } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>\nt\n</system-reminder>\n" },
      { type: "text", text: "c" },
    ],
  });
});

test("native: a multi-text attachment after an assistant is one user message per text; later texts and the prompt join the last", () => {
  const entries = [
    user("a"),
    assistant([{ type: "text", text: "b" }]),
    {
      ...attachment({ type: "file", filename: "/r/n.txt" }),
      rendered: [
        {
          content:
            "<system-reminder>\nCalled the Read tool\n</system-reminder>",
        },
        { content: "<system-reminder>\nResult of Read\n</system-reminder>" },
      ],
    },
    reminder("t"),
    user("c"),
  ];
  const { messages } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(
    messages
      .slice(2)
      .map((message) =>
        message.content.map((block) => String(block.text).slice(0, 27)),
      ),
    [
      ["<system-reminder>\nCalled th"],
      ["<system-reminder>\nResult of", "<system-reminder>\nt\n</syste", "c"],
    ],
  );
});

test("snapshot texts go out as persisted; renders-nothing and skipped entries map to none", () => {
  const snapshot: SessionEntry = {
    ...attachment({ type: "total_tokens_reminder", text: "payload" }),
    rendered: [{ content: "<system-reminder>\nsnap\n</system-reminder>" }],
  };
  const retired = attachment({
    type: "todo_reminder",
    content: [],
    itemCount: 0,
  });
  const boundary: SessionEntry = {
    type: "system",
    subtype: "compact_boundary",
    uuid: uuid(),
  };
  const entries = [
    user("a"),
    assistant([{ type: "text", text: "b" }]),
    snapshot,
    retired,
    boundary,
  ];
  const { messages, contributions } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>\nsnap\n</system-reminder>" },
    ],
  });
  assert.deepEqual(contributions.get(retired.uuid!), {
    kind: "none",
    reason: "renders-nothing",
  });
  assert.deepEqual(contributions.get(boundary.uuid!), {
    kind: "none",
    reason: "skipped",
  });
});

test("mid-conversation system: attachments accumulate, wrapper stripped, into one system message flushed at the next assistant or at the end; one attachment's texts join by a newline, attachments by a blank line", () => {
  const entries = [
    user("a"),
    assistant([{ type: "text", text: "b" }]),
    {
      ...reminder("payload"),
      rendered: [
        { content: "<system-reminder>\nt1\n</system-reminder>" },
        { content: "<system-reminder>\nt1b\n</system-reminder>" },
      ],
    },
    reminder("t2"),
    assistant([{ type: "text", text: "c" }]),
    attachment({ type: "session_context", content: "never folded" }),
    reminder("t3"),
  ];
  const { messages } = toApiMessages(entries, MID_CONVERSATION_SYSTEM);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "system", content: [{ type: "text", text: "t1\nt1b\n\nt2" }] },
    { role: "assistant", content: [{ type: "text", text: "c" }] },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nnever folded\n</system-reminder>",
        },
      ],
    },
    { role: "system", content: [{ type: "text", text: "t3" }] },
  ]);
});

test("assistant entries sharing message.id regroup into one message; thinking-only groups drop", () => {
  const thinkingOnly = assistant(
    [{ type: "thinking", thinking: "hm", signature: "s" }],
    { id: "msg_x" },
  );
  const entries = [
    user("a"),
    assistant([{ type: "thinking", thinking: "hm", signature: "s" }], {
      id: "msg_same",
    }),
    assistant([{ type: "text", text: "b" }], { id: "msg_same" }),
    user("c"),
    thinkingOnly,
    user("d"),
    assistant([
      { type: "text", text: "e" },
      { type: "thinking", thinking: "trail", signature: "s" },
    ]),
  ];
  const { messages, contributions } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "a" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm", signature: "s" },
        { type: "text", text: "b" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "c\n" },
        { type: "text", text: "d" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "e" }] },
  ]);
  assert.deepEqual(contributions.get(thinkingOnly.uuid!), {
    kind: "none",
    reason: "thinking-only",
  });
});

test("parallel tool calls: tool_use entries sharing message.id regroup across their tool-result users; a prompt ends the group", () => {
  const toolUseB = { ...toolUse, id: "toolu_2" };
  const toolResultB = { ...toolResult, tool_use_id: "toolu_2" };
  const { messages } = toApiMessages(
    [
      user("go"),
      assistant([toolUse], { id: "msg_batch" }),
      user([toolResult]),
      reminder("t1"),
      assistant([toolUseB], { id: "msg_batch" }),
      user([toolResultB]),
      assistant([{ type: "text", text: "mid" }], { id: "msg_other" }),
      user("again"),
      assistant([{ type: "text", text: "late" }], { id: "msg_batch" }),
    ],
    MID_CONVERSATION_SYSTEM,
  );
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [toolUse, toolUseB] },
    { role: "user", content: [toolResult, toolResultB] },
    { role: "system", content: [{ type: "text", text: "t1" }] },
    { role: "assistant", content: [{ type: "text", text: "mid" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
    { role: "assistant", content: [{ type: "text", text: "late" }] },
  ]);
});

test("mid-conversation system: a human-turn steer is a pending user with the wrapper stripped", () => {
  const steer = attachment({
    type: "queued_command",
    prompt: "look",
    commandMode: "prompt",
    humanTurn: true,
  });
  const { messages, contributions } = toApiMessages(
    [
      user("go"),
      assistant([toolUse]),
      user([toolResult]),
      steer,
      user("Continue from where you left off.", { isMeta: true }),
      assistant([{ type: "text", text: "done" }]),
    ],
    MID_CONVERSATION_SYSTEM,
  );
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      toolResult,
      { type: "text", text: "look\n" },
      { type: "text", text: "Continue from where you left off." },
    ],
  });
  assert.equal(contributions.get(steer.uuid!)?.kind, "text");
});

test("foreign-model thinking is removed when the model is set; fillers replace empty content; whitespace-only assistants drop", () => {
  const blank = assistant([{ type: "text", text: " \n" }]);
  const entries = [
    user("a"),
    assistant(
      [
        { type: "thinking", thinking: "x", signature: "s" },
        { type: "text", text: "b" },
      ],
      {
        model: "claude-opus-4-1",
      },
    ),
    user(""),
    assistant([]),
    user("c"),
    blank,
  ];
  const { messages, contributions } = toApiMessages(entries, DEFAULT);
  assert.equal(messages.length, 5);
  assert.deepEqual(contributions.get(blank.uuid!), {
    kind: "none",
    reason: "empty-content",
  });
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "b" }],
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "text", text: "" }],
  });
  assert.deepEqual(messages[3], {
    role: "assistant",
    content: [{ type: "text", text: "(no content)" }],
  });
  // No model given: the last assistant's model is the default, so the
  // Opus thinking is still foreign; naming Opus keeps it.
  assert.equal(
    toApiMessages(entries, { forceMidConversationSystem: false }).messages[1]!
      .content.length,
    1,
  );
  assert.equal(
    toApiMessages(entries, {
      forceMidConversationSystem: false,
      model: "claude-opus-4-1",
    }).messages[1]!.content.length,
    2,
  );
});

test("local_command output merges into the preceding user unwrapped; a virtual one and empty-array user content are dropped", () => {
  const command: SessionEntry = {
    type: "system",
    subtype: "local_command",
    content: "<local-command-stdout>ok</local-command-stdout>",
    uuid: uuid(),
  };
  const virtualCommand: SessionEntry = {
    ...command,
    uuid: uuid(),
    isVirtual: true,
  };
  const empty = user([]);
  const entries = [
    user("a"),
    assistant([{ type: "text", text: "b" }]),
    user("c"),
    command,
    virtualCommand,
    empty,
  ];
  const { messages, contributions } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "text", text: "c\n" },
      { type: "text", text: "<local-command-stdout>ok</local-command-stdout>" },
    ],
  });
  assert.deepEqual(contributions.get(virtualCommand.uuid!), {
    kind: "none",
    reason: "skipped",
  });
  assert.deepEqual(contributions.get(empty.uuid!), {
    kind: "none",
    reason: "empty-content",
  });
});

test("assistant empty texts are removed; one between two thinking blocks becomes the spacer", () => {
  const thinking = { type: "thinking", thinking: "t", signature: "s" };
  const entries = [
    user("a"),
    assistant([
      { type: "text", text: "" },
      thinking,
      { type: "text", text: "" },
      { type: "text", text: "" },
      thinking,
      { type: "text", text: "" },
      { type: "text", text: "b" },
    ]),
    user("c"),
  ];
  const { messages } = toApiMessages(entries, DEFAULT);
  assert.deepEqual(messages[1]!.content, [
    thinking,
    { type: "text", text: "[Empty text removed]" },
    thinking,
    { type: "text", text: "b" },
  ]);
});

test("tail reminder records re-send their text; the same record before any later entry renders nothing", () => {
  const sent = (type: string, text: string) =>
    attachment({ type, text, clearAt: "next_user_message" });
  const tail = [
    user("go"),
    assistant([toolUse]),
    user([toolResult]),
    sent("batching_reminder_sent", "old"),
    sent("batching_reminder_sent", "batch"),
    sent("secondary_reminder_sent", "second"),
    attachment({ type: "batching_reminder_sent", text: "no clearAt" }),
  ];
  const { messages, contributions } = toApiMessages(tail, DEFAULT);
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [{ ...toolResult, content: "ok\n\nbatch\n\nsecond" }],
  });
  assert.deepEqual(contributions.get(tail[3]!.uuid!), {
    kind: "none",
    reason: "renders-nothing",
  });
  assert.deepEqual(contributions.get(tail[4]!.uuid!), {
    kind: "text",
    texts: ["batch"],
    renderedBy: "snapshot",
  });
  assert.deepEqual(contributions.get(tail[6]!.uuid!), {
    kind: "none",
    reason: "renders-nothing",
  });
  // A later non-attachment entry ends the tail: the record is cleared.
  const cleared = [
    ...tail.slice(0, 5),
    assistant([{ type: "text", text: "hi" }]),
  ];
  const after = toApiMessages(cleared, DEFAULT);
  assert.deepEqual(after.messages[2], {
    role: "user",
    content: [toolResult],
  });
  assert.deepEqual(after.contributions.get(cleared[4]!.uuid!), {
    kind: "none",
    reason: "renders-nothing",
  });
});
