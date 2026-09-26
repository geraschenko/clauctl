# SDK migration report: 0.3.258 → 0.3.280

Date: 2026-09-22. Bundled Claude Code 2.1.258 → 2.1.280 (manifest commit
`80abbfe7`, build 2026-09-21). Procedure: `skills/update-claude-agent-sdk/SKILL.md`.
Commits: `87b38e6` (bump) through `ddc9593` (loader correction).

## Declaration changes and disposition

`Options` (exhaustive table in `src/core/options.ts`):

- `projectConfigRoot` — persist; spawn flag `--project-config-root`.
- `verbatimPrompts` — persist; no spawn flag yet (SDK stdin-side behavior).
- `permissionPrompts: 'host' | 'none'` — invariant, left unset (`host`) until
  the TUI answers prompts itself.
- `pluginDelivery: 'argv' | 'initialize'` — invariant, SDK default (no
  session-observable effect).
- `AgentDefinition.omitClaudeMd` — passes through the agent definition; no
  clauctl handling.

`Query` (`src/core/sdk-commands.ts`, `sdk-passthrough.ts`, `protocol.ts`):

- New `reloadOutputStyles()`, `readMcpResource(server, uri)` → subcommands
  `reload-output-styles`, `read-mcp-resource`.
- `reloadPlugins({holdOnCacheImpact})`, `usage({skipBehaviors})` → flags.
- `setMaxThinkingTokens` gains `'highlights'`; `updateSettings` gains
  `'userSettings'` source.
- Coverage is now enforced by `src/core/sdk-commands.test.ts`: every `Query`
  method in `sdk.d.ts` has an `sdkRoutes` entry or is named in
  `sdk-passthrough.ts`'s exclusion comment (`close`, `streamInput`,
  `reinitialize`). Spec `lifecycle-and-sdk-commands.md` DECISION-4 points at
  the test instead of enumerating methods.

`SDKMessage` and friends (additive optional fields; compile clean, no
rendering added): `result.user_message_uuids` (now asserted by the sdk
tests, see below), `result.usage_report`, `resume_reason`, `no_response`,
`mcp_server` provenance on tool-related frames, `SDKAssistantMessageError`
gains `verification_required` / `cloud_credential_error`,
`SDKControlGetHooksListing*`. `pending_permission_requests` /
`pending_user_dialog_requests` are documented always-present from 2.1.268.
`command_lifecycle` remains undeclared; tests keep a local type.

`sdk-tools.d.ts`: `TaskOutput` and `REPL` input/output types removed
(tool gone from the CLI). `TaskOutput` stays in `READ_ONLY_TOOLS`
(`src/tui/tool-views/tool-view.ts`) so older transcripts fold; dated
removal note 2026-12-22.

## Runtime drift (not in declarations) and disposition

- **Resume heal of an interrupted trailing turn** (2.1.274 "corrupted
  transcripts self-heal"). The p20-kill1 probe flipped from
  `drops-unresolved-block` to `kept-healed-interrupt`. Binary re-read
  (`docs/derisk/compact-boundary-injection/README-20260922.md`) showed the
  heal is positional — only unresolved calls of the file's trailing turn are
  kept, with a synthetic `is_error` tool_result — and the new
  `p20-kill1-later` probe confirmed it on the wire (`tail-heal-only`).
  `sanitizeForResume` (`src/core/tree/loader.ts`) and
  `ToolGroup.excludedAtEnd(atFileEnd)` model the rule; loader stages 1–2
  verified identical, stage 3 order-equivalent (new recovered-tails pass not
  modeled). FINDINGS §4 and the loaded-context / session-tree specs updated.
- **Slash-command predicate widened**: string content OR any text block
  starting with `/`; expansion in place; unknown commands forwarded to the
  model as plain user entries. `queue-model.ts` and
  `docs/claude-agent-sdk.md` updated; `steer-slash-command.test.ts` pins it.
- **TUI parity** (`docs/derisk/tui-parity/diff-catalog-2.1.280.html`):
  `/compact` result now attaches as `⤷ Compacted`; banner/summary lines
  lead with one blank line — both implemented (match). Other entries keep
  their earlier decisions; `write-success-preview` re-attested.
- Tool schemas recaptured (`tool-schemas.json` stamped 0.3.280; `TaskOutput`
  gone from the set).
- Version stamps: `write.ts`, `user-message.ts` bumped to 2.1.280 on parity
  evidence; `loader.ts` keeps its 2.1.258 provenance line plus the 2.1.280
  re-read pointer; derisk records untouched.

## Tests

Offline: `npm run presubmit` green (756 unit tests incl. the new Query
coverage test and the kill1/kill1-later loader tests); `check-reports.mjs`
75/75.

Live (haiku unless noted, temp `CLAUDE_CONFIG_DIR`, no `bypassPermissions`):

- `npm run test:sdk` (Anton, 2026-09-22): all green — permission-mode
  (workaround still required on 0.3.280), clear-session, interrupt-queue,
  session-id-option, queued-batches, steer-slash-command,
  steer-parallel-tools, compact-boundary-suite. The new
  `user_message_uuids` result-frame assertions (queued-batches,
  steer-slash-command, steer-parallel-tools) passed.
- Compact-boundary suite: 25 probes; p20-kill1-later run once.
- Tool-schema capture through mitmdump; parity recapture
  `--recapture-claude`.
- No separate core smoke: every sdk test spawns through the SDK and
  `assertVersions` checks `system/init.claude_code_version` = 2.1.280 before
  its own assertions.

## Unresolved risks

- p4.q7 writer keep-reach varies within a version; check-reports
  version-conditions it, root cause untraced.
- Stage-3 "recovered tails" pass and the >5 MiB two-pass reader are not
  modeled/tested; both touch only shapes clauctl's loaded-context consumers
  filter or never produce.
- Heal approximation: the CLI's trailing-turn scan stops at the last plain
  user prompt; `ToolGroup` ends a group at any non-member entry (an
  attachment after the last result would differ — not probed). Low stakes:
  `loadedContext` is an oracle, not a product path.
- `command_lifecycle` still undeclared; `user_message_uuids` assertions
  encode one observed capture shape each.
