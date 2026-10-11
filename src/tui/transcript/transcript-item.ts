import type { UUID } from "node:crypto";
import type { Component } from "@earendil-works/pi-tui";
import type { AssistantMessageComponent } from "../components/assistant-message.ts";
import type { ToolExecutionComponent } from "../components/tool-execution.ts";
import type { UserTurnComponent } from "../components/user-turn.ts";
import type { ToolView } from "../../format/entry-view/index.ts";
import type {
  RenderAssistant,
  RenderToolResult,
} from "../../format/render-types.ts";

export interface ItemKey {
  /** The uuid the item rendered under (`renderedUuids`' key); undefined
   *  for an unkeyed item (see `TranscriptItems`). Several items can share a
   *  uuid: every message has one uuid and (assistant) one content block,
   *  but `appendMessage` makes a top-level item per thing the user can
   *  fold or expand — a tool_use message yields its assistant item plus a
   *  tool item — so a uuid keys a contiguous run of one or more items. */
  uuid: UUID | undefined;
}

export interface AssistantItem extends ItemKey {
  kind: "assistant";
  component: AssistantMessageComponent;
  /** Undefined while streaming; streaming components never fold. */
  rendered?: RenderAssistant;
  /** Timestamp-delta duration; undefined when unavailable/non-monotonic. */
  thinkingSeconds?: number;
}

export interface ToolItem extends ItemKey {
  kind: "tool";
  name: string;
  component: ToolExecutionComponent;
  view: ToolView<unknown>;
  result?: RenderToolResult;
  /** A hook handed the agent context with the result; a fold would hide it. */
  hasHookContext?: true;
}

export interface PlainItem extends ItemKey {
  kind: "plain";
  component: Component;
}

/** A user turn's views as one component (prompt text, command, output). */
export interface UserTurnItem extends ItemKey {
  kind: "userTurn";
  component: UserTurnComponent;
}

export type TranscriptItem =
  AssistantItem | ToolItem | PlainItem | UserTurnItem;

/** A stream's item: the only unkeyed assistant item there is (subagent
 *  streams are nested, not items). */
export const isOpenStream = (item: TranscriptItem): boolean =>
  item.kind === "assistant" && item.uuid === undefined;
