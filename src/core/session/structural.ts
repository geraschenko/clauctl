/**
 * The structural projection of a session entry: the entry with its
 * payload strings emptied (docs/specs/session-tracker.md, "Structural
 * projection") — what a `sessionEntry` event carries for a shared-class
 * entry, whose payload the subscriber already holds from the query twin.
 * A projection, not a truncation: no length limit, no mark.
 */

import type { SessionEntry } from "./file.ts";

/** The leaves that carry payload, measured over real logs (spec WORK LOG).
 *  Within message content only payload leaves are listed — never
 *  structural fields (`type`, `id`, `tool_use_id`, `name`, `usage`,
 *  `model`, `message.id`) the builders and set-context validation read.
 *  `**` = every string value beneath; `[]` = each element; keys are never
 *  touched. */
export const PAYLOAD_PATHS = [
  "message.content", // when a plain string
  "message.content[].text",
  "message.content[].thinking",
  "message.content[].signature",
  "message.content[].input.**",
  "message.content[].content", // tool_result: string, or blocks:
  "message.content[].content[].text",
  "message.content[].source.data",
  "toolUseResult.**",
  "attachment.**",
] as const;

/** PAYLOAD_PATHS merged into one trie so an entry is walked once. */
interface PathTrie {
  /** A path ends here: a string value at this point is emptied. */
  leaf: boolean;
  /** `**` ends here: every string beneath is emptied. */
  deep: boolean;
  /** `[]` child, applied to each element of an array here. */
  element?: PathTrie;
  keys: Map<string, PathTrie>;
}

function emptyTrie(): PathTrie {
  return { leaf: false, deep: false, keys: new Map() };
}

function buildTrie(paths: readonly string[]): PathTrie {
  const root = emptyTrie();
  for (const path of paths) {
    let node = root;
    for (const segment of path.split(".")) {
      if (segment === "**") {
        node.deep = true;
        break;
      }
      const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
      let next = node.keys.get(key);
      if (next === undefined) {
        next = emptyTrie();
        node.keys.set(key, next);
      }
      if (segment.endsWith("[]")) {
        next.element ??= emptyTrie();
        next = next.element;
      }
      node = next;
    }
    node.leaf = true;
  }
  return root;
}

const PAYLOAD_TRIE = buildTrie(PAYLOAD_PATHS);

/** Every string beneath `value` emptied; the same reference when none was. */
function emptyDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value === "" ? value : "";
  }
  if (Array.isArray(value)) {
    return rebuildArray(value, emptyDeep);
  }
  if (typeof value === "object" && value !== null) {
    return rebuildObject(value as Record<string, unknown>, () => emptyDeep);
  }
  return value;
}

/** `value` with the trie's paths applied; the same reference when nothing
 *  beneath changed, so untouched subtrees are shared with the input. */
function emptyAt(value: unknown, node: PathTrie): unknown {
  if (node.deep) {
    return emptyDeep(value);
  }
  if (typeof value === "string") {
    return node.leaf ? emptyDeep(value) : value;
  }
  if (Array.isArray(value)) {
    const element = node.element;
    return element === undefined
      ? value
      : rebuildArray(value, (item) => emptyAt(item, element));
  }
  if (typeof value === "object" && value !== null && node.keys.size > 0) {
    return rebuildObject(value as Record<string, unknown>, (key) => {
      const child = node.keys.get(key);
      return child === undefined ? undefined : (item) => emptyAt(item, child);
    });
  }
  return value;
}

function rebuildArray(
  items: readonly unknown[],
  project: (item: unknown) => unknown,
): unknown[] {
  let copy: unknown[] | undefined;
  items.forEach((item, index) => {
    const projected = project(item);
    if (projected !== item) {
      copy ??= [...items];
      copy[index] = projected;
    }
  });
  return copy ?? (items as unknown[]);
}

function rebuildObject(
  record: Record<string, unknown>,
  projectorFor: (key: string) => ((item: unknown) => unknown) | undefined,
): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(record)) {
    const project = projectorFor(key);
    if (project === undefined) {
      continue;
    }
    const projected = project(item);
    if (projected !== item) {
      copy ??= { ...record };
      copy[key] = projected;
    }
  }
  return copy ?? record;
}

/** Same shape as `entry` with every string at a PAYLOAD_PATHS leaf
 *  replaced by "" (keys and block skeleton kept, so the result is still a
 *  valid entry for the builders). Strings elsewhere are not inspected.
 *  Uuid-less entries are returned unchanged. */
export function structuralEntry(entry: SessionEntry): SessionEntry {
  if (entry.uuid === undefined) {
    return entry;
  }
  return emptyAt(entry, PAYLOAD_TRIE) as SessionEntry;
}
