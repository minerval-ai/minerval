/**
 * The parts of a paper that are not its page text (#912): a figure fetched
 * as an image, and the source archive arXiv holds for a paper (its TeX, its
 * tables, the data files and figure files the authors uploaded).
 *
 * A Researcher asked for values that appear only in a paper's plots could
 * recover the surrounding text and none of the numbers, because read_page
 * reads text. The numbers are usually in one of two places: the figure, read
 * by eye, or the source archive, where a table sits in TeX and a plot's data
 * often sits beside it as a .dat or .csv file.
 *
 * Everything here handles bytes an attacker may have chosen:
 *
 *  - fetches go through the guarded fetcher (url-guard.ts): public hosts
 *    only, every redirect re-validated, time- and size-capped;
 *  - what a file is, is decided from its bytes, never from the server's
 *    Content-Type or the file's name;
 *  - an archive is unpacked in memory and never to disk, with a cap on what
 *    it may inflate to, so neither an entry named `../../etc/x` nor a
 *    decompression bomb has anything to act on. Entries with such names are
 *    left out all the same;
 *  - nothing is parsed beyond headers: an image's dimensions are read from
 *    its first bytes and the image is passed on undecoded.
 *
 * What the files say is data to the agent that reads them, as page text is
 * (prompts/constitution.ts, UNTRUSTED_CONTENT).
 */
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fetchPublicBytes } from "./url-guard.js";
import { looksLikePdf, sanitizeStoredText } from "./document-text.js";
import type { ImageMediaType } from "../llm/tool-output.js";

const gunzipAsync = promisify(gunzip);

const USER_AGENT = "Minerval/1.0 (research agent; mailto:hello@minerval.ai)";

/**
 * The largest image shown to a model. The model APIs refuse an image over
 * 10 MB once base64-encoded, which is 7.5 MB of bytes; a larger one would
 * fail the request that carries it, and with it the run.
 */
export const IMAGE_MAX_BYTES = 7 * 1024 * 1024;
/** The model APIs refuse an image wider or taller than this outright. */
export const IMAGE_MAX_SIDE_PX = 8000;
/**
 * Past twenty images in one conversation the Anthropic API rejects the
 * whole request if any image in it is larger than this on a side (the
 * figure its documentation gives as safe on every platform). The tools keep
 * a run on the allowed side of that rule (figure-tools.ts).
 */
export const IMAGE_LARGE_SIDE_PX = 3000;
export const IMAGES_BEFORE_SIZE_RULE = 20;

/**
 * The most bytes of images and documents one run is shown in all. Every
 * turn resends the whole conversation, attachments included, and the model
 * APIs refuse a request over a size limit (32 MB is the lowest documented
 * for the requests these agents make; base64 adds a third), which would end
 * the run. A token budget does not see bytes: a small-dimensioned image can
 * be a large file.
 */
export const SHOWN_BYTES_MAX_PER_RUN = 20 * 1024 * 1024;

/**
 * The longest PDF shown whole as a document. Each page is read as text and
 * as an image, several thousand tokens together, and a document cannot be
 * shown in part: a long one can overflow the model's context window, which
 * ends the run with nothing reported. That is the failure money does not
 * bound; under this length the run's budget decides.
 */
export const PDF_VIEW_MAX_PAGES = 20;

/**
 * An archive is unpacked in the memory of the process that runs every
 * agent, and nothing meters memory, so its size is capped here and not by
 * a run's budget: at most this much downloaded, and at most this much once
 * inflated.
 */
export const ARCHIVE_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_MAX_UNPACKED_BYTES = 150 * 1024 * 1024;

// --- Images -----------------------------------------------------------------

