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
/** A tool_result-only user entry with any `is_error` block. */
export const TOOL_RESULT_ERROR_GLYPH = "✗";

/** Tree-only. */
export const ATTACHMENT_GLYPH = "⎘";
export const COMPACT_BOUNDARY_GLYPH = "═";
export const COMPACT_SUMMARY_GLYPH = "□";
/** A user entry that is not a human prompt: isMeta expansions, command
 *  and shell echoes, interrupt markers, task notifications. In the
 *  assistant's context, not typed by the user. */
export const USER_BUT_NON_HUMAN_GLYPH = "◌";
export const OTHER_ENTRY_GLYPH = "·";
