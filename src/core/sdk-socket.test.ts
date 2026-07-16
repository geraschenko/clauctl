import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseSetContextRequest } from "./sdk-socket.ts";

test("parseSetContextRequest accepts boundary mode with all fields", () => {
  const uuids = [randomUUID(), randomUUID()];
  assert.deepEqual(
    parseSetContextRequest({
      type: "set-context",
      id: "r1",
      uuids,
      summaryText: "s",
      anchor: "boundary",
    }),
    { type: "set-context", uuids, summaryText: "s", anchor: "boundary" },
  );
});

test("parseSetContextRequest accepts bare uuids", () => {
  const uuids = [randomUUID()];
  assert.deepEqual(parseSetContextRequest({ uuids }), {
    type: "set-context",
    uuids,
  });
});

test("parseSetContextRequest accepts rewind mode", () => {
  const rewindTo = randomUUID();
  assert.deepEqual(parseSetContextRequest({ rewindTo }), {
    type: "set-context",
    rewindTo,
  });
});

test("parseSetContextRequest rejects both and neither mode", () => {
  assert.throws(
    () =>
      parseSetContextRequest({ uuids: [randomUUID()], rewindTo: randomUUID() }),
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
    /must be a uuid/,
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
    () => parseSetContextRequest({ uuids: [randomUUID()], anchor: "middle" }),
    /anchor/,
  );
  assert.throws(
    () => parseSetContextRequest({ rewindTo: randomUUID(), summaryText: "s" }),
    /mutually exclusive/,
  );
});
