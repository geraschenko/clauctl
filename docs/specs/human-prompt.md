# Spec: isHumanPrompt — classifying user entries by the CLI's `origin` field

> Status: **APPROVED 2026-09-07 (derisk in conversation; type design
> approved)**. Follow-up to docs/specs/get-context.md review round 3079b1e.

# SPEC

## Problem

The tree's "real user prompt" predicate (`userWithText`: user, not
`isMeta`, has text) over-reports: the CLI's command echoes
(`<command-name>…`, `<local-command-stdout>…`), shell-mode echoes
(`<bash-input>`/`<bash-stdout>`), and `[Request interrupted by user]`
are user entries with text and no `isMeta`, so `/tree` and `format tree`
draw them with the prompt glyph `❯`, and a `/tree` pick on one steps back
to its parent as if it were a prompt to edit.

The CLI records its own verdict: from 2.1.190 on, every prompt the human
typed carries `origin: {kind: "human"}` (skill invocations included);
subagent-completion injections carry `origin: {kind:
"task-notification"}`; command/shell echoes, interrupt markers and typed
`/compact …` text carry no `origin`. Entries written before 2.1.190 never
carry it. (Survey of 344 local files: docs/follow-ups/subagent-activity.md,
`origin` bullet.)

Wanted:

- **`isHumanPrompt(entry)`** replaces `userWithText`: the CLI's verdict
  for entries whose writer knew the field; a **temporary** heuristic for
  entries written before 2.1.190, marked for removal.
- **`/tree` shows only** human prompts, assistant messages (the picker's
  current final-with-text rule), compaction boundaries and summaries. The
  current-leaf exemption is dropped: when `/tree` is opened the leaf is
  an assistant message in practice, and a filtered leaf's marker already
  moves to its nearest visible ancestor.
- **Glyph**: `◌` means "user entry that is not a human prompt" (isMeta
  expansions, command echoes, interrupts, task notifications), no longer
  "isMeta"; `❯` means human prompt.

## Success criteria

1. `isHumanPrompt` on an entry with `version >= 2.1.190`: true iff
   `origin` is an object with `kind === "human"`. Command echoes,
   `<local-command-stdout>`, interrupt markers, `task-notification`
   entries, tool results, isMeta entries and summaries are false; a typed
   prompt and a skill invocation (`<command-message>…<command-args>` with
   `origin.kind === "human"`) are true.
2. `isHumanPrompt` on an entry with `version < 2.1.190` or no `version`
   (see Edge cases): true iff user, not isMeta,
   has text, and the text does not start with `<command-`,
   `<local-command-`, `<bash-`, or `[Request interrupted`.
3. `format tree` (default and `--filter all`) on the session in the
   Problem draws `❯` on typed prompts, `◌` on `<command-name>` and
   `<local-command-stdout>` rows; `--filter user-only` and `conversation`
   omit the latter two; summaries stay visible in every filter that showed
   them.
4. `/tree` rows: human prompts, final assistant entries with text,
   boundaries, summaries — nothing else, including a tool-result or system
   leaf (its marker lands on the nearest visible ancestor).
5. A `/tree` pick on a non-human user row (were it reachable through a
   future filter) rewinds to itself; pick semantics are otherwise those of
   docs/specs/get-context.md criterion 6.
6. `userWithText` and `META_GLYPH` no longer exist; the fallback's symbols
   are removable by deleting the marked block and its constant, with no
   other edits.
7. Existing tests stay green except where fixtures lack `origin` and now
   assert prompt rows: those fixtures gain `origin: {kind: "human"}`.

## Examples

Session at 2.1.258 (the one in the Problem): rows `□ summary`, `◌
<command-name>/compact…`, `◌ <local-command-stdout>Compacted`, `❯ Looks
good. Proceed…`, `● Now glyphs…`. `/tree` shows `□`, `❯`, `●` rows only.

A 2.1.126 session (no `origin` anywhere): `❯` on typed prompts, `◌` on
`<command-name>` rows, `◌` on isMeta skill expansions — via the fallback.

A subagent-completion injection (`origin.kind === "task-notification"`,
user entry with text): `◌`; hidden in `/tree`.

## Type design

