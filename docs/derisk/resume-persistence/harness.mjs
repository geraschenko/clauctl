// Shared plumbing for the resume-persistence experiments (E1, E2).
//
// SECURITY: never touches the real ~/.claude. Every session must be spawned
// with env = baseEnv(), which points CLAUDE_CONFIG_DIR at the scratch dir.
// Uses the SDK-bundled `claude` binary (no pathToClaudeCodeExecutable override).

import { query } from "/home/anton/.treehouse/clauctl-90dce5/1/clauctl/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

export const CONFIG_DIR = "/tmp/clauctl-resume-derisk";
export const HAIKU = "claude-haiku-4-5-20251001";

// Subprocess env with the scratch config dir. Options.env REPLACES the child
// env entirely, so spread process.env first.
export const baseEnv = () => ({ ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR });

// Offline reference MCP server (echo tool). alwaysLoad so it connects before
// the turn and surfaces in init.mcp_servers.
export const everythingServer = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  alwaysLoad: true,
};

// A manually-driven streaming session. A single consumer loop routes each
// turn's messages to the promise returned by send(); control methods live on
// the returned `q`. send(text) resolves with the turn's collected messages
// once its `result` arrives.
export function makeSession(options) {
  let resolveNext = null;
  const pending = [];
  let closed = false;
  const input = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { resolveNext = res; });
        },
      };
    },
  };
  const pushMsg = (text) => {
    const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: m, done: false }); }
    else pending.push(m);
  };

  const q = query({ prompt: input, options });
  const inits = [];
  let resolveResult = null;
  let turnMsgs = [];
  let loopErr = null;
  const loop = (async () => {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") inits.push(msg);
      turnMsgs.push(msg);
      if (msg.type === "result") {
        const r = resolveResult; resolveResult = null;
        const collected = turnMsgs; turnMsgs = [];
        if (r) r(collected);
      }
    }
  })().catch((e) => { loopErr = e; });

  const send = (text) => new Promise((res, rej) => {
    resolveResult = res;
    pushMsg(text);
    loop.then(() => { if (loopErr) rej(loopErr); });
  });
  const close = () => { closed = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } q.close(); };
  return { q, send, inits, close, lastInit: () => inits[inits.length - 1] };
}
