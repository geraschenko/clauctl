/** Session-entry uuid validation, prefix resolution, and display, shared by
 *  every consumer that tests, resolves, or renders uuids. */

import type { UUID } from "node:crypto";
import { UsageError } from "./generated/util.ts";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/** Whether input could begin a uuid: hex digits with dashes exactly at uuid
 *  positions, no longer than a full uuid. Rejects "" — an empty prefix
 *  matches everything. */
export function isUuidPrefix(input: string): boolean {
  if (input.length === 0 || input.length > UUID_TEMPLATE.length) {
    return false;
  }
  return [...input].every((char, index) =>
    UUID_TEMPLATE[index] === "-" ? char === "-" : /[0-9a-f]/i.test(char),
  );
}

export function parseUuidPrefixFlag(input: string): string {
  if (!isUuidPrefix(input)) {
    throw new UsageError(`invalid uuid or uuid prefix: ${input}`);
  }
  return input;
}

/**
 * Resolve an entry uuid given exactly or as a unique prefix — to a full uuid
 * from the session. An ambiguous prefix is an error listing the candidates,
 * never a guess. Matching is case-insensitive (session uuids are lowercase
 * on disk). State-dependent failures are runtime errors, not usage errors,
 * mirroring resolveAgentId.
 */
export function resolveUuidPrefix(
  uuidPrefix: string,
  sessionUuids: ReadonlySet<UUID>,
): UUID {
  const normalized = uuidPrefix.toLowerCase();
  const matches = [...sessionUuids].filter((uuid) =>
    uuid.startsWith(normalized),
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous entry uuid prefix '${uuidPrefix}', candidates:\n  ${matches.join("\n  ")}`,
    );
  }
  throw new Error(`no session entry uuid matches '${uuidPrefix}'`);
}

/** Every place a uuid is displayed goes through here, truncating to the
 *  8-character prefix that resolveUuidPrefix accepts back. Deliberate
 *  exception: `[cursor: …]` lines keep the full uuid — they exist for
 *  lossless copy-paste, and the full value is the fallback when 8 leading
 *  characters collide. */
export function displayUuid(uuid: string): string {
  return uuid.slice(0, 8);
}
