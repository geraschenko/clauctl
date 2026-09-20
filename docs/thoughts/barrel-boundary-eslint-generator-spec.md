We currently only have one barrel (agent-state), but lots of things should be refactored using the barrel pattern (e.g. transcript.ts has become huge and would benefit from this). Below is a partially-written spec for barrel guardrails. We'll have to update the existing agent-state barrel to expose its interface through index.ts rather than agent-state.ts.

# Generated ESLint Rules for Barrel Boundaries

## Status

Starting-point specification for refinement with an implementing agent. This document records the design discussed so far; it intentionally leaves project-specific API, resolver, and configuration details undecided.

## Summary

Add a generator that discovers directories containing an `index.ts` barrel and produces `eslint.barrels.generated.js`. The generated ESLint configuration enforces each barrel as a module boundary:

- Importers outside the barrel directory's subtree must import through the barrel rather than deep-importing implementation files.
- Importers inside the subtree must not import through that subtree's barrel.
- The barrel itself may import or re-export implementation files from its subtree.

The project's human-maintained `eslint.config.js` imports the generated file. The generator also provides a check mode suitable for CI.

## Motivation

Large modules may be refactored into directories of smaller implementation files while retaining the original public interface in `index.ts`. Without enforcement, callers can gradually bypass the public interface through deep imports, and implementation files can import their own barrel, creating confusing dependency paths or cycles.

Generating a separate config provides:

- A mechanically enforced public interface for each barrel directory.
- Preservation of the original external import surface during refactors.
- Protection against internal imports through the same barrel.
- An inspectable artifact that can be reviewed and checked in CI.
- A clean separation between generated rules and human-maintained ESLint configuration.

The generator should not rewrite `eslint.config.js` repeatedly. That file should contain one stable import of `eslint.barrels.generated.js`.

## Goals

1. Discover all in-scope directories whose barrel entry point is `index.ts`.
2. Generate deterministic ESLint flat-config rules enforcing their import boundaries.
3. Reject external deep imports into a barrel directory's subtree.
4. Reject imports from within a barrel subtree back through that subtree's barrel.
5. Allow the barrel entry point to import or re-export its implementation modules.
6. Handle nested barrel directories according to explicit, documented semantics.
7. Resolve import specifiers to canonical project files before classifying them, including configured aliases where supported.
8. Provide a write mode and a non-mutating `--check` mode.
9. Produce actionable lint messages identifying the relevant barrel boundary and expected import style.

## Non-goals

- Automatically creating barrels or deciding what they should export.
- Refactoring existing imports.
- Guaranteeing favorable tree-shaking or bundle performance.
- Detecting every dependency cycle in the project.
- Replacing general architecture or module-boundary tooling.
- Finalizing project-specific command names, TypeScript APIs, package choices, or alias-resolution behavior in this starting document.

## Boundary Semantics

For a barrel directory `B` containing `B/index.ts`:

### External importers

An importer outside `B`'s subtree may import the public barrel entry point. It must not import any other file inside `B`'s subtree directly.

Example: code outside `widgets/` may import `widgets` or `widgets/index`, subject to the project's normal import conventions, but may not import `widgets/button` directly.

### Internal importers

An importer inside `B`'s subtree, other than `B/index.ts`, must not import `B/index.ts` or another specifier that resolves to the same barrel. It may import implementation files directly when no more specific nested-barrel boundary prohibits that import.

This restriction avoids implementation modules depending on the public aggregation module that re-exports them, a common source of circular dependencies.

### The barrel file

`B/index.ts` may import or re-export files within `B`'s subtree. Imports that cross a nested barrel boundary require the nested-boundary rule described below.

### Nested barrels

Every barrel establishes its own boundary. If `B/N/index.ts` exists:

- Files outside `B/N` must access `B/N` through its barrel rather than deep-importing its implementation files, even when the importer is inside `B`.
- Files inside `B/N` must not import through `B/N/index.ts`.
- `B/index.ts`, as an external importer relative to `B/N`, should normally re-export from `B/N/index.ts`, not reach through it to `B/N` implementation files.
- A file inside `B/N` is also inside `B`; it must not import through `B/index.ts` either.

The implementing agent should turn these statements into a precise nearest-boundary/ancestor-boundary algorithm and a table of test cases before implementation.

## Import Resolution

Rules must operate on resolved, normalized file identities rather than raw import strings. The same target may be expressed using relative paths, path aliases, package self-references, or explicit/implicit `index` paths.

The refinement phase must decide:

- Which TypeScript configuration supplies `baseUrl`, `paths`, and project references.
- Whether JavaScript files and non-TypeScript importers are in scope.
- Which extensions and resolution modes are supported.
- How package exports, symlinks, generated files, and monorepo workspace aliases are treated.
- Whether type-only imports and dynamic imports follow identical rules.

