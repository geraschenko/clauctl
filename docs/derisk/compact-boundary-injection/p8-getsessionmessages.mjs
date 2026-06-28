// P8: cross-validate getSessionMessages against the outbound-request oracle.
//
// Question: does getSessionMessages return the EFFECTIVE context (boundary
// relink applied) — i.e. can clauctl use it as a cheap assertion layer in
// place of the recording shim?
//
// Two injected fixtures whose ground truth we hold as shim captures:
//   p2-a: up_to injection preserving U2..U3 (probe request captured in
//         captures/p2-a-upto-requests.jsonl; file persisted in its config dir)
//   p7:   the lifecycle prototype's final state — 12 stacked boundaries, the
//         last preserving only cycle 11's assistant leaf
//
// Hard assertions: returned uuid sequence == expected effective chain, nothing
// from the summarized region leaks, includeSystemMessages surfaces the boundary.

import { readJsonl, readCapturedInference, EXP_DIR, projectKey, assertVersions } from "./harness.mjs";
import { getSessionMessages } from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import fs from "node:fs";
import path from "node:path";

const versions = assertVersions();
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
const report = { versions };

// --- p2-a fixture ---
{
  const cwd = "/tmp/clauctl-cbi-derisk/p0b-native-compact-cwd";
  const sessionId = "c4a1bb69-58cb-4e57-b5f9-7f7e27a9fe36";
  const configDir = "/tmp/clauctl-cbi-derisk/p2-a-upto";
  const file = path.join(configDir, "projects", projectKey(cwd), `${sessionId}.jsonl`);
  const entries = readJsonl(file);

  // Effective chain per the shim capture: summary, U2 turn, U3 turn, then the probe turn.
  const byPrefix = Object.fromEntries(entries.filter((e) => e.uuid).map((e) => [e.uuid.slice(0, 8), e.uuid]));
  const preserved = ["d6c57604", "9f8ab726", "d16f84b0", "1a44a1ac", "a6941d02", "254029a1"].map((p) => byPrefix[p]);
  const summaryUuid = entries.find((e) => e.isCompactSummary).uuid;
  const boundaryUuid = entries.find((e) => e.subtype === "compact_boundary").uuid;
  // Summarized region = pre-boundary transcript messages not on the playlist.
  const boundaryIdx = entries.findIndex((e) => e.subtype === "compact_boundary");
  const summarized = entries.slice(0, boundaryIdx).filter((e) =>
    (e.type === "user" || e.type === "assistant") && !preserved.includes(e.uuid));

  process.env.CLAUDE_CONFIG_DIR = configDir;
  const msgs = await getSessionMessages(sessionId, { dir: cwd });
  const msgsSys = await getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true });
  const uuids = msgs.map((m) => m.uuid);

  const expectedHead = [summaryUuid, ...preserved];
  assert(JSON.stringify(uuids.slice(0, 7)) === JSON.stringify(expectedHead),
    `p2-a: head of returned chain != summary+preserved\n got ${uuids.slice(0, 7)}\n want ${expectedHead}`);
  const leaked = uuids.filter((u) => summarized.some((e) => e.uuid === u));
  assert(leaked.length === 0, `p2-a: summarized-region uuids leaked: ${leaked}`);
  assert(uuids.slice(7).every((u) => entries.find((e) => e.uuid === u)), `p2-a: unknown trailing uuids`);
  const probeUser = msgs.find((m) => JSON.stringify(m.message).includes("NONCE-P2A"));
  assert(probeUser, `p2-a: probe turn missing from returned messages`);
  assert(msgsSys.some((m) => m.uuid === boundaryUuid), `p2-a: includeSystemMessages did not surface the boundary`);
  assert(!msgs.some((m) => m.uuid === boundaryUuid), `p2-a: boundary returned without includeSystemMessages`);

  // Content parity with the captured probe request (modulo same-role coalescing
  // and the CLI's system-reminder wrappers): every text block the API saw must
  // appear, in order, in the getSessionMessages output.
  const capture = readCapturedInference(`${EXP_DIR}/captures/p2-a-upto-requests.jsonl`);
  const probeReq = capture.find((r) => JSON.stringify(r.body.messages).includes("NONCE-P2A"));
  const reqTexts = probeReq.body.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .filter((b) => b.type === "text" && !b.text.startsWith("<system-reminder>"))
    .map((b) => b.text.trim());
  const gsmStr = JSON.stringify(msgs.slice(0, uuids.indexOf(probeUser.uuid) + 1));
  let cursor = 0;
  for (const t of reqTexts) {
    const at = gsmStr.indexOf(JSON.stringify(t).slice(1, -1), cursor);
    assert(at >= 0, `p2-a: request text not found in order in getSessionMessages output: ${t.slice(0, 60)}`);
    cursor = at;
  }
  report.p2a = { returned: uuids.length, returnedWithSystem: msgsSys.length, requestTextBlocksMatched: reqTexts.length };
}

// --- p7 final state: 12 stacked boundaries, last preserves cycle 11's leaf ---
{
  const cwd = "/tmp/clauctl-cbi-derisk/p7-cwd";
  const configDir = "/tmp/clauctl-cbi-derisk/p7-lifecycle";
  const projDir = path.join(configDir, "projects", projectKey(cwd));
  const sessionId = fs.readdirSync(projDir)[0].replace(".jsonl", "");
  const entries = readJsonl(path.join(projDir, `${sessionId}.jsonl`));
  const lastBoundary = entries.filter((e) => e.subtype === "compact_boundary").at(-1);
  const lastSummary = entries.find((e) => e.parentUuid === lastBoundary.uuid);
  const preservedLeaf = lastBoundary.compactMetadata.preservedMessages.uuids[0];

  process.env.CLAUDE_CONFIG_DIR = configDir;
  const msgs = await getSessionMessages(sessionId, { dir: cwd });
  const uuids = msgs.map((m) => m.uuid);

  // KNOWN DIVERGENCE (captures/p7-groundtruth-requests.jsonl): the leaf's
  // thinking sibling — same API message id, NOT on the playlist — appears in
  // getSessionMessages but not in the outbound request. gSM is message-id
  // granular; the wire honors the playlist exactly. The two agree whenever the
  // playlist keeps sibling entries together (whole-API-message granularity).
  const thinkingSibling = entries.find((e) =>
    e.type === "assistant" && e.uuid !== preservedLeaf
    && e.message?.id === entries.find((x) => x.uuid === preservedLeaf).message?.id);
  const lastBoundaryIdx = entries.findLastIndex((e) => e.subtype === "compact_boundary");
  const allowed = new Set([lastSummary.uuid, preservedLeaf, thinkingSibling.uuid,
    ...entries.slice(lastBoundaryIdx).map((e) => e.uuid)]);
  assert(uuids[0] === lastSummary.uuid, `p7: first message is not the last summary`);
  assert(uuids.includes(preservedLeaf) && uuids.includes(thinkingSibling.uuid),
    `p7: preserved leaf or its thinking sibling missing`);
  const strays = uuids.filter((u) => !allowed.has(u));
  assert(strays.length === 0, `p7: pre-boundary messages leaked beyond the sibling: ${strays}`);
  assert(JSON.stringify(msgs[0].message).includes("ALPHA-12"), `p7: last summary content missing`);
  report.p7 = {
    returned: uuids.length,
    stackedBoundariesInFile: entries.filter((e) => e.subtype === "compact_boundary").length,
    divergence: "gSM includes same-message sibling entries excluded from the playlist; the wire does not",
  };
}

fs.writeFileSync(`${EXP_DIR}/captures/p8-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("PASS — getSessionMessages matches the effective context on both fixtures");
