#!/usr/bin/env node
// Sync the shared files from pictl (the canonical copies) into the
// generated/ directories. clauctl treats these as generated: never edit them
// here — edit pictl and re-run this script.
//
//   node scripts/sync-from-pictl.mjs          # regenerate
//   node scripts/sync-from-pictl.mjs --check  # fail if out of sync (presubmit)
//
// The pictl checkout defaults to ../pictl next to this repo; override with
// PICTL_DIR.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// pictl sits next to the *main* clauctl checkout. In the canonical layout the
// git common dir is repoRoot/.git, so this is plain ../pictl; from a git
// worktree it resolves to the main checkout's sibling instead of the
// worktree's (nonexistent) one.
function defaultPictlDir() {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return join(dirname(resolve(repoRoot, commonDir)), "..", "pictl");
  } catch {
    return join(repoRoot, "..", "pictl");
  }
}

const pictlDir = process.env.PICTL_DIR ?? defaultPictlDir();

// Each set syncs one pictl source directory into one generated/ directory;
// import rewriting (below) is scoped to the set's own file list.
const SYNC_SETS = [
  {
    sourceDir: join(pictlDir, "src", "core"),
    outDir: join(repoRoot, "src", "core", "generated"),
    files: [
      "ansi.ts",
      "attach.ts",
      "audit.ts",
      "cli.ts",
      "completion.ts",
      "pty.ts",
      "pty-screen.ts",
      "pty-screen.test.ts",
      "read-input.ts",
      "stream-driver.ts",
      "stream-driver.test.ts",
      "targets.ts",
      "tty-protocol.ts",
      "tty-protocol.test.ts",
      "tty-server.ts",
      "tty-server.test.ts",
      "until-engine.ts",
      "until-engine.test.ts",
      "util.ts",
      "version.ts",
    ],
  },
  {
    sourceDir: join(pictlDir, "src", "format"),
    outDir: join(repoRoot, "src", "format", "generated"),
    files: [
      "flat-tree.ts",
      "flat-tree.test.ts",
      "text.ts",
      "tree-layout.ts",
    ],
  },
];

const HEADER = `// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

`;

function transform(source, syncSet, fileName) {
  let out = source
    .replaceAll("pictl", "clauctl")
    .replaceAll("PICTL", "CLAUCTL")
    .replaceAll("Pictl", "Clauctl")
  // generated/ sits one level below the source directory's counterpart, so
  // relative imports that point outside the shared set gain a "../"; imports
  // within the set stay "./".
  out = out.replace(/from "\.\/([^"]+)"/g, (match, imported) =>
    syncSet.files.includes(imported) ? match : `from "../${imported}"`,
  );
  // Keep generated files formatted: the rename changes line lengths, and a
  // treefmt pass rewrapping them would otherwise fight --check.
  return execFileSync(
    join(repoRoot, "node_modules", ".bin", "prettier"),
    ["--stdin-filepath", join(syncSet.outDir, fileName)],
    { input: HEADER + out, encoding: "utf8" },
  );
}

const checkMode = process.argv.includes("--check");
const outOfSync = [];

for (const syncSet of SYNC_SETS) {
  mkdirSync(syncSet.outDir, { recursive: true });
  for (const fileName of syncSet.files) {
    const expected = transform(
      readFileSync(join(syncSet.sourceDir, fileName), "utf8"),
      syncSet,
      fileName,
    );
    const outPath = join(syncSet.outDir, fileName);
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
}

if (outOfSync.length > 0) {
  console.error(
    `out of sync with pictl: ${outOfSync.join(", ")}\n` +
      `run: node scripts/sync-from-pictl.mjs`,
  );
  process.exit(1);
}
