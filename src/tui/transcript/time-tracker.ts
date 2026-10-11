import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The previous top-level entry's time, for thinking durations. Claude's
 * session-file rule (validated empirically): a thinking message's duration
 * is its timestamp minus the previous entry's timestamp; live messages
 * carry no timestamp, so arrival time — the same clock the CLI stamps
 * entries with — stands in.
 */
export class TimeTracker {
  private lastEntryAtMs: number | undefined;

  /** Seconds from the previous entry to `message`; undefined with no
   *  previous entry or when time ran backwards. */
  secondsSincePrevious(message: SDKMessage): number | undefined {
    const at = messageTimestampMs(message) ?? Date.now();
    if (this.lastEntryAtMs === undefined || at < this.lastEntryAtMs) {
      return undefined;
    }
    return (at - this.lastEntryAtMs) / 1000;
  }

  /** Monotonic: a message's second arrival (its entry after its frame, or
   *  the reverse) must not move the baseline back behind a later entry.
   *  Only assistant messages carry a timestamp; the rest stamp arrival
   *  time, so a delta across a rebuild measures the replay, not the
   *  session. */
  stamp(message: SDKMessage): void {
    const at = messageTimestampMs(message) ?? Date.now();
    this.lastEntryAtMs = Math.max(this.lastEntryAtMs ?? at, at);
  }
}

function messageTimestampMs(message: SDKMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== "string") {
    return undefined;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}
