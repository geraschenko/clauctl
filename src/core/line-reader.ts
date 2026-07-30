/**
 * Incremental splitting of a byte stream into complete non-blank lines,
 * shared by the session-file parser and the `format` input pipeline.
 * Splitting only — parsing and error wording stay with the callers, whose
 * vocabularies deliberately differ (SessionEntryParser's `file:line:
 * malformed session file line` Error vs format input's `invalid JSONL line
 * N` UsageError).
 */

export type Line = Readonly<{ text: string; lineNumber: number }>;

const NEWLINE = "\n".charCodeAt(0);

/** Splits on raw NEWLINE bytes — never decoding first, so a UTF-8 code point
 *  split across chunks stays intact in the buffered suffix — and holds the
 *  unterminated byte suffix until its newline arrives: a mid-append read can
 *  see a partial final line, and once the newline lands the whole record
 *  before it has too. Blank/whitespace-only lines are skipped but still
 *  counted, so line numbers in caller errors match the input. */
export class LineReader {
  private tornSuffix = Buffer.alloc(0);
  private lineNumber = 0;

  /** Complete non-blank lines terminated within this chunk (prefixed by any
   *  retained torn suffix). */
  push(chunk: Buffer): Line[] {
    const data =
      this.tornSuffix.length === 0
        ? chunk
        : Buffer.concat([this.tornSuffix, chunk]);
    const lines: Line[] = [];
    let lineStart = 0;
    while (true) {
      const newlineIndex = data.indexOf(NEWLINE, lineStart);
      if (newlineIndex === -1) {
        break;
      }
      this.lineNumber += 1;
      const text = data.toString("utf8", lineStart, newlineIndex);
      lineStart = newlineIndex + 1;
      if (text.trim() === "") {
        continue;
      }
      lines.push({ text, lineNumber: this.lineNumber });
    }
    // Copied, not a subarray view: a view would pin the (possibly whole-file)
    // parent buffer for the lifetime of the torn suffix.
    this.tornSuffix =
      lineStart === data.length
        ? Buffer.alloc(0)
        : Buffer.from(data.subarray(lineStart));
    return lines;
  }
}
