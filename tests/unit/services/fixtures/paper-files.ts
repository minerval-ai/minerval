/**
 * Bytes for the paper-files tests: image headers of a stated size, and tar
 * archives built entry by entry, so a test can name an entry `../../etc/x`
 * or cut an archive short without a file on disk.
 */
import { gzipSync } from "node:zlib";

export function png(width: number, height: number, totalBytes = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, totalBytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/** A JPEG with an APP0 segment before its start-of-frame, as real ones have. */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...Buffer.alloc(9)]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

export function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

export interface TarEntry {
  name: string;
  data?: Buffer | string;
  /** The typeflag: "0" a file (the default), "2" a symlink, "5" a directory, "L" a GNU long name. */
  type?: string;
  linkname?: string;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(entry.name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(entry.type ?? "0", 156, "latin1");
  if (entry.linkname) h.write(entry.linkname, 157, "utf8");
  h.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : (entry.data ?? Buffer.alloc(0));
    parts.push(tarHeader(entry, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tarGz(entries: TarEntry[]): Buffer {
  return gzipSync(tar(entries));
}
