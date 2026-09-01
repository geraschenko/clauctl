# Findings: context management via synthetic `compact_boundary` injection

**Living document** — current belief about how the claude CLI loads context
from session jsonl files, and what synthetic boundary injection can do with
that. Superseded claims are rewritten in place; chronology and per-experiment
detail live in [WORK-LOG.md](WORK-LOG.md), the round-2 plan and source-reading
notes in [README-20260828.md](README-20260828.md).

Provenance:

- **Round 1** (2026-07-13/17): SDK 0.3.195 / bundled CLI 2.1.195 (P10 on
  0.3.211), model haiku-4.5. Probes `p0a`–`p10`.
- **Round 2** (2026-08-28/29): SDK 0.3.250 / CLI 2.1.250 — full round-1 rerun
  (zero loader drift; one writer-side drift, see "Version drift"), source
  reading of the bundled binary, and wire probes `p11a`–`p17` (nine wire
  calls: eight prediction-bearing cases, all matching their pre-registered
  source-predicted model with zero violations, plus the exploratory
  p12-results characterization).
- **Round 2 TDC probes** (2026-08-29): `p18`–`p20` (17 wire calls; p19 and
  p20 each ran twice because run 1 falsified every pre-registered model on
  one case — the added models are marked post-hoc in the scripts and held
  on the confirming rerun). Three claim changes came out of these probes:
  the unresolved-tool_use drop is block-level, not whole-message (revised);
  same-id assistant entries reassemble across an intervening tool_result
  user entry (revised); and an assistant turn reduced to only thinking is
  dropped whole (new finding).

Evidence classes, strongest first: **wire** = captured outbound API request
through the recording shim (never model recall alone; relink probes
additionally assert the `parentUuid` of the first post-resume write —
p18–p20 assert request captures only); **source** = minified JS read out of the bundled
binary (offsets in README-20260828.md; behaviors attributed to named
functions only where the call graph from resume to request was traced);
**probe-indirect** = jsonl/report observations. Upgrade-regression gate on
every SDK bump: rerun the probe scripts (p10+ fail their process on
violations) and `check-reports.mjs`, which hard-asserts over the full
p1–p20 report set.

**Consumer scoping (critical)**: every claim below names the loader it was
tested on. The two tested consumers — **resume** (interactive `--resume`,
`--continue`, headless SDK `query({resume})`; all converge on one code path,
source-traced) and **getSessionMessages** — demonstrably differ. Untested
loaders these claims must NOT be generalized to: `resumeSessionAt`/forks,
the >5 MB streaming skip path, subagent resumes, compaction's own
summarization input, the session picker.

## Headline

**The trick works.** Appending a synthetic `compact_boundary` + our own
summary entry to a session jsonl and resuming via the SDK controls which
transcript entries the model sees, in what order, with what summary text —
wire-verified, surviving a further turn, a second resume, and a subsequent
native `/compact`; stable across 2.1.195 → 2.1.250.

**But the effective context is not the playlist verbatim.** Between the
playlist and the wire sit the relink's cut, an API-message expansion, resume
sanitizers, and request normalization. The pipeline below predicts the wire
exactly as now written — but note its history: the eight prediction-bearing
E3 probes matched their pre-registered models, while one p19 case and one
p20 case falsified every model registered for them; the description below
incorporates those post-hoc revisions, each confirmed on a rerun.

## The load pipeline (resume consumer, 2.1.250)

Terminology, used consistently below:

- **entry** — one jsonl line, with `uuid`/`parentUuid`. The unit the tree,
  playlists, and stages 1–3 operate on; stage 4 also filters content
  blocks WITHIN entries.
- **incoming API message id** — assistant entries carry `message.id`, the
  id of the PAST API response they were streamed from; one assistant turn
  spans several entries sharing that id. User entries have no API id.
- **outgoing API message** — an element of the `messages` array in the
  request being built. Only stage 5 produces these; they exist per-request
  and are never written to the jsonl.

Overview — input → output and purpose of each stage:

