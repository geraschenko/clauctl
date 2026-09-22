# Work log — compact-boundary-injection derisk

## 2026-07-13 — setup + Phase 0a/0b

Versions: SDK 0.3.195 (bundled CLI 2.1.195), model haiku-4.5. All runs on scratch
`CLAUDE_CONFIG_DIR`s under `/tmp/clauctl-cbi-derisk/`, seeded with a read-only copy
of `~/.claude/.credentials.json` (the resume-persistence scratch creds had a dead
refresh token — the CLI zeroed `expiresAt` after a failed refresh). Harness refuses
to run if the real access token has <15 min left, so scratch CLIs never trigger a
refresh that could rotate the real session's tokens.

### Phase 0a — capture path validated (`p0a-capture-validation.mjs`)

`ANTHROPIC_BASE_URL` → local recording shim (`shim.mjs`) works: turn completes,
outbound inference request captured with nonce, session jsonl lands at the
predicted `projects/<projectKey>/<sessionId>.jsonl` path. PASS.

### Phase 0b — native `/compact` baseline (`p0b-native-compact.mjs`)

Fixture: U1 (Read-tool turn), U2, U3, nonce-tagged; then `/compact` sent as a user
message through streaming input; then probe turn. Artifacts in `captures/p0b-*`.

Findings:

1. **Boundary entry shape** (in `p0b-native-compact-report.json`): `type: "system",
   subtype: "compact_boundary"`, `parentUuid: null`, `logicalParentUuid` = old leaf,
   `content: "Conversation compacted"`, `isMeta: false`, `level: "info"`, plus
   `compactMetadata: {trigger: "manual", preTokens, durationMs, postTokens,
   preservedSegment {headUuid, anchorUuid, tailUuid}, preservedMessages {anchorUuid,
   uuids, allUuids}}`. Both old (`preservedSegment`) and new (`preservedMessages`)
   encodings are written.
2. **Preserved set is assistant-only here**: `uuids` = the U3 turn's two assistant
   entries (thinking + text); the U3 user message itself is NOT preserved. Anchor =
   the summary message uuid.
3. **Relink is load-time only, as inferred**: on disk, preserved entries keep their
   original `parentUuid`s; the file-order chain is `boundary → summary(user,
   isCompactSummary, isVisibleInTranscriptOnly) → /compact command-echo user
   messages → later turns`.
4. **Summarization prompt (Q5)**: the compaction request is a normal inference call
   (same system prompt); the instruction is a text block **appended to the final
   user message**: "CRITICAL: Respond with TEXT ONLY… <analysis> block followed by
   a <summary> block" with 9 required sections. Full text:
   `captures/p0b-summarization-prompt.txt`. The summary user message written to
   disk wraps the model's output in "This session is being continued…" boilerplate,
   including a pointer to the full transcript path and "Resume directly" tail
   instructions.
5. **Tool re-injection**: the post-compaction probe context was `[summary(user),
   preserved assistant blocks, user(system-reminder: "Called the Read tool with
   input …"), user(system-reminder: "Result of calling the Read tool: …" + command
   echoes + probe)]`. I.e. the CLI re-presents recent tool calls/results from the
   _summarized_ region as system-reminder text — tool context survives compaction
   via a mechanism separate from `preserved_messages`. Presence assertions must
   therefore locate _which_ message carries a nonce (summary text quotes user
   messages verbatim; naive "nonce in request" checks are confounded).
6. **No state outside the jsonl**: config-dir diff across compaction shows only the
   session jsonl changed.
7. Non-message entry types observed in the file: `queue-operation` (parentUuid
   null), `attachment`, `last-prompt`.

### Phase 0c — interactive Esc-Esc traces via tmux (no manual traces needed)

Drove the bundled CLI 2.1.195 interactively under tmux (scratch config dir needed
`.claude.json` patched with `oauthAccount` + `hasCompletedOnboarding: true`; then
theme/trust prompts scripted). Three fresh sessions, one per rewind variant, all at
rewind point U2. Artifacts: `captures/p0c-*`.

1. **"Summarize from here"** (`p0c-escesc-{pre-rewind,after-summarize-from}.jsonl`):
   appends `[boundary, summary]` to the SAME session file. Boundary
   `compactMetadata` gains `messagesSummarized: 8`; `preservedMessages.uuids` = the
   9 U1-turn entries (kept prefix), `anchorUuid` = **the boundary itself** — matches
   the static analysis for `from`. Summary user message has `summarize_metadata:
   {messagesSummarized: 8, direction: "from"}` and on-disk `parentUuid` = the
   boundary. **Open question for Phase 1**: post-relink, both the preserved prefix
   head and the summary claim the boundary as parent — the loader's ordering of
   these two children needs the resume oracle. UI prefills the input with U2's text.