export interface ImageInfo {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

/**
 * What image the bytes are and how large, read from the header; null when
 * they are not a PNG, JPEG, GIF or WebP whose dimensions can be read.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = sniffPng(b) ?? sniffGif(b) ?? sniffWebp(b) ?? sniffJpeg(b);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  return info;
}

function sniffPng(b: Buffer): ImageInfo | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function sniffGif(b: Buffer): ImageInfo | null {
  if (b.length < 10) return null;
  const sig = b.toString("latin1", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function sniffWebp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    return { mediaType: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    // A lossy key frame: three bytes of frame tag, the start code, then the size.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mediaType: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function sniffJpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  // One pass over the segment headers; each step moves forward by at least two bytes.
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1]!;
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2; // markers with no length
      continue;
    }
    const length = b.readUInt16BE(pos + 2);
    if (length < 2) return null;
    // Start-of-frame markers, C0 to CF, except the three that are tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mediaType: "image/jpeg", height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + length;
  }
  return null;
}

/** About what an image costs to read: one visual token per 28 by 28 pixel patch, capped per model. */
export function imageTokenEstimate(info: { width: number; height: number }, tokenCap: number): number {
  return Math.min(tokenCap, Math.ceil(info.width / 28) * Math.ceil(info.height / 28));
}

/** Why an image cannot be shown at all, or null when it can. */
export function imageProblem(bytes: Uint8Array, info: ImageInfo): string | null {
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return (
      `The image is ${mb(bytes.byteLength)} MB, and the model API takes an image of at most ` +
      `${mb(IMAGE_MAX_BYTES)} MB. Look for a smaller rendering of the same figure (a paper's HTML page ` +
      `usually serves one).`
    );
  }
  if (info.width > IMAGE_MAX_SIDE_PX || info.height > IMAGE_MAX_SIDE_PX) {
    return (
      `The image is ${info.width} by ${info.height} px, and the model API takes none over ` +
      `${IMAGE_MAX_SIDE_PX} px on a side. Look for a smaller rendering of the same figure.`
    );
  }
  return null;
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// --- A file fetched to be looked at ------------------------------------------

export type Viewable =
  | { ok: true; kind: "image"; url: string; bytes: Buffer; info: ImageInfo }
  | { ok: true; kind: "pdf"; url: string; bytes: Buffer; pages: number }
  | { ok: false; problem: string };

/** How many pages a PDF has, by opening it with pdf.js. Throws when it will not open. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  try {
    return doc.numPages;
  } finally {
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}

/** What a body is when it is neither an image nor a PDF, for the message that says so. */
function describeBytes(bytes: Uint8Array, contentType: string | null): string {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 512)).toString("latin1");
  if (isGzip(bytes)) return "a gzip archive";
  if (/^%!PS/.test(head)) return "PostScript (EPS), which no model here can be shown";
  if (/<svg[\s>]/i.test(head)) return "an SVG, which is text: read_page reads its source";
  if (/<(!doctype html|html|head|body)[\s>]/i.test(head)) return "an HTML page, not an image: read_page reads it, and its figures have their own URLs";
  return `not a PNG, JPEG, GIF, WebP or PDF (the server called it ${contentType ?? "nothing"})`;
}

/** Classify bytes as something a model can be shown, by their content. */
export async function classifyViewable(bytes: Buffer, url: string, contentType: string | null): Promise<Viewable> {
  const info = sniffImage(bytes);
  if (info) {
    const problem = imageProblem(bytes, info);
    return problem ? { ok: false, problem } : { ok: true, kind: "image", url, bytes, info };
  }
  // By magic number only: a server calling an HTML error page application/pdf is not a PDF.
  if (looksLikePdf(bytes, null)) {
    try {
      return { ok: true, kind: "pdf", url, bytes, pages: await pdfPageCount(bytes) };
    } catch (err) {
      return { ok: false, problem: `The PDF at ${url} could not be opened: ${message(err)}` };
    }
  }
  return { ok: false, problem: `What ${url} serves is ${describeBytes(bytes, contentType)}.` };
}

/** Fetch a public URL to be looked at: an image, or a PDF. Errors as a message. */
export async function fetchViewable(url: string): Promise<Viewable> {
  try {
    const body = await fetchPublicBytes(url, { userAgent: USER_AGENT });
    return await classifyViewable(body.bytes, body.url, body.contentType);
  } catch (err) {
    return { ok: false, problem: message(err) };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- arXiv source archives ---------------------------------------------------

/**
 * The arXiv identifier in what an agent passed: a bare id (`2401.01234`,
 * `2401.01234v2`, `hep-th/9901001`), with or without `arXiv:`, or an
 * arxiv.org URL of the paper (abs, pdf, html, e-print, src). Null otherwise.
 */
export function parseArxivId(raw: string): string | null {
  let s = raw.trim();
  const url = s.match(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html|e-print|src|format)\/([^?#]+)/i);
  if (url) s = url[1]!.replace(/\.pdf$/i, "").replace(/\/+$/, "");
  s = s.replace(/^arxiv:/i, "");
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return s;
  if (/^[a-z][a-z-]*(\.[A-Za-z]{2})?\/\d{7}(v\d+)?$/.test(s)) return s;
  return null;
}

export function arxivEprintUrl(id: string): string {
  return `https://arxiv.org/e-print/${id}`;
}

export type ArchiveFileKind = "text" | "image" | "pdf" | "binary";

export interface ArchiveFile {
  name: string;
  bytes: Buffer;
  kind: ArchiveFileKind;
}

export interface SourceArchive {
  files: ArchiveFile[];
  /** Entries left out for an unsafe name (absolute, or climbing out with `..`). */
  skipped: number;
  /** True when the tar ended mid-entry; the files before the break are kept. */
  truncated: boolean;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/** Whether a decoded sample reads as text: no NUL, and few other control bytes. */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.length === 0) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) control++;
  }
  return control / sample.length < 0.02;
}

export function classifyArchiveFile(bytes: Buffer): ArchiveFileKind {
  if (sniffImage(bytes)) return "image";
  if (looksLikePdf(bytes, null)) return "pdf";
  return looksLikeText(bytes) ? "text" : "binary";
}

/**
 * A name as a key into the archive: forward slashes, no leading `./`. Null
 * for a name that is absolute, climbs out with `..`, or is empty. Nothing is
 * ever written under these names; they are refused so that no later caller
 * can be handed one.
 */
export function safeArchiveName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "")) return null;
  return parts.filter((p) => p !== ".").join("/") || null;
}

