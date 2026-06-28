// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * Framing for the daemon's tty.sock attach protocol, shared by the daemon
 * (server) and `clauctl attach` (client). Binary frames — raw PTY output is
 * high-volume, so no JSONL/base64:
 *
 *   [type: u8][payloadLength: u32 BE][payload]
 *
 * Client → server: `hello` (JSON, required first client frame), `input`
 * (raw terminal input bytes), `resize` (JSON).
 * Server → client: `snapshot` (serialized screen state, sent once on
 * connect), `output` (raw PTY output bytes), `exit` (JSON, the agent is
 * shutting down).
 *
 * Keep this file free of clauctl-specific imports: it defines the wire
 * protocol and nothing else.
 */

// Const object + same-named type is the standard TS enum alternative: the
// value gives `FrameType.input` etc., the type is the union of the values
// (1 | 2 | ...). TS resolves which one a usage means from context, exactly
// as it does for `enum` declarations.
export const FrameType = {
  input: 1,
  resize: 2,
  snapshot: 3,
  output: 4,
  exit: 5,
  hello: 6,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_VALUES = new Set<number>(Object.values(FrameType));
const FRAME_TYPE_BYTES = 1;
const PAYLOAD_LENGTH_BYTES = 4;
const HEADER_BYTES = FRAME_TYPE_BYTES + PAYLOAD_LENGTH_BYTES;

/**
 * Upper bound on a single frame's payload, far above anything legitimate
 * (the largest frame is a snapshot with scrollback, ~hundreds of KB). Its
 * only job is to keep a corrupt or hostile length prefix from committing the
 * decoder to buffering gigabytes.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

export interface ResizePayload {
  cols: number;
  rows: number;
}

export interface ExitPayload {
  reason: string;
}

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, FRAME_TYPE_BYTES);
  return Buffer.concat([header, payload]);
}

export function encodeResize(resize: ResizePayload): Buffer {
  return encodeFrame(FrameType.resize, Buffer.from(JSON.stringify(resize)));
}

/** Throws on malformed payloads; the receiver should drop the connection. */
export function decodeResize(payload: Buffer): ResizePayload {
  const parsed = JSON.parse(payload.toString("utf8")) as Partial<ResizePayload>;
  if (!isValidDimension(parsed.cols) || !isValidDimension(parsed.rows)) {
    throw new Error(`invalid resize payload: ${payload.toString("utf8")}`);
  }
  return { cols: parsed.cols, rows: parsed.rows };
}

const MAX_DIMENSION = 10_000;

function isValidDimension(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_DIMENSION
  );
}

export interface HelloPayload {
  /** The client's own pid, self-reported (cooperative, unverified). */
  pid: number;
  /** Free-form client description, e.g. "clauctl attach". */
  client: string;
}

export function encodeHello(hello: HelloPayload): Buffer {
  return encodeFrame(FrameType.hello, Buffer.from(JSON.stringify(hello)));
}

/** Throws on malformed payloads; the receiver should drop the connection. */
export function decodeHello(payload: Buffer): HelloPayload {
  const parsed = JSON.parse(payload.toString("utf8")) as Partial<HelloPayload>;
  if (
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.client !== "string"
  ) {
    throw new Error(`invalid hello payload: ${payload.toString("utf8")}`);
  }
  return { pid: parsed.pid, client: parsed.client };
}

export function encodeExit(exit: ExitPayload): Buffer {
  return encodeFrame(FrameType.exit, Buffer.from(JSON.stringify(exit)));
}

export function decodeExit(payload: Buffer): ExitPayload {
  const parsed = JSON.parse(payload.toString("utf8")) as Partial<ExitPayload>;
  return { reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

/**
 * Incremental frame parser: feed socket chunks in, get complete frames out.
 *
 * Safety properties: header fields are read only once at least HEADER_BYTES
 * are buffered; a frame is emitted only once its declared payload is fully
 * buffered (a partial frame is the normal case — the kernel chunks socket
 * data with no regard for frame boundaries, so a frame routinely arrives
 * split across push() calls and the decoder just waits for the rest); reads
 * are via subarray, which is bounds-checked — a lying length prefix can never
 * read past what was actually received. The remaining risk with
 * length-prefixed framing is memory, not overflow: a huge declared length
 * would commit us to buffering it, hence the MAX_PAYLOAD_BYTES cap. Throws
 * on an unknown frame type or an oversized declared length; framing is then
 * unrecoverable and the caller must destroy the connection.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const type = this.buffer.readUInt8(0);
      if (!FRAME_TYPE_VALUES.has(type)) {
        throw new Error(`unknown tty frame type ${type}`);
      }
      const payloadLength = this.buffer.readUInt32BE(FRAME_TYPE_BYTES);
      if (payloadLength > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `tty frame payload length ${payloadLength} exceeds limit ${MAX_PAYLOAD_BYTES}`,
        );
      }
      if (this.buffer.length < HEADER_BYTES + payloadLength) {
        break;
      }
      frames.push({
        type: type as FrameType,
        payload: this.buffer.subarray(
          HEADER_BYTES,
          HEADER_BYTES + payloadLength,
        ),
      });
      this.buffer = this.buffer.subarray(HEADER_BYTES + payloadLength);
    }
    return frames;
  }
}
