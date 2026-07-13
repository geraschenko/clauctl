# Derisking: context management via synthetic `compact_boundary` injection

Goal: map the **spectrum of context-management options** available through the SDK if
we're willing to inject a synthetic `compact_boundary` entry into the session jsonl
and restart the `Query` object. Background:
[`docs/thoughts/rewind-and-tree.md`](../../thoughts/rewind-and-tree.md) — a static
analysis of the format **inferred from the CLI 2.1.195 binary, not yet validated
live**.

## Scope: what this trick can and cannot control

The boundary mechanism only restructures the _transcript messages_ fed back on
resume. Explicitly out of its reach (and out of scope here except where they
interact): system prompt, tool definitions, MCP state, permissions, model options,
filesystem state. The deliverable capability map must state this boundary so we
don't oversell "full spectrum."

Dimensions the trick plausibly controls, to be confirmed:

- which messages are included/excluded from context (arbitrary subsets?)
- message order (original order only, or arbitrary?)
- summary content and placement (we author the summary ourselves)
- branch selection (combined with `resumeSessionAt`)

## Methodology core

### Universal oracle: the outbound API request

The jsonl is the storage layer; ground truth is what the model receives. **Every**
injection experiment sends a controlled probe prompt after resume (resume alone may
not issue an inference request) and captures the API request it causes (recording shim
via `ANTHROPIC_BASE_URL` pointed at a local proxy; validate the capture path against
a plain baseline request before anything else — fall back to mitmproxy only if the
shim can't work). Fixture messages carry unique nonce tags so assertions are exact:
ordered presence of preserved/summary content, absence of summarized/abandoned
content, intact tool_use/tool_result pairing. Model recall is never primary
evidence.

### Fail closed on silent relink skip

The loader silently skips relinking on a bad `preserved_messages.uuids` list, and
the relink may be in-memory only. So no experiment may conclude "worked" from the
jsonl alone. Per-experiment asserts: (a) the outbound request matches the expected
message set; (b) after one live turn, the newly persisted message's `parentUuid`
points where the relinked chain predicts. A deliberate bad-uuid control must show
the detector firing.

### Controls

- unchanged resume (no injection) — baseline request shape
- native `/compact` — known-good boundary to compare against
- deliberately invalid `uuids` — proves skip detection works
- exact byte replay of a native boundary with fresh session — proves our
  append-and-resume path is sound independent of our synthesis

### Hygiene

- Isolated `CLAUDE_CONFIG_DIR` per case; keep an untouched copy of every
  pre-injection jsonl; no concurrent claude processes against the same file.
- Record per run: SDK package version, resolved CLI binary version, model. Abort on
  mismatch with the pinned versions in FINDINGS.
- Small models (haiku), tiny fixtures — a canonical fixture transcript
  (`U1/A1(tool)/U2/A2/...`, named uuids) defined once in the harness, so each
  experiment is "this exact transformation of that fixture" with an expected active
  chain and expected outbound `messages`.

## Phases and questions

### Phase 0 — native baseline capture

Generate the fixture, run a genuine `/compact`, capture: pre/post jsonl, any other
config-dir changes (diff the dir — native compaction may touch state outside the
jsonl), the outbound request, versions. If tmux-driving interactive claude works,
capture Esc-Esc plain-rewind / "summarize from here" / "summarize up to here" the
same way; otherwise ask Anton to generate those traces. These captures answer:

- **Q5. What is the summarization prompt?** (from the captured `/compact` and
  Esc-Esc requests; in the synthetic route we author summaries ourselves, so this is
  parity/reference, plus whether `/compact <instructions>` is a usable fallback)
- What the summary user message actually looks like on disk
  (`isCompactSummary`, `summarize_metadata`, parent links).

### Phase 1 — does injection work at all? (Q1)

Sequence, each step fail-closed per the oracle rules:

1. Exact replay: clone the complete pre-compaction transcript + config dir, append
   the captured native boundary+summary entries byte-for-byte (preserved uuids then
   reference real entries in the clone); resume; assert.
2. Synthetic equivalent: same shape, our uuids, our summary text; resume; assert.
3. Durability: after a successful resume, run a turn, close, **resume a second
   time**, assert again — first-resume success may not survive the writes it causes.
4. Bad-uuid control (skip detector).
5. Field ablation only as needed to answer: which boundary/summary fields are
   load-bearing vs. cosmetic?

### Phase 2 — map the valid option space (Q2a, Q4)

- Valid contiguous `up_to` and `from` reproductions (per the static analysis's
  producer orderings); assert resulting chains and requests.
- Valid non-contiguous preserved subsets that keep tool pairs intact.
- Branch navigation: `resume` + `resumeSessionAt` onto another branch — expectation:
  plain rewind, **no** summarization (unlike pi, summarize-set choice is ours).
  Probe: uuid on an abandoned branch; uuid inside a boundary-unreachable segment;
  nonexistent uuid.
- Combined: navigate to a branch _and_ inject a summary of the abandoned tail
  (the pi-style "summarize from here" emulation end-to-end).

### Phase 3 — adversarial/malformed cases (Q2b)

Only after Phase 2 establishes the valid envelope:

- preserved sets breaking tool_use/tool_result pairing; dropped user message with
  kept assistant reply; reordered subsets. For each, distinguish **loader
  acceptance** vs **API acceptance** (capture the outbound request even when the API
  400s) vs **semantically usable context**.
- duplicate uuids (if preserved entries are re-appended rather than referenced)
- stacked boundaries (two synthetic compactions; loader order sensitivity)
- trailing non-message entries after the boundary (snapshots, progress records)
- preserved uuids pointing at sidechain/subagent or snapshot entries (exploratory —
  subagents may live in separate files with separate loading rules)

### Phase 4 — integration edges (Q7, Q8, Q9)

- **Q7 CLI machinery:** does a real `/compact` cope with a file containing our
  boundary? Auto-compact threshold accounting after injection — oracle: the
  context-usage numbers the SDK reports, not waiting for organic auto-compaction.
- **Q8 file state:** with `enableFileCheckpointing`, does `rewindFiles` to a message
  behind the boundary still work?
- **Q9 lifecycle:** what must be true before appending — input closed vs. generator
  drained vs. child process exited? Does the CLI hold/rewrite the file on shutdown
  (clobbering appends)? Findings feed the daemon teardown→append→respawn protocol;
  crash-consistency engineering (fsync, atomic replace, rollback) is shipping-design
  work, out of scope here beyond noting what the experiments reveal.

### Supporting workstream (off critical path) — Q3 full-tree read

`importSessionToStore` vs. reading the jsonl directly. Decision criteria for which
clauctl uses: completeness (are unknown fields passed through un-normalized?),
version sensitivity, failure observability. Also: do store entries preserve
`preserved_messages` on boundary lines verbatim?

## Test matrix (Phase 1–3 summary)

| case                        | loader expectation | outbound request expectation       | next-write parent |
| --------------------------- | ------------------ | ---------------------------------- | ----------------- |
| unchanged resume (control)  | n/a                | full original chain                | last leaf         |
| native `/compact` (control) | relink             | summary + suffix                   | per native        |
| exact replay of native      | relink             | = native case                      | per relink        |
| synthetic valid `up_to`     | relink             | summary + kept suffix              | leaf of suffix    |
| synthetic valid `from`      | relink             | kept prefix + tail-summary         | tail-summary      |
| valid non-contiguous subset | relink             | exactly the subset                 | subset leaf       |
| bad uuid in list            | **skip**           | fixture-specific unrelinked chain¹ | per raw links     |
| broken tool pairing         | ?                  | capture regardless of 400          | ?                 |
| duplicate uuids             | ?                  | ?                                  | ?                 |
| stacked boundaries          | ?                  | ?                                  | ?                 |
| second resume after turn    | stable             | stable                             | consistent        |

¹ Not assumed to be "full original chain": with relink skipped, the appended
boundary/summary entries may themselves become the active leaf. Derive the expected
unrelinked chain from the fixture's raw parent links; the control passes when the
harness distinguishes that outcome from a successful relink.

## Execution order

capture-path validation → Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4; Q3
whenever convenient. Findings land in `FINDINGS.md` (conclusions + capability/scope
table), chronology in `WORK-LOG.md`. The harness stays rerunnable so CLI/SDK
upgrades can revalidate the whole matrix (the format is `@internal`; expect drift).
