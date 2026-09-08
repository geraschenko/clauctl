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
