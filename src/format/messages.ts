/**
 * Incremental renderer for canonical message records (`format messages` and
 * the default tail/prompt streams). Individual pieces (tool-call lines,
 * result summaries) render via the shared sdk-message.ts; this file owns the
 * stream driver: speaker headers, blank-line separation, coalescing of
 * thinking/read-only/bash activity, control-record rendering, and the
 * trailing cursor line. Lenient — unknown message types degrade to the
 * generic annotation rather than being rejected. The events path
 * (`format events`, `--type events`) deliberately does not share this
 * driver; it renders event-per-record through EventFormatter.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageControl,
  MessageRecord,
} from "../core/session/messages.ts";
import { DEFAULT_FORMAT_WIDTH } from "../core/generated/constants.ts";
import { isRecord } from "../core/generated/util.ts";
import type { RenderAssistant } from "../tui/render-types.ts";
import { renderAssistant, toolResultsOf, userText } from "../tui/sdk-render.ts";
import { countLines, oneLine, truncateText } from "./generated/text.ts";
import {
  annotation,
  assistantBody,
  formatResult,
  formatToolArguments,
  formatToolResult,
  genericAnnotation,
  newFormatState,
  PREFERRED_ARG_KEYS,
  type FormatState,
} from "./sdk-message.ts";
import type { MessageFormatOptions } from "./types.ts";

/** The defaults `format messages`/`format events` apply for omitted flags,
 *  and everything tail renders with — shared so tail's formatted output is
 *  byte-equal to its `--json` output piped through `format`. */
export const DEFAULT_MESSAGE_FORMAT_OPTIONS: MessageFormatOptions = {
  toolResults: "summary",
  maxToolArgChars: DEFAULT_FORMAT_WIDTH,
  maxErrorLines: 10,
};

/** Claude Code's built-in tools without side effects, eligible for
 *  coalescing. Skill/Agent and MCP tools (`mcp__*`) stay visible: their
 *  activity is meaningful (or their effects unknowable). Update on drift of
 *  the CLI's tool set. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "ListMcpResources",
  "ReadMcpResource",
]);

const BASH_TOOL = "Bash";

function renderControl(control: MessageControl): string {
  switch (control.kind) {
    case "model_changed":
      return `[model: ${control.from} -> ${control.to}]`;
    case "permission_mode_changed":
      return `[permission-mode: ${control.from} -> ${control.to}]`;
    case "compaction": {
      const parts = [
        ...(control.trigger === undefined ? [] : [control.trigger]),
        ...(control.preTokens === undefined
          ? []
          : [`${control.preTokens} preTokens`]),
      ];
      return parts.length === 0
        ? "[compaction]"
        : `[compaction: ${parts.join(", ")}]`;
    }
    case "queued_input":
      return annotation(`queued: ${control.text}`);
  }
}

/** A speaker header plus body; header-less blocks (controls, results
 *  one-liner, cursor) are role-neutral and never affect header
 *  suppression. */
interface RenderedBlock {
  readonly header: string | undefined;
  readonly body: string;
}

/** The messages-path blocks of one SDK message. Tool results are user-role
 *  in the protocol but assistant-side activity conceptually: they count as
 *  `== assistant ==`, so a result directly after a real user message
 *  reasserts the assistant header. */
function renderMessageBlocks(
  message: SDKMessage,
  formatState: FormatState,
  options: MessageFormatOptions,
): RenderedBlock[] {
  switch (message.type) {
    case "user": {
      if ("isReplay" in message && message.isReplay) {
        return [];
      }
      const results = toolResultsOf(message);
      const text = userText(message);
      if (results.length === 0) {
        return [{ header: "== user ==", body: text }];
      }
      const blocks: RenderedBlock[] = [];
      if (text !== "") {
        blocks.push({ header: "== user ==", body: text });
      }
      for (const result of results) {
        const body = formatToolResult(result, formatState, options);
        if (body !== undefined) {
          blocks.push({ header: "== assistant ==", body });
        }
      }
      return blocks;
    }
    case "assistant":
      return [
        {
          header: "== assistant ==",
          body: assistantBody(renderAssistant(message), formatState, options),
        },
      ];
    case "result":
      return [{ header: undefined, body: formatResult(message) }];
    case "stream_event":
    case "rate_limit_event":
      return [];
    case "system":
      if (message.subtype === "init") {
        return [];
      }
      return [{ header: undefined, body: genericAnnotation(message) }];
    default:
      return [{ header: undefined, body: genericAnnotation(message) }];
  }
}