```ts
// src/format/tree.ts — userWithText deleted

/** The first CLI version that writes `origin` on user entries. Entries
 *  written earlier take the pre-origin fallback. */
const ORIGIN_FIELD_SINCE = "2.1.190";

/** A prompt the human typed. Entries whose writer (`entry.version`) knew
 *  the field carry the CLI's verdict in `origin`; older entries go through
 *  the pre-origin fallback (see docs/follow-ups/subagent-activity.md). */
export function isHumanPrompt(entry: SessionEntry): boolean;
// entry.type === "user" && (writtenBefore(entry, ORIGIN_FIELD_SINCE)
//   ? preOriginHumanPrompt(entry)
//   : isRecord(entry.origin) && entry.origin.kind === "human")

/** `entry.version` (dotted numeric) is older than `version`; a missing or
 *  unparsable version counts as older. */
function writtenBefore(entry: SessionEntry, version: string): boolean;

// TEMPORARY — pre-2.1.190 fallback. Delete this block, ORIGIN_FIELD_SINCE
// and writtenBefore once sessions older than 2.1.190 no longer matter.
const PRE_ORIGIN_NON_HUMAN_PREFIXES = ["<command-", "<local-command-", "<bash-", "[Request interrupted"];
/** user, not isMeta, has text, text not starting with a known non-human
 *  prefix. */
function preOriginHumanPrompt(entry: SessionEntry): boolean;

// passesFilter (signature unchanged):
//   user-only:    isHumanPrompt(entry) || entry.isCompactSummary === true
//   conversation: user branch → same disjunction; rest unchanged
//   picker:       compact_boundary || isCompactSummary || isHumanPrompt
//                 || (assistant && isFinal && hasText)   — no isCurrentLeaf read
// treeRowGlyph user branch, first match wins:
//   isHumanPrompt → USER_GLYPH; toolResultOnly → TOOL_RESULT_GLYPH;
//   hasText → USER_BUT_NON_HUMAN_GLYPH; else fall through to OTHER_ENTRY_GLYPH.
//   Boundary/summary cases before it and the assistant branch
//   (tool_use → TOOL_CALL_GLYPH, else ASSISTANT_GLYPH) unchanged.

// src/tui/glyphs.ts
/** A user entry that is not a human prompt: isMeta expansions, command
 *  and shell echoes, interrupt markers, task notifications. In the
 *  assistant's context, not typed by the user. */
export const USER_BUT_NON_HUMAN_GLYPH = "◌";   // META_GLYPH renamed

// src/tui/components/tree-selector.ts: resolveTreePick reads isHumanPrompt
// where it read userWithText; TreePick unchanged.
```

Dependencies: `isHumanPrompt` → `writtenBefore`, `preOriginHumanPrompt`
(→ `hasText`); `passesFilter`, `treeRowGlyph`, `resolveTreePick` →
`isHumanPrompt`. `seed.ts` and `entryToSessionMessage` keep `isMeta`:
they mirror the stream fold and the SDK projection, not the human
question.

## Data flow

Unchanged: `treeLines` calls `passesFilter`/`treeRowGlyph` per row;
`resolveTreePick` classifies the picked entry once. The picker filter now
reads `isCompactSummary` explicitly (summaries have no `origin`).

## Cost

None beyond today: one `version` string parse per row on top of the text
extraction `hasText` already performs.

## Edge cases

- **Mixed-writer files.** A session resumed by a newer CLI mixes entry
  versions; the gate is per entry, so each entry is judged by the field
  set its writer produced.
- **Missing `version`.** Treated as pre-origin (fallback). Observed only
  on a few 2.1.34-era entries.
