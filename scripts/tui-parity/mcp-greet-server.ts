/**
 * Stdio MCP server for the `mcp` dialog scenario (dialog-scenarios.ts): one
 * tool, `greet`, so both native claude and the clauctl daemon can launch it
 * via --mcp-config and raise an MCP permission ask. Never approved, so the
 * tool body is never reached in a capture.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "probe", version: "0.0.0" });
server.registerTool(
  "greet",
  {
    description: "Greets a person by name",
    inputSchema: { name: z.string() },
  },
  ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}!` }] }),
);
await server.connect(new StdioServerTransport());