/** Consecutive read-only calls between bash calls, merged into per-tool
 *  clauses. */
interface CoalescedToolClauses {
  readonly kind: "tools";
  /** Tool name → rendered args in call order; insertion order is first
   *  appearance. */
  readonly toolArgs: Map<string, string[]>;
}

/** One Bash call rendered on its own line (commands may contain the `;`/`,`
 *  clause separators, so they never merge into a clause list). */
interface CoalescedBashLine {
  readonly kind: "bash";
  readonly command: string;
  /** `"3L, 45B"` once the call's successful result is absorbed; undefined
   *  until then, or when `toolResults: "none"` asked to hide results. */
  resultSummary: string | undefined;
}

/** A run of coalesced thinking/read-only/Bash activity, held back until a
 *  breaker or `end()` closes it (an open run is deliberately silent — any
 *  visible activity is itself a breaker). */
interface CoalescedRun {
  /** Read-only clause segments and Bash lines in call order; a Bash call
   *  closes the open clause segment so rendering preserves operation order. */
  readonly items: (CoalescedToolClauses | CoalescedBashLine)[];
  /** Read-only call ids whose successful results are absorbed silently
   *  (their summaries are the noise being removed). */
  readonly readCallIds: Set<string>;
  /** Bash call id → rendered line awaiting its result summary. */
  readonly bashLines: Map<string, CoalescedBashLine>;
  hadThinking: boolean;
  thoughtMs: number;
  thoughtComputable: boolean;
}

/** Thinking, read-only tool calls, and Bash (whose commands stay visible in
 *  the run rendering); nothing else visible — no non-blank text and no
 *  error. A message contributing neither thinking nor a call renders
 *  normally instead of opening an empty run. */
function isCoalescableAssistant(rendered: RenderAssistant): boolean {
  if (rendered.stopReason === "error" || rendered.errorMessage !== undefined) {
    return false;
  }
  let contributes = false;
  for (const block of rendered.content) {
    if (block.type === "thinking") {
      contributes = true;
    } else if (block.type === "text") {
      if (block.text.trim() !== "") {
        return false;
      }
    } else if (READ_ONLY_TOOLS.has(block.name) || block.name === BASH_TOOL) {
      contributes = true;
    } else {
      return false;
    }
  }
  return contributes;
}

/** The bare value of the first preferred key; calls without one fall back to
 *  the JSON argument summary. */
function coalescedCallArg(args: unknown, maxChars: number): string {
  if (isRecord(args)) {
    for (const key of PREFERRED_ARG_KEYS) {
      if (args[key] !== undefined) {
        return truncateText(oneLine(String(args[key])), maxChars);
      }
    }
  }
  return formatToolArguments(args, maxChars);
}

function toolClauses(segment: CoalescedToolClauses): string[] {
  return [...segment.toolArgs].map(([name, args]) => {
    const shown = args.filter((arg) => arg !== "");
    return shown.length === 0 ? name : `${name} ${shown.join(", ")}`;
  });
}

/** Width driving right-edge alignment: command plus summary code points (the
 *  `[Bash `, ` → `, `]` parts are constant per line). */
function bashLineWidth(line: CoalescedBashLine): number {
  return [...line.command].length + [...(line.resultSummary ?? "")].length;
}

/** `[thought for 4.3s; Read a, b; Grep TODO]` — one summed thought clause
 *  first (durations that would round to 0.0s render in milliseconds; bare
 *  `thought` when no duration was computable), then one clause per tool name
 *  in first-appearance order — followed by one `[Bash cmd → 3L, 45B]` line
 *  per Bash call, padded so result summaries share a right edge within the
 *  run. Later read-only segments render as further clause lines, preserving
 *  operation order around Bash calls. */
