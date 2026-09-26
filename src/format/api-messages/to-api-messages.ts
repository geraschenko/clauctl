/**
 * The context as the assistant receives it: the CLI's stage-5 wire
 * normalization over a `contextAt` context (docs/specs/api-messages.md;
 * facts from docs/derisk/api-context-view/P0-binary-read.md §b). Pure:
 * entries in, `messages` array out, plus what each entry contributed.
 */

import type { UUID } from "node:crypto";
import { isRecord } from "../../core/generated/util.ts";
import type { SessionEntry } from "../../core/session/file.ts";
import {
  renderAttachmentEntry,
  type AttachmentRendering,
  type RenderedBy,
} from "./render-attachment.ts";

export type { RenderedBy } from "./render-attachment.ts";

export interface ApiConversionInputs {
  /** The CLI's CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM: attachments go
   *  out as `role: "system"` messages instead of `<system-reminder>` text
   *  in user messages. Not persisted, so supplied by the caller. */
  forceMidConversationSystem: boolean;
  /** The model the request is for; thinking blocks of other models are
   *  removed, as the CLI does. Default: the model of the context's last
   *  assistant message. */
  model?: string;
}

/** A text block we produce, or an entry's block passed through verbatim
 *  (untrusted shape beyond `type`). */
export type ApiContentBlock = { type: string; [key: string]: unknown };

export interface ApiMessage {
  role: "user" | "assistant" | "system";
  content: ApiContentBlock[];
}

/** What one context entry put on the wire. */
export type WireContribution =
  | { kind: "message" }
  | { kind: "text"; texts: string[]; renderedBy: RenderedBy }
  | {
      kind: "none";
      reason: "skipped" | "renders-nothing" | "thinking-only" | "empty-content";
    };

export interface ApiConversion {
  messages: ApiMessage[];
  contributions: Map<UUID, WireContribution>;
  /** The entries behind each message, aligned with `messages`. */
  entryUuidsByMessage: UUID[][];
}

/** The wrapper the CLI puts around attachment text in user messages
 *  (binary anchor `<system-reminder>\n`; observed by the
 *  tests/sdk/api-context.test.ts "total_tokens_reminder" fixture). Under
 *  mid-conversation system it is stripped again, snapshot or not
 *  ("mid-conversation system" fixture). */
const SYSTEM_REMINDER_OPEN = "<system-reminder>\n";
const SYSTEM_REMINDER_CLOSE = "\n</system-reminder>";

/** Attachment types the CLI keeps as user text even under
 *  mid-conversation system (binary anchor `unknown_command_fallback`,
 *  the switch preceding the system-message flush). */
const NEVER_FOLDED: ReadonlySet<string> = new Set([
  "queued_command",
  "session_context",
  "instructions",
  "coordinator_context",
  "context_sections",
  "remote_session_change",
  "fork_briefing",
  "poll_events",
  "cowork_memory_context",
  "artifact_opening_prefetch",
  "dir_sync_notice",
  "unknown_command_fallback",
]);

function wrapSystemReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}${text}${SYSTEM_REMINDER_CLOSE}`;
}

function unwrapSystemReminder(text: string): string {
  return text.startsWith(SYSTEM_REMINDER_OPEN) &&
    text.endsWith(SYSTEM_REMINDER_CLOSE)
    ? text.slice(SYSTEM_REMINDER_OPEN.length, -SYSTEM_REMINDER_CLOSE.length)
    : text;
}

function textBlock(text: string): ApiContentBlock {
  return { type: "text", text };
}

/** The entry's message content as blocks: a string becomes one text
 *  block; unknown shapes become no blocks; a tool_use keeps only its wire
 *  fields (the CLI drops its `caller` annotation). */
function contentBlocks(entry: SessionEntry): ApiContentBlock[] {
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  if (typeof content === "string") {
    return [textBlock(content)];
  }
  return Array.isArray(content)
    ? content.flatMap((block): ApiContentBlock[] => {
        if (!isRecord(block) || typeof block.type !== "string") {
          return [];
        }
        return block.type === "tool_use"
          ? [
              {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              },
            ]
          : [block as ApiContentBlock];
      })
    : [];
}

function isThinking(block: ApiContentBlock): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function isToolResult(block: ApiContentBlock): boolean {
  return block.type === "tool_result";
}

function isSkipped(entry: SessionEntry): boolean {
  if (entry.type === "progress" || entry.isVirtual === true) {
    return true;
  }
  if (entry.type === "system") {
    return entry.subtype !== "local_command";
  }
  if (entry.type === "attachment") {
    return (
      isRecord(entry.attachment) && entry.attachment.type === "thinking_drop"
    );
  }
  if (entry.type === "assistant") {
    const model = isRecord(entry.message) ? entry.message.model : undefined;
    return entry.isApiErrorMessage === true && model === "<synthetic>";
  }
  return entry.type !== "user";
}

/** The CLI's user-into-user merge: adjacent text blocks at the seam are
 *  joined by a newline, tool_results are hoisted to the front (binary
 *  anchor `uuid:e.isMeta?n.uuid:e.uuid`; observed by every
 *  tests/sdk/api-context.test.ts fixture whose attachment precedes the
 *  prompt). */
function mergeUserContent(
  previous: ApiContentBlock[],
  next: ApiContentBlock[],
): ApiContentBlock[] {
  const seamPrevious = previous.at(-1);
  const joined =
    seamPrevious?.type === "text" &&
    typeof seamPrevious.text === "string" &&
    next[0]?.type === "text"
      ? [
          ...previous.slice(0, -1),
          { ...seamPrevious, text: `${seamPrevious.text}\n` },
          ...next,
        ]
      : [...previous, ...next];
  const toolResults: ApiContentBlock[] = [];
  const others: ApiContentBlock[] = [];
  for (const block of joined) {
    (isToolResult(block) ? toolResults : others).push(block);
  }
  return [...toolResults, ...others];
}

/** The CLI's attachment-into-user merge (binary: the reducer over the
 *  attachment's messages next to the anchor `uuid:e.isMeta?n.uuid:e.uuid`).
 *  Texts following a tool_result fold into that block's content; anything
 *  else is appended as blocks. Observed by the `attachment after
 *  tool_result` fixture in tests/sdk/api-context.test.ts. */
function mergeAttachmentTexts(
  previous: ApiContentBlock[],
  texts: string[],
): ApiContentBlock[] {
  const last = previous.at(-1);
  if (last === undefined || !isToolResult(last)) {
    return [...previous, ...texts.map(textBlock)];
  }
  const content = last.content;
  if (content === undefined || typeof content === "string") {
    const joined = [content ?? "", ...texts]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n");
    return [...previous.slice(0, -1), { ...last, content: joined }];
  }
  if (!Array.isArray(content)) {
    return [...previous, ...texts.map(textBlock)];
  }
  const seam = content.at(-1);
  const seamed =
    isRecord(seam) && seam.type === "text" && typeof seam.text === "string"
      ? [...content.slice(0, -1), { ...seam, text: `${seam.text}\n` }]
      : content;
  return [
    ...previous.slice(0, -1),
    { ...last, content: [...seamed, ...texts.map(textBlock)] },
  ];
}

interface PendingUser {
  blocks: ApiContentBlock[];
  uuid: UUID | undefined;
}

/** The forward build: messages in wire order with the placement and merge
 *  rules that only need the entries seen so far. */
class WireBuilder {
  readonly messages: ApiMessage[] = [];
  readonly contributions = new Map<UUID, WireContribution>();
  /** The entries behind each message, for tail fix-up bookkeeping. */
  readonly entryUuidsByMessage: UUID[][] = [];
  /** Prompts and local-command outputs since the latest anchor (assistant
   *  or tool-result user); the CLI moves attachments before them, so they
   *  reach the wire only at the next anchor or the end. */
  private pendingUsers: PendingUser[] = [];
  /** Where each assistant `message.id` went, so parallel tool calls
   *  (tool_use entries sharing an id, interleaved with their results)
   *  regroup into one message. The CLI forgets the ids at any user
   *  message without a tool_result (binary: the map cleared by the
   *  "some tool_result" predicate next to `uuid:e.isMeta?n.uuid:e.uuid`).
   * */
  private assistantIndexByMessageId = new Map<unknown, number>();
  private pendingSystemTexts: { text: string; uuid: UUID | undefined }[] = [];
  private readonly inputs: ApiConversionInputs;

  constructor(inputs: ApiConversionInputs) {
    this.inputs = inputs;
  }

  private trailingUser(): ApiMessage | undefined {
    const last = this.messages.at(-1);
    return last?.role === "user" ? last : undefined;
  }

  private push(
    role: ApiMessage["role"],
    content: ApiContentBlock[],
    uuids: UUID[],
  ): void {
    this.messages.push({ role, content });
    this.entryUuidsByMessage.push(uuids);
    if (role === "user" && !content.some(isToolResult)) {
      this.assistantIndexByMessageId.clear();
    }
  }

  private mergeOrPushUser(blocks: ApiContentBlock[], uuid: UUID | undefined) {
    const trailing = this.trailingUser();
    if (trailing === undefined) {
      this.push("user", blocks, uuid === undefined ? [] : [uuid]);
      return;
    }
    trailing.content = mergeUserContent(trailing.content, blocks);
    if (uuid !== undefined) {
      this.entryUuidsByMessage.at(-1)!.push(uuid);
    }
  }

  private flushPendingUsers(): void {
    for (const pending of this.pendingUsers) {
      this.mergeOrPushUser(pending.blocks, pending.uuid);
    }
    this.pendingUsers = [];
  }

  /** Attachments are joined by a blank line (provenance in `pushAttachment`,
   *  where one attachment's texts are joined). */
  private flushSystem(): void {
    if (this.pendingSystemTexts.length > 0) {
      this.push(
        "system",
        [textBlock(this.pendingSystemTexts.map((p) => p.text).join("\n\n"))],
        this.pendingSystemTexts.flatMap((p) =>
          p.uuid === undefined ? [] : [p.uuid],
        ),
      );
      this.pendingSystemTexts = [];
    }
  }

  pushUser(entry: SessionEntry): void {
    const blocks = contentBlocks(entry);
    if (blocks.length === 0) {
      this.contribute(entry, { kind: "none", reason: "empty-content" });
      return;
    }
    this.contribute(entry, { kind: "message" });
    if (blocks.some(isToolResult)) {
      this.flushPendingUsers();
      this.mergeOrPushUser(blocks, entry.uuid);
    } else {
      this.pendingUsers.push({ blocks, uuid: entry.uuid });
    }
  }

  pushAssistant(entry: SessionEntry): void {
    const message = isRecord(entry.message) ? entry.message : {};
    let blocks = contentBlocks(entry);
    // Foreign-model thinking is removed (binary: the filter selected by
    // the `keepForeignThinking` setting, default none; `<synthetic>` is
    // the CLI's own marker model, defined next to "No response
    // requested."). The CLI removes only signed or redacted thinking;
    // persisted thinking is always signed. Observed by the `foreign
    // thinking` fixture in tests/sdk/api-context.test.ts.
    if (
      this.inputs.model !== undefined &&
      typeof message.model === "string" &&
      message.model !== this.inputs.model &&
      message.model !== "<synthetic>"
    ) {
      blocks = blocks.filter((block) => !isThinking(block));
    }
    this.contribute(entry, { kind: "message" });
    this.flushPendingUsers();
    const regroupIndex = this.assistantIndexByMessageId.get(message.id);
    if (regroupIndex !== undefined) {
      this.messages[regroupIndex]!.content.push(...blocks);
      this.entryUuidsByMessage[regroupIndex]!.push(
        ...(entry.uuid === undefined ? [] : [entry.uuid]),
      );
      return;
    }
    this.flushSystem();
    this.push(
      "assistant",
      blocks,
      entry.uuid === undefined ? [] : [entry.uuid],
    );
    if (message.id !== undefined) {
      this.assistantIndexByMessageId.set(message.id, this.messages.length - 1);
    }
  }

  pushLocalCommand(entry: SessionEntry): void {
    const content = typeof entry.content === "string" ? entry.content : "";
    this.contribute(entry, {
      kind: "text",
      texts: [content],
      renderedBy: "snapshot",
    });
    this.pendingUsers.push({ blocks: [textBlock(content)], uuid: entry.uuid });
  }

  pushAttachment(entry: SessionEntry): void {
    const rendering = renderAttachmentEntry(entry);
    if (rendering === undefined) {
      this.contribute(entry, { kind: "none", reason: "renders-nothing" });
      return;
    }
    this.foldAttachment(entry, rendering);
  }

  /** A `*_reminder_sent` record in the context's tail: the CLI re-sends
   *  its `text` on the request that follows (docs/claude-agent-sdk.md,
   *  "Reminder attachments are re-applied at request time"), folded like
   *  any attachment text. Bare, never wrapped: observed live in the
   *  session that built docs/specs/api-messages.md (WORK LOG 2026-09-30);
   *  text block vs. joined text is unverified by capture. */
  pushTailReminder(entry: SessionEntry, text: string): void {
    this.foldAttachment(entry, { texts: [text], renderedBy: "snapshot" });
  }

  private foldAttachment(
    entry: SessionEntry,
    rendering: AttachmentRendering,
  ): void {
    const attachment = isRecord(entry.attachment) ? entry.attachment : {};
    const type = attachment.type;
    // A steer (the user's mid-turn prompt) in mid-conversation system mode
    // is a pending user with the wrapper stripped (binary: the list
    // flushed at the next assistant, next to `uuid:e.isMeta?n.uuid:e.uuid`).
    const steer =
      this.inputs.forceMidConversationSystem &&
      type === "queued_command" &&
      attachment.humanTurn === true &&
      attachment.commandMode === "prompt" &&
      entry.isMeta !== true;
    const toSystem =
      this.inputs.forceMidConversationSystem &&
      !(typeof type === "string" && NEVER_FOLDED.has(type));
    // Snapshots are persisted wrapped; the fallback is bare.
    const wireTexts = rendering.texts.map((text) =>
      toSystem || steer
        ? unwrapSystemReminder(text)
        : rendering.renderedBy === "fallback"
          ? wrapSystemReminder(text)
          : text,
    );
    this.contribute(entry, {
      kind: "text",
      texts: wireTexts,
      renderedBy: rendering.renderedBy,
    });
    if (steer) {
      this.pendingUsers.push({
        blocks: wireTexts.map(textBlock),
        uuid: entry.uuid,
      });
      return;
    }
    if (toSystem) {
      // One attachment's texts are joined by a newline (binary: the
      // attachment-to-system join before `### Phase 4: Final Plan`); the
      // attachments by a blank line (`flushSystem`). Observed on Anton's
      // 2.1.280 session (docs/specs/api-messages.md WORK LOG 2026-09-29).
      this.pendingSystemTexts.push({
        text: wireTexts.join("\n"),
        uuid: entry.uuid,
      });
      return;
    }
    // Without a trailing user message, each text is a user message of
    // its own.
    const trailing = this.trailingUser();
    if (trailing === undefined) {
      for (const text of wireTexts) {
        this.push(
          "user",
          [textBlock(text)],
          entry.uuid === undefined ? [] : [entry.uuid],
        );
      }
      return;
    }
    trailing.content = mergeAttachmentTexts(trailing.content, wireTexts);
    if (entry.uuid !== undefined) {
      this.entryUuidsByMessage.at(-1)!.push(entry.uuid);
    }
  }

  contribute(entry: SessionEntry, contribution: WireContribution): void {
    if (entry.uuid !== undefined) {
      this.contributions.set(entry.uuid, contribution);
    }
  }

  finish(): void {
    this.flushPendingUsers();
    this.flushSystem();
  }
}

