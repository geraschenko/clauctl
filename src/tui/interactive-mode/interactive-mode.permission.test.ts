/**
 * InteractiveMode's permission-dialog glue, observed as a user would: keys
 * go in through the terminal, assertions read the rendered screen (the
 * harness docs/follow-ups/old/interactive-mode-test-harness.md asks for,
 * limited to the paths docs/specs/permission-prompt.md needs). Fixture:
 * the `bash-safety-default` derisk probe ask (docs/derisk/permission-prompt/out).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  KeybindingsManager,
  setKeybindings,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { initialAgentState } from "../../core/agent-state/index.ts";
import { stripAnsi } from "../../core/generated/text.ts";
import { KEY } from "../../test-support/keys.ts";
import type { ProtocolClient } from "../../core/protocol-client/index.ts";
import { permissionRequestOf } from "../../core/protocol-server/index.ts";
import type {
  AgentState,
  PermissionRequest,
  ProtocolRequest,
} from "../../core/protocol/index.ts";
import { InteractiveMode } from "./interactive-mode.ts";
import { CLAUCTL_KEYBINDINGS } from "../keybindings.ts";

setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));

/**
 * A terminal that draws nowhere and lets the test type. Each `sendKeys`
 * call is one input chunk, which pi-tui treats as one key event (its key
 * matching runs on the whole chunk; only bracketed paste is split), so a
 * key like Enter must be sent on its own — as a raw-mode terminal does.
 */
class ScriptedTerminal implements Terminal {
  readonly columns = 100;
  readonly rows = 40;
  readonly kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;

  sendKeys(data: string): void {
    assert.ok(this.onInput, "the TUI has not started");
    this.onInput(data);
  }

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** `get-entries` and each `supported-models` request settle when the test
 *  says so; `modelFetches` holds one deferred per request, in order. */
function scriptedClient(): {
  client: ProtocolClient;
  history: { resolve: (value: unknown) => void };
  modelFetches: Deferred<unknown>[];
  sent: ProtocolRequest[];
} {
  const history = deferred<unknown>();
  const modelFetches: Deferred<unknown>[] = [];
  const sent: ProtocolRequest[] = [];
  const client = {
    request(request: ProtocolRequest): Promise<unknown> {
      sent.push(request);
      if (request.type === "initialization-result") {
        return Promise.resolve({ commands: [] });
      }
      if (request.type === "supported-models") {
        const modelFetch = deferred<unknown>();
        modelFetches.push(modelFetch);
        return modelFetch.promise;
      }
      return Promise.resolve(undefined);
    },
    requestWithEventCount(): Promise<{ data: unknown; eventsBefore: number }> {
      return history.promise.then((data) => ({ data, eventsBefore: 0 }));
    },
  } as unknown as ProtocolClient;
  return { client, history, modelFetches, sent };
}

function probeAsk(): PermissionRequest {
  const probe = JSON.parse(
    readFileSync(
      "docs/derisk/permission-prompt/out/bash-safety-default.json",
      "utf8",
    ),
  ) as {
    asks: Array<{
      toolName: string;
      input: Record<string, unknown>;
      options: Omit<Parameters<CanUseTool>[2], "signal">;
    }>;
  };
  const ask = probe.asks[0]!;
  return permissionRequestOf(
    ask.toolName,
    ask.input,
    {
      ...ask.options,
      signal: new AbortController().signal,
    },
    0,
  );
}

const SETTINGS = {
  tuiMode: "fullscreen" as const,
  showResolvedBoundary: false,
  tree: { showSizes: true },
};

/** The fixture ask's dialog, recognizable on screen by its question. */
const DIALOG_QUESTION = "Do you want to proceed?";
const MODEL_SELECTOR_HEADER = "select model (";
const MODELS = [{ value: "m", displayName: "m", description: "" }];

function mount(seed: AgentState) {
  const scripted = scriptedClient();
  const terminal = new ScriptedTerminal();
  const ui = new TuiMainScreen(terminal);
  const mode = new InteractiveMode(ui, scripted.client, seed, [], SETTINGS);
  ui.start();
  const screen = (): string =>
    ui.render(terminal.columns).map(stripAnsi).join("\n");
  return {
    mode,
    ui,
    screen,
    sendKeys: (data: string) => terminal.sendKeys(data),
    ...scripted,
  };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("an ask in the attach seed shows the dialog before history replays", async () => {
  const ask = probeAsk();
  const seed = { ...initialAgentState(), pendingPermissions: [ask] };
  const { mode, screen, sendKeys, history } = mount(seed);
  assert.ok(screen().includes(DIALOG_QUESTION));
  history.resolve({ entries: [] });
  await settle();
  assert.ok(screen().includes(DIALOG_QUESTION));
  mode.handleEvent(
    {
      kind: "permissionResolved",
      uuid: crypto.randomUUID(),
      toolUseId: ask.toolUseId,
      resolution: { behavior: "allow" },
    },
    initialAgentState(),
  );
  assert.ok(!screen().includes(DIALOG_QUESTION));
  sendKeys("typed after the dialog closed");
  assert.ok(
    screen().includes("typed after the dialog closed"),
    "the editor is back and focused",
  );
});

test("an ask arriving during history replay shows once the replay ends", async () => {
  const ask = probeAsk();
  const { mode, screen, history } = mount(initialAgentState());
  const blocked = { ...initialAgentState(), pendingPermissions: [ask] };
  mode.handleEvent(
    { kind: "permissionRequested", uuid: crypto.randomUUID(), request: ask },
    blocked,
  );
  assert.ok(!screen().includes(DIALOG_QUESTION), "held back with the replay");
  history.resolve({ entries: [] });
  await settle();
  assert.ok(screen().includes(DIALOG_QUESTION));
});

test("Esc in the question dialog's notes mode returns to selection instead of interrupting", async () => {
  const ask = permissionRequestOf(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Which layout?",
          header: "Layout",
          multiSelect: false,
          options: [
            { label: "Grid", description: "", preview: "Grid preview" },
            { label: "List", description: "" },
          ],
        },
      ],
    },
    {
      signal: new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "req_q",
    },
    0,
  );
  const seed = { ...initialAgentState(), pendingPermissions: [ask] };
  const { screen, sendKeys, history, sent } = mount(seed);
  history.resolve({ entries: [] });
  await settle();
  const interrupts = (): number =>
    sent.filter((request) => request.type === "interrupt").length;
  sendKeys("n");
  sendKeys("x");
  sendKeys(KEY.escape);
  assert.equal(interrupts(), 0);
  assert.ok(screen().includes("Notes: x"));
  assert.ok(screen().includes("n to add notes · Esc to cancel"));
  sendKeys(KEY.escape);
  assert.equal(interrupts(), 1, "Esc in selection mode interrupts");
});

