/** The TUI's entry point: read the configs, subscribe, run the
 *  interactive mode until the session ends. */

import {
  KeybindingsManager,
  ProcessTerminal,
  setKeybindings,
  TuiAltScreen,
  TuiMainScreen,
  type TuiMode,
} from "@earendil-works/pi-tui";
import { copyToClipboard, initTheme } from "@earendil-works/pi-coding-agent";
import type { ProtocolClient } from "../../core/protocol-client/index.ts";
import {
  CLAUCTL_KEYBINDINGS,
  conflictWarnings,
  keybindingsPath,
  readKeybindingsConfig,
} from "../keybindings.ts";
import { readSettings, settingsPath } from "../../core/settings.ts";
import { theme } from "../theme.ts";
import {
  InteractiveMode,
  type InteractiveOutcome,
} from "./interactive-mode.ts";

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
    settingsRead.settings,
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
