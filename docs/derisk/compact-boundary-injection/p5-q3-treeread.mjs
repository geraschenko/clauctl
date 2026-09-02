// Q3 (off critical path): can clauctl read the FULL session tree through the SDK
// (importSessionToStore → SessionStore) instead of parsing the jsonl itself?
// Decision criteria from the README: completeness (unknown fields passed through
// un-normalized?), version sensitivity, failure observability.
//
// Fixture: the p0c branched file (branches, turn_duration, file-history-snapshot,
// ai-title, mode entries) + an appended synthetic boundary+summary + one entry
// carrying an unknown custom field, to test verbatim passthrough.

import { assertVersions, makeConfigDir, readJsonl, EXP_DIR, projectKey } from "./harness.mjs";
import { importSessionToStore, InMemorySessionStore } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const cwd = "/tmp/clauctl-cbi-derisk/p0c-cwd";
const sessionId = "d3d313fa-9bc8-4dca-8549-5b20aa96dc4f";
const configDir = makeConfigDir("p5-q3");
const projDir = path.join(configDir, "projects", projectKey(cwd));
fs.mkdirSync(projDir, { recursive: true });
const file = path.join(projDir, `${sessionId}.jsonl`);

const boundaryUuid = randomUUID();
const summaryUuid = randomUUID();
const extraEntries = [
  {
    parentUuid: null, logicalParentUuid: null, isSidechain: false,
    type: "system", subtype: "compact_boundary", content: "Conversation compacted",
    isMeta: false, timestamp: new Date().toISOString(), uuid: boundaryUuid, level: "info",
    compactMetadata: {
      trigger: "manual", preTokens: 1, durationMs: 1, postTokens: 1,
      preservedMessages: { anchorUuid: summaryUuid, uuids: [], allUuids: [] },
    },
    x_clauctl_unknown_field: { nested: ["passthrough", 42] },
    cwd, sessionId, version: "2.1.195", gitBranch: "HEAD", userType: "external", entrypoint: "sdk-cli",
  },
  {
    parentUuid: boundaryUuid, isSidechain: false, type: "user",
    message: { role: "user", content: "Synthetic summary. (tag: SYNTH-Q3)" },
    isCompactSummary: true, uuid: summaryUuid, timestamp: new Date().toISOString(),
    cwd, sessionId, version: "2.1.195", gitBranch: "HEAD", userType: "external", entrypoint: "sdk-cli",
  },
];
fs.writeFileSync(file, fs.readFileSync(`${EXP_DIR}/captures/p0c-restore-post-branch.jsonl`, "utf8")
  + extraEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");

process.env.CLAUDE_CONFIG_DIR = configDir;
const store = new InMemorySessionStore();
let importError = null;
try {
  await importSessionToStore(sessionId, store, { dir: cwd });
} catch (e) { importError = String(e); }

const raw = readJsonl(file);
const stored = importError ? [] : store.getEntries({ projectKey: projectKey(cwd), sessionId });

const canon = (e) => JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))));
const rawSet = new Set(raw.map(canon));
const storedSet = new Set(stored.map(canon));
const onlyInRaw = raw.filter((e) => !storedSet.has(canon(e)));
const onlyInStored = stored.filter((e) => !rawSet.has(canon(e)));
const storedBoundary = stored.find((e) => e.subtype === "compact_boundary" && e.uuid === boundaryUuid);

// Failure observability: nonexistent session.
let missingError = null;
try { await importSessionToStore(randomUUID(), new InMemorySessionStore(), { dir: cwd }); }
catch (e) { missingError = String(e); }

const report = {
  versions: assertVersions(),
  importError,
  rawCount: raw.length,
  storedCount: stored.length,
  sameOrder: !importError && raw.length === stored.length && raw.every((e, i) => canon(e) === canon(stored[i])),
  onlyInRaw: onlyInRaw.map((e) => e.type + (e.subtype ? `:${e.subtype}` : "")),
  onlyInStored: onlyInStored.map((e) => e.type + (e.subtype ? `:${e.subtype}` : "")),
  unknownFieldPreserved: JSON.stringify(storedBoundary?.x_clauctl_unknown_field) === JSON.stringify({ nested: ["passthrough", 42] }),
  boundaryMetadataVerbatim: JSON.stringify(storedBoundary?.compactMetadata) === JSON.stringify(extraEntries[0].compactMetadata),
  missingSessionError: missingError,
};
fs.writeFileSync(`${EXP_DIR}/captures/p5-q3-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
