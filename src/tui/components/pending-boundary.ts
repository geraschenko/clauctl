/**
 * The rule between the transcript's resolved part and its pending part
 * (`showResolvedBoundary` setting): a full-width warning-colored line with
 * a blank line on each side. Its own class because the width is only
 * known at render.
 */

import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme.ts";

export class PendingBoundaryComponent implements Component {
  render(width: number): string[] {
    return ["", theme.fg("warning", "─".repeat(width)), ""];
  }

  /** Nothing is cached: every render reads the theme afresh. */
  invalidate(): void {}
}
