# Spec: Convenience commands — `format` and `completion`

> Status: **scaffold** — sparse; few decisions made yet. Read `docs/overview.md`
> first. Mirror pictl's equivalents where they exist.
>
> **`format` is superseded by `docs/specs/format.md`**; only `completion`
> remains covered here.

TDC: `completion` has already been implemented. It was done very early.

## SPEC (stable requirements)

Ergonomics commands that make clauctl pleasant to use, analogous to pictl's:

- **`completion`** — emit shell completion scripts for clauctl's subcommands.
  Driven by the **stricli** CLI framework (same as pictl), so completion should
  fall out of the command definitions rather than being hand-maintained.
- **`format`** — format clauctl output (e.g. an agent's `SDKMessage` stream /
  status) for human consumption, analogous to pictl's `format`. The structured
  SDK stream is verbose JSON; `format` renders it readably (and, ideally, the
  _same_ render logic the TUI uses — single source of truth).

## IMPLEMENTATION IDEAS (evolving)

- Look at how pictl implements `completion` and `format` and mirror the structure;
  diverge only where the Claude SDK's data differs from pi's.
- `format` should likely share the `SDKMessage` → presentation mapping with the
  TUI render layer (see `docs/specs/tui.md`) to avoid duplicate rendering logic.
- Consider output modes: raw JSON passthrough vs. pretty/human vs. compact.

## WORK LOG

- (empty) — initial scaffold.

## Open questions

- Exact pictl `format`/`completion` behavior to mirror (review pictl source).
- What `format` operates on: a live stream, a saved transcript JSONL, or both.
- Which `SDKMessage` variants `format` needs to render and at what verbosity
  levels.
