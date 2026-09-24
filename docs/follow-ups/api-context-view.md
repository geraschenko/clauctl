# What the assistant actually sees: `get-context --api`

Follow-up from the entry-views review (`git show 06208c5`, TDC in
`src/format/entry-view/attachment-view/file.ts`): the attachment size column is "approximate
model-visible chars" (`docs/specs/entry-views.md`), computed from payload
fields chosen by reading `docs/derisk/attachment-types/FINDINGS.md` — the
payload-key table, not observation of the outgoing request. Nobody has
verified which attachments reach the model, how the CLI renders them, or
when they drop out.

## Goal

Model the CLI's session-file → API-request conversion explicitly and expose
it as `clauctl get-context --api` (flag name open): the output is our best
guess of the request the assistant receives — parallel tool calls grouped
into one assistant message with their results in one user message,
attachments "rendered" into the text the CLI puts them in, entries the CLI
never sends omitted. Existing `get-context` behavior
(`docs/specs/get-context.md`, `docs/specs/loaded-context.md`) stays as the
session-file view.

## Derisk (to do, not done)

Build a small tool that replays a real session through the CLI behind
mitmproxy and captures the outgoing `/v1/messages` request body. Then, from
request bodies alone:

1. For every attachment type in FINDINGS: is it in the request? As which
   role/block? Wrapped how (`<system-reminder>`, tags, prefixes)? Where does
   its text come from (`content.file.content`, `snippet`, `content.content`,
   `text`, …)?
2. When does an attachment disappear (next turn, after compaction, never)?
   Which are deduplicated (repeated `total_tokens_reminder`,
   `todo_reminder`)?
3. Message grouping: parallel tool_use blocks → one assistant message;
   tool_results → one user message; where user text lands alongside
   results.
4. Which entries never appear (`system`, `progress`, `queued_command`,
   `file-history-snapshot`, …).
5. Thinking blocks: sent back verbatim, as signatures, or dropped?
6. System prompt vs. history: what is in `system` and what is in
   `messages`.

Constraints: never commit or copy session files from `~/.claude/projects`;
capture into `/tmp` and record only shapes and short samples in a FINDINGS
doc (`docs/derisk/api-context/`).

## Consequences once known

- Attachment `size` in the entry views becomes exact (same rendering code),
  and `file.ts`'s field choice is justified or corrected.
- A single conversion module (session entries → API messages) serves
  `get-context --api`, the size column, and any future "what the model saw"
  display — one implementation, per the single-source-of-truth rule.

## Open questions

- Flag name and output format (JSON request body vs. `format messages`-style
  text).
- Where the conversion lives (core/session next to the loader is the
  natural home; it must stay free of tui imports — see
  `docs/follow-ups/format-tui-layering.md`).
- CLI-version drift: the conversion mirrors CLI internals and must be
  re-derisked on SDK/CLI bumps (see the sdk-migration memory notes for the
  binary re-read routine). The facts we learn about how the API request is made
  should be encoded in sdk tests so that we know if we have to update the
  implementation when we bump the sdk version.
