import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  KeybindingsManager,
  setKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import { KEY } from "../../test-support/keys.ts";
import { CLAUCTL_KEYBINDINGS } from "../keybindings.ts";
import { getEditorTheme } from "../theme.ts";
import { PromptEditor } from "./prompt-editor.ts";

setKeybindings(new KeybindingsManager(CLAUCTL_KEYBINDINGS, {}));

/** pi-tui's Editor reads only these from its TUI. */
const STUB_TUI = {
  requestRender: () => {},
  terminal: { rows: 40 },
} as unknown as TUI;

/** pi-tui's `tui.editor.jumpForward` default. */
const CTRL_RIGHT_BRACKET = "\x1d";

function promptEditor(isBusy: boolean): {
  editor: PromptEditor;
  interrupts: () => number;
} {
  let interruptCount = 0;
  const editor = new PromptEditor(STUB_TUI, getEditorTheme(), {
    interrupt: () => {
      if (!isBusy) return false;
      interruptCount += 1;
      return true;
    },
    cyclePermissionMode: () => {},
    editExternally: () => {},
    onCleared: () => {},
  });
  return { editor, interrupts: () => interruptCount };
}

function typeKeys(editor: PromptEditor, ...keys: string[]): void {
  for (const key of keys) editor.handleInput(key);
}

test("Esc interrupts a busy agent and is consumed (jump mode survives it)", () => {
  const { editor, interrupts } = promptEditor(true);
  typeKeys(editor, "a", "b", "c", "\x01", CTRL_RIGHT_BRACKET, KEY.escape, "c");
  assert.equal(interrupts(), 1);
  assert.equal(editor.getText(), "abc", "c jumped instead of being typed");
});

test("Esc with nothing to interrupt reaches Editor, which cancels jump mode", () => {
  const { editor, interrupts } = promptEditor(false);
  typeKeys(editor, "a", "b", "c", "\x01", CTRL_RIGHT_BRACKET, KEY.escape, "c");
  assert.equal(interrupts(), 0);
  assert.equal(editor.getText(), "cabc", "c was typed at the line start");
});

test("Esc with the autocomplete popup showing closes it instead of interrupting", async () => {
  const { editor, interrupts } = promptEditor(true);
  let requested!: () => void;
  const suggestionsRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const provider: AutocompleteProvider = {
    getSuggestions: (): Promise<AutocompleteSuggestions> => {
      requested();
      return Promise.resolve({
        prefix: "/",
        items: [{ value: "model", label: "model" }],
      });
    },
    applyCompletion: (lines, cursorLine, cursorCol) => ({
      lines,
      cursorLine,
      cursorCol,
    }),
  };
  editor.setAutocompleteProvider(provider);
  typeKeys(editor, "/");
  await suggestionsRequested;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(editor.isShowingAutocomplete());
  typeKeys(editor, KEY.escape);
  assert.equal(interrupts(), 0);
  assert.ok(!editor.isShowingAutocomplete());
  typeKeys(editor, KEY.escape);
  assert.equal(interrupts(), 1, "with the popup closed, Esc interrupts");
});