function renderRunLines(run: CoalescedRun): string {
  const leadingClauses: string[] = [];
  if (run.hadThinking) {
    const seconds = (run.thoughtMs / 1000).toFixed(1);
    leadingClauses.push(
      !run.thoughtComputable
        ? "thought"
        : seconds === "0.0"
          ? `thought for ${run.thoughtMs}ms`
          : `thought for ${seconds}s`,
    );
  }
  const items = [...run.items];
  if (items[0]?.kind === "tools") {
    leadingClauses.push(...toolClauses(items[0]));
    items.shift();
  }
  const lines: string[] = [];
  if (leadingClauses.length > 0) {
    lines.push(`[${leadingClauses.join("; ")}]`);
  }
  const rightEdge = Math.max(
    ...run.items
      .filter(
        (item): item is CoalescedBashLine =>
          item.kind === "bash" && item.resultSummary !== undefined,
      )
      .map(bashLineWidth),
    0,
  );
  for (const item of items) {
    if (item.kind === "tools") {
      lines.push(`[${toolClauses(item).join("; ")}]`);
    } else if (item.resultSummary === undefined) {
      lines.push(`[${BASH_TOOL} ${item.command}]`);
    } else {
      const padding = " ".repeat(rightEdge - bashLineWidth(item));
      lines.push(
        `[${BASH_TOOL} ${item.command}${padding} → ${item.resultSummary}]`,
      );
    }
  }
  return lines.join("\n");
}

/** Bracketed lines (`[...]`) are self-delimiting; any other non-blank line
 *  is raw text whose boundary with a following same-speaker block would be
 *  ambiguous without a header. */
function hasRawTextLine(body: string): boolean {
  return body
    .split("\n")
    .some(
      (line) =>
        line.trim() !== "" && !(line.startsWith("[") && line.endsWith("]")),
    );
}

/**
 * Incremental renderer for canonical message records. The concatenation of
 * every push() and the final end() return value is the stream's formatted
 * output: chunks separated by blank lines, exactly one trailing newline,
 * cursor line last — byte-equal to formatting the same finite record
 * sequence whole.
 *
 * Runs of thinking, read-only tool calls, and Bash calls coalesce into one
 * compact block unless `toolResults` is "full" (full detail was asked for).
 * `push()` returns "" for records joining the run; the breaker's `push()` —
 * or `end()` at EOF — emits the completed block first, then the breaker's
 * own block.
 *
 * Speaker headers (`== user ==`, `== assistant ==`) are emitted only when
 * the speaker changes; tool results and coalesced runs count as assistant
 * output. A block containing raw (unbracketed) text forces the next headered
 * block to re-emit its header so the raw text's end stays unambiguous.
 */
export class MessageFormatter {
  private readonly options: MessageFormatOptions;
  private readonly formatState = newFormatState();
  private emitted = false;
  private lastUuid: string | undefined;
  private run: CoalescedRun | undefined;
  /** Header of the last speaker-attributed block; a matching next block
   *  omits its header unless raw text forced re-emission. */
  private lastHeader: string | undefined;
  /** Set when a block rendered raw (unbracketed) text; see class docs. */
  private forceNextHeader = false;
  /** Epoch ms of the last timestamped record; a thinking message's duration
   *  is its timestamp minus this (the session-file delta rule). */
  private previousTimestampMs: number | undefined;

  constructor(options: MessageFormatOptions) {
    this.options = options;
  }

  /** The record's formatted chunk (with any separator), "" when it renders
   *  to nothing or joined the open coalescing run. Tracks the last uuid
   *  consumed regardless of rendering. */
  push(record: MessageRecord): string {
    if (typeof record.uuid === "string") {
      this.lastUuid = record.uuid;
    }
    if (this.options.toolResults !== "full" && this.absorbIntoRun(record)) {
      return "";
    }
    let output = this.flushRun();
    this.trackTimestamp(record);
    const blocks =
      record.type === "control"
        ? [{ header: undefined, body: renderControl(record.control) }]
        : renderMessageBlocks(
            record as SDKMessage,
            this.formatState,
            this.options,
          );
    for (const block of blocks) {
      output += this.block(block.header, block.body);
    }
    return output;
  }

  /** Flush: any open coalesced run, the cursor line when any uuid-bearing
   *  record was consumed, and final-newline bookkeeping; "" for a stream
   *  that rendered nothing and carried no uuids. */
  end(): string {
    let output = this.flushRun();
    if (this.lastUuid !== undefined) {
      // The cursor keeps the full uuid (unlike displayUuid sites): it exists
      // for lossless copy-paste, and the full value is the fallback when a
      // truncated prefix collides.
      output += this.block(undefined, `[cursor: ${this.lastUuid}]`);
    }
    return `${output}${this.emitted ? "\n" : ""}`;
  }

