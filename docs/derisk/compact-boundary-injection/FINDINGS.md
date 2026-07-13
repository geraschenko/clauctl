# Findings: context management via synthetic `compact_boundary` injection

Run against SDK 0.3.195 on 2026-07-13, model haiku-4.5 (bundled CLI version
2.1.195 inferred from the `version` field the CLI stamps on session entries;
`assertVersions()` pins only the SDK package — per-run CLI/model assertion is
future harness work). The jsonl format is `@internal`; the harness
(`p0*`–`p5*` scripts) is rerunnable, but note it currently *records* results
rather than hard-asserting them — turning each non-exploratory case into a
pass/fail assertion is required before using it as an upgrade-regression
harness. Evidence for context-relink claims: outbound API request capture
(recording shim) + the `parentUuid` of the first post-resume write — never the
jsonl or model recall alone. Chronology and per-experiment detail: [WORK-LOG.md](WORK-LOG.md).
Reviewer audit (2026-07-13): core technique justified; wording below
incorporates the demanded weakenings.

## Headline

**The trick works.** Appending a synthetic `compact_boundary` + our own summary
message to a session jsonl and resuming via the SDK controls which transcript
messages the model sees, in what order, with what summary text — verified
against captured API requests, surviving a further turn, a second resume, and a
subsequent native `/compact` (each verified once).

## Capability / scope table

| dimension | verdict | evidence |
| --- | --- | --- |
| Include/exclude message subsets | **YES**, for ordered subsets of existing, unique message uuids that form an API-valid sequence after CLI normalization (see failure modes) | P2 c, P3 |
| Message order | Context followed the list order in the tested valid sequences, incl. reverse-chronological | P3 m3 |
| Summary content & placement | **Ours** — free-form text; `up_to` shape puts it first, `from` shape puts it after the kept prefix | P1e, P2 a/b |
| Branch selection | **YES** — via a one-line leaf-marker append or a boundary listing the desired chain (both internal-format techniques; leaf-selection behavior could change across CLI versions) | P2 i/j |
| Rewind within active chain | `resumeSessionAt` (assistant uuid on the active chain only) | P2 d |
| Reach into a summarized region | **NO** via the three mechanisms tested (`resumeSessionAt`, leaf-marker, `rewindFiles`); escape hatch = new boundary re-listing the old chain | P2 g/k, P4 q8 |
| System prompt, tools, MCP, permissions, filesystem | **Out of reach** — the boundary only restructures transcript messages | by design |

## The known-working recipe

