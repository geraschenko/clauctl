/**
 * Clamp every rendered line of `inner` to the render width. pi-tui's
 * regular-mode screen throws (after tearing the TUI down) on a single
 * over-wide line, so one unwrapped string in any custom component is a
 * crash; wrapping at each source stays the goal, this is the backstop. It
 * truncates rather than wraps so the line count is what `inner` produced.
 */

import {
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export class FitWidth implements Component {
  private readonly inner: Component;

  constructor(inner: Component) {
    this.inner = inner;
  }

  render(width: number): string[] {
    return this.inner
      .render(width)
      .map((line) =>
        visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line,
      );
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
