# Findings: session entries → API request (SDK 0.3.280 / CLI 2.1.280)

Evidence classes: **wire** = request body captured by
`scripts/capture-api-request.ts` (answering shim; nothing forwarded);
**source** = minified CLI read in `P0-binary-read.md`. Captures live in
`/tmp`; only shapes and short samples are recorded here.

## P1 — oracle validity (wire)

- Forwarding shim vs answering shim, same session, same options: request
  bodies identical. The request is built before any response; answering
  locally changes nothing.
- Scratch config vs `--real-config`: identical except the config-dir
  path in the "Contents of …/CLAUDE.md" and "…/memory/MEMORY.md" header
  lines. Mirrored allowlist: `CLAUDE.md`, `settings.json`, `skills/`,
  `agents/`, `projects/<key>/memory/` for the cwd and the main worktree
  root, `todos/<sessionId>*`.
- Real credentials unchanged after scratch runs (never-expiring seed).

## First shapes (wire, 13-entry session, to be confirmed by P2)

- Body: `model`, `system` (2 text blocks: billing header line, the system
  prompt), `tools` (11), `messages`, `metadata.user_id`.
- `messages` roles in order: user, **system**, assistant, user, **system**.
  The system-role messages are the "deferred tools available via
  ToolSearch" notice and the `# Environment` block; neither corresponds
  to a session entry.
- The first user message carries `ide_selection` as its own text block
  (`<ide_selection>…</ide_selection>`) before the prompt text; the new
  prompt's user message carries the CLAUDE.md/memory reminder, the
  userEmail reminder and the git-attribution reminder as text blocks
  before the prompt.

## P2 — structure on a real session (wire; 91-entry session with 5 compact

boundaries, one thinking block, three tool turns; loader context 23 entries →
20 outgoing messages)

- **Entry → message mapping.** Every user prompt, tool_result entry and
  assistant entry in the loader context became one outgoing message in
  context order; nothing outside the loader context appeared (the
  `queue-operation`, `last-prompt`, `mode`, `atis-latch`, `system` entries
  and the pre-boundary entries are absent). Stages 1–4 as implemented by
  `loadedContext` predict the non-attachment part of the wire exactly.
