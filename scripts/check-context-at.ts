/**
 * Checks success criterion 1 of docs/specs/context-tree.md against a real
 * session file: at every settled prefix, contextAt presents the same
 * context as loadedContext. Reports every divergence; the documented ones
 * (spec Edge cases, e.g. pre-2.1.258 queued-prompt races) are expected on
 * old files. Read-only. Usage:
 *   node scripts/check-context-at.ts <session.jsonl>...
 * Exit 1 on any mismatch.
 */

import { readSessionEntries } from "../src/core/session/file.ts";
import { contextAtMismatches } from "../src/core/tree/context-check.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/check-context-at.ts <session.jsonl>...");
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const entries = readSessionEntries(file);
  const { checked, mismatches } = contextAtMismatches(entries);
  console.log(
    `${file}: ${entries.length} entries, ${checked} settled prefixes, ${mismatches.length} mismatches`,
  );
  for (const { prefixLength, expected, actual } of mismatches) {
    failed = true;
    console.log(`  prefix ${prefixLength}:`);
    console.log(`    loader:    ${expected.join(" ")}`);
    console.log(`    contextAt: ${actual.join(" ")}`);
  }
}
process.exit(failed ? 1 : 0);