(A reduced recipe validated by ablation — not proven minimal; fields not
individually ablated include `trigger`, `durationMs`, `preTokens`/`postTokens`,
`allUuids`, `logicalParentUuid`, and the summary's `parentUuid`.)

Append two lines to the session jsonl, then resume with `resume: sessionId`:

1. A `type: "system", subtype: "compact_boundary"` entry whose `compactMetadata`
   contains `preservedMessages: {anchorUuid, uuids, allUuids}` — `uuids` = the
   ordered list of message uuids to keep; `anchorUuid` = the summary's uuid to
   put the summary first ("up_to" shape) or the boundary's own uuid to put the
   kept messages first ("from" shape).
2. A `type: "user"` summary message with `parentUuid` = the boundary's uuid and
   any content we like.

Ablation results: removing `compactMetadata` or emptying `uuids` kills the
relink; removing `isCompactSummary` + `isVisibleInTranscriptOnly` (jointly),
using the legacy `preservedSegment` encoding instead of `preservedMessages`, or
replacing the boilerplate summary text does not. Relink happens at load time
only; on-disk entries keep their original parents, so the full tree is never
destroyed.

For pure branch switching without a summary, skip the boundary entirely: append
one `turn_duration`-shaped system entry whose `parentUuid` is the target
branch's leaf — the loader's natural-leaf walk then activates that branch
(native files also parent user messages onto `turn_duration` entries).

## Failure modes (fail-closed-detectable in the tested cases)

- **A missing uuid in `uuids`, or a duplicated one** → the relink was silently
  skipped (one shape of each tested); context = summary only (+ a
  CLI-synthesized assistant "No response requested."). Detect by asserting the
  first new write's `parentUuid` = the expected preserved tail. (P1 d, P3 m4)
- **Broken tool pairing is sanitized, not rejected** in the two patterns tested:
  an orphan `tool_use` or `tool_result` (and its companion thinking block)
  silently vanished from the outbound request; no API 400. Generalization to
  other positions/parallel tool calls is untested — don't rely on an error to
  catch a bad subset. (P3 m1/m2)
- An attachment uuid in the list was accepted and contributed nothing. Trailing
  `file-history-snapshot`/`queue-operation` entries after the summary were
  harmless. (P3 m6/m7)
- **Stacked boundaries: the last one won** in the tested stacks (two synthetic
  up_to-style; synthetic followed by native `/compact`). Other combinations
  (from+up_to, malformed members) untested. (P3 m5, P4 q7)

## Integration observations for the daemon protocol

- **Flush lag is real**: the turn's assistant entry hit disk ~180 ms *after*
  the SDK `result` message (one measured run; the same lag produced truncated
  fixtures in Phase 1). Poll for the expected leaf entry rather than trusting
  `result` or a fixed delay. In that run the file then stayed unchanged for a
  2 s observation window, and a line appended before `q.close()` survived close
  with only a trailing `last-prompt` entry after it. **This is one run's
  observation, not a proven lifecycle boundary** — close semantics (await vs
  kill, child-exit confirmation) and append-then-immediate-resume were not
  systematically tested. (P4 q9)
- **CLI machinery coped with an injected file**: reported usage matched the
  small compacted context (suggesting auto-compact accounting is compatible —
  automatic triggering itself was NOT exercised), and a real `/compact` on an
  injected session succeeded, summarizing only the effective context. (P4 q7)
- **`rewindFiles` (file checkpointing) worked across plain resume and onto
  preserved messages, but not into a summarized region.** (P4 q8)
- **Session identity was preserved in every successful operation**: same
  session id and file across injection, resume, an on-chain `resumeSessionAt`
  fork, and a second resume (failed `resumeSessionAt` calls abort before
  initializing a session). In-file branching only. (P1 c, P2 d)

## Summarization (Q5)

Native summarization is a normal inference call with an instruction block
appended to the last user message; scoping (`/compact` full-window vs
"summarize from here" vs "up to here") is purely prompt-side plus message-set
selection — no API parameter. Captured prompts:
`captures/p0b-summarization-prompt.txt`, `captures/p0c-summarize-req{0,1}-prompt.txt`.
In the synthetic route we author the summary ourselves, so we can reuse these
prompts verbatim for parity or write our own. Note the CLI separately re-injects
recent tool calls/results from the summarized region as `<system-reminder>` text
after a NATIVE compaction; synthetic injection doesn't get this unless we add it.

## Reading the tree (Q3)

For the tested 30-entry branched fixture, `importSessionToStore` (@alpha) copied
entries verbatim — order preserved, unknown fields and `compactMetadata`
un-normalized, clear error for a missing session — i.e. no SDK-added entries or
normalization were observed, so it loses nothing vs parsing the jsonl directly.
Subagent import (`includeSubagents`) is an API capability we did not exercise.
Choose between the routes on API-stability grounds.

## Deviations from the approved plan

- The **unchanged-resume control** on the canonical fixture was never run as
  its own case (P2 d and the Q8 plain-resume control exercise resume, but not
  as the canonical baseline capture).
- **"Exact replay" (P1 a)** installed the complete native post-compact jsonl
  into a fresh config dir — a "native transcript replay" — rather than cloning
  the pre-compaction config dir and appending the captured entries byte-for-byte.
- Harness assertions: reports are recorded and were interpreted manually;
  scripted pass/fail is still to be added (see header).

## Caveats

- Everything here is SDK-pinned empiricism against an observed bundled CLI
  version and an `@internal` format,
  and most behaviors were verified by a single run of each case; rerun the
  harness on SDK/CLI upgrades.
- Preserved thinking blocks carry signatures; we did not test cross-model
  restore of thinking blocks (all experiments used haiku end-to-end).
- Small fixtures only; organic auto-compaction at real token scale untested.
- "No state outside the jsonl" (Phase 0b) relied on a config-dir diff taken
  before the flush-lag issue was understood, and compared file sizes only —
  treat as weak evidence.
