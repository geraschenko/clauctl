/**
 * InteractiveMode's permission-dialog glue, observed as a user would: keys
 * go in through the terminal, assertions read the rendered screen (the
 * harness docs/follow-ups/old/interactive-mode-test-harness.md asks for,
 * limited to the paths docs/specs/permission-prompt.md needs). Fixture:
 * the `bash-safety-default` derisk probe ask (docs/derisk/permission-prompt/out).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { initialAgentState } from "../core/agent-state/index.ts";
import { stripAnsi } from "../core/generated/text.ts";
import type { ProtocolClient } from "../core/protocol-client/index.ts";
import { permissionRequestOf } from "../core/protocol-server/index.ts";
import type {
  AgentState,
  PermissionRequest,
  ProtocolRequest,
} from "../core/protocol/index.ts";
import { InteractiveMode } from "./interactive-mode.ts";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `get-entries` and `supported-models` settle when the test says so. */
function scriptedClient(): {
  client: ProtocolClient;
  history: { resolve: (value: unknown) => void };
  models: { resolve: (value: unknown) => void };
  sent: ProtocolRequest[];
} {
  const history = deferred<unknown>();
  const models = deferred<unknown>();
  const sent: ProtocolRequest[] = [];
  const client = {
    request(request: ProtocolRequest): Promise<unknown> {
      sent.push(request);
      if (request.type === "initialization-result") {
        return Promise.resolve({ commands: [] });
      }
      if (request.type === "supported-models") return models.promise;
      return Promise.resolve(undefined);
    },
    requestWithEventCount(): Promise<{ data: unknown; eventsBefore: number }> {
      return history.promise.then((data) => ({ data, eventsBefore: 0 }));
    },
  } as unknown as ProtocolClient;
  return { client, history, models, sent };
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
  return permissionRequestOf(ask.toolName, ask.input, {
    ...ask.options,
    signal: new AbortController().signal,
  });
}

const SETTINGS = {
  tuiMode: "fullscreen" as const,
  showResolvedBoundary: false,
  tree: { showSizes: true },
};

/** The fixture ask's dialog, recognizable on screen by its question. */
const DIALOG_QUESTION = "Do you want to proceed?";
const MODEL_SELECTOR_HEADER = "select model (";

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

test("a /model fetch that completes while the dialog is up opens no selector", async () => {
  const ask = probeAsk();
  const { mode, screen, sendKeys, history, models, sent } =
    mount(initialAgentState());
  history.resolve({ entries: [] });
  await settle();
  sendKeys("/model");
  // Enter is a chunk of its own; "\r" is what the key sends in raw mode
  // ("\n" is ctrl+j).
  sendKeys("\r");
  assert.ok(sent.some((request) => request.type === "supported-models"));
  mode.handleEvent(
    { kind: "permissionRequested", uuid: crypto.randomUUID(), request: ask },
    { ...initialAgentState(), pendingPermissions: [ask] },
  );
  models.resolve([{ value: "m", displayName: "m", description: "" }]);
  await settle();
  const shown = screen();
  assert.ok(shown.includes(DIALOG_QUESTION));
  assert.ok(!shown.includes(MODEL_SELECTOR_HEADER));
});
