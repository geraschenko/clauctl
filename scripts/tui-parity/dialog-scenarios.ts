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
  /** tmux key names sent once the dialog is captured; the screen they lead
   *  to is captured and diffed too (`<name>.keys.*`). */
  keysAtDialog?: string[];
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
const ASK_RULE_PROMPT = `Use the Bash tool to run \`${ASK_RULE_COMMAND}\` and report the output.`;

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

/** Pet (single-select: Cats, Dogs), then Colors (multi-select). */
const ASKUSER_MULTI_PROMPT =
  'Call the AskUserQuestion tool once with two questions: first "Do you prefer cats or dogs?" (header "Pet", options Cats and Dogs, single-select), then "Which colors do you like?" (header "Colors", options Red, Blue and Green, multiSelect true).';

/** One preview-layout question: Grid has a preview, List none. */
const ASKUSER_PREVIEW_PROMPT =
  'Call the AskUserQuestion tool once with one single-select question "Which layout?" (header "Layout") and two options: "Grid" with preview "# Grid\\n\\nItems in **cells**." and "List" with no preview.';

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
    prompt: ASK_RULE_PROMPT,
  },
  {
    name: "amend-yes-typing",
    description: "Tab on Yes opens the amend input; text typed into it",
    prompt: ASK_RULE_PROMPT,
    keysAtDialog: ["Tab", "o", "k"],
  },
  {
    name: "amend-yes",
    description: "Tab on Yes, text, Enter: the tool runs with the text",
    prompt: ASK_RULE_PROMPT,
    keysAtDialog: ["Tab", "o", "k", "Enter"],
  },
  {
    name: "amend-no",
    description: "Tab on No, text, Enter: a deny carrying the text",
    prompt: ASK_RULE_PROMPT,
    keysAtDialog: ["Down", "Tab", "o", "k", "Enter"],
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
    description: "AskUserQuestion, one single-select question",
    prompt:
      "Use the AskUserQuestion tool to ask me whether I prefer cats or dogs.",
  },
  {
    name: "askuser-esc",
    description: "AskUserQuestion, Esc in selection mode",
    prompt:
      "Use the AskUserQuestion tool to ask me whether I prefer cats or dogs.",
    keysAtDialog: ["Escape"],
  },
  {
    name: "askuser-multi",
    description: "AskUserQuestion, two questions, the second multi-select",
    prompt: ASKUSER_MULTI_PROMPT,
  },
  {
    name: "askuser-preview",
    description: "AskUserQuestion, preview layout",
    prompt: ASKUSER_PREVIEW_PROMPT,
  },
  {
    name: "askuser-revisit",
    description:
      "AskUserQuestion keys: answer Pet with Dogs, then ← back to it (✔ on revisit, cursor on return, ← switches tabs)",
    prompt: ASKUSER_MULTI_PROMPT,
    keysAtDialog: ["Down", "Enter", "Left"],
  },
  {
    name: "askuser-digit",
    description: "AskUserQuestion keys: digit 2 on the Pet tab",
    prompt: ASKUSER_MULTI_PROMPT,
    keysAtDialog: ["2"],
  },
  {
    name: "askuser-tab",
    description: "AskUserQuestion keys: Tab on the Pet tab",
    prompt: ASKUSER_MULTI_PROMPT,
    keysAtDialog: ["Tab"],
  },
  {
    name: "askuser-submit-tab",
    description: "AskUserQuestion keys: answer Pet, → to the Submit tab",
    prompt: ASKUSER_MULTI_PROMPT,
    keysAtDialog: ["2", "Right"],
  },
  {
    name: "askuser-submit-cancel",
    description: "AskUserQuestion keys: the Submit tab's second row",
    prompt: ASKUSER_MULTI_PROMPT,
    keysAtDialog: ["2", "Right", "Down", "Enter"],
  },
  {
    name: "askuser-notes-enter",
    description:
      "AskUserQuestion keys: type notes on the List row of a preview question, then Enter",
    prompt: ASKUSER_PREVIEW_PROMPT,
    keysAtDialog: ["Down", "n", "o", "k", "Enter"],
  },
];
