# `src/base/`: a clauctl-agnostic layer below `core`

Follow-up from the format-tui-layering review (`docs/specs/format-tui-layering.md`,
`.dependency-cruiser.cjs` `DEPENDENCY_DAG`). Deferred by Anton; pictl has
since moved `text.ts` to its `src/core/`, so it syncs into
`src/core/generated/` like the rest.

## Problem

`core` plays two roles: clauctl's domain library (agents, sessions, the
daemon, the protocol) and "the bottom of the DAG". The pictl-synced files
(`src/core/generated/`, `src/format/generated/`) are neither domain code
nor a DAG key: they are unconstrained, so a synced file that imports
upward — which `completion.ts` did until the thunk refactor — passes the
cruise unnoticed. `generated/` also names provenance, not role.

## Proposal

- **Criterion**: `base` holds clauctl-agnostic code — nothing that knows
  agents, sessions, the daemon, or the protocol. "Synced from pictl" is
  today exactly this set (stricli plumbing `cli.ts`/`targets.ts`/
  `completion.ts`, `until-engine`, `line-reader`, `read-input`, `util`,
  `text.ts`, the repo-agnostic `streaming/` driver); the rule is the
  criterion, the sync list is the current membership.
- **DAG**: `base: []`, `core: ["base"]` (every other row unchanged; `base`
  is reachable from all layers through the hierarchy rule). `base` becomes a
  key, so upward imports fail the cruise.
- **Layout**: `src/base/` flat, `streaming/` beneath it; the sync script's
  three sets become one prefix, and its cross-set import rewriting goes
  away if pictl mirrors `src/base/`.
- **Membership**: start synced-only. Hand-written clauctl-agnostic code may
  join later, but the sync file list must stay the source of truth for what
  is generated (the DO-NOT-MODIFY header carries it per file).

## Open

- Whether pictl mirrors `src/base/` (then the sync is a copy) or clauctl
  rewrites paths on sync as today.

## Risk

Promotion-to-dodge-the-DAG: a module moved to `base` because it is
convenient to import from below, not because it is agnostic. The criterion
above is the review question for any addition.
