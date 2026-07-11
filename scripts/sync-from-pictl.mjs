#!/usr/bin/env node
// Sync the shared files from pictl (the canonical copies) into
// src/core/generated/. clauctl treats these as generated: never edit them
// here — edit pictl and re-run this script.
//
//   node scripts/sync-from-pictl.mjs          # regenerate
//   node scripts/sync-from-pictl.mjs --check  # fail if out of sync (presubmit)
//
// The pictl checkout defaults to ../pictl next to this repo; override with
// PICTL_DIR.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_FILES = [
  "audit.ts",
  "cli.ts",
  "completion.ts",
  "targets.ts",
  "util.ts",
  "version.ts",
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pictlDir = process.env.PICTL_DIR ?? join(repoRoot, "..", "pictl");
const sourceDir = join(pictlDir, "src", "core");
const outDir = join(repoRoot, "src", "core", "generated");

const HEADER = `// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

`;

function transform(source, fileName) {
  let out = source
    .replaceAll("pictl", "clauctl")
    .replaceAll("PICTL", "CLAUCTL")
    .replaceAll("Pictl", "Clauctl")
    // The agent-id env var pictl sets for its agents is named after pi, not
    // pictl, so the renames above miss it.
    .replaceAll("PI_AGENT_ID", "CLAUCTL_AGENT_ID");
  // generated/ sits one level below src/core/, so relative imports that point
  // outside the shared set gain a "../"; imports within the set stay "./".
  out = out.replace(/from "\.\/([^"]+)"/g, (match, imported) =>
    SHARED_FILES.includes(imported) ? match : `from "../${imported}"`,
  );
  // Keep generated files formatted: the rename changes line lengths, and a
  // treefmt pass rewrapping them would otherwise fight --check.
  return execFileSync(
    join(repoRoot, "node_modules", ".bin", "prettier"),
    ["--stdin-filepath", join(outDir, fileName)],
    { input: HEADER + out, encoding: "utf8" },
  );
}

const checkMode = process.argv.includes("--check");
const outOfSync = [];

mkdirSync(outDir, { recursive: true });
for (const fileName of SHARED_FILES) {
  const expected = transform(
    readFileSync(join(sourceDir, fileName), "utf8"),
    fileName,
  );
  const outPath = join(outDir, fileName);
  if (checkMode) {
    let actual;
    try {
      actual = readFileSync(outPath, "utf8");
    } catch {
      actual = undefined;
    }
    if (actual !== expected) {
      outOfSync.push(fileName);
    }
  } else {
    writeFileSync(outPath, expected);
    console.log(`wrote ${outPath}`);
  }
}

if (outOfSync.length > 0) {
  console.error(
    `out of sync with pictl: ${outOfSync.join(", ")}\n` +
      `run: node scripts/sync-from-pictl.mjs`,
  );
  process.exit(1);
}
