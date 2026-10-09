/**
 * The interactive-mode directory's only import surface (eslint
 * `no-restricted-imports`); the siblings are implementation and import each
 * other directly, never this file.
 */

export { runInteractive } from "./run-interactive.ts";
export type { InteractiveOutcome } from "./interactive-mode.ts";
