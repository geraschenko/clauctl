// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import { LineReader } from "./line-reader.ts";

test("LineReader yields multiple lines from one chunk with line numbers", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
    { text: '{"b":2}', lineNumber: 2, byteOffset: 8, byteLength: 8 },
  ]);
});

test("LineReader buffers a line split across pushes", () => {
  const decoder = new LineReader();
  const line = '{"key":"a longer value"}\n';
  assert.deepEqual(decoder.push(Buffer.from(line.slice(0, 10))), []);
  assert.deepEqual(decoder.push(Buffer.from(line.slice(10, 20))), []);
  assert.deepEqual(decoder.push(Buffer.from(line.slice(20))), [
    {
      text: line.slice(0, -1),
      lineNumber: 1,
      byteOffset: 0,
      byteLength: Buffer.byteLength(line),
    },
  ]);
});

test("LineReader reassembles a UTF-8 code point split across pushes", () => {
  const decoder = new LineReader();
  const text = '{"text":"snowman \u{2603} and beyond \u{1f680}"}';
  const bytes = Buffer.from(`${text}\n`);
  const rocketStart = bytes.indexOf(Buffer.from("\u{1f680}")) + 2;
  assert.deepEqual(decoder.push(bytes.subarray(0, rocketStart)), []);
  assert.deepEqual(decoder.push(bytes.subarray(rocketStart)), [
    {
      text,
      lineNumber: 1,
      byteOffset: 0,
      byteLength: Buffer.byteLength(text) + 1,
    },
  ]);
  assert.deepEqual(decoder.push(Buffer.from("next\n")), [
    { text: "next", lineNumber: 2, byteOffset: bytes.length, byteLength: 5 },
  ]);
});

test("LineReader emits a torn tail once its newline arrives", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b"')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
  ]);
  assert.deepEqual(decoder.push(Buffer.from(":2}\n")), [
    { text: '{"b":2}', lineNumber: 2, byteOffset: 8, byteLength: 8 },
  ]);
  assert.deepEqual(decoder.push(Buffer.from("next\n")), [
    { text: "next", lineNumber: 3, byteOffset: 16, byteLength: 5 },
  ]);
});

test("LineReader preserves CRLF text and counts both terminator bytes", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from("first\r\n\r\nsecond\r\n")), [
    { text: "first\r", lineNumber: 1, byteOffset: 0, byteLength: 7 },
    { text: "second\r", lineNumber: 3, byteOffset: 9, byteLength: 8 },
  ]);
});

test("LineReader counts whitespace split across pushes and empty pushes", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from(" \t")), []);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
  assert.deepEqual(decoder.push(Buffer.from("\nrecord")), []);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
  assert.deepEqual(decoder.push(Buffer.from("\n")), [
    { text: "record", lineNumber: 2, byteOffset: 3, byteLength: 7 },
  ]);
});

test("LineReader skips blank lines but counts them", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n\n   \n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1, byteOffset: 0, byteLength: 8 },
    { text: '{"b":2}', lineNumber: 4, byteOffset: 13, byteLength: 8 },
  ]);
});
