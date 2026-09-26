/**
 * The compare utility of docs/specs/api-messages.md: a captured request,
 * split at the prompt turn, against the conversion of the same context.
 * Strict positional JSON comparison once every TOLERANCES entry has
 * rewritten both sides; the conversion's trailing messages are matched
 * as prefixes of the prompt turn and the system tail, whose remainder is
 * the CLI's request-time content.
 */

import { isRecord } from "../../core/generated/util.ts";
import type {
  ApiContentBlock,
  ApiConversion,
  ApiMessage,
  RenderedBy,
} from "./to-api-messages.ts";

/** A captured body cut at the prompt turn (the message the oracle's own
 *  prompt creates). */
export interface CapturedApiMessages {
  /** Every message before the prompt turn: what the context entries
   *  determine exactly. */
  apiMessages: ApiMessage[];
  /** The prompt turn's blocks before the prompt text: persisted trailing
   *  attachments first, then the CLI's request-time reminders. */
  promptTurnLeadingBlocks: ApiContentBlock[];
  /** Mid-conversation system only (hence also the mode): the trailing
   *  system message's single text — persisted trailing attachments joined
   *  by "\n\n", then request-time text. */
  systemTail: string | undefined;
}

export interface JsonDifference {
  /** JSON path into `messages`. */
  path: string;
  captured: unknown;
  synthesized: unknown;
}

interface Normalized {
  captured: ApiMessage[];
  synthesized: ApiMessage[];
  /** The differences the rewrite excused, with the values before it. */
  tolerated: JsonDifference[];
}

export interface Tolerance {
  why: string;
  removeWhen: string;
  /** Rewrites both lists so that the difference this tolerance covers
   *  disappears; touches nothing else. */
  normalize(
    captured: ApiMessage[],
    synthesized: ApiMessage[],
    conversion: ApiConversion,
  ): Normalized;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function textOf(block: ApiContentBlock | undefined): string | undefined {
  return block?.type === "text" && typeof block.text === "string"
    ? block.text
    : undefined;
}

const TOOL_BLOCK_ID_FIELDS = {
  tool_use: "id",
  tool_result: "tool_use_id",
} as const;

/** `type:id` of each tool block, in content order. */
function toolBlockKeys(content: ApiContentBlock[]): string[] {
  return content.flatMap((block) =>
    block.type === "tool_use" || block.type === "tool_result"
      ? [`${block.type}:${String(block[TOOL_BLOCK_ID_FIELDS[block.type]])}`]
      : [],
  );
}

/** tool_use blocks sorted by id among the positions tool_use blocks
 *  occupy, tool_result blocks likewise; other blocks stay put. */
function sortToolBlocks(content: ApiContentBlock[]): ApiContentBlock[] {
  const sorted = [...content];
  for (const [type, idField] of Object.entries(TOOL_BLOCK_ID_FIELDS)) {
    const positions = sorted.flatMap((block, index) =>
      block.type === type ? [index] : [],
    );
    const blocks = positions
      .map((index) => sorted[index]!)
      .sort((a, b) => String(a[idField]).localeCompare(String(b[idField])));
    positions.forEach((index, rank) => {
      sorted[index] = blocks[rank]!;
    });
  }
  return sorted;
}

/** The non-empty texts the entries behind message `index` put on the
 *  wire through a `renderedBy` rendering, in entry order. */
function contributionTexts(
  conversion: ApiConversion,
  index: number,
  renderedBy: RenderedBy,
): string[] {
  return (conversion.entryUuidsByMessage[index] ?? []).flatMap((uuid) => {
    const contribution = conversion.contributions.get(uuid);
    return contribution?.kind === "text" &&
      contribution.renderedBy === renderedBy
      ? contribution.texts.filter((text) => text !== "")
      : [];
  });
}

/** A place the placement rules write attachment text into: a text
 *  block, a tool_result's string content, or a text part of its array
 *  content (`partIndex`). */
interface TextSlot {
  blockIndex: number;
  partIndex: number | undefined;
  text: string;
}

function textSlots(message: ApiMessage): TextSlot[] {
  const slots: TextSlot[] = [];
  message.content.forEach((block, blockIndex) => {
    const own = textOf(block);
    if (own !== undefined) {
      slots.push({ blockIndex, partIndex: undefined, text: own });
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") {
        slots.push({ blockIndex, partIndex: undefined, text: block.content });
      } else if (Array.isArray(block.content)) {
        block.content.forEach((part: unknown, partIndex) => {
          if (isRecord(part) && typeof part.text === "string") {
            slots.push({ blockIndex, partIndex, text: part.text });
          }
        });
      }
    }
  });
  return slots;
}

