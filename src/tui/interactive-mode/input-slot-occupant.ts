import type { Component } from "@earendil-works/pi-tui";
import type { EffortSelectorComponent } from "../components/effort-selector.ts";
import type { ModelSelectorComponent } from "../components/model-selector.ts";
import type { PermissionPromptComponent } from "../components/permission-prompt.ts";
import type { PromptEditor } from "../components/prompt-editor.ts";
import type { QuestionPromptComponent } from "../components/question-prompt.ts";
import type { TreeSelectorComponent } from "../components/tree-selector.ts";

/** What the input slot shows: the prompt editor, or what replaces it
 *  (docs/specs/input-slot.md). */
export type InputSlotOccupant =
  | { kind: "editor" }
  | { kind: "modelSelector"; selector: ModelSelectorComponent }
  | { kind: "effortSelector"; selector: EffortSelectorComponent }
  | { kind: "treeSelector"; selector: TreeSelectorComponent }
  | {
      kind: "permissionPrompt";
      toolUseId: string;
      prompt: PermissionPromptComponent;
    }
  | {
      kind: "questionPrompt";
      toolUseId: string;
      prompt: QuestionPromptComponent;
    };

/** An occupant showing a pending ask. */
export type AskPromptOccupant = Extract<
  InputSlotOccupant,
  { kind: "permissionPrompt" | "questionPrompt" }
>;

/** The component that represents `occupant` in the input slot. */
export function occupantComponent(
  occupant: InputSlotOccupant,
  editor: PromptEditor,
): Component {
  switch (occupant.kind) {
    case "editor":
      return editor;
    case "modelSelector":
      return occupant.selector;
    case "effortSelector":
      return occupant.selector;
    case "treeSelector":
      return occupant.selector;
    case "permissionPrompt":
      return occupant.prompt;
    case "questionPrompt":
      return occupant.prompt;
  }
}