Unsupported resolution cases should be explicit rather than silently misclassified.

## Generated Configuration

The generated file should:

- Be clearly marked as generated.
- Be deterministic for an unchanged source tree and configuration.
- Contain no timestamps or machine-specific absolute paths.
- Use stable ordering for directories, patterns, and rules.
- Export ESLint flat-config entries consumable by `eslint.config.js`.
- Be replaced atomically in write mode.

The main ESLint configuration should make one stable import of the generated configuration and compose it with the rest of the project's config.

The refinement phase should determine whether existing ESLint rules can express the resolved-path semantics or whether a small custom ESLint rule/plugin is needed. Generating textual path restrictions alone may be insufficient when aliases or multiple equivalent specifiers exist.

## Command Behavior

At minimum, support two operations:

- **Write:** discover barrels and update `eslint.barrels.generated.js`.
- **Check:** generate the expected content in memory, compare it with the checked-in file, make no changes, and exit nonzero with a useful message when stale.

The command should fail clearly on malformed project configuration, ambiguous resolution that affects correctness, or an unwritable output file.

## Validation and Acceptance Criteria

The refined specification should include fixture-based tests covering at least:

1. An external import through a barrel is accepted.
2. An external deep import is rejected.
3. A sibling implementation import within a barrel subtree is accepted.
4. An internal import through its own barrel is rejected.
5. The barrel's imports/re-exports of its implementation files are accepted.
6. Nested-barrel imports obey both inner and outer boundaries.
7. Equivalent relative and aliased specifiers receive the same classification.
8. Type-only exports/imports receive the chosen, documented behavior.
9. Write mode is deterministic and idempotent.
10. Check mode succeeds for current output and fails without modifying files when output is stale.
11. Diagnostics name the violated boundary and suggest the permitted route.

## Costs and Tradeoffs

- **Lint/config size:** A generated override per boundary may grow with the number of barrels.
- **Generation time:** Discovery and import-resolution metadata loading add work, especially in a monorepo.
- **Lint time:** Per-import resolved-path checks may be more expensive than textual restrictions.
- **Maintenance:** Alias and module-resolution semantics must remain aligned with TypeScript and ESLint.
- **Architecture rigidity:** Once a directory has `index.ts`, it becomes an enforced boundary; some `index.ts` files may be conveniences rather than intended public interfaces.
- **Nested-boundary complexity:** Correct behavior is understandable but requires careful tests and diagnostics.

## Caveats

- Treating every `index.ts` as an architectural boundary may be too broad. The refined design should consider an inclusion/exclusion mechanism or an explicit declaration convention.
- `export *` may accidentally expand a public API and should not be encouraged merely because a barrel exists.
- Barrels can affect circular dependencies, bundler behavior, incremental builds, and tree-shaking. This tool enforces access boundaries; it does not prove those properties are healthy.
- Internal code importing its own barrel is particularly risky because the barrel commonly re-exports that internal code.
- Textual ESLint restrictions can be bypassed unintentionally through aliases unless imports are resolved consistently.
- The generated file should be reviewable, but it remains derived output; the source tree and generator configuration are authoritative.

## Implementation Ideas to Evaluate

These are leads, not settled requirements:

- Discover candidate barrels with a filesystem walk constrained to configured source roots and ignore patterns.
- Build a normalized map from each barrel entry file to its directory boundary.
- Classify each resolved importer/target pair using ancestor relationships among normalized paths.
- Generate ESLint flat-config overrides and/or a compact data table consumed by a custom rule.
- Reuse the project's TypeScript-aware resolver rather than independently approximating path aliases.
- Generate to a temporary sibling file and rename it into place after successful completion.
- Add the check command to CI and optionally to a pre-commit workflow.

## Open Questions for Refinement

1. Does every in-scope `index.ts` declare a boundary, or is explicit opt-in/opt-out needed?
2. What are the exact source roots and ignored/generated directories?
3. Are `index.tsx`, `index.js`, and other entry-point names supported?
4. What module-resolution mechanisms and aliases must be understood?
5. Are cross-package workspace imports governed by the same rules?
6. Should the generated file be committed, or generated during setup and checked only in CI?
7. Can existing ESLint plugins express the required resolved semantics, or should the generated file configure a purpose-built rule?
8. What exact CLI, function, and configuration types should the implementation expose?
9. What behavior is expected for imports that cannot be resolved?

Before implementation, the next agent should resolve these questions, agree on exact type signatures and data flow, and add a comprehensive importer/target decision table.
