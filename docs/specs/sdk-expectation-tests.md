# SDK expectation tests and the permission-mode cascade fix

> Status: **implemented.**

# SPEC

## Problem

A freshly spawned clauctl agent shows the settings-cascade permission mode
(`permissions.defaultMode`, e.g. `auto`) in the footer before the first
message, then flips to `default` ("⏸ manual") at the first `init`. The CLI
child never honors `permissions.defaultMode`.

Root cause (verified live on SDK 0.3.220, 0.3.250, 0.3.258): the SDK's public
`query()` builds the child argv as
`permissionMode ?? (internal.resolvePermissionModeInCli ? undefined : "default")`,
where `resolvePermissionModeInCli` lives on `query()`'s private second
argument and is never set for public callers. So an unset `permissionMode`
always spawns `claude --permission-mode default`, which overrides every
settings file. Before a392561, `daemon.ts` `buildOptions` forwarded
`settingsSeed`'s mode explicitly to compensate; a392561 removed that merge on
the belief that 0.3.250 "omits --permission-mode when unset". The belief came
from reading the minified bundle (the destructure default was gone, the
replacement `??` expression was missed), and the live smoke that "confirmed"
it ran with a config whose `defaultMode` was unset — it observed `default` and
could not tell forced from resolved.

Two things are wanted:

1. Restore the merge so the cascade mode reaches the child.
2. A test category for _expectations of the SDK/CLI that clauctl's code is
   built on_, run on SDK bumps, whose first members are (a) the permission-mode
   expectation pair and (b) the existing compact-boundary loader suite wrapped
   as one test. A future migrator who believes the workaround is obsolete gets
   a red test, not a belief.

## Definitions

- **sdk test** (`tests/sdk/*.test.ts`, `npm run test:sdk`): asserts a
  behavior of the SDK or bundled CLI that clauctl depends on. A failure means
  "re-examine a clauctl assumption", never "clauctl is broken". Live: spends
  real API calls, uses scratch `CLAUDE_CONFIG_DIR`s only.
- **api test** (`src/**/*.apitest.ts`, `npm run test:api`, unchanged): tests
  of clauctl's own behavior that need real API calls. Not touched here.
- **workaround**: the `buildOptions` merge
  `permissionMode: persisted.permissionMode ?? settings.permissionMode`.

## Success criteria

1. With `~/.claude/settings.json` `permissions.defaultMode: "auto"` and a
   spawn without `--permission-mode`, the first `init` announces
   `permissionMode: "auto"` and the footer does not flip.
2. `npm run test:sdk` exists and runs:
   - `permission-mode.test.ts` — two cases, both against a scratch config
     dir whose `settings.json` is `{"permissions":{"defaultMode":"acceptEdits"}}`:
     - _workaround required_: `permissionMode` unset → `init.permissionMode === "default"`.
       Passing means the SDK still forces the flag and the merge must stay.
     - _workaround works_: `permissionMode: "acceptEdits"` → `init.permissionMode === "acceptEdits"`.
   - `compact-boundary-suite.test.ts` — runs
     `docs/derisk/compact-boundary-injection/run-suite.mjs` as a child
     process and asserts exit status 0. No wrapper timeout: run-suite already
     bounds each probe.
3. `npm run check` and `npm run lint` cover `tests/`.
4. `docs/derisk/compact-boundary-injection/captures/` is gitignored (Anton
   `git rm`s the tracked files).
5. `skills/update-claude-agent-sdk/SKILL.md` names `npm run test:sdk` as the
   loader/permission live step and states the link: while the
   _workaround required_ case passes, the `buildOptions` merge stays. Its
   "regenerates the tracked reports" wording goes (captures are no longer
   tracked). `docs/derisk/AGENTS.md`'s implementation note points at
   `tests/sdk/harness.ts` as the module that sets the telemetry variable.
6. Presubmit green. `test:sdk` is not part of presubmit (live).

## Type design

New file `tests/sdk/harness.ts` — the scratch-config plumbing moved out of
`docs/derisk/compact-boundary-injection/harness.mjs` (moved, not copied: the
credential-copy safety logic has one home). Semantics unchanged except the
new optional `settings` parameter:

