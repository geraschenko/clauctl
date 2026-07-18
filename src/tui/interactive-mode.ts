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
  booleanFlag,
  commandNoTarget,
  requiredStringFlag,
  type InferFlags,
} from "../core/generated/cli.ts";
import type { CommandContext } from "../core/generated/targets.ts";
import {
  isBusy,
  nextAgentState,
  type AgentState,
} from "../core/agent-state.ts";
import { entryToSessionMessage } from "../core/session-file.ts";
import {
  pathToLeaf,
  type SessionTree,
  type TreeNode,
  type TreeNodeRef,
} from "../core/tree.ts";
import { SdkSocketClient, type SdkEvent } from "../core/sdk-socket.ts";
import { findFd, TuiAutocompleteProvider } from "./autocomplete.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { FooterComponent } from "./components/footer.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { PendingMessagesComponent } from "./components/pending-messages.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import {
  resolveTreePick,
  TreeSelectorComponent,
} from "./components/tree-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import {
  beginMessage,
  foldStreamEvent,
  pathUpToBoundary,
  releaseDedupeUuid,
  renderAssistant,
  toolResultsOf,
  userText,
  type StreamingMessage,
} from "./sdk-render.ts";
import { getEditorTheme, theme, type ThemeColor } from "./theme.ts";

const CTRL_C_EXIT_WINDOW_MS = 2_000;

