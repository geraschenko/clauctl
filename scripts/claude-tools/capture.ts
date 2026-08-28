/**
 * Captures the bundled claude's tool schemas by running it through an
 * mitmdump forward proxy (capture-addon.py) and recording the `tools` array
 * of its /messages requests. Two-phase flow:
 *
 *  1. A trivial prompt captures the immediately-loaded tools plus the
 *     deferred-tool roster from the system-reminder in the request.
 *  2. A prompt instructing claude to run `select:` ToolSearch queries for
 *     every deferred tool makes the API include their schemas in the next
 *     request's tools array.
 *
 * A forward proxy (HTTPS_PROXY) is required — pointing ANTHROPIC_BASE_URL at
 * a reverse proxy changes claude's tool surface (no deferred roster).
 *
 * Uses the parity harness's isolated CLAUDE_CONFIG_DIR (OAuth credentials —
 * verified to survive the MITM). Writes scripts/claude-tools/tool-schemas.json
 * (checked in): the built-in tools only — account-level `mcp__*` tools are
 * filtered out so the file is a function of the claude version, not of the
 * capturing account — stamped with the claude/SDK versions for
 * `generate.ts --check` — then regenerates src/tui/tool-views/generated.ts,
 * so a single run leaves both files consistent.
 *
 * The built-in roster is NOT a pure function of the binary version: tools
 * carry `isEnabled()` predicates that consult server-fetched feature gates
 * (statsig `tengu_*` gates), and gate state depends on the capturing
 * account's experiment-group membership. Some tools exist in the binary but
 * are only enabled for accounts in the right experiment group, so rerunning
 * capture can change the results — gaining or losing tools — even when the
 * claude version has not changed. A diff in tool-schemas.json without an
 * SDK bump means the gate state changed, not the pin.
 *
 * Entry point: node scripts/claude-tools/capture.ts
 * Requires mitmdump on PATH (or $MITMDUMP).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
// Aliased because promises-flavored setTimeout(ms, value) would otherwise
// shadow the global setTimeout(cb, ms) under the same name.
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  claudeEnv,
  ensureClaudeConfigDir,
  resolveBundledClaude,
  workdirBase,
} from "../tui-parity/capture.ts";
import { regenerate } from "./generate.ts";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
export const toolSchemasPath = join(scriptDir, "tool-schemas.json");

const PROXY_PORT = 18877;
const READY_TIMEOUT_MS = 15_000;

/** The raw JSON capture-addon.py writes. */
interface RawCapture {
  tools: {
    name: string;
    input_schema: Record<string, unknown>;
    defer_loading?: boolean;
  }[];
  deferred_tool_roster: string[] | null;
  drift_detected: boolean;
}

export interface ToolSchemas {
  /** Version of the bundled claude binary the schemas were captured from. */
  claudeVersion: string;
  /** @anthropic-ai/claude-agent-sdk version bundling that binary; what
   *  `generate.ts --check` compares against (a local file read). */
  sdkVersion: string;
  tools: {
    name: string;
    input_schema: Record<string, unknown>;
    defer_loading?: boolean;
  }[];
}

/** Polls until the proxy accepts TCP connections (mitmdump has no
 *  observable ready signal; backoff-polling is the sanctioned fallback). */
async function awaitProxyReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let delayMs = 100;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (connected) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`mitmdump not accepting connections on port ${port}`);
    }
    await delay(delayMs);
    delayMs = Math.min(delayMs * 2, 1_000);
  }
}

