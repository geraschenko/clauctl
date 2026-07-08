/**
 * The interactive mode: assembly + event dispatch, mirroring the shape of
 * pi's interactive-mode.ts (single event switch dispatching to components)
 * at a fraction of the size — everything pi-core-specific (extensions,
 * session trees, model registry, settings, auth) has no counterpart here.
 * All claude-specificity of *content* lives in sdk-render.ts; this file owns
 * layout, keybindings, and the SdkEvent → component dispatch.
 *
 * TDC: Don't put crap like this in comments. I don't want comments documenting rejected plans or future plans. Comments should document how the code is actually _currently_ organized, and only talk about alternatives when a developer reading the _current_ code would naturally ask why it's not shaped a different way. No developer would read "interactive mode" and ask "why isn't this called 'attach'". Do a thorough audit of the whole repo looking for comments like this; I want to get rid of them.
 * The name is "interactive mode", not "attach": `clauctl attach` is reserved
 * for the future tty.sock client (see docs/specs/tui.md, "Architecture").
 */

import {
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  commandNoTarget,
  requiredStringFlag,
  type InferFlags,
} from "../core/generated/cli.ts";
import type { CommandContext } from "../core/generated/targets.ts";
import {
  isBusy,
  nextAssistantState,
  type AssistantState,
} from "../core/assistant-state.ts";
import {
  SdkSocketClient,
  type SdkEvent,
  type StateSnapshot,
} from "../core/sdk-socket.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { FooterComponent } from "./components/footer.ts";
import { PendingMessagesComponent } from "./components/pending-messages.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import {
  beginMessage,
  foldStreamEvent,
  renderAssistant,
  toolResultsOf,
  userText,
  type StreamingMessage,
} from "./sdk-render.ts";
import { getEditorTheme, theme } from "./theme.ts";

const CTRL_C_EXIT_WINDOW_MS = 2_000;

const tuiFlags = {
  sdkSocket: requiredStringFlag("Path to the agent's sdk.sock", "path"),
};

type TuiFlags = InferFlags<typeof tuiFlags>;

/**
 * `clauctl _tui --sdk-socket <path>` — internal
 * Used by the daemon inside a pty and proxy the terminal bytes over tty.sock.
 */
export const tuiRoute = {
  _tui: commandNoTarget<TuiFlags>({
    docs: { brief: "run the interactive terminal UI against an sdk.sock" },
    parameters: { flags: tuiFlags },
    func: async function (this: CommandContext, flags: TuiFlags) {
      const client = await SdkSocketClient.connect(flags.sdkSocket);
      await runInteractive(client);
    },
  }),
} as const;

interface StreamingComponent {
  component: AssistantMessageComponent;
  state: StreamingMessage;
}

/**
 * Connect the TUI to a subscribed client. Owns the subscribe ordering: events
 * may be delivered before the snapshot promise settles (SdkSocketClient
 * contract), so they buffer in a closure until InteractiveMode exists — the
 * same gating `tail` does. Resolves on detach (double Ctrl+C) or when the
 * daemon closes the socket; the agent keeps running either way.
 * TDC: huh? The daemon should only close the socket if the agent is dead, right?
 */
export async function runInteractive(client: SdkSocketClient): Promise<void> {
  const buffered: SdkEvent[] = [];
  let handleEvent = (event: SdkEvent): void => {
    buffered.push(event);
  };
  // TDC: "snapshot" and "mode" are terrible names. Why would you choose names that don't describe what they are?
  const stateSnapshot = await client.subscribe((event) => handleEvent(event));
  const ui = new TUI(new ProcessTerminal());
  const interactiveMode = new InteractiveMode(ui, client, stateSnapshot);
  handleEvent = (event) => interactiveMode.handleEvent(event);
  for (const event of buffered.splice(0)) {
    interactiveMode.handleEvent(event);
  }
  ui.start();
  try {
    await Promise.race([interactiveMode.done, client.waitClosed()]);
  } finally {
    ui.stop();
    client.close();
  }
}

class InteractiveMode {
  readonly done: Promise<void>;
  private finish!: () => void;

  private readonly ui: TUI;
  private readonly client: SdkSocketClient;
  private assistantState: AssistantState;

  private readonly chatContainer = new Container();
  private readonly pendingMessages = new PendingMessagesComponent();
  private readonly statusContainer = new Container();
  private readonly hintText = new Text("", 1, 0);
  private readonly loader: Loader;
  private readonly editor: Editor;
  private readonly footer = new FooterComponent();

  /** Live streaming component per parent_tool_use_id ("" = top level). */
  private readonly streaming = new Map<string, StreamingComponent>();
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  private lastCtrlCAt = 0;

