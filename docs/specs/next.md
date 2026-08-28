# Post-derisk work queue: set-context and TUI changes

## SPEC DISCUSSION STATE (2026-08-31, derisk phase for the replacing spec)

Decisions agreed with Anton so far:

- `loadedContext` changes meaning for ALL consumers: "what the assistant
  will see on the next turn, as a list of entries" — stages 1–4 at entry
  granularity (relink+cut, walk, API-message expansion, sanitization:
  drop result-less tool_use entries and thinking-only turns). Entries ≈
  one block each, so stage 4's block-level drops are entry-level here.
- Return type: KEEP `TreeNodeRef[]` (Anton pushed back on a compound
  type; refs are needed — set-context mid-chain filterTail leaf,
  tree-selector rewindTo, snapshot.leaf viaBoundary). CONTINGENT on the
  splice-point check below (`.at(-1)`-as-leaf must stay valid).
- Heal (set-context uuids form): for each listed tool call add its
  result entry from the file (adjacent), for each listed result add its
  call. NO same-id sibling closure beyond that (p20-part1: partial
  selection is legal; caller's choice). Report what healing added in
  SetContextResult.
- REJECT (fail-closed, all with messages explaining why + "if you
  wanted that, use a shorter playlist"): duplicates in the playlist
  (p14: the sequential relink clobbers the repeat entry's parent —
  everything before the last duplicate occurrence is functionally
  deleted + a parent cycle; can never mean "message twice" since the
  map is uuid-keyed); a call whose result exists NOWHERE in the file
  (killed-turn shape; loader block-drops it anyway); a result whose
  call is nowhere in the file; a playlist including thinking entries of
  a group with no non-thinking sibling of that group (loader drops the
  turn whole — silent acceptance would confuse).
- Expansion (stage 3) implemented ONCE, shared: used by loadedContext
  AND by toDisplayTree — Anton's proposal: linearize parallel-call
  branches into the display SPINE in toDisplayTree, so pathToLeaf
  (maybe renamed historyOfLeaf, possibly returning entries — optional,
  deferred) shows both calls; fixes TUI history after detach/reattach
  (live rendering is already correct) AND tree views. Goal fixture:
  scripts/tui-parity/out/sessions/readonly-fold.jsonl shows BOTH calls.
- Stale comments to fix: loader.ts:81 TDC (duplicates rationale —
  resolved: keep rejection, explain clobbering), set-context.ts ~232
  duplicate-rejection message ("loader silently skips the whole
  relink" is FALSE per p14 — rewrite unchecked).

Open questions / to resolve before writing the spec:

- SPLICE-POINT CHECK (no new probes — read p13/p18/p11b captured
  request message order): where does expansion splice recovered
  entries relative to the on-path result / walk tip? Determines
  whether a spliced entry can land AFTER the walk tip (breaking
  `.at(-1)` leaf in kill shapes like [..callA,callB,resultB,resultA]
  EOF). If splice is always before the on-path tail, keep TreeNodeRef[]
  with no leaf machinery; else leaf must be exposed separately.
- CONTINUATION-PARENT RULE disagreement: evidence (readonly-fold i28
  resultA written last, i29 continuation parents on it = FIRST call's
  result; p18 real sessions parented on last-written too) says the
  continuation parents on the file tip at write time = last-WRITTEN
  result (completion order); results themselves parent on their OWN
  calls (fixed at pairing). Anton believes it's determined at
  call-write time. Resolve; FINDINGS overview stages 2/3 were already
  reworded to "last-written" and may need another pass after
  resolution.
- Display ordering of linearized parallel groups (calls in chain
  order, then results — in which order?); must match the shared
  expansion function's order (single source of truth).
- Whether seed.ts leaf findLast and get-entries leaf need an
  expansion-aware guard (moot if splice-point check passes).
- Type design for the shared expansion function + heal function
  signatures — must be agreed before writing the spec.

Facts worth not re-deriving: background bash tool_use gets an
IMMEDIATE tool_result (task id); completion arrives later as a
separate user message — so result-less calls occur only in
killed/truncated turns. Same-model resume DOES forward prior thinking
(p19: 5 signed blocks on wire); cross-model strips all (P6),
mechanism: server-issued per-model signatures fail verification
cross-model (documented); deeper rationale unofficial.

Collected during the loader round-2 derisking
(docs/derisk/compact-boundary-injection/README-20260828.md). Starting
point for specs now that the investigation is closed: the E3 probes
p11a–p17 ran nine wire calls — all eight prediction-bearing cases matched
their source-predicted models, and the exploratory p12-results case
revealed positional tool-pair repair; the TDC-round probes p18–p20
resolved parallel same-id ordering, thinking exclusion, and block-level
unresolved-call drops (see FINDINGS.md).

## set-context: closure over the caller's playlist

Goals (Anton, 2026-08-28/29):

- (a) **Predict the effective context.** Given preserved uuids, know what
  the assistant will actually see after the boundary — before writing it.
- (b) **Preserve caller intent.** The caller's chosen messages must
  actually land in context, closing over what the loader/normalizer would
  otherwise drop.

Closure rules (directives, refined by the E2a/E2b source findings):

- **Tool pairing**: a playlist including either half of a tool exchange
  silently gets the matching call/result included too. Presented-context
  outcomes (all wire-confirmed): result-without-call → the orphaned
  result is dropped, the assistant never sees the output (ee0d, P3 m2);
  call-without-result → the call's block is dropped, the assistant sees
  no trace of the call (p20; the rest of its message survives); call and
  result both present but ending up in non-adjacent DISTINCT API
  messages → the call presented with a synthetic error result and the
  REAL result dropped (p12 results, triaged: order alone caused the
  loss). **Parallel same-id calls need no special ordering**: native
  parallel calls BRANCH in the file (callB a child of callA, each result
  a child of its call), a relinked playlist is necessarily linear, but
  the presented context comes out identical either way — [callA, callB,
  resultA, resultB] and [callA, resultA, callB, resultB] both presented
  exactly the native shape (one assistant API message with both calls,
  one user API message with both results), zero synthetic heals (p18,
  with a native-shaped plain-resume oracle). Same-id reassembly restores
  call adjacency across intervening tool_result users before positional
  pairing judges; only calls in DISTINCT assistant messages (p12's
  shape) are order-sensitive.
- **API-message closure**: including any entry pulls in all sibling
  entries sharing its API `message.id` (thinking/text bundled with a
  tool_use). This is intent-preservation POLICY, not a loader
  requirement — the loader tolerates per-entry exclusion fine (p20-part1
  presented a kept call+result without their text sibling); the point is
  that whatever the caller excludes is silently absent. Rationale: the
  resume relink's cut deletes playlist-excluded
  entries BEFORE the sibling-expansion pass runs, so a split API message
  is unrecoverable — the excluded sibling is absent from presented
  context (wire: p11a text, p11b parallel-tool, p19 thinking; same-model
  resume forwards signed thinking, so this WAS discriminable). Extra
  closure constraint from p19: a message reduced to ONLY thinking is
  dropped whole, so including a thinking entry MUST pull in its
  non-thinking siblings or contribute nothing.
- **Consecutive user messages**: NOT dropped by the loader — merged into
  one API user message with all content concatenated (`$oe`). So no
  synthetic "No response requested" interleaves are needed for content
  preservation; consider them only if the caller needs the messages to
  stay SEPARATE API messages (whether the model can perceive API-message
  boundaries at all is unknown — merged and separate may present
  identically). p12 confirms the merge on the wire.
- Surface what closure added (don't silently diverge from the caller's
  list without saying so in the result).

## TUI after set-context (observed 2026-08-29, /tmp/claude-tui-too-many-oks{,2})

Current behavior: after an external set-context, the TUI keeps showing the
stale pre-surgery messages; a "context compacted" marker appears only
after detach/reattach.

- (a) Show a **"context changed" marker live** when set-context rewrites
  the context out from under an attached TUI.
- (b) **Render the playlist messages** after the boundary. Normally the
  TUI not rendering the playlist matches the user's mental model, but
  after message surgery the user must SEE that the resulting context is
  what they intended. Single source of truth: render the effective
  context via the same loader code the estimate uses — no UI-specific
  reimplementation.

## Probes as an SDK-upgrade regression suite

Rewrite the derisk probes to run experiments and assert our expectations
of the results, as a standard step of every SDK version bump. (The round-2
rerun already caught one flaky fixture — p4 q8's relative-path prompt —
worth hardening as part of this.)

## loadedContext / consumers

- Decide whether `loadedContext` grows the API-message expansion, and
  which consumers (TUI replay, set-context verification, get-messages
  synthesize, seed) want which granularity — a third concept "effective
  API context" deepening loader.ts's interface, not appearing at call
  sites.
- Scope every claim by consumer: resume (last-boundary relink + cut) and
  getSessionMessages (all-boundaries relink, no cut) demonstrably differ.

## Blog post

Correct geraschenko.com claude-context: the loader is not a pure parent
walk (API-message expansion), the relink details (last-boundary-only with
metadata, cut, abort-untouched on invalid playlists), and the
request-time merge behavior.
