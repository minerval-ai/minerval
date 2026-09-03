/**
 * Output caps of design section 5.3: 64 KB of process output and 200
 * diagnostics per check, with a `truncated` flag wherever a cap bit.
 */

export const OUTPUT_CAP_BYTES = 64 * 1024;
export const DIAGNOSTICS_CAP = 200;

/** Cap a string at `maxBytes` of UTF-8 without splitting a code point. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back up over UTF-8 continuation bytes (10xxxxxx) so the cut lands on a
  // code point boundary.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function capList<T>(items: T[], max: number): { items: T[]; truncated: boolean } {
  if (items.length <= max) return { items, truncated: false };
  return { items: items.slice(0, max), truncated: true };
}

/**
 * Accumulates a child process's output up to a byte cap. Chunks past the
 * cap are counted, not kept, so the child never blocks on a full pipe and
 * the flag records that output was lost.
 */
export class OutputCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;
  public droppedBytes = 0;

  constructor(private readonly capBytes: number) {}

  append(chunk: Buffer): void {
    if (this.bytes >= this.capBytes) {
      this.truncated = true;
      this.droppedBytes += chunk.length;
      return;
    }
    const room = this.capBytes - this.bytes;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.bytes += room;
      this.droppedBytes += chunk.length - room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
    }
  }

  text(): string {
    return capText(Buffer.concat(this.chunks).toString("utf8"), this.capBytes).text;
  }
}
