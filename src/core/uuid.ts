/** Session-entry uuid validation and display, shared by every consumer that
 *  tests or renders uuids. */

import type { UUID } from "node:crypto";
import { UsageError } from "./generated/util.ts";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuidFlag(input: string): UUID {
  if (!UUID_PATTERN.test(input)) {
    throw new UsageError(`invalid uuid: ${input}`);
  }
  return input as UUID;
}

/** Every place a uuid is displayed goes through here. Returns the full uuid
 *  today; the future unique-prefix work (truncated display, prefix
 *  addressing) changes only this function and its resolver counterpart. */
export function displayUuid(uuid: string): string {
  return uuid;
}
