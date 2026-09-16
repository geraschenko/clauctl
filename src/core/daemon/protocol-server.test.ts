import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProtocolClient } from "../protocol.ts";
import { startProtocolServer } from "./protocol-server.ts";

const dir = mkdtempSync(join(tmpdir(), "clauctl-protocol-server-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("respond survives an unserializable payload and the daemon keeps serving", async () => {
  const socketPath = join(dir, "socket");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const server = startProtocolServer(socketPath, (request) =>
    Promise.resolve(request.type === "get-entries" ? cyclic : "ok"),
  );
  try {
    const client = await ProtocolClient.connect(socketPath);
    try {
      await assert.rejects(
        client.request({ type: "get-entries", payload: "full" }),
        /response serialization failed/,
      );
      // The failure was per-response: the connection and server still work.
      assert.equal(
        await client.request({ type: "get-context", payload: "full" }),
        "ok",
      );
    } finally {
      client.close();
    }
  } finally {
    server.close();
  }
});
