/**
 * The interactive mode: assembly + event dispatch, mirroring the shape of
 * pi's interactive-mode.ts (single event switch dispatching to components)
 * at a fraction of the size — everything pi-core-specific (extensions,
 * session trees, model registry, settings, auth) has no counterpart here.
 * All claude-specificity of *content* lives in sdk-render.ts; this file owns
 * keybindings and the AgentEvent → component dispatch.
 */

import {
  Container,
  getKeybindings,
  KeybindingsManager,
  Loader,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  EffortLevel,
  ModelInfo,
  SDKControlInitializeResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  allPendingAsks,
  anomalyReport,
  isIdle,
  type PendingAsk,
} from "../../core/agent-state/index.ts";
import type {
  AgentState,
  AgentEvent,
  GetEntriesResponse,
} from "../../core/protocol/index.ts";
import type { UUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionEntry } from "../../core/session/file.ts";
import type { TreeNodeRef } from "../../core/tree/nodes.ts";
import type { ProtocolClient } from "../../core/protocol-client/index.ts";
import { findFd, TuiAutocompleteProvider } from "../autocomplete.ts";
import { EffortSelectorComponent } from "../components/effort-selector.ts";
import { FooterComponent } from "../components/footer.ts";
import { FooterDataProvider } from "../footer-data-provider.ts";
import { ModelSelectorComponent } from "../components/model-selector.ts";
import { PendingMessagesComponent } from "../components/pending-messages.ts";
import { PromptEditor } from "../components/prompt-editor.ts";
import {
  resolveTreePick,
  TreeSelectorComponent,
} from "../components/tree-selector.ts";
import {
  editFileInExternalEditor,
  editTextInExternalEditor,
  externalEditorCommand,
} from "../external-editor.ts";
import { VERSION } from "../../core/generated/version.ts";
import { userText } from "../../format/sdk-render.ts";
import type { SessionModel } from "../session-model.ts";
import { SessionModels } from "../session-models.ts";
import { type ClauctlSettings } from "../../core/settings.ts";
import { Transcript, type Banner } from "../transcript/index.ts";
import { getEditorTheme, theme } from "../theme.ts";
import { mountParts } from "./layout.ts";
import { parseEffortCommand, parseModelCommand } from "./local-commands.ts";
import { nextPermissionMode } from "./permission-mode-cycle.ts";
import { effortLevelsOf } from "./effort-levels.ts";
import { HeldLiveEvents } from "./held-live-events.ts";
import { editKeybindings, reloadKeybindings } from "./keybindings-commands.ts";
import {
  occupantComponent,
  type InputSlotOccupant,
} from "./input-slot-occupant.ts";
import { askPromptOccupant, type AskPromptHandlers } from "./ask-prompt.ts";
import { resolutionBanner } from "./resolution-banner.ts";

/** How an interactive session ended; attach.ts turns this into the exit
 *  message and code. */
export type InteractiveOutcome =
  | { kind: "detached" } // app.detach pressed; the agent keeps running
  | { kind: "shutdown"; reason: string } // daemon shutdown event received
  | { kind: "connectionLost" }; // socket closed unannounced (daemon crash)

export class InteractiveMode {
  readonly done: Promise<InteractiveOutcome>;
  private finish!: (outcome: InteractiveOutcome) => void;

  private readonly ui: TUI;
  private readonly client: ProtocolClient;
  /**
   * Seeded from the subscribe response and assigned the post-fold state the
   * client delivers with each live event — the client runs the same fold the
   * daemon does, so this always matches the daemon's state. Historical
   * replay renders transcript messages but must not advance this state
   * (they predate the seed).
   */
  private agentState: AgentState;
  /** Per-session entries, pending lists and trees, fed every event in
   *  socket order; the transcript and `/tree` read them instead of
   *  fetching. */
  private readonly sessionModels: SessionModels;

