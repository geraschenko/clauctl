# `clauctl wait` returns the cursor where its condition was met

## Motivation

tg-worker's `tg` post-hook (see
[`until-api-request-end.md`](until-api-request-end.md)) runs
`clauctl wait --until <condition>` and then needs the cursor at which the
condition was met, to store as the task's resume point. Today `wait` only
exits. Decided with Anton (2026-10-08): `wait` reports that cursor.

A cursor is an entry the agent actually saw, suitable for
`set-context --rewind-to`. At a compact or `set-context` boundary it is the
boundary's `anchorUuid`, never `<uuid>@<boundary>`.

## Current state

- `src/commands/wait.ts`; conditions in `src/core/until.ts`.
- The conditions fire on `AgentEvent`s, some of which are SDK frames that
  precede the file entry carrying the same uuid
  (`docs/stream-merging.md`). The cursor must be a session entry, so `wait`
  may need to wait until the matching entry resolves before reporting it.

## To decide

- Output format: the bare uuid on stdout, or JSON behind `--json`, as other
  commands do.
- What it reports for conditions with no natural entry (`no-activity`): the
  leaf at that moment, or nothing.
