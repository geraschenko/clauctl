/**
 * Minimal fixed theme for the ported components. Exposes the same call-site
 * API as pi's theme controller (`theme.fg/bg/bold/italic`, `getMarkdownTheme`)
 * so ported code keeps its pi shape verbatim, but with a hardcoded dark
 * palette (pi's dark.json values) instead of pi's 1300-line theme system.
 */

import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

const FG_COLORS = {
  accent: "#8abeb7",
  error: "#cc6666",
  warning: "#ffff00",
  dim: "#666666",
  thinkingText: "#808080",
  userMessageText: "#d4d4d4",
  toolTitle: "#d4d4d4",
  toolOutput: "#808080",
  pendingText: "#808080",
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  mdLinkUrl: "#666666",
  mdCode: "#8abeb7",
  mdCodeBlock: "#b5bd68",
  mdCodeBlockBorder: "#808080",
  mdQuote: "#808080",
  mdQuoteBorder: "#808080",
  mdHr: "#808080",
  mdListBullet: "#8abeb7",
  searchMatchText: "#d4d4d4",
} as const;

const BG_COLORS = {
  userMessageBg: "#343541",
  pendingBg: "#2d2838",
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
  searchMatchBg: "#3a3a4a",
} as const;

export type ThemeColor = keyof typeof FG_COLORS;
export type ThemeBg = keyof typeof BG_COLORS;

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export const theme = {
  fg(color: ThemeColor, text: string): string {
    const [r, g, b] = rgb(FG_COLORS[color]);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  },
  bg(color: ThemeBg, text: string): string {
    const [r, g, b] = rgb(BG_COLORS[color]);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
  inverse(text: string): string {
    return `\x1b[7m${text}\x1b[27m`;
  },
  italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`;
  },
  underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`;
  },
  strikethrough(text: string): string {
    return `\x1b[9m${text}\x1b[29m`;
  },
};

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    // claude indents code-block content at the block indent, not deeper
    // (parity spec; the kept fences are a recorded divergence).
    codeBlockIndent: "",
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => theme.strikethrough(text),
  };
}

export function getEditorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("dim", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.bold(text),
      description: (text: string) => theme.fg("dim", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("dim", text),
    },
  };
}
