/**
 * The editor the user types prompts into. It owns the app actions that
 * apply while it occupies the input slot (docs/specs/input-slot.md);
 * pi-tui's Editor handles everything else. Mirrors pi's CustomEditor.
 */

import {
  Editor,
  getKeybindings,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

/** What the prompt editor can do beyond editing text. */
export interface PromptEditorActions {
  /** app.interrupt; false when there is nothing to interrupt, and the
   *  key then reaches pi-tui's Editor. */
  interrupt(): boolean;
  cyclePermissionMode(): void; // app.permissionMode.cycle
  editExternally(): void; // app.editor.external
  onCleared(): void; // app.clear, after the editor emptied itself
}

export class PromptEditor extends Editor {
  private readonly actions: PromptEditorActions;

  constructor(tui: TUI, theme: EditorTheme, actions: PromptEditorActions) {
    super(tui, theme);
    this.actions = actions;
  }

  override handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (
      keybindings.matches(data, "app.interrupt") &&
      !this.isShowingAutocomplete() &&
      this.actions.interrupt()
    ) {
      return;
    }
    if (keybindings.matches(data, "app.permissionMode.cycle")) {
      this.actions.cyclePermissionMode();
      return;
    }
    if (keybindings.matches(data, "app.editor.external")) {
      this.actions.editExternally();
      return;
    }
    if (keybindings.matches(data, "app.clear")) {
      // Cleared text stays reachable via up/down history (unlike pi, which
      // discards it).
      const clearedText = this.getText();
      if (clearedText.trim() !== "") {
        this.addToHistory(clearedText);
      }
      this.setText("");
      this.actions.onCleared();
      return;
    }
    super.handleInput(data);
  }
}
