import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  KeybindingsManager,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../../core/generated/text.ts";
import { KEY } from "../../test-support/keys.ts";
import { CLAUCTL_KEYBINDINGS } from "../keybindings.ts";
import { feedbackDenial, type PermissionDialog } from "../permission-dialog.ts";
import { PermissionPromptComponent } from "./permission-prompt.ts";

setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));

/** An `editText` for prompts whose test never opens the external editor. */
const NO_EDITOR = async (): Promise<undefined> => undefined;

const NO: PermissionResult = { behavior: "deny", message: "no" };

const dialog = (
  overrides: Partial<PermissionDialog> = {},
): PermissionDialog => ({
  title: "Bash command",
  body: ["cd /tmp\nmake\nmake install"],
  question: "Do you want to proceed?",
  rows: [
    {
      label: "Yes",
      action: { kind: "decide", decision: { behavior: "allow" } },
    },
  ],
  cancelDecision: NO,
  defaultToNo: false,
  tabAmends: false,
  ...overrides,
});

test("defaultToNo opens on the last row and ignores digits", () => {
  const decisions: PermissionResult[] = [];
  const rows: PermissionDialog["rows"] = [
    {
      label: "Yes",
      action: { kind: "decide", decision: { behavior: "allow" } },
    },
    { label: "No", action: { kind: "decide", decision: NO } },
  ];
  const prompt = new PermissionPromptComponent(
    dialog({ rows, defaultToNo: true }),
    1,
    {
      decide: (d) => decisions.push(d),
      editText: NO_EDITOR,
      editPlan: () => {},
      interrupt: () => {},
    },
  );
  prompt.handleInput("1");
  assert.deepEqual(decisions, []);
  const selectedLine = prompt
    .render(40)
    .map(stripAnsi)
    .find((l) => l.startsWith(" ❯"));
  assert.equal(selectedLine, " ❯ 2. No");
});

test("a body line's own newlines stay separate lines, each indented", () => {
  const lines = new PermissionPromptComponent(dialog(), 1, {
    decide: () => {},
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => {},
  })
    .render(40)
    .map(stripAnsi);
  assert.deepEqual(lines.slice(3, 6), [
    "   cd /tmp",
    "   make",
    "   make install",
  ]);
});

test("a long body line wraps within the width", () => {
  const long = "x ".repeat(40).trim();
  const lines = new PermissionPromptComponent(dialog({ body: [long] }), 1, {
    decide: () => {},
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => {},
  }).render(30);
  assert.ok(lines.length > 6);
  assert.ok(lines.every((line) => visibleWidth(line) <= 30));
});

test("ctrl+c sends the dialog's cancelDecision even without a deny row; Esc interrupts instead", () => {
  const decisions: PermissionResult[] = [];
  let interrupts = 0;
  const prompt = new PermissionPromptComponent(dialog(), 1, {
    decide: (d) => decisions.push(d),
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => interrupts++,
  });
  prompt.handleInput(KEY.escape);
  assert.deepEqual([decisions, interrupts], [[], 1]);
  prompt.handleInput(KEY.ctrlC);
  assert.deepEqual(decisions, [NO]);
});

test("the title's (+N more) follows pendingCount", () => {
  const prompt = new PermissionPromptComponent(dialog(), 1, {
    decide: () => {},
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => {},
  });
  assert.ok(!stripAnsi(prompt.render(40)[1] ?? "").includes("more"));
  prompt.pendingCount = 3;
  assert.ok(stripAnsi(prompt.render(40)[1] ?? "").endsWith("(+2 more)"));
});

type Decided = [PermissionResult, string?];

/** The calls `onDecide` received after `keys`, each with its feedback. */
function decidedAfter(
  dialogUnderTest: PermissionDialog,
  keys: string[],
): Decided[] {
  const decided: Decided[] = [];
  const prompt = new PermissionPromptComponent(dialogUnderTest, 1, {
    decide: (...args) => decided.push(args),
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => {},
  });
  for (const key of keys) prompt.handleInput(key);
  return decided;
}

