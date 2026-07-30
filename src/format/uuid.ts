/** Every place a uuid is displayed goes through here. Returns the full uuid
 *  today; the future unique-prefix work (truncated display, prefix
 *  addressing) changes only this function and its resolver counterpart. */
export function displayUuid(uuid: string): string {
  return uuid;
}