- **Attachments render as `role: "system"` messages with string
  content**, placed where the attachment sits in the context, text wrapped
  in `<system-reminder>\n…\n</system-reminder>`. Not user-role/isMeta as
  `attachment-types/FINDINGS.md` assumed.
  - `deferred_tools_delta` → rendered ("The following deferred tools are
    now available via ToolSearch…").
  - `total_tokens_reminder` → rendered from `attachment.text` verbatim
    inside the wrapper; NOT deduplicated: all 6 instances in context
    appeared, each with its own value. The first (`15000000`) shares one
    outgoing system message with the `deferred_tools_delta` notice: the
    attachments between the first prompt and the first assistant turn
    fold into a single system-role message (P0 `qw`: accumulate, flush at
    the next assistant).
  - `agent_listing_delta` ("Available agent types for the Agent tool:")
    and `skill_listing` ("The following skills are available for use with
    the Skill tool:") → rendered, folded into the same first system-role
    message as the two above (an earlier pass of this doc missed them by
    reading only the message head). `auto_mode` → not on the wire.
- **Two system-role messages correspond to no entry**: the `# Environment`
  block (last message, after the new prompt) and — when no
  `deferred_tools_delta` entry exists (13-entry session) — the
  deferred-tools notice; both are `<system-reminder>`-wrapped.
- **New prompt's user message**: text blocks in order — CLAUDE.md +
  memory reminder, userEmail reminder, git-attribution reminder, then the
  prompt text. Same in both sessions.
- **Thinking**: the assistant history block was sent as
  `{type: "thinking", thinking: "", signature: <388 chars>}` — but the
  session file already stores `thinking: ""` for that entry, so whether the
  CLI strips text is not observable here; the signature is passed through.
- **Parallel tool calls**: not present in either session; still open.
- **Parallel tool calls (second real session, 98 entries, loader context
  75 → 45 outgoing messages)**: an assistant turn persisted as four
  entries (two thinking, two tool_use, one `message.id`) became one
  outgoing assistant message `[thinking, thinking, tool_use, tool_use]`
  and its two tool_result entries one user message
  `[tool_result, tool_result]`; every multi-entry turn regrouped the same
  way (stage 5 reassembly by incoming id, as FINDINGS "load pipeline"
  states). Thinking blocks in history pass through with their signatures.
  This session's context had no `total_tokens_reminder`; its only
  system-role messages were the deferred-tools notice and `# Environment`.

## P0 — source reading, reconciled with the wire

Full table and offsets: `P0-binary-read.md`. What the wire above confirms
or refines:

- **Two rendering modes.** Natively every rendered attachment is a
  `user` entry wrapped in `<system-reminder>` (`isMeta` internal only).
  In _mid-conversation-system mode_ (per-model gate; on for the models
  captured here) the wrapper is stripped, consecutive attachment texts are
  accumulated and flushed at the next assistant message as one
  `{role: "system"}` message. Both captured sessions are in that mode,
  which is why the wire shows system-role messages and why the first
  slot's `deferred_tools_delta` + `total_tokens_reminder` became one
  message. Some types never fold (`queued_command`, `session_context`,
  `instructions`, …) and stay user-role. The conversion model must carry
  the mode as an input.
- **Persisted `rendered`.** 2.1.280 writes `rendered: [{content}]` on
  many attachment entries at creation and replays it instead of
  re-rendering (`tae`); `deferred_tools_delta` re-renders when surfaced
  names changed. Locally, 2.1.280 sessions carry `rendered` on roughly
  60–70% of attachment entries and `null` on the rest; pre-2.1.280
  sessions have none. The model therefore needs both paths: replay when
  present, else the per-type renderer.
- **Placement.** Attachments are moved to right after the nearest
  preceding assistant/tool-result message, i.e. before a following plain
  user prompt, then merged into the preceding user message (SR text as its
  own block, tool_results hoisted first). Wire: consistent — every
  attachment message sits between a tool_result/assistant and the next
  turn.
- **Never rendered** (`[]` in the switch): `auto_mode` and 24 other
  explicit no-ops plus 16 unhandled types — matches the wire.
  `skill_listing` renders unless empty; `agent_listing_delta` renders.
- **Entries never sent**: progress, system (except local_command),
  virtual user/assistant, synthetic api-error assistants, empty-content
  users. `local_command` output goes as a plain user message.
- **Thinking**: signed blocks sent verbatim (no signature-only form);
  trailing thinking of the last assistant stripped; thinking-only turns
  dropped unless a same-id sibling has content (the p19 drop, now located
  in stage 5); foreign-model thinking removed by default. Wire: signature
  passed through; the empty text is the file's own.
- **`# Environment` and the deferred-tools notice** are attachments
  (`environment`, `deferred_tools_delta`) or generated at request time;
  both fold to system in mid-conversation mode. Nothing from the entry
  chain lands in the `system` parameter.

## P3 — spot checks (wire, SDK tests)

`tests/sdk/api-context.test.ts`: one synthetic three-entry session per
type (prompt, HAIKU text reply, attachment with `rendered: null` and a
nonce in its text fields), resumed under HAIKU (scratch `settings.json`
pinned) against the answering shim; the body carrying the probe prompt is
inspected. "SR user block" = a `<system-reminder>`-wrapped text block of
the user message that carries the new prompt. All 11 tests pass.

| type                           | on the wire                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file` (text)                  | SR user block `Result of calling the Read tool:\n1\t<content>` (line-numbered), preceded by an SR block `Called the Read tool with the following input: {"file_path":…` |
| `edited_text_file`             | SR user block `Note: <filename> changed on disk since you last read it. …` + snippet                                                                                    |
| `nested_memory`                | SR user block `Contents of <content.path>:\n\n<content.content>`                                                                                                        |
| `queued_command` (human)       | SR user block `The user sent a new message while you were working:\n<prompt>\n\n…`                                                                                      |
| `todo_reminder`                | nothing (nonce absent from the whole body) — the P0 gate `WS()\|\|!e$()` is open in the SDK path; semantics still untraced                                              |
| `total_tokens_reminder`        | SR user block, `text` verbatim                                                                                                                                          |
| `skill_listing` (`content:""`) | nothing                                                                                                                                                                 |
| `agent_listing_delta`          | **rendered**: SR user block `Available agent types for the Agent tool:\n- …` (isInitial). P2's "absent" holds for real sessions, not for the renderer.                  |

- **Default mode for HAIKU is the native one**: every rendered type above
  is an SR user block merged into the prompt's user message; no
  `role: "system"` message appears. With
  `CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM=1` the same
  `total_tokens_reminder` becomes a `role: "system"` message with
  **block** content (not a string), wrapper stripped, placed last —
  after the prompt — and joined (`\n\n`) with the request-time
  `# Environment` text. The env can only force on; the P2 sessions ran
  under the user's default model, which explains their system-role shape.
- **`rendered` replay is verbatim**: with `rendered: [{content}]` the
  snapshot text goes out as the block, unwrapped, and the payload `text` is
  absent — so persisted snapshots already carry whatever wrapper they were
  rendered with.
- **Resume adds its own `agent_listing_delta`**: the fixture's agent type
  reappears in the CLI's request-time delta as "no longer available", so
  the nonce occurs twice in that body.
- Not covered (three-capture lifetime fixtures per the README's P3): only
  one instance per type was captured; supersession/dedup remains P0-only.

## Consequences for the conversion spec

- **The fold mode is an input, not a derivation.** Whether attachments
  reach the wire as `role: "system"` messages or as `<system-reminder>`
  user blocks is decided by `kw`: HIPAA → off; env
  `CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM` → on (force-on only; there
  is no force-off); remote flag `mid_conv_system` (statsig, suppressed
  under essential-traffic mode); model rules; else provider default. None
  of that is persisted in the session file (the fold's `api_system`
  entries never are). `get-context --api` therefore needs the mode as a
  setting/flag and can be exact only relative to it.
- **Two rendering paths.** Replay `rendered` when present; otherwise the
  per-type renderer from `P0-binary-read.md`. Pre-2.1.280 sessions always
  take the second path.
- **Placement precedes folding.** Attachments move after the nearest
  preceding assistant/tool-result before either mode renders them, so the
  entry order in the loader context is not the outgoing order.
