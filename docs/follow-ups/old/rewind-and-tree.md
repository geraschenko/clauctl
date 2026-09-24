# Rewind and `/tree` for clauctl

Handoff notes for a future spec: implementing conversation rewind (claude's
Esc-Esc / `/rewind`) and a pi-style `/tree` command in the clauctl TUI. The
findings below were verified empirically against Agent SDK 0.3.195 and real
session transcripts on 2026-07-08 unless marked as a hypothesis.

## How rewind works

The SDK's `Query` has no in-session conversation-rewind control. The mechanism
is a query restart:

```ts
query({ options: { resume: sessionId, resumeSessionAt: messageUuid } })
```

`resumeSessionAt` means "only resume messages up to and including this UUID"
(sdk.d.ts documents it as an `SDKAssistantMessage.uuid`). Decision: the
technical rewind target is always an assistant message. Rewinding "to" a user
message U means "re-do that turn" and decomposes, same as pi, into:
`resumeSessionAt(<assistant message before U>)` + `rewindFiles(U)`? + prefill
the input box with U's text. The two anchors cohere: file checkpoints snapshot
state at user messages (before the turn runs), so `rewindFiles` wants U while
the conversation resumes at the assistant message preceding it.
Resume without `forkSession: true` keeps the same session ID and appends to the
same jsonl file — the `forkSession` option exists precisely to opt out of that.
So messages appended after a rewind carry a `parentUuid` pointing at the rewind
target: **an in-file tree, not a new session file**. This avoids the crummy
`forkSession()` route (which copies the transcript into a new session file with
remapped UUIDs).

Hypothesis still to confirm (one interactive claude session with Esc-Esc, then
inspect the jsonl): interactive claude's rewind produces exactly this in-file
branch. A scan of recent local transcripts found no branch points to confirm
against.

File state is separate: `Query.rewindFiles(userMessageId, {dryRun?})` restores
tracked files to their state at that message. It requires
`enableFileCheckpointing: true` at query creation (the transcripts'
`file-history-snapshot` entries are this feature's data).

## Reading the tree

- `getSessionMessages(sessionId, {dir})` returns only the **active chain**:
  from the file's last entry, backwards along `parentUuid`, stopping at the
  last compaction (`compact_boundary` entries have `parentUuid: null`; the
  pre-compaction chain hangs off `logicalParentUuid`). Good for linear
  history, useless for enumerating branches.
- Full file through the SDK: `importSessionToStore(sessionId, store, {dir,
  includeSubagents: false})` into an `InMemorySessionStore`, then
  `store.load({projectKey, sessionId})`. Returns every raw jsonl line as a
  `SessionStoreEntry` (`{type, uuid?, timestamp?, ...}` — opaque blobs; we
  parse `parentUuid`/`logicalParentUuid`/`isCompactSummary` ourselves).
  Verified: entry count matches the file's line count exactly. Caveats:
  `@alpha` API; `projectKey` = cwd with `[^a-zA-Z0-9]` replaced by `-`
  (verified against a real project dir).
- Or just read the jsonl directly — same parsing burden, minus the SDK's file
  location logic. Path: `~/.claude/projects/<projectKey>/<sessionId>.jsonl`.

Branch enumeration = entries whose `parentUuid` has more than one child among
user/assistant entries.

## What the daemon needs

Rewind requires the daemon to tear down its `query()` and construct a new one
with `resume` + `resumeSessionAt` (the existing daemon runs one query for its
lifetime). Sketch:

1. New `SdkControlMutation`-style request, e.g. `{type: "navigateTree",
   messageUuid, rewindFiles?: boolean}` where `messageUuid` is the assistant
   message to resume at (the user-message interpretation above is TUI-side:
   it picks the preceding assistant uuid and prefills the editor).
2. Daemon: interrupt/await idle → dispose the current query → start a new
   query with `resume: sessionId, resumeSessionAt: messageUuid` → rewire the
   message pump and EventBus. Queued-but-undelivered messages need a policy
   (drop? keep?).
3. Optionally call `rewindFiles` first (needs `enableFileCheckpointing`
   enabled at spawn — decide whether clauctl turns this on by default).
4. TUI `/tree`: fetch the full entry set (above), render the branch structure,
   let the user pick a node, send the rewind request, then re-render history
   from the new active chain.

## Esc-Esc summarization options

Interactive claude's rewind menu offers "Summarize from here" (summarize the
cut-off tail) and "Summarize up to here" (replace the conversation prefix with
a summary, staying at the leaf). Neither has an SDK control — compaction is
only triggerable by sending `/compact [instructions]` as a user message, which
summarizes the whole window with no boundary parameter.

