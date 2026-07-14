# Spec: `clauctl format` — human/LLM-readable rendering of JSON output

> Status: **spec approved, not yet implemented.** Supersedes the `format` half of
> `docs/specs/convenience-commands.md` (`completion` remains there). Phase-4 item
> in `docs/implementation-plan.md`.

## SPEC (stable requirements)

### Problem

clauctl's message-carrying commands emit verbose JSON: `tail` emits JSONL of
`{snapshot: StateSnapshot}` / `{event: SdkEvent}` records, and `get-messages`
emits the transcript segment as `SessionMessage`s. Neither is pleasant for a
human — or economical for an LLM — to read. `clauctl format` is a pure filter
(file arg or stdin, plain text to stdout) that renders them readably.

### Command surface

A `format` routemap with two subcommands (a third, `format tree`, is deferred
until `get-tree` exists — see `docs/specs/session-tree-and-set-context.md`):

- **`clauctl format messages [file]`** — formats `get-messages` output (JSONL,
  one `SessionMessage` per line) and, in the future, `get-entries` output
  (verbatim session-file entries). Emits **inferred change lines**: a model
  change detected from consecutive assistant entries' `.message.model`, and a
  permission-mode change deduped from verbatim `permission-mode` entries
  (which the CLI writes identically every turn).
- **`clauctl format events [file]`** — formats the `tail` stream. Same
  `SDKMessage` rendering; daemon-synthesized events (`userMessageQueued`,
  `userMessageDequeued`, `compactSent`, `interruptSent`, `controlApplied`)
  and the subscribe snapshot render as explicit one-line annotations.

Both: `[file]` optional, `-` or absent = stdin. Flags (shared):

- `--tool-results summary|none|full` (default `summary`)
- `--max-tool-arg-chars <num>` (default 120)
- `--max-error-lines <num>` (default 10)

Feeding `tail` output to `format messages` (or message-shaped input to
`format events`) fails with a `UsageError` pointing at the other subcommand.

### Scope changes to existing commands

- **`get-messages` prints JSONL** (one `SessionMessage` per line) instead of a
  pretty-printed JSON array. The socket protocol is unchanged (response data
  stays `SessionMessage[]`); only the CLI printing changes.
- `tail` stays raw JSONL; its TODO about flipping to formatted-by-default (and
  `query` likewise) is a **later spec**.

### Rendering rules

pictl's `format messages` conventions, no ANSI/color ever (the output is
consumed by LLMs; color is noise):

- `user` / `assistant` render **fully**: `== user ==` / `== assistant ==`
  headers, text verbatim, `[thinking]` marker (content elided),
  `[tool:Name key: value]` for tool calls (preferred keys `path`, `file_path`,
  `command`, `pattern`; else truncated JSON), records separated by blank lines.
- A `user` message whose content carries `tool_result` blocks renders those as
  `[Name:ok 12 lines, 340 bytes]` summaries (errors additionally show up to
  `--max-error-lines` of the result text; `full` shows everything; `none`
  drops them). The tool *name* comes from the preceding assistant message's
  `tool_use` block with the matching id — the formatter memoizes id→name
  across the stream.
- `result` renders as a one-liner: subtype, num_turns, duration, cost.
- **Dropped entirely** (rendered as nothing): `stream_event` partials,
  `user` replay variants, `system/init`, `rate-limit` events. (Expect this
  list to grow; anything noisy-and-worthless gets demoted here.)
- **Every other `SDKMessage` variant** renders as a generic one-line
  annotation derived from its `type`/`subtype` fields — no per-variant
  renderers for the long tail.
- Inferred change lines (messages mode): `[model: old -> new]` **only on
  change**, not for the first assistant message; `[permission-mode: old ->
  new]` likewise (only reachable on verbatim `get-entries` input, since
  `getSessionMessages` filters those entries out).
- Unknown session-record types (`attachment`, `file-history-snapshot`, …) are
  skipped silently.
