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
   *summarized* region as system-reminder text — tool context survives compaction
   via a mechanism separate from `preserved_messages`. Presence assertions must
   therefore locate *which* message carries a nonce (summary text quotes user
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

| variant | relinked? | conclusion |
|---|---|---|
| boundary without `compactMetadata` | no (summary-only context) | metadata is **load-bearing** |
| `preservedMessages.uuids: []` | no | empty list = skip, as inferred |
| summary without `isCompactSummary` | **yes** | flag is cosmetic for the loader |
| `preservedSegment` only (old encoding) | **yes** | old encoding still honored by loader |
| summary text without "This session is being continued…" boilerplate | **yes** | summary content is free-form |

So the minimal synthetic recipe: boundary entry with `compactMetadata` containing a
valid `preservedMessages` (or `preservedSegment`), plus any user message parented
on the boundary as the summary. `isCompactSummary`/`isVisibleInTranscriptOnly`
affect UI rendering, not context reconstruction. Summary text is entirely ours.
