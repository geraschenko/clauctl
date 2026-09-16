# Phase 5: docs

> Work log for phase 5 of docs/specs/session-tracker.md (IMPLEMENTATION
> IDEAS, "Docs"). Status: **all edits made; the four new/rewritten docs
> (socket-interface, stream-merging, session-views, claude-agent-sdk) are in
> review iterations with Anton**; the "sdk socket" → protocol rename is
> applied (2026-09-15).

Unlike phases 1–4 the unit of work is a document, not a code step, so
this log is a file → verdict → action table, the agreed outline of the
new doc, and the decisions; there is no step plan.

## Scope

The spec's phase 5: `docs/agent-events.md`, session-views.md
cross-reference, status notes on the superseded specs, retire the
AGENTS.md one-pass bullet, and bring docs/claude-agent-sdk.md up to
date on how the unified subscription is produced. Plus everything the
sweep below found.

## Sweep (2026-09-13)

Verified against `src/`: `AgentObserver`, `seed.ts`/`seedFromEntries`,
`slimEntry`, `consumedUuids`, `LoadedContext` (the type; the
`loadedContext` oracle stays), `isFinalAssistantEntry`,
`SessionEntryClient`, `readEntriesAfterStreamFlush`, `get-tree` have no
hits.

### Living docs (read as current)

| File                                 | Stale                                                                                                                                                                                           | Action                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| docs/claude-agent-sdk.md             | L90–116: `AgentObserver` and `src/core/agent-observer.ts`; the socket event list omits the file leg (`sessionEntry`, `sessionFileChanged`, `scanComplete`, `sessionAppended`, `trackerAnomaly`) | Keep the CLI/process facts; move L90–116 out (structure below)                  |
| docs/architecture.md                 | L88–94 same event list; L193–198 "tail, the TUI's history replay, and get-entries all consume the session file" (TUI never reads files; daemon serves from the resident tracker)                | Fix both passages; attach section mentions `SessionModel`; point at protocol.md |
| docs/overview.md                     | L204–207 calls daemon-architecture.md "the current state-tracking architecture … tty service"; document map lacks session-tracker, stream-merge, session-views, socket-interface                | Update the document map                                                         |
| docs/session-views.md                | Accurate; silent on how each view is kept (rolling builders, daemon vs TUI ownership)                                                                                                           | "Owned by" lines gain pointers into protocol.md                                 |
| docs/user-message-tracking.md        | Accurate                                                                                                                                                                                        | Cross-link only                                                                 |
| docs/thoughts/get-entries-caching.md | Fully implemented, reads as a proposal; cited as "next" from get-context.md ×5, context-tree.md ×3                                                                                              | Move to docs/thoughts/old/; retarget the citations at session-tracker.md        |
| docs/thoughts/transcript-order.md    | Current                                                                                                                                                                                         | Cross-link from protocol.md                                                     |
| AGENTS.md L21 (one-pass bullet)      | Introduced against agents re-reading the whole file per function; the rolling builders make that shape unnatural now                                                                            | Remove (Anton, 2026-09-13)                                                      |
| README.md                            | Accurate                                                                                                                                                                                        | none                                                                            |

### Specs

Every spec except session-tracker.md is complete (Anton, 2026-09-13),
whatever its header says. Action: give each a header `> Status:
implemented` line — dated where the file records a date, with
"superseded by …" where a later spec replaced it — and leave the bodies
as the historical record.

Headerless today: adopt-shared-stream-engine, attach-direct-tui,
attach (superseded by attach-direct-tui), daemon-architecture,
flat-tree-sync-handoff, loaded-context, prompt-parity,
repersisted-duplicates-handoff, sdk-expectation-tests,
session-snapshot-and-forest, session-tree-and-set-context, tail-parity,
tui-fullscreen, tui-history, tui-rendering-parity, wait-and-tail-until.

