import assert from "node:assert/strict";
import { test } from "node:test";
import { LineReader } from "./line-reader.ts";

test("LineReader yields multiple lines from one chunk with line numbers", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1 },
    { text: '{"b":2}', lineNumber: 2 },
  ]);
});

test("LineReader buffers a line split across pushes", () => {
  const decoder = new LineReader();
  const line = '{"key":"a longer value"}\n';
  assert.deepEqual(decoder.push(Buffer.from(line.slice(0, 10))), []);
  assert.deepEqual(decoder.push(Buffer.from(line.slice(10, 20))), []);
  assert.deepEqual(decoder.push(Buffer.from(line.slice(20))), [
    { text: line.slice(0, -1), lineNumber: 1 },
  ]);
});

test("LineReader reassembles a UTF-8 code point split across pushes", () => {
  const decoder = new LineReader();
  const text = '{"text":"snowman \u{2603} and beyond \u{1f680}"}';
  const bytes = Buffer.from(`${text}\n`);
  const rocketStart = bytes.indexOf(Buffer.from("\u{1f680}")) + 2;
  assert.deepEqual(decoder.push(bytes.subarray(0, rocketStart)), []);
  assert.deepEqual(decoder.push(bytes.subarray(rocketStart)), [
    { text, lineNumber: 1 },
  ]);
});

test("LineReader emits a torn tail once its newline arrives", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n{"b"')), [
    { text: '{"a":1}', lineNumber: 1 },
  ]);
  assert.deepEqual(decoder.push(Buffer.from(":2}\n")), [
    { text: '{"b":2}', lineNumber: 2 },
  ]);
});

test("LineReader skips blank lines but counts them", () => {
  const decoder = new LineReader();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\n\n   \n{"b":2}\n')), [
    { text: '{"a":1}', lineNumber: 1 },
    { text: '{"b":2}', lineNumber: 4 },
  ]);
});
