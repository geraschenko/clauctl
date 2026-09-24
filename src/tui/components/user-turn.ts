// One user turn — prompt text, slash command, its output — as a single
// component, so a dequeue echo's provisional rendering is replaced in place
// by the entry's (TranscriptRenderer.replaceContent). Composes
// UserMessageComponent (prompt, contextTag) and UserCommandComponent
// (slashCommand, bashInput; an output view attaches to the turn's command
// child while it holds none, else renders as a standalone ⤷ block).

import { Container } from "@earendil-works/pi-tui";
import type { UserTurnView } from "../../format/sdk-render.ts";
import { UserCommandComponent } from "./user-command.ts";
import { UserMessageComponent } from "./user-message.ts";

export const isOutputView = (view: UserTurnView): boolean =>
  view.kind === "commandOutput" || view.kind === "bashOutput";

/** The text an output view shows; undefined when there is none (empty
 *  bash stdout and stderr). */
export function outputText(view: UserTurnView): string | undefined {
  switch (view.kind) {
    case "commandOutput":
      return view.text;
    case "bashOutput": {
      const parts = [view.stdout, view.stderr].filter(
        (part) => part.trim() !== "",
      );
      return parts.length > 0 ? parts.join("\n") : undefined;
    }
    default:
      return undefined;
  }
}

interface CommandChild {
  component: UserCommandComponent;
  /** The slash command (e.g. "/compact"); undefined for bash passthrough. */
  command: string | undefined;
  hasOutput: boolean;
}

export class UserTurnComponent extends Container {
  private expanded: boolean;
  /** Output attached after rendering (a later frame or entry); re-applied
   *  on every re-render. */
  private attachedOutput: string | undefined;
  /** The turn's command child, the target of output views. */
  private commandChild: CommandChild | undefined;

  constructor(views: readonly UserTurnView[], toolsExpanded: boolean) {
    super();
    this.expanded = toolsExpanded;
    this.updateContent(views);
  }

  /** Re-renders from `views`; attached output and expansion carry over. */
  updateContent(views: readonly UserTurnView[]): void {
    this.clear();
    this.commandChild = undefined;
    for (const view of views) {
      switch (view.kind) {
        case "prompt":
        case "contextTag":
          this.addChild(new UserMessageComponent(view.text));
          break;
        case "slashCommand":
          this.addCommand(
            view.args === "" ? view.command : `${view.command} ${view.args}`,
            view.command,
          );
          break;
        case "bashInput":
          this.addCommand(`! ${view.command}`, undefined);
          break;
        case "commandOutput":
        case "bashOutput": {
          const text = outputText(view);
          if (text !== undefined) {
            this.addOutput(text);
          }
          break;
        }
      }
    }
    if (this.attachedOutput !== undefined) {
      this.addOutput(this.attachedOutput);
    }
  }

  /** Output under the turn's command child. True when attached; false when
   *  the turn has no command child or it already holds output — the caller
   *  renders the output standalone. */
  attachOutput(text: string): boolean {
    const attached = this.attachToCommand(text);
    if (attached) {
      this.attachedOutput = text;
    }
    return attached;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const child of this.children) {
      if (child instanceof UserCommandComponent) {
        child.setExpanded(expanded);
      }
    }
  }

  private addCommand(line: string, command: string | undefined): void {
    const component = new UserCommandComponent(line);
    component.setExpanded(this.expanded);
    this.addChild(component);
    this.commandChild = { component, command, hasOutput: false };
  }

  private attachToCommand(text: string): boolean {
    if (this.commandChild === undefined || this.commandChild.hasOutput) {
      return false;
    }
    this.commandChild.hasOutput = true;
    this.commandChild.component.setOutput(text);
    return true;
  }

  /** An output view inside the turn: attached like `attachOutput`, but a
   *  turn without a command to hold it shows the output as a bare block. */
  private addOutput(text: string): void {
    if (this.attachToCommand(text)) {
      return;
    }
    const component = new UserCommandComponent(undefined);
    component.setOutput(text);
    component.setExpanded(this.expanded);
    this.addChild(component);
  }
}