/**
 * The invoking shell may itself be a claude agent session (CLAUDECODE,
 * CLAUDE_CODE_*, AI_AGENT, …), and the bundled claude changes its tool
 * surface when it detects that — e.g. an inherited
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC suppresses the feature-gate
 * fetch, leaving default gate values. Scrub those vars so the capture is a
 * function of the claude version and account, not of who ran the script
 * (verified 2026-08-28: an agent-shell capture differed from a user-shell
 * capture until scrubbed).
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(CLAUDE|AI_AGENT)/.test(key),
    ),
  );
}

async function runClaude(prompt: string, maxTurns: number): Promise<void> {
  const workdir = join(workdirBase, "claude-tools");
  await mkdir(workdir, { recursive: true });
  const { stdout } = await execFileAsync(
    resolveBundledClaude(),
    ["-p", prompt, "--max-turns", String(maxTurns)],
    {
      cwd: workdir,
      env: {
        ...scrubbedEnv(),
        ...claudeEnv,
        DISABLE_AUTOUPDATER: "1",
        HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    },
  );
  console.log(`claude: ${stdout.trim().split("\n").at(-1)}`);
}

function isBuiltIn(name: string): boolean {
  return !name.startsWith("mcp__");
}

/** ToolSearch prompt loading every deferred built-in tool's schema. */
function toolSearchPrompt(names: string[]): string {
  const queries: string[] = [];
  for (let i = 0; i < names.length; i += 5) {
    queries.push(`- select:${names.slice(i, i + 5).join(",")}`);
  }
  return (
    "Call the ToolSearch tool once for each of these queries, exactly as written:\n" +
    `${queries.join("\n")}\n` +
    'Do NOT invoke any of the loaded tools. When all queries are done, respond with "done".'
  );
}

async function readRawCapture(path: string): Promise<RawCapture> {
  const raw = JSON.parse(await readFile(path, "utf8")) as RawCapture;
  if (raw.drift_detected) {
    throw new Error("schema drift detected during capture (see mitmdump log)");
  }
  return raw;
}

async function claudeVersion(): Promise<string> {
  const { stdout } = await execFileAsync(
    resolveBundledClaude(),
    ["--version"],
    {
      env: { ...scrubbedEnv(), ...claudeEnv },
    },
  );
  const version = stdout.trim().split(/\s/)[0];
  if (version === undefined || version === "") {
    throw new Error(`unparseable claude --version output: ${stdout}`);
  }
  return version;
}

async function sdkVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(
      join(
        repoRoot,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string };
  return packageJson.version;
}

async function main(): Promise<void> {
  await ensureClaudeConfigDir();
  const rawPath = join(workdirBase, "claude-tools", "raw-capture.json");
  await mkdir(dirname(rawPath), { recursive: true });
  await rm(rawPath, { force: true });

  const mitmdump: ChildProcess = spawn(
    process.env.MITMDUMP ?? "mitmdump",
    [
      "--listen-port",
      String(PROXY_PORT),
      "--ssl-insecure",
      "--set",
      "flow_detail=0",
      "-s",
      join(scriptDir, "capture-addon.py"),
      "--set",
      `output_path=${rawPath}`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const mitmdumpExit = new Promise<void>((resolve, reject) => {
    mitmdump.on("exit", () => resolve());
    mitmdump.on("error", reject);
  });

  try {
    await awaitProxyReady(PROXY_PORT);

    console.log("phase 1: discovery prompt");
    await runClaude("Respond with just the word hello.", 1);
    const discovery = await readRawCapture(rawPath);
    if (discovery.deferred_tool_roster === null) {
      throw new Error("no deferred-tool roster captured in phase 1");
    }
    const captured = new Set(discovery.tools.map((tool) => tool.name));
    const toLoad = discovery.deferred_tool_roster
      .filter(isBuiltIn)
      .filter((name) => !captured.has(name));

    if (toLoad.length > 0) {
      console.log(`phase 2: loading ${toLoad.length} deferred tools`);
      await runClaude(toolSearchPrompt(toLoad), 5);
    }
  } finally {
    mitmdump.kill("SIGTERM");
    await mitmdumpExit;
  }

  const capture = await readRawCapture(rawPath);
  const capturedNames = new Set(capture.tools.map((tool) => tool.name));
  const missing = (capture.deferred_tool_roster ?? [])
    .filter(isBuiltIn)
    .filter((name) => !capturedNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `roster tools never captured (ToolSearch loading failed?): ${missing.join(", ")}`,
    );
  }

  const output: ToolSchemas = {
    claudeVersion: await claudeVersion(),
    sdkVersion: await sdkVersion(),
    tools: capture.tools.filter((tool) => isBuiltIn(tool.name)),
  };
  await writeFile(toolSchemasPath, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `wrote ${toolSchemasPath}: ${output.tools.length} tools ` +
      `(claude ${output.claudeVersion}, sdk ${output.sdkVersion})`,
  );
  await regenerate();
}

if (process.argv[1] !== undefined) {
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
