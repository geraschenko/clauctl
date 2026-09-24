/**
 * Styling seam: format builds plain text and applies a `Style` decorator last,
 * to a fragment that is never measured again, so `stripAnsi(styled)` equals
 * the `PLAIN_STYLE` output. `ANSI_STYLE` is claude's transcript SGR palette,
 * the exact 256-color codes claude 2.1.211 emits (captured in
 * scripts/tui-parity/out/*.claude.ansi), so the parity captures compare
 * byte-for-byte. Distinct from tui/theme.ts, the pi-shaped palette the
 * verbatim-ported components consume.
 */

export const ANSI_STYLE = {
  /** Fold lines, `⤷` result prefixes, hint text. */
  grey: (text: string): string => `\x1b[38;5;246m${text}\x1b[39m`,
  /** Successful tool-call `▸`. */
  success: (text: string): string => `\x1b[38;5;114m${text}\x1b[39m`,
  /** Failed tool-call `▸` and error summaries. */
  error: (text: string): string => `\x1b[38;5;211m${text}\x1b[39m`,
  /** Assistant text `●` and user-prompt text. */
  white: (text: string): string => `\x1b[38;5;231m${text}\x1b[39m`,
  warning: (text: string): string => `\x1b[38;5;220m${text}\x1b[39m`,
  bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
  /** Inline `*italic*` spans in the user-prompt echo. */
  italic: (text: string): string => `\x1b[3m${text}\x1b[23m`,
  /** The generic `… +N lines (ctrl+o to expand)` truncation line. */
  dim: (text: string): string => `\x1b[2m${text}\x1b[22m`,
};

export type Style = {
  readonly [K in keyof typeof ANSI_STYLE]: (text: string) => string;
};

export const PLAIN_STYLE: Style = {
  grey: (text) => text,
  success: (text) => text,
  error: (text) => text,
  white: (text) => text,
  warning: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  dim: (text) => text,
};