  private readonly chatContainer = new Container();
  private readonly pendingMessages = new PendingMessagesComponent();
  private readonly statusContainer = new Container();
  private readonly hintText = new Text("", 1, 0);
  private readonly loader: Loader;
  /** Lives across occupancies, so text typed before an ask survives it. */
  private readonly editor: PromptEditor;
  private readonly inputSlot = new Container();
  private inputSlotOccupant: InputSlotOccupant = { kind: "editor" };
  /** Plans edited via ctrl+g, by ask: a task's plan ask can lose the head
   *  to a newer main-agent ask and regain it later, edit intact. Cleared
   *  when no ask is pending. */
  private readonly planEdits = new Map<string, string>();
  private readonly askPromptHandlers: AskPromptHandlers;
  /** Git-branch data for the footer. The daemon always seeds cwd, so this
   *  is only undefined for a (theoretical) unseeded subscribe response —
   *  the footer then simply never shows a branch. */
  private readonly footerData: FooterDataProvider | undefined;
  private readonly footer: FooterComponent;

  /** All transcript content renders through this (recreated on reload). */
  private transcript: Transcript;
  /** The global manager set by runInteractive; also consulted by pi-tui's
   *  Editor and SelectList, so remaps apply everywhere at once. */
  private readonly keybindings: KeybindingsManager;
  /** ctrl+o / ctrl+t toggles, reapplied to recreated renderers. */
  private toolsExpanded = false;
  private showThinking = false;
  private readonly settings: ClauctlSettings;

  /** Defined while history replays; undefined afterwards. */
  private heldLiveEvents: HeldLiveEvents | undefined = new HeldLiveEvents();
  /** Between `sessionFileChanged` and `scanComplete` the transcript is
   *  blank and nothing renders live: the scan's entries and the query
   *  messages arriving meanwhile reach it through the rebuild at the end. */
  private scanning = false;

  private readonly autocomplete: TuiAutocompleteProvider;
  /** The token of the latest selector command whose fetch is in flight.
   *  Each command takes a fresh `{}`, distinct by identity from every
   *  other, so a fetch result mounts only while its token is still this
   *  one (a newer selector command replaces it; `/tree` and a mounted ask
   *  prompt clear it). A boolean could not tell a stale fetch from the
   *  current one. */
  private pendingSelectorRequest: object | undefined;

