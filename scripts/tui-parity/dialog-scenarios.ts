/**
 * Permission-dialog scenarios for the TUI parity harness
 * (docs/specs/permission-prompt.md, "Parity harness"): each prompt makes
 * haiku raise exactly one permission ask, which capture-dialogs.ts captures
 * on both sides and never approves.
 *
 * `claudeArgs` are claude CLI flags; clauctl's `spawn -- …` forwards the
 * same flags to its claude child, so one list configures both sides.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workdirBase } from "./capture.ts";

export interface DialogScenario {
  /** Slug; output filenames and the per-scenario workdir derive from it. */
  name: string;
  description: string;
  /** Sent as the initial prompt; may depend on the per-scenario workdir. */
  prompt: string | ((cwd: string) => string);
  /** Runs in the freshly wiped workdir before either side launches. */
  setup?(cwd: string): void;
  claudeArgs?: string[];
  /** Claude side only (no clauctl counterpart yet; see
   *  docs/follow-ups/permission-cli.md for AskUserQuestion). */
  claudeOnly?: boolean;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Targets outside every workdir, so Read/rm asks carry directory
 *  suggestions; recreated by the scenarios that use them. */
const OUTSIDE_DIR = "/tmp/clauctl-tui-parity-outside";
const VICTIM_DIR = "/tmp/clauctl-tui-parity-victim";

/**
 * The `ask-rule` scenario's command; capture-dialogs.ts pins a
 * `permissions.ask` rule for exactly this command in the isolated settings
 * so the ask arrives without suggestions (spec: no-row-2 numbering).
 */
export const ASK_RULE_COMMAND = "echo parity-ask-rule";

/** `--mcp-config` takes a file on both sides (the native CLI's flag is
 *  variadic, so inline JSON would swallow the prompt that follows). */
const MCP_CONFIG_PATH = join(workdirBase, "mcp-greet.json");
const writeMcpConfig = (): void =>
  writeFileSync(
    MCP_CONFIG_PATH,
    JSON.stringify({
      mcpServers: {
        probe: {
          command: process.execPath,
          args: [join(scriptDir, "mcp-greet-server.ts")],
        },
      },
    }),
  );

export const dialogScenarios: DialogScenario[] = [
  {
    name: "bash-outside",
    description: "Bash ask with a directory suggestion (rm outside cwd)",
    setup: () => mkdirSync(VICTIM_DIR, { recursive: true }),
    prompt: `Use the Bash tool to run \`rm -rf ${VICTIM_DIR}\`.`,
  },
  {
    name: "bash-incwd",
    description: "Bash ask for a command inside the workdir",
    prompt:
      "Use the Bash tool to run `touch created.txt` in the current directory.",
  },
  {
    name: "bash-plain",
    description: "Bash ask with a command rule suggestion, no directory",
    prompt:
      "Use the Bash tool to run `curl -sI https://example.com` and report the status line.",
  },
  {
    name: "ask-rule",
    description: "suggestion-less ask forced by a permissions.ask rule",
    prompt: `Use the Bash tool to run \`${ASK_RULE_COMMAND}\` and report the output.`,
  },
  {
    name: "edit",
    description: "Edit ask: replacement diff",
    setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "hello world\n"),
    prompt: (cwd) =>
      `Use the Edit tool to replace 'hello' with 'goodbye' in ${cwd}/a.txt.`,
  },
  {
    name: "write",
    description: "Write ask: numbered content preview",
    prompt: (cwd) =>
      `Use the Write tool to create ${cwd}/b.txt containing the single line 'hi'.`,
  },
  {
    name: "read-outside",
    description: "Read ask outside the workdir (session directory rule)",
    setup: () => {
      mkdirSync(OUTSIDE_DIR, { recursive: true });
      writeFileSync(join(OUTSIDE_DIR, "secret.txt"), "outside secret\n");
    },
    prompt: `Use the Read tool to read ${OUTSIDE_DIR}/secret.txt.`,
  },
  {
    name: "webfetch",
    description: "WebFetch ask (domain rule suggestion)",
    prompt:
      "Use the WebFetch tool to fetch https://example.com and tell me its title.",
  },
  {
    name: "mcp",
    description: "MCP tool ask (stdio server, displayName title)",
    setup: writeMcpConfig,
    claudeArgs: ["--mcp-config", MCP_CONFIG_PATH],
    prompt:
      "Call the mcp__probe__greet tool with name 'Anton' and report the result.",
  },
  {
    name: "plan",
    description: "ExitPlanMode ask: plan body, three rows, no Tab amend",
    claudeArgs: ["--permission-mode", "plan"],
    prompt:
      "Make a one-line plan to create a file c.txt, then call ExitPlanMode to get my approval.",
  },
  {
    name: "askuser",
    description: "AskUserQuestion's answer picker (claude only)",
    claudeOnly: true,
    prompt:
      "Use the AskUserQuestion tool to ask me whether I prefer cats or dogs.",
  },
];