```ts
export const REPO_DIR: string;
/** Throws when node_modules' SDK != package.json's exact pin. */
export function assertVersions(): { sdk: string };
/**
 * Fresh scratch CLAUDE_CONFIG_DIR seeded with a 0600 copy of the real
 * credentials and a projects-cleared .claude.json; refuses to run when the
 * access token is within 15 min of expiry. `settings`, when given, is
 * written as settings.json.
 */
export function makeConfigDir(
  caseName: string,
  settings?: Record<string, unknown>,
): string;
export function baseEnv(
  configDir: string,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv;
```

Module-scope side effect moves with it: `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"`
(the telemetry policy for scratch sessions; `docs/derisk/AGENTS.md`).
`docs/derisk/compact-boundary-injection/harness.mjs` imports these from
`../../../tests/sdk/harness.ts` and re-exports them so probe imports are
unchanged. The scratch root path constant keeps its current value
(`/tmp/clauctl-cbi-derisk`) — p8 reads p2's and p7's scratch dirs.

`tests/sdk/permission-mode.test.ts`, `tests/sdk/compact-boundary-suite.test.ts`:
`node:test` files, no exports.

`src/core/daemon/daemon.ts` `buildOptions`: no new symbols; the merge is
restored:

```ts
...record.persistedOptions,
...(record.persistedOptions.permissionMode === undefined &&
  settings.permissionMode !== undefined && {
    permissionMode: settings.permissionMode,
  }),
```

with the `settingsSeed` comment rewritten to name the actual SDK mechanism
(`resolvePermissionModeInCli`, private) and point at the sdk test.

Config:

- `package.json`: `"test:sdk": "node --test \"tests/sdk/**/*.test.ts\""`;
  `"lint": "eslint src tests"`.
- `tsconfig.json` `include`: `+ "tests"`. (`tsconfig.build.json` already
  restricts to `src`.)
- `.gitignore`: `+ docs/derisk/compact-boundary-injection/captures`.

## Data flow

- Daemon start: `settingsSeed(persisted, cwd)` → `resolveSettings` +
  `filterEscalatingDefaultMode` → `settings.permissionMode` → (a) AgentState
  seed for the footer (existing) and (b) `buildOptions` → SDK `query()` →
  `--permission-mode <mode>` → CLI `init.permissionMode`. (a) and (b) now
  read the same value, so prediction and truth coincide by construction.
- sdk test: `makeConfigDir(name, settings)` → scratch dir → `baseEnv` →
  `query({ prompt: string, options: { env, cwd: tmpdir, model: haiku, maxTurns: 1, ...case } })`
  → first `system/init` → assertion → `query.close()`.

## Cost

- Daemon: none beyond existing `settingsSeed` (already run at start).
- `test:sdk`: two haiku calls (~$0.01) for permission-mode; the compact
  suite as today (~75 haiku + a few sonnet calls, ~$1, ~3 min observed on
  0.3.258).

## Edge cases and non-goals

- Fidelity gaps of `settingsSeed` (inline `Options.settings` tier not fed to
  `resolveSettings`; policy helper not executed) are accepted, as documented
  on `settingsSeed`. A spawn with `--settings '{...defaultMode}'` still gets
  the SDK's forced `default`. Non-goal.
- Explicit `--permission-mode` at spawn (persisted) always wins; unchanged.
- `filterEscalatingDefaultMode` applies: a repo-committed escalating
  `defaultMode` is not forwarded, matching the CLI's own trust filter.
- Non-goal: the `spawnClaudeCodeProcess` argv-strip alternative (full
  fidelity but SDK-argv coupling). Rejected in favor of restoring the
  previously reviewed merge.
- Non-goal: breaking the compact-boundary probes into individual
  `node:test` cases (follow-up).
- Non-goal: fixing `check-reports.mjs` p4.q7 (writer keep-reach is
  nondeterministic across runs on 0.3.258; Anton to decide later). Until
  then `compact-boundary-suite.test.ts` is expected red on that assertion.
- Non-goal: an end-to-end `test:api` daemon test that the merge is present.
  The sdk pair removes the false belief; it does not mechanically stop a
  deletion of the merge. Known gap, deferred.

# IMPLEMENTATION IDEAS