test("Esc in the permission dialog's amend input closes it instead of interrupting", async () => {
  const seed = { ...initialAgentState(), pendingPermissions: [probeAsk()] };
  const { screen, sendKeys, history, sent } = mount(seed);
  history.resolve({ entries: [] });
  await settle();
  const interrupts = (): number =>
    sent.filter((request) => request.type === "interrupt").length;
  sendKeys(KEY.tab);
  sendKeys("x");
  sendKeys(KEY.escape);
  assert.equal(interrupts(), 0);
  assert.ok(screen().includes(DIALOG_QUESTION));
  sendKeys(KEY.escape);
  assert.equal(interrupts(), 1, "Esc on the rows interrupts");
});

test("a resolved AskUserQuestion ask adds no banner; other asks do", async () => {
  const question = permissionRequestOf(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Cats or dogs?",
          header: "Pet",
          multiSelect: false,
          options: [
            { label: "Cats", description: "" },
            { label: "Dogs", description: "" },
          ],
        },
      ],
    },
    {
      signal: new AbortController().signal,
      toolUseID: "toolu_pet",
      requestId: "req_pet",
    },
    0,
  );
  const bash = probeAsk();
  const seed = {
    ...initialAgentState(),
    pendingPermissions: [question, bash],
  };
  const { mode, screen, history } = mount(seed);
  history.resolve({ entries: [] });
  await settle();
  mode.handleEvent(
    {
      kind: "permissionResolved",
      uuid: crypto.randomUUID(),
      toolUseId: question.toolUseId,
      resolution: { behavior: "allow" },
    },
    { ...initialAgentState(), pendingPermissions: [bash] },
  );
  assert.ok(!screen().includes("permission allowed"));
  mode.handleEvent(
    {
      kind: "permissionResolved",
      uuid: crypto.randomUUID(),
      toolUseId: bash.toolUseId,
      resolution: { behavior: "allow" },
    },
    initialAgentState(),
  );
  assert.ok(screen().includes("permission allowed"));
});

test("a /model fetch that completes while the dialog is up opens no selector", async () => {
  const ask = probeAsk();
  const { mode, screen, sendKeys, history, modelFetches } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  sendKeys("/model");
  // Enter is a chunk of its own; "\r" is what the key sends in raw mode
  // ("\n" is ctrl+j).
  sendKeys(KEY.enter);
  assert.equal(modelFetches.length, 1);
  mode.handleEvent(
    { kind: "permissionRequested", uuid: crypto.randomUUID(), request: ask },
    { ...initialAgentState(), pendingPermissions: [ask] },
  );
  modelFetches[0]!.resolve(MODELS);
  await settle();
  const shown = screen();
  assert.ok(shown.includes(DIALOG_QUESTION));
  assert.ok(!shown.includes(MODEL_SELECTOR_HEADER));
});

/** Type a slash command and submit it (Enter is a chunk of its own). */
function runCommand(sendKeys: (data: string) => void, command: string): void {
  sendKeys(command);
  sendKeys(KEY.enter);
}

