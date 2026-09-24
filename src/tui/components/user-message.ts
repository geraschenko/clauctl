// Custom (formerly a verbatim port of pi coding-agent's user-message.ts;
// taken out of scripts/update-ports.sh when it stopped tracking pi's
// layout). Renders claude 2.1.280's user-prompt look —
//
//   ❯ prompt text, word-wrapped,
//     continuation lines indented 2
//
// inline markdown styled with its markers consumed (`code`, **bold**,
// *italic*; block markdown stays verbatim), `❯ ` gutter in dark grey,
// white text, all content cells on claude's background band; one leading
// blank line (every transcript block leads with one, giving claude's
// exactly-one-blank spacing). Colors/formats captured by
// scripts/tui-parity/ (claude-derived: update against fresh captures on
// claude version bumps). pi lineage: the Component shape and the OSC 133
// zone markers.

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CachedLinesComponent } from "./cached-lines.ts";
import { ANSI_STYLE } from "../../format/style.ts";
import { USER_GLYPH } from "../../format/glyphs.ts";
import { wrapHeaderArg } from "./tool-execution.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Gutter width: `❯ ` on the first line, 2 spaces on continuations. */
const GUTTER_WIDTH = 2;

/** The `❯`-gutter band lines of one command line, shown verbatim:
 *  word-wrapped, first line prefixed `❯ `, continuations indented 2,
 *  claude's colors throughout. Used by the local-command blocks
 *  (user-command.ts) — command lines get no markdown styling. */
export function userPromptLines(text: string, width: number): string[] {
  const capacity = Math.max(1, width - GUTTER_WIDTH);
  const { lines } = wrapHeaderArg(
    text,
    capacity,
    capacity,
    Number.MAX_SAFE_INTEGER,
  );
  return bandLines(lines.map((line) => ANSI_STYLE.white(line)));
}

/** The prompt band's `❯ ` gutter. */
const userGutter = (text: string): string => `\x1b[38;5;239m${text}\x1b[39m`;
/** Background band behind user-prompt content cells. */
const userBg = (text: string): string => `\x1b[48;5;237m${text}\x1b[49m`;
/** Inline `` `code` `` spans in the user-prompt echo; restores the prompt's
 *  white rather than the default foreground. */
const promptCode = (text: string): string =>
  `\x1b[38;5;153m${text}\x1b[38;5;231m`;

/** Puts already-styled content lines on the prompt band: `❯ ` gutter on the
 *  first line, 2-space indent on continuations, background across the
 *  content cells. */
function bandLines(lines: string[]): string[] {
  return lines.map((line, index) => {
    const gutter =
      index === 0 ? userGutter(`${USER_GLYPH} `) : " ".repeat(GUTTER_WIDTH);
    return userBg(gutter + line);
  });
}

/** Styles the inline markdown claude renders in the prompt echo, consuming
 *  the markers: `` `code` ``, **bold**, *italic*. Code spans are styled
 *  first so markers inside them stay literal; block markdown (headings,
 *  lists, fences) is untouched. */
function styleInlineMarkdown(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((segment, index) =>
      index % 2 === 1
        ? promptCode(segment.slice(1, -1))
        : segment
            .replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) =>
              ANSI_STYLE.bold(inner),
            )
            .replace(/\*([^*\n]+)\*/g, (_, inner: string) =>
              ANSI_STYLE.italic(inner),
            ),
    )
    .join("");
}

/** The prompt echo's band lines: inline markdown styled (markers consumed,
 *  so wrap points match the styled text), wrapped ANSI-aware — the active
 *  styles re-open on continuation lines. Claude leaves the last column of
 *  the prompt band empty (observed: 2.1.280 prompt lines top out one short
 *  of the terminal width), so the wrap capacity reserves it too. */
function promptEchoLines(text: string, width: number): string[] {
  const capacity = Math.max(1, width - GUTTER_WIDTH - 1);
  const styled = ANSI_STYLE.white(styleInlineMarkdown(text));
  return bandLines(wrapTextWithAnsi(styled, capacity));
}

export class UserMessageComponent extends CachedLinesComponent {
  private readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  protected cacheKey(): readonly unknown[] {
    return [];
  }

  protected computeLines(width: number): string[] {
    const out = ["", ...promptEchoLines(this.text, width)];
    out[0] = OSC133_ZONE_START + out[0];
    out[out.length - 1] =
      OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
    return out;
  }
}
