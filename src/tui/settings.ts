/**
 * clauctl's persisted TUI settings: `<configDir>/settings.json`, a flat JSON
 * object read once at startup. Unlike keybindings.json there is no in-TUI
 * editing surface yet (a `/settings` command is a planned follow-up —
 * docs/specs/tui-fullscreen.md, Non-goals), so this module is read-only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiMode } from "@earendil-works/pi-tui";
import { clauctlConfigDir } from "./keybindings.ts";

export interface ClauctlSettings {
  tuiMode: TuiMode;
  /** Draw a rule between the transcript's resolved and pending parts (a
   *  debugging aid for the merge; see transcript.ts). */
  showResolvedBoundary: boolean;
}

const DEFAULT_SETTINGS: ClauctlSettings = {
  tuiMode: "fullscreen",
  showResolvedBoundary: false,
};

const TUI_MODES: readonly TuiMode[] = ["regular", "fullscreen"];

/** <clauctlConfigDir()>/settings.json */
export function settingsPath(): string {
  return join(clauctlConfigDir(), "settings.json");
}

/**
 * Read + parse the settings file. Never throws; a missing file yields the
 * defaults silently, and every recoverable problem (unreadable/unparseable
 * file, non-object root, unknown key, bad value) yields the default for the
 * affected field(s) plus a warning — settings must never prevent startup.
 */
export function readSettings(path: string): {
  settings: ClauctlSettings;
  warnings: string[];
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: { ...DEFAULT_SETTINGS }, warnings: [] };
    }
    return {
      settings: { ...DEFAULT_SETTINGS },
      warnings: [`cannot read ${path}: ${String(error)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warnings: [`cannot parse ${path}: ${String(error)}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warnings: [`${path}: root must be a JSON object`],
    };
  }
  const settings: ClauctlSettings = { ...DEFAULT_SETTINGS };
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "tuiMode") {
      if (TUI_MODES.includes(value as TuiMode)) {
        settings.tuiMode = value as TuiMode;
      } else {
        warnings.push(
          `"tuiMode": expected ${TUI_MODES.map((mode) => `"${mode}"`).join(" or ")} ` +
            `(got ${JSON.stringify(value)}; using "${DEFAULT_SETTINGS.tuiMode}")`,
        );
      }
    } else if (key === "showResolvedBoundary") {
      if (typeof value === "boolean") {
        settings.showResolvedBoundary = value;
      } else {
        warnings.push(
          `"showResolvedBoundary": expected a boolean (got ${JSON.stringify(value)}; ` +
            `using ${DEFAULT_SETTINGS.showResolvedBoundary})`,
        );
      }
    } else {
      warnings.push(`unknown setting "${key}" (ignored)`);
    }
  }
  return { settings, warnings };
}