test("a selector replaces the editor; Esc restores the editor with its text", async () => {
  const { screen, sendKeys, history, modelFetches } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  runCommand(sendKeys, "/model");
  sendKeys("draft");
  modelFetches[0]!.resolve(MODELS);
  await settle();
  assert.ok(screen().includes(MODEL_SELECTOR_HEADER));
  assert.ok(!screen().includes("draft"), "the editor left the slot");
  sendKeys(KEY.escape);
  assert.ok(!screen().includes(MODEL_SELECTOR_HEADER));
  sendKeys("!");
  assert.ok(screen().includes("draft!"), "the editor is back and focused");
});

test("/tree supersedes a pending /model even with no session file to show", async () => {
  const { screen, sendKeys, history, modelFetches } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  runCommand(sendKeys, "/model");
  runCommand(sendKeys, "/tree");
  assert.ok(screen().includes("no session file to navigate yet"));
  modelFetches[0]!.resolve(MODELS);
  await settle();
  assert.ok(!screen().includes(MODEL_SELECTOR_HEADER));
});

test("an ask that arrives and resolves while /model is pending supersedes it", async () => {
  const ask = probeAsk();
  const { mode, screen, sendKeys, history, modelFetches } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  runCommand(sendKeys, "/model");
  mode.handleEvent(
    { kind: "permissionRequested", uuid: crypto.randomUUID(), request: ask },
    { ...initialAgentState(), pendingPermissions: [ask] },
  );
  mode.handleEvent(
    {
      kind: "permissionResolved",
      uuid: crypto.randomUUID(),
      toolUseId: ask.toolUseId,
      resolution: { behavior: "allow" },
    },
    initialAgentState(),
  );
  modelFetches[0]!.resolve(MODELS);
  await settle();
  assert.ok(!screen().includes(MODEL_SELECTOR_HEADER));
});

test("a superseded /model that fails still shows its banner and leaves the newer request pending", async () => {
  const { screen, sendKeys, history, modelFetches } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  runCommand(sendKeys, "/model");
  runCommand(sendKeys, "/model");
  modelFetches[0]!.reject(new Error("first fetch lost"));
  await settle();
  assert.ok(screen().includes("first fetch lost"));
  modelFetches[1]!.resolve(MODELS);
  await settle();
  assert.ok(screen().includes(MODEL_SELECTOR_HEADER));
});

test("/effort LEVEL whose fetch returns while an ask prompt is up still sends", async () => {
  const ask = probeAsk();
  const seed = { ...initialAgentState(), model: "m" };
  const { mode, screen, sendKeys, history, modelFetches, sent } = mount(seed);
  history.resolve({ entries: [] });
  await settle();
  runCommand(sendKeys, "/effort high");
  mode.handleEvent(
    { kind: "permissionRequested", uuid: crypto.randomUUID(), request: ask },
    { ...seed, pendingPermissions: [ask] },
  );
  modelFetches[0]!.resolve([
    { ...MODELS[0], supportedEffortLevels: ["low", "high"] },
  ]);
  await settle();
  assert.deepEqual(
    sent.filter((request) => request.type === "apply-flag-settings"),
    [{ type: "apply-flag-settings", settings: { effortLevel: "high" } }],
  );
  assert.ok(screen().includes(DIALOG_QUESTION));
});

test("a plan edit finishing after its ask was resolved leaves the newer prompt as it is", async () => {
  const planFilePath = join(mkdtempSync(join(tmpdir(), "plan-")), "plan.md");
  writeFileSync(planFilePath, "edited plan");
  const plan = permissionRequestOf(
    "ExitPlanMode",
    { plan: "original plan", planFilePath },
    {
      signal: new AbortController().signal,
      toolUseID: "toolu_plan",
      requestId: "req_plan",
    },
    0,
  );
  const bash = probeAsk();
  const seed = { ...initialAgentState(), pendingPermissions: [plan, bash] };
  const { mode, ui, screen, sendKeys, history } = mount(seed);
  history.resolve({ entries: [] });
  await settle();
  // `true` exits 0 without touching the file; its exit arrives only after
  // the synchronous steps below.
  const savedEnv = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  delete process.env.VISUAL;
  process.env.EDITOR = "true";
  const editorDone = new Promise<void>((resolve) => {
    const start = ui.start.bind(ui);
    ui.start = () => {
      start();
      resolve();
    };
  });
  try {
    sendKeys(KEY.ctrlG);
    mode.handleEvent(
      {
        kind: "permissionResolved",
        uuid: crypto.randomUUID(),
        toolUseId: plan.toolUseId,
        resolution: { behavior: "allow" },
      },
      { ...initialAgentState(), pendingPermissions: [bash] },
    );
    // In-progress state on the newer head: the amend input with text.
    sendKeys(KEY.tab);
    sendKeys("kept");
    await editorDone;
    await settle();
  } finally {
    process.env.EDITOR = savedEnv.EDITOR;
    if (savedEnv.EDITOR === undefined) delete process.env.EDITOR;
    if (savedEnv.VISUAL !== undefined) process.env.VISUAL = savedEnv.VISUAL;
  }
  assert.ok(screen().includes(DIALOG_QUESTION));
  assert.ok(screen().includes("kept"), "the bash prompt was not remounted");
});
