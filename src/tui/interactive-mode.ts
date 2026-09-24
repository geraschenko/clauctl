/**
 * The interactive mode: assembly + event dispatch, mirroring the shape of
 * pi's interactive-mode.ts (single event switch dispatching to components)
 * at a fraction of the size — everything pi-core-specific (extensions,
 * session trees, model registry, settings, auth) has no counterpart here.
 * All claude-specificity of *content* lives in sdk-render.ts; this file owns
 * layout, keybindings, and the AgentEvent → component dispatch.
 */

import {
  Container,
  Editor,
  getKeybindings,
  isViewportTUI,
  KeybindingsManager,
  Loader,
  ProcessTerminal,
  ScrollView,
  setKeybindings,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Component,
  type StackEntry,
  type TUI,
  type TuiMode,
} from "@earendil-works/pi-tui";
import { copyToClipboard, initTheme } from "@earendil-works/pi-coding-agent";
import type {
  EffortLevel,
  ModelInfo,
  PermissionMode,
  SDKControlInitializeResponse,
} from "@anthropic-ai/claude-agent-sdk";
import {
  anomalyReport,
  isIdle,
  type AgentState,
} from "../core/agent-state/agent-state.ts";
import { randomUUID, type UUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "../core/session/file.ts";
import type { TreeNodeRef } from "../core/tree/nodes.ts";
import type {
  AgentEvent,
  ProtocolClient,
  GetEntriesResponse,
} from "../core/protocol.ts";
import { findFd, TuiAutocompleteProvider } from "./autocomplete.ts";
import { EffortSelectorComponent } from "./components/effort-selector.ts";
import { FooterComponent } from "./components/footer.ts";
import { FooterDataProvider } from "./footer-data-provider.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { PendingMessagesComponent } from "./components/pending-messages.ts";
import {
  resolveTreePick,
  TreeSelectorComponent,
} from "./components/tree-selector.ts";
import {
  CLAUCTL_KEYBINDINGS,
  conflictWarnings,
  keybindingsPath,
  promoteEditedDefaults,
  readKeybindingsConfig,
  writeDefaultBindings,
} from "./keybindings.ts";
import {
  editFileInExternalEditor,
  externalEditorCommand,
} from "./external-editor.ts";
import { VERSION } from "../core/generated/version.ts";
import { userText } from "./sdk-render.ts";
import type { SessionModel } from "./session-model.ts";
import { SessionModels } from "./session-models.ts";
import { readSettings, settingsPath } from "./settings.ts";
import { TranscriptRenderer } from "./transcript.ts";
import { getEditorTheme, theme, type ThemeColor } from "./theme.ts";

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
 * Parse the locally intercepted `/effort` command; same first-token parse
 * as parseModelCommand. `level` undefined means bare `/effort` (open the
 * menu).
 */
export function parseEffortCommand(
  text: string,
): { level: string | undefined } | null {
  const trimmed = text.trim();
  const spaceIndex = trimmed.search(/\s/);
  const token = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  if (token !== "/effort") {
    return null;
  }
  const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  return { level: arg === "" ? undefined : arg };
}

/** How an interactive session ended; attach.ts turns this into the exit
 *  message and code. */
export type InteractiveOutcome =
  | { kind: "detached" } // app.detach pressed; the agent keeps running
  | { kind: "shutdown"; reason: string } // daemon shutdown event received
  | { kind: "connectionLost" }; // socket closed unannounced (daemon crash)

/**
 * Connect the TUI to a subscribed client. Owns the subscribe ordering: events
 * may be delivered before the snapshot promise settles (ProtocolClient
 * contract), so they buffer in a closure until InteractiveMode exists — the
 * same gating `tail` does. Resolves with how the session ended: `done`
 * (detach key, shutdown event) races the event pump, whose own end means the
 * socket closed unannounced — the pump subsumes waitClosed because the event
 * queue closes with the socket, and draining it first is what lets a shutdown
 * line already on the wire still win the race.
 */
export async function runInteractive(
  client: ProtocolClient,
  logDirectory: string,
): Promise<InteractiveOutcome> {
  initTheme("dark");
  // The global manager must be set before InteractiveMode exists: its Editor
  // resolves tui.* ids against getKeybindings(), which otherwise caches a
  // TUI_KEYBINDINGS-only fallback on first use.
  const configRead = readKeybindingsConfig(
    keybindingsPath(),
    CLAUCTL_KEYBINDINGS,
  );
  const keybindingWarnings = configRead.ok
    ? [...configRead.warnings]
    : [`config ignored, using defaults: ${configRead.error}`];
  const keybindings = new KeybindingsManager(
    CLAUCTL_KEYBINDINGS,
    configRead.ok ? configRead.bindings : {},
  );
  setKeybindings(keybindings);
  keybindingWarnings.push(...conflictWarnings(keybindings));
  const startupWarnings = keybindingWarnings.map(
    (warning) => `keybindings: ${warning}`,
  );
  if (client.versionWarning !== undefined) {
    startupWarnings.push(client.versionWarning);
  }
  const settingsRead = readSettings(settingsPath());
  startupWarnings.push(
    ...settingsRead.warnings.map((warning) => `settings: ${warning}`),
  );
  const { seed, events } = await client.subscribe({
    pid: process.pid,
    client: "clauctl attach",
  });
  const ui = createTui(settingsRead.settings.tuiMode, logDirectory);
  const interactiveMode = new InteractiveMode(
    ui,
    client,
    seed,
    startupWarnings,
    settingsRead.settings.showResolvedBoundary,
  );
  // Events arriving while the UI is built wait in the queue; the pump starts
  // only once there is something to hand them to. Racing it propagates a
  // handler failure, which would otherwise be an unhandled rejection.
  const pump = (async () => {
    for await (const { event, state } of events) {
      interactiveMode.handleEvent(event, state);
    }
  })();
  ui.start();
  try {
    // `done` settles inside the pump's iteration (handleEvent), strictly
    // before the pump itself can resolve — so an announced shutdown never
    // misreports as connectionLost.
    return await Promise.race([
      interactiveMode.done,
      pump.then((): InteractiveOutcome => ({ kind: "connectionLost" })),
    ]);
  } finally {
    // The mode is about to be disposed, so drop anything still queued.
    events.cancel();
    // Fullscreen restores the pre-attach main screen instead of dumping the
    // rendered document: attach/detach is frequent, and the transcript
    // remains available by reattaching.
    ui.stop({ preserveScreen: ui.mode === "fullscreen" });
    interactiveMode.dispose();
    client.close();
  }
}

/**
 * Renderer selection (the composition point for settings.tuiMode): regular
 * mode is pi-tui's main-buffer document renderer; fullscreen is the
 * alternate-screen viewport renderer, whose transcript search styling and
 * selection-copy mirror pi's createInteractiveTui. The hardware cursor stays
 * hidden and clear-on-shrink off (pi-tui's defaults; pi exposes both as
 * settings, we have no need yet). logDirectory is the agent directory —
 * pi-tui only writes there on a fatal render invariant (pi-tui-crash.log)
 * or under PI_TUI_DEBUG_REDRAW=1; without it crash dumps go to the OS temp
 * directory.
 */
function createTui(
  tuiMode: TuiMode,
  logDirectory: string,
): TuiMainScreen | TuiAltScreen {
  const terminal = new ProcessTerminal();
  if (tuiMode === "fullscreen") {
    const styleSearchMatch = (text: string) =>
      theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
    return new TuiAltScreen(terminal, false, logDirectory, {
      searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
      searchCurrentMatchStyle: (text) =>
        theme.bold(theme.inverse(styleSearchMatch(text))),
      copySelection: async (text) => {
        try {
          await copyToClipboard(text);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  return new TuiMainScreen(terminal, false, logDirectory);
}

/** The components the TUI composes, in one place so both mount paths draw
 *  from the same set. */
export interface TuiParts {
  chatContainer: Container;
  statusContainer: Container;
  pendingMessages: Component;
  editor: Component;
  hintText: Component;
  footer: Component;
}

/**
 * The non-transcript components in visual order, with their fullscreen dock
 * sizing (minSize keeps the editor at 3 rows and the footer at 1 on short
 * terminals). The single source of the below-transcript ordering: the
 * fullscreen dock VStack consumes the entries, the regular-mode flat mount
 * consumes just the components.
 */
function dockEntries(parts: TuiParts): StackEntry[] {
  return [
    { component: parts.statusContainer, shrink: 1, minSize: 0 },
    { component: parts.pendingMessages, shrink: 1, minSize: 0 },
    { component: parts.editor, shrink: 1, minSize: 3 },
    { component: parts.hintText, shrink: 1, minSize: 0 },
    { component: parts.footer, shrink: 1, minSize: 1 },
  ];
}

/** The layout TuiAltScreen renders: transcript in a scroll region that takes
 *  the spare height, everything else in a fixed-bottom dock. */
export interface FullscreenLayout {
  /** The component handed to TuiAltScreen.setLayoutRoot. */
  layoutRoot: VStack;
  transcriptScrollView: ScrollView;
}

/**
 * Pure layout composition (exported for tests): wraps the transcript
 * container in the primary ScrollView — follow:"end" keeps it pinned to new
 * output until the user scrolls, overscroll:"chain" lets wheel input past
 * the edges fall through — and docks the dockEntries components below it;
 * the transcript absorbs the spare height via grow:1.
 */
export function buildFullscreenLayout(parts: TuiParts): FullscreenLayout {
  const transcriptScrollView = new ScrollView(parts.chatContainer, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const layoutRoot = new VStack([
    {
      component: transcriptScrollView,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    },
    {
      component: new VStack(dockEntries(parts)),
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
  return { layoutRoot, transcriptScrollView };
}

/**
 * Mount the parts on the renderer — the one place that knows the two
 * rendering shapes. A viewport renderer gets the explicit layout root;
 * regular mode gets the flat document (transcript, then the dock components
 * in the same dockEntries order). Either/or, unlike pi's mount, which does
 * both unconditionally because its runtime mode switching moves the same
 * components between renderers; without that (a recorded non-goal), the
 * unused mount would just be a second copy of the layout to keep in sync.
 */
function mountParts(ui: TUI, parts: TuiParts): void {
  if (isViewportTUI(ui)) {
    ui.setLayoutRoot(buildFullscreenLayout(parts).layoutRoot);
    return;
  }
  ui.addChild(parts.chatContainer);
  for (const { component } of dockEntries(parts)) {
    ui.addChild(component);
  }
}

class InteractiveMode {
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
  private readonly editor: Editor;
  /** Git-branch data for the footer. The daemon always seeds cwd, so this
   *  is only undefined for a (theoretical) unseeded subscribe response —
   *  the footer then simply never shows a branch. */
  private readonly footerData: FooterDataProvider | undefined;
  private readonly footer: FooterComponent;

  /** All transcript content renders through this (recreated on reload). */
  private transcript: TranscriptRenderer;
  /** The global manager set by runInteractive; also consulted by pi-tui's
   *  Editor and SelectList, so remaps apply everywhere at once. */
  private readonly keybindings: KeybindingsManager;
  /** ctrl+o / ctrl+t toggles, reapplied to recreated renderers. */
  private toolsExpanded = false;
  private showThinking = false;
  private readonly showResolvedBoundary: boolean;

  /**
   * Live events held back until history replay finishes (undefined
   * afterwards), so live output cannot interleave with — or precede — the
   * replayed transcript.
   */
  private liveEventsDuringReplay: Array<[AgentEvent, AgentState]> | undefined =
    [];
  /** `reloadHistory` waiting for the buffer to reach its snapshot cut
   *  (`eventsBefore` counts events pushed to the subscription, which runs
   *  ahead of the pump that delivers them here). A shutdown inside the cut
   *  is never buffered, so the wait then stays pending — moot, the mode is
   *  finishing. */
  private cutAwaiter: { position: number; resolve: () => void } | undefined;
  /** Between `sessionFileChanged` and `scanComplete` the transcript is
   *  blank and nothing renders live: the scan's entries and the query
   *  messages arriving meanwhile reach it through the rebuild at the end. */
  private scanning = false;

  private readonly autocomplete: TuiAutocompleteProvider;
  private modelSelector?: ModelSelectorComponent;
  /** True from `/model` submit until the supported-models read settles. */
  private modelSelectorPending = false;
  private treeSelector?: TreeSelectorComponent;
  private effortSelector?: EffortSelectorComponent;
  /** True from `/effort` submit until the supported-models read settles. */
  private effortSelectorPending = false;

  constructor(
    ui: TUI,
    client: ProtocolClient,
    seedState: AgentState,
    startupWarnings: string[],
    showResolvedBoundary: boolean,
  ) {
    this.ui = ui;
    this.client = client;
    this.agentState = seedState;
    this.keybindings = getKeybindings();
    this.showResolvedBoundary = showResolvedBoundary;
    this.transcript = this.freshTranscript();
    this.sessionModels = new SessionModels(
      (message) => this.addBanner(message),
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
    this.editor = new Editor(ui, getEditorTheme());
    this.editor.onSubmit = (text: string) => this.submit(text);

    if (seedState.cwd !== undefined) {
      this.footerData = new FooterDataProvider(seedState.cwd);
      this.footerData.onBranchChange(() => this.ui.requestRender());
    }
    this.footer = new FooterComponent(this.footerData);

    mountParts(ui, {
      chatContainer: this.chatContainer,
      statusContainer: this.statusContainer,
      pendingMessages: this.pendingMessages,
      editor: this.editor,
      hintText: this.hintText,
      footer: this.footer,
    });
    ui.setFocus(this.editor);
    ui.addInputListener((data) => this.handleGlobalKey(data));

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
        this.addBanner(`command list fetch failed: ${String(error)}`);
        this.ui.requestRender();
      },
    );

    this.syncActivity();
  }

  /**
   * The attach-time history fetch: `get-entries {payload: "full"}` seeds
   * the session models (the response's event count is its snapshot cut,
   * and the state at that cut is the one the daemon answered against —
   * read from the buffer once the pump has delivered that far), the
   * buffered live events release their state effects, then the transcript
   * fills from the models below the startup banners — unless the release
   * left a scan window open, whose `scanComplete` rebuilds instead.
   * `startupWarnings` describe the keybindings and settings as read at
   * start, so only this first transcript shows them; rebuilds do not.
   */
  private async reloadHistory(startupWarnings: string[]): Promise<void> {
    for (const warning of startupWarnings) {
      this.transcript.addBanner(warning, "warning");
    }
    this.liveEventsDuringReplay = [];
    try {
      const { data, eventsBefore } = await this.client.requestWithEventCount({
        type: "get-entries",
        payload: "full",
      });
      const snapshot = data as GetEntriesResponse;
      await this.bufferedUpTo(eventsBefore);
      this.sessionModels.applySnapshot(
        snapshot.entries!,
        eventsBefore,
        this.stateAtCut(eventsBefore),
      );
    } catch (error) {
      this.addBanner(`history fetch failed: ${String(error)}`);
      this.sessionModels.applySnapshot([], 0, this.agentState);
    }
    const buffered = this.liveEventsDuringReplay;
    this.liveEventsDuringReplay = undefined;
    for (const [event, state] of buffered) {
      this.applyState(event, state);
    }
    if (!this.scanning) {
      this.renderHistory();
    }
    this.ui.requestRender();
  }

  /** Resolves once `liveEventsDuringReplay` holds `position` events. */
  private bufferedUpTo(position: number): Promise<void> {
    return this.liveEventsDuringReplay!.length >= position
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.cutAwaiter = { position, resolve };
        });
  }

  /** The state the first `eventsBefore` buffered events folded to: the
   *  seed when none preceded the snapshot response. */
  private stateAtCut(eventsBefore: number): AgentState {
    return eventsBefore === 0
      ? this.agentState
      : this.liveEventsDuringReplay![eventsBefore - 1]![1];
  }

  private resetTranscript(): void {
    this.chatContainer.clear();
    this.transcript = this.freshTranscript();
  }

  /** An empty transcript with the welcome line at its top, so it heads the
   *  scrollback whatever follows. The welcome line self-identifies the
   *  product (Agent SDK branding guidelines: our own branding, not Claude
   *  Code's). */
  private freshTranscript(): TranscriptRenderer {
    const transcript = new TranscriptRenderer(
      this.chatContainer,
      this.showResolvedBoundary,
    );
    transcript.setCwd(this.agentState.cwd);
    transcript.setToolsExpanded(this.toolsExpanded);
    transcript.setCompactSummaryExpanded(this.toolsExpanded);
    transcript.setShowThinking(this.showThinking);
    transcript.addBanner(
      `Welcome to clauctl TUI ${theme.fg("dim", `v${VERSION}`)}`,
      "accent",
    );
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
    // replay: the socket may close right behind it, and a buffered shutdown
    // would then misreport as connectionLost.
    if (event.kind === "shutdown") {
      this.finish({ kind: "shutdown", reason: event.reason });
      return;
    }
    // The session models see every event as it arrives — their snapshot
    // cut is a socket position — while state and rendering wait out the
    // history replay. Live, the state (and its scan gate) updates before
    // the models fire `onResolved`, so the callback reads the current gate.
    if (this.liveEventsDuringReplay !== undefined) {
      this.sessionModels.observe(event, state);
      this.liveEventsDuringReplay.push([event, state]);
      if (
        this.cutAwaiter !== undefined &&
        this.liveEventsDuringReplay.length >= this.cutAwaiter.position
      ) {
        this.cutAwaiter.resolve();
        this.cutAwaiter = undefined;
      }
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
   *  transcript effect that must survive a buffered release. Runs for every
   *  event, including the ones released after attach. */
  private applyState(event: AgentEvent, state: AgentState): void {
    this.agentState = state;
    if (event.kind === "sessionFileChanged") {
      this.scanning = true;
    } else if (event.kind === "scanComplete") {
      this.scanning = false;
    }
    // The daemon reports every anomaly it detects, its own fold's included,
    // so `state.anomaly` (the TUI's fold detecting the same thing) is not
    // read: the report names the bundle.
    if (event.kind === "trackerAnomaly") {
      this.addBanner(anomalyReport(event.anomaly, event.bundlePath), "warning");
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
      this.treeSelector?.setWarning(
        "context changed while the tree selector is open",
      );
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
        this.addEventBanner("interrupted", event.uuid);
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
      this.liveEventsDuringReplay !== undefined ||
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
      this.liveEventsDuringReplay !== undefined ||
      this.scanning ||
      sessionId !== this.agentState.querySessionId
    ) {
      return;
    }
    this.rebuildTranscript();
  }

  private addBanner(text: string, color: ThemeColor = "dim"): void {
    // Through the renderer so banners keep their transcript position across
    // its fold-state rebuilds.
    this.transcript.addBanner(text, color);
  }

  /** A banner rendering the query-side event `uuid`, keyed so the
   *  event's resolution moves it. The event folds (and the session models
   *  observe) before it renders, so a resolution in its own step has
   *  already fired: then the banner is resolved here. */
  private addEventBanner(text: string, uuid: UUID): void {
    this.transcript.addBanner(text, "dim", uuid);
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
      void this.openKeybindingsEditor();
      return;
    }
    if (/^\/reload-keybindings(\s|$)/.test(text.trim())) {
      this.reloadKeybindings();
      return;
    }
    // The queued echo comes back as a userMessageQueued event; nothing is
    // rendered here.
    void this.client
      .request({ type: "prompt", content: text })
      .catch((error: unknown) => {
        this.addBanner(`prompt failed: ${String(error)}`);
        this.ui.requestRender();
      });
  }

  /**
   * `/keybindings`: refresh default_bindings (skipped with a banner when the
   * existing file is unparseable — the editor still opens, since this is
   * also the repair tool), edit the file in $VISUAL/$EDITOR with the TUI
   * suspended, promote post-editor default_bindings edits to top-level
   * overrides (only when the refresh succeeded — without that baseline,
   * drift is not attributable to this session), then reload.
   */
  private async openKeybindingsEditor(): Promise<void> {
    const editorCommand = externalEditorCommand();
    if (editorCommand === undefined) {
      this.addBanner("set $EDITOR to edit keybindings", "warning");
      this.ui.requestRender();
      return;
    }
    const path = keybindingsPath();
    let refreshed = true;
    try {
      writeDefaultBindings(path, CLAUCTL_KEYBINDINGS);
    } catch (error) {
      refreshed = false;
      this.addBanner(
        `keybindings: defaults refresh skipped: ${String(error)}`,
        "warning",
      );
    }
    const exitedZero = await editFileInExternalEditor(
      this.ui,
      editorCommand,
      path,
    );
    if (!exitedZero) {
      this.addBanner(
        "keybindings: editor exited nonzero; changes not applied",
        "warning",
      );
      this.ui.requestRender();
      return;
    }
    if (refreshed) {
      try {
        const { warnings } = promoteEditedDefaults(path, CLAUCTL_KEYBINDINGS);
        for (const warning of warnings) {
          this.addBanner(`keybindings: ${warning}`, "warning");
        }
      } catch (error) {
        this.addBanner(`keybindings: ${String(error)}`, "error");
        this.ui.requestRender();
        return;
      }
    }
    this.reloadKeybindings();
  }

  /**
   * `/reload-keybindings` (also the tail of openKeybindingsEditor): re-read
   * the config and apply it to the existing manager instance — pi-tui
   * components hold the same reference, so they see the change. A fatal
   * read keeps the current live bindings: a temporary syntax error must not
   * strip a working configuration.
   */
  private reloadKeybindings(): void {
    const configRead = readKeybindingsConfig(
      keybindingsPath(),
      CLAUCTL_KEYBINDINGS,
    );
    if (!configRead.ok) {
      this.addBanner(`keybindings not reloaded: ${configRead.error}`, "error");
      this.ui.requestRender();
      return;
    }
    this.keybindings.setUserBindings(configRead.bindings);
    const warnings = [
      ...configRead.warnings,
      ...conflictWarnings(this.keybindings),
    ];
    if (warnings.length === 0) {
      this.addBanner("keybindings reloaded");
    } else {
      for (const warning of warnings) {
        this.addBanner(`keybindings: ${warning}`, "warning");
      }
    }
    this.ui.requestRender();
  }

  /**
   * app.editor.external (ctrl+g): edit the prompt in $VISUAL/$EDITOR with
   * the TUI suspended. Exit 0 replaces the editor content — stripping one
   * trailing newline, matching pi — nonzero keeps the original text. Events
   * arriving while the TUI is suspended are not lost: rendering is
   * deferred, not the socket-driven handleEvent (see the spec's WORK LOG,
   * 2026-07-21).
   */
  private async openExternalPromptEditor(): Promise<void> {
    const editorCommand = externalEditorCommand();
    if (editorCommand === undefined) {
      this.addBanner("set $EDITOR to edit the prompt", "warning");
      this.ui.requestRender();
      return;
    }
    const tempPath = join(tmpdir(), `clauctl-editor-${randomUUID()}.md`);
    try {
      writeFileSync(tempPath, this.editor.getText(), "utf8");
      const exitedZero = await editFileInExternalEditor(
        this.ui,
        editorCommand,
        tempPath,
      );
      if (exitedZero) {
        this.editor.setText(readFileSync(tempPath, "utf8").replace(/\n$/, ""));
      }
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Cleanup is best-effort; the file is in tmpdir anyway.
      }
    }
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
   * `/effort` (both forms): fetch supported-models and resolve the current
   * model's levels. Bare form: open the selector. With `level`: validate
   * against the resolved levels and send — the one place a typo can surface
   * (the CLI runtime silently drops unknown levels into the settings
   * cascade). Not named open…Selector because the direct-set path never
   * opens one.
   */
  private handleEffortCommand(level?: string): void {
    if (this.effortSelector !== undefined || this.effortSelectorPending) {
      return;
    }
    this.effortSelectorPending = true;
    void this.client.request({ type: "supported-models" }).then(
      (data) => {
        this.effortSelectorPending = false;
        const models = data as ModelInfo[];
        // agentState.model holds a set-model request value or the SDK init
        // message's resolved id, depending on history — so match both.
        const current = this.agentState.model;
        const matched = models.find(
          (model) =>
            current !== undefined &&
            (model.value === current || model.resolvedModel === current),
        );
        if (matched === undefined) {
          this.addBanner(
            "cannot determine effort levels for the current model",
            "warning",
          );
          this.ui.requestRender();
          return;
        }
        const levels = matched.supportedEffortLevels ?? [];
        if (levels.length === 0) {
          this.addBanner(
            "current model does not support effort levels",
            "warning",
          );
          this.ui.requestRender();
          return;
        }
        if (level !== undefined) {
          const validated = levels.find((candidate) => candidate === level);
          if (validated === undefined) {
            this.addBanner(
              `invalid effort level ${level}; ${matched.displayName} supports: ${levels.join(", ")}`,
              "warning",
            );
            this.ui.requestRender();
          } else {
            this.sendSetEffort(validated);
          }
          return;
        }
        const selector = new EffortSelectorComponent(
          levels,
          (picked) => {
            this.closeEffortSelector();
            this.sendSetEffort(picked);
          },
          () => this.closeEffortSelector(),
        );
        this.effortSelector = selector;
        this.statusContainer.addChild(selector);
        this.ui.setFocus(selector);
        this.ui.requestRender();
      },
      (error: unknown) => {
        this.effortSelectorPending = false;
        this.addBanner(`supported-models failed: ${String(error)}`, "error");
        this.ui.requestRender();
      },
    );
  }

  private closeEffortSelector(): void {
    if (this.effortSelector === undefined) {
      return;
    }
    this.statusContainer.removeChild(this.effortSelector);
    this.effortSelector = undefined;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private sendSetEffort(level: EffortLevel): void {
    // No optimistic footer update: it follows from the controlApplied event.
    void this.client
      .request({
        type: "apply-flag-settings",
        settings: { effortLevel: level },
      })
      .catch((error: unknown) => {
        this.addBanner(`apply-flag-settings failed: ${String(error)}`, "error");
        this.ui.requestRender();
      });
  }

  private openTreeSelector(): void {
    if (this.treeSelector !== undefined) {
      return;
    }
    const fileSessionModel = this.fileSessionModel();
    if (fileSessionModel === undefined) {
      this.addBanner("no session file to navigate yet", "warning");
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
      (pick) => this.confirmTreePick(fileSessionModel, pick),
      () => this.closeTreeSelector(),
    );
    this.treeSelector = selector;
    this.statusContainer.addChild(selector);
    this.ui.setFocus(selector);
    this.ui.requestRender();
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
    this.closeTreeSelector();
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
    // An open menu owns the interrupt and clear chords (cancel / clear
    // search via tui.select.cancel, which the focused selector handles).
    const selectorOpen =
      this.modelSelector !== undefined ||
      this.treeSelector !== undefined ||
      this.effortSelector !== undefined;
    if (
      this.keybindings.matches(data, "app.interrupt") &&
      !isIdle(this.agentState) &&
      !selectorOpen
    ) {
      void this.client.request({ type: "interrupt" }).catch(() => {});
      return { consume: true };
    }
    if (this.keybindings.matches(data, "app.permissionMode.cycle")) {
      this.cyclePermissionMode();
      return { consume: true };
    }
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
    if (
      this.keybindings.matches(data, "app.editor.external") &&
      !selectorOpen
    ) {
      void this.openExternalPromptEditor().catch((error: unknown) => {
        this.addBanner(`external editor failed: ${String(error)}`, "error");
        this.ui.requestRender();
      });
      return { consume: true };
    }
    if (this.keybindings.matches(data, "app.clear") && !selectorOpen) {
      // Cleared text stays reachable via up/down history (unlike pi, which
      // discards it).
      const clearedText = this.editor.getText();
      if (clearedText.trim() !== "") {
        this.editor.addToHistory(clearedText);
      }
      this.editor.setText("");
      this.hintText.setText(
        theme.fg(
          "dim",
          `detach with ${this.keybindings.getKeys("app.detach").join(", ")}`,
        ),
      );
      this.ui.requestRender();
      return { consume: true };
    }
    if (this.keybindings.matches(data, "app.detach")) {
      this.finish({ kind: "detached" });
      return { consume: true };
    }
    this.hintText.setText("");
    return undefined;
  }

  private cyclePermissionMode(): void {
    const cycle: PermissionMode[] = [];
    for (const mode of [
      "default" as const,
      "plan" as const,
      "acceptEdits" as const,
      "auto" as const,
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
