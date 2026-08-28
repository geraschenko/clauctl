/**
 * Shared helpers for the per-tool views. A separate module (not
 * tool-view.ts) so views need no runtime import from the registry that
 * imports them — only the erased `import type { ToolView }` — keeping
 * module evaluation order-independent.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

/** Defensive string-field read: generated types describe the schema, but a
 *  wire payload can take any shape, and views must never crash on one. */
export function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** claude's header-path display: cwd-relative inside the cwd, ~-abbreviated
 *  under the home directory, absolute otherwise. Relative paths are
 *  displayed normalized ("./lines.txt" → "lines.txt", write-preview
 *  capture); resolving them against the cwd funnels them through the same
 *  rules. */
export function abbreviatePath(path: string, cwd: string | undefined): string {
  if (!isAbsolute(path)) {
    if (cwd === undefined) {
      return normalize(path);
    }
    path = resolve(cwd, path);
  }
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) {
    return path.slice(cwd.length + 1);
  }
  const home = homedir();
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
