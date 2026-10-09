/**
 * Parse the locally intercepted `/model` command: the first
 * whitespace-delimited token must be exactly `/model` (case-sensitive);
 * the argument is the trimmed remainder. Returns null for any other text;
 * `model` undefined means bare `/model` (open the menu).
 */
export function parseModelCommand(
  text: string,
): { model: string | undefined } | null {
  const trimmed = text.trim();
  const spaceIndex = trimmed.search(/\s/);
  const token = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  if (token !== "/model") {
    return null;
  }
  const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  return { model: arg === "" ? undefined : arg };
}

/**
 * Parse the locally intercepted `/effort` command; same first-token parse
 * as parseModelCommand. `level` undefined means bare `/effort` (open the
 * menu).
 */
export function parseEffortCommand(
  text: string,
): { level: string | undefined } | null {
  const trimmed = text.trim();
  const spaceIndex = trimmed.search(/\s/);
  const token = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  if (token !== "/effort") {
    return null;
  }
  const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();
  return { level: arg === "" ? undefined : arg };
}