- Events mode extras: the snapshot renders as a short header (assistant
  state, model, permission mode, session id, then one `[queued #N: text]` /
  `[delivered #N: text]` line per snapshot queued/delivered message).
  `userMessageQueued` → one-line truncated `[queued #N: text]`, but the full
  `SDKUserMessage` is remembered (snapshot `queuedMessages` seed the same
  store); `userMessageDequeued` → `[dequeued (turn|steer|append): #N, …]`
  followed by the **full user render** of each remembered message — the full
  text appears where it logically enters context, while the queued line
  preserves when it arrived. An id with no remembered message (shouldn't
  happen given the snapshot seed) degrades to the annotation alone.
  `compactSent` → `[compact sent]`, `interruptSent` → `[interrupt sent]`,
  `controlApplied` → `[control: set-model claude-opus-4-8]`-style one-liners
  derived from the mutation record.

### Example

`clauctl get-messages A | clauctl format messages`:

```
== user ==
Fix the failing test in src/foo.test.ts

== assistant ==
[thinking]
The assertion is stale after the rename.
[tool:Read file_path: src/foo.test.ts]

[Read:ok 42 lines, 1337 bytes]

[model: claude-fable-5 -> claude-opus-4-8]

== assistant ==
Renamed the symbol in the assertion; the test passes.
```

`clauctl tail A | clauctl format events` (excerpt):

```
[snapshot: idle, model claude-fable-5, permissions auto, session 28972c69]

[queued #3: rerun the tests and tell me whether the timeout in foo.test.ts is…]

[dequeued (turn): #3]
== user ==
rerun the tests and tell me whether the timeout in foo.test.ts is still
flaky, or whether the retry fixed it

== assistant ==
[tool:Bash command: npm test]

[Bash:ok 34 lines, 2101 bytes]

[result: success, 1 turn, 12.3s, $0.0421]
```

### Type design

New directory `src/format/` (a non-core part of the CLI, not part of the TUI;
importing from `src/tui/` is acceptable).

**`src/format/generated/text.ts`** — pictl's pure text helpers (`oneLine`,
`truncateText`, `countLines`, `extractTextContent`, `summarizeUnknown`,
`summarizeContentBlock`), synced from pictl by `scripts/sync-from-pictl.mjs`
(extended to support a second source/output directory pair), never edited here.

**`src/format/types.ts`**

```ts
export interface MessageFormatOptions {
  toolResults: "summary" | "none" | "full";
  maxToolArgChars: number;
  maxErrorLines: number;
}

/** One line of `format messages` input: a SessionMessage or a verbatim
 * session-file entry (future get-entries). Lenient: only `type` is
 * required; unrecognized types are skipped. */
export type SessionRecord = Record<string, unknown> & { type: string };

/** One line of `format events` input: tail's framing. */
export type TailRecord = { snapshot: StateSnapshot } | { event: SdkEvent };
```

**`src/format/input.ts`**

TDC: does it make sense to move pictl's readInputFile and parseJsonlInput into a separate file so that we can exactly copy with sync-from-pictl?
```ts
export async function readInputFile(context: CommandContext, file: string | undefined): Promise<string>;
export function parseJsonlInput(input: string): readonly unknown[]; // UsageError with line number
export function parseSessionRecords(input: string): readonly SessionRecord[]; // {snapshot|event} shape → UsageError suggesting `format events`
export function parseTailRecords(input: string): readonly TailRecord[]; // message shape → UsageError suggesting `format messages`
```

**`src/format/messages.ts`** — shared `SDKMessage` rendering + inference:

```ts
/** Mutable rendering context threaded through a whole stream: tool_use id →
 * tool name (results are named by their call), last-seen model /
 * permission mode (for inferred change lines). */
export interface FormatState {
  toolNames: Map<string, string>;
  /** Full text of queued prompts, rendered at their dequeue (events mode);
   * seeded from the snapshot's queuedMessages. */
  queuedMessages: Map<number, SDKUserMessage>;
  lastModel?: string;
  lastPermissionMode?: string;
}
export function newFormatState(): FormatState;

/** Render one SDK message; undefined = dropped. Calls
 * renderAssistant/toolResultsOf/userText from src/tui/sdk-render.ts. */
export function formatSdkMessage(message: SDKMessage, state: FormatState, options: MessageFormatOptions): string | undefined;

/** Whole-input formatter for `format messages`; calls formatSdkMessage. */
export function formatSessionRecords(records: readonly SessionRecord[], options: MessageFormatOptions): string;
```

**`src/format/events.ts`**

```ts
/** Whole-input formatter for `format events`; calls formatSdkMessage for
 * sdkMessage events, renders the snapshot header and daemon-event
 * annotations itself. */
export function formatTailRecords(records: readonly TailRecord[], options: MessageFormatOptions): string;
```

