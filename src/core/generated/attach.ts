// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/*
 * `clauctl attach --target <agent>` — connect the local terminal to an agent's
 * PTY via the daemon's tty.sock: raw-mode stdin, snapshot render, then
 * bidirectional byte proxying until the detach keybinding.
 */

import { connect, type Socket } from "node:net";
import {
  CURSOR_HOME,
  cursorToRow,
  DISABLE_BRACKETED_PASTE,
  ERASE_SCREEN,
  RESET_SGR,
  RESTORE_CURSOR,
  SAVE_CURSOR,
  SHOW_CURSOR,
} from "./ansi.ts";
import { commandOneTarget } from "./cli.ts";
import { oneTarget, type CommandContext } from "./targets.ts";
import { ensureAgentRunning } from "../lifecycle.ts";
import { ttySocketPath } from "../registry.ts";
import {
  decodeExit,
  encodeFrame,
  encodeHello,
  encodeResize,
  FrameDecoder,
  FrameType,
} from "./tty-protocol.ts";

/** The only definition of the detach key. 0x1d is ctrl+] as a raw-mode byte. */
const DETACH_KEY = 0x1d;
export const DETACH_KEY_NAME = "ctrl+]";

/**
 * Undo what an attach session may have left in the local terminal: pi runs
 * cursor-hidden with bracketed paste on, and output may end mid-SGR.
 */
const TERMINAL_RESTORE_SEQUENCE = `${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${RESET_SGR}`;

/** Render the snapshot from the daemon's emulator origin: home, clear. */
const CLEAR_SCREEN_SEQUENCE = `${CURSOR_HOME}${ERASE_SCREEN}`;

async function connectToTty(
  socketPath: string,
  agentId: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", (error) =>
      reject(
        new Error(
          `cannot connect to agent ${agentId}'s tty socket: ${String(error)}`,
        ),
      ),
    );
  });
}

export async function attach(this: CommandContext): Promise<void> {
  const { id: targetId } = oneTarget(this);
  const { id: agentId, agentDir } = await ensureAgentRunning(targetId);
  // attach is inherently Node/TTY-specific; Stricli's process type is
  // intentionally minimal, so use the real Node process interface here.
  const nodeProcess = this.process as NodeJS.Process;
  const { stdin, stdout } = nodeProcess;

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("attach requires stdin and stdout to be a terminal");
  }

  // pi leaves the cursor at its editor line with the footer drawn below it;
  // printing there would leave the footer as ghost text around the shell
  // prompt. Park the cursor on the last row so the exit message and the prompt
  // land below everything pi drew.
  const cursorToLastRow = (): string => cursorToRow(stdout.rows);

  const socket = await connectToTty(ttySocketPath(agentDir), agentId);
  // hello is the required first client frame (before the initial resize);
  // the daemon drops clients that send anything else first.
  socket.write(encodeHello({ pid: nodeProcess.pid, client: "clauctl attach" }));
  stdin.setRawMode(true);
  stdin.resume();

  // Drawn over the last row right after the snapshot, so it is visible on
  // attach instead of being wiped by the snapshot's screen clear; pi's next
  // full redraw overwrites it. DECSC/DECRC bracket it so the cursor and SGR
  // state the snapshot established are untouched.
  const attachHint = `${SAVE_CURSOR}${cursorToLastRow()}${RESET_SGR}attached to ${agentId}; detach: ${DETACH_KEY_NAME}${RESTORE_CURSOR}`;

  const finish = (exitCode: number, message: string): never => {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(
      `${cursorToLastRow()}${TERMINAL_RESTORE_SEQUENCE}\r\n${message}\n`,
    );
    socket.destroy();
    nodeProcess.exit(exitCode);
    throw new Error("unreachable after process.exit");
  };

  const sendResize = (): void => {
    socket.write(
      encodeResize({
        cols: stdout.columns,
        rows: stdout.rows,
      }),
    );
  };
  sendResize();
  stdout.on("resize", sendResize);

  const frameDecoder = new FrameDecoder();
  socket.on("data", (chunk) => {
    try {
      for (const frame of frameDecoder.push(chunk)) {
        switch (frame.type) {
          case FrameType.snapshot:
            stdout.write(CLEAR_SCREEN_SEQUENCE);
            stdout.write(frame.payload);
            stdout.write(attachHint);
            break;
          case FrameType.output:
            stdout.write(frame.payload);
            break;
          case FrameType.exit:
            finish(0, `agent exited: ${decodeExit(frame.payload).reason}`);
            break;
          default:
            throw new Error(
              `unexpected server-to-client frame type ${frame.type}`,
            );
        }
      }
    } catch (error) {
      finish(1, `attach protocol error: ${String(error)}`);
    }
  });
  socket.on("close", () => finish(1, "connection to agent daemon lost"));
  socket.on("error", () => socket.destroy());

  stdin.on("data", (chunk: Buffer) => {
    const detachIndex = chunk.indexOf(DETACH_KEY);
    if (detachIndex === -1) {
      socket.write(encodeFrame(FrameType.input, chunk));
      return;
    }
    const beforeDetach = chunk.subarray(0, detachIndex);
    if (beforeDetach.length > 0) {
      socket.write(encodeFrame(FrameType.input, beforeDetach));
    }
    finish(0, `detached from ${agentId}`);
  });

  // The proxy now runs entirely on the event handlers above; every path out
  // goes through finish() and process.exit.
  return new Promise<never>(() => {});
}

const attachCommand = commandOneTarget({
  common: true,
  docs: { brief: "attach this terminal to an agent" },
  func: attach,
});

export const attachRoute = {
  attach: attachCommand,
} as const;