1. **Relink** (resume-only, once at load): uuid→entry map + the last
   boundary's playlist → the same map with parents rewritten (playlist
   chained in order after the anchor; the anchor's other children
   reparented onto the playlist tail) AND pre-boundary non-playlist
   entries deleted (any surviving children of deleted entries reparented
   onto the playlist tail — wire-discriminated from anchor-reparenting by
   p16, where the tail appeared on the orphan's walked path; such
   children normally don't exist, natively post-boundary entries parent
   on the summary). Applies the compaction boundary; the later stages
   run the same code whether or not a boundary was involved (the summary
   entry, if any, rides along as ordinary content).
2. **Leaf selection + parent walk**: entry map → one LINEAR chain of
   entries in chronological (root-to-leaf) order — the walk climbs
   leaf→root, then reverses. Picks the active branch; prunes every side
   branch — including, natively, part of every parallel-call turn: the
   calls chain, each result branches off its own call, and the
   continuation parents on the last-WRITTEN result (tool-completion
   order), so the walk keeps that result plus the call chain up to its
   call and loses the other results and any later calls.
3. **Expansion**: the linear chain → the chain plus spliced-back
   same-incoming-id assistant siblings (any block type) and their
   tool_result user children. Restores the pieces of a historical
   assistant turn that branching pushed off-path. This stage MUST exist
   for parallel tool calls to survive: each result is natively a child
   of its own call and the continuation parents on the last-written
   one, so a pure parent walk always loses the other results — and,
   when the last-written result belongs to an earlier call, the later
   calls too (e.g. scripts/tui-parity/out/sessions/readonly-fold.jsonl
   continues from the FIRST call's result, putting the second call AND
   its result off-path).
4. **Resume sanitization** (resume-only, once at load): expanded entry
   list → the list minus tool_use blocks whose result appears nowhere in
   it; an assistant turn (same-incoming-id group) left with nothing
   presentable contributes nothing to any request. Removes exchanges
   whose result is absent from the loaded context — a result-less
   tool_use is an API 400 — before it would poison every later request.
   (A turn reduced to ONLY thinking also vanishes — wire fact, p19;
   whether that drop happens here or in stage 5 is untraced.)
5. **Request normalization** (EVERY turn, resume or not): surviving
   entries + the new turn → the outgoing `messages` array. Merges
   adjacent user entries into one outgoing user message, reassembles
   same-incoming-id assistant entries into one outgoing message (which
   makes stage 3's
   linearization ambiguity unobservable, p18), positionally
   heals/drops tool pairs split across DISTINCT outgoing messages,
   strips cross-model thinking. Produces an API-legal linear request.

Stages 4 and 5 divide the tool-pairing work by condition, which is why
repair can still fire after stage 4's drops: stage 4 removes calls whose
result is absent from the loaded context ENTIRELY ("never answered");
stage 5's repair handles calls whose result exists but lands non-adjacent
after linearization ("answered but misfiled", p12). A call caught by
stage 4 never reaches repair (p20-kill1: no synthetic result).

Outgoing-message STRUCTURE (as opposed to content) matters only
instrumentally: the model may well be unable to perceive message
boundaries at all, but positional repair judges on the outgoing
structure, so structure determines which content is dropped or replaced
with synthetic errors.

Detail per stage, in order. Steps 1–3 are source-traced (`Ser`/`uye`/`Aer`
etc.; offsets in README-20260828.md) and each carries at least one wire
probe.

### 1. Relink (`Ser`, runs on the uuid→entry map before anything else)

