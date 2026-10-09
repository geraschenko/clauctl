/**
 * The `/effort` menu: a plain pi-tui SelectList over the current model's
 * supported effort levels. Focus handling lives in interactive-mode
 * (appended near the editor while open, removed on select/cancel).
 */

import {
  Container,
  getKeybindings,
  SelectList,
  Text,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { keyHints } from "../keybindings.ts";
import { getEditorTheme, theme } from "../theme.ts";

const MAX_VISIBLE_LEVELS = 10;

export class EffortSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly selectList: SelectList;

  constructor(
    levels: EffortLevel[],
    onSelect: (level: EffortLevel) => void,
    onCancel: () => void,
  ) {
    super();
    this.selectList = new SelectList(
      levels.map((level) => ({ value: level, label: level })),
      MAX_VISIBLE_LEVELS,
      getEditorTheme().selectList,
    );
    // Items are built from `levels`, so the value round-trips as EffortLevel.
    this.selectList.onSelect = (item) => onSelect(item.value as EffortLevel);
    this.selectList.onCancel = onCancel;
    const hint = keyHints(getKeybindings(), [
      ["tui.select.cancel", "to cancel"],
    ]).join(", ");
    this.addChild(
      new Text(
        theme.fg(
          "accent",
          hint === "" ? "select effort level" : `select effort level (${hint})`,
        ),
        1,
        0,
      ),
    );
    this.addChild(this.selectList);
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
