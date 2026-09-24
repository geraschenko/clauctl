# Formatted `tail`/`query` output, cursors, and `tail --since`

Follow-up specs to `docs/specs/format.md` (captured 2026-07-15, not yet
specced).

## 1. Formatted text as the default output of `tail` and `query`

Like pictl's `tail` and `prompt`: `clauctl tail` and `clauctl query` should
emit formatted text by default, with `--json` for the current raw JSONL.
(`src/core/tail.ts` already carries a TODO placing raw mode behind a flag once
formatted tail lands.)

With default (formatted) output, both commands should also emit a final

```
[cursor: <uuid>]
```

line carrying the uuid of the last formatted message, so a follow-up
invocation can resume from that point (see `--since` below). Message uuids are
available on both sources: `SDKMessage` variants carry `uuid` on the live
stream, and session-file entries carry `uuid` in history.

**Prerequisite — streaming format.** `parseSessionRecords` /
`parseTailRecords` / `formatSessionRecords` / `formatTailRecords` currently
consume the whole input before emitting anything. That breaks
`clauctl query XXX | clauctl format messages` (and formatted `tail`, which
never ends): `query` emits messages as they arrive, so `format` must consume a
stream and emit a stream. The rendering core is already incremental —
`FormatState` is threaded record-by-record and each record renders
independently — so the restructure is in the driver layer: parse and validate
line-by-line, emit each chunk (with its blank-line separator) as it is
produced instead of `joinChunks` at the end.

## 2. `tail --since <uuid>`

`tail --since <uuid>` returns all messages _after_ the specified one — the
consumer of the `[cursor: ...]` line above. Together they give a poll loop:
format a stretch of conversation, remember the cursor, later ask for
everything since it.

The live sdk.sock stream only carries messages from subscribe time onward, so
serving `--since` for uuids older than the subscription requires reading the
session file — now available: `src/core/session-file.ts`
(`readSessionEntries`) and the `get-entries` request landed with the
session-tree work. Slicing history after a given uuid is the complement of
`historyUpToBoundary` in `src/tui/sdk-render.ts` (which slices up to a
boundary); `--since` is that slice plus the live stream.
