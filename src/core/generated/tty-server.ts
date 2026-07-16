// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * The daemon's tty.sock server: speaks the framed attach protocol from
 * tty-protocol.ts to any number of simultaneous clients. PTY/xterm specifics
 * stay in the daemon and arrive here as hooks, so this module is pure
 * connection management.
 */

import { chmod } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  decodeHello,
  decodeResize,
  encodeExit,
  encodeFrame,
  FrameDecoder,
  FrameType,
  type HelloPayload,
  type ResizePayload,
} from "./tty-protocol.ts";

const EXIT_FLUSH_DEADLINE_MS = 1_000;

/** The server's view of a helloed client. */
export interface AttachmentInfo {
  pid: number;
  client: string;
  connectedAt: string; // ISO 8601, like AgentRecord.createdAt
  size?: ResizePayload;
}

export interface TtyServerHooks {
  /**
   * Serialize the current screen state. MUST synchronously enqueue a parse
   * barrier behind all PTY output written to the emulator so far, and resolve
   * with a snapshot that includes exactly that output: broadcastOutput data
   * relayed to a connecting client is buffered from the moment its connection
   * arrives, so output parsed before the barrier must be in the snapshot and
   * output written after it must not be (it reaches the client via the
   * buffer). Any other ordering duplicates or drops bytes on attach during
   * heavy streaming.
   */
  serializeScreen(): Promise<string>;
  writeInput(data: string): void;
  resize(cols: number, rows: number): void;
  // The hooks below are synchronous and fire-and-forget from the server's
  // perspective; implementations wrap their own async work.
  /** A client completed hello. */
  onAttach(info: AttachmentInfo): void;
  /** A helloed client disconnected. */
  onDetach(info: AttachmentInfo): void;
  /**
   * The attachment list changed (hello, resize, or disconnect). The array is
   * a fresh snapshot; implementations may keep it but must not mutate it.
   */
  onAttachmentsChanged(attachments: AttachmentInfo[]): void;
}

interface AttachClient {
  socket: Socket;
  /** Output relayed before the snapshot was sent; null once flushed. */
  pendingOutput: Buffer[] | null;
  connectedAt: string;
  /** Set once the client's hello frame arrives; tracking begins there. */
  hello?: HelloPayload;
  /** Last size this client reported; undefined until its first resize frame. */
  size?: ResizePayload;
}

export class TtyServer {
  readonly server: Server;
  private readonly hooks: TtyServerHooks;
  private readonly clients = new Set<AttachClient>();
  private appliedSize: ResizePayload | undefined;
  private shuttingDown = false;

