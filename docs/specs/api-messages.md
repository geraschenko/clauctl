# Spec: api-messages — the context as the assistant receives it

> Status: **IMPLEMENTED** (2026-09-30; restructured from the first
> implementation 54478c7, whose checker tolerances were heuristics that
> could mask a wrong conversion, whose transcribed CLI literals had no
> provenance, and which nothing forced to re-verify on an SDK bump;
> reviewed by Anton and a fresh-context reviewer, WORK LOG). Follow-up
> to `docs/follow-ups/api-context-view.md`; the facts it encodes come from `docs/derisk/api-context-view/FINDINGS.md`
> and `P0-binary-read.md` (SDK 0.3.280 / CLI 2.1.280) and are verified
> by `tests/sdk/api-context.test.ts` (see Verification).

# SPEC

## Problem

`get-context` and `format tree` show the session file's view of the
assistant's context: verbatim entries, attachments included. Nobody can
see from clauctl what the assistant actually receives — which entries the
CLI drops, how attachments are rendered, how parallel tool calls are
regrouped. The attachment size column is an estimate whose field choices
were never checked against the wire, and the tree cannot mark entries
that contribute nothing.

Wanted: one pure conversion, **context entries → API `messages`**, that
reproduces the CLI's stage-5 wire normalization (loader stages 1–4 are
`contextAt`, docs/specs/get-context.md), exposed as
`clauctl format api-request` and consumed by the tree presentation
(per-entry wire contribution) and by the attachment views (the
assistant-visible size). A `--check` mode of the capture oracle
(`scripts/capture-api-request.ts`) diffs the conversion against a real
capture so drift on SDK bumps is visible.

Vocabulary (from the derisk docs): _Contribution_ is what one context
entry put on the wire. _Prompt turn_ is the user message the oracle's
own prompt creates at capture time. _Request-time_ content is what the
CLI adds for the new request from the environment, not from any entry:
reminders in the prompt turn (`# Environment`, the model notice, agent
and skill listings, token usage, CLAUDE.md, userEmail, date, git
attribution — 0 to 9 blocks observed) and, with mid-conversation system
on, text in the system tail and an empty `system` message after the
first user message. _API messages_ are the captured messages before the
prompt turn — the part of the request the context entries determine
exactly. Persisted attachments that trail the last assistant land at
the **front** of the prompt turn (default) or of the system tail
(mid-conversation system), before the request-time content; the
conversion's trailing message is therefore compared as a _prefix_ of
those (see the split contract below).

_Mid-conversation system_ (the CLI's term, env
`CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM`): by default attachments go
out as `<system-reminder>`-wrapped text blocks of a user message; with
mid-conversation system on, consecutive attachment texts are flushed at
the next assistant, or after the prompt turn as the _system tail_, as
one `role: "system"` message holding **one** text block: the texts with
their `<system-reminder>` wrapper stripped (snapshot or fallback alike),
joined by `"\n\n"`; the tail continues with `"\n\n"` + request-time
text. The CLI turns it on for some models (HAIKU: off;
`claude-fable-5-1`: on — the rule is not located in the binary) and the
env var forces it on (it cannot force it off). Nothing in the file
records it, so `forceMidConversationSystem` is an **input** to the
conversion. The oracle derives it from the capture: the request's system
prompt travels as the `system` parameter, never as a message, so a
`role: "system"` message in `messages` exists only with mid-conversation
system on. Observed 2026-09-29 (WORK LOG): forced-Haiku and gated-fable
captures agree on all of the above; the P2 session's wrapped system
texts (WORK LOG 2026-09-28) were the one outlier; the real-session
re-run (WORK LOG 2026-09-29) passed.

Three separate utilities, no shared logic — the `--check` script and the
SDK tests only wire them together:

| utility | where                                             | in → out                                                                                |
| ------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| capture | `tests/sdk/capture-inference-request.ts`          | resumable session + prompt → request body; `splitPromptTurn` → `CapturedApiMessages`    |
| convert | `src/format/api-messages/to-api-messages.ts`      | context entries + inputs → `ApiConversion` (pure)                                       |
| compare | `src/format/api-messages/compare-api-messages.ts` | `CapturedApiMessages` + conversion → `ApiComparison` (tolerated, failing, request-time) |

The request is a function of the context entries, the environment and
the prompt; the oracle can't remove the environment and the prompt from
the wire, so `splitPromptTurn` cuts the captured body at the prompt text
(the block carrying the nonce — the only exact boundary; the count of
request-time blocks varies) into the API messages, the prompt turn's
leading blocks and the system tail. The comparison then matches the
conversion's trailing message as a prefix of the leading blocks (or of
the tail text) and reports the remainder as request-time — never
dropped silently: a persisted block landing after a request-time one
breaks the prefix and fails.

## Success criteria

1. `clauctl format api-request FILE` prints the messages of
   `contextAt(leaf)` of the file as the assistant reads them (the
   transcript presentation below); `--json` prints `{"messages": [...]}`
   instead, the request body's `messages` array verbatim. `clauctl