  private block(header: string | undefined, body: string): string {
    const emitHeader =
      header !== undefined &&
      (this.forceNextHeader || header !== this.lastHeader);
    if (header !== undefined) {
      this.lastHeader = header;
      this.forceNextHeader = false;
    }
    if (hasRawTextLine(body)) {
      this.forceNextHeader = true;
    }
    const chunk = emitHeader ? `${header}\n${body}` : body;
    if (chunk === "") {
      return "";
    }
    const separator = this.emitted ? "\n\n" : "";
    this.emitted = true;
    return `${separator}${chunk}`;
  }

  private flushRun(): string {
    if (this.run === undefined) {
      return "";
    }
    const lines = renderRunLines(this.run);
    this.run = undefined;
    return this.block("== assistant ==", lines);
  }

  private absorbIntoRun(record: MessageRecord): boolean {
    if (record.type === "assistant") {
      const rendered = renderAssistant(record as SDKAssistantMessage);
      if (!isCoalescableAssistant(rendered)) {
        return false;
      }
      const run: CoalescedRun = (this.run ??= {
        items: [],
        readCallIds: new Set(),
        bashLines: new Map(),
        hadThinking: false,
        thoughtMs: 0,
        thoughtComputable: false,
      });
      if (rendered.content.some((block) => block.type === "thinking")) {
        run.hadThinking = true;
        const timestampMs = recordTimestampMs(record);
        if (
          timestampMs !== undefined &&
          this.previousTimestampMs !== undefined &&
          timestampMs >= this.previousTimestampMs
        ) {
          run.thoughtMs += timestampMs - this.previousTimestampMs;
          run.thoughtComputable = true;
        }
      }
      for (const block of rendered.content) {
        if (block.type !== "toolCall") {
          continue;
        }
        this.formatState.toolNames.set(block.id, block.name);
        const arg = coalescedCallArg(
          block.arguments,
          this.options.maxToolArgChars,
        );
        if (block.name === BASH_TOOL) {
          const line: CoalescedBashLine = {
            kind: "bash",
            command: arg,
            resultSummary: undefined,
          };
          run.items.push(line);
          run.bashLines.set(block.id, line);
        } else {
          const last = run.items.at(-1);
          const segment: CoalescedToolClauses =
            last?.kind === "tools"
              ? last
              : { kind: "tools", toolArgs: new Map() };
          if (segment !== last) {
            run.items.push(segment);
          }
          const args = segment.toolArgs.get(block.name) ?? [];
          args.push(arg);
          segment.toolArgs.set(block.name, args);
          run.readCallIds.add(block.id);
        }
      }
      this.trackTimestamp(record);
      return true;
    }
    if (record.type === "user" && this.run !== undefined) {
      const run = this.run;
      const message = record as SDKUserMessage;
      if (
        ("isReplay" in message && message.isReplay) ||
        userText(message) !== ""
      ) {
        return false;
      }
      const results = toolResultsOf(message);
      if (
        results.length === 0 ||
        !results.every(
          (result) =>
            !result.isError &&
            (run.readCallIds.has(result.toolCallId) ||
              run.bashLines.has(result.toolCallId)),
        )
      ) {
        return false;
      }
      for (const result of results) {
        const line = run.bashLines.get(result.toolCallId);
        if (line !== undefined && this.options.toolResults === "summary") {
          line.resultSummary = `${countLines(result.content)}L, ${Buffer.byteLength(result.content, "utf8")}B`;
        }
      }
      this.trackTimestamp(record);
      return true;
    }
    return false;
  }

  private trackTimestamp(record: MessageRecord): void {
    const timestampMs = recordTimestampMs(record);
    if (timestampMs !== undefined) {
      this.previousTimestampMs = timestampMs;
    }
  }
}

/** The record's entry timestamp as epoch ms; undefined when absent or
 *  unparseable (live-captured records may carry none). */
function recordTimestampMs(record: MessageRecord): number | undefined {
  if (typeof record.timestamp !== "string") {
    return undefined;
  }
  const parsed = Date.parse(record.timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}