const TAR_BLOCK = 512;

function tarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString("utf8");
}

/** A tar header's size field: octal digits. Null for anything else (the base-256 form included). */
function tarSize(block: Buffer): number | null {
  const field = tarString(block, 124, 12).trim();
  if (!/^[0-7]*$/.test(field)) return null;
  return field === "" ? 0 : parseInt(field, 8);
}

/** Whether a block's stored checksum matches its bytes: what tells a tar from other data. */
function tarChecksumOk(block: Buffer): boolean {
  const stored = parseInt(tarString(block, 148, 8).trim() || "x", 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === stored;
}

export function looksLikeTar(data: Buffer): boolean {
  return data.length >= TAR_BLOCK && tarChecksumOk(data.subarray(0, TAR_BLOCK));
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Buffer): string | null {
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const length = parseInt(data.toString("latin1", pos, space), 10);
    if (!Number.isFinite(length) || length <= 0 || pos + length > data.length) break;
    const record = data.toString("utf8", space + 1, pos + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    pos += length;
  }
  return null;
}

/**
 * The regular files of a tar held in memory. Each file's bytes are a view
 * into `data`, not a copy, so the archive costs its inflated size once.
 * Links, devices and directories are passed over: nothing here follows a
 * link or creates anything.
 */
export function readTar(data: Buffer): SourceArchive {
  const files: ArchiveFile[] = [];
  let skipped = 0;
  let truncated = false;
  let longName: string | null = null;
  let pos = 0;
  while (pos + TAR_BLOCK <= data.length) {
    const header = data.subarray(pos, pos + TAR_BLOCK);
    // Two zero blocks end an archive; one is enough to stop on.
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(header);
    if (size === null || !tarChecksumOk(header)) {
      truncated = true;
      break;
    }
    const start = pos + TAR_BLOCK;
    if (start + size > data.length) {
      truncated = true;
      break;
    }
    const body = data.subarray(start, start + size);
    const type = String.fromCharCode(header[156] ?? 0);
    pos = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === "L") {
      // GNU long name: this entry's data names the next entry.
      longName = tarString(body, 0, body.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(body) ?? longName;
      continue;
    }
    if (type === "g") continue;

    const prefix = tarString(header, 257, 5) === "ustar" ? tarString(header, 345, 155) : "";
    const rawName = longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    longName = null;
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const name = safeArchiveName(rawName);
    if (!name) {
      skipped++;
      continue;
    }
    files.push({ name, bytes: body, kind: classifyArchiveFile(body) });
  }
  return { files, skipped, truncated };
}

/** The original file name a gzip header carries, if it carries one. */
function gzipFileName(bytes: Buffer): string | null {
  if (bytes.length < 10 || (bytes[3]! & 0x08) === 0) return null;
  let pos = 10;
  if (bytes[3]! & 0x04) {
    if (pos + 2 > bytes.length) return null;
    pos += 2 + bytes.readUInt16LE(pos);
  }
  const end = bytes.indexOf(0, pos);
  if (end < 0 || end - pos > 255) return null;
  return bytes.toString("latin1", pos, end);
}

/**
 * Unpack what arXiv serves at /e-print/<id>: a gzipped tar of the
 * submission's files, or, for a paper submitted as one file, that file
 * gzipped alone. Inflation stops at `maxUnpackedBytes`: a body that would
 * exceed it is refused, never partly inflated. Throws ArchiveError with a
 * message fit to show the agent.
 */
export async function unpackEprint(
  bytes: Buffer,
  opts: { id?: string; maxUnpackedBytes?: number } = {}
): Promise<SourceArchive> {
  const cap = opts.maxUnpackedBytes ?? ARCHIVE_MAX_UNPACKED_BYTES;
  if (!isGzip(bytes)) {
    if (looksLikePdf(bytes, null)) {
      throw new ArchiveError(
        "arXiv holds no source for this paper, only its PDF (the authors submitted a PDF). " +
          "read_page reads the PDF's text."
      );
    }
    throw new ArchiveError("What arXiv served is not a gzip archive, so there is no source to unpack.");
  }
  let data: Buffer;
  try {
    data = await gunzipAsync(bytes, { maxOutputLength: cap });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      throw new ArchiveError(
        `The archive inflates to more than ${mb(cap)} MB and was not unpacked: it is unpacked in the ` +
          `memory of the server every agent runs on.`
      );
    }
    throw new ArchiveError(`The archive is damaged and could not be unpacked (${message(err)}).`);
  }
  if (looksLikeTar(data)) return readTar(data);
  // One file, gzipped alone: a single TeX file, as a rule.
  const named = safeArchiveName(gzipFileName(bytes) ?? "");
  const kind = classifyArchiveFile(data);
  const stem = opts.id ? opts.id.replace(/\//g, "_") : "source";
  const extension = kind === "pdf" ? ".pdf" : kind === "text" ? ".tex" : "";
  return {
    files: [{ name: named ?? `${stem}${extension}`, bytes: data, kind }],
    skipped: 0,
    truncated: false,
  };
}

/**
 * Archives fetched lately, so that listing a paper's files and then reading
 * three of them is one download from arXiv and not four. Bounded by bytes
 * and by age; an entry is the inflated archive, held once.
 */
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;
const cache = new Map<string, { archive: SourceArchive; bytes: number; at: number }>();

function cacheGet(id: string, now: number): SourceArchive | null {
  const hit = cache.get(id);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(id);
    return null;
  }
  return hit.archive;
}

