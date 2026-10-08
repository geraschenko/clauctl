import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PermissionRequest } from "../protocol/index.ts";
import { initialAgentState } from "../agent-state/index.ts";
import { AnomalyRecorder } from "./anomaly-bundle.ts";
import { EventHub } from "./event-hub.ts";
import {
  PermissionBroker,
  validatePermissionResult,
} from "./permission-broker.ts";

function hub(): EventHub {
  return new EventHub({
    seed: initialAgentState(),
    deliver: () => {},
    tracker: () => undefined,
    log: () => {},
    anomalies: new AnomalyRecorder(mkdtempSync(join(tmpdir(), "broker-"))),
  });
}

const request = (toolUseId: string): PermissionRequest => ({
  toolUseId,
  toolName: "Bash",
  input: { command: "ls" },
  arrivedAt: 0,
  suggestions: [],
});

const CANCELLED = { behavior: "deny", message: "cancelled" };

test("an already-aborted signal settles immediately with no events", async () => {
  const events = hub();
  const permissionBroker = new PermissionBroker(events);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await permissionBroker.request(request("a"), controller.signal),
    CANCELLED,
  );
  assert.deepEqual(events.agentState.pendingPermissions, []);
  assert.throws(
    () => permissionBroker.respond("a", { behavior: "allow" }),
    /not pending/,
  );
});

test("respond settles once; a later abort for the same ask is a no-op", async () => {
  const events = hub();
  const permissionBroker = new PermissionBroker(events);
  const controller = new AbortController();
  const decided = permissionBroker.request(request("a"), controller.signal);
  assert.equal(events.agentState.pendingPermissions.length, 1);
  permissionBroker.respond("a", { behavior: "allow" });
  assert.deepEqual(await decided, { behavior: "allow" });
  assert.deepEqual(events.agentState.pendingPermissions, []);
  controller.abort();
  assert.deepEqual(events.agentState.pendingPermissions, []);
});

test("abort cancels the ask; respond afterwards is not pending", async () => {
  const events = hub();
  const permissionBroker = new PermissionBroker(events);
  const controller = new AbortController();
  const decided = permissionBroker.request(request("a"), controller.signal);
  controller.abort();
  assert.deepEqual(await decided, CANCELLED);
  assert.throws(
    () => permissionBroker.respond("a", { behavior: "allow" }),
    /not pending/,
  );
});

test("cancelAll settles every pending ask and is idempotent", async () => {
  const events = hub();
  const permissionBroker = new PermissionBroker(events);
  const signal = new AbortController().signal;
  const a = permissionBroker.request(request("a"), signal);
  const b = permissionBroker.request(request("b"), signal);
  permissionBroker.cancelAll();
  assert.deepEqual(await Promise.all([a, b]), [CANCELLED, CANCELLED]);
  assert.deepEqual(events.agentState.pendingPermissions, []);
  permissionBroker.cancelAll();
  assert.throws(
    () => permissionBroker.respond("a", { behavior: "allow" }),
    /not pending/,
  );
});

test("a duplicate toolUseId throws synchronously", () => {
  const permissionBroker = new PermissionBroker(hub());
  const signal = new AbortController().signal;
  void permissionBroker.request(request("a"), signal);
  assert.throws(
    () => permissionBroker.request(request("a"), signal),
    /already pending/,
  );
});

test("validatePermissionResult accepts the wire shapes and rejects the rest", () => {
  assert.deepEqual(validatePermissionResult({ behavior: "allow" }), {
    behavior: "allow",
  });
  assert.deepEqual(
    validatePermissionResult({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls" }],
          behavior: "allow",
          destination: "session",
        },
        { type: "addDirectories", directories: ["/x"], destination: "session" },
      ],
    }),
    {
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls" }],
          behavior: "allow",
          destination: "session",
        },
        { type: "addDirectories", directories: ["/x"], destination: "session" },
      ],
    },
  );
  assert.deepEqual(
    validatePermissionResult({
      behavior: "deny",
      message: "no",
      interrupt: true,
    }),
    { behavior: "deny", message: "no", interrupt: true },
  );
  for (const [value, pattern] of [
    ["allow", /must be an object/],
    [{ behavior: "ask" }, /allow or deny/],
    [{ behavior: "deny" }, /message must be a string/],
    [{ behavior: "allow", updatedInput: [] }, /updatedInput/],
    [{ behavior: "allow", updatedPermissions: {} }, /must be an array/],
    [
      {
        behavior: "allow",
        updatedPermissions: [{ type: "nope", destination: "session" }],
      },
      /not a PermissionUpdate type/,
    ],
    [
      {
        behavior: "allow",
        updatedPermissions: [
          { type: "addRules", rules: [{}], destination: "session" },
        ],
      },
      /rules must be/,
    ],
    [
      {
        behavior: "allow",
        updatedPermissions: [
          { type: "setMode", mode: 1, destination: "cliArg" },
        ],
      },
      /mode must be a string/,
    ],
  ] as const) {
    assert.throws(() => validatePermissionResult(value), pattern);
  }
});

/** Calls the broker's hook for `event` the way the CLI would. */
async function callFeedbackHook(
  permissionBroker: PermissionBroker,
  event: "PostToolUse" | "PostToolUseFailure",
  toolUseId: string,
): Promise<unknown> {
  const hook = permissionBroker.feedbackHooks[event]?.[0]?.hooks[0];
  assert.ok(hook !== undefined);
  const base = {
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
    tool_name: "Bash",
    tool_input: {},
    tool_use_id: toolUseId,
  };
  const input =
    event === "PostToolUse"
      ? { ...base, hook_event_name: event, tool_response: {} }
      : { ...base, hook_event_name: event, error: "failed" };
  return hook(input, toolUseId, { signal: new AbortController().signal });
}

const ALLOW = { behavior: "allow" } as const;
const context = (event: string, text: string): unknown => ({
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext: `The user approved this tool call and added: ${text}`,
  },
});

test("feedback is handed out once, by either hook, to its own tool use only", async () => {
  const permissionBroker = new PermissionBroker(hub());
  const signal = new AbortController().signal;
  const first = permissionBroker.request(request("t1"), signal);
  const second = permissionBroker.request(request("t2"), signal);
  permissionBroker.respond("t1", ALLOW, "one");
  permissionBroker.respond("t2", ALLOW, "two");
  assert.deepEqual(await first, ALLOW);
  await second;
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "other"),
    {},
  );
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUseFailure", "t1"),
    context("PostToolUseFailure", "one"),
  );
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "t1"),
    {},
  );
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "t2"),
    context("PostToolUse", "two"),
  );
});

test("a not-pending respond records no feedback; cancelAll drops it and later asks still work", async () => {
  const permissionBroker = new PermissionBroker(hub());
  const signal = new AbortController().signal;
  assert.throws(() => permissionBroker.respond("t1", ALLOW, "late"));
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "t1"),
    {},
  );
  const asked = permissionBroker.request(request("t2"), signal);
  permissionBroker.respond("t2", ALLOW, "dropped");
  await asked;
  permissionBroker.cancelAll();
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "t2"),
    {},
  );
  const again = permissionBroker.request(request("t3"), signal);
  permissionBroker.respond("t3", ALLOW, "kept");
  await again;
  assert.deepEqual(
    await callFeedbackHook(permissionBroker, "PostToolUse", "t3"),
    context("PostToolUse", "kept"),
  );
});