- **"Summarize from here"** is cleanly emulatable, pi-style: the cut-off
  branch's messages are available from the full-file read, so generate the
  summary ourselves (one API call with our own summarization prompt) and
  inject it as a tagged user message after `resumeSessionAt(P)`. No CLI
  cooperation needed.
- **"Summarize up to here"** has no public route: nothing tells a running
  query to replace its prefix (`resumeSessionAt` keeps prefixes, not
  suffixes). The unsupported route is a synthetic `compact_boundary` (below):
  writing the CLI's private jsonl format ourselves — validate with a live
  resume before building on it, and expect breakage on CLI updates. The clean
  path is an upstream feature request (boundary/`messagesToKeep` parameter on
  compaction).

### Partial-compaction format (verified in CLI 2.1.195 binary)

Both menu options are implemented as partial compaction (internal modes
`"up_to"` / `"from"`), NOT as parentUuid branches — which is why transcript
scans find no branch points from summarize-mode rewinds. The mode is a
producer-time parameter only: the boundary does not record it, and the loader
is mode-agnostic (relink is fully determined by `anchor_uuid` + `uuids`). The
direction is persisted on the synthetic summary user message instead, as
`summarize_metadata: {messages_summarized, user_context?, direction?}`
(`@internal`; used by the transcript UI to render "Summarized N messages up
to/from this point"). Producer:

- `up_to` ("Summarize up to here"): `messagesToKeep` = the suffix; entries
  appended in order `[boundary, ...summaryMessages, ...messagesToKeep]`;
  `preserved_messages.anchor_uuid` = the **last summary message**. Post-relink
  chain: `boundary → summary → kept suffix → future messages`.
- `from` ("Summarize from here"): `messagesToKeep` = the prefix up to the
  rewind point; order `[boundary, ...messagesToKeep, ...summaryMessages]`;
  anchor = the **boundary itself**. Chain: `boundary → kept prefix →
  tail-summary → future messages`.

Loader relink (runs at transcript load, e.g. on `resume`): for each
`compact_boundary` with `preserved_messages {anchorUuid, uuids}`, re-parent
`uuids[0]` onto `anchorUuid` and each `uuids[i]` onto `uuids[i-1]`. Summarized
messages are not deleted — they become unreachable from the leaf's backward
walk (the boundary has `parentUuid: null`). `preserved_segment {head, anchor,
tail}` is the older encoding of the same list: the loader walks `tail → … →
head` along parentUuid and then relinks identically, so the preserved set
there must be a contiguous chain segment; `preserved_messages` supersedes it
with an explicit, not-necessarily-contiguous list. Sharp edges:

- The relink is **silently skipped** if `uuids` is empty or any listed uuid is
  absent from the file. `uuids` must be the on-disk subset (`all_uuids` is an
  internal in-memory superset) — build the list from what is actually in the
  jsonl.
- No SDK surface mutates a running query's context, so the synthetic route is:
  wait idle → close the query → append summary message(s) + boundary entry to
  the session file → new `query({resume: sessionId})`.

## Related

- `docs/specs/tui-history.md` (get-messages RPC + history-on-attach) is the
  prerequisite: it establishes historical-message rendering in the TUI.