  constructor(
    ui: TUI,
    client: ProtocolClient,
    seedState: AgentState,
    startupWarnings: string[],
    settings: ClauctlSettings,
  ) {
    this.ui = ui;
    this.client = client;
    this.agentState = seedState;
    this.keybindings = getKeybindings();
    this.settings = settings;
    this.transcript = this.freshTranscript();
    this.sessionModels = new SessionModels(
      (message) => this.transcript.addBanner({ text: message }),
      (sessionId, uuid, entry) => this.onResolved(sessionId, uuid, entry),
      (sessionId) => this.onContextChanged(sessionId),
    );
    this.sessionModels.seed(seedState);
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });

    this.loader = new Loader(
      ui,
      (text: string) => theme.fg("accent", text),
      (text: string) => theme.fg("dim", text),
    );
    this.editor = new PromptEditor(ui, getEditorTheme(), {
      interrupt: () => {
        // No ask can be pending while the editor occupies the slot.
        if (isIdle(this.agentState)) return false;
        this.interrupt();
        return true;
      },
      cyclePermissionMode: () => this.cyclePermissionMode(),
      editExternally: () => void this.openExternalPromptEditor(),
      onCleared: () => {
        this.hintText.setText(
          theme.fg(
            "dim",
            `detach with ${this.keybindings.getKeys("app.detach").join(", ")}`,
          ),
        );
        this.ui.requestRender();
      },
    });
    this.editor.onSubmit = (text: string) => this.submit(text);
    this.askPromptHandlers = {
      respond: (toolUseId, decision, feedback) =>
        this.sendPermissionResponse(toolUseId, decision, feedback),
      editText: (text) => this.editTextExternally(text),
      editPlan: (toolUseId, planFilePath) =>
        void this.openPlanEditor(toolUseId, planFilePath),
      // A pending ask is interruptible even with the main loop idle (a
      // background task's ask): the CLI aborts the ask and kills the task.
      interrupt: () => this.interrupt(),
    };

    if (seedState.cwd !== undefined) {
      this.footerData = new FooterDataProvider(seedState.cwd);
      this.footerData.onBranchChange(() => this.ui.requestRender());
    }
    this.footer = new FooterComponent(this.footerData);

    this.inputSlot.addChild(this.editor);
    mountParts(ui, {
      chatContainer: this.chatContainer,
      statusContainer: this.statusContainer,
      pendingMessages: this.pendingMessages,
      inputSlot: this.inputSlot,
      hintText: this.hintText,
      footer: this.footer,
    });
    ui.setFocus(this.editor);
    ui.addInputListener((data) => this.handleGlobalKey(data));
    // An agent already blocked at attach shows its dialog before the
    // history replay fills the transcript.
    this.syncAskPrompt(seedState);

    // The seed state fills the pending area (the footer reads it via
    // syncActivity below); the transcript fills asynchronously via
    // reloadHistory.
    for (const entry of seedState.queuedMessages) {
      this.pendingMessages.add(entry.uuid, userText(entry.message));
    }
    void this.reloadHistory(startupWarnings);

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
        this.transcript.addBanner({
          text: `command list fetch failed: ${String(error)}`,
        });
        this.ui.requestRender();
      },
    );

    this.syncActivity();
  }

  /**
   * The attach-time history fetch: `get-entries {payload: "full"}` seeds
   * the session models (the response's event count is its snapshot cut,
   * and the state at that cut is the one the daemon answered against —
   * read from the held live events once the pump has delivered that far),
   * the held live events release their state effects, then the transcript
   * fills from the models below the startup banners — unless the release
   * left a scan window open, whose `scanComplete` rebuilds instead.
   * `startupWarnings` describe the keybindings and settings as read at
   * start, so only this first transcript shows them; rebuilds do not.
   */
  private async reloadHistory(startupWarnings: string[]): Promise<void> {
    for (const warning of startupWarnings) {
      this.transcript.addBanner({ text: warning, color: "warning" });
    }
    const heldLiveEvents = this.heldLiveEvents!;
    try {
      const { data, eventsBefore } = await this.client.requestWithEventCount({
        type: "get-entries",
        payload: "full",
      });
      const snapshot = data as GetEntriesResponse;
      // Nothing folds into agentState while events are held: it is the seed.
      const cutState = await heldLiveEvents.stateAtCut(
        eventsBefore,
        this.agentState,
      );
      this.sessionModels.applySnapshot(
        snapshot.entries!,
        eventsBefore,
        cutState,
      );
    } catch (error) {
      this.transcript.addBanner({
        text: `history fetch failed: ${String(error)}`,
      });
      this.sessionModels.applySnapshot([], 0, this.agentState);
    }
    this.heldLiveEvents = undefined;
    for (const [event, state] of heldLiveEvents.events) {
      this.applyState(event, state);
    }
    if (!this.scanning) {
      this.renderHistory();
    }
    this.ui.requestRender();
  }

  private resetTranscript(): void {
    this.chatContainer.clear();
    this.transcript = this.freshTranscript();
  }

  /** An empty transcript with the welcome line at its top, so it heads the
   *  scrollback whatever follows. The welcome line self-identifies the
   *  product (Agent SDK branding guidelines: our own branding, not Claude
   *  Code's). */
  private freshTranscript(): Transcript {
    const transcript = new Transcript(
      this.chatContainer,
      this.settings.showResolvedBoundary,
    );
    transcript.setCwd(this.agentState.cwd);
    transcript.setToolsExpanded(this.toolsExpanded);
    transcript.setCompactSummaryExpanded(this.toolsExpanded);
    transcript.setShowThinking(this.showThinking);
    transcript.addBanner({
      text: `Welcome to clauctl TUI ${theme.fg("dim", `v${VERSION}`)}`,
      color: "accent",
    });
    return transcript;
  }

  /** The rebuild for a resolved `contextChanged` and `scanComplete`; attach
   *  renders the history into the fresh transcript directly. */
  private rebuildTranscript(): void {
    this.resetTranscript();
    this.renderHistory();
  }

  /**
   * The one history path (attach, `contextChanged`, `scanComplete`), all
   * of it the query session's: its display path — the trees hold resolved
   * entries only, so the whole path is the resolved part — then its
   * pending query messages (dequeued prompts among them).
   */
  private renderHistory(): void {
    const querySessionModel = this.querySessionModel();
    if (querySessionModel !== undefined) {
      for (const ref of querySessionModel.pathToLeaf()) {
        // pathToLeaf validated every path uuid against byUuid, so the
        // lookup cannot miss.
        this.transcript.appendEntry(querySessionModel.byUuid.get(ref.uuid)!);
      }
      for (const message of querySessionModel.queryMessages.values()) {
        if (message !== undefined) {
          this.transcript.append(message);
        }
      }
    }
  }

  private querySessionModel(): SessionModel | undefined {
    const { querySessionId } = this.agentState;
    return querySessionId === undefined
      ? undefined
      : this.sessionModels.get(querySessionId);
  }

  private fileSessionModel(): SessionModel | undefined {
    const { fileSessionId } = this.agentState;
    return fileSessionId === undefined
      ? undefined
      : this.sessionModels.get(fileSessionId);
  }

  handleEvent(event: AgentEvent, state: AgentState): void {
    // Terminal and order-independent, so it must not wait out a history
    // replay: the socket may close right behind it, and a held shutdown
    // would then misreport as connectionLost.
    if (event.kind === "shutdown") {
      this.finish({ kind: "shutdown", reason: event.reason });
      return;
    }
    // The session models see every event as it arrives — their snapshot
    // cut is a socket position — while state and rendering wait out the
    // history replay. Live, the state (and its scan gate) updates before
    // the models fire `onResolved`, so the callback reads the current gate.
    if (this.heldLiveEvents !== undefined) {
      this.sessionModels.observe(event, state);
      this.heldLiveEvents.hold(event, state);
      return;
    }
    this.applyState(event, state);
    this.sessionModels.observe(event, state);
    this.renderEvent(event);
    this.ui.requestRender();
  }

  /** The event's effects outside the transcript — the state itself, the
   *  scan gate, and the components that read the state: the pending area,
   *  the command list, the footer — plus the anomaly banner, the one
   *  transcript effect that must survive the release of held events. Runs for every
   *  event, including the ones released after attach. */
  private applyState(event: AgentEvent, state: AgentState): void {
    const priorState = this.agentState;
    this.agentState = state;
    this.syncAskPrompt(state);
    if (event.kind === "permissionResolved") {
      const resolvedRequest = allPendingAsks(priorState).find(
        ({ request }) => request.toolUseId === event.toolUseId,
      )?.request;
      const banner = resolutionBanner(event.resolution, resolvedRequest);
      if (banner !== undefined) this.transcript.addBanner({ text: banner });
    }
    if (event.kind === "sessionFileChanged") {
      this.scanning = true;
    } else if (event.kind === "scanComplete") {
      this.scanning = false;
    }
    // The daemon reports every anomaly it detects, its own fold's included,
    // so `state.anomaly` (the TUI's fold detecting the same thing) is not
    // read: the report names the bundle.
    if (event.kind === "trackerAnomaly") {
      this.transcript.addBanner({
        text: anomalyReport(event.anomaly, event.bundlePath),
        color: "warning",
      });
    }
    if (event.kind === "userMessageQueued") {
      this.pendingMessages.add(
        event.message.uuid as UUID,
        userText(event.message),
      );
    } else if (event.kind === "userMessageDequeued") {
      this.pendingMessages.take(event.uuids);
    } else if (event.kind === "contextChanged") {
      // An open selector keeps its now-stale tree; the warning tells the
      // attached user some other process changed the context under them.
      if (this.inputSlotOccupant.kind === "treeSelector") {
        this.inputSlotOccupant.selector.setWarning(
          "context changed while the tree selector is open",
        );
      }
    } else if (
      event.kind === "sdkMessage" &&
      event.message.type === "system" &&
      event.message.subtype === "commands_changed"
    ) {
      this.autocomplete.setCommands(event.message.commands);
    }
    this.syncActivity();
  }

  /** The event's transcript effect: query-side content, into the pending
   *  part as it arrives (the render-once guard in the transcript keeps a
   *  message rendered from one stream from rendering again from the
   *  other). File-side content reaches the transcript through `onResolved`
   *  and `onContextChanged` only. A scan window renders nothing until its
   *  rebuild. */
  private renderEvent(event: AgentEvent): void {
    if (event.kind === "sessionFileChanged") {
      this.resetTranscript();
      return;
    }
    if (event.kind === "scanComplete") {
      this.rebuildTranscript();
      return;
    }
    if (this.scanning) {
      return;
    }
    switch (event.kind) {
      case "userMessageDequeued": {
        // The dequeue's stream position is the correct transcript position;
        // the session model just recorded the run's joined prompt under the
        // run key — absent when the step already resolved it (its entry
        // rendered it) or there is no query session yet (its entry will).
        const prompt = this.querySessionModel()?.queryMessages.get(
          event.uuids.at(-1)!,
        );
        if (prompt !== undefined) {
          this.transcript.append(prompt);
        }
        break;
      }
      case "compactSent":
        this.addEventBanner("compacting…", event.uuid);
        break;
      case "interruptSent":
        // The CLI's interrupt marker renders the interrupt, from the session
        // file too, so a late attacher sees it (interruptMarkerText).
        break;
      case "sdkMessage":
        if (
          event.message.type !== "system" ||
          event.message.subtype !== "commands_changed"
        ) {
          this.transcript.append(event.message);
        }
        break;
      case "sessionAppended":
        this.transcript.append(event.message);
        break;
      case "contextChanged":
        // The transcript is rebuilt when the context change _resolves_, not
        // when it arrives. Otherwise the display tree will not have registered
        // the context update yet.
        break;
      case "sessionEntry":
      case "userMessageQueued":
      case "controlApplied":
      case "trackerAnomaly":
      case "querySessionChanged":
        break;
    }
  }

  /** A resolution on the query session moves its items into the resolved
   *  part and renders from the entry — the canonical content
   *  (`stop_reason`, the persisted text). Nothing to do while the
   *  transcript is not showing live events: the rebuild renders the trees. */
  private onResolved(
    sessionId: UUID,
    uuid: UUID,
    entry: SessionEntry | undefined,
  ): void {
    if (
      this.heldLiveEvents !== undefined ||
      this.scanning ||
      sessionId !== this.agentState.querySessionId
    ) {
      return;
    }
    this.transcript.resolve(uuid, entry);
  }

  /** The query session's path changed under a boundary that is now in the
   *  trees (with its anchor, for a relink): rebuild from it. Gated like
   *  `onResolved`. */
  private onContextChanged(sessionId: UUID): void {
    if (
      this.heldLiveEvents !== undefined ||
      this.scanning ||
      sessionId !== this.agentState.querySessionId
    ) {
      return;
    }
    this.rebuildTranscript();
  }

  /** A banner rendering the query-side event `uuid`, keyed so the
   *  event's resolution moves it. The event folds (and the session models
   *  observe) before it renders, so a resolution in its own step has
   *  already fired: then the banner is resolved here. */
  private addEventBanner(text: string, uuid: UUID): void {
    this.transcript.addBanner({ text }, uuid);
    if (this.querySessionModel()?.queryMessages.has(uuid) !== true) {
      this.transcript.resolve(uuid, undefined);
    }
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
    const effortCommand = parseEffortCommand(text);
    if (effortCommand !== null) {
      this.handleEffortCommand(effortCommand.level);
      return;
    }
    if (/^\/tree(\s|$)/.test(text.trim())) {
      this.openTreeSelector();
      return;
    }
    if (/^\/keybindings(\s|$)/.test(text.trim())) {
      void editKeybindings(this.ui, this.keybindings).then((banners) =>
        this.addBanners(banners),
      );
      return;
    }
    if (/^\/reload-keybindings(\s|$)/.test(text.trim())) {
      this.addBanners(reloadKeybindings(this.keybindings));
      return;
    }
    // The queued echo comes back as a userMessageQueued event; nothing is
    // rendered here.
    void this.client
      .request({ type: "prompt", content: text })
      .catch((error: unknown) => {
        this.transcript.addBanner({ text: `prompt failed: ${String(error)}` });
        this.ui.requestRender();
      });
  }

  private addBanners(banners: readonly Banner[]): void {
    for (const banner of banners) this.transcript.addBanner(banner);
    this.ui.requestRender();
  }

  /** Edit the prompt text in the external editor: exit 0 replaces it,
   *  nonzero keeps it. Failures are reported as a banner. */
  private async openExternalPromptEditor(): Promise<void> {
    if (externalEditorCommand() === undefined) {
      this.transcript.addBanner({
        text: "set $EDITOR to edit the prompt",
        color: "warning",
      });
      this.ui.requestRender();
      return;
    }
    try {
      const edited = await editTextInExternalEditor(
        this.ui,
        this.editor.getText(),
      );
      if (edited !== undefined) {
        this.editor.setText(edited);
      }
    } catch (error) {
      this.transcript.addBanner({
        text: `external editor failed: ${String(error)}`,
        color: "error",
      });
      this.ui.requestRender();
    }
  }

  /** Text edited in the external editor; undefined when there is none or
   *  it fails, each reported as a banner. */
  private async editTextExternally(text: string): Promise<string | undefined> {
    if (externalEditorCommand() === undefined) {
      this.transcript.addBanner({
        text: "set $EDITOR to use an external editor",
        color: "warning",
      });
      this.ui.requestRender();
      return undefined;
    }
    try {
      return await editTextInExternalEditor(this.ui, text);
    } catch (error) {
      this.transcript.addBanner({
        text: `external editor failed: ${String(error)}`,
        color: "error",
      });
      this.ui.requestRender();
      return undefined;
    }
  }

  /** ctrl+g on the ExitPlanMode dialog: edit claude's plan file in place;
   *  exit 0 remounts the dialog showing the edited plan, which approval
   *  then sends as `updatedInput`. Failures are reported as a banner. */
  private async openPlanEditor(
    toolUseId: string,
    planFilePath: string,
  ): Promise<void> {
    const editorCommand = externalEditorCommand();
    if (editorCommand === undefined) {
      this.transcript.addBanner({
        text: "set $EDITOR to edit the plan",
        color: "warning",
      });
      this.ui.requestRender();
      return;
    }
    try {
      if (
        await editFileInExternalEditor(this.ui, editorCommand, planFilePath)
      ) {
        // A resolved ask does not regain an entry; only the displayed
        // prompt remounts (a head-losing ask shows the edit on regaining it).
        const asks = allPendingAsks(this.agentState);
        if (asks.some(({ request }) => request.toolUseId === toolUseId)) {
          this.planEdits.set(toolUseId, readFileSync(planFilePath, "utf8"));
        }
        const occupant = this.inputSlotOccupant;
        if (
          occupant.kind === "permissionPrompt" &&
          occupant.toolUseId === toolUseId
        ) {
          this.showAskPrompt(asks);
        }
      }
    } catch (error) {
      this.transcript.addBanner({
        text: `external editor failed: ${String(error)}`,
        color: "error",
      });
    }
    this.ui.requestRender();
  }

  private sendSetModel(model: string): void {
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({ type: "set-model", model })
      .catch((error: unknown) => {
        this.transcript.addBanner({
          text: `set-model failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      });
  }

  private openModelSelector(): void {
    const token = {};
    this.pendingSelectorRequest = token;
    void this.client.request({ type: "supported-models" }).then(
      (data) => {
        if (this.pendingSelectorRequest !== token) return;
        this.pendingSelectorRequest = undefined;
        const selector = new ModelSelectorComponent(
          data as ModelInfo[],
          (model) => {
            this.occupyInputSlot({ kind: "editor" });
            this.sendSetModel(model.value);
          },
          () => this.occupyInputSlot({ kind: "editor" }),
        );
        this.occupyInputSlot({ kind: "modelSelector", selector });
      },
      (error: unknown) => {
        if (this.pendingSelectorRequest === token) {
          this.pendingSelectorRequest = undefined;
        }
        this.transcript.addBanner({
          text: `supported-models failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      },
    );
  }

  /** Swap the slot's component for the occupant's, focus it, render. */
  private occupyInputSlot(occupant: InputSlotOccupant): void {
    this.inputSlot.removeChild(
      occupantComponent(this.inputSlotOccupant, this.editor),
    );
    const component = occupantComponent(occupant, this.editor);
    this.inputSlot.addChild(component);
    this.inputSlotOccupant = occupant;
    this.ui.setFocus(component);
    this.ui.requestRender();
  }

  /** Make the slot show the head pending ask's prompt; with no ask
   *  pending, an ask prompt gives the slot back to the editor (a selector
   *  stays). Call on every state change. */
  private syncAskPrompt(state: AgentState): void {
    const asks = allPendingAsks(state);
    const head = asks[0];
    const occupant = this.inputSlotOccupant;
    const isAskPrompt =
      occupant.kind === "permissionPrompt" ||
      occupant.kind === "questionPrompt";
    if (head === undefined) {
      this.planEdits.clear();
      if (isAskPrompt) this.occupyInputSlot({ kind: "editor" });
      return;
    }
    if (isAskPrompt && occupant.toolUseId === head.request.toolUseId) {
      occupant.prompt.pendingCount = asks.length;
      return;
    }
    this.showAskPrompt(asks);
  }

  /** Mount the head ask's prompt (superseding any selector fetch); also
   *  the remount after a plan edit. */
  private showAskPrompt(asks: readonly PendingAsk[]): void {
    this.pendingSelectorRequest = undefined;
    const head = asks[0]!;
    this.occupyInputSlot(
      askPromptOccupant(
        head,
        asks.length,
        this.agentState.cwd,
        this.planEdits.get(head.request.toolUseId),
        this.askPromptHandlers,
      ),
    );
  }

  /** Send `interrupt`; failures are ignored. */
  private interrupt(): void {
    void this.client.request({ type: "interrupt" }).catch(() => {});
  }

  /** Any failure shows a banner. */
  private sendPermissionResponse(
    toolUseId: string,
    decision: PermissionResult,
    feedback?: string,
  ): void {
    void this.client
      .request({
        type: "permission-response",
        toolUseId,
        decision,
        ...(feedback !== undefined && { feedback }),
      })
      .catch((error: unknown) => {
        this.transcript.addBanner({
          text: `permission response failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      });
  }

  /**
   * `/effort` (both forms): fetch supported-models and resolve the current
   * model's levels. Bare form: open the selector. With `level`: validate
   * against the resolved levels and send — the one place a typo can surface
   * (the CLI runtime silently drops unknown levels into the settings
   * cascade). Not named open…Selector because the direct-set path never
   * opens one.
   */
  private handleEffortCommand(level?: string): void {
    // Only the bare form opens a selector, so only it takes a token.
    const token = level === undefined ? {} : undefined;
    if (token !== undefined) this.pendingSelectorRequest = token;
    void this.client.request({ type: "supported-models" }).then(
      (data) => {
        if (token !== undefined) {
          if (this.pendingSelectorRequest !== token) return;
          this.pendingSelectorRequest = undefined;
        }
        const effortLevels = effortLevelsOf(
          data as ModelInfo[],
          this.agentState.model,
        );
        if (effortLevels.kind !== "levels") {
          this.transcript.addBanner({
            text:
              effortLevels.kind === "unknownModel"
                ? "cannot determine effort levels for the current model"
                : "current model does not support effort levels",
            color: "warning",
          });
          this.ui.requestRender();
          return;
        }
        const { model, levels } = effortLevels;
        if (level !== undefined) {
          const validated = levels.find((candidate) => candidate === level);
          if (validated === undefined) {
            this.transcript.addBanner({
              text: `invalid effort level ${level}; ${model.displayName} supports: ${levels.join(", ")}`,
              color: "warning",
            });
            this.ui.requestRender();
          } else {
            this.sendSetEffort(validated);
          }
          return;
        }
        const selector = new EffortSelectorComponent(
          levels,
          (picked) => {
            this.occupyInputSlot({ kind: "editor" });
            this.sendSetEffort(picked);
          },
          () => this.occupyInputSlot({ kind: "editor" }),
        );
        this.occupyInputSlot({ kind: "effortSelector", selector });
      },
      (error: unknown) => {
        if (token !== undefined && this.pendingSelectorRequest === token) {
          this.pendingSelectorRequest = undefined;
        }
        this.transcript.addBanner({
          text: `supported-models failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      },
    );
  }

  private sendSetEffort(level: EffortLevel): void {
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({
        type: "apply-flag-settings",
        settings: { effortLevel: level },
      })
      .catch((error: unknown) => {
        this.transcript.addBanner({
          text: `apply-flag-settings failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      });
  }

  private openTreeSelector(): void {
    this.pendingSelectorRequest = undefined;
    const fileSessionModel = this.fileSessionModel();
    if (fileSessionModel === undefined) {
      this.transcript.addBanner({
        text: "no session file to navigate yet",
        color: "warning",
      });
      this.ui.requestRender();
      return;
    }
    // The rows come from the file session's display tree, rendered once at
    // open; picks resolve on the context tree (a picked row's parent — e.g.
    // of a post-compaction user row — is a relinked occurrence the display
    // tree hides). The marker is the session model's leaf, not leaf(agentState):
    // the state's is the query-side leaf, which names an entry not yet in
    // the tree while the query leads the file.
    const selector = new TreeSelectorComponent(
      fileSessionModel.leaf,
      fileSessionModel.displayTree,
      fileSessionModel.byUuid,
      fileSessionModel.toolNames,
      this.settings.tree,
      (pick) => this.confirmTreePick(fileSessionModel, pick),
      () => this.occupyInputSlot({ kind: "editor" }),
    );
    this.occupyInputSlot({ kind: "treeSelector", selector });
  }

  /** The selector stays dumb; the busy gate and the request live here. The
   *  pick resolves on the session model the selector showed. */
  private confirmTreePick(
    fileSessionModel: SessionModel,
    pick: TreeNodeRef,
  ): void {
    if (!isIdle(this.agentState)) {
      this.hintText.setText(
        theme.fg("dim", "cannot navigate tree while assistant is busy"),
      );
      this.ui.requestRender();
      return;
    }
    const action = resolveTreePick(
      fileSessionModel.contextTree,
      fileSessionModel.byUuid,
      pick,
    );
    this.occupyInputSlot({ kind: "editor" });
    const request =
      action.rewindTo === null
        ? { type: "set-context" as const, uuids: [] }
        : { type: "set-context" as const, rewindTo: action.rewindTo };
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
        this.transcript.addBanner({
          text: `set-context failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      },
    );
  }

  /**
   * Registered as a TUI input listener, which pi-tui runs before the focused
   * component sees the key: `{consume: true}` stops dispatch there (keeping
   * these bindings global instead of becoming editor input), undefined lets
   * the key fall through. The return type is structural because pi-tui does
   * not export its InputListenerResult.
   */
  private handleGlobalKey(data: string): { consume: boolean } | undefined {
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.transcript.setToolsExpanded(this.toolsExpanded);
      this.transcript.setCompactSummaryExpanded(this.toolsExpanded);
      this.ui.requestRender();
      return { consume: true };
    }
    if (this.keybindings.matches(data, "app.thinking.toggle")) {
      this.showThinking = !this.showThinking;
      this.transcript.setShowThinking(this.showThinking);
      this.ui.requestRender();
      return { consume: true };
    }
    if (this.keybindings.matches(data, "app.detach")) {
      this.finish({ kind: "detached" });
      return { consume: true };
    }
    // Every other key reaches the input slot's occupant through focus.
    this.hintText.setText("");
    return undefined;
  }

  private cyclePermissionMode(): void {
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({
        type: "set-permission-mode",
        mode: nextPermissionMode(this.agentState),
      })
      .catch((error: unknown) => {
        this.transcript.addBanner({
          text: `set-permission-mode failed: ${String(error)}`,
          color: "error",
        });
        this.ui.requestRender();
      });
  }

  /** Release everything that would keep the process alive after the TUI
   *  stops: the footer's git watchers and the activity spinner's interval
   *  (running whenever the agent is not idle at detach time). */
  dispose(): void {
    this.footerData?.dispose();
    this.loader.stop();
  }

  private syncActivity(): void {
    this.footer.setState(this.agentState);
    this.transcript.setCwd(this.agentState.cwd);
    if (this.agentState.cwd !== undefined) {
      this.footerData?.setCwd(this.agentState.cwd);
    }
    // A blocked agent shows the dialog, not a spinner (claude shows none).
    if (
      this.agentState.activity === "idle" ||
      allPendingAsks(this.agentState).length > 0
    ) {
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
