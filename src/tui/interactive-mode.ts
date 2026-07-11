/**
 * The interactive mode: assembly + event dispatch, mirroring the shape of
 * pi's interactive-mode.ts (single event switch dispatching to components)
 * at a fraction of the size — everything pi-core-specific (extensions,
 * session trees, model registry, settings, auth) has no counterpart here.
 * All claude-specificity of *content* lives in sdk-render.ts; this file owns
 * layout, keybindings, and the SdkEvent → component dispatch.
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
import type {
  ModelInfo,
  PermissionMode,
  SDKControlInitializeResponse,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { findFd, TuiAutocompleteProvider } from "./autocomplete.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { FooterComponent } from "./components/footer.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { PendingMessagesComponent } from "./components/pending-messages.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import {
  beginMessage,
  foldStreamEvent,
  historyToSdkMessages,
  historyUpToBoundary,
  renderAssistant,
  toolResultsOf,
  userText,
  type StreamingMessage,
} from "./sdk-render.ts";
import { getEditorTheme, theme, type ThemeColor } from "./theme.ts";

const CTRL_C_EXIT_WINDOW_MS = 2_000;

const tuiFlags = {
  sdkSocket: requiredStringFlag("Path to the agent's sdk.sock", "path"),
};

type TuiFlags = InferFlags<typeof tuiFlags>;

/**
 * `clauctl _tui --sdk-socket <path>` — the interactive terminal UI, a pure
 * sdk.sock client.
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
 * Parse the locally intercepted `/model` command: the first
 * whitespace-delimited token must be exactly `/model` (case-sensitive);
 * the argument is the trimmed remainder. Returns null for any other text;
 * `model` undefined means bare `/model` (open the menu).
 */
export function parseModelCommand(
  text: string,
): { model: string | undefined } | null {
  const trimmed = text.trim();
  const spaceIndex = trimmed.search(/\s/);
  const token = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  if (token !== "/model") {
    return null;
  }
  const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  return { model: arg === "" ? undefined : arg };
}

/**
 * Connect the TUI to a subscribed client. Owns the subscribe ordering: events
 * may be delivered before the snapshot promise settles (SdkSocketClient
 * contract), so they buffer in a closure until InteractiveMode exists — the
 * same gating `tail` does. Resolves on detach (double Ctrl+C; the agent keeps
 * running) or when the daemon closes the socket, which it only does while
 * shutting the agent down.
 */
