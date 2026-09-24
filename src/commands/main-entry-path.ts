/**
 * The script Node was invoked with, re-execed for self-spawned subprocesses
 * (the detached daemon, the daemon-managed tui). Using process.argv[1]
 * (rather than a path derived from import.meta.url) keeps the re-exec correct
 * whether clauctl runs from the built `dist/` (`main.js`) or from `.ts` source
 * under type-stripping (`main.ts`), where a hardcoded `./main.js` would point
 * at a nonexistent file.
 */
export function mainEntryPath(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new Error("cannot determine clauctl entry script (process.argv[1])");
  }
  return entry;
}
