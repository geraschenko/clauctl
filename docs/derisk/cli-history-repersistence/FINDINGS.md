# Findings: the CLI re-persists loaded history, duplicating uuids in the session file

> **Observational report from a single production session — no probes were run.**
> Forensic analysis (2026-07-22) of session `429cb369-f1e3-4c3f-bfc7-129a119734f2`
> (clauctl agent `84c090fe-93bb-4f61-ade6-3a4efa4d1417`, CLI/SDK 2.1.211,
> cwd this repo). Line numbers cite the file snapshot as of the analysis;
> uuids are the stable anchors.

## TL;DR

The `claude` CLI itself can append **duplicate uuids** to a session file: it
re-persisted 237 already-persisted entries (same uuids, same timestamps,
re-serialized content) immediately before writing a manual-compact boundary.
The CLI keeps operating on such files without complaint. clauctl's
`buildTree` treats any duplicate raw uuid as corruption and throws
(`duplicate occurrence <key> — the session file is corrupt`), which makes
every subsequent history fetch fail — the TUI exits with code 1 on attach and
the session is unrecoverable without file surgery.

**Conclusion: a duplicate raw uuid is not corruption. It is a re-persisted
entry, and clauctl must tolerate it.** (Handoff for the code change:
`docs/specs/repersisted-duplicates-handoff.md`.)

## Symptom

`clauctl` attach after archiving the agent:

```
history fetch failed: Error: duplicate occurrence 2cab8750-7ed6-4006-ab92-e7b6082732b1 — the session file is corrupt
```

Thrown by `buildTree` (`src/core/build-tree.ts`), whose comment asserts
"valid files cannot produce one". `daemon.log` shows `tui exited with code 1`
on each attach attempt; the daemon and CLI stay healthy (turns kept flowing
after the duplicates were written, including three more compacts).

## Timeline of the session

| when (UTC)     | event                                                                                          | evidence                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Jul 21 23:45   | manual `/compact` — boundary `2cab8750…` (line 584), preserves `1064cc5c…`                      | native boundary, `gitBranch: main`                                             |
| Jul 22 ~01:24  | esc-esc rewind: lines 833–900 abandoned (line 905's parent is line 830)                         | clauctl no-write rewind → `resumeSessionAt` query restart (P2 d path)          |
| Jul 22 01:33   | manual `/compact` — boundary `19ac29da…` (line 947), preserves `f0db8495…`                      | summarizes the chain from the 23:45 boundary block down to line 940            |
| 01:33–04:58    | conversation continues normally (lines 948–1448)                                               |                                                                                |
| Jul 22 05:00   | manual `/compact` — boundary `4355252c…` (line 1689). **Immediately before it, the CLI appended lines 1452–1688: 237 re-persisted copies of earlier entries.** | the duplication event                                                          |
| Jul 22 05:20+  | archive → re-attach → `history fetch failed`; repeats on every attach                          | `audit.jsonl`, `daemon.log`                                                    |

## What exactly was duplicated

The re-appended set is precisely **the effective chain the previous (01:33)
boundary had summarized away**: the 23:45 boundary + its summary + the
preserved message + every turn on the active chain down to line 939 —
**excluding** the abandoned rewind branch (833–900) and **excluding** the
message the 01:33 boundary preserved (`f0db8495…`, which stayed live in
context). Not a file copy, not the active chain: exactly the
dropped-from-context segment.

## Evidence the copies are the CLI's in-memory view, serialized back out

Field-by-field diff of all 237 first/second pairs:

| field           | pairs differing | nature                                                                                                    |
| --------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `gitBranch`     | 14              | restamped `main` → `keybindings` (only originals written before the branch switch differ) — proves a live process re-serialized at write time |
| `toolUseResult` | 50              | value re-normalized                                                                                          |
| `promptId`      | 10              | value changed                                                                                                |
| `attachment`    | 7               | value re-normalized                                                                                          |
| `parentUuid`    | 2               | **the boundary relink materialized into raw pointers** (below)                                              |
| `message`       | 1               | `usage` zeroed on the preserved message's copy                                                               |
| `slug`          | 1               | added                                                                                                        |

The two `parentUuid` rewrites are the smoking gun: the preserved message
`1064cc5c…`'s copy parents onto the summary `b3b31b3f…` (its original raw
parent was the pre-compact chain, `921b654b…`), and the first post-summary
user message's copy parents onto `1064cc5c…` instead of the summary. That is
the 23:45 boundary's load-time relink **baked into raw `parentUuid`
pointers** — the CLI serialized its reconstructed in-memory chain, not the
file's entries.

Writer attribution: clauctl only ever appends boundary-shaped entries
(`buildBoundaryEntries`); this block is ordinary user/assistant/attachment
entries, restamped by a live process, positioned immediately before the CLI's
own native manual-compact boundary. The writer is the CLI.

## Trigger hypothesis (unproven)

A query restarted with `resume`/`resumeSessionAt` loads history into its
in-memory session store without marking it file-backed; a later `/compact`
flushes the segment it evicts from context, re-appending it to the file.

This **corrects the scope of P2 d / P9 c**
(`docs/derisk/compact-boundary-injection/FINDINGS.md`): the
`resumeSessionAt` rewind itself writes nothing to the file — but a later
`/compact` in the restarted query may re-persist what it drops.

Unexplained wrinkle: the 01:33 compact ran in the same restarted query and
did **not** re-persist; only the 05:00 compact did. The trigger is therefore
more specific than "compact after restart" — plausibly it fires only when
the dropped segment was itself loaded through a compact-boundary relink.
Pinning it down needs a live probe (resume → rewind → compact → compact in
an isolated harness); none was run for this report.

## Implications for clauctl

- `buildTree`'s premise — duplicate raw uuid ⇒ corrupt file — is false for
  CLI-written files. Tolerance direction (first occurrence authoritative for
  tree placement, `entriesByUuid` last-wins for content) is specified in
  `docs/specs/repersisted-duplicates-handoff.md`.
- Duplicates always sit below a compact boundary that immediately follows
  them, so tip-anchored walks (`effectiveTreeNodeChain`, get-messages,
  set-context eligibility) never see them in practice; only whole-file tree
  construction does.
- Affected files need no repair once tolerance lands — the CLI's own loader
  evidently tolerates them already.
- The re-serialized copies can carry degraded sidecar data (zeroed `usage`,
  re-normalized `toolUseResult`), so last-wins content lookups on deep
  history may show the degraded values; accepted as cosmetic.
