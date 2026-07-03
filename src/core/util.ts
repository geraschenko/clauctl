/** Small shared helpers. Keep this file free of clauctl-specific imports. */

import { access } from "node:fs/promises";

/** Bad command-line arguments; main.ts exits 2 (shell usage-error convention). */
export class UsageError extends Error {}

export function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  what: string,
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(
    `${what} must be one of: ${allowed.join(", ")} (got '${value}')`,
  );
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