function lastAssistantModel(
  context: readonly SessionEntry[],
): string | undefined {
  for (let index = context.length - 1; index >= 0; index--) {
    const entry = context[index]!;
    const model = isRecord(entry.message) ? entry.message.model : undefined;
    if (entry.type === "assistant" && typeof model === "string") {
      return model;
    }
  }
  return undefined;
}

const TAIL_REMINDER_TYPES: ReadonlySet<string> = new Set([
  "batching_reminder_sent",
  "secondary_reminder_sent",
]);

/** The reminder records the CLI re-applies on the next request: per type,
 *  the latest `clearAt: "next_user_message"` record among the attachments
 *  trailing the last non-attachment entry (binary: the backwards walk
 *  over `clearAt==="next_user_message"` next to `batching_reminder_sent`;
 *  virtual entries are skipped, any other entry ends the walk). */
function tailReminders(context: readonly SessionEntry[]): Map<UUID, string> {
  const reminders = new Map<UUID, string>();
  const seenTypes = new Set<string>();
  for (let index = context.length - 1; index >= 0; index--) {
    const entry = context[index]!;
    if (entry.isVirtual === true) {
      continue;
    }
    if (entry.type !== "attachment") {
      break;
    }
    const attachment = isRecord(entry.attachment) ? entry.attachment : {};
    const type = attachment.type;
    if (
      typeof type === "string" &&
      TAIL_REMINDER_TYPES.has(type) &&
      !seenTypes.has(type) &&
      attachment.clearAt === "next_user_message" &&
      typeof attachment.text === "string" &&
      entry.uuid !== undefined
    ) {
      seenTypes.add(type);
      reminders.set(entry.uuid, attachment.text);
    }
  }
  return reminders;
}

