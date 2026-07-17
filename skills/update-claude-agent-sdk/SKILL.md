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
  `src/core/sdk-socket.ts`, `src/core/sdk-passthrough.ts`, and
  `src/core/sdk-commands.ts`. Every new method must be exposed or have an explicit
  exclusion rationale at the mapping site.
- Message-shape changes can affect `src/core/agent-state.ts`,
  `src/core/daemon/queue-model.ts`, `src/format/`, and `src/tui/sdk-render.ts`.
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
   - Update comments/docs pinned to the old SDK version or old contract.
   - Add or update offline tests for changed project behavior. Do not loosen types,
     cast away a migration error, or remove intentional functionality.

6. Run focused tests while editing, then one final `npm run presubmit`. Do not repeat
   the full suite after every small correction. Treat successful compilation as weak
   evidence for additive SDK or runtime-default changes. Do not use a reviewer by
   default; use one final review only when the migration changes lifecycle, protocol,
   or security-sensitive behavior and the extra scrutiny is worthwhile.

7. Propose a minimal live matrix derived from the migration notes and ask for explicit
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

   Add only cases for changed behavior that clauctl actually depends on: Query
   controls, queueing, tools/MCP, compaction, session rollover, resume, set-context,
   or TUI rendering. A declaration change alone does not require a live case. Reuse
   focused harnesses under
   `docs/derisk/` when they directly cover a changed assumption; do not rerun every
   historical experiment. State expected assertions and dollar/time ceilings before
   seeking approval. Enforce the wall-clock ceiling
   externally; for spend, account for `maxBudgetUsd`'s one-request overshoot and stop
   before the approved headroom is exhausted. Preserve only sanitized failing
   captures—never credentials, tokens, environment dumps, or private config—and
   remove successful temporary agent state.

8. Finish with a migration report containing:

   - old and new exact versions;
   - notable declaration/runtime changes and their disposition;
   - updated call sites and adopted/deferred opportunities;
   - offline and live tests run (or live tests explicitly not run);
   - unresolved risks, including behavior not represented in declarations.
