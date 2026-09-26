# Derisking: session entries → the API request the assistant receives

Plan for the derisk phase of
[`docs/follow-ups/api-context-view.md`](../../follow-ups/api-context-view.md).
The end product of that follow-up is a conversion module (session entries →
API `messages`) exposed as `get-context --api` and reused for attachment
sizes and any "what the model saw" display. This plan builds the oracle the
conversion will be checked against and runs the probes that tell us what to
implement; the conversion itself gets its own spec once
[`FINDINGS.md`](FINDINGS.md) exists.

# SPEC

## Problem

`get-context` returns the loader's context: the session entries the CLI
presents on resume. The CLI turns those entries into a `/v1/messages`
request by grouping parallel tool calls and results, rendering attachments
into text, and dropping entries it never sends. The entry-level part of
that pipeline is known: stages 1–5 in
[`compact-boundary-injection/FINDINGS.md`](../compact-boundary-injection/FINDINGS.md)
("The load pipeline") give relink, leaf walk, expansion, resume
sanitization and request normalization, wire-verified for tool pairing and
message regrouping, and `loadedContext` implements stages 1–4. What is not
known is the _content_ side of stage 5 — how each attachment type is
rendered (or not) into outgoing message text, when an earlier instance is
superseded, what happens to thinking blocks — and the outgoing shapes
attachments produce; the attachment size column in the entry views is
computed from payload keys guessed from
[`attachment-types/FINDINGS.md`](../attachment-types/FINDINGS.md).

We want a reproducible way to capture, for any session file and any point in
it, the exact request the CLI would send if the user typed a prompt there —
without sending a real request and without touching the session file — and
a set of probes that use it to answer the follow-up's six questions.

## Deliverables

1. `scripts/capture-api-request.ts` — the oracle. Given a session file (and
   optionally a uuid to stop at), it prints the request body the CLI builds
   for a probe prompt sent at that point.
2. `tests/sdk/answering-shim.ts` — the answering shim, a local stand-in for
   `api.anthropic.com` that records requests and answers them itself
   (nothing is forwarded); `tests/sdk/resumable-session.ts` — the
   resumable-session constructors the oracle and the P3 tests share;
   `tests/sdk/capture-inference-request.ts` — their composition.
3. Probes P0–P3 below, as `.mjs`/`.ts` files in this directory, whose
   results are recorded in `FINDINGS.md` (shapes and short samples only).

## Success criteria

1. Running the oracle on a session file leaves the file byte-identical; in
   the default (scratch) mode nothing under `~/.claude` changes and no
   request reaches Anthropic in either mode.
2. P1 shows the answering shim and the forwarding shim
   (`compact-boundary-injection/shim.mjs`) capture identical request bodies
   for the same session and prompt, and that scratch mode and
   `--real-config` mode capture identical bodies (identical after removing
   the probe nonce and any per-run ids). A scratch/real difference names
   something missing from the mirrored allowlist.
3. `--at UUID` reproduces the request for the prefix ending at the _first_
   line carrying that uuid.
4. `FINDINGS.md` answers, with evidence (request excerpts, which probe, CLI
   version), each of the follow-up's questions: attachment rendering per
   type, attachment lifetime and deduplication, message grouping, omitted
   entry types, thinking blocks, system-vs-messages split.
5. Every probe runs with the telemetry policy and permission policy of
   [`docs/derisk/AGENTS.md`](../AGENTS.md) and asserts the pinned CLI/SDK
   versions (`assertVersions`).

## Oracle contract

```
node scripts/capture-api-request.ts <session.jsonl> [--at UUID] [--prompt TEXT] [--out FILE] [--real-config]
```

- Scratch mode (default): copies the session into a scratch config dir at
  `projects/<projectKey(cwd)>/<sessionId>.jsonl`, where `cwd` and
  `sessionId` come from the file's entries. With `--at`, the copy is the
  prefix up to and including the first line whose `uuid` is `UUID`
  (later re-persistences of the same uuid are a different session state).
  Fails if `cwd` no longer exists: the CLI reads `CLAUDE.md`, git state and
  skills from it, and a different cwd would change the request.