const DONT_ASK_AGAIN: PermissionResult = {
  behavior: "allow",
  updatedPermissions: [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "make:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ],
};

const amendDialog = dialog({
  tabAmends: true,
  rows: [
    {
      label: "Yes",
      action: { kind: "decide", decision: { behavior: "allow" } },
    },
    {
      label: "Yes, and don't ask again",
      action: { kind: "decide", decision: DONT_ASK_AGAIN },
    },
    { label: "No", action: { kind: "decide", decision: NO } },
  ],
});

test("Tab on an allow row sends that allow with the text as feedback; empty text sends the plain allow", () => {
  assert.deepEqual(decidedAfter(amendDialog, [KEY.tab, ..."ok", KEY.enter]), [
    [{ behavior: "allow" }, "ok"],
  ]);
  assert.deepEqual(decidedAfter(amendDialog, [KEY.tab, KEY.enter]), [
    [{ behavior: "allow" }],
  ]);
  assert.deepEqual(
    decidedAfter(amendDialog, [KEY.down, KEY.tab, ..."ok", KEY.enter]),
    [[DONT_ASK_AGAIN, "ok"]],
  );
});

test("Tab on a deny row sends the feedback deny, native's wording", () => {
  assert.deepEqual(
    decidedAfter(amendDialog, [
      KEY.down,
      KEY.down,
      KEY.tab,
      ..."use ls",
      KEY.enter,
    ]),
    [[feedbackDenial("use ls")]],
  );
});

test("the plan dialog's amend row sends the feedback deny", () => {
  const planDialog = dialog({
    rows: [
      {
        label: "Yes",
        action: { kind: "decide", decision: { behavior: "allow" } },
      },
      { label: "Tell Claude what to change", action: { kind: "amend" } },
    ],
  });
  assert.deepEqual(decidedAfter(planDialog, ["2", ..."smaller", KEY.enter]), [
    [feedbackDenial("smaller")],
  ]);
});

test("ctrl+g in the amend input replaces its text with the editor's", async () => {
  const decided: Decided[] = [];
  const edited: string[] = [];
  let editing: Promise<string> | undefined;
  const prompt = new PermissionPromptComponent(amendDialog, 1, {
    decide: (...args) => decided.push(args),
    editText: (text) => {
      edited.push(text);
      editing = Promise.resolve("from editor");
      return editing;
    },
    editPlan: () => {},
    interrupt: () => {},
  });
  for (const key of [KEY.tab, ..."ok", KEY.ctrlG]) prompt.handleInput(key);
  // The prompt's own continuation was registered first, so it has run.
  await editing;
  prompt.handleInput(KEY.enter);
  assert.deepEqual(edited, ["ok"]);
  assert.deepEqual(decided, [[{ behavior: "allow" }, "from editor"]]);
});

test("ctrl+g on a plan dialog's rows edits the plan file; without a plan file it does nothing", () => {
  const plansEdited: string[] = [];
  const actions = {
    decide: () => assert.fail("no decision"),
    editText: NO_EDITOR,
    editPlan: (planFilePath: string) => plansEdited.push(planFilePath),
    interrupt: () => {},
  };
  new PermissionPromptComponent(
    dialog({ planFilePath: "/tmp/plan.md" }),
    1,
    actions,
  ).handleInput(KEY.ctrlG);
  new PermissionPromptComponent(dialog(), 1, actions).handleInput(KEY.ctrlG);
  assert.deepEqual(plansEdited, ["/tmp/plan.md"]);
});

test("the amend input's hint names the bound keys", () => {
  const prompt = new PermissionPromptComponent(amendDialog, 1, {
    decide: () => {},
    editText: NO_EDITOR,
    editPlan: () => {},
    interrupt: () => {},
  });
  const hint = (): string | undefined =>
    prompt.render(80).map(stripAnsi).at(-1);
  assert.equal(hint(), " Esc to cancel · Tab to amend");
  prompt.handleInput(KEY.tab);
  assert.equal(
    hint(),
    " Enter to send · Esc back to the options · ctrl+g to edit in your editor",
  );
});

test("app.permission.amend follows a remap", () => {
  setKeybindings(
    new KeybindingsManager(CLAUCTL_KEYBINDINGS, {
      "app.permission.amend": "a",
    }),
  );
  try {
    assert.deepEqual(decidedAfter(amendDialog, [KEY.tab, ..."ok", KEY.enter]), [
      [{ behavior: "allow" }],
    ]);
    assert.deepEqual(decidedAfter(amendDialog, ["a", ..."ok", KEY.enter]), [
      [{ behavior: "allow" }, "ok"],
    ]);
  } finally {
    setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));
  }
});
