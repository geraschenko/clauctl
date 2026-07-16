// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * Format-agnostic input plumbing: read a file arg or stdin, parse JSON/JSONL
 * with useful errors.
 *
 * This file is synced verbatim into clauctl (its scripts/sync-from-clauctl.mjs
 * copies it with textual renames), so it must only import node builtins and
 * files in clauctl's shared core set (currently ./targets.ts and ./util.ts) —
 * no pi types, no format files.
 */

import { readFile } from "node:fs/promises";
import type { CommandContext } from "./targets.ts";
import { UsageError } from "./util.ts";

/** Returns stdin exactly as received; trailing-newline policy is the
 *  caller's (e.g. prompt text strips the shell's newline, documents don't). */
export async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
): Promise<string> {
  let data = "";
  for await (const chunk of stdin) {
    data += chunk.toString();
  }
  return data;
}

export async function readInputFile(
  context: CommandContext,
  file: string | undefined,
): Promise<string> {
  if (file === undefined || file === "-") {
    return await readStdin((context.process as NodeJS.Process).stdin);
  }
  return await readFile(file, "utf8");
}

export function parseJsonInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new UsageError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseJsonlInput(input: string): readonly unknown[] {
  const lines = input.split(/\r?\n/u).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new UsageError(
        `invalid JSONL line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