/** Stage-5 wire normalization over a context (contextAt order). */
export function toApiMessages(
  context: readonly SessionEntry[],
  inputs: ApiConversionInputs,
): ApiConversion {
  const builder = new WireBuilder({
    ...inputs,
    model: inputs.model ?? lastAssistantModel(context),
  });
  const reminders = tailReminders(context);
  for (const entry of context) {
    const reminderText =
      entry.uuid === undefined ? undefined : reminders.get(entry.uuid);
    if (isSkipped(entry)) {
      builder.contribute(entry, { kind: "none", reason: "skipped" });
    } else if (reminderText !== undefined) {
      builder.pushTailReminder(entry, reminderText);
    } else if (entry.type === "user") {
      builder.pushUser(entry);
    } else if (entry.type === "assistant") {
      builder.pushAssistant(entry);
    } else if (entry.type === "system") {
      builder.pushLocalCommand(entry);
    } else {
      builder.pushAttachment(entry);
    }
  }
  builder.finish();
  return {
    ...fixUpTail(
      builder.messages,
      builder.entryUuidsByMessage,
      builder.contributions,
      inputs.forceMidConversationSystem,
    ),
    contributions: builder.contributions,
  };
}

function isEmptyText(block: ApiContentBlock): boolean {
  return block.type === "text" && block.text === "";
}