- The scratch config dir mirrors the parts of `~/.claude` that shape the
  request, on top of what `makeConfigDir` seeds (credentials,
  `.claude.json`): `CLAUDE.md`, `settings.json`, `skills/`, `agents/`,
  `projects/<key>/memory/`, and `todos/` entries for the session id. Hooks
  and MCP servers configured there run for real (a hook must tolerate
  running again; the CLI would run it too). The oracle prints the mirrored
  paths on stderr.
- `--real-config` mode (P1's allowlist check; not combinable with `--at`):
  runs against `~/.claude` itself with only `ANTHROPIC_BASE_URL` overridden.
  Before the run the session file is backed up to `/tmp` and its byte
  length recorded; after the run the file is truncated back to that length
  (the CLI only appends) and compared with the backup. The CLI's other
  writes (`history.jsonl`, `todos/`, `.claude.json`) are left in place —
  this mode is for one-off comparison, not routine capture.
- Starts the answering shim, runs the SDK `query({ prompt, resume:
  sessionId, cwd, env: baseEnv(configDir, { ANTHROPIC_BASE_URL }) })` with
  the default or given prompt (default: `Reply with exactly the word pong.
  (tag: <nonce>)`), and selects the `/v1/messages` request whose `messages`
  contain the nonce. Side requests (`count_tokens`, titling, telemetry) are
  recorded but not selected.
- stdout: the selected request body as JSON (the full body: `system`,
  `tools`, `messages`; slice with `jq`), or the file named by `--out`.
- stderr: SDK version, mirrored paths, an "unsettled prefix" note when
  `--at` stops mid tool-turn, the number of requests captured.
- Exit 1 if no request containing the nonce was captured; the shim's
  recorded requests are dumped to stderr in that case.

## Type design

The capture machinery lives in three files next to `tests/sdk/harness.ts`
(scratch config dir, telemetry env, version assertion):
`tests/sdk/answering-shim.ts` (the shim), `tests/sdk/resumable-session.ts`
(a session file placed where the CLI finds it on `resume`; imports
`src/core` for session parsing and the loader) and
`tests/sdk/capture-inference-request.ts` (`captureInferenceRequest`, the
composition of the two). All throw on usage errors.
`scripts/capture-api-request.ts` is the thin CLI over them (arg
parsing, exit codes, output); `tests/sdk/api-context.test.ts` (P3) is its
other consumer. Nothing in `src/` changes. One harness change:
`makeConfigDir` gains an option for how credentials are seeded —
`{ credentials: "copy" | "never-expiring" }` (default `"copy"`, today's
behavior with the near-expiry refusal; `"never-expiring"` copies with
`expiresAt` set far ahead and skips the refusal).

```ts
// tests/sdk/answering-shim.ts
export interface CapturedRequest {
  path: string;
  headers: Record<string, string>;   // authorization / x-api-key / cookie redacted
  body: unknown;                     // parsed JSON, or { unparsed: string }
}
export interface AnsweringShim {
  port: number;
  requests: CapturedRequest[];       // in arrival order
  close(): void;
}
/** Listens on 127.0.0.1; answers /v1/messages with a minimal synthetic SSE
 *  stream ending in stop_reason end_turn, everything else with an empty
 *  200; forwards nothing. */
export function startAnsweringShim(): Promise<AnsweringShim>;

// tests/sdk/resumable-session.ts
/** A session file placed where the CLI will find it on `resume`, with the
 *  env to run the CLI in and `restore()` to undo the placement. */
export interface ResumableSession {
  env: NodeJS.ProcessEnv;            // CLI env; scratch mode sets CLAUDE_CONFIG_DIR, real-config mode leaves the shell's
  cwd: string;
  sessionId: UUID;
  entries: SessionEntry[];           // the placed prefix
  restore(): void;                   // real-config mode: truncate to the recorded length and verify; scratch mode: no-op
}
/** A prefix copy in a scratch CLAUDE_CONFIG_DIR (makeConfigDir + mirrored
 *  allowlist): the prefix of sessionFile through the first line with uuid
 *  `at` (whole file when undefined). Throws when the session's cwd does
 *  not exist. */
export function scratchResumableSession(sessionFile: string, at: UUID | undefined): ResumableSession;
/** The session file in place in the user's own ~/.claude; backs it up to
 *  /tmp and records its length so restore() can truncate the appended
 *  lines back. */
export function realConfigResumableSession(sessionFile: string): ResumableSession;

// tests/sdk/capture-inference-request.ts
/** One SDK turn against the shim; the /v1/messages request whose messages
 *  contain `nonce`, or undefined. Calls startAnsweringShim, query. */
export async function captureInferenceRequest(resumableSession: ResumableSession, prompt: string, nonce: string): Promise<{ request: CapturedRequest | undefined; all: CapturedRequest[] }>;
```

`scratchResumableSession` calls `readSessionEntries` and `makeConfigDir`;
the CLI's `main` calls `scratchResumableSession` or
`realConfigResumableSession`, `captureInferenceRequest`,
`resumableSession.restore()` (also on failure), `assertVersions`. `assertVersions`
pins the SDK, whose bundled `cli.js` is the CLI under test; the global
`claude` binary is not involved.

## Data flow

session.jsonl ─(readSessionEntries, cut at first `--at` line)→ entries
─(write to scratch `projects/<key>/<id>.jsonl`)→ SDK `query` with
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` ─(CLI builds request)→ shim
records `CapturedRequest`, answers synthetic SSE ─(select by nonce)→ stdout
JSON.

## Cost

- One CLI process per capture (seconds); a scratch config dir per run.
  The token's validity is irrelevant — nothing is forwarded — but its
  recorded `expiresAt` is not: the CLI refreshes a near-expiry token
  against the OAuth host (unaffected by `ANTHROPIC_BASE_URL`), which is
  the real-token rotation `makeConfigDir` refuses to risk. Scratch mode
  therefore seeds the copied credentials with a far-future `expiresAt` so
  no refresh is attempted; P0 confirms by checking that `~/.claude`'s
  credentials are unchanged after a run.
- Request bodies are large (tools + full history); captures stay in `/tmp`,
  never in the repo.

## Probes

Order: binary first, so every wire probe tests a pre-registered prediction
(the E3 discipline of the compact-boundary-injection round) instead of
exploring. Inputs: real sessions from `~/.claude/projects` (local only,
never committed or copied into the repo) for P2; synthetic fixtures for
P3, built by cloning real attachment payloads with their text replaced by
nonce-tagged markers so shapes stay faithful.

- **P0 — binary read.** In the pinned CLI, locate stage 5's content
  path: the attachment renderer (per-type branches: rendered text, wrapper
  tags, source field, supersession such as "omit after the next user
  turn"), thinking-block handling, and the `system` assembly. Routine per
  the sdk-migration memory notes; minified identifiers stay in
  `FINDINGS.md`. Output: a per-type prediction table that P3 asserts
  against, and the list of types no fixture will cover.
- **P1 — oracle validation.** Same session + prompt through the forwarding
  shim (one real haiku request, `HAIKU` model) and the answering shim; diff
  the bodies. Same session through scratch mode and `--real-config`; diff
  the bodies and extend the mirrored allowlist until they agree. Does the
  CLI accept the synthetic SSE (turn completes, no retry)? If not, switch
  the shim to a non-retryable 400 and select the first request. Confirm
  the real credentials file is unchanged after a scratch run.
- **P2 — structure on a real session.** At the whole file and at several
  `--at` prefixes (before/after a parallel tool group, after a compaction
  boundary, mid-thinking): message grouping (Q3), omitted entry types
  (Q4), thinking blocks (Q5), `system` vs `messages` (Q6). Cross-check the
  oracle's `messages` against `loadedContext` for the same prefix; any
  divergence is a stage 1–4 bug in `loadedContext`, not new knowledge
  about stage 5.
- **P3 — attachment rendering and lifetime.** One fixture per attachment
  type in `attachment-types/FINDINGS.md`: instance A1 → a user turn with
  its assistant reply → instance A2 → probe prompt, captured with `--at`
  at A1, at the reply, and at A2. From the three requests: present or not,
  role/block and wrapper text, source field of the text (Q1); whether A1
  survives the user turn and whether A1 is dropped once A2 exists (Q2).
  Compaction is not a lifetime question: stage 1 deletes every
  pre-boundary entry outside the playlist, and a playlisted attachment is
  just an old attachment, covered by the A1-after-a-turn capture.

## Edge cases

- `--at` uuid absent from the file: exit 2 with the message.
- A session line `readSessionEntries` rejects: exit 2 naming the line;
  no scratch dir is created.
- `--real-config` with `--at`: exit 2 (never truncate the real file).
- `--at` uuid whose prefix is unsettled (a tool call awaiting its result;
  `settledPrefixLengths`): allowed — that is a legitimate "what if the user
  typed here" state — but flagged on stderr.
- A session whose `cwd` is a deleted worktree: refuse (see contract). A
  `--cwd` override is out of scope until a probe needs it.
- The CLI may re-persist the copied session in the scratch dir; the
  original is never opened for writing.

## Non-goals

- The conversion module, `get-context --api`, and SDK tests encoding the
  findings: separate spec after `FINDINGS.md`.
- Driving the interactive TUI. Our own TUI drives the CLI through the SDK,
  so the SDK path is the one that matters; an interactive control probe is
  a possible later addition if a finding looks mode-dependent.
- mitmproxy. `ANTHROPIC_BASE_URL` plus a plain-HTTP shim is already proven
  by the compact-boundary-injection probes; no TLS interception is needed.

# IMPLEMENTATION IDEAS

- The answering shim is `compact-boundary-injection/shim.mjs` with the
  upstream call replaced by a canned response; keep the redaction set and
  the record shape so `readCapturedInference` filters still apply.
- Synthetic SSE body: `message_start` (usage 1/1), `content_block_start`
  text, one `content_block_delta` "ok", `content_block_stop`,
  `message_delta` `stop_reason: "end_turn"`, `message_stop`, with
  `content-type: text/event-stream`. The CLI persists the resulting
  assistant entry into the scratch copy, which is harmless.
- Nonce selection over `JSON.stringify(body.messages)` like
  `p1-injection.mjs`.
- P3 fixtures: take a real entry of each attachment type, keep
  `parentUuid`/`sessionId`/timestamps consistent with the fixture chain,
  replace text fields with `ATT-<type>-<nonce>`; a request that contains the
  marker proves both presence and the source field.
- The comparison the oracle exists for arrives with the conversion module:
  a `--check` that runs the conversion on `loadedContext(entries)` and
  reports mismatches against the capture, like `check-context-at.ts`.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] answering shim (`tests/sdk/answering-shim.ts`)
- [x] `scripts/capture-api-request.ts` (+ `makeConfigDir` credential seed option)
- [x] P0 binary read (`P0-binary-read.md`)
- [x] P1 oracle validation (`p1-oracle-validation.mjs` + `--real-config` diff)
- [x] P2 structure (wire half; needs a parallel-tool session and P0 correlation)
- [x] P3 attachment rendering (`tests/sdk/api-context.test.ts`; lifetime not covered)
- [ ] `FINDINGS.md`

- 2026-09-28 review round 0f5c5ca: `api-capture.ts` split into
  `answering-shim.ts` / `resumable-session.ts` /
  `capture-inference-request.ts`; `SessionCopy`→`ResumableSession`,
  `installSessionCopy`→`scratchResumableSession`,
  `useRealConfig`→`realConfigResumableSession`.

- 2026-09-26 capture machinery moved from `scripts/` to
  `tests/sdk/api-capture.ts` (thrown errors; the CLI keeps the exit codes)
  so the P3 SDK tests share it. P3 as spot checks on synthetic
  single-attachment fixtures under HAIKU: default mode is the native SR
  user block (no fold); the env forces `role: "system"` with block
  content; `rendered` replays verbatim; `todo_reminder` renders nothing;
  `agent_listing_delta` does render. See FINDINGS "P3".

- 2026-09-25 review b4113e2: binary read moved first (P0); rendering and
  lifetime merged into one three-capture fixture per type so supersession
  is observable; compaction dropped as a lifetime case (stage 1 already
  models it); scratch credentials seeded never-expiring instead of the
  near-expiry refusal.
- 2026-09-25 plan written. Critique round: scratch config dir mirrors an
  allowlist of `~/.claude` (hooks/MCP on); `--real-config` mode added as
  the allowlist check with append-only restore. Decisions: SDK path only (our TUI is
  SDK-driven); `--at` truncates the file rather than using
  `resumeSessionAt` so prefixes off the current leaf are reachable; first
  occurrence of a repeated uuid; capture via `ANTHROPIC_BASE_URL` shim, not
  mitmproxy; conversion module deferred to its own spec.

- 2026-09-25 implementation. Types compiled first; tracer run on a
  13-entry real session: 2 requests captured (`/api/hello`,
  `/v1/messages?beta=true`), session file and real credentials unchanged.
  P1a (`p1-oracle-validation.mjs`, one real haiku request): forwarding
  and answering shim bodies identical; the CLI accepts the synthetic SSE
  (turn completes, one request, no retry). P1b (scratch vs
  `--real-config`): identical after two fixes below, except the config-dir
  path inside the CLAUDE.md/MEMORY.md header lines — inherent to the copy.
  First wire observations (to be confirmed in P2): `messages` contains
  `role: "system"` entries (deferred-tools notice, `# Environment`);
  `ide_selection` renders as a text block in the user message that
  carried it.

## Implementation-Time Decisions

- **Auto-memory is keyed by the main worktree root.** The CLI stores
  `projects/<key>/memory/` under the git common dir's parent, not the
  linked worktree's cwd; scratch mode mirrors memory for both keys
  (`gitMainRoot`). Found because the tracer's request lacked MEMORY.md.
- **`ResumableSession.env` replaces `configDir`.** `--real-config` must leave
  `CLAUDE_CONFIG_DIR` exactly as the user's shell has it: setting it to
  `~/.claude` moved the CLI's `.claude.json` lookup into that dir, which
  dropped the `userEmail` reminder and the account id from the request —
  the "real" run was less real than scratch. Each resumable-session
  constructor builds the CLI env itself.
- **P1 probe drives the oracle's scratch copy.** `p1-oracle-validation.mjs`
  runs the oracle once to install the copy, then resumes it twice via the
  compact-boundary-injection harness (`makeSession`, `HAIKU`) rather than
  adding forwarding or model flags to the oracle.
- 2026-09-25 P2 on a 91-entry real session: loader context → wire
  one-to-one for non-attachments; attachments render as system-role
  string messages (not user/isMeta); `total_tokens_reminder` not deduped
  except one instance lost in the first slot; `agent_listing_delta`,
  `skill_listing`, `auto_mode` absent. See FINDINGS.md. P0 running.
- 2026-09-25 P0 landed and reconciled (FINDINGS "P0"): the P2 "lost
  total_tokens_reminder" was a fold — attachments between two assistant
  messages become ONE system-role message in mid-conversation-system
  mode. New inputs for the model: the mode gate, and the persisted
  `rendered` snapshot (present on ~2/3 of 2.1.280 attachment entries).
  P3 scope question raised with Anton before building fixtures.
- 2026-09-26 review b188096: the loader-context printout was a manual
  alignment aid for P2; removed (spec contract and criterion 3 amended).
  The diff it stood in for arrives with the conversion module.
- 2026-09-26 P3 landed (11 live tests green, presubmit green). FINDINGS
  corrected: `agent_listing_delta` and `skill_listing` DO render (folded
  into the first system message in the P2 sessions; the P2 pass had read
  only message heads). `todo_reminder` gate left open. HAIKU's default is
  the native SR-user mode; fable's is the fold. Note for Anton: treefmt
  reformats `P0-binary-read.md` (table padding, 25→107 KB); the
  formatted version is what's in the tree.