function cachePut(id: string, archive: SourceArchive, now: number): void {
  const bytes = archive.files.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (bytes > CACHE_MAX_BYTES) return;
  cache.set(id, { archive, bytes, at: now });
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  // Oldest first: a Map iterates in insertion order.
  for (const [key, entry] of cache) {
    if (total <= CACHE_MAX_BYTES) break;
    if (key === id) continue;
    cache.delete(key);
    total -= entry.bytes;
  }
}

/** For tests. */
export function clearSourceArchiveCache(): void {
  cache.clear();
}

export type ArxivSource =
  | { ok: true; id: string; archive: SourceArchive }
  | { ok: false; problem: string };

/** The source archive of an arXiv paper, fetched under the guard and unpacked in memory. */
export async function fetchArxivSource(rawId: string, now: () => number = Date.now): Promise<ArxivSource> {
  const id = parseArxivId(rawId);
  if (!id) {
    return {
      ok: false,
      problem:
        `"${rawId}" is not an arXiv identifier. Pass the id (2401.01234, 2401.01234v2, hep-th/9901001) ` +
        `or the paper's arxiv.org URL.`,
    };
  }
  const cached = cacheGet(id, now());
  if (cached) return { ok: true, id, archive: cached };
  try {
    const body = await fetchPublicBytes(arxivEprintUrl(id), {
      userAgent: USER_AGENT,
      maxBytes: ARCHIVE_MAX_DOWNLOAD_BYTES,
    });
    const archive = await unpackEprint(body.bytes, { id });
    cachePut(id, archive, now());
    return { ok: true, id, archive };
  } catch (err) {
    if (err instanceof ArchiveError) return { ok: false, problem: err.message };
    const text = message(err);
    if (/exceeds \d+ bytes/.test(text)) {
      return {
        ok: false,
        problem:
          `The source archive of ${id} is over ${mb(ARCHIVE_MAX_DOWNLOAD_BYTES)} MB and was not fetched: ` +
          `archives are unpacked in the memory of the server every agent runs on.`,
      };
    }
    return { ok: false, problem: text };
  }
}

/** A file's text as an agent reads it: UTF-8, scrubbed of control characters. */
export function archiveFileText(file: ArchiveFile): string {
  return sanitizeStoredText(file.bytes.toString("utf8"));
}
