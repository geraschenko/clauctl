/**
 * The one glyph vocabulary for entry kinds, shared by the transcript
 * components and the session tree (`format tree`, `/tree`). Every glyph is
 * exactly one terminal column: the tree renderer places it in a fixed
 * graph grid. Clauctl-independent modules (`format/dag-lines.ts`,
 * `core/tree/parent-map.ts`) must not import this — pictl renders its own
 * vocabulary through the same layer.
 */

/** Transcript gutter glyphs. */
export const USER_GLYPH = "❯";
export const ASSISTANT_GLYPH = "●";
/** A tool call "plays" the command. */
export const TOOL_CALL_GLYPH = "▸";
export const TOOL_RESULT_GLYPH = "⤷";

/** Tree-only. */
export const COMPACT_BOUNDARY_GLYPH = "═";
export const COMPACT_SUMMARY_GLYPH = "□";
export const OTHER_ENTRY_GLYPH = "·";
