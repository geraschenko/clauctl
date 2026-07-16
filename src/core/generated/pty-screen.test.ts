// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { hintRoomSequence } from "./pty-screen.ts";

function makeTerminal(): xterm.Terminal {
  return new xterm.Terminal({ cols: 80, rows: 10, allowProposedApi: true });
}

function write(terminal: xterm.Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()));
}

test("hintRoomSequence is empty while the bottom row is free", async () => {
  const terminal = makeTerminal();
  await write(terminal, "line one\r\nline two");
  assert.equal(hintRoomSequence(terminal), "");
});

test("hintRoomSequence scrolls one line and re-parks the cursor when content reaches the bottom row", async () => {
  const terminal = makeTerminal();
  for (let i = 1; i <= 10; i++) {
    await write(terminal, `line-${i}${i < 10 ? "\r\n" : ""}`);
  }
  // Cursor sits at the end of "line-10" on the bottom row (row 10, col 8;
  // 0-based cursorY 9, cursorX 7). After the appended scroll, the same spot
  // in the content is one row higher: row 9, col 8.
  assert.equal(hintRoomSequence(terminal), "\x1b[10;1H\n\x1b[9;8H");

  // Applying the sequence to the emulator itself must leave the bottom row
  // blank and the cursor on the re-parked spot.
  await write(terminal, hintRoomSequence(terminal));
  const buffer = terminal.buffer.active;
  const bottomRow = buffer
    .getLine(buffer.baseY + terminal.rows - 1)!
    .translateToString()
    .trim();
  assert.equal(bottomRow, "");
  assert.equal(buffer.cursorY, 8);
  assert.equal(buffer.cursorX, 7);
});
