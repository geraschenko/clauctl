import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh `clauctl-<prefix>-*` directory under the OS temp dir, removed
 *  when `scope` ends — a test's context, or `{ after }` from node:test for
 *  a directory shared by a whole file. */
export function tempDir(
  prefix: string,
  scope: { after(cleanup: () => void): void },
): string {
  const dir = mkdtempSync(join(tmpdir(), `clauctl-${prefix}-`));
  scope.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
