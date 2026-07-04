/**
 * DO NOT MODIFY
 * TODO: this is an almost byte-for-byte copy of pictl's. We'll have to figure out how/if to share it between the two.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findPackageJson(start: string): string {
  let dir = start;
  while (true) {
    const candidate = join(dir, "package.json");
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error("could not locate package.json");
      }
      dir = parent;
    }
  }
}

const packageJsonPath = findPackageJson(
  dirname(fileURLToPath(import.meta.url)),
);
export const VERSION = (
  JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }
).version;