- Evidence trail (probes run 2026-09-02 from the repo cwd, real user
  settings unless noted):
  - SDK 0.3.280 / 0.3.258 / 0.3.250 / 0.3.220, `permissionMode` unset → init
    `default` (0.3.280: 2026-09-22 rerun, workaround still required).
  - 0.3.258, scratch config `acceptEdits` and `auto` → `default` (not
    auto-specific).
  - Direct `claude -p` honors both `auto` and `acceptEdits`.
  - `spawnClaudeCodeProcess` hook stripping `--permission-mode default` →
    CLI resolves `auto` / `acceptEdits`. Confirms the CLI cascade is intact;
    only the forced flag is in the way.
  - Captured SDK argv: `[--output-format stream-json, --verbose,
--input-format stream-json, --max-turns 1, --permission-mode default]`.
  - Bundle: `HL=bne??(e?.resolvePermissionModeInCli?void 0:"default")` where
    `e` is the `{isSingleUserTurn}` internal arg of the query builder.
- Test shape: a string prompt ("reply with the single word ok") so the SDK
  runs single-turn; iterate until the first `init`, assert, then
  `query.close()` — the assertion does not need the model reply, but the
  call is already in flight; `maxTurns: 1` bounds it.
- Verified 2026-09-02: Node 23.11 imports a `.ts` module from `.mjs` with
  no flag (an ExperimentalWarning line, as `npm test` already prints). The
  derisk probes reference `/tmp/clauctl-cbi-derisk/<case>` as string
  literals (p4, p6, p8), hence the unchanged scratch root.
- `.ts` over `.mjs` for the sdk tests: `tsc` checks the cases against the
  SDK's declared `Options`/`SDKMessage` types, so a bump that changes those
  shapes fails `npm run check` before any live call. The derisk probes stay
  `.mjs`; only the harness plumbing they share moves to `.ts`.
- Follow-up candidates (not in scope): migrate run-suite's probes to
  individual sdk tests; resolve p4.q7's nondeterminism; a `test:api`
  end-to-end merge test; SKILL.md guidance "live checks must use config
  values that differ from CLI defaults, else they cannot detect forced
  values".

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] `tests/sdk/harness.ts` extracted; derisk `harness.mjs` re-exports
- [x] `tests/sdk/permission-mode.test.ts`
- [x] `tests/sdk/compact-boundary-suite.test.ts`
- [x] `package.json` scripts, `tsconfig.json` include, `.gitignore`
- [x] `daemon.ts` merge restored + comment
- [x] `SKILL.md` step 9 updated; `docs/derisk/AGENTS.md` and `run-suite.mjs`
      header pointers updated
- [x] `npm run test:sdk` — permission-mode: both cases green (~1.5 s each;
      `init` arrives before the model reply, `close()` cuts the rest)
- [x] `npm run test:sdk` — compact suite green this run (216 s, 24 probes +
      74 check-reports assertions on 0.3.258). p4.q7 passed, consistent
      with its across-run nondeterminism; Anton's earlier manual run was red
      on it. Still an open item outside this spec.
- [x] `npm run test:sdk` on 0.3.280 (2026-09-22): permission-mode both
      cases green; compact suite green, 25 probes + 75 check-reports
      assertions (p20 kill1 pinned to the 2.1.274+ heal, new kill1-later
      row; p4.q7 keep-reach and the p1e metadata-less boundary flipped shape
      again and are version-conditioned in check-reports). The
      `user_message_uuids` result-frame assertions in queued-batches,
      steer-slash-command and steer-parallel-tools passed live.
- [x] presubmit green (597 tests)
- [x] scratch cleanup: `tmp-probe/` and `/tmp/sdk*` removed by Anton;
      `/tmp/cfg-*` still present (harmless, `/tmp`)

## Implementation-Time Decisions

- **Explicit-absent `permissionMode` in the test's options.** The
  "workaround required" case spreads the key in only when defined rather
  than passing `permissionMode: undefined`, so the unset case is a genuinely
  absent key — the same shape a daemon without the merge would send.
- **`HAIKU` duplicated** in `permission-mode.test.ts` and derisk
  `harness.mjs` rather than exported from `tests/sdk/harness.ts`: the
  approved type design lists only the scratch-config plumbing; the model
  pin is a per-suite choice.
- **Temp cwd cleanup** added to the test's `finally` (not in the spec's data
  flow; a leak of one `mkdtemp` dir per run otherwise).
- **Suffix `.test.ts`, not `.sdktest.ts`** (review comment 4b8c5e8): the
  `tests/sdk/` directory is the category; the suffix only needs to keep
  `harness.ts` out of the glob, which the repo's existing `.test.ts` does.
  `.apitest.ts` keeps its suffix because those files interleave with `src/`.