2. **"Summarize up to here"** (`p0c-uptohere-{pre,post}.jsonl`): appends
   `[boundary, summary]`; `preservedMessages.uuids` = the 8 U2..U3 entries (kept
   suffix), `anchorUuid` = **the summary message** — matches the static analysis for
   `up_to`. No `direction` field observed on this summary entry.
3. **Plain "Restore conversation"** (`p0c-restore-*.jsonl`): writes NOTHING at
   rewind time. The fork materializes when the next message is sent: replacement
   U2B's `parentUuid` = original U2's parent — **in-file branch confirmed**
   (rewind-and-tree.md's hypothesis). Preceded by a `file-history-snapshot` entry.
4. **Partial-summarization prompts (Q5, saved as
   `captures/p0c-summarize-req{0,1}-prompt.txt`)**: both modes are normal inference
   calls with the instruction appended to the last user message, like `/compact`,
   but with mode-specific wording and message sets:
   - `from`: request contains the FULL conversation; instruction says "summarize
     the RECENT portion — the messages that follow earlier retained context; earlier
     messages are kept intact".
   - `up_to`: request contains ONLY the to-be-summarized prefix; instruction says
     the summary "will be placed at the start of a continuing session; newer
     messages follow after it".
     So in the synthetic route we can match parity by using these exact prompts with
     our own boundary choice — the scoping is purely prompt-side plus message-set
     selection; no API-level parameter.

## 2026-07-13 — Phase 1 (`p1-injection.mjs`)

**Methodology trap found first**: the session jsonl flush LAGS the SDK `result`
message. My initial p0b snapshots (taken right after `send()` resolved) were
missing the final assistant entries, and the "post-compact" snapshot was missing
the boundary+summary entirely — which made a first run of Phase 1 look like exact
replay failed. Corrected fixtures (`p1-fixture-{pre,replay}.jsonl`) are cut from
the final post-probe file. **Q9 implication: "turn result received" ≠ "file
flushed"; the daemon's teardown→append sequence must wait for file quiescence.**

Results with corrected fixtures (all resume with `resume: sessionId` in a fresh
config dir; oracle = probe request capture + parentUuid of first new write):

- **A. Exact replay** of the native post-/compact file: PASS. Probe context =
  [summary, preserved assistant, tool-reminder user msgs, echo/synthetic msgs,
  probe]. Compaction state fully reconstructed from the jsonl alone on resume;
  the tool-reminder re-injection also happens on resume.
- **B. Synthetic boundary + summary (fresh uuids, our own summary text)**: PASS.
  Probe context = [our summary, preserved messages, probe]; first new write's
  `parentUuid` = preserved tail — exactly the relinked chain. **The core trick
  works.**
- **C. Second-resume durability** of B (after a live turn): PASS — context stays
  compacted, first probe turn retained.
- **D. Bad uuid in `preservedMessages.uuids`**: relink silently skipped, as the
  static analysis predicted. Context = summary only (CLI inserts an assistant
  "No response requested." after the trailing summary-user message; same insertion
  appears whenever the effective chain ends on a user message). Distinguishable
  from B by the missing preserved messages and by the first new write's parent
  being the synthetic assistant instead of the preserved tail — the fail-closed
  detector works.

Also observed: `queue-operation`, `last-prompt`, `file-history-snapshot`,
`system:turn_duration` entries interleave with messages; none carried parent links
that affected the walks above.

### Phase 1e — field ablation (`p1e-ablation.mjs`, `captures/p1e-report.json`)

Baseline = Phase 1 case B (relinked = preserved "Red" in context AND first new
write parents onto preserved tail). One change per variant:

| variant                                                             | relinked?                 | conclusion                           |
| ------------------------------------------------------------------- | ------------------------- | ------------------------------------ |
| boundary without `compactMetadata`                                  | no (summary-only context) | metadata is **load-bearing**         |
| `preservedMessages.uuids: []`                                       | no                        | empty list = skip, as inferred       |
| summary without `isCompactSummary`                                  | **yes**                   | flag is cosmetic for the loader      |
| `preservedSegment` only (old encoding)                              | **yes**                   | old encoding still honored by loader |
| summary text without "This session is being continued…" boilerplate | **yes**                   | summary content is free-form         |

So the minimal synthetic recipe: boundary entry with `compactMetadata` containing a
valid `preservedMessages` (or `preservedSegment`), plus any user message parented
on the boundary as the summary. `isCompactSummary`/`isVisibleInTranscriptOnly`
affect UI rendering, not context reconstruction. Summary text is entirely ours.

## 2026-07-13 — repo-relative harness

Addressed TDC (commit f29fe03): `EXP_DIR` is now derived from `import.meta.url`,
`REPO_DIR` from it; the SDK import uses a relative specifier. Experiments run from
any worktree.

## 2026-07-13 — Phase 2 (`p2-options.mjs`, `captures/p2-report.json`)

Fixtures: the p1 fixture (U1 tool-turn / U2 "4" / U3 "Red") and the p0c branched
fixture (trunk = U1 turn ending in a `turn_duration` entry; branch 1 = U2 "4" →
U3 "Red", abandoned; branch 2 = U2B "6", holds the file's natural leaf).

### Summarization shapes (Q2a) — all PASS

- **a. up_to reproduction** (preserve U2..U3 suffix incl. user messages, anchor =
  summary): probe context = [summary+U2 merged, "4", U3, "Red", probe]; next write
  parents on "Red". Note: the summary user message and a preserved leading user
  message merge into ONE API user message (consecutive same-role blocks coalesce).
- **b. from reproduction** (preserve U1 prefix, anchor = boundary): resolves the
  Phase 0c open question — loader order is **preserved prefix first, then
  summary**; the chain ends on the summary (a user message), so the CLI appends a
  synthetic assistant "No response requested." and the next write parents onto
  that synthetic assistant, not a fixture entry. Probe context = [U1 turn (6
  msgs), summary, synthetic assistant, probe].
- **c. non-contiguous subset** (drop U1 user msg + failed first Read pair + the
  whole U2 turn; keep the successful tool pair + U3): probe context = exactly the
  subset, tool pairing intact, parent = "Red". **Arbitrary ordered subsets work**
  as long as they're valid message sequences.

### Branch navigation (Q4)

- **`resumeSessionAt` is active-chain-only rewind, not tree navigation.** The
  lookup only covers the chain walked from the file's natural leaf to the root.
  On-chain uuid (case d): works — context truncated at the target, next write
  parents on the target (in-file fork, same session file, same session id), no
  summarization request. Abandoned-branch uuid (e), nonexistent uuid (f), and
  uuid behind an injected boundary (g): all fail fast with result
  `error_during_execution`, stderr `No message found with message.uuid of: <uuid>`,
  **zero API requests**. (Found via debug scripts: a live-session assistant uuid
  works both in place and transplanted to a fresh config dir, so it's chain
  membership, not file provenance.)
- **i. Branch activation by leaf-marker append — the clean branch-switch
  primitive.** Appending ONE `turn_duration`-shaped system entry with
  `parentUuid` = abandoned-branch leaf makes that branch the active chain:
  probe context = U1..U3 with "4"/"Red", no U2B/"6", no summary needed; next
  write parents onto the marker (native files also parent user messages onto
  `turn_duration` entries, so the shape is idiomatic).
- **j. Branch activation via boundary** (preserved uuids = full desired chain,
  minimal summary text): also works; probe parent = "Red" directly. Use when a
  summary of the abandoned branch is wanted anyway; use the leaf-marker when not.
- **h. Combined pi-style emulation** (branched file, from-style boundary keeping
  only the U1 trunk, our summary of both abandoned branches): PASS — context =
  [U1 turn, summary, synthetic assistant, probe]; relink overrides the file's
  natural leaf.
- **k. Boundaries seal the summarized region.** A leaf-marker whose parent points
  at a message behind the boundary is ignored — context stays [summary,
  preserved, probe], parent = preserved tail. Together with (g): once a boundary
  is in the file, the summarized region is unreachable by `resumeSessionAt` and by
  markers; the only way back is a NEW boundary whose `preservedMessages` re-lists
  the old chain (j shows that works).

## 2026-07-13 — Phase 3 (`p3-adversarial.mjs`, `captures/p3-report.json`)

All on the p1 fixture; loader acceptance vs API acceptance vs semantic usability:

- **m1/m2. Broken tool pairing is SANITIZED, not rejected.** Preserving a
  `tool_use` without its `tool_result` (m1), or a `tool_result` without its
  `tool_use` (m2), never reaches the API as malformed: the CLI drops the orphan
  block AND its companion thinking block from the outbound request (both cases
  converge to the same clean context; probe got HTTP 200, turn succeeded). So
  invalid pairings degrade gracefully — messages silently vanish from context.
- **m3. Arbitrary reordering works.** Preserved list [U3 turn, U2 turn] (reverse
  chronology, valid role alternation) → context follows LIST ORDER exactly; next
  write parents on the list's last uuid ("4"). Combined with Phase 2c: the
  preserved list is an arbitrary ordered playlist of message uuids, not a chain
  filter.
- **m4. Duplicate uuids invalidate the whole relink** — silent skip, same
  signature as the bad-uuid control (context = summary + synthetic "No response
  requested."; next write parents on the synthetic assistant). The fail-closed
  detector catches it.
- **m5. Stacked boundaries: the LAST boundary wins entirely** — second summary +
  its preserved set; first summary absent from context.
- **m6. Trailing non-message entries** (file-history-snapshot, queue-operation
  after the summary) — no effect on relink.
- **m7. Attachment uuid in the preserved list is accepted** (it exists in the
  file, so no skip) and contributes nothing to the outbound messages; the rest of
  the list works normally. Preserved lists don't need to avoid non-message uuids
  as long as the uuids exist.

## 2026-07-13 — Phase 4 (`p4-integration.mjs`, `captures/p4-report.json`)

### Q7 — CLI machinery on an injected file: fully compatible

- **Token accounting follows the compacted context**: probe on an injected file
  reports ~24k total input (≈ system prompt + tools + our small context), so
  auto-compact thresholds operate on the true post-injection size.
- **A real `/compact` on an injected session succeeds**: the summarization
  request contains only the effective context (our synthetic summary + preserved
  messages, 3 messages; sealed region absent), and the CLI writes a normal new
  boundary (both `preservedSegment` and `preservedMessages` encodings,
  plausible `preTokens: 24313`). Post-compact probe works. Boundaries stack
  exactly as m5 predicts (last one wins).

### Q8 — file checkpointing vs boundaries

Setup in ONE config dir (create → close → append in place → resume), checkpointing
enabled, notes.txt written V1 (turn 1) then V2 (turn 2); boundary injected
preserving only turn 2.

- Live control (pre-injection): `rewindFiles(U1, dryRun)` → `canRewind: true`.
- Plain-resume control (separate run, no injection): `rewindFiles(U1)` still
  works after resume — it deleted notes.txt (rewind target = state at that user
  message, before its turn's writes). So checkpoints survive resume per se.
- **After boundary injection, `rewindFiles` to a summarized-region message fails**
  with "No file checkpoint found for this message." — the boundary seals
  checkpoint lookups too (consistent with Phase 2 g/k).
- `rewindFiles` to a PRESERVED message on the injected file works: notes.txt
  reverted V2 → V1.

### Q9 — lifecycle for the teardown→append→resume protocol

- Flush lag: the turn's assistant entry hit disk **177 ms after** the SDK
  `result` message in this run. Poll for the expected leaf entry; don't trust
  `result` alone (Phase 1 trap) and don't rely on a fixed delay.
- Once the leaf assistant entry is on disk, the file stayed quiescent (0 bytes
  in a 2 s observation window) — leaf-on-disk is a usable append trigger.
- A sentinel line appended while the Query was still open **survived
  `q.close()`** (no rewrite/clobber); the only post-sentinel write was a
  trailing `last-prompt` entry, which is a non-message entry and harmless to an
  appended boundary (Phase 3 m6).

## 2026-07-13 — Q3 full-tree read (`p5-q3-treeread.mjs`, `captures/p5-q3-report.json`)

`importSessionToStore` → `InMemorySessionStore` on the branched fixture + a
synthetic boundary carrying an unknown custom field:

- **Verbatim and complete**: 30/30 entries deep-equal to the raw jsonl, in file
  order; the unknown field and `compactMetadata` pass through un-normalized.
- **Failure observability**: nonexistent session throws `Session <id> not found`.
- So the SDK route loses nothing vs parsing the jsonl directly. Trade-off:
  `importSessionToStore` is `@alpha` (drift risk) but handles project-dir
  resolution and subagent transcripts (`includeSubagents`); raw jsonl parsing is
  trivial (`readJsonl`) and avoids the alpha surface. Either works for tree
  navigation; nothing in the entry stream is SDK-only.

## 2026-07-13 — FINDINGS.md + reviewer audit

Wrote FINDINGS.md; revived the plan reviewer (pictl agent
40783d4b-bea7-49f1-9ed8-fc2053fb7616) to audit whether the findings are
justified by the experiments. Verdict: **core technique justified** (synthetic
boundary controls the effective resumed transcript; capture oracle detects
silent relink failure; survives resume + manual /compact), but the document as
first written **overclaimed** in several places. Applied the demanded
weakenings to FINDINGS.md:

- "arbitrary subsets" → ordered subsets of existing unique uuids, subject to
  CLI normalization; "minimal recipe" → "known-working recipe" with the
  un-ablated fields listed; `preTokens`/`postTokens` no longer called cosmetic.
- Auto-compact: accounting compatibility observed, automatic triggering NOT
  tested. Q9: downgraded from "safe with one rule" to a single-run observation;
  safe lifecycle boundary remains unproven.
- Sealed-region "NO" scoped to the three tested mechanisms; "last boundary
  wins" scoped to tested stacks; tool-pair sanitization scoped to the two
  tested patterns; Q3 verbatim-copy scoped to the tested fixture; subagent
  import noted as unexercised.
- New "Deviations from the approved plan" section: unchanged-resume control on
  the canonical fixture never run standalone; P1 a is a "native transcript
  replay" rather than the literal clone+byte-append control; harness records
  rather than hard-asserts (upgrade-regression use requires adding assertions).
- Provenance corrected: only the SDK package version is asserted per run; CLI
  2.1.195 inferred from entry `version` fields; request model not recorded.

Reviewer follow-ups NOT yet done (candidate next steps): add hard assertions to
the harness, run the standalone unchanged-resume control, per-run CLI/model
assertion, second-resume parent assertion, and (optionally) the literal exact
replay control.

## Reviewer approval + remaining-gaps assessment (2026-07-13)

Sent the revised FINDINGS.md back to the reviewer (agent 40783d4b). Two final
wording edits demanded and applied: (1) header evidence statement scoped to
context-relink claims (Q3/Q5/Q9/provenance use different evidence);
(2) "version-pinned empiricism" → "SDK-pinned empiricism against an observed
bundled CLI version". Reviewer then **formally approved FINDINGS.md**.

Reviewer's ranked remaining gaps (risk × cheapness), design-blocking first:

1. **Safe mutation lifecycle** (highest): repeated matrix of append points
   (after result / after leaf-on-disk / after input close / after drain /
   after close / after child exit) × immediate resume, 10–20 reps, incl.
   pending last-prompt writes. Blocks the daemon teardown→append→respawn protocol.
2. **Cross-model preserved thinking blocks**: inject preserving signed thinking
   from model A, resume under model B; also preserve turns with thinking omitted.
   Blocks model switching across tree navigation (or forces a conservative
   exclude-thinking rule).
3. **Leaf-marker durability**: marker → resume → turn → close → resume again;
   interaction with earlier/later boundaries, last-prompt, checkpointing.
   Blocks choosing markers (vs boundaries) as the branch-switch primitive.
4. **Safe playlist-construction rule**: focused matrix (complete turns,
   consecutive same-role, assistant-without-user, parallel tools, tool errors)
   to derive a conservative rule like "complete turns + complete tool exchanges
   only". Blocks exposing arbitrary selection; not up_to/from on whole turns.
5. **Summary/tool-reminder parity**: what native compaction re-injects as
   system-reminders, selection rule, persistence. Product-quality, not mechanism.

Hardening (not design-blocking): 6 assertion-ize the harness; 7 assert CLI
version + captured request model per run; 8 organic auto-compaction trigger;
9 boundary-stack combinations; 10 literal replay/unchanged-resume controls;
11 field minimization ablation; 12 large fixtures + subagent sidechains.

Reviewer archived.

## P6: cross-model preserved thinking blocks (2026-07-13)

`p6-model-switch.mjs` — P1 fixture (haiku-created, signed thinking in every
assistant turn), resumed under `claude-sonnet-4-6`. Three cases:
control (plain resume), up_to injection preserving U2..U3 WITH the thinking
entries, and the same playlist WITHOUT them.

All three: HTTP 200, result success, correct recall (control recovered the
magic word + Red; injected cases correctly knew only what the summary allowed),
first new write parented on red (254029a1). Key mechanism finding: **the CLI
strips historical thinking blocks itself when the resume model differs** —
sonnet requests carried 0 thinking blocks even in the plain-resume control
(thinking param `{"type":"adaptive"}`, tool_use/tool_result pairs forwarded
intact), while the same fixture resumed under haiku (p2-a capture) forwarded
2 signed thinking blocks. So no clauctl-side exclude-thinking rule is needed
for model switches; the CLI already applies one. Caveats: one direction
(haiku→sonnet), one run each, CLI 2.1.195 behavior.

Report: captures/p6-report.json.

## P7 lifecycle prototype + P8 getSessionMessages + assertions (2026-07-14)

Harness: makeSession gained `endInput()` (graceful: end prompt stream, CLI
exits on stdin EOF) and `done` (the message-loop promise; SDK cleanup awaits
the child's exit before the generator completes).

`p7-lifecycle.mjs` — 12 consecutive cycles of the daemon path: send turn →
fs.watch until the stream's assistant uuid is on disk → endInput → await done
→ assert no claude child (ps --ppid; first attempt used pgrep -f, which
matched its own sh -c cmdline) → append boundary preserving only the leaf,
summary declaring codeword ALPHA-i → resume. Hard assertions per cycle: probe
request = exactly [summary_i, leaf, probe], no stale summaries/probes, parent =
preserved leaf, model answered ALPHA-i. 12/12 PASS. leafOnDiskMs 27–101
(median ~98), teardownMs 9–14. Boundaries stacked 12 deep, last always won.

`p8-getsessionmessages.mjs` — cross-validated getSessionMessages against shim
captures on the p2-a fixture (uuid chain summary+U2..U3 exact; every
non-reminder request text block found in order — note the CLI adds a trailing
\n to the summary block when coalescing) and the p7 final state. Divergence
found and characterized: gSM returns same-API-message sibling entries even
when the playlist excludes them (cycle 11's thinking sibling), but a fresh
haiku ground-truth capture (captures/p7-groundtruth-requests.jsonl) shows the
wire honors the playlist exactly. gSM == wire at whole-API-message granularity.
includeSystemMessages surfaces the boundary entry.

`check-reports.mjs` — 38 hard assertions over p1–p8 report JSONs (run-stable
invariants only; run-minted uuids asserted structurally). PASS. This +
rerunning the scripts is now the upgrade-regression gate. FINDINGS.md updated:
header (assertion gate), lifecycle proven (replaces the one-run Q9 hedge),
cross-model caveat resolved (P6), gSM assertion-layer note.

## P9: summary-free navigation + rewind within a relinked chain (2026-07-14)

Derisk targets from the spec review comments (`git show 4eb65a9`). Script:
`p9-navigation.mjs`; report: `captures/p9-report.json`. All three cases met
every expectation on the first run (gate: `check-reports.mjs`, now 41 asserts).

- **a-no-summary**: P1 fixture + a boundary with `anchorUuid` = its own uuid,
  playlist U2..red, NO summary entry — the boundary is the last line of the
  file. Relink applied: probe request = exactly the playlist turns (5 msgs),
  U1/magic word absent, new write parented on red. Pure navigation works
  without synthesizing any summary. The prior worry (nothing parents onto the
  boundary, so it might never join the active chain) was unfounded.
- **b-prefix**: p2-a fixture (boundary1 + summary1 + probe turn) + boundary2
  whose playlist = [summary1, U2 user, U2 thinking, "4"] — a prefix of the
  chain boundary1 created, reaching entries boundary1 summarized away and
  including boundary1's summary entry as a playlist member. Honored exactly:
  request = summary1 + U2 turn (3 msgs), U3/red/old-probe absent, new write
  parented on "4". This is the TUI viaBoundary-TreeNode navigation case.
- **c-rewind-preserved**: p2-a fixture resumed with `resumeSessionAt` = "4"
  (a playlist member of boundary1). The rewound context PRESERVES the
  boundary's effect: summary1 present, U1 absent, everything after "4"
  truncated; new write parented on "4"; nothing written to the file by the
  rewind itself. So `--rewind-to` needs no jsonl mutation on the active chain,
  relinked or not.

Also settled from existing evidence while addressing the review comments:

- The SDK query option is `resumeSessionAt` (docs: assistant uuid, "resume
  messages up to and including"); `upToMessageId` is a `forkSession()` param
  that mints a NEW session id with fresh uuids — wrong tool for the daemon.
- Duplicate playlist uuids: already verified (P3 m4) — the loader silently
  skips the whole relink; the spec's fail-closed error stands.
- Native `logicalParentUuid` semantics confirmed in p0b/p0c captures (see
  FINDINGS): always the last message before the summarization point.

## 2026-08-28/29 — Round 2: loader re-derivation on SDK 0.3.250 / CLI 2.1.250

Plan + source-reading detail: README-20260828.md (reviewer-hardened, pictl
agent be9d9690; two rounds of probe-design fixes — p14 redesigned around an
anchor child after the original was shown non-discriminating, E1 relabeled
from "free" after a live-call audit, p11a's thinking fixture replaced with a
text+tool_use split to dodge the thinking-strip mask).

**Phase 0 + E2 (source)**: read the 2.1.250 binary. Found the resume relink
`Ser` hiding in `H0t`'s `finish` callback (round 1 missed it); traced the
full call graph resume→relink→walk→expansion→sanitizers→normalization→wire,
and the request pipeline (`$oe` user-merge, `DJn` same-id regroup, `_vt`
positional tool-pair repair, `eye` unresolved-tool_use drop). Key reading:
the cut runs BEFORE the expansion on resume; getSessionMessages is a
separate pipeline (sequential-all relink, no cut).

**E1 (rerun)**: full round-1 suite p0a–p10 + check-reports on 0.3.250 — all
PASS after two non-loader fixes (p4 q8 prompt pinned to absolute paths — a
model flake wrote /tmp/notes.txt; /tmp fixture regeneration after a reboot).
Zero loader drift. One writer drift: native /compact keep-segment reach
shrank on the p4 q7 fixture (2.1.195 kept old-summary→probe-turn; 2.1.250
kept only the final assistant turn's entries, excluding even its user
prompt). One data point per version; selection rule untraced;
check-reports.mjs now version-conditions that assertion. harness.mjs
repinned to 0.3.250.

**E3 (wire probes, `round2.mjs` + p11a–p17)**: all 8 matched their
pre-registered source-predicted model, zero violations.

- p13: API-message expansion ACTIVE on plain resume (off-path fork sibling
  - result on the wire).
- p11a/p11b: cut-before-expansion — playlist-excluded same-id siblings
  (text; fork tool_use + its result) absent from the wire, present in the
  same fixture's getSessionMessages output. P8's divergence explained.
- p12 plain: three consecutive preserved users MERGED into one API user
  message, all markers intact — no drop rule exists.
- p12 results: playlist order [call1, call2, result1, result2] → call1
  synthetically healed, real result1 dropped, adjacent call2/result2
  intact. Triage (post-run): NOT a fixture defect (result1's tool_use_id is
  present) — `_vt` pairing is positional; results must sit immediately
  after their calls.
- p14: duplicated playlist rewritten UNCHECKED (anchor-child discriminator)
  — REVERSES round 1's m4 claim, whose fixture was masked. FINDINGS,
  session-tree.md Ground truth, and loader.ts comments updated; our
  duplicate rejection re-labeled a deliberate fail-closed divergence.
- p15a: trailing invalid boundary → abort-untouched on resume (earlier
  valid boundary NOT consulted); gSM applied it — per-consumer split.
- p16: cut + orphan reparent on resume (raw pre-boundary ancestors gone,
  orphan repointed to playlist tail); gSM followed raw parents — no cut.
- p17: call-without-result → whole assistant message dropped (`eye`), no
  synthetic heal.

Corroborating live experiment (Anton, session ee0d): merged users perceived
as one message ("Only once"); orphan result dropped; call-without-result.

**E4**: FINDINGS.md rewritten as the living document (pipeline-ordered,
per-consumer scoping, m4 reversal, drift section); session-tree.md Ground
truth re-derived for 2.1.250 (resume-consumer scoping, post-walk stages,
p15a confirmation, m4 caveat resolved); D6 timestamp-repair divergence
recorded as a loader.ts comment (deferred — corrupted files only).
Follow-up specs queued in docs/specs/next.md (set-context closure, TUI
post-set-context rendering, probes as SDK-upgrade regression suite).

## 2026-08-29 — TDC round (e691fe6): p18–p20, three claim revisions

Anton committed E4 with eight in-place TDC review comments; the load-
bearing ones demanded wire answers instead of hedges. 17 wire calls
(p18×3; p19 3+3, p20 4+4 — reruns after run 1 falsified every
pre-registered model on one case each; post-hoc models are marked in the
scripts and held on the confirming rerun).

- Native parallel-call raw shape verified against real sessions
  (~/.claude/projects/-home-anton/4cbaa4de…, 4d92f439…): same-id entries
  chain callA→callB, each result is a CHILD of its call (branch at
  callA), continuation parents on the LAST result. round2.mjs
  forkFixture (both calls user-parented) does NOT match; p13's oracle
  role moved to p18's native-shaped control.
- p18: BOTH playlist orderings ([calls then results] and per-pair
  interleaved) presented the exact native shape — one assistant API
  message with both calls, one user message with both results, zero
  heals. REVISES "only consecutive same-id entries join": reassembly
  crosses intervening tool_result users. Ordering only matters for
  calls in distinct API messages (p12).
- p19: same-model resume forwards signed thinking (control: 5 blocks on
  wire — kills the round-2 "not wire-discriminable" hedge, cf. p2-a).
  Excluded thinking sibling absent (cut-before-expansion). NEW: excluding
  the TEXT sibling dropped the whole message — thinking-only assistant
  messages are dropped; thinking is never presented without a
  non-thinking sibling. Run-1 marker-collision lesson: bare
  XYLOPHONE-77431 also occurs in result2's tool_result; the magic TEXT
  entry needs the `**`-marked form.
- p20: REVISES p17's whole-message reading — the unresolved-call drop is
  BLOCK-level: kill0 (text+2 calls, 0 results) presented the text alone;
  kill1 (1 result) kept text+callA+resultA, dropped callB with NO
  synthetic heal (the block dies before `_vt`). Partial-message
  playlists work per-entry (part1/part2). Side observation: a file
  ending on a tool result gets a CLI-appended "Continue from where you
  left off" user text + "No response requested." assistant turn.

Docs updated (FINDINGS pipeline steps 3–5, failure modes, provenance;
next.md closure rules; session-tree step 8); check-reports extended to
p1–p20 (66 assertions, PASS). ee0d "merged users perceived as one" claim
withdrawn (it asked about responses, not appearances); all
content-preservation claims now scoped to the wire.

## 2026-08-31 — Reviewer round on the pipeline description: APPROVED

Reviewer be9d9690 (revived with its E4 context) reviewed the p18–p20
material plus the new terminology block and five-stage overview. Two
block rounds (10 + 4 findings, all evidence-scoping/terminology; no new
probes), all agreed and fixed. Substantive corrections: stage-2 output
is chronological root-to-leaf (`uye` walks leaf→root, then REVERSES);
the overview had the native parallel-fork geometry inverted (the calls
CHAIN and stay on the walked path — the RESULTS branch, so the walk
loses off-path results and expansion exists to recover them); stage 4
filters content blocks WITHIN entries (terminology block updated —
entries are the unit of stages 1–3); the thinking-only drop's stage
attribution is left untraced in the overview too; session-tree.md
ground truth split into step 8 (resume sanitization) and step 9
(request normalization) with citations untangled (expansion: p13/p18;
cut-before-expansion exclusion: p11a/p11b/p19); the "wire" evidence
class now notes p18–p20 assert request captures only; the capability
table's subset-closure and message-order rows restated per p18–p20;
next.md's API-message closure bullet labeled intent-preservation
POLICY, not a loader requirement (p20-part1); post-hoc models labeled
at their citation sites and the headline no longer reads as blanket
prediction success. Final verdict: "ready to serve as the basis for the
real specs."

## 2026-07-17 — P10: empty preserved list (tui-tree spec derisk)

The TUI `/tree` "rewind to the first user message" pick needs a context reset
to nothing: a no-summary boundary with `preservedMessages.uuids: []` (the
shape `buildBoundaryEntries` would write for an empty list). P1e only showed
that emptying `uuids` kills the relink, and the tested skipped-relink shapes
had a summary to fall back on — a bare trailing empty boundary had never been
resumed. `p10-empty-boundary.mjs` (run on SDK 0.3.211, not the 0.3.195 pin;
version recorded in the report): resume + probe turn succeeded, the captured
request contained exactly 1 message (the probe; no fixture markers), and the
first new write's `parentUuid` was the boundary uuid. Empty-context reset
works; `set-context --empty` / TUI new-root rewind are viable.

## 2026-09-22 — 0.3.280: suite rerun + binary re-read (2.1.258 → 2.1.280)

Suite rerun on SDK 0.3.280: check-reports 74/74 after pinning p20 kill1
to `kept-healed-interrupt` for 0.3.280 (the p1e metadata-less boundary
and p4 q7 keep-reach flipped shapes again; see FINDINGS "Version drift").
The heal rule inferred from kill1 ("≥1 answered call keeps the group")
was ported into `sanitizeForResume` / `ToolGroup.excludedAtEnd`. A full
binary diff of the loader followed (README-20260922.md): stages 1–2
token-identical; stage 3 splice order changed (equivalent on native
shapes) plus a new recovered-tails pass; stage 4's heal is NEW and
conditioned on the call being in the file's trailing turn, not on the
group having a result — kill1's file ends at its result and cannot
discriminate. Added `p20-kill1-later` (kill1 + a later user turn and
reply; models tail-heal-only / group-heal / stage5-heal, pre-registered
from the source reading): one run, `tail-heal-only`; kill1 re-confirmed.
`sanitizeForResume` / `ToolGroup.excludedAtEnd(atFileEnd)` corrected to
the positional rule; check-reports gains the kill1-later row (75
assertions). Two-pass >5 MiB reader now admits same-id siblings, progress
rows and tails; still an untested consumer.
