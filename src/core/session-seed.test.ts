import assert from "node:assert/strict";
import { randomUUID, type UUID } from "node:crypto";
import { test } from "node:test";
import { seedFromEntries } from "./session-seed.ts";
import type { SessionEntry } from "./session-file.ts";

const uuid = (): UUID => randomUUID();

/** onInvalid sink for well-formed files: any diagnostic is a test failure. */
const failOnInvalid = (message: string): never => {
  throw new Error(`unexpected onInvalid: ${message}`);
};

// --- entry builders ------------------------------------------------------------

function userEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "user",
    sessionId,
    message: { role: "user", content: "hi" },
  };
}

function assistantEntry(
  parentUuid: UUID | null,
  sessionId: UUID,
): SessionEntry & { uuid: UUID } {
  return {
    uuid: uuid(),
    parentUuid,
    type: "assistant",
    sessionId,
    message: {
      role: "assistant",
      id: `msg_${randomUUID().slice(0, 8)}`,
      content: [{ type: "text", text: "ok" }],
    },
  };
}

function boundaryEntry(params: {
  sessionId: UUID;
  uuids: UUID[];
  anchor: "own" | UUID;
  logicalParentUuid?: UUID;
}): SessionEntry & { uuid: UUID } {
  const boundaryUuid = uuid();
  return {
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: params.logicalParentUuid ?? null,
    type: "system",
    subtype: "compact_boundary",
    sessionId: params.sessionId,
    compactMetadata: {
      trigger: "manual",
      preservedMessages: {
        anchorUuid: params.anchor === "own" ? boundaryUuid : params.anchor,
        uuids: params.uuids,
        allUuids: params.uuids,
      },
    },
  };
}

// --- seedFromEntries -------------------------------------------------------

test("seedFromEntries on an empty file yields no values", () => {
  assert.deepEqual(seedFromEntries([], failOnInvalid), {});
});

test("seedFromEntries derives every field from a linear session", () => {
  const sid = uuid();
  const u1 = { ...userEntry(null, sid), version: "2.1.190" };
  const a1 = {
    ...assistantEntry(u1.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-old",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [],
    },
  };
  const mode = {
    type: "permission-mode",
    permissionMode: "plan",
    sessionId: sid,
  };
  const u2 = { ...userEntry(a1.uuid, sid), version: "2.1.211" };
  const a2 = {
    ...assistantEntry(u2.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-new",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 30,
      },
      content: [],
    },
  };
  const seed = seedFromEntries([u1, a1, mode, u2, a2], failOnInvalid);
  assert.equal(seed.model, "claude-new");
  assert.equal(seed.claudeCodeVersion, "2.1.211");
  assert.equal(seed.permissionMode, "plan");
  assert.deepEqual(seed.leaf, { uuid: a2.uuid });
  // Null token counters are coerced to 0.
  assert.deepEqual(seed.lastUsage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 30,
  });
});

test("seedFromEntries reads usage/model from the loaded context, not abandoned branches", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = {
    ...assistantEntry(u1.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-kept",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [],
    },
  };
  const u2 = userEntry(a1.uuid, sid);
  const a2 = {
    ...assistantEntry(u2.uuid, sid),
    message: {
      role: "assistant",
      model: "claude-summarized-away",
      usage: { input_tokens: 100, output_tokens: 200 },
      content: [],
    },
  };
  // The boundary preserves only the first turn; a2 is off the context.
  const boundary = boundaryEntry({
    sessionId: sid,
    uuids: [u1.uuid, a1.uuid],
    anchor: "own",
  });
  const seed = seedFromEntries([u1, a1, u2, a2, boundary], failOnInvalid);
  assert.equal(seed.model, "claude-kept");
  assert.equal(seed.lastUsage?.input_tokens, 1);
  // The context tip is a1's relinked occurrence under the boundary.
  assert.deepEqual(seed.leaf, {
    uuid: a1.uuid,
    viaBoundary: boundary.uuid,
  });
});

test("seedFromEntries leaf skips meta and sidechain entries", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  const meta = { ...userEntry(a1.uuid, sid), isMeta: true };
  const seed = seedFromEntries([u1, a1, meta], failOnInvalid);
  assert.deepEqual(seed.leaf, { uuid: a1.uuid });
});

test("seedFromEntries: a trailing system entry does not become the leaf", () => {
  const sid = uuid();
  const u1 = userEntry(null, sid);
  const a1 = assistantEntry(u1.uuid, sid);
  // Leaf selection (loader step 6) walks up to the nearest user/assistant,
  // so a trailing turn_duration never seeds a leaf the fold would not have
  // produced.
  const duration: SessionEntry = {
    uuid: uuid(),
    parentUuid: a1.uuid,
    type: "system",
    subtype: "turn_duration",
    sessionId: sid,
  };
  const seed = seedFromEntries([u1, a1, duration], failOnInvalid);
  assert.deepEqual(seed.leaf, { uuid: a1.uuid });
});
