import { createServer, type Server, type Socket } from "node:net";
import {
  SDK_SOCKET_PROTOCOL,
  SDK_SOCKET_VERSION,
  type SdkRequestRecord,
  type SdkResponse,
} from "../sdk-socket.ts";

/**
 * Returned by a handler that wrote its own response (subscribe): the generic
 * respond path runs in a later microtask, and an event emitted in that window
 * would hit the wire before the response line.
 */
export const RESPONSE_SENT: unique symbol = Symbol("response sent");

/** Per-connection handle so subscribe can attach a sink and unhook it on close. */
export interface SdkConnection {
  write(line: string): void;
  onClose(cleanup: () => void): void;
}

/**
 * JSONL server on sdk.sock; hello on connect. Requests get responses; a
 * subscribed connection additionally receives pushed SdkEventRecord lines
 * (written by the EventHub sink the subscribe handler attaches). Sinks are
 * fire-and-forget socket writes: a slow subscriber buffers in its socket,
 * never blocks the daemon or other clients.
 */
export function startSdkServer(
  socketPath: string,
  handleRequest: (
    request: SdkRequestRecord,
    connection: SdkConnection,
  ) => Promise<unknown>,
): Server {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => socket.destroy());
    socket.write(
      `${JSON.stringify({
        type: "hello",
        protocol: SDK_SOCKET_PROTOCOL,
        version: SDK_SOCKET_VERSION,
      })}\n`,
    );
    const connection: SdkConnection = {
      write: (line) => {
        if (!socket.destroyed) {
          socket.write(line);
        }
      },
      onClose: (cleanup) => {
        socket.on("close", cleanup);
      },
    };
    const respond = (response: SdkResponse): void => {
      let line: string;
      try {
        line = JSON.stringify(response);
      } catch (error) {
        // Serialization failure (e.g. a cyclic or too-deep payload) must not
        // crash the daemon. The fallback embeds only String(error) — no part
        // of the original response data — so it cannot itself fail.
        const failure: SdkResponse = {
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
          let request: SdkRequestRecord;
          try {
            request = JSON.parse(line) as SdkRequestRecord;
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