**`src/format/command.ts`**

```ts
export const formatRoute: RouteMap<CommandContext>; // routes: messages, events
```

**Modified files:**

- `src/core/app.ts` — register `formatRoute`.
- `src/core/sdk-commands.ts` — `get-messages` gets its own `func` printing the
  response array as JSONL (leaves `bareRequestCommand`).
- `src/tui/sdk-render.ts` — header comment updated (shared by TUI and format);
  no code changes.
- `scripts/sync-from-pictl.mjs` — generalize the single `SHARED_FILES` set to
  source/output directory pairs; add `src/format/text.ts` →
  `src/format/generated/text.ts`.

### Success criteria

- `clauctl get-messages A | clauctl format messages` renders a real transcript
  per the rules above; `clauctl tail A | clauctl format events` renders a live
  stream including queue/control annotations.
- `get-messages` output is JSONL; each line parses as a `SessionMessage`.
- Wrong-subcommand input fails with the cross-pointing `UsageError`.
- Unit tests cover: full user/assistant rendering, tool-result naming via the
  id→name map, all three `--tool-results` modes, error-result snippets,
  model-change inference (change vs. no change vs. first message),
  permission-mode dedup, dropped variants produce nothing, generic one-liner
  fallback, snapshot/queue/control annotations, and both UsageError paths.
- `node scripts/sync-from-pictl.mjs --check` passes.

### Non-goals

- `format tree` (waits for `get-tree`).
- Formatted-by-default `tail`/`query` (later spec; raw stays default).
- Formatting passthrough reads (`usage`, `supported-models`, …) — they stay JSON.
- Color/ANSI output, `--timestamps` (entries carry timestamps; easy later add).
- Streaming/incremental formatting — v1 reads the whole input, but the
  per-record `FormatState` design must not preclude a streaming caller later.

## IMPLEMENTATION IDEAS (evolving)

Derisk findings (empirical, from real session files and pictl source):

- `getSessionMessages` (backing `get-messages`) returns only
  `user | assistant | system` entries; the raw session file additionally has
  `permission-mode`, `mode`, `attachment`, `file-history-snapshot`,
  `last-prompt`, `ai-title`, `agent-name` entries. Those reach the formatter
  only via the future `get-entries` — hence lenient decoding, and
  permission-mode inference is dead code until then.
- `permission-mode` entries are written unconditionally every turn (identical
  repeats, no uuid/timestamp) — rendering them requires dedupe-on-change.
- Every assistant entry carries `.message.model` — model-change inference.
- Thinking *level* is not recorded in the transcript at all (only thinking
  blocks), so it is not inferable in messages mode; in events mode it is
  explicit via `controlApplied: set-max-thinking-tokens`.
- User/assistant/system entries carry `timestamp` — a `--timestamps` flag is
  feasible later.
- Strict pictl-style validators were considered and rejected: verbatim session
  entries drift with Anthropic's CLI versions, and `format` should not break
  on unknown fields/types.
- pictl's `text.ts` is import-free, so the sync-script port is mechanical.
- The `SDKMessage` union has ~35 variants; per-variant renderers for the long
  tail is over-implementation — the generic `type`/`subtype` one-liner covers
  them, and specific variants can be promoted (or demoted to dropped) later.
- A `SessionRecord` with type `user`/`assistant` narrows to `SDKMessage` by
  cast, the same narrowing `historyToSdkMessages` (sdk-render.ts) already
  performs — a `SessionMessage` carries every field the variant requires.

## WORK LOG

**Instructions**: Update this section during each work session. Add new tasks,
mark completed ones with [x], document decisions and problems encountered.

- 2026-07-14: Derisk discussion with Anton; all design decisions above
  approved (command shape, scope, rendering rules, type design, get-messages
  JSONL flip, text.ts via sync script). Spec written.
- 2026-07-14: Critique pass. Fixed `MessageDelivery` variants (turn|steer|
  append). Resolved the prompt-visibility question with Anton: prompts on the
  tail stream only appear as `userMessageQueued` events, so queued renders as
  a truncated one-liner and the full text renders at `userMessageDequeued` —
  where it logically enters context. `FormatState` gained `queuedMessages`.
