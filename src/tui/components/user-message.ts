// Custom (formerly a verbatim port of pi coding-agent's user-message.ts;
// taken out of scripts/update-ports.sh when it stopped tracking pi's
// layout). Renders claude 2.1.211's user-prompt look —
//
//   ❯ verbatim prompt text, word-wrapped,
//     continuation lines indented 2
//
// text shown verbatim (no Markdown), `❯ ` gutter in dark grey, white text,
// all content cells on claude's background band; one leading blank line
// (every transcript block leads with one, giving claude's exactly-one-blank
// spacing). Colors/formats captured by scripts/tui-parity/ (claude-derived:
// update against fresh captures on claude version bumps). pi lineage: the
// Component shape and the OSC 133 zone markers.

import { CachedLinesComponent } from "./cached-lines.ts";
import { claudeStyle } from "../claude-style.ts";
import { wrapHeaderArg } from "./tool-execution.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** Gutter width: `❯ ` on the first line, 2 spaces on continuations. */
const GUTTER_WIDTH = 2;

/** The `❯`-gutter band lines of one prompt: word-wrapped, first line
 *  prefixed `❯ `, continuations indented 2, claude's colors throughout.
 *  Shared with the local-command blocks (user-command.ts). */
export function userPromptLines(text: string, width: number): string[] {
  const capacity = Math.max(1, width - GUTTER_WIDTH);
  const { lines } = wrapHeaderArg(
    text,
    capacity,
    capacity,
    Number.MAX_SAFE_INTEGER,
  );
  return lines.map((line, index) => {
    const gutter =
      index === 0 ? claudeStyle.userGutter("❯ ") : " ".repeat(GUTTER_WIDTH);
    return claudeStyle.userBg(gutter + claudeStyle.white(line));
  });
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
    const out = ["", ...userPromptLines(this.text, width)];
    out[0] = OSC133_ZONE_START + out[0];
    out[out.length - 1] =
      OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
    return out;
  }
}
