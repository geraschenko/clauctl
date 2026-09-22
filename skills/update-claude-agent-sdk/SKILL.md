---
name: update-claude-agent-sdk
description: Migrate clauctl between exact @anthropic-ai/claude-agent-sdk versions. Use to diff the SDK's shipped TypeScript declarations, classify API and bundled-Claude behavior changes, update all SDK-coupled call sites, and run risk-based offline and opt-in live verification.
disable-model-invocation: true
---

# Update Claude Agent SDK

The version argument is the target exact version. If it is omitted, resolve
`npm view @anthropic-ai/claude-agent-sdk version`, show it to the user, and ask
for confirmation. Never infer a target from an unverified claim or install a
range.

## Fixed facts

- `package.json` pins `@anthropic-ai/claude-agent-sdk` exactly. Keep the exact pin.
- The package is closed-source. Its shipped declarations are the public contract;
  `sdk.mjs` and the bundled `claude` binary can still change behavior without a
  declaration change.
- The project directly imports `@anthropic-ai/sdk` types supplied transitively by
  the agent SDK. Peer/transitive version and declaration changes are migration
  inputs, not lockfile noise.
- `src/core/options.ts` exhaustively classifies `keyof Options`. A new or removed
  option must be deliberately classified; never weaken that compile-time tripwire.
- The full `Query` control surface is intentionally exposed. Its churn zone is
  `src/core/protocol.ts`, `src/core/sdk-passthrough.ts`, and
  `src/core/sdk-commands.ts`. Every new method must be exposed or have an explicit
  exclusion rationale at the mapping site.
- Message-shape changes can affect `src/core/agent-state.ts`,
  `src/core/daemon/queue-model.ts`, `src/format/`, and `src/tui/sdk-render.ts`.