Header says not-yet-done: context-tree ("implementing"),
convenience-commands and lifecycle-and-sdk-commands ("scaffold"),
phase-1-lifecycle-core and phase-2-sdk-sock-protocol ("ready to
implement"), session-tree and tui-tree ("approved for implementation"),
streaming-conversions-and-formatters ("awaiting implementation"),
tui-input ("draft"), tui-parity ("not yet implemented"), tui
("phase-3 spec"), canonical-session-entry-stream / format-tree /
get-context ("awaiting review"). All implemented; the headers were
never updated.

Bodies that describe the retired design (headers only, no rewrite):
daemon-architecture (pre-tracker AgentState, tty service),
prompt-parity and tail-parity (`AgentObserver`, `SessionEntryClient`),
loaded-context L245–254 (per-request rebuild), and the `seed.ts` /
`seedFromEntries` / `isFinalAssistantEntry` / no-write-rewind mentions
in canonical-session-entry-stream, session-snapshot-and-forest,
tui-tree, session-tree-and-set-context, session-tree, get-context,
context-tree, human-prompt, boundary-substructure, format-tree. Their
status line names session-tracker.md as the successor.

### Accurate anchors

stream-merge.md (its Problem section is the cleanest statement of "one
process, several ordered lossy views"), user-message-tracking.md,
session-views.md, context-tree.md body, tree-presentation.md,
thoughts/transcript-order.md.

## Doc structure (agreed 2026-09-14, review round 5ee9844)

Problems and their solutions live together: we only describe an SDK gap
because we closed it. So the phase produces one interface doc and deep
dives it links from an implementation section, not a facts doc paired
with a mechanisms doc.

### `docs/protocol.md` (new) — the interface socket provides

The main thrust is interface and philosophy; implementation is one
section of links.

1. **What socket is** — the observation and control interface we wish
   the SDK had: hello-first, requests with ids, pushed events. Brief;
   the protocol details stay in architecture.md and protocol.ts.
2. **Philosophy** — observability by snapshot-on-subscribe plus a folded
   event stream: a subscriber maintains `AgentState` from the
   subscription alone; one fold (`nextAgentState`) runs in the daemon
   and in every client; live = replay (the same fold, whether the
   events arrive live or from the file); no lag (an event is rebroadcast
   the moment it arrives on any stream).
3. **The event stream** — `sdkMessage` (the query stream, including the
   set-context appends: serialized with the query — Query closed,
   entries appended, Query restarted — and on the query side of the
   merge because their file twins are expected, exactly as a native
   compaction's are), `sessionEntry` (the file stream), and daemon
   bookkeeping (everything else), each bookkeeping event with the SDK
   gap it closes: `userMessageQueued`/`userMessageDequeued` ← no prompt
   echo, no visible queue ops (user-message-tracking.md is the in-depth
   account of how they are generated); `contextChanged` ← no
   set-context; `sessionFileChanged` ← rollover in place;
   `scanComplete`/`sessionAppended` ← the file leg's catch-up;
   `trackerAnomaly`; `shutdown`.
4. **`AgentState`** — what it holds; the activity and prompt-visibility
   invariants; what the merge does and does not hide from a client
   (settled, pending, `whenSettled`).
5. **Requests** — subscribe, prompt/interrupt, get-entries (`uuids` /
   `full`, `--since` as the catch-up primitive), get-context,
   set-context, passthrough.
6. **Building on it** — the interface gives a client (the TUI included)
   everything needed to build the three views of session-views.md; one
   paragraph and a link, no tree discussion here.
7. **Implementation** — links: stream-merging.md, user-message-tracking.md,
   session-views.md, claude-agent-sdk.md, the code map.

### `docs/stream-merging.md` (new) — deep dive: merging the query and file streams

The one problem stream-merge.ts and the classification table exist for.
Contents: the two views of one process and why neither suffices; the
classification table (moved here from session-tracker.md's spec text,
which then cites it); `MergeState` (the general-purpose library)
pending/resolved/settled; anomalies as data; leaf is file-side; startup
scan vs live, the seed, `scanComplete`; the switch on rollover; the
daemon's `SessionTracker` (structural residency, byte-range index) vs
the TUI's full entries. To be updated when
docs/thoughts/fold-resolved-events.md lands: the clauctl-specific part
extracted from `SessionModel` joins this doc beside the library.

### Existing docs

- session-views.md gains the in-depth tree discussion: how each view is
  kept (rolling builders pushed per entry; daemon `SessionTracker` vs
  TUI `SessionModel` ownership; reset on `sessionFileChanged`;
  `get-entries --since` catch-up), and the `getSessionMessages`
  deficiencies (steered prompts absent; not the assistant's context)
  next to the context-tree discussion, as what `ContextTree` answers.
- claude-agent-sdk.md keeps the CLI/process facts whose consequence is
  the architecture itself (binary is the authority, streaming-input
  mode, one connection, session ids roll over, transcripts are files);
  the stream-gap facts and the AgentObserver/event-list paragraphs
  (L90–116) move into protocol.md and stream-merging.md. Each
  fact gets a "tested by" pointer where tests/sdk/ has one (comparison
  below).
- user-message-tracking.md stays a separate deep dive; its `get-messages`
  references are updated to get-context (docs/specs/get-context.md).
- architecture.md: the socket section defers to protocol.md; the
  history paragraph and attach section fixed (sweep table).
- overview.md document map gains protocol.md, stream-merging.md,
  session-views.md, session-tracker.md.

### tests/sdk/ vs claude-agent-sdk.md

Relied-on facts with a test but no doc mention:

- `permissionMode` unset ⇒ the SDK passes `--permission-mode default`,
  overriding every settings file (tests/sdk/permission-mode.test.ts;
  daemon.ts forwards the settings-cascade mode explicitly). Belongs in
  claude-agent-sdk.md.
- Stream classification (tests/sdk/stream-classification.test.ts):
  shared classes carry one uuid on both streams in the same relative
  order; query-only classes never share; a query `assistant` for a
  local command shares its uuid with the file's `system/local_command`;
  hooks never reach the query stream; a stamped `SDKUserMessage.uuid`
  becomes the file's user entry uuid and a steer surfaces only as a
  `queued_command` attachment. Belongs in stream-merging.md's table.
- The compact-boundary loading model
  (tests/sdk/compact-boundary-suite.test.ts →
  docs/derisk/compact-boundary-injection/FINDINGS.md). Already cited.

Documented facts with no test (derisk experiments only): session ids
roll over in place (clear-vs-session-experiment), one programmatic
connection, repersisted duplicates (cli-history-repersistence). Noted
in the doc as untested; writing tests is not this phase's work.

### Blog posts

Anton's blog covers set-context in depth
(https://geraschenko.com/blog/claude-context, linked from
architecture.md) and may cover stream merging and the SDK workarounds
later. The deep dives stay the repo's own account; a post is linked
where one exists.

## Decisions

- 2026-09-13 (Anton): "action stream" → **daemon bookkeeping**; the
  set-context appends belong to the query stream (rationale in the
  outline, §3).
- 2026-09-14 (Anton): one interface doc, not a facts/mechanisms pair;
  deep dives for the involved parts. The earlier
  `docs/agent-events.md` name is dropped for `docs/protocol.md`
  (it is not an SDK).
- 2026-09-13 (Anton): remove the AGENTS.md one-pass bullet.
- 2026-09-13 (Anton): get-entries-caching.md moves to docs/thoughts/old/.
- 2026-09-13 (Anton): stale historical specs get headers only.
- 2026-09-15 (Anton, 95069a7): protocol terminology is **request channel**
  (request–reply, responses private to the requester) and **event
  channel** (publish–subscribe, every subscriber, no history; a new
  subscriber gets a **snapshot**). "Query" is avoided for the request side
  because it collides with the SDK's `Query`.
- 2026-09-15 (Anton): `/fork` is not a slash command in programmatic mode
  (the native TUI has it; clauctl may add one later), so the docs mention
  only `/clear` and `/new`.
- 2026-09-15 (Anton): the AGENTS.md one-pass bullet stays (re-added in
  95069a7); the 2026-09-13 removal decision is reversed.
- 2026-09-15 (Anton): the muninn runner paragraph is dropped from
  overview.md; audit.md is a follow-up, not this phase; the
  delivered-prompt confirmation must not match by text.
- 2026-09-15: the compaction-hides-append limitation in
  user-message-tracking.md is retired: the entry is pre-boundary in the
  file, the display tree shows it, and `get-context` correctly omits it;
  nothing is hidden that should be shown. The interrupt limitation stays,
  with the file-stream fix (confirm delivered prompts by their entry)
  recorded as a follow-up.
- 2026-09-15 (Anton): "sdk socket" → **protocol** everywhere the term
  meant the clauctl interface: `src/core/protocol.ts` (`ProtocolClient`,
  `ProtocolRequest`/`ProtocolResponse`/`ProtocolRequestRecord`,
  `PROTOCOL_NAME`/`PROTOCOL_VERSION`), `src/core/daemon/protocol-server.ts`
  (`startProtocolServer`, `ProtocolConnection`), `registry.agentSocketPath`,
  `docs/protocol.md`, error strings ("agent socket closed …"). The hello
  value becomes `"clauctl-protocol"` (wire-breaking: old clients and daemons
  reject each other; live agents need a restart). `Sdk*` names that mean
  the Claude Agent SDK stay: `sdkMessage`, `SdkControl*`, sdk-passthrough,
  sdk-commands, sdk-render, sdk-message, `tests/sdk/`. The `socket`
  filename became `socket` in the same minor bump (0.2.0).
- 2026-09-15: overview.md keeps its origin reasoning; sections it
  duplicated (SDK facts, data model, roadmap, document map) are links.

## Follow-up raised while planning

Explaining the interface showed a leak: `MergeState` cannot fully hide
the unsynchronized streams from a client. Sketch in
docs/thoughts/fold-resolved-events.md (deferred; a separate spec).

From review round 95069a7:

- `clauctl` `/fork` command (none exists in programmatic mode). See docs/thoughts/fork.md
- `docs/audit.md`: how the attach/detach audit works.
- Confirming a delivered prompt by identity rather than by a later
  emission (stamping `SDKUserMessage.uuid`; `derisk/uuid-stamping/`), which
  would close the interrupt limitation in user-message-tracking.md.

## WORK LOG

- 2026-09-13: sweep done (table above); first outline agreed.
- 2026-09-14: review round bf7eb2e; the facts/mechanisms split replaced
  by protocol.md + deep dives (structure above); fold follow-up
  recorded in docs/thoughts/fold-resolved-events.md.
- 2026-09-14: review round 5ee9844: doc renamed protocol.md;
  trees and `getSessionMessages` move to session-views.md; queue events
  link user-message-tracking.md; tests/sdk/ compared with
  claude-agent-sdk.md (table above).
- 2026-09-14: written: docs/protocol.md, docs/stream-merging.md
  (classification table moved here from session-tracker.md, which now
  cites it), docs/session-views.md ("Why not ask the SDK?" under view 2;
  "How the views are kept" section), docs/claude-agent-sdk.md (AgentObserver
  paragraphs gone; `permissionMode` and hooks facts added; each fact
  names its test or experiment; links to the new docs).
- 2026-09-14: remaining items: architecture.md (event list and history
  paragraph point at the daemon's resident view; attach mentions
  `SessionModel`; reference list), overview.md document map,
  user-message-tracking.md (`get-messages`/`lastTranscriptUuid`/
  `historyUpToBoundary` gone; the steered-prompt, attach-during-compaction
  and boundary-undefined limitations retired — the entry stream and the
  cursor-free handoff removed their mechanisms; the compaction-hides-append
  limitation narrowed to the context view), Status headers on all 27
  completed specs (existing superseded/lineage blockquotes left as they
  were), AGENTS.md one-pass bullet removed, get-entries-caching.md moved to
  docs/thoughts/old/ with its 9 citations retargeted.
- 2026-09-15: review round 95069a7: protocol.md (channels, the
  philosophy rewritten around late subscribers/durability/multiple
  clients, Anton's "exists because the SDK lacks" list polished with the
  `getSessionMessages` deficiencies, the `SessionStore` rejection, the
  file-only information inventory, and the dedup/duplicate footnotes;
  settlement noted as stronger than the reads need), stream-merging.md
  (table restructured to class | query | session | note; resolution
  wording; exclusion as extra information; duplicates on both streams),
  user-message-tracking.md (why the queue model rather than
  `queue-operation` entries; delivery paragraph tightened; interrupt
  limitation rewritten; compaction limitation retired), session-views.md
  (linearization footnote; `loadedContext` moved to a historical note;
  no TUI reconnect; `getSessionMessages` is a module function),
  architecture.md ("Two facts" reduced to a sentence; "The clauctl
  protocol" defers to protocol.md), overview.md (links replace
  duplicated sections), README.md (`spawn -a` quickstart; independent
  TUIs).
- 2026-09-15: Anton's answers applied: `/fork` mentions removed, muninn
  paragraph dropped, audit TDC moved to follow-ups, interrupt limitation
  reworded without text matching; docs/derisk/attachment-types/FINDINGS.md
  written from a scan of 1160 local session files (27 types).
- 2026-09-15: "sdk socket" → protocol rename applied (files, symbols,
  error strings, comments, living docs, SKILL.md); hello value changed to
  `clauctl-protocol`; `socket` filename rename left as a follow-up.
- 2026-09-15: `stopRunningAgent` (archive) no longer requires the daemon to
  speak our protocol: a failed connect/hello warns and falls through to
  SIGTERM, so a clauctl update never has to be preceded by archiving the
  agents its old daemons run (`src/core/lifecycle.test.ts`).
- 2026-09-15: `sdk.sock` → `socket` (`agentSocketPath`, sun_path boundary
  tests re-derived for the 7-byte suffix, docs); version bumped to 0.2.0.
  Live agents started by 0.1.x need a restart (archive stops them via the
  no-protocol path).
