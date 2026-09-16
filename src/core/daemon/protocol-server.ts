import { createServer, type Server, type Socket } from "node:net";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type ProtocolRequestRecord,
  type ProtocolResponse,
} from "../protocol.ts";

/**
 * Returned by a handler that wrote its own response (subscribe): the generic
 * respond path runs in a later microtask, and an event emitted in that window
 * would hit the wire before the response line.
 */
export const RESPONSE_SENT: unique symbol = Symbol("response sent");

/** Per-connection handle so subscribe can attach a sink and unhook it on close. */
export interface ProtocolConnection {
  write(line: string): void;
  onClose(cleanup: () => void): void;
}

/**
 * JSONL server speaking the clauctl protocol on socket; hello on connect. Requests get responses; a
 * subscribed connection additionally receives pushed AgentEventRecord lines
 * (written by the EventHub sink the subscribe handler attaches). Sinks are
 * fire-and-forget socket writes: a slow subscriber buffers in its socket,
 * never blocks the daemon or other clients.
 */
export function startProtocolServer(
  socketPath: string,
  handleRequest: (
    request: ProtocolRequestRecord,
    connection: ProtocolConnection,
  ) => Promise<unknown>,
): Server {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => socket.destroy());
    socket.write(
      `${JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
      })}\n`,
    );
    const connection: ProtocolConnection = {
      write: (line) => {
        if (!socket.destroyed) {
          socket.write(line);
        }
      },
      onClose: (cleanup) => {
        socket.on("close", cleanup);
      },
    };
    const respond = (response: ProtocolResponse): void => {
      let line: string;
      try {
        line = JSON.stringify(response);
      } catch (error) {
        // Serialization failure (e.g. a cyclic or too-deep payload) must not
        // crash the daemon. The fallback embeds only String(error) — no part
        // of the original response data — so it cannot itself fail.
        const failure: ProtocolResponse = {
          id: response.id,
          ok: false,
          error: `response serialization failed: ${String(error)}`,
        };
        line = JSON.stringify(failure);
      }
      connection.write(`${line}\n`);
    };
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          let request: ProtocolRequestRecord;
          try {
            request = JSON.parse(line) as ProtocolRequestRecord;
          } catch {
            continue;
          }
          void handleRequest(request, connection).then(
            (data) => {
              if (data !== RESPONSE_SENT) {
                respond({
                  id: request.id,
                  ok: true,
                  ...(data !== undefined && { data }),
                });
              }
            },
            (error: unknown) =>
              respond({
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
  server.listen(socketPath);
  return server;
}