/** The CLI's empty-text rule for assistant content (binary: the
 *  `"[Empty text removed]"` spacer in the assistant regroup merge): empty
 *  text blocks are removed, except that one sitting between two thinking
 *  blocks becomes the spacer so the thinking blocks stay apart. */
function withEmptyTextsRemoved(blocks: ApiContentBlock[]): ApiContentBlock[] {
  return blocks.flatMap((block, index) => {
    if (!isEmptyText(block)) {
      return [block];
    }
    const before = blocks[index - 1];
    const after = blocks.slice(index + 1).find((b) => !isEmptyText(b));
    return before !== undefined &&
      after !== undefined &&
      isThinking(before) &&
      isThinking(after)
      ? [textBlock("[Empty text removed]")]
      : [];
  });
}

/** A wire message with the entries behind it, through the tail fix-up. */
interface AttributedMessage {
  message: ApiMessage;
  uuids: UUID[];
}

/** The passes that need the whole list: thinking-only assistants dropped
 *  (binary anchor `tengu_filtered_orphaned_thinking_message`); adjacent
 *  users merged — the CLI does this only after such a drop, or always
 *  under mid-conversation system; trailing thinking of the last assistant
 *  stripped (anchor `tengu_filtered_trailing_thinking_block`; its `[No
 *  message content]` filler is unreachable here, the thinking-only drop
 *  precedes it); whitespace-only assistants dropped and `(no content)`
 *  filled in (anchor: the `"[Empty text removed]"` definition and the
 *  predicate after it). Observed by the `thinking-only assistant dropped`
 *  fixture in tests/sdk/api-context.test.ts. */
function fixUpTail(
  messages: ApiMessage[],
  entryUuidsByMessage: UUID[][],
  contributions: Map<UUID, WireContribution>,
  alwaysMergeUsers: boolean,
): Pick<ApiConversion, "messages" | "entryUuidsByMessage"> {
  const drop = (uuids: UUID[], reason: "thinking-only" | "empty-content") => {
    for (const uuid of uuids) {
      contributions.set(uuid, { kind: "none", reason });
    }
  };
  let dropped = false;
  const survivors = messages.flatMap((message, index): AttributedMessage[] => {
    const content =
      message.role === "assistant"
        ? withEmptyTextsRemoved(message.content)
        : message.content;
    const uuids = entryUuidsByMessage[index]!;
    if (
      message.role === "assistant" &&
      content.length > 0 &&
      content.every(isThinking)
    ) {
      drop(uuids, "thinking-only");
      dropped = true;
      return [];
    }
    return [{ message: { role: message.role, content }, uuids }];
  });
  const kept: AttributedMessage[] = [];
  let lastAssistant: ApiMessage | undefined;
  for (const attributed of survivors) {
    const previous = kept.at(-1);
    if (
      (dropped || alwaysMergeUsers) &&
      attributed.message.role === "user" &&
      previous?.message.role === "user"
    ) {
      previous.message.content = mergeUserContent(
        previous.message.content,
        attributed.message.content,
      );
      previous.uuids.push(...attributed.uuids);
      continue;
    }
    kept.push(attributed);
    if (attributed.message.role === "assistant") {
      lastAssistant = attributed.message;
    }
  }
  while (
    lastAssistant !== undefined &&
    lastAssistant.content.length > 0 &&
    isThinking(lastAssistant.content.at(-1)!)
  ) {
    lastAssistant.content.pop();
  }
  const result: Pick<ApiConversion, "messages" | "entryUuidsByMessage"> = {
    messages: [],
    entryUuidsByMessage: [],
  };
  for (const { message, uuids } of kept) {
    const whitespaceOnly =
      message.role === "assistant" &&
      message.content.length > 0 &&
      message.content.every(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim() === "",
      );
    if (whitespaceOnly) {
      drop(uuids, "empty-content");
      continue;
    }
    result.messages.push(
      message.role === "assistant" && message.content.length === 0
        ? { role: message.role, content: [textBlock("(no content)")] }
        : message,
    );
    result.entryUuidsByMessage.push(uuids);
  }
  return result;
}