- `scripts/claude-tools/tool-schemas.json` is stamped with the capturing SDK
  version and checked by presubmit (`generate.ts --check`), so an SDK bump turns
  presubmit red until `capture.ts` is rerun. Capture is a live step: it runs the
  bundled claude through mitmdump with real credentials. A schema diff can also
  come from account-level feature gates rather than the version change (see
  capture.ts's header).
- The TUI parity harness (`scripts/tui-parity`, docs/specs/tui-parity.md) caches
  native-claude captures keyed to the session content, so after a bump they must
  be recaptured with `--recapture-claude`. Capture/diff of the existing corpus is
  free to repeat; only session generation (`tui-parity/generate.ts`) costs API
  calls. The corpus lives in gitignored `scripts/tui-parity/out/`.
- Live Claude calls may consume money and alter credentials/config/transcripts.
  Never run them without explicit user approval of the proposed cases and budget.
- For live tests, use a temporary `CLAUDE_CONFIG_DIR` and copy the active config's
  `.credentials.json` into it with mode `0600`. Remove the copy during cleanup and
  never retain it in captures. If it happens to expire, report the auth failure.
- `maxBudgetUsd` is a turn-level stop, not a hard spending cap: the request that
  crosses it is still billed and may overshoot. Reserve approved headroom based on a
  full first-request cost and report actual result costs.

## Procedure

1. Require a clean worktree or identify and preserve the user's existing changes.
   Read `package.json` and inventory SDK imports with the command below. Do not read
   every matched file up front; use the declaration diff and compiler to identify
   which symbols and call sites need inspection.

   ```bash
   rg -l '@anthropic-ai/claude-agent-sdk|@anthropic-ai/sdk' src
   ```

   Record the installed and locked versions and require them to agree. Record the
   dependency tree. Run the baseline presubmit only if this branch is not already
   known green:

   ```bash
   node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"
   npm ls @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk --all
   npm run presubmit
   ```

2. Verify the target exists, then snapshot and diff the exact npm artifacts before
   changing the install:

   ```bash
   npm view @anthropic-ai/claude-agent-sdk@<target> version
   skills/update-claude-agent-sdk/scripts/diff-types.sh <old> <target>
   ```

   Read `sdk.d.ts.diff` once and inspect `other-types.diff`, which contains only
   changed declarations outside `sdk.d.ts` (no duplicated primary diff or unchanged
   file headings). Consult `README.diff`, `package-json.diff`, or `manifest.diff` only
   when they contain a change relevant to clauctl.

   Read the Claude Code changelog for every bundled-claude version between the
   old and new `manifest.json` `version` (the declarations do not describe
   runtime-only changes: resume/compaction loading, headless lifecycle, tool
   removals, subagent result framing). https://code.claude.com/docs/en/changelog
   carries only recent releases; for older entries in the range use
   `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`.
   Keep only bullets that touch SDK/headless sessions, resume, compaction,
   transcripts, hooks, permissions, queueing, or tools clauctl renders.

3. Update the dependency and lockfile together, then compile early:

   ```bash
   npm install --save-exact @anthropic-ai/claude-agent-sdk@<target>
   npm run check
   ```

   The exhaustive `Options` table and other compiler errors are high-signal impact
   discovery; use them before manually reading broad call-site files. Confirm
   `package.json`, `package-lock.json`, and the installed package all report the exact
   target. Inspect the lockfile diff and rerun `npm ls`; if a directly imported
   transitive package changed, diff its declarations.

4. Make concise migration notes for only:

   - breaking or behavioral changes that affect clauctl;
   - coverage obligations from changed `Query` methods, `Options` keys, or
     `SDKMessage` variants;
   - concrete opportunities to remove a clauctl workaround.

   Do not catalogue unrelated SDK changes. Trace only the items above to project
   call sites. For opportunities,
   describe the concrete simplification and ask before broadening the migration
   into an optional refactor.

   Find the installed platform package's `claude`/`claude.exe`, run its offline
   `--version`, and verify it against `manifest.json`. Inspect `--help` or a focused
   region of `sdk.mjs` only when a specific changed flag or runtime behavior remains
   unanswered; never review generated runtime source speculatively.

5. Inspect and update only the call sites implicated by the migration notes or compiler:

   - Classify every changed `Options` key in `OPTION_BUCKETS`; update flag parsing,
     persistence, invariant construction, and comments as required.
   - Keep the `Query` passthrough complete across wire types, daemon dispatch,
     persistence semantics, CLI commands, and tests.
   - Handle new message variants wherever exhaustive rendering, state folding,
     transcript conversion, or generic fallbacks require it.
   - Sweep for stale version stamps:
     `rg -n '\b[0-9]+\.[0-9]+\.[0-9]+\b' src scripts skills` and triage every
     hit (the bare-literal pattern is deliberate: it finds stamps regardless
     of phrasing or how many migrations behind they are). Update comments pinned to
     the old SDK version or old contract; a comment describing observed runtime
     behavior may only carry the new version once the migration confirmed the
     behavior is unchanged (declaration diff, migration notes, or a live check)
     — otherwise leave the old stamp and flag it. Leave provenance references
     (e.g. which decompiled binary a port came from), test fixture data, and
     `docs/derisk/` experiment records alone: they record which version
     something actually ran on.
   - Add or update offline tests for changed project behavior. Do not loosen types,
     cast away a migration error, or remove intentional functionality.

6. Refresh the captured tool schemas — presubmit stays red until
   `tool-schemas.json`'s recorded sdkVersion matches the new install:

   ```bash
   node scripts/claude-tools/capture.ts
   ```

   (capture regenerates `generated.ts` itself; `generate.ts` alone re-renders
   from the checked-in schemas.)

   Capture is live (see fixed facts): ask before running it, together with or
   ahead of the step-9 approval, and report that the schema presubmit check
   cannot pass if it is declined. Review the resulting `tool-schemas.json` and
   `generated.ts` diff: tools without a bespoke view render through the generic
   fallback in `src/tui/tool-views/tool-view.ts`, so for each new tool decide
   whether it needs a bespoke view or the fallback suffices, and flag removed or
   changed inputs to views that consume them. Attribute a schema diff to gate
   drift, not the bump, when the tool set changed without a matching
   binary-version change.

7. When the bundled claude version changed, re-baseline the TUI parity harness
   against the existing session corpus:

   ```bash
   node scripts/tui-parity/capture.ts --recapture-claude
   ```

   This is free to repeat. Treat new diffs as rendering obligations (clauctl
   rendering or `normalize()` updates); regenerate scenario sessions only when a
   migration note requires new session content, with the same approval as other
   live runs. If the local corpus is missing, say so instead of silently
   regenerating it.

   When the recapture surfaces new rendering differences (not just the
   previously decided divergences), distill them into a dated catalog
   `docs/derisk/tui-parity/diff-catalog-<claude-version>.html` in the format of
   `diff-catalog.html` (side-by-side verbatim excerpts, one entry per logical
   difference, a triage summary table) with proposed triage badges, and ask the
   user to decide match/differ/skip per entry before implementing any of them.
   Before presenting the catalog, verify completeness with a second pass over
   the raw `.diff` files: every changed line of every hunk must be attributable
   to a specific catalog entry — small hunks adjacent to large decided-differ
   hunks are the ones that get missed when triaging by expected category.

8. Run focused tests while editing, then one final `npm run presubmit`. Do not repeat
   the full suite after every small correction. Treat successful compilation as weak
   evidence for additive SDK or runtime-default changes. Do not use a reviewer by
   default; use one final review only when the migration changes lifecycle, protocol,
   or security-sensitive behavior and the extra scrutiny is worthwhile.

9. Propose a minimal live matrix derived from the migration notes and ask for explicit
   approval before running it. Always include one isolated core smoke because the
   SDK package pins the bundled Claude binary:

   - spawn with a low-cost model in temporary `CLAUCTL_DIR` and
     `CLAUDE_CONFIG_DIR` containing a copied `.credentials.json`, with tools disabled
     and `maxBudgetUsd` as a soft stop;
   - enforce an external wall-clock timeout around the whole case;
   - send a deterministic, tool-free turn and assert structural behavior rather
     than exact model prose;
   - observe `system/init`, the expected manifest `claude_code_version`, assistant
     output, `result`, idle, and clean archive.

   Always include the SDK expectation tests, which assert the SDK/CLI
   behaviors clauctl's code is built on:

   ```bash
   npm run test:sdk
   ```

   - `tests/sdk/permission-mode.test.ts` (two haiku calls): the SDK forces
     `--permission-mode default` when `permissionMode` is unset, and an explicit
     value reaches the CLI. While the _workaround required_ case passes, the
     `buildOptions` merge in `src/core/daemon/daemon.ts` stays; if it fails,
     re-examine the merge rather than the test.
   - `tests/sdk/compact-boundary-suite.test.ts`: the loader regression
     suite (`docs/derisk/compact-boundary-injection/run-suite.mjs`), because
     the session-loading model behind `src/core/tree/loader.ts` and
     `src/core/daemon/set-context.ts` is empirical and pinned to the bundled
     binary (`docs/derisk/compact-boundary-injection/FINDINGS.md`). About 75
     haiku calls plus a few sonnet calls (roughly $1, 3–20 minutes); outputs
     land in the untracked `captures/`. `check-reports.mjs` fails by design on
     an SDK version it has no writer-drift expectation for (p4.q7):
     characterize the new behavior and extend its version table; never loosen
     an assertion to make a bump pass. Any other failure is a loader-model
     finding — triage it against FINDINGS before changing loader.ts or the
     assertion. A p4 "fixture setup failed" message is the known model flake;
     rerun that probe alone, then check-reports.

   Add only further cases for changed behavior that clauctl actually depends on:
   Query controls, queueing, tools/MCP, compaction, session rollover, resume,
   set-context, or TUI rendering. A declaration change alone does not require a
   live case. Reuse other focused harnesses under `docs/derisk/` when they
   directly cover a changed assumption; do not rerun every historical experiment. State expected assertions and dollar/time ceilings before
   seeking approval. Enforce the wall-clock ceiling
   externally; for spend, account for `maxBudgetUsd`'s one-request overshoot and stop
   before the approved headroom is exhausted. Preserve only sanitized failing
   captures—never credentials, tokens, environment dumps, or private config—and
   remove successful temporary agent state.

10. Finish with a migration report containing:

- old and new exact versions;
- notable declaration/runtime changes and their disposition;
- updated call sites and adopted/deferred opportunities;
- offline and live tests run (or live tests explicitly not run);
- unresolved risks, including behavior not represented in declarations.
