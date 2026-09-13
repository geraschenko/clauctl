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
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isIdle, leaf, type AgentState } from "../core/agent-state.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  entryToSessionMessage,
  queuedCommandPrompt,
  type SessionEntry,
} from "../core/session/file.ts";
import { pathToLeaf, type TreeNodeRef } from "../core/tree/nodes.ts";
import type {
  AgentEvent,
  SdkSocketClient,
  GetEntriesResponse,
} from "../core/sdk-socket.ts";
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
import { pathUpToBoundary, releaseDedupeUuid, userText } from "./sdk-render.ts";
import { SessionModel } from "./session-model.ts";
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
 * may be delivered before the snapshot promise settles (SdkSocketClient
 * contract), so they buffer in a closure until InteractiveMode exists — the
 * same gating `tail` does. Resolves with how the session ended: `done`
 * (detach key, shutdown event) races the event pump, whose own end means the
 * socket closed unannounced — the pump subsumes waitClosed because the event
 * queue closes with the socket, and draining it first is what lets a shutdown
 * line already on the wire still win the race.
 */
export async function runInteractive(
  client: SdkSocketClient,
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
 * selection-copy mirror pi's createInteractiveTui. logDirectory is the agent
 * directory — pi-tui only writes there on a fatal render invariant
 * (pi-crash.log) or under PI_DEBUG_REDRAW=1, and the default (~/.pi/agent)
 * is not ours to write into.
 */
function createTui(
  tuiMode: TuiMode,
  logDirectory: string,
): TuiMainScreen | TuiAltScreen {
  const terminal = new ProcessTerminal();
  if (tuiMode === "fullscreen") {
    const styleSearchMatch = (text: string) =>
      theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
    return new TuiAltScreen(terminal, undefined, logDirectory, {
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
  return new TuiMainScreen(terminal, undefined, logDirectory);
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
  private readonly client: SdkSocketClient;
  /**
   * Seeded from the subscribe response and assigned the post-fold state the
   * client delivers with each live event — the client runs the same fold the
   * daemon does, so this always matches the daemon's state. Historical
   * replay renders transcript messages but must not advance this state
   * (they predate the seed).
   */
  private agentState: AgentState;
  /** Entries, payloads and trees, fed every event in socket order; the
   *  transcript and `/tree` read it instead of fetching. */
  private readonly sessionModel: SessionModel;

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
  /**
   * Queued prompts retained by queue id so the dequeue echo can render the
   * full SDKUserMessage through appendUserTurn (the pending area shows only
   * the preview text).
   */
  private readonly queuedById = new Map<number, SDKUserMessage>();
  /** The global manager set by runInteractive; also consulted by pi-tui's
   *  Editor and SelectList, so remaps apply everywhere at once. */
  private readonly keybindings: KeybindingsManager;
  /** ctrl+o / ctrl+t toggles, reapplied to recreated renderers. */
  private toolsExpanded = false;
  private showThinking = false;

  /**
   * Live events held back until history replay finishes (undefined
   * afterwards), so live output cannot interleave with — or precede — the
   * replayed transcript.
   */
  private liveEventsDuringReplay: Array<[AgentEvent, AgentState]> | undefined =
    [];

  /**
   * Release dedupe (defined only during reloadHistory's release loop):
   * uuids rendered from a replayed path — the attach redraw's, and any
   * buffered contextChanged's redraw during the loop. A buffered event
   * carrying one of them advances agentState but renders nothing — the
   * snapshot can include entries newer than the seed leaf, which are also
   * in the buffer.
   */
  private replayedUuids: Set<string> | undefined;
  /** Buffered contextChanged events not yet released; each redraws the
   *  transcript, superseding the redraws before it. */
  private pendingContextChanges = 0;

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
  private effortSelector?: EffortSelectorComponent;
  /** True from `/effort` submit until the supported-models read settles. */
  private effortSelectorPending = false;

  constructor(
    ui: TUI,
    client: SdkSocketClient,
    seedState: AgentState,
    startupWarnings: string[],
  ) {
    this.ui = ui;
    this.client = client;
    this.agentState = seedState;
    this.keybindings = getKeybindings();
    this.transcript = new TranscriptRenderer(this.chatContainer);
    this.sessionModel = new SessionModel((message) => this.addBanner(message));
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
      this.queuedById.set(entry.id, entry.message);
      this.pendingMessages.add(entry.id, userText(entry.message));
    }
    void this.reloadHistory();
    // After reloadHistory's synchronous prefix, which recreates the
    // transcript renderer — banners added earlier would be wiped. The
    // welcome line self-identifies the product on attach (Agent SDK
    // branding guidelines: our own branding, not Claude Code's).
    this.addBanner(
      `Welcome to clauctl TUI ${theme.fg("dim", `v${VERSION}`)}`,
      "accent",
    );
    for (const warning of startupWarnings) {
      this.addBanner(warning, "warning");
    }

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
   * the session model (the response's event count is its snapshot cut),
   * the transcript renders from the session model, then the buffered live
   * events are released. Path-vs-buffer duplication is deduped by replayedUuids
   * during the release loop.
   */
  private async reloadHistory(): Promise<void> {
    this.resetTranscript();
    this.liveEventsDuringReplay = [];
    try {
      const { data, eventsBefore } = await this.client.requestWithEventCount({
        type: "get-entries",
        payload: "full",
      });
      const snapshot = data as GetEntriesResponse;
      this.sessionModel.applySnapshot(snapshot.entries!, eventsBefore);
    } catch (error) {
      this.addBanner(`history fetch failed: ${String(error)}`);
      this.sessionModel.applySnapshot([], 0);
    }
    const buffered = this.liveEventsDuringReplay ?? [];
    this.liveEventsDuringReplay = undefined;
    this.pendingContextChanges = buffered.filter(
      ([event]) => event.kind === "contextChanged",
    ).length;
    const replayed = new Set<string>();
    this.renderHistory(replayed);
    this.replayedUuids = replayed;
    try {
      for (const [event, state] of buffered) {
        if (event.kind === "contextChanged") {
          this.pendingContextChanges -= 1;
        }
        this.applyEvent(event, state);
      }
    } finally {
      this.replayedUuids = undefined;
    }
    this.ui.requestRender();
  }

  private resetTranscript(): void {
    this.chatContainer.clear();
    this.transcript = new TranscriptRenderer(this.chatContainer);
    this.transcript.setCwd(this.agentState.cwd);
    this.transcript.setToolsExpanded(this.toolsExpanded);
    this.transcript.setCompactSummaryExpanded(this.toolsExpanded);
    this.transcript.setShowThinking(this.showThinking);
    this.replayedBoundaryUuids.clear();
  }

  /**
   * Render the session model's root-to-leaf display path cut at the state
   * fold's leaf (pathUpToBoundary), then the delivered-but-unconfirmed
   * prompts. `replayed` collects the uuids rendered.
   *
   * Two leaves because they play different roles. The path runs to the
   * session model's leaf — the file's tip as far as the model knows —
   * because pathUpToBoundary keeps the boundary banners and summaries
   * beyond the cut (their live events render no text) and because a
   * missing cut falls back to the whole path. The state leaf is the cut:
   * the buffered live events resume right after it.
   *
   * When the state leaf is missing from the path, exactly-once is
   * unachievable: the whole path replays behind a warning banner — unless a
   * buffered contextChanged is still pending, whose redraw supersedes this
   * one (the context change moved the leaf between seed and snapshot), so
   * warning would be spurious.
   */
  private renderHistory(replayed: Set<string>): void {
    const displayTree = this.sessionModel.displayTree;
    const byUuid = this.sessionModel.byUuid;
    // Leaves map to the visible node that carries them (a hidden relinked
    // leaf renders as its summary's line). A stale leaf maps to itself, so
    // the raced-leaf handling below still warns.
    const sessionLeaf = this.sessionModel.leaf;
    const leafNode =
      sessionLeaf === null
        ? undefined
        : displayTree.nearestVisibleNode(sessionLeaf);
    const path = pathToLeaf(displayTree.parentMap, byUuid, leafNode ?? null);
    const stateLeaf = leaf(this.agentState);
    const { nodes, boundaryMissing } = pathUpToBoundary(
      path,
      byUuid,
      stateLeaf === null
        ? undefined
        : displayTree.nearestVisibleNode(stateLeaf),
    );
    // pathToLeaf validated every path uuid against byUuid, so the lookup
    // cannot miss.
    for (const ref of nodes) {
      this.renderEntry(byUuid.get(ref.uuid)!, replayed);
    }
    if (boundaryMissing && this.pendingContextChanges === 0) {
      this.addBanner(
        "history attach point not found; recent messages may be missing or duplicated",
      );
    }
    // Delivered-but-unconfirmed prompts (the prompt-visibility invariant,
    // agent-state.ts): dequeued before the state snapshot was taken with the
    // transcript echo still pending, so they are in neither the leaf-cut
    // path nor the buffered events. Chronologically they follow the
    // replayed transcript.
    for (const message of this.agentState.deliveredMessages) {
      this.transcript.appendUserTurn(message);
    }
  }

  /**
   * One path entry: the rendering itself lives in
   * TranscriptRenderer.appendEntry; this wrapper keeps only the replay
   * dedupe bookkeeping (which uuids rendered, so their buffered live events
   * fold without re-rendering). It re-derives the rendered uuid with the
   * same entryToSessionMessage the renderer uses — a pure conversion, run
   * twice so the renderer stays free of attach-only dedupe state.
   */
  private renderEntry(entry: SessionEntry, replayed: Set<string>): void {
    if (entry.subtype === "compact_boundary") {
      if (entry.uuid !== undefined) {
        replayed.add(entry.uuid);
        this.replayedBoundaryUuids.add(entry.uuid);
      }
    } else if (queuedCommandPrompt(entry) !== undefined) {
      if (entry.uuid !== undefined) {
        replayed.add(entry.uuid);
      }
    } else {
      const message = entryToSessionMessage(entry);
      if (message !== undefined) {
        replayed.add(message.uuid);
      }
    }
    this.transcript.appendEntry(entry);
  }

  handleEvent(event: AgentEvent, state: AgentState): void {
    // The session model sees every event as it arrives — its snapshot cut
    // is a socket position — while rendering waits out the history replay.
    this.sessionModel.observe(event);
    // Terminal and order-independent, so it must not wait out a history
    // replay: the socket may close right behind it, and a buffered shutdown
    // would then misreport as connectionLost.
    if (event.kind === "shutdown") {
      this.finish({ kind: "shutdown", reason: event.reason });
      return;
    }
    if (this.liveEventsDuringReplay !== undefined) {
      this.liveEventsDuringReplay.push([event, state]);
      return;
    }
    this.applyEvent(event, state);
  }

  private applyEvent(event: AgentEvent, state: AgentState): void {
    this.agentState = state;
    // `anomaly` names the event just folded (agent-state.ts), so reading it
    // per event shows each anomaly once, whichever event's fold raised it.
    if (state.anomaly !== undefined) {
      this.addBanner(
        `tracker anomaly ${state.anomaly.kind}: ${state.anomaly.detail}`,
        "warning",
      );
    }
    // The switch is rendering-only dispatch; all state effects (footer
    // fields, mode cycle, activity) come from the delivered state above.
    switch (event.kind) {
      case "userMessageQueued":
        this.queuedById.set(event.id, event.message);
        this.pendingMessages.add(event.id, userText(event.message));
        break;
      case "userMessageDequeued":
        // The dequeue's stream position is the correct transcript position;
        // the retained message renders through the same appendUserTurn the
        // replay path uses. A steered message renders from its
        // `queued_command` attachment entry instead (the sessionEntry case),
        // where history replay finds it too.
        this.pendingMessages.take(event.ids);
        for (const id of event.ids) {
          const message = this.queuedById.get(id);
          this.queuedById.delete(id);
          if (message !== undefined && event.delivery !== "steer") {
            this.transcript.appendUserTurn(message);
          }
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
        // agentState already holds the new leaf, so the redraw cuts the
        // fresh path at the right occurrence.
        this.resetTranscript();
        this.renderHistory(this.replayedUuids ?? new Set());
        break;
      case "sdkMessage":
        this.handleSdkMessage(event.message);
        break;
      case "sessionEntry":
        // The session-only entries with transcript content of their own
        // (today: the steered prompt); shared entries render from their
        // sdkMessage twin. Appended at arrival, which trails the query
        // stream: an entry may land after a later sdkMessage (rare; see
        // docs/thoughts/transcript-order.md). Release dedupe as in
        // handleSdkMessage: a buffered event whose entry the replayed path
        // already rendered renders nothing.
        if (
          queuedCommandPrompt(event.entry) !== undefined &&
          (event.entry.uuid === undefined ||
            !this.replayedUuids?.has(event.entry.uuid))
        ) {
          this.transcript.appendEntry(event.entry);
        }
        break;
      // The rest of the session stream feeds the session model
      // (handleEvent) and renders nothing itself.
      case "sessionFileChanged":
      case "scanComplete":
      case "sessionAppended":
      case "trackerAnomaly":
        break;
    }
    this.syncActivity();
    this.ui.requestRender();
  }

  private handleSdkMessage(message: SDKMessage): void {
    // Release dedupe: a buffered event whose transcript entry already
    // rendered from the replayed path advances agentState (handleEvent,
    // before dispatch) but renders nothing — no second banner, no streaming
    // component, no tool-result re-resolution.
    const dedupeUuid = releaseDedupeUuid(message);
    if (dedupeUuid !== undefined && this.replayedUuids?.has(dedupeUuid)) {
      // A buffered banner event consumed here won't arrive again — release
      // its one-shot entry.
      this.replayedBoundaryUuids.delete(dedupeUuid);
      return;
    }
    if (message.type === "system") {
      // The two attach-only system effects; everything else renders (or
      // deliberately doesn't) in TranscriptRenderer.append.
      if (message.subtype === "commands_changed") {
        this.autocomplete.setCommands(message.commands);
        return;
      }
      if (
        message.subtype === "compact_boundary" &&
        message.uuid !== undefined &&
        this.replayedBoundaryUuids.delete(message.uuid)
      ) {
        return;
      }
    }
    this.transcript.append(message);
  }

  private addBanner(text: string, color: ThemeColor = "dim"): void {
    // Through the renderer so banners keep their transcript position across
    // its fold-state rebuilds.
    this.transcript.addBanner(text, color);
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
    // The rows come from the session model's display tree, rendered once at
    // open; picks resolve on the context tree (a picked row's parent — e.g.
    // of a post-compaction user row — is a relinked occurrence the display
    // tree hides). The marker is the session model's leaf, not
    // leaf(agentState): the state's is the query-side leaf, which names an
    // entry not yet in the tree while the query leads the file.
    const selector = new TreeSelectorComponent(
      this.sessionModel.leaf,
      this.sessionModel.displayTree,
      this.sessionModel.byUuid,
      (pick) => this.confirmTreePick(pick),
      () => this.closeTreeSelector(),
    );
    this.treeSelector = selector;
    this.statusContainer.addChild(selector);
    this.ui.setFocus(selector);
    this.ui.requestRender();
  }

  /** The selector stays dumb; the busy gate and the request live here. */
  private confirmTreePick(pick: TreeNodeRef): void {
    if (!isIdle(this.agentState)) {
      this.hintText.setText(
        theme.fg("dim", "cannot navigate tree while assistant is busy"),
      );
      this.ui.requestRender();
      return;
    }
    const action = resolveTreePick(
      this.sessionModel.contextTree,
      this.sessionModel.byUuid,
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

  /** Release the footer's git watchers; the TUI is done rendering. */
  dispose(): void {
    this.footerData?.dispose();
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
