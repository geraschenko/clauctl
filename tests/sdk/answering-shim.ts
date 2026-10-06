/**
 * The answering shim: a local HTTP stand-in for the Anthropic API that
 * records every request and answers /v1/messages with a synthetic end_turn
 * stream, so nothing reaches the real API
 * (docs/derisk/api-context-view/README.md).
 */

import http from "node:http";

export interface CapturedRequest {
  path: string;
  /** authorization / x-api-key / cookie redacted. */
  headers: Record<string, string>;
  /** Parsed JSON, or `{ unparsed }`. */
  body: unknown;
}

export interface AnsweringShim {
  port: number;
  /** In arrival order. */
  requests: CapturedRequest[];
  close(): void;
}

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

const SYNTHETIC_MESSAGE_ID = "msg_answering_shim";

/** The SSE events of an assistant message with one content block. */
function singleBlockStream(
  model: string,
  contentBlock: object,
  delta: object,
  stopReason: "end_turn" | "tool_use",
): string {
  const events: [string, object][] = [
    [
      "message_start",
      {
        message: {
          id: SYNTHETIC_MESSAGE_ID,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ["content_block_start", { index: 0, content_block: contentBlock }],
    ["content_block_delta", { index: 0, delta }],
    ["content_block_stop", { index: 0 }],
    [
      "message_delta",
      {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", {}],
  ];
  return events
    .map(
      ([type, data]) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    )
    .join("");
}

/** A one-word assistant reply with stop_reason end_turn. */
function syntheticStream(model: string): string {
  return singleBlockStream(
    model,
    { type: "text", text: "" },
    { type: "text_delta", text: "ok" },
    "end_turn",
  );
}

/** An assistant reply calling `name` with `input`, verbatim and unvalidated. */
export function toolUseStream(
  model: string,
  toolUseId: string,
  name: string,
  input: unknown,
): string {
  return singleBlockStream(
    model,
    { type: "tool_use", id: toolUseId, name, input: {} },
    { type: "input_json_delta", partial_json: JSON.stringify(input) },
    "tool_use",
  );
}

/** Overrides the synthetic reply to one /v1/messages request: the SSE body
 *  to send, or undefined for the synthetic end_turn reply. */
export type ShimReply = (body: unknown) => string | undefined;

function recordedHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name !== "host")
      .map(([name, value]) => [
        name,
        REDACTED_HEADERS.has(name)
          ? "<redacted>"
          : Array.isArray(value)
            ? value.join(", ")
            : (value ?? ""),
      ]),
  );
}

/** Listens on 127.0.0.1; answers /v1/messages with `reply`'s stream or the
 *  synthetic one, everything else with an empty 200. */
export function startAnsweringShim(
  reply: ShimReply = () => undefined,
): Promise<AnsweringShim> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = { unparsed: raw.slice(0, 2000) };
        }
      }
      const path = req.url ?? "";
      requests.push({ path, headers: recordedHeaders(req.headers), body });
      if (path.startsWith("/v1/messages") && !path.includes("count_tokens")) {
        const model = (body as { model?: string } | null)?.model ?? "unknown";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.end(reply(body) ?? syntheticStream(model));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("answering shim: no TCP address"));
        return;
      }
      resolve({ port: address.port, requests, close: () => server.close() });
    });
  });
}
