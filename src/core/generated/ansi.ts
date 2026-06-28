// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * ANSI escape sequences shared by the daemon and the attach client. Keep this
 * file free of clauctl-specific imports.
 */

export const SHOW_CURSOR = "\x1b[?25h";
export const HIDE_CURSOR = "\x1b[?25l";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const RESET_SGR = "\x1b[0m";
export const CURSOR_HOME = "\x1b[H";
export const ERASE_SCREEN = "\x1b[2J";
/** DECSC/DECRC: save/restore cursor position AND SGR attributes. */
export const SAVE_CURSOR = "\x1b7";
export const RESTORE_CURSOR = "\x1b8";

/** CUP with 1-based coordinates. */
export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorToRow(row: number): string {
  return cursorTo(row, 1);
}
