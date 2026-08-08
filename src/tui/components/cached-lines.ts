// The TUI re-renders the full component tree every frame (pi-tui has no
// framework-level caching; its Text/Markdown leaves each memoize
// internally). Any component that COMPUTES its lines in render() — wrapping,
// diffing — must therefore cache, or that work re-runs at frame rate for
// the whole transcript. This base centralizes the memo: subclasses declare
// their mutable inputs once in cacheKey() instead of clearing a cache from
// every mutator, so a missed dependency is reviewable in one place next to
// computeLines(). See cached-lines.test.ts for the contract tests.

import { type Component } from "@earendil-works/pi-tui";

function sameKey(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[],
): boolean {
  return (
    previous !== undefined &&
    previous.length === current.length &&
    previous.every((value, index) => Object.is(value, current[index]))
  );
}

/**
 * A leaf component whose lines are recomputed only when its declared inputs
 * or the width change. render() returns the cached array by reference, so
 * repeat renders are identity-stable (the contract tests assert this).
 */
export abstract class CachedLinesComponent implements Component {
  private cachedKey?: readonly unknown[];
  private cachedWidth?: number;
  private cachedLines?: string[];

  /** Every mutable input computeLines reads, shallow-compared with
   *  Object.is. Immutable-input components return []. */
  protected abstract cacheKey(): readonly unknown[];

  protected abstract computeLines(width: number): string[];

  /** Force a recompute even with an unchanged key (external state such as
   *  terminal capabilities may have changed). */
  invalidate(): void {
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const key = this.cacheKey();
    if (
      this.cachedLines === undefined ||
      this.cachedWidth !== width ||
      !sameKey(this.cachedKey, key)
    ) {
      this.cachedLines = this.computeLines(width);
      this.cachedWidth = width;
      this.cachedKey = key;
    }
    return this.cachedLines;
  }
}
