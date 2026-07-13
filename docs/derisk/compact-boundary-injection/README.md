# Derisking: context management via synthetic `compact_boundary` injection

Goal: map the **full spectrum of context-management options** available through the
SDK if we're willing to inject a synthetic `compact_boundary` entry into the session
jsonl and restart the `Query` object. Background and prior static analysis:
[`docs/thoughts/rewind-and-tree.md`](../../thoughts/rewind-and-tree.md) (format
verified by reading the CLI 2.1.195 binary; **not yet validated with a live resume**).

## Questions

### Q1. Does injection work at all?

Append a `compact_boundary` + summary message to the jsonl (query closed), then
`query({resume: sessionId})`. Does the loader relink as documented and does the new
query run on the compacted context? This gates everything else.

- What is the minimal set of fields the boundary and summary entries need? (Exact
  shape of the CLI's own summary message: `isCompactSummary`, `summarize_metadata`,
  `parentUuid` — which are load-bearing vs. cosmetic/UI-only?)
- Failure mode observability: the relink is documented as **silently skipped** on a
  bad `uuids` list. How do we detect from the outside that injection didn't take?

### Q2. How do the summarization variants behave; what do unusual `preserved_messages` sets do?

- Reproduce `up_to` and `from` orderings and confirm the resulting chains.
- Non-contiguous preserved sets: preserved lists that break `tool_use`/`tool_result`
  pairing, drop a user message but keep the assistant reply, interleave out of
  original order. Does the CLI repair the sequence, does the API reject it (400
  invalid `messages`), or does it silently work?
- Preserved uuids pointing at sidechain/subagent entries, `file-history-snapshot`
  entries, or entries already behind an earlier boundary.
- Multiple boundaries in one file (stacked synthetic compactions).

### Q3. Can we read the full tree through the SDK?

`importSessionToStore` → `store.load` reportedly returns every raw line (verified
once, 2026-07-08). Confirm the entries carry everything needed for tree navigation:
`parentUuid`, `logicalParentUuid`, `isCompactSummary`, sidechain markers, boundary
`preserved_messages`. Compare against reading the jsonl directly and decide which
route clauctl uses.

### Q4. Branch-to-branch navigation semantics

`resume` + `resumeSessionAt` on a different branch: what does the CLI actually do?
Expectation from static analysis: no summarization at all — plain rewind keeps the
prefix and abandons the tail. If that holds, "which messages get summarized" is
entirely **our** choice in the synthetic route (unlike pi, where the engine
summarizes back to the common ancestor). Verify:

- `resumeSessionAt` a uuid on an abandoned branch; a uuid inside a summarized
  (boundary-unreachable) segment; a uuid that doesn't exist.
- What interactive claude's Esc-Esc writes for the pure-rewind (no summarize) option,
  for parity reference.

### Q5. What is the summarization prompt, and can we control it?

Capture the `/compact` and Esc-Esc summarize requests with mitmproxy. Note: in the
synthetic route **we** generate the summary with our own API call, so the CLI's
prompt matters for parity, not capability. But capture it anyway — it tells us what
the CLI considers a good summary shape, and whether `/compact <instructions>` is a
usable fallback.

### Q6. What context does the model actually receive after resume?

The jsonl relinking is only the storage layer. Ground truth is the outgoing API
request (mitmproxy or `ANTHROPIC_BASE_URL` shim): are summarized messages truly
absent, is the summary presented as claimed, do token counts / context-low warnings
reflect the compacted window?

### Q7. Interaction with the CLI's own context machinery

- Does auto-compact still trigger correctly after a synthetic boundary (threshold
  accounting reset)?
- Microcompaction interplay, if enabled.
- Does a subsequent real `/compact` cope with a file containing our boundary?

### Q8. File-state features across the boundary

With `enableFileCheckpointing: true`: do `file-history-snapshot` entries in the
summarized segment survive, and does `rewindFiles` to a message behind the boundary
still work?

### Q9. Write-safety and lifecycle

Is "query closed" sufficient, or must the CLI process be fully exited before we
append (does the CLI hold the file open / rewrite it on shutdown, clobbering our
lines)? What does the daemon teardown → append → respawn sequence need to guarantee?

### Q10. Fragility management

The format is `@internal` and verified against CLI 2.1.195 only. Build the
experiments as a rerunnable harness (isolated `CLAUDE_CONFIG_DIR`, scripted asserts)
so we can revalidate on every CLI/SDK upgrade and detect silent relink skips before
they ship.

## Methodology

Same setup as the sibling experiments (`../resume-persistence/`): `.mjs` scripts
against the bundled SDK, isolated `CLAUDE_CONFIG_DIR`, real authenticated sessions.
mitmproxy for Q5/Q6. Findings land in `FINDINGS.md`, chronology in `WORK-LOG.md`.

Suggested order: Q1 → Q6 (prove the injected context is real) → Q2/Q4 (map the
option space) → Q3 (tree read) → Q7/Q8/Q9 (integration edges) → Q5 (parity) → Q10
(harden).
