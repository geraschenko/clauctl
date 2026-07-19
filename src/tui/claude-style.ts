/**
 * claude's transcript SGR palette: the exact 256-color codes claude 2.1.211
 * emits (captured in scripts/tui-parity/out/*.claude.ansi), used by the
 * claude-layout transcript pieces (tool components, fold lines) so the
 * parity captures compare byte-for-byte. Distinct from theme.ts, which is
 * the pi-shaped palette the verbatim-ported components consume.
 */

export const claudeStyle = {
  /** Fold lines, `⎿ ` prefixes, hint text. */
  grey: (text: string): string => `\x1b[38;5;246m${text}\x1b[39m`,
  /** Successful tool `●`. */
  success: (text: string): string => `\x1b[38;5;114m${text}\x1b[39m`,
  /** Failed tool `●` and error summaries. */
  error: (text: string): string => `\x1b[38;5;211m${text}\x1b[39m`,
  /** Assistant text `●` and user-prompt text. */
  white: (text: string): string => `\x1b[38;5;231m${text}\x1b[39m`,
  /** The user prompt's `❯ ` gutter. */
  userGutter: (text: string): string => `\x1b[38;5;239m${text}\x1b[39m`,
  /** Background band behind user-prompt content cells. */
  userBg: (text: string): string => `\x1b[48;5;237m${text}\x1b[49m`,
  /** Footer plan-mode indicator. */
  planMode: (text: string): string => `\x1b[38;5;73m${text}\x1b[39m`,
  /** Footer accept-edits indicator. */
  autoAccept: (text: string): string => `\x1b[38;5;147m${text}\x1b[39m`,
  /** Footer auto-mode indicator. */
  warning: (text: string): string => `\x1b[38;5;220m${text}\x1b[39m`,
  bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
  /** The generic `… +N lines (ctrl+o to expand)` truncation line. */
  dim: (text: string): string => `\x1b[2m${text}\x1b[22m`,
};
