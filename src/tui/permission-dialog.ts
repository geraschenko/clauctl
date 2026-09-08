/**
 * The pure content of a permission dialog: what `PermissionPromptComponent`
 * renders and what each row decides (docs/specs/permission-prompt.md,
 * "Dialog layout"). The component knows nothing about tools or
 * permissions; a follow-up (AskUserQuestion's answer picker) supplies a
 * different value of the same type.
 */

import type {
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../core/protocol/index.ts";
import type { ToolViewContext } from "../format/entry-view/index.ts";
import {
  type ExitPlanModeInput,
  type PermissionBodyLine,
  permissionViewFor,
} from "./permission-views.ts";

export interface PermissionRow {
  label: string;
  action: { kind: "decide"; decision: PermissionResult } | { kind: "amend" };
}

export interface PermissionDialog {
  title: string;
  body: PermissionBodyLine[];
  question: string;
  rows: PermissionRow[];
  /** What Esc sends. */
  cancelDecision: PermissionResult;
  /** Open on the last row (the decline) and take no digit shortcut. */
  defaultToNo: boolean;
  /** Whether Tab opens the amend input (false for ExitPlanMode, whose
   *  row 3 is the amend action). */
  tabAmends: boolean;
  /** ExitPlanMode only: the file ctrl+g opens in the external editor. */
  planFilePath?: string;
}

/** claude's own plain-deny text, sent verbatim. */
export const PLAIN_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const ALLOW: PermissionResult = { behavior: "allow" };
const PLAIN_DENY: PermissionResult = {
  behavior: "deny",
  message: PLAIN_DENY_MESSAGE,
};

const decide = (label: string, decision: PermissionResult): PermissionRow => ({
  label,
  action: { kind: "decide", decision },
});

/** `updatedInput` carries an edited plan; absent, the ask's input stands. */
const exitPlanModeRows = (
  updatedInput: Record<string, unknown> | undefined,
): PermissionRow[] => [
  decide("Yes, auto-accept edits", {
    behavior: "allow",
    ...(updatedInput === undefined ? {} : { updatedInput }),
    updatedPermissions: [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  }),
  decide("Yes, manually approve edits", {
    behavior: "allow",
    ...(updatedInput === undefined ? {} : { updatedInput }),
  }),
  { label: "Tell Claude what to change", action: { kind: "amend" } },
];

/** Row-2 label per the spec's derivation table; first matching row wins. */
export function suggestionsLabel(
  suggestions: PermissionUpdate[],
  toolName: string,
  cwd: string | undefined,
): string {
  const directories = suggestions.find(
    (update) => update.type === "addDirectories",
  );
  if (directories?.type === "addDirectories") {
    return `Yes, and always allow access to ${directories.directories[0]} from this project`;
  }
  const rules = suggestions.find((update) => update.type === "addRules");
  const rule = rules?.type === "addRules" ? rules.rules[0] : undefined;
  if (rule !== undefined) {
    if (
      rule.toolName === "WebFetch" &&
      rule.ruleContent?.startsWith("domain:")
    ) {
      return `Yes, and don't ask again for ${rule.ruleContent.slice("domain:".length)}`;
    }
    if (
      rule.toolName === "Read" &&
      rules?.destination === "session" &&
      rule.ruleContent !== undefined
    ) {
      const dir = rule.ruleContent.replace(/^\/\//, "/").replace(/\/\*\*$/, "");
      return `Yes, allow reading from ${dir} during this session`;
    }
    return `Yes, and don't ask again for ${rule.ruleContent ?? toolName} in ${cwd ?? "this project"}`;
  }
  if (
    suggestions.length > 0 &&
    suggestions.every(
      (update) => update.type === "setMode" && update.mode === "acceptEdits",
    )
  ) {
    return "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)";
  }
  return "Yes, and don't ask again";
}

/** `editedPlan` (ExitPlanMode, after ctrl+g) replaces the plan shown and
 *  is sent as `updatedInput` on approval. */
export function permissionDialog(
  request: PermissionRequest,
  context: ToolViewContext,
  editedPlan?: string,
): PermissionDialog {
  const view = permissionViewFor(request.toolName, request.displayName);
  if (request.toolName === "ExitPlanMode") {
    const input = request.input as ExitPlanModeInput;
    const updatedInput =
      editedPlan === undefined ? undefined : { ...input, plan: editedPlan };
    const shown = updatedInput ?? input;
    return {
      title: view.title(shown),
      body: view.body(shown, context),
      question: request.title ?? view.question(shown),
      rows: exitPlanModeRows(updatedInput),
      cancelDecision: PLAIN_DENY,
      defaultToNo: request.defaultToNo === true,
      tabAmends: false,
      planFilePath: input.planFilePath,
    };
  }
  const title = view.title(request.input);
  const body = view.body(request.input, context);
  const question = request.title ?? view.question(request.input);
  const rows = [
    decide("Yes", ALLOW),
    ...(request.suggestions.length === 0 ||
    request.suppressAlwaysAllowRule === true
      ? []
      : [
          decide(
            suggestionsLabel(
              request.suggestions,
              request.toolName,
              context.cwd,
            ),
            { behavior: "allow", updatedPermissions: request.suggestions },
          ),
        ]),
    decide("No", PLAIN_DENY),
  ];
  return {
    title,
    body,
    question,
    rows,
    cancelDecision: PLAIN_DENY,
    defaultToNo: request.defaultToNo === true,
    tabAmends: true,
  };
}
