import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseSetContextRequest } from "./messages.ts";

test("parseSetContextRequest accepts boundary mode with all fields", () => {
  const uuids = [randomUUID(), randomUUID()];
  assert.deepEqual(
    parseSetContextRequest({
      type: "set-context",
      id: "r1",
      uuids,
      summaryText: "s",
    }),
    { type: "set-context", uuids, summaryText: "s" },
  );
});

test("parseSetContextRequest accepts bare uuids", () => {
  const uuids = [randomUUID()];
  assert.deepEqual(parseSetContextRequest({ uuids }), {
    type: "set-context",
    uuids,
  });
});

test("parseSetContextRequest accepts rewind mode (raw and viaBoundary refs)", () => {
  const uuid = randomUUID();
  const viaBoundary = randomUUID();
  assert.deepEqual(parseSetContextRequest({ rewindTo: { uuid } }), {
    type: "set-context",
    rewindTo: { uuid },
  });
  assert.deepEqual(
    parseSetContextRequest({ rewindTo: { uuid, viaBoundary } }),
    { type: "set-context", rewindTo: { uuid, viaBoundary } },
  );
});

test("parseSetContextRequest accepts an empty uuids array", () => {
  assert.deepEqual(parseSetContextRequest({ uuids: [] }), {
    type: "set-context",
    uuids: [],
  });
});

test("parseSetContextRequest rejects both and neither mode", () => {
  assert.throws(
    () =>
      parseSetContextRequest({
        uuids: [randomUUID()],
        rewindTo: { uuid: randomUUID() },
      }),
    /mutually exclusive/,
  );
  assert.throws(() => parseSetContextRequest({}), /exactly one of/);
});

test("parseSetContextRequest rejects malformed fields", () => {
  assert.throws(
    () => parseSetContextRequest({ uuids: "not-an-array" }),
    /array/,
  );
  assert.throws(
    () => parseSetContextRequest({ uuids: ["not-a-uuid"] }),
    /must be a uuid/,
  );
  assert.throws(
    () => parseSetContextRequest({ rewindTo: "nope" }),
    /must be a \{uuid, viaBoundary\?\} object/,
  );
  assert.throws(
    () => parseSetContextRequest({ rewindTo: {} }),
    /rewindTo.uuid must be a uuid/,
  );
  assert.throws(
    () =>
      parseSetContextRequest({
        rewindTo: { uuid: randomUUID(), viaBoundary: "nope" },
      }),
    /rewindTo.viaBoundary must be a uuid/,
  );
  assert.throws(
    () => parseSetContextRequest({ uuids: [randomUUID()], summaryText: "" }),
    /non-empty string/,
  );
  assert.throws(
    () => parseSetContextRequest({ uuids: [randomUUID()], summaryText: 3 }),
    /non-empty string/,
  );
  assert.throws(
    () =>
      parseSetContextRequest({ uuids: [randomUUID()], append: [randomUUID()] }),
    /append requires rewindTo/,
  );
  assert.throws(
    () =>
      parseSetContextRequest({ rewindTo: { uuid: randomUUID() }, append: "x" }),
    /append must be an array/,
  );
  assert.throws(
    () =>
      parseSetContextRequest({
        rewindTo: { uuid: randomUUID() },
        summaryText: "s",
      }),
    /mutually exclusive/,
  );
});
