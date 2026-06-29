# Derisking experiment: which `Options` does `resume` restore, and which does it drop?

> **Handoff brief for a fresh-context agent.** Read `docs/overview.md` and
> `docs/specs/lifecycle-and-sdk-commands.md` (the "Persist mutable runtime state" and
> "agent.json Options handling" sections) first. This experiment **gates the exact
> agent.json merge set** but does not block scaffolding — Phase 1 can proceed against
> the provisional merge map and tighten it once these findings land.

## Why this matters

clauctl's respawn recipe is **persisted (merged) `Options` + `resume:
currentSessionId`** in a _fresh_ process (after a crash or daemon restart). For this
to feel like "the session was running the whole time," respawn must reproduce the
agent's **current** runtime state, including anything a client changed mid-session via
a `Query` control method (`setModel`, `setPermissionMode`, `setMcpServers`,
`applyFlagSettings`, `setMaxThinkingTokens`, `setMcpPermissionModeOverride`, …).

The open question is **how much of that state `resume` restores on its own**. The
transcript JSONL clearly carries the conversation, but it is unknown which _session
configuration_ travels with it. Anecdotally:

- **`model` changes appear to persist** across `resume`.
- **`permissionMode` changes appear NOT to persist** across `resume`.

We need a precise, per-field answer, because it determines clauctl's obligations:

- **Field that `resume` DROPS and that has an `Options` equivalent** → clauctl
  **must** merge the current value into the persisted `Options` and re-pass it on
  respawn (e.g. `permissionMode`). This is the load-bearing case.
- **Field that `resume` RESTORES** → merging is harmless/redundant; nice to confirm so
  we don't fight `resume` (e.g. is there a conflict if we _also_ pass `model`?).
- **Field with NO `Options` equivalent** (`setMcpPermissionModeOverride`,
  `toggleMcpServer`/`reconnectMcpServer`, `setMaxThinkingTokens`'s `thinkingDisplay`)
  → if `resume` drops it, clauctl must **re-apply via the control method** after
  respawn, or accept the loss. Determine which.

The deliverable is a **per-field table** that becomes the authoritative merge/re-apply
list in `docs/specs/lifecycle-and-sdk-commands.md`.

## CRITICAL constraint — do NOT pollute the real `~/.claude`

Every spawn in this experiment **must** set a custom **`CLAUDE_CONFIG_DIR`** pointing
at a scratch directory inside this experiment folder (or `/tmp/clauctl-resume-derisk/`),
**not** the user's real `~/.claude`. The SDK reads `CLAUDE_CONFIG_DIR` from the
subprocess env; note that `Options.env`, **when set, REPLACES the subprocess env
entirely** — so spread `process.env` and then override:

```js
env: { ...process.env, CLAUDE_CONFIG_DIR: '/abs/path/to/scratch-config' }
```

Session transcripts will then be written under
`$CLAUDE_CONFIG_DIR/projects/<cwd>/<session_id>.jsonl`. **The respawn must reuse the
same `CLAUDE_CONFIG_DIR`**, or `resume` will not find the transcript. Do not write
anything under the real `~/.claude` at any point.

## Setup

- Pinned SDK at `node_modules/@anthropic-ai/claude-agent-sdk` (version **0.3.195**).
- **Use the SDK-bundled `claude` binary** — do not point
  `pathToClaudeCodeExecutable` at the system binary; keeps results tied to the pinned
  version that clauctl ships against.
- `permissionMode: 'auto'` for the _initial_ planting turn (cheap, no
  prompts). Note: this means you must change the mode to something observably
  different (e.g. `'default'` or `'plan'`) during the run to test persistence — see
  below.
- Model the harness on `docs/derisk/clear-vs-session-experiment/exp.mjs`: a single
  long-lived `query({ prompt: <AsyncIterable of SDKUserMessage> })`, input iterable
  held open, advancing on `result`. The `Query` generator also exposes the control
  methods and the introspection methods you'll use to _observe_ state.

## Experiment shape

**Phase A — establish & mutate state (process #1).**

1. Spawn a streaming session (custom `CLAUDE_CONFIG_DIR`). Plant one trivial turn so a
   transcript exists and capture `currentSessionId` from the `system/init`.
2. Mutate as many runtime controls as cheaply observable, recording the value set:
   - `setModel(<a model different from the spawn default>)`
   - `setPermissionMode('plan')` (or any mode ≠ the spawn mode)
   - `setMaxThinkingTokens(<n>, <display>)`
   - `applyFlagSettings({ ... })` (a flag-layer setting with an observable effect)
   - `setMcpServers({...})` and/or `setMcpPermissionModeOverride(server, 'default')`
     if a cheap throwaway MCP server is available (optional — note if skipped)
3. **Observe the live state** via the introspection methods so you have a "before"
   baseline from the _same_ process: `initializationResult()` /
   `getContextUsage()` / `supportedModels()` / `mcpServerStatus()` / `accountInfo()`.
   Record exactly which method surfaces each mutated field (this also tells clauctl
   how `status` should read each value back). NOTE: the session jsonl files
   often have clearer information than the SDK messages. For example, if you
   cannot observe the new persmission mode in the SDK messages, check the jsonl
   files.
4. **Kill the process** (not `/clear` — a real cold kill; e.g. `query.close()` or
   killing the child). Confirm the child `claude` is gone.

**Phase B — cold respawn WITHOUT re-passing the mutated Options (process #2).**

5. Start a fresh `query()` with **`resume: currentSessionId`**, the **same
   `CLAUDE_CONFIG_DIR`**, and the **original spawn `Options` only** — deliberately do
   **not** re-pass the mutated `model`/`permissionMode`/etc. This isolates what
   `resume` restores on its own.
6. Immediately re-observe the same fields via the same introspection methods (or
   jsonl files; this may require sending an additional prompt). For each
   field: **restored to the Phase-A value, or reverted to the spawn default?**

**Phase C — confirm the merge fix (optional but valuable).**

7. Repeat Phase B but this time **do** pass the mutated values in the spawn `Options`
   (the merge strategy). Confirm each previously-dropped field now comes up correct,
   and that fields `resume` already restores don't conflict when also passed.

## What to capture (in this directory)

- The harness (`exp.mjs` or similar), inlined like the `/clear` experiment.
- The live event/introspection logs for Phase A, B, and (if run) C.
- The session JSONL(s) from the scratch `CLAUDE_CONFIG_DIR` (copied in), if small.
- The **per-field results table** (the headline deliverable):

  | Options field | mutated via | restored by `resume`? | has Options equiv? | clauctl action |
  | ------------- | ----------- | --------------------- | ------------------ | -------------- |
  | `permissionMode` | `setPermissionMode` | ? | yes | merge (expected) |
  | `model` | `setModel` | ? (expected yes) | yes | merge (redundant) |
  | `maxThinkingTokens` | `setMaxThinkingTokens` | ? | yes | merge |
  | thinking `display` | `setMaxThinkingTokens` | ? | no | re-apply / accept loss |
  | flag `settings` | `applyFlagSettings` | ? | yes (`settings`) | merge |
  | `mcpServers` | `setMcpServers` | ? | yes | merge |
  | mcp perm override | `setMcpPermissionModeOverride` | ? | no | re-apply / accept loss |

  (`clauctl action` ∈ {merge into persisted Options, re-apply via control method after
  respawn, accept loss}.)

## Constraints

- Keep artifacts to support your conclusions in this directory; the
  scratch `CLAUDE_CONFIG_DIR` must live in this folder or
  `/tmp/clauctl-resume-derisk/` — never the real `~/.claude`.
- This spends real credits — don't be wasteful. You can use sonnet or haiku to
  make things cheaper. However, it is expected that you'll have to run dozens
  (maybe even 100-200) actual short sessions to produce this table, and it's
  important that the table is actually correct.

## Report back (evidence-first)

The filled-in per-field table, plus a one-paragraph conclusion: **the exact set of
fields clauctl MUST merge into `agent.json` on change** (because `resume` drops them),
**the set it may merge redundantly** (because `resume` restores them), and **the set
with no Options path** that must be re-applied via a control method after respawn or
accepted as lost. Note any field whose persistence is surprising or version-fragile
(it may change on an SDK bump — that feeds RISK-6).