- **`origin` present, kind unknown.** Not human.
- **Typed `/compact args` text (origin-era, no `origin`)** → not human.
- **Who stamps `origin`.** The host wrapping keyboard input, not the CLI:
  sdk.d.ts ("a host wrapping keyboard input must stamp {kind:'human'}
  explicitly — absent origin is treated as unattributed and fails closed
  at strict isHuman() trust gates"). clauctl stamps it on every sdk.sock
  prompt and `/compact` (request-handlers.ts). `query({prompt: "string"})`
  — the SDK smoke tests — stamps nothing, so those prompts are not human
  here, by the SDK's own contract. `promptSource: "sdk"` is the CLI's
  record of the delivery path and appears on both; it is not a
  discriminator.
- **Summaries** have no `origin`; every filter that showed them admits
  them via `isCompactSummary`.
- **Filtered leaf in `/tree`.** The marker moves to the nearest visible
  ancestor (existing filtered-leaf behavior); if there is none, no active
  chain.

## Non-goals

- Cycling `/tree` through richer filters (tool calls/results, attachments)
  — a later spec.
- Changing `seed.ts`'s leaf eligibility or `entryToSessionMessage`.
- Changing pick semantics (docs/specs/get-context.md criterion 6).

# IMPLEMENTATION IDEAS

- Version parsing: split on `.`, compare numerically, element-wise; a
  local helper in tree.ts (no dependency), since the fallback and its
  helper are deleted together.
- Test fixtures: `format/tree.test.ts`, `tree-selector.test.ts`,
  `interactive-mode`-level tests that build user entries — add `origin:
  {kind: "human"}` to the user-entry helper rather than per test; add
  `version: "2.1.258"` where the helper has no version (else the fallback
  runs and still classifies typed text as human — the tests must exercise
  the origin branch explicitly with an origin-less command echo).
- Fallback tests use `version: "2.1.126"` entries: typed text → human,
  `<command-name>` → not.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

## 2026-09-07 — critique

- Added the `type === "user"` guard to the origin branch (the field is
  only written on user entries; a non-user entry must be false without
  consulting it).
- Checked: no doc outside the specs names the meta glyph; the filtered-leaf
  marker behavior the picker change relies on is treeLines' existing
  contract ("the leaf's row is currentLeafId itself when it passes, else
  its nearest visible ancestor").
- Test fixtures carry no `version`, so today's helpers would exercise the
  fallback only; the origin branch needs versioned fixtures (Implementation
  Ideas).

## 2026-09-07 — derisk (in conversation, get-context review round 3079b1e)

- Survey of 344 files established the `origin` facts (recorded in
  docs/follow-ups/subagent-activity.md).
- Rejected: per-entry field-absence gating (an origin-era entry without
  `origin` would get a second opinion from the heuristic; the CLI's
  silence is the verdict); whole-file gating (file-level state threaded
  into a per-entry predicate; mixed-writer files).
- Chosen: per-entry writer-version gate; fallback marked TEMPORARY.
- `/tree`: drop the current-leaf exemption; keep final-with-text
  assistants; richer views deferred to a later spec.
- Glyph: `◌` = user-but-non-human; `❯`, `⤷`, `▸`, `●`, `·` unchanged.

Checklist:

- [x] isHumanPrompt + writtenBefore + fallback block (tree.ts)
- [x] passesFilter / treeRowGlyph updates; userWithText deleted
- [x] USER_BUT_NON_HUMAN_GLYPH rename
- [x] tree-selector uses isHumanPrompt
- [x] tests (origin branch, fallback branch, picker leaf, glyphs)
- [x] docs: no doc outside the two specs names META_GLYPH/◌ (checked);
      glyphs.ts comment is the only prose to update

## 2026-09-08 — implementation

- Types compiled and the full suite stayed green before any fixture
  changed — confirming the critique's point that version-less fixtures
  exercise only the fallback. Fixtures then moved to the origin era.
- Presubmit green; 624 tests.

## Implementation-Time Decisions

- **Test fixture split** (`format/tree.test.ts`, `tree-selector.test.ts`):
  `nonHumanUserEntry` (version 2.1.258, no `origin`) is the base and
  `userEntry` spreads `origin: {kind: "human"}` over it, so a test builds a
  command echo / isMeta expansion / summary by starting from the non-human
  shape rather than deleting a field from the human one. Fallback tests
  override `version` on the non-human shape.
- **`writtenBefore` parses inline** (local `parse` closure, element-wise
  numeric compare, missing components read as 0): the whole helper is
  deleted with the fallback, so it takes no dependency and lives nowhere
  else.
- **`preOriginHumanPrompt` does not re-check `type`**: `isHumanPrompt`
  guards it, and the helper extracts the text once instead of calling
  `hasText` and extracting again.
- **docs/specs/get-context.md still names `userWithText`/`META_GLYPH`** in
  its type design and work log: it is the record of that round, left as
  written.
