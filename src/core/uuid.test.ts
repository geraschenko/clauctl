import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { test } from "node:test";
import { UsageError } from "./generated/util.ts";
import {
  displayUuid,
  isUuidPrefix,
  parseUuidPrefixFlag,
  resolveUuidPrefix,
} from "./uuid.ts";

const UUID_A = "11111111-2222-3333-4444-555555555555" as UUID;
const UUID_B = "11111111-aaaa-bbbb-cccc-dddddddddddd" as UUID;
const SESSION = new Set<UUID>([UUID_A, UUID_B]);

test("isUuidPrefix accepts every truncation of a uuid and nothing else", () => {
  for (let length = 1; length <= UUID_A.length; length++) {
    assert.ok(isUuidPrefix(UUID_A.slice(0, length)), `length ${length}`);
  }
  assert.ok(isUuidPrefix(UUID_A.toUpperCase()));
  for (const bad of [
    "",
    "-", // dash where a hex digit belongs
    "11111111x", // non-hex character
    "111111112", // hex digit where the dash belongs
    `${UUID_A}5`, // longer than a uuid
    "not a uuid",
  ]) {
    assert.ok(!isUuidPrefix(bad), JSON.stringify(bad));
  }
});

test("parseUuidPrefixFlag passes prefixes through and rejects syntax as usage", () => {
  assert.equal(parseUuidPrefixFlag("11111111-2"), "11111111-2");
  assert.equal(parseUuidPrefixFlag(UUID_A), UUID_A);
  assert.throws(() => parseUuidPrefixFlag("zz"), UsageError);
});

test("resolveUuidPrefix resolves a unique prefix to the full uuid", () => {
  assert.equal(resolveUuidPrefix("11111111-2", SESSION), UUID_A);
  assert.equal(resolveUuidPrefix("11111111-a", SESSION), UUID_B);
  assert.equal(resolveUuidPrefix(UUID_A, SESSION), UUID_A);
});

test("resolveUuidPrefix matches case-insensitively", () => {
  assert.equal(resolveUuidPrefix("11111111-A", SESSION), UUID_B);
});

test("an ambiguous prefix errors listing every candidate", () => {
  assert.throws(
    () => resolveUuidPrefix("11111111", SESSION),
    (error: Error) =>
      /ambiguous entry uuid prefix '11111111'/.test(error.message) &&
      error.message.includes(UUID_A) &&
      error.message.includes(UUID_B),
  );
});

test("a matchless prefix errors naming the input", () => {
  assert.throws(
    () => resolveUuidPrefix("99", SESSION),
    /no session entry uuid matches '99'/,
  );
});

test("displayUuid is the 8-character prefix", () => {
  assert.equal(displayUuid(UUID_A), "11111111");
});