function withSlotText(
  message: ApiMessage,
  slot: TextSlot,
  text: string,
): ApiMessage {
  const content = message.content.map((block, blockIndex) => {
    if (blockIndex !== slot.blockIndex) {
      return block;
    }
    if (block.type === "text") {
      return { ...block, text };
    }
    if (slot.partIndex === undefined) {
      return { ...block, content: text };
    }
    const parts = (block.content as unknown[]).map((part, partIndex) =>
      partIndex === slot.partIndex && isRecord(part) ? { ...part, text } : part,
    );
    return { ...block, content: parts };
  });
  return { ...message, content };
}

function slotPath(index: number, slot: TextSlot): string {
  const block = `messages[${index}].content[${slot.blockIndex}]`;
  return slot.partIndex === undefined
    ? block
    : `${block}.content[${slot.partIndex}]`;
}

function occurrences(text: string, part: string): number {
  if (part === "") {
    return 0;
  }
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    count += 1;
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** `text` matched against `literals` with a non-greedy wildcard between
 *  each pair, anchored at both ends — or, with `tail`, followed by
 *  "\n\n" + request-time text or the end. The wildcard contents are the
 *  `spans`; an ambiguous wildcard (its content holds the next literal)
 *  resolves to the earliest match (docs/specs/api-messages.md
 *  Implementation-Time Decisions). */
function matchWildcards(
  text: string,
  literals: string[],
  tail: boolean,
): { spans: string[]; matched: string; rest: string | undefined } | undefined {
  const pattern = literals.map(escapeRegExp).join("([\\s\\S]*?)");
  const match = new RegExp(
    `^(${pattern})${tail ? "(?:\n\n([\\s\\S]*))?" : ""}$`,
    "u",
  ).exec(text);
  if (match === null) {
    return undefined;
  }
  const spans = match.slice(2, 1 + literals.length);
  return { spans, matched: match[1]!, rest: match[1 + literals.length] };
}

/** A contribution text's place in a slot: `part` is the text as placed
 *  (trimmed when folded into a tool_result's string content). */
interface LocatedText {
  slot: TextSlot;
  part: string;
  start: number;
}

/** Where each of `texts` sits in `message`, when each sits in exactly one
 *  place (else that text is left to the strict compare: fail closed).
 *  Candidates are the exact text in any slot and the trimmed text in a
 *  tool_result's string content. */
function locateTexts(message: ApiMessage, texts: string[]): LocatedText[] {
  const slots = textSlots(message);
  const located: LocatedText[] = [];
  for (const text of texts) {
    const candidates: LocatedText[] = [];
    for (const slot of slots) {
      const trimmed = text.trim();
      const forms =
        slot.partIndex === undefined &&
        message.content[slot.blockIndex]!.type === "tool_result" &&
        trimmed !== text
          ? [text, trimmed]
          : [text];
      for (const part of forms) {
        const count = occurrences(slot.text, part);
        if (count > 1) {
          candidates.push({ slot, part, start: -1 }, { slot, part, start: -1 });
        } else if (count === 1) {
          candidates.push({ slot, part, start: slot.text.indexOf(part) });
        }
      }
    }
    if (candidates.length === 1) {
      located.push(candidates[0]!);
    }
  }
  return located;
}

/** The literal segments of `slot.text` around its located texts, in
 *  order; undefined when the texts overlap. */
function literalsAround(
  slot: TextSlot,
  located: LocatedText[],
): string[] | undefined {
  const sorted = [...located].sort((a, b) => a.start - b.start);
  const literals: string[] = [];
  let end = 0;
  for (const { part, start } of sorted) {
    if (start < end) {
      return undefined;
    }
    literals.push(slot.text.slice(end, start));
    end = start + part.length;
  }
  literals.push(slot.text.slice(end));
  return literals;
}

function slotsEqual(a: TextSlot, b: TextSlot): boolean {
  return a.blockIndex === b.blockIndex && a.partIndex === b.partIndex;
}

/** Each `renderedBy` text of the entries behind a synthesized message,
 *  located in that message (provenance: `entryUuidsByMessage`), and the
 *  captured slot at the same position, replaced by `placeholder` — all
 *  of a slot's texts at once, so the literal text between and around
 *  them must agree. */
function textTolerance(
  renderedBy: RenderedBy,
  placeholder: string,
): Tolerance["normalize"] {
  return (captured, synthesized, conversion) => {
    const tolerated: JsonDifference[] = [];
    const rewrittenCaptured = [...captured];
    const rewrittenSynthesized = synthesized.map((message, index) => {
      const located = locateTexts(
        message,
        contributionTexts(conversion, index, renderedBy),
      );
      let rewritten = message;
      for (const slot of textSlots(message)) {
        const own = located.filter((item) => slotsEqual(item.slot, slot));
        const literals =
          own.length === 0 ? undefined : literalsAround(slot, own);
        if (literals === undefined) {
          continue;
        }
        const normalized = literals.join(placeholder);
        const capturedMessage = rewrittenCaptured[index];
        const capturedSlot =
          capturedMessage === undefined
            ? undefined
            : textSlots(capturedMessage).find((candidate) =>
                slotsEqual(candidate, slot),
              );
        if (capturedSlot !== undefined) {
          const match = matchWildcards(capturedSlot.text, literals, false);
          if (match === undefined) {
            continue;
          }
          const parts = [...own].sort((a, b) => a.start - b.start);
          match.spans.forEach((span, spanIndex) => {
            if (span !== parts[spanIndex]!.part) {
              tolerated.push({
                path: slotPath(index, slot),
                captured: { type: "text", text: span },
                synthesized: { type: "text", text: parts[spanIndex]!.part },
              });
            }
          });
          rewrittenCaptured[index] = withSlotText(
            capturedMessage!,
            capturedSlot,
            normalized,
          );
        }
        rewritten = withSlotText(rewritten, slot, normalized);
      }
      return rewritten;
    });
    return {
      captured: rewrittenCaptured,
      synthesized: rewrittenSynthesized,
      tolerated,
    };
  };
}

/** The registry; the key is the tolerance's name in reports. Order
 *  matters: the structural rewrite first, so the text ones see aligned
 *  positions. */
export const TOLERANCES = {
  "empty-system-message": {
    why: "The CLI emits its deferred-tools notice as a role:system message even when it is empty (model-gated mid-conversation system, after the first user message); nothing in the file corresponds to it.",
    removeWhen:
      "the `model-gated mid-conversation system` fixture (tests/sdk/api-context.test.ts) stops showing a system message with empty content.",
    normalize: (captured, synthesized) => {
      const tolerated: JsonDifference[] = [];
      const kept = captured.filter((message, index) => {
        if (message.role === "system" && message.content.length === 0) {
          tolerated.push({
            path: `messages[${index}]`,
            captured: message,
            synthesized: undefined,
          });
          return false;
        }
        return true;
      });
      return { captured: kept, synthesized, tolerated };
    },
  },
  "parallel-order": {
    why: "contextAt orders the tool_use blocks of parallel calls (and their tool_result blocks) by uuid, the CLI by arrival; the file does not record arrival order.",
    removeWhen: "never — the order is not recoverable from the file.",
    normalize: (captured, synthesized) => {
      const tolerated: JsonDifference[] = [];
      const sortSide = (messages: ApiMessage[]) =>
        messages.map((message) => ({
          ...message,
          content: sortToolBlocks(message.content),
        }));
      captured.forEach((message, index) => {
        const other = synthesized[index];
        if (other === undefined) {
          return;
        }
        const capturedKeys = toolBlockKeys(message.content);
        const synthesizedKeys = toolBlockKeys(other.content);
        if (!sameJson(capturedKeys, synthesizedKeys)) {
          tolerated.push({
            path: `messages[${index}].content`,
            captured: capturedKeys,
            synthesized: synthesizedKeys,
          });
        }
      });
      return {
        captured: sortSide(captured),
        synthesized: sortSide(synthesized),
        tolerated,
      };
    },
  },
  "external-state-text": {
    why: "The type carries a snapshot but the CLI re-renders it from request-time state (deferred_tools_delta from the current tool set).",
    removeWhen: "the CLI replays the snapshot for these types.",
    normalize: textTolerance("external-state", "<external-state-text>"),
  },
} as const satisfies Record<string, Tolerance>;

export type ToleranceName = keyof typeof TOLERANCES;

export interface ApiComparison {
  /** Every rewrite a tolerance made, attributed by name. */
  tolerated: (JsonDifference & { tolerance: ToleranceName })[];
  /** Differences no tolerance covers. */
  failing: JsonDifference[];
  /** What the prefix match left over: the CLI's request-time content. */
  requestTime: {
    promptTurnBlocks: ApiContentBlock[];
    systemText: string | undefined;
  };
}

/** The captured system tail split at the request-time boundary: the
 *  synthesized text is matched as a prefix with its external-state texts
 *  as wildcards (`matchWildcards`, tail form). Undefined when the tail
 *  does not match, when a text is not located, or when the boundary is
 *  undecidable (the synthesized text ends in a wildcard). */
function partitionSystemTail(
  tail: string,
  trailingSystem: ApiMessage,
  externalStateTexts: string[],
): { persisted: string; requestTime: string | undefined } | undefined {
  const slot = textSlots(trailingSystem)[0];
  if (slot === undefined || trailingSystem.content.length !== 1) {
    return undefined;
  }
  const located = locateTexts(trailingSystem, externalStateTexts);
  if (located.length !== externalStateTexts.length) {
    return undefined;
  }
  const literals = literalsAround(slot, located);
  if (literals === undefined || literals.at(-1) === "") {
    return undefined;
  }
  const match = matchWildcards(tail, literals, true);
  return match === undefined
    ? undefined
    : { persisted: match.matched, requestTime: match.rest };
}

function blockDifferences(
  path: string,
  captured: ApiContentBlock[],
  synthesized: ApiContentBlock[],
): JsonDifference[] {
  const differences: JsonDifference[] = [];
  const count = Math.max(captured.length, synthesized.length);
  for (let index = 0; index < count; index += 1) {
    if (!sameJson(captured[index], synthesized[index])) {
      differences.push({
        path: `${path}.content[${index}]`,
        captured: captured[index],
        synthesized: synthesized[index],
      });
    }
  }
  return differences;
}

/** Strict positional comparison after normalization. The captured list
 *  is `apiMessages`, then — when the conversion ends with a user message
 *  (before its optional system message) — the prompt turn's leading
 *  blocks as a user message, then the system tail cut at the request-time
 *  boundary (`partitionSystemTail`, before any tolerance sees it); that
 *  trailing user must be a block-prefix of the prompt turn, the remainder
 *  being request-time. A prompt turn the conversion has no user for is
 *  request-time in full. */
export function compareApiMessages(
  capture: CapturedApiMessages,
  conversion: ApiConversion,
): ApiComparison {
  const synthesized0 = conversion.messages;
  // The conversion never produces the empty system messages the CLI
  // adds, so its message for the prompt turn sits that many indices
  // earlier than the prompt turn does in the capture.
  const trailingIndex =
    capture.apiMessages.length -
    capture.apiMessages.filter(
      (message) => message.role === "system" && message.content.length === 0,
    ).length;
  const hasTrailingUser = synthesized0[trailingIndex]?.role === "user";
  const systemIndex = trailingIndex + (hasTrailingUser ? 1 : 0);
  const trailingSystem =
    capture.systemTail === undefined
      ? undefined
      : synthesized0[systemIndex]?.role === "system"
        ? synthesized0[systemIndex]
        : undefined;
  const promptTurn: ApiMessage = {
    role: "user",
    content: capture.promptTurnLeadingBlocks,
  };
  const requestTime: ApiComparison["requestTime"] = {
    promptTurnBlocks: promptTurn.content,
    systemText: capture.systemTail,
  };
  let tailFailure: JsonDifference | undefined;
  let tailMessage: ApiMessage[] = [];
  if (capture.systemTail !== undefined && trailingSystem !== undefined) {
    const partition = partitionSystemTail(
      capture.systemTail,
      trailingSystem,
      contributionTexts(conversion, systemIndex, "external-state"),
    );
    if (partition === undefined) {
      tailFailure = {
        path: `messages[${systemIndex}].content[0]`,
        captured: capture.systemTail,
        synthesized: trailingSystem.content,
      };
    } else {
      requestTime.systemText = partition.requestTime;
      tailMessage = [
        {
          role: "system",
          content: [{ type: "text", text: partition.persisted }],
        },
      ];
    }
  }
  let captured: ApiMessage[] = [
    ...capture.apiMessages,
    ...(hasTrailingUser ? [promptTurn] : []),
    ...tailMessage,
  ];
  let synthesized = synthesized0;
  const tolerated: ApiComparison["tolerated"] = [];
  for (const [name, tolerance] of Object.entries(TOLERANCES) as [
    ToleranceName,
    Tolerance,
  ][]) {
    const normalized = tolerance.normalize(captured, synthesized, conversion);
    captured = normalized.captured;
    synthesized = normalized.synthesized;
    tolerated.push(
      ...normalized.tolerated.map((difference) => ({
        ...difference,
        tolerance: name,
      })),
    );
  }

  const failing: JsonDifference[] = [];
  const strictCount =
    captured.length - (hasTrailingUser ? 1 : 0) - tailMessage.length;
  for (let index = 0; index < strictCount; index += 1) {
    const path = `messages[${index}]`;
    const capturedMessage = captured[index]!;
    const synthesizedMessage = synthesized[index];
    if (synthesizedMessage === undefined) {
      failing.push({ path, captured: capturedMessage, synthesized: undefined });
    } else if (capturedMessage.role !== synthesizedMessage.role) {
      failing.push({
        path: `${path}.role`,
        captured: capturedMessage.role,
        synthesized: synthesizedMessage.role,
      });
    } else {
      failing.push(
        ...blockDifferences(
          path,
          capturedMessage.content,
          synthesizedMessage.content,
        ),
      );
    }
  }
  let index = strictCount;
  if (hasTrailingUser) {
    const trailingUser = synthesized[index]!;
    const leading = captured[index]!.content;
    failing.push(
      ...blockDifferences(
        `messages[${index}]`,
        leading.slice(0, trailingUser.content.length),
        trailingUser.content,
      ),
    );
    requestTime.promptTurnBlocks = leading.slice(trailingUser.content.length);
    index += 1;
  }
  if (tailFailure !== undefined) {
    failing.push(tailFailure);
    index += 1;
  } else if (tailMessage.length > 0) {
    failing.push(
      ...blockDifferences(
        `messages[${index}]`,
        captured[index]!.content,
        synthesized[index]!.content,
      ),
    );
    index += 1;
  }
  for (; index < synthesized.length; index += 1) {
    failing.push({
      path: `messages[${index}]`,
      captured: undefined,
      synthesized: synthesized[index],
    });
  }
  return { tolerated, failing, requestTime };
}
