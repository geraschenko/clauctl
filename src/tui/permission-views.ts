/**
 * Per-tool permission dialog content (title / body / question), replicating
 * claude's prompts (scripts/tui-parity/capture-dialogs.ts captures the
 * bundled version's dialogs).
 * TUI-specific — a dialog, not transcript formatting — so it lives beside
 * the dialog rather than on the transcript's ToolView. Keyed by the
 * generated input types like toolViews; a tool without a view gets the
 * generic view: `Name(headerArg)` then one `key: value` line per input key.
 */

import { basename } from "node:path";
import {
  stringArg,
  type ToolInputMap,
  type ToolName,
  type ToolViewContext,
  toolViewFor,
} from "../format/entry-view/index.ts";

/** A body line the component widens to a full-width `╌` rule. */
export const DASHED_RULE = "╌";

/** A plain line (styled through `context.style`, wrapped by the component)
 *  or a markdown block the component renders. */
export type PermissionBodyLine = string | { markdown: string };

export interface PermissionView<A> {
  title(args: A): string;
  question(args: A): string;
  /** Body lines; the component indents and rules them. */
  body(args: A, context: ToolViewContext): PermissionBodyLine[];
}

/** ExitPlanMode is not among the generated tool inputs. */
export interface ExitPlanModeInput {
  plan?: string;
  /** claude's own copy of the plan, what ctrl+g edits. */
  planFilePath?: string;
}

const PROCEED = "Do you want to proceed?";

const lines = (text: string): string[] => text.split("\n");

export const permissionViews: {
  [K in ToolName]?: PermissionView<ToolInputMap[K]>;
} & { ExitPlanMode: PermissionView<ExitPlanModeInput> } = {
  // Decided divergence: claude puts the description under the command;
  // the title carries it here so the body is the command alone.
  Bash: {
    title(args) {
      const description = stringArg(args, "description");
      return description === undefined
        ? "Bash command"
        : `Bash: ${description}`;
    },
    question: () => PROCEED,
    body: (args) => [stringArg(args, "command") ?? ""],
  },
  Edit: {
    title: () => "Edit file",
    question: (args) =>
      `Do you want to make this edit to ${basename(stringArg(args, "file_path") ?? "")}?`,
    // Decided divergence from claude's numbered file diff: the replacement
    // itself, unnumbered (the diff exists only once the tool has run).
    body(args, { style }) {
      return [
        basename(stringArg(args, "file_path") ?? ""),
        DASHED_RULE,
        ...lines(stringArg(args, "old_string") ?? "").map((line) =>
          style.error(`-${line}`),
        ),
        ...lines(stringArg(args, "new_string") ?? "").map((line) =>
          style.success(`+${line}`),
        ),
        DASHED_RULE,
      ];
    },
  },
  Write: {
    title: () => "Create file",
    question: (args) =>
      `Do you want to create ${basename(stringArg(args, "file_path") ?? "")}?`,
    body(args, { style }) {
      const content = lines(stringArg(args, "content") ?? "");
      const width = String(content.length).length;
      return [
        basename(stringArg(args, "file_path") ?? ""),
        DASHED_RULE,
        ...content.map(
          (line, index) =>
            `${style.dim(String(index + 1).padStart(width))} ${line}`,
        ),
        DASHED_RULE,
      ];
    },
  },
  Read: {
    title: () => "Read file",
    question: () => PROCEED,
    body: (args) => [`Read(${stringArg(args, "file_path") ?? ""})`],
  },
  // Decided divergence: the url is the title (claude: a `url:` body line).
  WebFetch: {
    title: (args) => `Fetch: ${stringArg(args, "url") ?? ""}`,
    question: () => "Do you want to allow Claude to fetch this content?",
    body(args) {
      const url = stringArg(args, "url") ?? "";
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        // Not a URL: the raw text names the host well enough.
      }
      return [
        `prompt: ${stringArg(args, "prompt") ?? ""}`,
        `Claude wants to fetch content from ${host}`,
      ];
    },
  },
  ExitPlanMode: {
    title: () => "Ready to code?",
    question: () =>
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    body: (args) => [
      "Here is Claude's plan:",
      DASHED_RULE,
      { markdown: stringArg(args, "plan") ?? "" },
      DASHED_RULE,
    ],
  },
};

function genericPermissionView(
  toolName: string,
  displayName: string | undefined,
): PermissionView<Record<string, unknown>> {
  return {
    title: () => displayName ?? toolName,
    question: () => PROCEED,
    body(args, context) {
      const arg = toolViewFor(toolName).header(args, context).arg;
      return [
        arg === undefined ? toolName : `${toolName}(${arg})`,
        ...Object.entries(args).map(
          ([key, value]) => `${key}: ${JSON.stringify(value)}`,
        ),
      ];
    },
  };
}

/** The type-erasure point (as toolViewFor): callers hold the wire input as
 *  unknown; lookup by own property so a tool named `constructor` falls back
 *  to the generic view. */
export function permissionViewFor(
  toolName: string,
  displayName: string | undefined,
): PermissionView<unknown> {
  const view = Object.hasOwn(permissionViews, toolName)
    ? (permissionViews as Record<string, PermissionView<unknown> | undefined>)[
        toolName
      ]
    : undefined;
  return (
    view ??
    (genericPermissionView(toolName, displayName) as PermissionView<unknown>)
  );
}