- **Last-metadata-boundary-only**: find the last boundary carrying
  `preservedMessages` (or legacy `preservedSegment`) metadata. Relink runs
  only if that boundary IS the file's last boundary. Earlier boundaries'
  playlists are never consulted. (Wire: P3 m5, P4 q7, P7's 12-deep stack.)
- **Stale metadata** (a later metadata-less boundary exists): no relink, but
  the pre-last-boundary prune still runs with an empty keep-set — a wipe.
  (Source; the empty-`uuids` trailing-boundary wipe is wire-verified, P10.)
- **Invalid playlist** (a uuid naming no file entry): telemetry, then return
  with the map UNTOUCHED — no relink, no cut. The walk then follows raw
  parents and stops at the last reachable null-parent boundary. (Wire: p15a —
  a valid earlier boundary was NOT consulted; context = the raw post-boundary
  chain. Round 1's P1 d "summary only" observation is this same abort: its
  file ended at the summary, so the raw walk stopped immediately.)
- **No duplicate-uuid check**: a playlist listing a uuid twice is rewritten
  unchecked. (Wire: p14 — see "Failure modes"; REVERSES round 1's m4
  claim.) set-context still REJECTS duplicates deliberately: the
  unchecked rewrite gives duplicates no statable presented-context
  outcome (in p14's shape the summary fell off the walked path), so
  fail-closed preserves predictability.
- **On success**: chain rewrite (`uuids[0].parent = anchorUuid`, then
  chained); every other child of the anchor reparents to `uuids.last()`;
  `usage` token fields ZEROED on preserved assistant entries; **the cut** —
  every pre-boundary entry not on the playlist is deleted from the map —
  and surviving children of deleted entries repoint to the playlist tail.
  (Wire: p16 — an entry raw-parented on a cut entry appeared after the
  playlist tail; its raw ancestors were absent.)

### 2. Leaf selection + parent walk (`uye`)

Leaf = the last user/assistant entry in the file (trailing
system/attachment/queue entries are skipped; a leaf-marker entry
overrides; after a relink the rewritten chain's dangling tip is the
leaf). Then an ordinary `parentUuid` walk from that leaf over the
transformed map; boundaries act as chain ends. The walked chain is
reversed to chronological order before expansion (source: `uye` walks,
then reverses). A broken parent link falls back to the nearest
earlier entry within 5 s with matching `isSidechain` (timestamp repair —
corrupted files only; no known producer writes dangling parents; recorded as
a comment divergence in `src/core/tree/loader.ts`).

### 3. API-message expansion (`Aer`, after the walk)

Groups by INCOMING API message id. For each on-path assistant
`message.id`: splice in same-id assistant sibling
entries not on the path, plus the tool_result-bearing user children of all
entries of that message. **Active on plain resume** (wire: p13 — an off-path
fork sibling tool_use + its result reached the API; note p13's fixture
parented both calls on the user, which is NOT the native raw shape —
natively same-id entries chain callA→callB with each result a child of
its own call and the next turn continuing from the last-WRITTEN result —
the file tip at continuation-write time, not a position fixed at call
time. Discriminating evidence: results usually complete in call order
(both real sessions below, incl. a three-call chain whose continuation
parents the THIRD call's result), but readonly-fold.jsonl's second tool
finished first, and its continuation parents the FIRST call's result —
the last one written. That raw
shape was established by inspecting real session files; p18's
native-shaped synthetic control then established its wire presentation —
[both calls][both results] — and now serves as the oracle).
**But it runs AFTER the
cut**, so playlist-excluded same-message siblings are unrecoverable on
resume (wire: p11a text sibling of a same-id tool_use, p11b fork tool_use
sibling + its result — all absent). Presented-context rule: whatever
same-message sibling a playlist excludes is absent from what the
assistant sees — the cut is entry-type agnostic. Wire-confirmed for
text+tool_use splits (p11a), parallel-tool splits (p11b), and the
thinking direction (p19: same-model resume forwards signed thinking —
control showed 5 thinking blocks on the wire, cf. round-1 p2-a; the
excluded thinking sibling was absent while its kept text sibling
survived). One ASYMMETRY on top of the rule: excluding the TEXT sibling
of a thinking entry removes BOTH — an assistant turn reduced to only
thinking is dropped whole by a later stage (p19 excl-text; POST-HOC
model — run 1 falsified both pre-registered models, confirmed on
rerun). So thinking can never be presented without a non-thinking
sibling, while text survives without its thinking fine.

**Splice position** (source-traced in `Aer`, 2.1.250; it fires
`tengu_chain_parallel_tr_recovered` telemetry): for each group, the
recovered block — missing same-id siblings timestamp-sorted, then
missing tool_results timestamp-sorted — is inserted immediately after
the LAST on-path assistant entry sharing the `message.id`; on-path
entries keep their positions. Consequence: on file-shaped input the
recovered block always lands strictly BEFORE the walk tip (it follows
the group's last assistant, and results are written after calls, so a
tip inside a group with later off-path results is impossible), so the
expanded chain's last element is still the true file leaf. Since the
continuation parents on the last-written result, the on-path result
sorts last among the group's results, and the expanded order equals
plain "calls in write order, then results in write order".

### 4. Resume sanitizers (`eye` and friends)

Presented-context rule (wire, p20; the block-level model is POST-HOC —
p20-kill1's run 1 falsified every pre-registered model, and the model
held on a confirming rerun): **a tool_use whose result is nowhere in
the loaded context is removed at BLOCK level** — the rest of its turn
survives — with NO synthetic repair. An assistant turn left with no
presentable content disappears entirely (p17's turn was tool_use-only,
which is why it previously read as a whole-message drop; p20
discriminated the two, and the earlier "the drop also takes bundled
text" source reading was WRONG). A turn left with only thinking also
disappears (p19 excl-text; wire fact — whether that drop mechanically
happens here or in stage 5 is untraced). Per-shape wire facts, all
matching the one block-level model:

- NO boundary, session killed mid-response (text + 2 calls, zero
  results), plain --resume → the text is presented alone; both calls
  absent, no synthetic results (p20-kill0 — falsified both "whole
  message dropped" and "kept + healed").
- Same but ONE call has a result → text + that call + its real result
  presented; the unresolved call's block absent, no synthetic heal (the
  block is gone before `_vt` could heal it; p20-kill1). Side
  observation: on a file ending at a tool result the CLI appends a
  "Continue from where you left off" user text (merged into the result
  message) and a "No response requested." assistant turn.
- Playlist keeping one call + its result from a text+2-calls turn →
  presented: an assistant message containing JUST that call, then its
  result; the text and the other pair absent (p20-part1).
- Playlist also keeping the text entry → text + that call + its result
  presented, other pair absent (p20-part2).

So this is NOT "include every entry of a turn or lose them all":
exclusion is per-entry (step 1's cut removes exactly the excluded
entries), and the sanitizer then removes result-less tool_use blocks
from whatever remains.

### 5. Request normalization (every turn, not resume-specific)

Every unqualified "API message" in this section is an OUTGOING one.

- **Adjacent user messages MERGE** into one API user message, all content
  blocks concatenated, tool_results hoisted first (in call order in every
  capture; a playlist listing results in reverse order is unprobed — any
  within-message result order is API-legal, so this is a low-stakes
  unknown). No plain user content is
  dropped at the merge stage (positional tool-pair repair can still drop
  tool_result blocks later — next bullet). (Wire: p12 plain — three
  consecutive preserved users arrived as ONE user message carrying all
  three markers. The earlier "consecutive users get dropped" observation
  is consistent with this merge — its exact fixture was not recorded.)
  The single API message is the wire fact — and the wire is where our
  claims stop: whether the model can perceive API-message boundaries at
  all is unknown (separate vs merged adjacent user messages may present
  identically to the model), so all content-preservation statements here
  are about wire content, not model perception.
- **Same-`message.id` assistant entries reassemble into one API message**:
  a single assistant turn is written to the jsonl as multiple entries
  (roughly one per content block) sharing one API `message.id`; at
  request-build time consecutive same-id entries become one assistant API
  message — the native presented shape. The reassembly is stronger than
  simple adjacency: an intervening tool_result-bearing user entry does
  NOT split the group (wire: p18-interleaved — playlist [callA, resultA,
  callB, resultB] with same-id calls still presented as one assistant
  message with both calls followed by one user message with both
  results, identical to the native shape). Whether a PLAIN user text
  entry between same-id entries splits the group remains untested.
- **Tool-pair repair is POSITIONAL** (`_vt`): a tool_use whose immediately
  following message carries no matching tool_result gets a synthetic
  `"[Tool result missing due to internal error]"` is_error result; a
  tool_result whose call is not in the immediately preceding assistant
  message is an orphan and its block is DROPPED. (Wire: p12 results variant —
  playlist order [call1, call2, result1, result2] put an assistant message
  between call1 and result1: call1 was synthetically healed and the REAL
  result1 payload dropped, while call2/result2 — adjacent — survived intact.
  So including a result is not enough; ordering matters — but only
  across DISTINCT assistant messages. Outcome rule: a real result is
  presented iff it lands in the user API message immediately after the
  assistant API message carrying its call, judged AFTER same-id
  reassembly and user-merge. For parallel SAME-id calls that makes both
  playlist orderings safe (tested at the two-call shape): [callA, callB,
  resultA, resultB] and [callA,
  resultA, callB, resultB] each presented the exact native shape with
  zero heals (wire: p18 — the reassembly pulls the calls together and
  the merge pulls the results together before positional pairing
  judges). p12's loss happened because its calls were separate API
  messages, which reassembly cannot merge.)
  This does NOT contradict "call-without-result → call dropped" (ee0d,
  p17, p20): that is the earlier resume-sanitizer stage, which removes
  the call's BLOCK when its result is absent from the loaded context
  ENTIRELY — the model never sees the call, and `_vt` has nothing left
  to heal (p20-kill1: no synthetic result). `_vt`'s synthetic heal
  appears only when the result IS in context but ends up non-adjacent
  across distinct assistant messages: the call is presented with a
  synthetic error result and the real result is dropped (p12).
- **Cross-model thinking strip**: historical thinking blocks are removed by
  the CLI when the resume model differs from the authoring model (P6,
  haiku→sonnet, one direction tested). Likely mechanism (external API
  docs, not source-traced): a thinking block's `signature` is a
  server-issued cryptographic attestation verified when the block is
  passed back, and thinking blocks are documented as non-portable across
  models — so the strip is plausibly proactive avoidance of a
  signature-verification 400, not a CLI policy preference.

## getSessionMessages (the other tested consumer)

Same expansion, different relink — wire-proven divergences (p11a, p11b,
p15a, and p16 each ran BOTH consumers on the identical fixture; the
duplicate-uuid row rests on source reading plus p14's resume wire run):

| behavior                       | resume                                                              | getSessionMessages                                               | evidence             |
| ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------- |
| relink arity                   | last-metadata-boundary-only, must be file's last boundary           | EVERY boundary, sequentially (invalid ones skipped per-boundary) | source + p15a        |
| invalid playlist               | abort — map untouched, raw-parent walk                              | that boundary skipped, others still applied                      | p15a                 |
| cut                            | yes (pre-boundary non-playlist entries deleted, orphans reparented) | NO cut — raw parents followed                                    | p16                  |
| excluded same-message siblings | gone (cut before expansion)                                         | present (no cut; expansion recovers them)                        | p11a, p11b, P8       |
| duplicate playlist uuids       | unchecked rewrite                                                   | unchecked rewrite (no check either)                              | source; p14 (resume) |

Why this matters: what reaches assistant context on the next request is
defined by the RESUME pipeline above, full stop. gSM is only relevant as
a preview tool — and on files with excluded siblings, stacked boundaries,
or invalid playlists, its output is NOT what resume will present, so any
preview built on it lies in exactly those cases. The two agree — at the
granularity of whole incoming-`message.id` groups — on well-formed
single-boundary files (P8 cross-validation, exact uuid chain + text
blocks in order).

`importSessionToStore` (@alpha) copied entries verbatim for full-tree
reading on the tested 30-entry branched fixture — order preserved, unknown
fields un-normalized, clear error on a missing session (P5); on that
fixture it lost nothing vs parsing the jsonl directly.

## Capability / scope table

| dimension                                          | verdict                                                                                                                                                                                                                                                                                                                                                                                     | evidence          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Include/exclude message subsets                    | **YES**, for ordered subsets of existing entry uuids that survive the pipeline above. Exclusion is per-entry; survival rules for what's kept: a call needs its result somewhere in context (else block-dropped), a result must land adjacent after reassembly+merge (automatic for same-id calls; order-sensitive across distinct turns), and thinking needs a non-thinking same-id sibling | P2 c, P3, p11–p20 |
| Message order                                      | The loaded entry chain followed the list order in the tested valid sequences, incl. reverse-chronological — but stage 5 may normalize the wire shape (same-id entries regroup, tool_results hoist; p18)                                                                                                                                                                                     | P3 m3, p18        |
| Summary content & placement                        | **Ours** — free-form text; `up_to` shape puts it first, `from` shape puts it after the kept prefix                                                                                                                                                                                                                                                                                          | P1e, P2 a/b       |
| Branch selection                                   | **YES** — via a one-line leaf-marker append or a boundary listing the desired chain                                                                                                                                                                                                                                                                                                         | P2 i/j            |
| Summary-free navigation                            | **YES** — a boundary with `anchorUuid` = its own uuid and NO summary entry relinks fine, even as the last entry in the file                                                                                                                                                                                                                                                                 | P9 a              |
| Boundary-prefix navigation                         | **YES** — a second boundary may re-list an earlier boundary's summary and entries it summarized away                                                                                                                                                                                                                                                                                        | P9 b              |
| Empty context (new root)                           | **YES** — a no-summary boundary with `uuids: []` as the trailing entry resets the context to nothing                                                                                                                                                                                                                                                                                        | P10               |
| Rewind within active chain                         | `resumeSessionAt` (assistant uuid on the active chain only); on a relinked chain it targets playlist members and PRESERVES the boundary's effect, writing nothing (but see the re-persistence caveat, docs/derisk/cli-history-repersistence/FINDINGS.md)                                                                                                                                    | P2 d, P9 c        |
| Reach into a summarized region                     | **NO** via the three mechanisms tested (`resumeSessionAt`, leaf-marker, `rewindFiles`); escape hatch = new boundary re-listing the old chain                                                                                                                                                                                                                                                | P2 g/k, P4 q8     |
| System prompt, tools, MCP, permissions, filesystem | **Out of reach** — the boundary only restructures transcript messages                                                                                                                                                                                                                                                                                                                       | by design         |

## The known-working recipe

(Validated by ablation — not proven minimal; fields not individually ablated
include `trigger`, `durationMs`, `preTokens`/`postTokens`, `allUuids`,
`logicalParentUuid`, and the summary's `parentUuid`.)

Append two lines to the session jsonl, then resume with `resume: sessionId`:

1. A `type: "system", subtype: "compact_boundary"` entry whose
   `compactMetadata` contains `preservedMessages: {anchorUuid, uuids,
   allUuids}` — `uuids` = the ordered playlist; `anchorUuid` = the summary's
   uuid to put the summary first ("up_to" shape) or the boundary's own uuid
   to put the kept messages first ("from" shape). Set `allUuids === uuids`
   (a downstream live-stream pass prefers `allUuids`; a mismatch is an
   unprobed confound).
2. Optionally, a `type: "user"` summary entry with `parentUuid` = the
   boundary's uuid and any content we like. With no summary entry, set
   `anchorUuid` = the boundary's own uuid (P9 a — pure navigation).

Ablation: removing `compactMetadata` or emptying `uuids` kills the relink
(the boundary still wipes: P10); removing `isCompactSummary` +
`isVisibleInTranscriptOnly`, using the legacy `preservedSegment` encoding,
or replacing the boilerplate summary text does not. Relink happens at load
time only; on-disk entries keep their original parents.

For pure branch switching without a summary, either use a no-summary
boundary or skip the boundary entirely: append one `turn_duration`-shaped
system entry whose `parentUuid` is the target branch's leaf.

Native `logicalParentUuid` on boundaries: always the last message of the
context preceding the summarization point (p0b/p0c captures). Synthetic
boundaries set it freely; it does not affect the relink.

## Failure modes

- **A missing uuid in `uuids`** → the relink ABORTS with the map untouched
  (resume): the raw-parent walk resurrects whatever chain the leaf reaches,
  stopping at the last null-parent boundary. On a file ending at the
  summary this looks like "summary only" (P1 d); with post-boundary turns it
  resurrects the raw chain minus the playlist (p15a). Detect by asserting
  the first new write's `parentUuid` = the expected preserved tail.
- **A duplicated uuid in `uuids`** → the rewrite runs UNCHECKED (p14, wire:
  the duplicated-list chain reached the API; the summary fell off the
  walked path in that fixture's shape). This REVERSES round 1's m4 claim
  ("duplicates invalidate the relink"): m4's fixture was non-discriminating
  — an unchecked rewrite of its shape predicts the same "summary only"
  observation as an explicit skip. No duplicate check exists on either
  2.1.250 path (source), so the resulting parent structure is whatever the
  sequential rewrite leaves — don't author duplicates.
- **Tool pairing is sanitized, not rejected**, by three distinct mechanisms
  (never an API 400): call-without-result → the call's BLOCK dropped at
  resume load, siblings kept, no synthetic repair, the turn vanishing
  only when nothing presentable remains (p20, p17); result-without-call
  → the result block dropped (P3 m2, ee0d); call and result both in
  context but in non-adjacent DISTINCT outgoing API messages after
  normalization
  → the call synthetically healed and the real result dropped (p12
  results; same-id calls are immune — reassembly restores adjacency,
  p18). Round 1's m1 (call-without-result → blocks vanish) is the same
  block-level mechanism.
- An attachment uuid in the list was accepted and contributed nothing.
  Trailing `file-history-snapshot`/`queue-operation` entries after the
  summary were harmless. (P3 m6/m7)
- **Stacked boundaries: the last metadata-carrying boundary wins on resume,
  and only if it is the file's last boundary** — a trailing invalid or
  metadata-less boundary neutralizes ALL earlier valid ones (abort/wipe
  respectively; p15a, P10, source). getSessionMessages instead applies
  every valid boundary (p15a gsm).

## Integration observations for the daemon protocol

- **Flush lag is real**: the turn's assistant entry hits disk ~30–180 ms
  after the SDK `result` message (P4 q9, P7). Never trust `result` or a
  fixed delay; detect the leaf entry on disk.
- **The mutation lifecycle is proven for the daemon's one path** (P7, 12
  consecutive cycles, hard-asserted): turn `result` → leaf on disk → end
  input stream → await generator completion → append boundary+summary →
  resume. Every cycle's request contained exactly the new summary +
  preserved leaf + probe; boundaries stacked 12 deep, last always winning.
- **CLI machinery coped with an injected file**: token accounting followed
  the compacted context, and a real `/compact` on an injected session
  succeeded, summarizing only the effective context. (P4 q7; automatic
  auto-compact triggering NOT exercised.)
- **`rewindFiles` worked across plain resume and onto preserved messages,
  but not into a summarized region.** (P4 q8)
- **Session identity preserved in every successful operation**: same session
  id and file across injection, resume, an on-chain `resumeSessionAt` fork,
  and a second resume. (P1 c, P2 d)

## Summarization (Q5)

Native summarization is a normal inference call with an instruction block
appended to the last user message; scoping (`/compact` vs "from here" vs
"up to here") is purely prompt-side plus message-set selection. Captured
prompts: `captures/p0b-summarization-prompt.txt`,
`captures/p0c-summarize-req{0,1}-prompt.txt` — reusable verbatim for parity.
The CLI separately re-injects recent tool calls/results from the summarized
region as `<system-reminder>` text after a NATIVE compaction; synthetic
injection doesn't get this unless we add it.

## Version drift observed (2.1.195 → 2.1.250)

The full round-1 rerun found **zero loader-side drift** — every relink,
navigation, lifecycle, and sanitization assertion held identically. One
writer-side drift: the native `/compact` keep-segment reach shrank on the
p4 q7 fixture — 2.1.195 kept from the old summary through the probe turn
(essentially the whole small conversation); 2.1.250 kept only the final
assistant turn's entries, not even the user prompt that elicited them. One
data point per version on a tiny conversation; the selection rule is
untraced (could be a threshold change rather than a policy change).
`check-reports.mjs` carries a version-dependent expectation.

## Deviations from the approved plans

- Round 1: the unchanged-resume control on the canonical fixture was never
  run standalone; "exact replay" (P1 a) was a native-transcript replay, not
  a byte-for-byte clone+append; p1–p6 assertions were added after the fact.
- Round 2: p11a substituted a same-id text+tool_use split for the
  reviewer-specified thinking-excluded fixture, on the belief that
  normalization might strip historical thinking and mask the
  discriminator. That belief was WRONG (p2-a shows same-model thinking on
  the wire; only cross-model strips), so the substitution was
  unnecessary; the thinking-exclusion direction stayed untested until
  p19 closed it.

## Caveats

- SDK-pinned empiricism against observed bundled CLI versions and an
  `@internal` format; most behaviors verified by one run each (P7's 12
  cycles and the round-1+round-2 double coverage are the exceptions). Rerun
  the harness on SDK/CLI upgrades.
- Round-2 source attributions (function names, offsets) are 2.1.250-specific
  and will not survive a rebuild; the wire probes are the durable evidence.
- Small fixtures only; organic auto-compaction at real token scale untested.
- "No state outside the jsonl" (Phase 0b) relied on a config-dir size diff
  taken before the flush-lag issue was understood — weak evidence.
- Cross-model thinking strip tested one direction (haiku→sonnet), one run.
