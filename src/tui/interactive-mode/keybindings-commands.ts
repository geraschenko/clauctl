import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
  editFileInExternalEditor,
  externalEditorCommand,
} from "../external-editor.ts";
import {
  CLAUCTL_KEYBINDINGS,
  conflictWarnings,
  keybindingsPath,
  promoteEditedDefaults,
  readKeybindingsConfig,
  writeDefaultBindings,
} from "../keybindings.ts";
import type { Banner } from "../transcript/index.ts";

/**
 * `/keybindings`: refresh default_bindings (skipped with a banner when the
 * existing file is unparseable — the editor still opens, since this is
 * also the repair tool), edit the file in $VISUAL/$EDITOR with the TUI
 * stopped, promote post-editor default_bindings edits to top-level
 * overrides (only when the refresh succeeded — without that baseline,
 * drift is not attributable to this session), then reload.
 */
export async function editKeybindings(
  ui: TUI,
  keybindings: KeybindingsManager,
): Promise<Banner[]> {
  const editorCommand = externalEditorCommand();
  if (editorCommand === undefined) {
    return [{ text: "set $EDITOR to edit keybindings", color: "warning" }];
  }
  const banners: Banner[] = [];
  const path = keybindingsPath();
  let refreshed = true;
  try {
    writeDefaultBindings(path, CLAUCTL_KEYBINDINGS);
  } catch (error) {
    refreshed = false;
    banners.push({
      text: `keybindings: defaults refresh skipped: ${String(error)}`,
      color: "warning",
    });
  }
  if (!(await editFileInExternalEditor(ui, editorCommand, path))) {
    banners.push({
      text: "keybindings: editor exited nonzero; changes not applied",
      color: "warning",
    });
    return banners;
  }
  if (refreshed) {
    try {
      const { warnings } = promoteEditedDefaults(path, CLAUCTL_KEYBINDINGS);
      for (const warning of warnings) {
        banners.push({ text: `keybindings: ${warning}`, color: "warning" });
      }
    } catch (error) {
      banners.push({ text: `keybindings: ${String(error)}`, color: "error" });
      return banners;
    }
  }
  return [...banners, ...reloadKeybindings(keybindings)];
}

/**
 * `/reload-keybindings` (also the tail of editKeybindings): re-read the
 * config and apply it to the existing manager instance — pi-tui components
 * hold the same reference, so they see the change. A fatal read keeps the
 * current live bindings: a temporary syntax error must not strip a working
 * configuration.
 */
export function reloadKeybindings(keybindings: KeybindingsManager): Banner[] {
  const configRead = readKeybindingsConfig(
    keybindingsPath(),
    CLAUCTL_KEYBINDINGS,
  );
  if (!configRead.ok) {
    return [
      { text: `keybindings not reloaded: ${configRead.error}`, color: "error" },
    ];
  }
  keybindings.setUserBindings(configRead.bindings);
  const warnings = [...configRead.warnings, ...conflictWarnings(keybindings)];
  return warnings.length === 0
    ? [{ text: "keybindings reloaded" }]
    : warnings.map((warning) => ({
        text: `keybindings: ${warning}`,
        color: "warning",
      }));
}
