/**
 * Run an external editor while the TUI is stopped. Mirrors the shape of pi's
 * (private, hence non-reusable) InteractiveMode.openExternalEditor: async
 * spawn with inherited stdio — not spawnSync, which on Windows can keep
 * Node's console input read active after ui.stop() pauses stdin, racing
 * vim/nvim for the console input buffer.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";

/** $VISUAL ?? $EDITOR (empty strings count as unset); undefined when neither is set. */
export function externalEditorCommand(): string | undefined {
  return process.env.VISUAL || process.env.EDITOR || undefined;
}

/**
 * Stop the TUI so the editor owns the terminal, run it on filePath, then
 * restart the TUI with a full re-render (editors use the alternate screen);
 * the restart runs in a finally, including on spawn errors. The command is split on spaces (supports
 * "code --wait"; quoted arguments and paths with spaces are deliberately
 * unsupported, matching pi). Returns true when the editor exited 0.
 * Agent events keep arriving while the editor owns the terminal; pi-tui
 * skips rendering while stopped (`TUI.stop` sets the `stopped` flag its
 * render paths check), and the re-render on restart shows them.
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

/** Edit `text` in $VISUAL/$EDITOR with the TUI suspended; undefined if
 *  no editor is set or it exited nonzero. One trailing newline is
 *  stripped, matching pi. */
export async function editTextInExternalEditor(
  ui: TUI,
  text: string,
): Promise<string | undefined> {
  const editorCommand = externalEditorCommand();
  if (editorCommand === undefined) {
    return undefined;
  }
  const tempPath = join(tmpdir(), `clauctl-editor-${randomUUID()}.md`);
  try {
    writeFileSync(tempPath, text, "utf8");
    return (await editFileInExternalEditor(ui, editorCommand, tempPath))
      ? readFileSync(tempPath, "utf8").replace(/\n$/, "")
      : undefined;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Cleanup is best-effort; the file is in tmpdir anyway.
    }
  }
}
