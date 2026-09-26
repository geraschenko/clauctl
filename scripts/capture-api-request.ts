/**
 * Oracle for docs/derisk/api-context-view/README.md: the /v1/messages request
 * the CLI builds when a prompt is sent at a point of a session file. The
 * session is resumed from a copy in a scratch CLAUDE_CONFIG_DIR (or, with
 * --real-config, from ~/.claude with the file restored afterwards;
 * tests/sdk/resumable-session.ts) against the answering shim
 * (tests/sdk/answering-shim.ts), so no request reaches the API and the
 * given file is never changed. Usage:
 *   node scripts/capture-api-request.ts <session.jsonl> [--at UUID] [--prompt TEXT] [--out FILE] [--real-config] [--check]
 * stdout: the captured request body (JSON). stderr: versions, mirrored
 * paths, capture counts. Exit 1 when no request
 * carrying the prompt nonce was captured, 2 on usage errors.
 * --check (docs/specs/api-messages.md): splitPromptTurn → toApiMessages →
 * compareApiMessages; writes
 * /tmp/capture-api-request-<sessionId>/{captured,split,captured-messages,synthesized,comparison}.json
 * (`captured-messages` is the wire without its request-time content, in
 * the synthesized shape: empty `diff` against `synthesized` ⇔ no differences),
 * prints every difference with its tolerance or FAIL, and exits 1 on a
 * failing one.
 */

import { randomUUID, type UUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { leafContext } from "../src/commands/format.ts";
import { compareApiMessages } from "../src/format/api-messages/compare-api-messages.ts";
import { toApiMessages } from "../src/format/api-messages/to-api-messages.ts";
import {
  captureInferenceRequest,
  splitPromptTurn,
} from "../tests/sdk/capture-inference-request.ts";
import { assertVersions } from "../tests/sdk/harness.ts";
import {
  realConfigResumableSession,
  scratchResumableSession,
  warnIfUnsettled,
} from "../tests/sdk/resumable-session.ts";

interface Options {
  sessionFile: string;
  at: UUID | undefined;
  prompt: string | undefined;
  out: string | undefined;
  realConfig: boolean;
  check: boolean;
}

function usage(message: string): never {
  console.error(`capture-api-request: ${message}`);
  console.error(
    "usage: node scripts/capture-api-request.ts <session.jsonl> [--at UUID] [--prompt TEXT] [--out FILE] [--real-config] [--check]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sessionFile: "",
    at: undefined,
    prompt: undefined,
    out: undefined,
    realConfig: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (): string => argv[++index] ?? usage(`${arg} needs a value`);
    if (arg === "--at") {
      options.at = value() as UUID;
    } else if (arg === "--prompt") {
      options.prompt = value();
    } else if (arg === "--out") {
      options.out = value();
    } else if (arg === "--real-config") {
      options.realConfig = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg.startsWith("--")) {
      usage(`unknown flag ${arg}`);
    } else if (options.sessionFile === "") {
      options.sessionFile = arg;
    } else {
      usage("one session file only");
    }
  }
  if (options.sessionFile === "") {
    usage("session file required");
  }
  if (options.realConfig && options.at !== undefined) {
    usage(
      "--real-config cannot be combined with --at (never truncate the real file)",
    );
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.error(`sdk ${assertVersions().sdk}`);
  const nonce = randomUUID().slice(0, 8);
  const prompt = `${options.prompt ?? "Reply with exactly the word pong."} (tag: ${nonce})`;
  let resumableSession;
  try {
    resumableSession = options.realConfig
      ? realConfigResumableSession(options.sessionFile)
      : scratchResumableSession(options.sessionFile, options.at);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  console.error(
    `resuming ${resumableSession.sessionId} in ${resumableSession.cwd} (${resumableSession.entries.length} entries)`,
  );
  warnIfUnsettled(resumableSession.entries);
  let captured;
  try {
    captured = await captureInferenceRequest(resumableSession, prompt, nonce);
  } finally {
    resumableSession.restore();
  }
  console.error(
    `captured ${captured.all.length} requests: ${captured.all.map((request) => request.path).join(", ")}`,
  );
  if (captured.request === undefined) {
    console.error(JSON.stringify(captured.all, null, 2));
    console.error("no /v1/messages request carried the prompt nonce");
    process.exit(1);
  }
  const output = `${JSON.stringify(captured.request.body, null, 2)}\n`;
  if (options.out === undefined && !options.check) {
    process.stdout.write(output);
  } else if (options.out !== undefined) {
    fs.writeFileSync(options.out, output);
    console.error(`wrote ${options.out}`);
  }
  if (!options.check) {
    return;
  }
  const capture = splitPromptTurn(captured.request.body, nonce);
  const conversion = toApiMessages(leafContext(resumableSession.entries), {
    forceMidConversationSystem: capture.systemTail !== undefined,
  });
  const comparison = compareApiMessages(capture, conversion);
  const { promptTurnBlocks, systemText } = comparison.requestTime;
  const persistedLeading = capture.promptTurnLeadingBlocks.slice(
    0,
    capture.promptTurnLeadingBlocks.length - promptTurnBlocks.length,
  );
  const persistedTail =
    systemText === undefined
      ? capture.systemTail
      : systemText === capture.systemTail
        ? undefined
        : capture.systemTail?.slice(0, -(systemText.length + "\n\n".length));
  const checkDir = path.join(
    "/tmp",
    `capture-api-request-${resumableSession.sessionId}`,
  );
  fs.mkdirSync(checkDir, { recursive: true });
  const files = {
    captured: captured.request.body,
    split: capture,
    // The wire without its request-time content, in the synthesized
    // shape: with no differences, `diff captured-messages.json
    // synthesized.json` is empty.
    "captured-messages": [
      ...capture.apiMessages,
      ...(persistedLeading.length === 0
        ? []
        : [{ role: "user", content: persistedLeading }]),
      ...(persistedTail === undefined || persistedTail === ""
        ? []
        : [
            {
              role: "system",
              content: [{ type: "text", text: persistedTail }],
            },
          ]),
    ],
    synthesized: conversion.messages,
    comparison,
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(checkDir, `${name}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  console.error(`wrote ${checkDir}/{${Object.keys(files).join(",")}}.json`);
  const preview = (value: unknown) =>
    JSON.stringify(value)?.slice(0, 80) ?? "undefined";
  for (const difference of comparison.tolerated) {
    console.log(
      `tolerated ${difference.tolerance} ${difference.path}\n  captured:    ${preview(difference.captured)}\n  synthesized: ${preview(difference.synthesized)}`,
    );
  }
  for (const difference of comparison.failing) {
    console.log(
      `FAIL ${difference.path}\n  captured:    ${preview(difference.captured)}\n  synthesized: ${preview(difference.synthesized)}`,
    );
  }
  console.log(
    `${capture.apiMessages.length} captured API messages, ${conversion.messages.length} synthesized; ${comparison.tolerated.length} tolerated, ${comparison.failing.length} failing; request-time: ${comparison.requestTime.promptTurnBlocks.length} prompt-turn blocks${comparison.requestTime.systemText === undefined ? "" : ", system text"}`,
  );
  if (comparison.failing.length > 0) {
    process.exit(1);
  }
}

await main();
