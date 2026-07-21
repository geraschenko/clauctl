/**
 * The TUI's autocomplete provider: pi-tui's CombinedAutocompleteProvider
 * (slash-command popup + fd-backed `@` file completion) wrapped to merge the
 * local commands into the agent's command list and to surface the install-fd
 * hint when `@` is used without fd available.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from "@earendil-works/pi-tui";

/** Commands the TUI intercepts at submit time; they shadow same-named SDK entries. */
const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "model", description: "select the agent's model interactively" },
  { name: "tree", description: "rewind the conversation via the session tree" },
  {
    name: "keybindings",
    description: "edit keybindings.json in $EDITOR and reload it",
  },
  {
    name: "reload-keybindings",
    description: "re-read keybindings.json and apply it",
  },
];

/** Locate fd by PATH lookup — `fd`, then `fdfind` (Debian). No auto-download. */
export function findFd(): string | null {
  const pathDirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "");
  for (const name of ["fd", "fdfind"]) {
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not there or not executable; keep looking.
      }
    }
  }
  return null;
}

/** Merge the SDK command list with the local commands (locals shadow by name). */
function mergeCommands(sdkCommands: SlashCommand[]): SlashCommand[] {
  const localNames = new Set(LOCAL_COMMANDS.map((command) => command.name));
  return [
    ...sdkCommands.filter((command) => !localNames.has(command.name)),
    ...LOCAL_COMMANDS,
  ];
}

// Matches pi-tui's @-prefix detection: an @ at a token boundary (start of
// line or after a token delimiter), with no whitespace after it.
const AT_PREFIX_PATTERN = /(?:^|[\s"'=])@[^\s]*$/;

export class TuiAutocompleteProvider implements AutocompleteProvider {
  private inner: CombinedAutocompleteProvider;
  private readonly cwd: string | null;
  private readonly fdPath: string | null;
  private readonly onAtWithoutFd: () => void;
  private hintFired = false;

  /**
   * `cwd` null (snapshot from a pre-extension daemon) disables `@` completion
   * the same way a missing fd does, minus the hint.
   */
  constructor(
    cwd: string | null,
    fdPath: string | null,
    onAtWithoutFd: () => void,
  ) {
    this.cwd = cwd;
    this.fdPath = fdPath;
    this.onAtWithoutFd = onAtWithoutFd;
    this.inner = this.buildInner([]);
  }

  /** Replace the SDK command list (e.g. on `commands_changed`). */
  setCommands(commands: SlashCommand[]): void {
    this.inner = this.buildInner(commands);
  }

  private buildInner(
    sdkCommands: SlashCommand[],
  ): CombinedAutocompleteProvider {
    // With no cwd there is no meaningful base for file completion; a null
    // fdPath makes the inner provider return nothing for @ prefixes.
    return new CombinedAutocompleteProvider(
      mergeCommands(sdkCommands),
      this.cwd ?? ".",
      this.cwd === null ? null : this.fdPath,
    );
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (this.fdPath === null && !this.hintFired) {
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if (AT_PREFIX_PATTERN.test(textBeforeCursor)) {
        this.hintFired = true;
        this.onAtWithoutFd();
      }
    }
    return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.inner.applyCompletion(
      lines,
      cursorLine,
      cursorCol,
      item,
      prefix,
    );
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    return this.inner.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