get-context | clauctl format api-request` prints the same
   for a running agent (a chain input's leaf context is the chain itself
   — asserted by a test).
2. `scripts/capture-api-request.ts --check` writes
   `/tmp/capture-api-request-<sessionId>/{captured,split,captured-messages,synthesized,comparison}.json`
   (`captured-messages`: the wire without its request-time content, in
   the synthesized shape — with no differences, `diff` against
   `synthesized.json` is empty)
   (the raw body, the `CapturedApiMessages`, the conversion, the
   `ApiComparison`), prints every difference with its tolerance or `failing`,
   and exits non-zero only on failing ones. A maintainer can judge the
   diff from the files alone, without trusting the comparison code.
   Zero failing on every `tests/sdk/api-context.test.ts` fixture (a
   test) and on the two real sessions recorded in the WORK LOG (manual
   runs; real sessions are never committed).
3. The comparison is strict — positional, role and content by JSON
   equality — after the tolerances of the `TOLERANCES` registry have
   rewritten both sides (each entry: `why`, `removeWhen`, `normalize`;
   the name is the key). A tolerance removes exactly the difference it
   covers and nothing else, so tolerances compose (a permuted
   `tool_use` next to an external-state text in one message) and every
   remaining difference is failing. Entries: `parallel-order` (within
   one message, `tool_use` blocks sorted by id on both sides, likewise
   `tool_result` blocks; nothing else moves), `external-state-text` (the
   span of a block holding a `renderedBy: "external-state"` contribution
   replaced by a placeholder on both sides) and `empty-system-message` (a
   captured `role: "system"` message with `content: []` dropped). The
   report lists every rewrite with its tolerance and path, so a
   maintainer sees what was excused. Negative unit tests: a dropped user
   message, a reordered text block, an altered snapshot text, an extra
   non-empty `system` message, and a fallback text next to an altered
   sibling block are reported failing.
4. Per-entry contributions: every uuid of the context maps to exactly one
   `WireContribution` (`format api-request`, `--check`). The tree's
   "contributes nothing" mark is entry-local: the entry views give the
   `·` glyph to attachments the CLI renders to nothing and to
   all-thinking assistants, decided from the entry alone — the tree
   never runs the conversion.
5. Attachment size is the assistant-visible char count:
   `attachmentEntryView.size` is the total length of
   `renderAttachmentEntry(entry).texts` — the `rendered` snapshot's when
   the entry carries a valid one (exact), else the fallback's (one string
   field; unverified, like the text itself), 0 when the entry renders
   nothing. Entry-local, like the glyph. `AttachmentView` carries no
   size. Summaries compress the wire text rather than echo the payload:
   `token_usage` and `instructions` have views (the rows Anton named as
   noise); other types keep the default `text`/`content`/JSON echo until
   someone names them.
6. Pure: `src/format/api-messages/` is a `DEPENDENCY_DAG` key in
   `.dependency-cruiser.cjs` with edges `["core/session", "core/uuid.ts",
"core/generated/util.ts"]` only (`npm run depcruise` enforces it; the
   DAG generator is unchanged); `toApiMessages` performs no I/O and is
   deterministic in its inputs.
7. Existing behavior unchanged except where criteria 4 and 5 change
   it (attachment glyphs and sizes in `format entries|tree` and
   `/tree`): `format messages|entries|tree|events`,
   `get-context`, all presubmit tests.
8. Provenance and drift detection (Verification below): every literal
   transcribed from the CLI carries, in a comment at its declaration, a
   grep anchor into the binary and the name of the SDK test that
   observes it on the wire; `skills/update-claude-agent-sdk/SKILL.md`
   step 9 names `tests/sdk/api-context.test.ts` and the re-verification
   procedure, so an SDK bump done by the skill re-runs it.

## Examples

Native mode, a two-text attachment after a tool result (the texts fold
into the tool_result's string content), then the prompt:

```
entries (context order)                      messages
─────────────────────────────────────────    ─────────────────────────────────────────
assistant  tool_use Read                 →   assistant [tool_use]
user       tool_result "ok"              →   user [tool_result "ok\n\n<system-reminder>\nCalled the Read tool …
attachment (rendered: 2 texts)           →                       \n\n<system-reminder>\nResult of calling the Read tool:\n1\t…"]
attachment todo_reminder                 →   (none: renders-nothing)
user       "next prompt"                 →   user [text "next prompt"]
```

`todo_reminder` is a retired attachment type: CLI 2.1.280 exposes no
`TodoWrite`/`TaskCreate` tool (interactive or SDK-driven) and writes no
`todo_reminder` entries (local sessions: 23k such entries from 2.1.126,
6 from 2.1.220, none from 2.1.280), and its renderer returns `[]`. Old
sessions keep carrying the entries, and when 2.1.280 resumes one they
are absent from the HTTP request body it sends to `/v1/messages` (P3:
the fixture's nonce occurs zero times in the captured body —
`tests/sdk/api-context.test.ts` "todo_reminder"). General rule: the
conversion is the pinned CLI's renderer applied to whatever the file
holds; attachment types retired between versions render nothing.

Transcript presentation (default output), modelled on how a transcript
reads from inside the context — role headers, text verbatim with real
newlines, structured blocks as one-line brackets:

```
USER:
Read the config.

ASSISTANT:
[thinking]
The file is small, one Read suffices.
[tool_use Read toolu_01 {"file_path":"/repo/config.json"}]

USER:
[tool_result toolu_01]
{"port": 8080}
<system-reminder>
Called the Read tool with the following input: {"file_path":"/repo/config.json"}
</system-reminder>

SYSTEM:
# Environment
…
```

Blocks: `text` verbatim; `thinking` as `[thinking]` + text;
`redacted_thinking` as `[redacted_thinking]`; `tool_use` as
`[tool_use <name> <id> <input JSON>]`; `tool_result` as
`[tool_result <tool_use_id>]` (+ `is_error`) followed by its text
content; `image`/other as `[<type>]`. Messages separated by one blank
line.

Where this presentation comes from (recorded so the decision can be
revisited): the wire is JSON blocks and is tokenized server-side, so
the assistant-side rendering cannot be observed client-side. The
headers and brackets are **reader conventions**, chosen with the
model's own introspective report (Claude, 2026-09-28) as the only
available evidence:

- Turn boundaries and roles are perceived with certainty — which text is
  the user's, the assistant's, a tool result, and that the system prompt
  is a distinct region before the first user turn — but the mechanism
  (delimiter tokens vs. a per-token channel) is not introspectable; no
  role _text_ like `USER:` is perceived.
- Within a turn, `<system-reminder>…</system-reminder>` blocks and tool
  results are perceived as literal text; the view shows them verbatim.
- The assistant's own earlier thinking and tool calls are not perceived
  as marked-up text; `[thinking]`/`[tool_use …]` brackets exist for the
  human reader only.
- Public record: open-source chat templates delimit roles with special
  tokens (Llama 3 `<|start_header_id|>`, ChatML `<|im_start|>`, Mistral
  `[INST]`); Anthropic's legacy Text Completions API exposed turns as
  literal `\n\nHuman:` / `\n\nAssistant:` text with system text before
  the first turn. The current Messages API's server-side format is
  unverified.

Placement: an attachment that follows a plain user prompt in the file is
emitted before that prompt (after the nearest preceding assistant or
tool-result message).

## Type design

All new symbols live in `src/format/api-messages/`. Rule applied:
`src/core/session/` holds what the daemon and protocol need to run an
agent (entry parsing, canonical filtering, the message projection the
protocol streams); a projection whose only consumers are presentation —
`format api-request`, the attachment sizes — is formatting and lives
in `src/format/`.

```ts
// api-messages/to-api-messages.ts
export interface ApiConversionInputs {
  /** The CLI's CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM (vocabulary);
   *  not persisted, so supplied by the caller — the flag, or derived
   *  from the capture by the oracle. */
  forceMidConversationSystem: boolean;
  /** The model the request is for; thinking blocks of other models are
   *  removed, as the CLI does. Default: the model of the context's last
   *  assistant message (what a resume observes). */
  model?: string;
}

/** A text block we produce, or an entry's block passed through verbatim
 *  (untrusted shape beyond `type`). */
export type ApiContentBlock = { type: string; [key: string]: unknown };

export interface ApiMessage {
  role: "user" | "assistant" | "system";
  content: ApiContentBlock[];
}

/** Where an attachment's wire text came from: the entry's persisted
 *  `rendered` snapshot (exact; every rendering attachment type carries
 *  one since CLI 2.1.280), the fallback for entries without a valid
 *  one — the payload's first string field — whose text is a guess, or
 *  `external-state`: the CLI re-renders the type from state outside
 *  the file even when a snapshot exists (`deferred_tools_delta`). */
export type RenderedBy = "snapshot" | "fallback" | "external-state";

/** What one context entry put on the wire. */
export type WireContribution =
  | { kind: "message" } // user/assistant carried as blocks
  | { kind: "text"; texts: string[]; renderedBy: RenderedBy } // attachment, local_command; the texts as placed, joins belong to the placement
  | {
      kind: "none";
      reason: "skipped" | "renders-nothing" | "thinking-only" | "empty-content";
    };

export interface ApiConversion {
  messages: ApiMessage[];
  contributions: Map<UUID, WireContribution>;
  /** The entries behind each message, aligned with `messages`. */
  entryUuidsByMessage: UUID[][];
}

/** Stage-5 wire normalization over a context (contextAt order). Calls
 *  renderAttachmentEntry for attachments. */
export function toApiMessages(
  context: readonly SessionEntry[],
  inputs: ApiConversionInputs,
): ApiConversion;

// api-messages/render-attachment.ts
export interface AttachmentRendering {
  /** Texts in wire order. Snapshot texts are as persisted (already
   *  wrapped); fallback texts are bare. */
  texts: string[];
  renderedBy: RenderedBy;
}

/** Persisted `rendered` replayed when valid; types the CLI never
 *  renders (RENDERS_NOTHING) → undefined; anything else the fallback. */
export function renderAttachmentEntry(
  entry: SessionEntry,
): AttachmentRendering | undefined;

// api-messages/format-api-messages.ts
/** The transcript presentation (Examples). */
export function formatApiMessages(messages: readonly ApiMessage[]): string;

// api-messages/compare-api-messages.ts (the compare utility's input; the
// capture utility in tests/sdk/capture-inference-request.ts produces it)
export interface CapturedApiMessages {
  /** Every message before the prompt turn: what the context entries
   *  determine exactly. */
  apiMessages: ApiMessage[];
  /** The prompt turn's blocks before the prompt text: persisted trailing
   *  attachments first, then the CLI's request-time reminders. */
  promptTurnLeadingBlocks: ApiContentBlock[];
  /** Mid-conversation system only (hence also the mode): the trailing
   *  system message's single text — persisted trailing attachments
   *  joined by "\n\n", then request-time text. */
  systemTail: string | undefined;
}
/** Cuts the captured body at the block carrying `nonce`; string content
 *  is one text block. Throws unless the body ends with a user message
 *  holding the nonce exactly once, optionally followed by one system
 *  message with one text block. */
// tests/sdk/capture-inference-request.ts (capture utility)
export function splitPromptTurn(body: unknown, nonce: string): CapturedApiMessages;

// api-messages/compare-api-messages.ts (compare utility)
export interface Tolerance {
  why: string;
  removeWhen: string;
  /** Rewrites both lists so that the difference this tolerance covers
   *  disappears; touches nothing else. `tolerated` lists what it excused,
   *  with the values before the rewrite. */
  normalize(
    captured: ApiMessage[],
    synthesized: ApiMessage[],
    conversion: ApiConversion,
  ): { captured: ApiMessage[]; synthesized: ApiMessage[]; tolerated: JsonDifference[] };
}
/** The registry: the key is the tolerance's name in reports. */
export const TOLERANCES = {
  "parallel-order": { why: "…", removeWhen: "…", normalize: … },
  "external-state-text": { … },
  "empty-system-message": { … },
} as const satisfies Record<string, Tolerance>;
export type ToleranceName = keyof typeof TOLERANCES;

export interface JsonDifference {
  path: string; // JSON path into messages
  captured: unknown;
  synthesized: unknown;
}
export interface ApiComparison {
  /** Every rewrite a tolerance made, attributed by name. */
  tolerated: (JsonDifference & { tolerance: ToleranceName })[];
  /** Differences no tolerance covers. */
  failing: JsonDifference[];
  /** What the prefix match left over: the CLI's request-time content. */
  requestTime: { promptTurnBlocks: ApiContentBlock[]; systemText: string | undefined };
}
/** Strict positional comparison after normalization. The captured list
 *  is `apiMessages`, then — when the conversion ends with a user message
 *  (before its optional system message) — the prompt turn's leading
 *  blocks as a user message, then the system tail cut at the request-time
 *  boundary (`partitionSystemTail`, before any tolerance sees it); that
 *  trailing user must be a block-prefix of the prompt turn, the remainder
 *  being request-time. A prompt turn the conversion has no user for is
 *  request-time in full. */
export function compareApiMessages(
  capture: CapturedApiMessages,
  conversion: ApiConversion,
): ApiComparison;
```

`why`/`removeWhen` per entry: parallel-order — `contextAt` orders
parallel calls by uuid, the CLI by arrival; never removable.
external-state-text — the type carries a snapshot but the CLI
re-renders it from request-time state (`deferred_tools_delta` from the
current tool set); removable only if the CLI starts replaying the
snapshot. empty-system-message — the CLI emits its deferred-tools
notice as a `system` message even when empty (gated `claude-fable-5-1`,
after the first user message; absent under forced Haiku); removable
when the `model-gated mid-conversation system` fixture stops showing
it. The text tolerances locate a contribution's texts inside the message
its entry is behind (`entryUuidsByMessage`; Implementation-Time
Decisions); `RenderedBy` gains `"external-state"`.
Each normalizer reports its own `tolerated` entries (Implementation-Time
Decisions: a positional diff of input against output would attribute a
whole shifted tail to a dropped message).

`render-attachment.ts` keeps no per-type renderers (Non-goals): a valid
snapshot is replayed, RENDERS_NOTHING types (the P0-binary-read §c
explicit list, the known-but-unhandled list, `todo_reminder`,
`task_reminder`, `queued_command` with `renderedByBatchHead: true`)
render nothing (`undefined`), everything else is the fallback.

Changed existing symbols:

- `src/commands/format.ts`: new route `api-request` with
  `filePositional` and flags `{ forceMidConversationSystem: booleanFlag,
model: stringFlag, json: booleanFlag }`; `--force-mid-conversation-system`
  help: "Render attachments as role:system messages, as the CLI does
  under CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM=1 and for some models
  (default: <system-reminder> text in user messages)"; `model` help: "Model the request is for (default: the model of the
  context's last assistant message); thinking blocks of other models are
  dropped, as the CLI does".
- `.dependency-cruiser.cjs`: `DEPENDENCY_DAG` key `"format/api-messages":
["core/session", "core/uuid.ts", "core/generated/util.ts"]`; the
  generator's ancestor grant (54478c7) is reverted.
- `scripts/capture-api-request.ts`: flag `--check` = `splitPromptTurn`
  → `toApiMessages` → `compareApiMessages`, the five `/tmp` files, the
  report. No logic of its own.
- `src/format/entry-view/attachment-view/*`: `AttachmentView.size`
  removed; `attachmentEntryView.size` sums `renderAttachmentEntry`'s
  texts (criterion 5). New summary views `token_usage` and
  `instructions` replace the default view's payload echo.
- `src/format/entry-view/`: `attachmentSilentView` (attachment whose
  `renderAttachmentEntry` is `undefined`) and `assistantThinkingOnlyView`
  (all blocks thinking/redacted_thinking), both the parent view with
  `OTHER_ENTRY_GLYPH`; `entryViewFor` selects them from the entry alone.

## Data flow

`format api-request`: `inputChunks` → `decodeFormatInput` (entries) →
`CanonicalEntryFilter` → `buildTree` + `toContextTree` → `contextAt(leaf)`
→ `toApiMessages(context, inputs)` → `formatApiMessages(messages)`, or
`JSON.stringify({messages})` with `--json`.

`toApiMessages`, two passes:

1. Forward build. Per entry: skip predicate (`progress`; `isVirtual`;
   `system` unless `local_command`; synthetic api-error assistant;
   `thinking_drop`) → `none/skipped`; empty-array user content →
   `none/empty-content`.
   User/assistant: blocks verbatim (`tool_use` reduced to its wire
   fields); assistants sharing `message.id` merge into one message —
   also across tool-result users and system messages, so parallel tool
   calls regroup (a user without a tool_result ends the group). A prompt (user without tool_results) or `local_command`
   output is held pending until the next assistant, tool-result user or
   the end, then merged into the trailing user message (seam texts
   joined by a newline, tool_results hoisted) or pushed. Attachment:
   `renderAttachmentEntry`; `[]` → `none/renders-nothing`; default:
   texts join the trailing user message (`mergeAttachmentTexts`:
   folded into a final tool_result block's content — string content
   trimmed and joined by `"\n\n"`, array content appended with a `"\n"`
   seam on its last text — else appended as further blocks;
   `<system-reminder>`-wrapped unless a snapshot), or each becomes a
   user message of its own; a human-turn `queued_command` (prompt mode,
   not meta) under mid-conversation system is a pending user with the
   wrapper stripped; mid-conversation system: accumulated,
   wrapper stripped, and flushed as one `system` message with one text
   block at the next assistant or at the end — one attachment's texts
   joined by `"\n"`, attachments by `"\n\n"`. Types that never fold (`queued_command`,
   `session_context`, `instructions`, `coordinator_context`,
   `context_sections`, `remote_session_change`, `fork_briefing`,
   `poll_events`, `cowork_memory_context`, `artifact_opening_prefetch`,
   `dir_sync_notice`, `unknown_command_fallback`) take the default
   path either way. `local_command` output: plain text block merged
   into the preceding user.
2. Tail fix-up (needs the whole list): thinking-only assistant messages
   dropped unless a same-id sibling carried content (`none/thinking-only`);
   adjacent users merged when such a drop happened or under
   mid-conversation system;
   trailing thinking of
   the last assistant stripped; foreign-model thinking removed when
   `inputs.model` is set; assistant empty text blocks removed, one
   between two thinking blocks kept as the `[Empty text removed]` spacer
   (user empty text: untouched, unverified); whitespace-only assistants
   dropped (`none/empty-content`); empty assistant → `(no content)`.

`--check` and the SDK tests: `captureInferenceRequest` →
`splitPromptTurn(body, nonce)` ∥ `toApiMessages(leafContext(entries),
{forceMidConversationSystem: capture.systemTail !== undefined})` →
`compareApiMessages(capture, conversion)` → report; exit 1 iff
`failing` is non-empty. `splitPromptTurn`: the last message, or the
one before a final one-block `system` message, must be a user holding
exactly one block containing the nonce; the blocks before it are the
leading blocks and, when the last of them is text, its trailing `"\n"`
is removed (the CLI's user-into-user merge appends one newline to the
seam text — binary anchor `Y9r`, observed by every fixture whose
attachment precedes the prompt); blocks after it are request-time and
stay in `captured.json` only.

Tree: unchanged — glyphs come from `entryViewFor(entry)`; the tree
never runs the conversion.

## Cost

- `toApiMessages` is O(total content chars) in memory (renders every
  attachment without `rendered`, copies block arrays). Runs once per
  `format api-request`; the tree never runs it (criterion 4).
- `renderAttachmentEntry` passes strings through (snapshot texts or one
  payload field), so the size column stays O(1) `.length` reads
  (criterion 5).
- `compareApiMessages` is O(size of both bodies); oracle-only.

## Edge cases

- Resuming an unsettled tail (the context ends in a `tool_result` user
  with no assistant after it): the CLI appends a synthetic turn — user
  `Continue from where you left off.` merged into the tool_result message,
  then assistant `No response requested.` — before the prompt turn
  (observed 2026-09-29 by the first `attachment after tool_result`
  fixture). Request-time; the conversion does not model it, and the
  fixtures are settled. `--check` on an unsettled prefix reports it as
  failing (`warnIfUnsettled` flags the prefix first).

- Chain input (from `get-context`): the context tree over a chain has
  the chain as its leaf context (criterion 1 test).
- Pre-2.1.280 sessions (no `rendered` anywhere) and `rendered` present
  but invalid (empty, non-text blocks): the CLI re-renders per type; the
  conversion has no per-type renderers and takes the fallback guess,
  marked `renderedBy: "fallback"` — display only, never verified.
- `queued_command.renderedByBatchHead === true`: `none/renders-nothing`.
- `skill_listing`/`invoked_skills`/`hook_additional_context` with empty
  content render nothing in the CLI, but the CLI never persists them
  empty (survey of every local session, 2.1.112–2.1.280, 2026-09-29:
  none), so the fallback's `""` guess for that shape is not special-cased
  (YAGNI, Anton).
- Attachment entries whose payload fails the CLI's per-type validation
  (e.g. `file` without `content`) are dropped at transcript load with an
  error log (anchor `transcript load: dropped`). Not modelled: the CLI
  writes valid payloads; fixtures must too (WORK LOG 2026-09-29).
- `batching_reminder_sent`/`secondary_reminder_sent` render nothing as
  attachments, but a record in the context's trailing attachment run
  (after the last non-attachment entry; virtual entries skipped) with
  `clearAt: "next_user_message"` contributes its `text` — the latest per
  type — folded like any attachment text, bare (`tailReminders` /
  `pushTailReminder`; `docs/claude-agent-sdk.md`, "Reminder attachments
  are re-applied at request time"). Unverified by capture: whether the
  text is its own block or joined; every fixture ends with a prompt,
  which clears the record, so no `--check` covers it (unit test only).
- Context with no assistant yet: attachments attach to the first user
  message; `model` default is undefined.
- Compact boundaries: the context is already the loader's; `system`
  compact_boundary entries are `none/skipped`; the summary user message
  is carried as a message.

## Non-goals

- The `system` and `tools` request parameters (not derived from the
  file; P0 §b.4).
- Ephemeral reminders (`batching_reminder`, `secondary_reminder`) and
  `clear_at` system messages. The `*_reminder_sent` tail records are
  modelled (Edge cases); the gates on either CLI path are not.
- Exact text of the "not excerpted" attachment types — the fallback by
  design.
- Locating the CLI's mid-conversation-system model rule in the binary;
  the setting is an input.
- Per-type attachment renderers transcribed from the CLI (deleted
  2026-09-29: every rendering attachment carries a snapshot since
  2.1.280; older sessions take the marked fallback).
- `--at` on `format api-request` (pipe `get-context --at` instead).

## Verification

**Provenance rule.** A literal transcribed from the CLI (renderer
texts, the `<system-reminder>` wrapper, filler strings, the seam newline)
is declared once, with a comment naming (a) a grep anchor — a nearby
unique literal — in `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`,
and (b) the `tests/sdk/api-context.test.ts` test that observes it on the
wire. A literal no fixture can trigger is not transcribed; its type takes
the fallback (marked `renderedBy: "fallback"`, compared like any text).

**Claim → test.** Each row names the test observing it: a live SDK test
(`npm run test:sdk`) whose fixture writes a synthetic session, captures,
and asserts both the wire shape and `compareApiMessages` zero-failing —
or, where no settled fixture reaches the rule, a unit test, marked so.

| CLI behaviour                                                                | conversion code         | test                                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| attachment after a trailing user folds into its final tool_result or appends | `mergeAttachmentTexts`  | `attachment after tool_result` (two-text snapshot after a tool_result user, settled by a final assistant)                                |
| attachment with no trailing user: one user message per text                  | `pushAttachment`        | unit test (`to-api-messages.test.ts`, one user message per text); `rendered replay` (one text)                                           |
| user-into-user merge appends `"\n"` to the seam text                         | `mergeUserContent`      | every fixture (prompt after attachment)                                                                                                  |
| user-into-user merge hoists tool_results                                     | `mergeUserContent`      | unit test only (`to-api-messages.test.ts`); no settled fixture merges a prompt into a tool_result user                                   |
| persisted trailing attachments precede request-time reminders                | prefix rule (compare)   | `request-time reminders` (CLAUDE.md in the fixture cwd; its reminder is request-time, the persisted block is not)                        |
| mid-conversation system: one system block, wrappers stripped, `"\n\n"` join  | `flushSystem`           | `mid-conversation system` (forced; two trailing snapshots, one persisted wrapped, one bare)                                              |
| mid-conversation system on for `claude-fable-5-1`; empty system message      | `empty-system-message`  | `model-gated mid-conversation system` (fixture assistant model `claude-fable-5-1`, no env)                                               |
| snapshot replayed verbatim, never re-wrapped                                 | `renderAttachmentEntry` | `rendered replay`                                                                                                                        |
| retired types render nothing                                                 | `RENDERS_NOTHING`       | `todo_reminder`                                                                                                                          |
| thinking-only assistant dropped; adjacent users then merged                  | `fixUpTail`             | `thinking-only assistant dropped` (attachment user merges into the prompt turn)                                                          |
| same-`message.id` assistants regrouped, across tool-result users and systems | `pushAssistant`         | unit test (`parallel tool calls`) + real-session run 7b3418a6 (WORK LOG 2026-09-29)                                                      |
| `tool_use` stripped to wire fields                                           | `contentBlocks`         | `tool call` (persisted `caller` absent on the wire)                                                                                      |
| foreign-model thinking dropped                                               | `pushAssistant`         | `foreign thinking` (opus assistant before the haiku tail: thinking gone, text kept)                                                      |
| mid-conversation system: a human-turn steer is a bare pending user text      | `pushAttachment`        | unit test (`human-turn steer`) + real-session run 7b3418a6 (WORK LOG 2026-09-29)                                                         |
| branch: only the leaf chain is sent                                          | `leafContext`           | `branch` (fixture `parentIndex` forks off the reply; the sibling turn is absent)                                                         |
| compaction: summary carried, boundary skipped                                | skip predicate          | real-session `--check` on compacted sessions (Anton, 2026-09-29); no synthetic fixture — a fabricated boundary would not be the loader's |

**Updating on an SDK bump** — the procedure lives in
`skills/update-claude-agent-sdk/SKILL.md` step 9 (the bump is done by
that skill, so the instruction sits where the bump happens). All four
steps run on every bump, not only after a failure — the fixtures only
observe what they were written for: (1) `npm run test:sdk` — a failing
`api-context` fixture names the CLI behaviour that changed; (2) for
each transcribed literal, grep its anchor in the new binary and re-read
the slice
(`node -e 'process.stdout.write(require("fs").readFileSync(BIN,"latin1").slice(OFF-2000,OFF+4000))'`
with `OFF` from `grep -boa ANCHOR BIN`); (3) run `--check` on a real
session written by the new version and judge the `/tmp` files; (4)
record the run in the update's spec.

# IMPLEMENTATION IDEAS

- Skip lists transcribed from
  `docs/derisk/api-context-view/P0-binary-read.md` §c; SDK-test
  fixtures (`tests/sdk/api-context.test.ts`) double as unit fixtures for
  `renderAttachmentEntry`: the synthetic entries and their captured wire
  texts are inlined in the unit test file, as the repo's other tests do
  (never real sessions).
- Placement index: keep `lastAnchor` = index in `messages` of the latest
  assistant or tool-result user message; attachments insert at
  `lastAnchor + 1` (extending that user message when it is a user), so a
  plain prompt appended later lands after them.
- Why the oracle splits at the nonce and prefix-matches, rather than
  filtering by text prefix: the prompt turn holds persisted trailing
  attachment blocks, then request-time reminders, then the prompt (probe
  2026-09-29, WORK LOG). The nonce block is the only exact boundary;
  text-prefix lists (`# Environment`, …) were heuristics that also
  erased genuine API messages, and the request-time block count varies
  with the environment (CLAUDE.md present or not).
- Tree glyph: none — `entryViewFor` is already computed per row; the
  silent/thinking-only checks are O(entry).

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] `render-attachment.ts` + unit tests against SDK-test fixtures
      (2026-09-28; renderer texts re-verified against the pinned binary by
      string search, not only against P0's table)
- [x] `api-messages.ts` (`toApiMessages`) + unit tests (placement, regroup, fold, tail fix-up, chain input)
- [x] `format api-request` route (tracer bullet: transcript, `--json` and
      `--force-mid-conversation-system fold` on an SDK fixture; chain-input invariant holds —
      `src/commands/format.test.ts`)
- [x] `checkDifferences` + `--check` in the capture script (superseded
      by the 2026-09-29 restructure below; the P2 run was **not** zero
      failing — see the real-session note)
  - 2026-09-28: first `--check` run on the `file` SDK fixture failed on
    the adjacent-user merge: the wire carries the two `file` texts as two
    consecutive `user` messages while the conversion merged them. Read
    the binary instead of guessing (Implementation-Time Decisions, "User
    merges"): the builder now keeps prompts pending and pushes rendered
    texts separately when no user trails; `CM`'s seam newline was
    confirmed by the capture (`</system-reminder>\n` before the prompt).
  - `--check` across the 30 live SDK fixtures in `/tmp`: 0 failing after
    also filtering request-time texts on the synthesized side (a
    persisted `agent_listing_delta` matched the wire but was stripped from
    the captured side only) and aligning the fold's `[user, system]` tail.
    `tests/sdk/api-context.test.ts` `captureWith` now asserts criterion 2
    on every capture (10 pass, the fold-forced one included).
  - Real-session run (the P2 91-entry, 5-compaction Opus session, scratch
    copy; no `rendered` on any entry): 20 captured vs 18 synthesized, 8
    differences, **5 failing, all one class**: in the model-gated fold
    the system messages carry `total_tokens_reminder` text **with** its
    `<system-reminder>` wrapper, whereas the env-forced fold of the SDK
    fixture (same type, renderer path, HAIKU) carries it bare and checks
    clean. `x9r` (@201,276,726) SR-wraps bare text on the fold path; which
    pass strips it in the forced case — or adds it in the gated case — is
    not located. Left as is (fixture-backed behavior) pending Anton's
    call; the other 3 differences are `request-time-block` ×2 and
    `prompt-message`. The wire also carries the prompt as **string**
    content; `--check` normalizes it to one text block.
  - 2026-09-28, Anton's 2.1.280 session (7b3418a6, ~800 entries): 196
    synthesized vs 118 captured messages, roles drifting from message
    13 where the synthesized assistant lacks a `tool_use`; and snapshot
    texts inside the gated fold's `system` messages were **bare**,
    contradicting the P2 run. Diagnosed 2026-09-29 (below): parallel
    tool calls not regrouped, the steer folded into a tool_result.
- 2026-09-29 restructure (Anton + fresh reviewer, 54478c7 review):
  - [x] mid-conversation system kept (Anton, 4551d4e); the oracle derives
        the mode from the wire. 2026-09-29 boundary probes (throwaway,
        `/tmp`, fixture = user/assistant/nested_memory/total_tokens +
        CLAUDE.md in the cwd, answering shim): default — prompt turn =
        `[ATT, 9 request-time blocks, prompt]`; forced Haiku — prompt turn
        `[CLAUDE.md, userEmail, attribution, prompt]`, system tail one
        block `MEM\n\nATT\n\n# Environment…` with a wrapped `rendered`
        snapshot replayed **stripped**; gated `claude-fable-5-1` (no env)
        — identical tail, plus a `system` with `content: []` after the
        first user. Wrapper contradiction closed: strip.
  - [x] `check-differences.ts` deleted; `splitPromptTurn` →
        `CapturedApiMessages` (capture), `compareApiMessages` +
        `TOLERANCES` normalizers + prefix rule (compare), negative unit
        tests (2026-09-29; 10 compare unit tests)
  - [x] `--check` and `captureWith` reduced to wiring; four `/tmp` files
        (2026-09-29; `captureFixture` chains arbitrary fixture tails, one
        cwd per capture; the settings.json model pin was dead — the CLI
        resumes with the session's last assistant model)
  - [x] SKILL.md step 9: `api-context` re-verification procedure
  - [x] renderer catalog deleted (Anton, 2026-09-29; done 2026-09-29,
        `render-attachment.ts` 150 lines, unit tests rewritten;
        `renderAttachmentEntry` returns `undefined` for renders-nothing
        types — Anton, 2026-09-29: no `renderedBy` for an empty rendering): in his 2.1.280
        session every rendering attachment type carries a `rendered`
        snapshot (the only `rendered`-less types — `prompt_snapshot`,
        `batching_reminder_sent`, `thinking_drop` — render nothing), so
        the per-type renderers served pre-2.1.280 sessions only and
        were the bulk of the literals to re-verify on every bump.
        `render-attachment.ts` keeps: snapshot validity, RENDERS_NOTHING,
        the fallback, `external-state` marking.
  - [x] `SystemMode` → `forceMidConversationSystem: boolean`,
        `--force-mid-conversation-system`; `model` defaults to the last
        assistant's model (in `toApiMessages`, not the command)
  - [x] `docs/reports/sdk-0.3.280-migration.md` →
        `docs/specs/sdk-updates/sdk-0.3.280.md` (moved; SKILL.md step 10
        writes future updates there)
  - [x] provenance comments on every transcribed literal (audit
        2026-09-29: `<synthetic>` and the foreign-thinking filter
        (`keepForeignThinking`), the tail fix-up fillers
        (`tengu_filtered_orphaned_thinking_message`,
        `tengu_filtered_trailing_thinking_block`, the `"[Empty text
removed]"` definition), the system-tail joins; the wrapper,
        NEVER_FOLDED, RENDERS_NOTHING and EXTERNAL_STATE anchors were
        already in place). Found while auditing, not modelled: the CLI
        removes empty text blocks and emits `[Empty text removed]` only as
        a spacer between two thinking blocks of a regrouped assistant,
        whereas `fixUpTail` substituted the filler for every empty text —
        fixed (Anton, 2026-09-30: `withEmptyTextsRemoved`, assistants
        only; user empty text is left as is, unverified); the CLI removes only signed/redacted foreign thinking (persisted
        thinking is always signed); its whitespace-only assistant drop
        also treats `(no content)`/`[Empty text removed]` texts as blank
        and allows leading thinking. Deferred until a check trips.
  - [x] `api-messages.ts` → `to-api-messages.ts`; DAG generator change
        reverted, `core/generated/util.ts` edge added (ITD "DAG")
  - [x] `--model` help text; no jargon in help
  - [x] fixtures `attachment after tool_result`, `request-time
reminders`, `mid-conversation system`, `model-gated
mid-conversation system` (2026-09-29). Findings: an unsettled
        tail gets a synthetic continuation turn (Edge cases); the gated
        empty system message carries `output_config: {effort}` (the
        tolerance matches role + empty content only).
  - [x] attachment texts after a tool_result fold into that block
        (`mergeAttachmentTexts`; unit tests for string and array
        content; the `attachment after tool_result` fixture asserts the
        string fold). Not modelled: the CLI keeps poll-event reminders
        and `is_error` results' non-text attachments out of the fold.
  - [x] same-`message.id` assistants regroup across tool-result users
        and system messages (`assistantIndexByMessageId`, cleared by a
        user without a tool_result — the binary's "some tool_result"
        predicate next to `uuid:e.isMeta?n.uuid:e.uuid`). Not modelled:
        the merge's blank-text filter between thinking blocks and its
        tool_use ordering pass.
  - [x] human-turn `queued_command` under mid-conversation system:
        pending user, wrapper stripped (the binary's steer list flushed
        at the next assistant). Not modelled: its `coe` predicate and
        the `tengu_parsed_willow` gate (default on).
  - [x] real-session run, Anton's 2.1.280 session 7b3418a6 (scratch
        copy, `--check`): **116 captured, 116 synthesized, 0 failing, 1
        tolerated** (`external-state-text` at `messages[4].content[0]`;
        was 196 vs 118 with 244 failing).
  - [x] Anton's review of that run: the one tolerated difference was
        mislabelled. `textTolerance` excused the whole block when any
        contribution in it was external-state, and a system block holds
        every attachment since the last assistant; the real difference
        was the join inside a two-text attachment (`"\n"` on the wire —
        the binary's attachment-to-system join before `### Phase 4:
Final Plan` — vs our `"\n\n"`). Fixed both: the tolerance now
        excuses only the contribution's span and requires the captured
        block to share the text around it (unit test `external-state-text
excuses only…`); `pushAttachment` joins one attachment's texts by
        `"\n"` under mid-conversation system. Re-run: **116/116, 0
        tolerated, 0 failing**. `--check` also writes
        `captured-messages.json` (the wire minus the request-time
        content the comparison identified, in the synthesized shape), so
        `diff captured-messages.json synthesized.json` is empty exactly
        when the comparison reports no differences (Anton's TDC).
  - [x] `fallback-text` tolerance removed (Anton, 2026-09-29): `--check`
        only ever runs against sessions written by the current CLI, and
        those carry `rendered` on every rendering attachment (measured on
        7b3418a6: 60 snapshot, 1 external-state, 0 fallback). The
        fallback renderer stays for displaying older sessions; a fallback
        difference under `--check` now fails.
  - [x] `WireContribution` text kind carries `texts: string[]` (Anton):
        the rendering as placed, joins left to the placement, so
        `textTolerance` matches a multi-text attachment in every mode
        (unit test `a multi-text contribution is one span…`).
  - [x] resolved (2026-09-29): the `file` attachment that vanished from
        the wire in the `attachment after tool_result` fixture was
        malformed, not deduped. The transcript loader validates each
        attachment payload by type (`file`/`already_read_file` need a
        `content`; anchor `transcript load: dropped`) and drops failures;
        the fixture had `{ type: "file", filename }` only. With a
        well-formed payload the attachment folds like any other (fixture
        re-run, passes). `already_read_file` is a distinct type chosen
        at attachment creation (readFileState hit or Read returning
        `file_unchanged`), rendering `[]` — already in the renderer
        table. The loader's payload validation is not modelled: the CLI
        writes valid payloads; malformed ones mean a corrupt transcript.
  - [x] fixtures `thinking-only`, `tool call`, `foreign thinking`,
        `branch` added (2026-09-29; all pass first run, 0 failing).
        `compaction` not added: Anton's real-session `--check` runs on
        compacted sessions are the evidence; `multi-part assistant` is
        covered by the regroup unit test and the real-session run. The
        harness gained `parentIndex` on fixture entries for `branch`.
  - [x] six `rendered: null` per-type probes deleted (Anton, 2026-09-29):
        `file (text)`, `edited_text_file`, `nested_memory`,
        `queued_command (human origin)`, `skill_listing` empty,
        `agent_listing_delta`. They recorded the CLI's per-type texts
        (kept in docs/derisk/api-context-view/P0-binary-read.md) and
        passed criterion 2 only through the `fallback-text` tolerance;
        the current CLI never writes `rendered: null` for them.
  - [x] re-run `--check` on real sessions: Anton ran it on sessions
        with compactions (2026-09-29), including the session that built
        this spec
- [x] attachment views (2026-09-30): size moved out of `AttachmentView`
      — it only sees the payload, the rendering is on the entry — into
      `attachmentEntryView.size` = sum of `renderAttachmentEntry` texts,
      entry-local (a cleared tail reminder is 0, like its glyph; Anton).
      Eight per-view `size()`s deleted; `todo_reminder` now 0 instead of
      its content's JSON length; pre-2.1.280 entries size by the
      renderer's fallback guess (single source of truth over precision).
      Summaries: `token_usage` (`used/total; remaining remaining`) and
      `instructions` (last two path segments per file) added, the two
      rows Anton named as noise. Tests: per-view size assertions dropped,
      entry-view test covers snapshot / fallback / renders-nothing.
- [x] tail reminder records modelled (Anton, 2026-09-30: "bugging me
      too much"): `tailReminders` scans the context's trailing attachment
      run for the latest `*_reminder_sent` per type with `clearAt:
    "next_user_message"`; `pushTailReminder` folds its `text` through
      the attachment fold (`foldAttachment`, split out of
      `pushAttachment`), contribution `text`/`snapshot`. Evidence: the
      binary's backwards walk next to `batching_reminder_sent`, the
      survey of this session's file (1005 records, always the last
      attachment before the reply) and the bare line seen live after
      tool results in the session that built this spec. Not in
      `fixUpTail` as first suggested: the fold in entry order puts the
      text where the record sits among the tail attachments, and it
      shares the mid-conversation-system path for free.
- [x] glyph for entries that render nothing in assistant context (Anton,
      2026-09-30: entry space, not API-request space — the entry views
      decide from the entry alone, never via `toApiMessages`; the
      existing OTHER_ENTRY_GLYPH `·`, no new glyph). Done 2026-09-30:
      `attachmentSilentView` (`renderAttachmentEntry(entry) ===
undefined`) and `assistantThinkingOnlyView` in `entryViewFor`;
      `progress` and non-`local_command` `system` entries already
      reached `otherView`; virtual entries classify by shape (no
      `isVirtual` guard). Accepted caveats: a thinking-only sibling of a
      regrouped assistant is kept by the CLI but shows `·`; a
      `queued_command` with `renderedByBatchHead: true` shows `❯` — its
      prompt reaches the assistant through the batch head.
      Criterion 4, Type design, Data flow and Cost reworded:
      `contributions` serves `format api-request`/`--check` only.
- [x] depcruise + presubmit + `npm run test:sdk` (Anton, 2026-09-30,
      after rebasing on the `synthetic-assistant` fix in `main`)
- [x] fresh-context review, cheap batch (2026-09-30): `isSkipped` tests
      `isVirtual` before the `system` subtype (a virtual `local_command`
      converted); whitespace-only assistants dropped by the tail fix-up
      now get `none/empty-content` (contributions were left at
      `message`); the unreachable `[No message content]` filler removed
      (Implementation-Time Decisions); `mergeUserContent` partitions in
      one pass; minified identifiers out of test comments/names; stale
      spec lines and the `attachmentSilentView` comment corrected.
- [x] `--check` tolerance provenance (2026-09-30, the review's High
      findings): `ApiConversion.entryUuidsByMessage`; the external-state
      tolerance attributes by message and locates text by text, reaching
      `tool_result.content`, failing closed on ambiguity; the system
      tail is partitioned before the tolerances (Implementation-Time
      Decisions). Unit tests for duplicate text elsewhere / twice in a
      message, folded string and array content, and the tail boundary
      with a leading or trailing external-state text.

## Implementation-Time Decisions

- **`RenderedBy` is declared in `render-attachment.ts`** and re-exported
  from `api-messages.ts` (the spec listed it under `api-messages.ts`):
  both modules use it and `api-messages.ts` imports the renderer, so
  declaring it at the renderer avoids a type-only import cycle.
- **DAG: `core/generated/util.ts` is an explicit edge; ancestor keys
  are forbidden outside granted subtrees.** `core` is itself a key, so
  without an edge to it `^src/core/` was forbidden wholesale; 54478c7
  "fixed" that by granting an edge's ancestors, which let
  `format/api-messages` reach all of `core`. Now the rule's `to` carries
  `pathNot` = the granted edges, so `core` stays forbidden except
  `core/session/`, `core/uuid.ts`, `core/generated/util.ts`. Anton's
  `.dot` DAG proposal is `docs/follow-ups/dependency-dag-dot.md`.
- **`CapturedApiMessages` is declared in `compare-api-messages.ts`**, not
  in the capture module: `src/` cannot import from `tests/`, and the type
  is the compare utility's input; the capture module imports it.
- **Normalizers report their own `tolerated` entries.** Diffing a
  tolerance's input against its output positionally would attribute the
  whole shifted tail to `empty-system-message`'s drop; each normalizer
  knows exactly what it excused.
- **The captured list is aligned to the conversion's tail shape before
  the tolerances run.** With no conversion user before the system tail,
  the prompt-turn message would shift the tail by one position and the
  text tolerances (positional) would placeholder only one side. The cost:
  a trailing attachment the conversion dropped entirely lands in
  `requestTime.promptTurnBlocks` (visible in `comparison.json`), not in
  `failing` — request-time blocks are not recognizable by content.
- **Text tolerances attribute by message, then locate by text.**
  `ApiConversion.entryUuidsByMessage` (carried through the tail fix-up's
  drops and merges) names the entries behind each message; the compare
  utility takes the external-state `texts` of those entries and locates
  each among the message's text slots — text blocks, a tool_result's
  string content (where the placement trimmed it), the text parts of its
  array content. A text found in no slot, in several, or twice in one is
  left alone (fail closed: the strict compare reports it). All of a
  slot's located texts are then matched at once: the literal text
  before, between and after them must appear verbatim in the captured
  slot (`matchWildcards`, anchored at both ends), the wildcards' content
  is what `tolerated` reports. A changed join next to a wildcard is
  taken up by that wildcard (reported, not failing): wildcards cannot
  verify their own edges. Block-level provenance
  (`contributionByMessageBlock`) is not needed.
- **The system tail is partitioned before the tolerances run.** The
  synthesized trailing system text, its external-state texts as
  non-greedy wildcards, is matched as a prefix of the captured tail
  followed by `"\n\n"` + request-time text or the end
  (`partitionSystemTail`); only the matched part enters the comparison.
  A synthesized text ending in a wildcard leaves the boundary
  undecidable and fails rather than guessing. Known limitation: a
  wildcard whose captured content itself contains the following literal
  resolves to the earliest match, so a changed persisted text after it
  can be misfiled as request-time — visible in `comparison.json`
  (`requestTime.systemText`), not in `failing`. Failing closed instead
  would reject every tail holding a `deferred_tools_delta`.
- **Renderer fidelity downgrades** (the text is still the best available,
  but `renderedBy: "fallback"` marks it unverified where the CLI's output
  depends on request-time state): `file` with `truncated: true` (the note's
  line budget is a CLI constant not transcribed); `queued_command` of
  non-human origin. Kept as `"renderer"` with a known gap: `directory`
  does not reproduce the CLI's shell quoting of unusual paths in the
  synthetic `ls` command; `deferred_tools_delta` omits the
  surfaced-name filtering and the retracted-definitions paragraph (both
  request-time state) — `renderedBy: "external-state"` in the
  restructure (tolerance `external-state-text`).
- **User merges follow the CLI's two merge functions, not "a user
  following a user merges"** (binary, loader chunk @201,296,300 and
  `CM`/`p5t`/`Zie` @201,297–299k; confirmed by the `file` SDK fixture
  capture): rendered attachment messages join a trailing user message
  through the attachment merge (`p5t`/`f3t`/`r0e`: text attachments
  fold into a final tool_result block's content, else append as blocks,
  no seam newline), but with no trailing user each rendered text becomes
  a user message of its own; prompts, tool-result users and local-command
  output merge with `CM` — a newline is appended to the seam text block
  and tool_results are hoisted; the tail-pass merge of all adjacent users
  (`Zie`) runs only after a thinking-only drop removed something. The
  builder therefore keeps prompts and
  local-command outputs _pending_ until the next assistant, tool-result
  user or the end (the CLI moves attachments before them), which
  replaces the earlier block-index slot bookkeeping.
- **`tool_use` blocks keep only `type/id/name/input`** (`xAt`
  @201,276,416 drops the file's `caller` annotation).
- **`[No message content]` is not produced**: the CLI's filler for a
  last assistant emptied by the trailing-thinking strip is unreachable
  once all-thinking assistants are dropped first, as the CLI does. An
  assistant persisted with empty content takes `(no content)`; it is
  not "thinking-only" (the CLI drops only non-empty all-thinking
  groups).
- **Tail fix-up is one rebuild pass plus the last-assistant strip**: the
  strip needs the whole list, and the whitespace-only/empty-assistant
  fillers must run after it, hence a second short pass over the kept list.
