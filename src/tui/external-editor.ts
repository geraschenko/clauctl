/**
 * Run an external editor over a suspended TUI. Mirrors the shape of pi's
 * (private, hence non-reusable) InteractiveMode.openExternalEditor: async
 * spawn with inherited stdio — not spawnSync, which on Windows can keep
 * Node's console input read active after ui.stop() pauses stdin, racing
 * vim/nvim for the console input buffer.
 */

import { spawn } from "node:child_process";
import type { TUI } from "@earendil-works/pi-tui";

/** $VISUAL ?? $EDITOR (empty strings count as unset); undefined when neither is set. */
export function externalEditorCommand(): string | undefined {
  return process.env.VISUAL || process.env.EDITOR || undefined;
}

/**
 * Suspend the TUI, run the editor on filePath, resume and force a full
 * re-render (editors use the alternate screen) — resume runs in a finally,
 * including on spawn errors. The command is split on spaces (supports
 * "code --wait"; quoted arguments and paths with spaces are deliberately
 * unsupported, matching pi). Returns true when the editor exited 0.
 */
export async function editFileInExternalEditor(
  ui: TUI,
  editorCommand: string,
  filePath: string,
): Promise<boolean> {
  const [command, ...commandArgs] = editorCommand.split(" ");
  // preserveScreen in fullscreen: a bare stop would replay the whole
  // rendered document into the main buffer before the editor starts,
  // leaving a transcript dump in scrollback on every suspend (pi v0.84.2
  // does exactly that; deliberate divergence — see
  // docs/specs/tui-fullscreen.md, success criterion 5).
  ui.stop({ preserveScreen: ui.mode === "fullscreen" });
  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(command!, [...commandArgs, filePath], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    return exitCode === 0;
  } finally {
    ui.start();
    ui.requestRender(true);
  }
}
