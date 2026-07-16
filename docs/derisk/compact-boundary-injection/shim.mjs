// Recording proxy for the outbound-request oracle (README "Methodology core").
// Listens on 127.0.0.1, forwards verbatim to api.anthropic.com, and appends one
// JSON line per request to the capture file: {ts, method, path, headers, body,
// status}. Response bodies (SSE streams) are piped through untouched and not
// recorded — assertions run on outbound `messages`, not on model output.
//
// Usage: node shim.mjs <captureFile> [port]   (prints "LISTENING <port>" when ready)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const captureFile = process.argv[2];
const port = Number(process.argv[3] ?? 0);
if (!captureFile) {
  console.error("usage: node shim.mjs <captureFile> [port]");
  process.exit(1);
}

const REDACT = new Set(["authorization", "x-api-key", "cookie"]);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    const recordedHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, REDACT.has(k.toLowerCase()) ? "<redacted>" : v])
    );
    let body = null;
    if (bodyBuf.length) {
      try { body = JSON.parse(bodyBuf.toString("utf8")); }
      catch { body = { unparsed: bodyBuf.toString("utf8").slice(0, 2000) }; }
    }

    const upstream = https.request(
      { host: "api.anthropic.com", method: req.method, path: req.url, headers },
      (upRes) => {
        fs.appendFileSync(
          captureFile,
          JSON.stringify({
            ts: new Date().toISOString(),
            method: req.method,
            path: req.url,
            status: upRes.statusCode,
            headers: recordedHeaders,
            body,
          }) + "\n"
        );
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on("error", (e) => {
      fs.appendFileSync(
        captureFile,
        JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.url, error: String(e), body }) + "\n"
      );
      res.writeHead(502);
      res.end(String(e));
    });
    upstream.end(bodyBuf);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LISTENING ${server.address().port}`);
});