export async function runInteractive(client: SdkSocketClient): Promise<void> {
  const buffered: SdkEvent[] = [];
  let handleEvent = (event: SdkEvent): void => {
    buffered.push(event);
  };
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

  /**
   * Events held back until history replay finishes (undefined afterwards), so
   * live output cannot interleave with — or precede — the replayed transcript.
   */
  // TDC: "historyBuffer" is a confusing name for this, since it makes it sound like these are messages from the history replay, but it's exactly the opposite. "buffer" is a good term, but we somehow want to indicate that these are _live_ messages that arrived while history was being processed.
  private historyBuffer: SdkEvent[] | undefined = [];

  private readonly autocomplete: TuiAutocompleteProvider;
  private modelSelector?: ModelSelectorComponent;
  /** True from `/model` submit until the supported-models read settles. */
  private modelSelectorPending = false;
  private permissionMode?: PermissionMode;
  /** Every mode seen (snapshot seed + live), in first-observed order. */
  private readonly observedPermissionModes: PermissionMode[] = [];

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
    // fills asynchronously via loadHistory.
    this.footer.setAssistantState(this.assistantState);
    if (stateSnapshot.sessionId !== undefined) {
      this.footer.setSessionId(stateSnapshot.sessionId);
    }
    // Unknown model/mode (no init yet, or a pre-extension daemon) display as
    // "default" — the same convention the shift+tab cycle and set-model with
    // no model use; the first init corrects both.
    this.footer.setModel(stateSnapshot.model ?? "default");
    for (const mode of stateSnapshot.observedPermissionModes ?? []) {
      this.observePermissionMode(mode);
    }
    this.notePermissionMode(stateSnapshot.permissionMode ?? "default");
    for (const entry of stateSnapshot.queuedMessages ?? []) {
      this.pendingMessages.add(entry.id, userText(entry.message));
    }
    void this.loadHistory(stateSnapshot.lastTranscriptUuid);

    this.autocomplete = new TuiAutocompleteProvider(
      stateSnapshot.cwd ?? null,
      findFd(),
      () => {
        this.hintText.setText(
          theme.fg("dim", "install fd for @ file completion"),
        );
        this.ui.requestRender();
      },
    );
    this.editor.setAutocompleteProvider(this.autocomplete);
    // The command list arrives when this read resolves; until then the popup
    // shows only the local commands.
    void client.request({ type: "initialization-result" }).then(
      (data) => {
        const init = data as SDKControlInitializeResponse;
        this.autocomplete.setCommands(init.commands);
      },
      (error: unknown) => {
        this.addBanner(`command list fetch failed: ${String(error)}`);
        this.ui.requestRender();
      },
    );

    this.syncActivity();
  }

  /** Record a mode sighting for the shift+tab cycle without making it current. */
  private observePermissionMode(mode: PermissionMode): void {
    if (!this.observedPermissionModes.includes(mode)) {
      this.observedPermissionModes.push(mode);
    }
  }

  /** The mode is current: track it, record the sighting, update the footer. */
  private notePermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.observePermissionMode(mode);
    this.footer.setPermissionMode(mode);
  }

  /**
   * Fetch and render the transcript up to the attach boundary, then release
   * the buffered live events. The subscribe snapshot and the transcript read
   * are not atomic: entries past the boundary may appear in both the read
   * and the buffered events, so replay stops at the boundary and the live
   * stream renders the rest — each message renders exactly once by
   * construction, no dedupe needed.
   */
  private async loadHistory(boundaryUuid: string | undefined): Promise<void> {
    try {
      const data = await this.client.request({ type: "get-messages" });
      const history = data as SessionMessage[];
      for (const message of historyToSdkMessages(
        historyUpToBoundary(history, boundaryUuid),
      )) {
        // Live user prompts render at userMessageDequeued, never via
        // sdkMessage (whose user case only resolves tool results), so history
        // renders them here through the same userText + UserMessageComponent
        // pair the dequeue path uses.
        if (message.type === "user") {
          const text = userText(message);
          if (text !== "") {
            this.chatContainer.addChild(new UserMessageComponent(text));
          }
        }
        this.handleSdkMessage(message);
      }
    } catch (error) {
      this.addBanner(`history fetch failed: ${String(error)}`);
    }
    const buffered = this.historyBuffer ?? [];
    this.historyBuffer = undefined;
    for (const event of buffered) {
      this.handleEvent(event);
    }
    this.ui.requestRender();
  }

  handleEvent(event: SdkEvent): void {
    if (this.historyBuffer !== undefined) {
      this.historyBuffer.push(event);
      return;
    }
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
        if (event.request.type === "set-model") {
          this.footer.setModel(event.request.model ?? "default");
        } else if (event.request.type === "set-permission-mode") {
          this.notePermissionMode(event.request.mode);
        }
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
          this.notePermissionMode(message.permissionMode);
        } else if (message.subtype === "status") {
          // Mode changes not initiated over sdk.sock (e.g. plan transitions).
          if (message.permissionMode !== undefined) {
            this.notePermissionMode(message.permissionMode);
          }
        } else if (message.subtype === "commands_changed") {
          this.autocomplete.setCommands(message.commands);
        } else if (message.subtype === "local_command_output") {
          // The CLI's own rendering; plain Text so embedded ANSI passes through.
          this.chatContainer.addChild(new Text(message.content, 1, 1));
        } else if (message.subtype === "compact_boundary") {
          this.addBanner("context compacted");
        } else if (message.subtype === "notification") {
          this.addBanner(message.text);
        } else if (message.subtype === "informational") {
          if (message.level !== "info") {
            this.addBanner(message.content);
          }
        } else if (
          message.subtype === "model_refusal_fallback" ||
          message.subtype === "model_refusal_no_fallback"
        ) {
          this.addBanner(message.content, "error");
        }
        // Other system subtypes (session_state_changed, hook and task
        // lifecycle, …) are operational chatter with no transcript content.
        break;
      }
      case "result": {
        if (message.is_error) {
          this.addBanner(`turn failed: ${message.subtype}`);
        }
        break;
      }
      default:
        // The remaining top-level variants (rate-limit and tool-progress
        // bookkeeping, user-message replays, …) carry no transcript content;
        // user-facing text arrives as one of the messages handled above.
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

  private addBanner(text: string, color: ThemeColor = "dim"): void {
    this.chatContainer.addChild(new Text(theme.fg(color, text), 1, 1));
  }

  private submit(text: string): void {
    if (text.trim() === "") {
      return;
    }
    this.editor.addToHistory(text);
    const modelCommand = parseModelCommand(text);
    if (modelCommand !== null) {
      if (modelCommand.model === undefined) {
        this.openModelSelector();
      } else {
        this.sendSetModel(modelCommand.model);
      }
      return;
    }
    // The queued echo comes back as a userMessageQueued event; nothing is
    // rendered here.
    void this.client
      .request({ type: "query", content: text })
      .catch((error: unknown) => {
        this.addBanner(`query failed: ${String(error)}`);
        this.ui.requestRender();
      });
  }

  private sendSetModel(model: string): void {
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({ type: "set-model", model })
      .catch((error: unknown) => {
        this.addBanner(`set-model failed: ${String(error)}`, "error");
        this.ui.requestRender();
      });
  }

  private openModelSelector(): void {
    if (this.modelSelector !== undefined || this.modelSelectorPending) {
      return;
    }
    this.modelSelectorPending = true;
    void this.client.request({ type: "supported-models" }).then(
      (data) => {
        this.modelSelectorPending = false;
        const selector = new ModelSelectorComponent(
          data as ModelInfo[],
          (model) => {
            this.closeModelSelector();
            this.sendSetModel(model.value);
          },
          () => this.closeModelSelector(),
        );
        this.modelSelector = selector;
        this.statusContainer.addChild(selector);
        this.ui.setFocus(selector);
        this.ui.requestRender();
      },
      (error: unknown) => {
        this.modelSelectorPending = false;
        this.addBanner(`supported-models failed: ${String(error)}`, "error");
        this.ui.requestRender();
      },
    );
  }

  private closeModelSelector(): void {
    if (this.modelSelector === undefined) {
      return;
    }
    this.statusContainer.removeChild(this.modelSelector);
    this.modelSelector = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  /**
   * Registered as a TUI input listener, which pi-tui runs before the focused
   * component sees the key: `{consume: true}` stops dispatch there (keeping
   * these bindings global instead of becoming editor input), undefined lets
   * the key fall through. The return type is structural because pi-tui does
   * not export its InputListenerResult.
   */
  private handleGlobalKey(data: string): { consume: boolean } | undefined {
    if (
      matchesKey(data, "escape") &&
      isBusy(this.assistantState) &&
      this.modelSelector === undefined // an open menu owns escape (cancel)
    ) {
      void this.client.request({ type: "interrupt" }).catch(() => {});
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      this.cyclePermissionMode();
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

  private cyclePermissionMode(): void {
    const cycle: PermissionMode[] = [];
    for (const mode of [
      "default" as const,
      "acceptEdits" as const,
      "plan" as const,
      ...this.observedPermissionModes,
    ]) {
      if (!cycle.includes(mode)) {
        cycle.push(mode);
      }
    }
    const current = this.permissionMode ?? "default";
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length]!;
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({ type: "set-permission-mode", mode: next })
      .catch((error: unknown) => {
        this.addBanner(`set-permission-mode failed: ${String(error)}`, "error");
        this.ui.requestRender();
      });
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
