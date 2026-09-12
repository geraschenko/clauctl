/**
 * What the structural projection (src/core/session/structural.ts) saves on
 * a real session file: per entry type, how the bytes shrink; then the
 * fields that dominate what remains, so a new bulk carrier shows up as a
 * candidate for PAYLOAD_PATHS. Every entry is projected here regardless of
 * class (the wire projects only shared ones). Read-only. Usage:
 *   node scripts/diagnostic/structural-stats.ts <session.jsonl>...
 */

import {
  readSessionEntries,
  type SessionEntry,
} from "../../src/core/session/file.ts";
import { structuralEntry } from "../../src/core/session/structural.ts";

const RESIDUE_ROWS = 20;

interface Tally {
  entries: number;
  fileBytes: number;
  structuralBytes: number;
}

function tallyOf(tallies: Map<string, Tally>, key: string): Tally {
  let tally = tallies.get(key);
  if (tally === undefined) {
    tally = { entries: 0, fileBytes: 0, structuralBytes: 0 };
    tallies.set(key, tally);
  }
  return tally;
}

/** `type/subtype`, with user entries split by what they carry: a human (or
 *  command) prompt, tool results, a compaction summary, or an injected
 *  isMeta message. */
function entryKind(entry: SessionEntry): string {
  if (entry.type !== "user") {
    return entry.subtype === undefined
      ? (entry.type ?? "(no type)")
      : `${entry.type}/${entry.subtype}`;
  }
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  const hasToolResult =
    Array.isArray(content) &&
    content.some((block: { type?: unknown }) => block.type === "tool_result");
  if (hasToolResult) {
    return "user/tool_result";
  }
  if (entry.isCompactSummary === true) {
    return "user/compact_summary";
  }
  if (entry.isMeta === true) {
    return "user/meta";
  }
  return "user/prompt";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Bytes of each field of the structural entry, content blocks split per
 *  block type and field so the residue table names what PAYLOAD_PATHS
 *  left. */
function addResidue(residue: Map<string, number>, structural: object): void {
  const add = (key: string, value: unknown): void => {
    residue.set(key, (residue.get(key) ?? 0) + jsonBytes(value));
  };
  for (const [key, value] of Object.entries(structural)) {
    if (key !== "message" || typeof value !== "object" || value === null) {
      add(key, value);
      continue;
    }
    for (const [messageKey, messageValue] of Object.entries(value)) {
      if (messageKey !== "content" || !Array.isArray(messageValue)) {
        add(`message.${messageKey}`, messageValue);
        continue;
      }
      for (const block of messageValue as Record<string, unknown>[]) {
        for (const [blockKey, blockValue] of Object.entries(block)) {
          add(`message.content[${block.type}].${blockKey}`, blockValue);
        }
      }
    }
  }
}

const mb = (bytes: number): string =>
  bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${(bytes / 1e3).toFixed(1)} KB`;
const percent = (part: number, whole: number): string =>
  whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error(
    "usage: node scripts/diagnostic/structural-stats.ts <session.jsonl>...",
  );
  process.exit(2);
}
for (const file of files) {
  const entries = readSessionEntries(file);
  const byType = new Map<string, Tally>();
  const residue = new Map<string, number>();
  const started = performance.now();
  for (const entry of entries) {
    const structural = structuralEntry(entry);
    const tally = tallyOf(byType, entryKind(entry));
    tally.entries += 1;
    tally.fileBytes += jsonBytes(entry) + 1;
    tally.structuralBytes += jsonBytes(structural) + 1;
    addResidue(residue, structural);
  }
  const elapsedMs = performance.now() - started;
  const total = { entries: 0, fileBytes: 0, structuralBytes: 0 };
  for (const tally of byType.values()) {
    total.entries += tally.entries;
    total.fileBytes += tally.fileBytes;
    total.structuralBytes += tally.structuralBytes;
  }
  console.log(`${file}`);
  console.log(
    `  ${total.entries} entries, ${mb(total.fileBytes)} → ${mb(total.structuralBytes)} structural ` +
      `(${percent(total.structuralBytes, total.fileBytes)}), ${elapsedMs.toFixed(0)} ms`,
  );
  console.log("  by entry type:");
  const rows = [...byType].sort((a, b) => b[1].fileBytes - a[1].fileBytes);
  for (const [typeKey, tally] of rows) {
    console.log(
      `    ${typeKey.padEnd(28)} ${String(tally.entries).padStart(7)} entries ` +
        `${mb(tally.fileBytes).padStart(10)} → ${mb(tally.structuralBytes).padStart(10)} ` +
        `(${percent(tally.structuralBytes, tally.fileBytes)})`,
    );
  }
  console.log(`  structural residue by field (top ${RESIDUE_ROWS}):`);
  const residueRows = [...residue]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RESIDUE_ROWS);
  for (const [field, bytes] of residueRows) {
    console.log(
      `    ${mb(bytes).padStart(10)} ${percent(bytes, total.structuralBytes).padStart(6)}  ${field}`,
    );
  }
}