const tuiFlags = {
  sdkSocket: requiredStringFlag("Path to the agent's sdk.sock", "path"),
  managed: booleanFlag(
    "Run as the daemon-managed shared renderer (ctrl+c shows the detach hint instead of exiting)",
  ),
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
      await runInteractive(client, flags.managed);
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
 * shutting the agent down. Under `managed` there is no local detach — ctrl+c
 * only hints at the tty-level detach key — so it resolves on socket close
 * alone.
 */
export async function runInteractive(
  client: SdkSocketClient,
  managed: boolean,
): Promise<void> {
  const buffered: SdkEvent[] = [];
  let handleEvent = (event: SdkEvent): void => {
    buffered.push(event);
  };
  const seedState = await client.subscribe((event) => handleEvent(event));
  const ui = new TUI(new ProcessTerminal());
  const interactiveMode = new InteractiveMode(ui, client, seedState, managed);
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
  /** Daemon-managed shared renderer: exiting on ctrl+c would kill the screen
   *  for every attacher, so ctrl+c only hints at the tty-level detach key. */
  private readonly managed: boolean;
  /**
   * Seeded from the subscribe response and advanced only by `nextAgentState`
   * on live events — the same fold the daemon runs, so this always matches
   * the daemon's state. Historical replay renders transcript messages but
   * must not fold them (they predate the seed).
   */
  private agentState: AgentState;

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
   * Live events held back until history replay finishes (undefined
   * afterwards), so live output cannot interleave with — or precede — the
   * replayed transcript.
   */
  private liveEventsDuringReplay: SdkEvent[] | undefined = [];

  /**
   * Release dedupe (nonempty only during reloadHistory's release loop):
   * uuids rendered from the replayed path. A buffered event carrying one of
   * them folds into agentState but renders nothing — the flush-synced tree
   * read can include entries newer than the snapshot leaf, which are also
   * in the buffer.
   */
  private replayedUuids = new Set<string>();

  /**
   * One-shot banner dedupe that OUTLIVES the release loop: replayed boundary
   * banners whose live compact_boundary event may not have arrived yet.
   * Stream-before-file ordering is the codebase's working assumption (the
   * flush-wait machinery exists because the file lags the stream) but is
   * unproven for native compaction events, so a late arrival consumes its
   * entry here instead of rendering a second banner. Only banners need this:
   * post-cut ordinary raw entries never replay, and a replayed summary's
   * live `user` event renders nothing. Daemon-authored boundaries emit no
   * compact_boundary event, so their entries are simply never consumed.
   */
  private readonly replayedBoundaryUuids = new Set<string>();

  private readonly autocomplete: TuiAutocompleteProvider;
  private modelSelector?: ModelSelectorComponent;
  /** True from `/model` submit until the supported-models read settles. */
  private modelSelectorPending = false;
  private treeSelector?: TreeSelectorComponent;
  /** True from `/tree` submit until the get-tree read settles. */
  private treeSelectorPending = false;

  constructor(
    ui: TUI,
    client: SdkSocketClient,
    seedState: AgentState,
    managed: boolean,
  ) {
    this.ui = ui;
    this.client = client;
    this.managed = managed;
    this.agentState = seedState;
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

    // The seed state fills the pending area (the footer reads it via
    // syncActivity below); the transcript fills asynchronously via
    // reloadHistory.
    for (const entry of seedState.queuedMessages) {
      this.pendingMessages.add(entry.id, userText(entry.message));
    }
    void this.reloadHistory();

    this.autocomplete = new TuiAutocompleteProvider(
      seedState.cwd ?? null,
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

  /**
   * (Re)build the transcript from the session tree: fetch get-tree, render
   * the root-to-leaf path cut at the state fold's leaf occurrence
   * (pathUpToBoundary — the entries after it arrive as live events), then
   * the delivered-but-unconfirmed prompts, then release the buffered live
   * events. Called on attach (constructor) and on every contextChanged
   * (redraw). Path nodes render unconditionally, duplicates included — a
   * boundary's preserved messages appear both in the raw pre-boundary
   * history and below the banner, which is the honest display of the
   * logical history; only path-vs-buffer duplication is deduped
   * (replayedUuids, during the release loop).
   *
   * When the leaf is missing from the path, exactly-once is unachievable:
   * the whole path replays behind a warning banner — unless a buffered
   * contextChanged is pending, which means this reload is already
   * superseded (the context change moved the leaf between snapshot and
   * read; releasing it reloads with the new leaf), so warning would be
   * spurious.
   */
  private async reloadHistory(): Promise<void> {
    this.chatContainer.clear();
    this.streaming.clear();
    this.toolComponents.clear();
    this.replayedBoundaryUuids.clear();
    this.liveEventsDuringReplay = [];
    const replayed = new Set<string>();
    try {
      const data = await this.client.request({ type: "get-tree" });
      const sessionTree = data as SessionTree;
      const path = pathToLeaf(sessionTree.tree, sessionTree.leaf);
      const { nodes, boundaryMissing } = pathUpToBoundary(
        path,
        this.agentState.leafTreeNodeRef,
      );
      for (const node of nodes) {
        this.renderPathNode(node, replayed);
      }
      if (
        boundaryMissing &&
        !this.liveEventsDuringReplay.some(
          (event) => event.kind === "contextChanged",
        )
      ) {
        this.addBanner(
          "history attach point not found; recent messages may be missing or duplicated",
        );
      }
    } catch (error) {
      this.addBanner(`history fetch failed: ${String(error)}`);
    }
    // Delivered-but-unconfirmed prompts (the prompt-visibility invariant,
    // agent-state.ts): dequeued before the state snapshot was taken with the
    // transcript echo still pending, so they are in neither the leaf-cut
    // path nor the buffered events. Chronologically they follow the
    // replayed transcript.
    for (const message of this.agentState.deliveredMessages) {
      const text = userText(message);
      if (text !== "") {
        this.chatContainer.addChild(new UserMessageComponent(text));
      }
    }
    const buffered = this.liveEventsDuringReplay ?? [];
    this.liveEventsDuringReplay = undefined;
    this.replayedUuids = replayed;
    try {
      // A buffered contextChanged re-enters reloadHistory here; its
      // synchronous prefix re-arms the buffer, so the rest of this loop
      // feeds the follow-up reload instead of rendering.
      for (const event of buffered) {
        this.handleEvent(event);
      }
    } finally {
      this.replayedUuids = new Set();
    }
    this.ui.requestRender();
  }

  /**
   * One path node through the exact live pipeline: boundary nodes render
   * the banner their live compact_boundary event would; user prompts render
   * through the same userText + UserMessageComponent pair the dequeue path
   * uses (the sdkMessage user case only resolves tool results); everything
   * else dispatches through handleSdkMessage. A SessionMessage carries
   * every field its SDKMessage variant requires, so the cast is a narrowing
   * of `message: unknown`, not a fabrication.
   */
  private renderPathNode(node: TreeNode, replayed: Set<string>): void {
    if (node.entry.subtype === "compact_boundary") {
      if (node.entry.uuid !== undefined) {
        replayed.add(node.entry.uuid);
        this.replayedBoundaryUuids.add(node.entry.uuid);
      }
      this.addBanner("context compacted");
      return;
    }
    const message = entryToSessionMessage(node.entry);
    if (message === undefined) {
      return;
    }
    replayed.add(message.uuid);
    const sdkMessage = message as SessionMessage & SDKMessage;
    if (sdkMessage.type === "user") {
      const text = userText(sdkMessage);
      if (text !== "") {
        this.chatContainer.addChild(new UserMessageComponent(text));
      }
    }
    this.handleSdkMessage(sdkMessage);
  }

  handleEvent(event: SdkEvent): void {
    if (this.liveEventsDuringReplay !== undefined) {
      this.liveEventsDuringReplay.push(event);
      return;
    }
    this.agentState = nextAgentState(this.agentState, event);
    // The switch is rendering-only dispatch; all state effects (footer
    // fields, mode cycle, activity) come from the fold above.
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
        break;
      case "contextChanged":
        // An open selector keeps its now-stale tree; the warning tells the
        // attached user some other process changed the context under them.
        this.treeSelector?.setWarning(
          "context changed while the tree selector is open",
        );
        // The fold above already holds the new leaf, so the reload cuts the
        // fresh path at the right occurrence.
        void this.reloadHistory();
        break;
      case "sdkMessage":
        this.handleSdkMessage(event.message);
        break;
    }
    this.syncActivity();
    this.ui.requestRender();
  }

  private handleSdkMessage(message: SDKMessage): void {
    // Release dedupe: a buffered event whose transcript entry already
    // rendered from the replayed path folds into agentState (handleEvent,
    // before dispatch) but renders nothing — no second banner, no streaming
    // component, no tool-result re-resolution.
    const dedupeUuid = releaseDedupeUuid(message);
    if (dedupeUuid !== undefined && this.replayedUuids.has(dedupeUuid)) {
      // A buffered banner event consumed here won't arrive again — release
      // its one-shot entry.
      this.replayedBoundaryUuids.delete(dedupeUuid);
      return;
    }
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
      case "conversation_reset":
        // The old conversation is no longer this surface's transcript. New
        // queued prompts remain in pendingMessages; the fold has cleared the
        // old history identity until the new session's init arrives.
        this.chatContainer.clear();
        this.streaming.clear();
        this.toolComponents.clear();
        this.addBanner("conversation reset");
        break;
      case "system": {
        // init and status carry only state (model/mode/session), which the
        // fold already covers; they render nothing.
        if (message.subtype === "commands_changed") {
          this.autocomplete.setCommands(message.commands);
        } else if (message.subtype === "local_command_output") {
          // The CLI's own rendering; plain Text so embedded ANSI passes through.
          this.chatContainer.addChild(new Text(message.content, 1, 1));
        } else if (message.subtype === "compact_boundary") {
          if (
            message.uuid === undefined ||
            !this.replayedBoundaryUuids.delete(message.uuid)
          ) {
            this.addBanner("context compacted");
          }
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
    if (/^\/tree(\s|$)/.test(text.trim())) {
      this.openTreeSelector();
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

  private openTreeSelector(): void {
    if (this.treeSelector !== undefined || this.treeSelectorPending) {
      return;
    }
    this.treeSelectorPending = true;
    void this.client.request({ type: "get-tree" }).then(
      (data) => {
        this.treeSelectorPending = false;
        const tree = data as SessionTree;
        const selector = new TreeSelectorComponent(
          tree,
          (pick) => this.confirmTreePick(tree, pick),
          () => this.closeTreeSelector(),
        );
        this.treeSelector = selector;
        this.statusContainer.addChild(selector);
        this.ui.setFocus(selector);
        this.ui.requestRender();
      },
      (error: unknown) => {
        this.treeSelectorPending = false;
        this.addBanner(`get-tree failed: ${String(error)}`, "error");
        this.ui.requestRender();
      },
    );
  }

  /** The selector stays dumb; the busy gate and the request live here. */
  private confirmTreePick(tree: SessionTree, pick: TreeNodeRef): void {
    if (isBusy(this.agentState)) {
      this.hintText.setText(
        theme.fg("dim", "cannot navigate tree while assistant is busy"),
      );
      this.ui.requestRender();
      return;
    }
    const action = resolveTreePick(tree, pick);
    this.closeTreeSelector();
    const request =
      action.kind === "rewind"
        ? { type: "set-context" as const, rewindTo: action.rewindTo }
        : { type: "set-context" as const, uuids: [] };
    // The redraw follows from the contextChanged event; only the pick's
    // editorText is applied here (only the initiating TUI prefills).
    void this.client.request(request).then(
      () => {
        if (action.editorText !== undefined) {
          this.editor.setText(action.editorText);
        }
        this.ui.requestRender();
      },
      (error: unknown) => {
        this.addBanner(`set-context failed: ${String(error)}`, "error");
        this.ui.requestRender();
      },
    );
  }

  private closeTreeSelector(): void {
    if (this.treeSelector === undefined) {
      return;
    }
    this.statusContainer.removeChild(this.treeSelector);
    this.treeSelector = undefined;
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
      isBusy(this.agentState) &&
      // An open menu owns escape (cancel / clear search).
      this.modelSelector === undefined &&
      this.treeSelector === undefined
    ) {
      void this.client.request({ type: "interrupt" }).catch(() => {});
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      this.cyclePermissionMode();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.managed) {
        this.hintText.setText(theme.fg("dim", "detach: ctrl+]"));
        this.ui.requestRender();
        return { consume: true };
      }
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
      ...this.agentState.observedPermissionModes,
    ]) {
      if (!cycle.includes(mode)) {
        cycle.push(mode);
      }
    }
    const current = this.agentState.permissionMode ?? "default";
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
    this.footer.setState(this.agentState);
    if (this.agentState.activity === "idle") {
      this.loader.stop();
      this.statusContainer.removeChild(this.loader);
    } else if (!this.statusContainer.children.includes(this.loader)) {
      this.loader.setMessage(this.agentState.activity);
      this.loader.start();
      this.statusContainer.addChild(this.loader);
    } else {
      this.loader.setMessage(this.agentState.activity);
    }
  }
}