  constructor(hooks: TtyServerHooks) {
    this.hooks = hooks;
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  async listen(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    // Connecting to tty.sock grants full control of the agent's PTY (read its
    // screen, inject input), so restrict it to the owner rather than leaving
    // it at the umask default. pi locks down pi.sock the same way.
    await chmod(socketPath, 0o600);
  }

  /**
   * PTY size = elementwise min over all attached clients' reported sizes
   * (like tmux), recomputed on every resize, attach, and detach: every
   * attacher renders correctly, larger ones with unused margin. Last-writer-
   * wins was tried first and garbles every other differently-sized attacher —
   * one byte stream cannot render at two geometries. When the last client
   * disconnects the PTY keeps its size.
   */
  private applyMinSize(): void {
    let cols = Infinity;
    let rows = Infinity;
    for (const client of this.clients) {
      if (client.size) {
        cols = Math.min(cols, client.size.cols);
        rows = Math.min(rows, client.size.rows);
      }
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }
    if (this.appliedSize?.cols === cols && this.appliedSize?.rows === rows) {
      return;
    }
    this.appliedSize = { cols, rows };
    this.hooks.resize(cols, rows);
  }

  private attachmentInfo(client: AttachClient): AttachmentInfo {
    return {
      pid: client.hello!.pid,
      client: client.hello!.client,
      connectedAt: client.connectedAt,
      ...(client.size !== undefined && { size: client.size }),
    };
  }

  private attachmentsSnapshot(): AttachmentInfo[] {
    return [...this.clients]
      .filter((client) => client.hello !== undefined)
      .map((client) => this.attachmentInfo(client));
  }

  /** Relay PTY output to every attached client. */
  broadcastOutput(data: string): void {
    if (this.clients.size === 0) {
      return;
    }
    const payload = Buffer.from(data);
    for (const client of this.clients) {
      if (client.pendingOutput !== null) {
        client.pendingOutput.push(payload);
      } else {
        client.socket.write(encodeFrame(FrameType.output, payload));
      }
    }
  }

  /**
   * Tell every client the agent is going away, then close. The exit frame is
   * best-effort: flushing is bounded because a client that has stopped
   * reading (with a full kernel buffer) must not block daemon shutdown — its
   * socket dying when the daemon exits carries the same information. Clears
   * clients directly, bypassing dropClient: shutdown emits no detach hooks —
   * the daemon's exit is itself the boundary.
   */
  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    this.server.close();
    const exitFrame = encodeExit({ reason });
    const flushes = [...this.clients].map(
      (client) =>
        new Promise<void>((resolve) => client.socket.end(exitFrame, resolve)),
    );
    let flushDeadline: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(flushes),
      new Promise<void>((resolve) => {
        flushDeadline = setTimeout(resolve, EXIT_FLUSH_DEADLINE_MS);
      }),
    ]);
    clearTimeout(flushDeadline);
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
  }

  private handleConnection(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }
    const client: AttachClient = {
      socket,
      pendingOutput: [],
      connectedAt: new Date().toISOString(),
    };
    this.clients.add(client);
    // dropClient is registered on both 'close' and 'error', and destroy()
    // re-triggers 'close', so onDetach fires only when the delete actually
    // removed the client (and only for helloed clients — unhelloed ones are
    // invisible to hooks).
    const dropClient = (): void => {
      // During shutdown the exit handshake owns the sockets and shutdown()
      // clears the client set itself; no detach hooks may fire (shutdown is
      // hook-silent), and a 'close' arriving before clients.clear() would
      // otherwise emit one.
      if (this.shuttingDown) {
        return;
      }
      const removed = this.clients.delete(client);
      socket.destroy();
      this.applyMinSize();
      if (removed && client.hello !== undefined) {
        this.hooks.onDetach(this.attachmentInfo(client));
        this.hooks.onAttachmentsChanged(this.attachmentsSnapshot());
      }
    };
    socket.on("close", dropClient);
    socket.on("error", dropClient);

    // Buffering (registration above) and the serialize parse barrier must be
    // enqueued in the same synchronous step — see TtyServerHooks.
    this.hooks.serializeScreen().then(
      (snapshot) => {
        // shuttingDown guards the window between shutdown()'s socket.end and
        // the socket reporting destroyed, where a write would still succeed
        // (or raise write-after-end) and corrupt the exit handshake.
        if (
          client.pendingOutput === null ||
          socket.destroyed ||
          this.shuttingDown
        ) {
          return;
        }
        socket.write(encodeFrame(FrameType.snapshot, Buffer.from(snapshot)));
        for (const payload of client.pendingOutput) {
          socket.write(encodeFrame(FrameType.output, payload));
        }
        client.pendingOutput = null;
      },
      // A client whose snapshot failed would otherwise buffer output forever.
      () => dropClient(),
    );

    // Input bytes are UTF-8 that may split mid-character across frames;
    // StringDecoder reassembles (node-pty accepts only strings).
    const inputDecoder = new StringDecoder("utf8");
    const frameDecoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      // Frames racing the exit handshake are meaningless and must not fire
      // hooks after shutdown() has cleared the attachment state.
      if (this.shuttingDown) {
        return;
      }
      try {
        for (const frame of frameDecoder.push(chunk)) {
          // hello is the required first client frame: input or resize before
          // it (or a repeated hello) is a protocol violation and drops the
          // client. A client that never sends any frame can still observe
          // passively (snapshot and output) without appearing in
          // attachments — tracking is cooperative, not enforcement.
          switch (frame.type) {
            case FrameType.hello:
              if (client.hello !== undefined) {
                throw new Error("repeated hello frame");
              }
              client.hello = decodeHello(frame.payload);
              this.hooks.onAttach(this.attachmentInfo(client));
              this.hooks.onAttachmentsChanged(this.attachmentsSnapshot());
              break;
            case FrameType.input:
              if (client.hello === undefined) {
                throw new Error("input frame before hello");
              }
              this.hooks.writeInput(inputDecoder.write(frame.payload));
              break;
            case FrameType.resize:
              if (client.hello === undefined) {
                throw new Error("resize frame before hello");
              }
              client.size = decodeResize(frame.payload);
              this.applyMinSize();
              this.hooks.onAttachmentsChanged(this.attachmentsSnapshot());
              break;
            default:
              throw new Error(
                `unexpected client-to-server frame type ${frame.type}`,
              );
          }
        }
      } catch {
        dropClient();
      }
    });
  }
}
