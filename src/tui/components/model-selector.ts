/**
 * The `/model` menu: a plain pi-tui SelectList over `supported-models`.
 * Focus handling lives in interactive-mode (appended near the editor while
 * open, removed on select/cancel).
 */

import {
  Container,
  getKeybindings,
  SelectList,
  Text,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { getEditorTheme, theme } from "../theme.ts";

const MAX_VISIBLE_MODELS = 10;

export class ModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly selectList: SelectList;

  constructor(
    models: ModelInfo[],
    onSelect: (model: ModelInfo) => void,
    onCancel: () => void,
  ) {
    super();
    const modelsByValue = new Map(models.map((model) => [model.value, model]));
    this.selectList = new SelectList(
      models.map((model) => ({
        value: model.value,
        label: model.displayName,
        description: model.description,
      })),
      MAX_VISIBLE_MODELS,
      getEditorTheme().selectList,
    );
    this.selectList.onSelect = (item) =>
      onSelect(modelsByValue.get(item.value)!);
    this.selectList.onCancel = onCancel;
    const cancelKey =
      getKeybindings().getKeys("tui.select.cancel")[0] ?? "escape";
    this.addChild(
      new Text(
        theme.fg("accent", `select model (${cancelKey} to cancel)`),
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