  constructor(ui: TUI, client: SdkSocketClient, stateSnapshot: StateSnapshot) {
    this.ui = ui;
    this.client = client;
    this.assistantState = stateSnapshot.assistantState;
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });

    this.loader = new Loader(
      ui,
      (text: string) => theme.fg("accent", text),
      (text: string) => theme.fg("dim", text),
    );
    this.editor = new Editor(ui, getEditorTheme());
    this.editor.onSubmit = (text: string) => this.submit(text);

    ui.addChild(this.chatContainer);
    ui.addChild(this.statusContainer);
    ui.addChild(this.pendingMessages);
    ui.addChild(this.editor);
    ui.addChild(this.hintText);
    ui.addChild(this.footer);
    ui.setFocus(this.editor);
    ui.addInputListener((data) => this.handleGlobalKey(data));

    // The snapshot seeds footer state and the pending area; the transcript
    // starts blank (no history replay in this phase).
    this.footer.setAssistantState(this.assistantState);
    if (stateSnapshot.sessionId !== undefined) {
      this.footer.setSessionId(stateSnapshot.sessionId);
    }
    for (const entry of this.assistantState.queued) {
      this.pendingMessages.add(entry.id, `(queued message ${entry.id})`);
    }
    this.syncActivity();
  }

  handleEvent(event: SdkEvent): void {
    this.assistantState = nextAssistantState(this.assistantState, event);
    switch (event.kind) {
      case "userMessageQueued":
        this.pendingMessages.add(event.id, userText(event.message));
        break;
      case "userMessageDequeued":
        for (const text of this.pendingMessages.take(event.ids)) {
          this.chatContainer.addChild(new UserMessageComponent(text));
        }
        break;
      case "compactSent":
        this.addBanner("compacting…");
        break;
      case "interruptSent":
        this.addBanner("interrupted");
        break;
      case "controlApplied":
        // TODO: update state appropriately (e.g. if model or permissions mode changed)
        break;
      case "sdkMessage":
        this.handleSdkMessage(event.message);
        break;
    }
    this.syncActivity();
    this.ui.requestRender();
  }

  private handleSdkMessage(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event": {
        const key = message.parent_tool_use_id ?? "";
        if (message.event.type === "message_start") {
          const component = new AssistantMessageComponent();
          this.streaming.set(key, { component, state: beginMessage() });
          this.attach(component, message.parent_tool_use_id);
          break;
        }
        const live = this.streaming.get(key);
        if (live !== undefined) {
          live.state = foldStreamEvent(live.state, message.event);
          live.component.updateContent(live.state.partial);
        }
        break;
      }
      case "assistant": {
        const key = message.parent_tool_use_id ?? "";
        const rendered = renderAssistant(message);
        const live = this.streaming.get(key);
        if (live !== undefined) {
          live.component.updateContent(rendered);
          this.streaming.delete(key);
        } else {
          // No partials seen (e.g. subscribed mid-message): render whole.
          this.attach(
            new AssistantMessageComponent(rendered),
            message.parent_tool_use_id,
          );
        }
        for (const block of rendered.content) {
          if (block.type === "toolCall") {
            const tool = new ToolExecutionComponent(
              block.name,
              block.arguments,
            );
            this.toolComponents.set(block.id, tool);
            this.attach(tool, message.parent_tool_use_id);
          }
        }
        break;
      }
      case "user": {
        for (const result of toolResultsOf(message)) {
          this.toolComponents.get(result.toolCallId)?.updateResult(result);
        }
        break;
      }
      case "system": {
        if (message.subtype === "init") {
          this.footer.setModel(message.model);
          this.footer.setSessionId(message.session_id);
        } else if (message.subtype === "compact_boundary") {
          this.addBanner("context compacted");
        }
        break;
      }
      case "result": {
        if (message.is_error) {
          this.addBanner(`turn failed: ${message.subtype}`);
        }
        break;
      }
      default:
        // TODO: determine what other SDKMessage variants (status, hooks, task
        // notifications, rate limits, …) should affect the UI.
        break;
    }
  }

  /** Add to the transcript, nested under the owning tool for subagents. */
  private attach(
    component: AssistantMessageComponent | ToolExecutionComponent,
    parentToolUseId: string | null,
  ): void {
    const parent =
      parentToolUseId === null
        ? undefined
        : this.toolComponents.get(parentToolUseId);
    if (parent === undefined) {
      this.chatContainer.addChild(component);
    } else {
      parent.addSubagentChild(component);
    }
  }

  private addBanner(text: string): void {
    this.chatContainer.addChild(new Text(theme.fg("dim", text), 1, 1));
  }

  private submit(text: string): void {
    if (text.trim() === "") {
      return;
    }
    this.editor.addToHistory(text);
    // The queued echo comes back as a userMessageQueued event; nothing is
    // rendered here.
    void this.client
      .request({ type: "query", content: text })
      .catch((error: unknown) => {
        this.addBanner(`query failed: ${String(error)}`);
        this.ui.requestRender();
      });
  }

  private handleGlobalKey(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "escape") && isBusy(this.assistantState)) {
      void this.client.request({ type: "interrupt" }).catch(() => {});
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - this.lastCtrlCAt <= CTRL_C_EXIT_WINDOW_MS) {
        this.finish();
      } else {
        this.lastCtrlCAt = now;
        this.hintText.setText(
          theme.fg(
            "dim",
            "press ctrl+c again to detach (the agent keeps running)",
          ),
        );
        this.ui.requestRender();
      }
      return { consume: true };
    }
    this.hintText.setText("");
    return undefined;
  }

  private syncActivity(): void {
    this.footer.setAssistantState(this.assistantState);
    if (this.assistantState.activity === "idle") {
      this.loader.stop();
      this.statusContainer.removeChild(this.loader);
    } else if (!this.statusContainer.children.includes(this.loader)) {
      this.loader.setMessage(this.assistantState.activity);
      this.loader.start();
      this.statusContainer.addChild(this.loader);
    } else {
      this.loader.setMessage(this.assistantState.activity);
    }
  }
}
