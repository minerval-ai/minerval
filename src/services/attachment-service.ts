/**
 * Attachments (docs/mathematics.md §8.4, "Storage"): the Lean source, the
 * documents and data a prize claim carries, and a winner's tax form.
 *
 * Bodies live in Postgres (`attachments.body`, bytea) behind a `storage`
 * discriminator so an object store is a code change, not a migration.
 * Content type is decided by magic bytes against an allowlist, never from
 * the client's header; filenames are sanitized; the Lean file must be valid
 * UTF-8 with no NUL bytes; zips are inspected and nested archives refused;
 * nothing is executed or parsed except the Lean file inside the checker's
 * sandbox. Downloads are served with Content-Disposition: attachment,
 * nosniff, and a sandboxing CSP. Bodies are `restricted` at submission; a
 * Lean source becomes `public` when the Steward accepts the claim, and a
 * rejected source stays restricted until the bounty closes. A `tax_form` is
 * always restricted to its owner and the operator.
 */
import { createHash } from "node:crypto";
import { rawQuery } from "../db/client.js";
import { asRunner, type Runner } from "./prize-pool-service.js";

export type AttachmentKind = "lean_source" | "document" | "dataset" | "code" | "tax_form";
export type AttachmentVisibility = "restricted" | "public";

/** The allowlist (§8.4): `.lean` as text, PDF, Markdown, text, CSV, JSON, zip. */
export const ALLOWED_CONTENT_TYPES = {
  lean: "text/x-lean",
  pdf: "application/pdf",
  markdown: "text/markdown",
  text: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
} as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[keyof typeof ALLOWED_CONTENT_TYPES];

export const LEAN_MAX_BYTES = 256 * 1024;
export const LEAN_MAX_LINES = 20_000;
export const DOCUMENT_MAX_FILES = 5;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024;

const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz", ".xz", ".txz", ".7z", ".rar", ".jar", ".war"];

export interface DetectedType {
  contentType: AllowedContentType;
  kind: AttachmentKind;
}

export function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function hasNul(buf: Buffer): boolean {
  return buf.includes(0);
}

function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

/**
 * Determine the content type from the bytes. Binary formats by magic
 * number; text formats must be valid UTF-8 without NUL bytes, classified by
 * a structural check (JSON parses) or the extension the caller named for
 * the text-only families. Returns null for anything outside the allowlist.
 */
export function detectContentType(
  body: Buffer,
  filename: string,
  intended: "lean_source" | "document" | "tax_form" = "document"
): DetectedType | null {
  const ext = extensionOf(filename);
  if (body.length >= 5 && body.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { contentType: ALLOWED_CONTENT_TYPES.pdf, kind: intended === "tax_form" ? "tax_form" : "document" };
  }
  if (
    body.length >= 4 &&
    body[0] === 0x50 &&
    body[1] === 0x4b &&
    ((body[2] === 0x03 && body[3] === 0x04) || (body[2] === 0x05 && body[3] === 0x06))
  ) {
    return intended === "tax_form"
      ? null
      : { contentType: ALLOWED_CONTENT_TYPES.zip, kind: ext === ".zip" && /code|src/i.test(filename) ? "code" : "dataset" };
  }
  if (!isValidUtf8(body) || hasNul(body)) return null;
  if (intended === "lean_source") {
    return ext === ".lean" || ext === "" ? { contentType: ALLOWED_CONTENT_TYPES.lean, kind: "lean_source" } : null;
  }
  if (intended === "tax_form") {
    // A tax form is a PDF or an image-free text scan; text is allowed only
    // as plain text so a script never rides in as a form.
    return ext === ".txt" ? { contentType: ALLOWED_CONTENT_TYPES.text, kind: "tax_form" } : null;
  }
  const text = body.toString("utf8").trimStart();
  if (ext === ".json" || text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(body.toString("utf8"));
      return { contentType: ALLOWED_CONTENT_TYPES.json, kind: "dataset" };
    } catch {
      if (ext === ".json") return null;
    }
  }
  if (ext === ".lean") return { contentType: ALLOWED_CONTENT_TYPES.lean, kind: "code" };
  if (ext === ".csv") return { contentType: ALLOWED_CONTENT_TYPES.csv, kind: "dataset" };
  if (ext === ".md" || ext === ".markdown") return { contentType: ALLOWED_CONTENT_TYPES.markdown, kind: "document" };
  if (ext === ".txt" || ext === "") return { contentType: ALLOWED_CONTENT_TYPES.text, kind: "document" };
  return null;
}

/** Keep a safe basename: printable ASCII, no path separators, bounded length. */
export function sanitizeFilename(name: string, fallback = "attachment"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\;<>]/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Walk a zip's central directory and refuse nested archives (§8.4). The
 * central directory is authoritative for names and sizes; a truncated or
 * malformed directory is refused too, since nothing else will read it.
 */
export function inspectZip(body: Buffer): { ok: true; entries: string[] } | { ok: false; reason: string } {
  const EOCD = 0x06054b50;
  let eocdAt = -1;
  const minAt = Math.max(0, body.length - 22 - 65_535);
  for (let i = body.length - 22; i >= minAt; i--) {
    if (body.readUInt32LE(i) === EOCD) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) return { ok: false, reason: "zip has no end-of-central-directory record" };
  const count = body.readUInt16LE(eocdAt + 10);
  const cdSize = body.readUInt32LE(eocdAt + 12);
  const cdOffset = body.readUInt32LE(eocdAt + 16);
  if (cdOffset + cdSize > body.length) return { ok: false, reason: "zip central directory is truncated" };
  const entries: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > body.length || body.readUInt32LE(p) !== 0x02014b50) {
      return { ok: false, reason: "zip central directory is malformed" };
    }
    const nameLen = body.readUInt16LE(p + 28);
    const extraLen = body.readUInt16LE(p + 30);
    const commentLen = body.readUInt16LE(p + 32);
    const name = body.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push(name);
    const lower = name.toLowerCase();
    if (ARCHIVE_EXTENSIONS.some((e) => lower.endsWith(e))) {
      return { ok: false, reason: `zip contains a nested archive (${name})` };
    }
    if (name.includes("..") || name.startsWith("/")) {
      return { ok: false, reason: `zip entry escapes its directory (${name})` };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries };
}

export interface IncomingFile {
  filename: string;
  body: Buffer;
}

export type AttachmentProblem = { code: "INVALID_SUBMISSION"; message: string };

export interface ValidatedAttachment {
  kind: AttachmentKind;
  filename: string;
  contentType: AllowedContentType;
  body: Buffer;
  sha256: string;
  metadata: Record<string, unknown>;
}

export function sha256Hex(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Validate the Lean file: size, lines, UTF-8, NUL, type. */
export function validateLeanSource(file: IncomingFile): ValidatedAttachment | AttachmentProblem {
  if (file.body.length === 0) return { code: "INVALID_SUBMISSION", message: "the Lean source is empty" };
  if (file.body.length > LEAN_MAX_BYTES) {
    return { code: "INVALID_SUBMISSION", message: `the Lean source exceeds ${LEAN_MAX_BYTES} bytes` };
  }
  if (!isValidUtf8(file.body)) return { code: "INVALID_SUBMISSION", message: "the Lean source is not valid UTF-8" };
  if (hasNul(file.body)) return { code: "INVALID_SUBMISSION", message: "the Lean source contains a NUL byte" };
  const lines = file.body.toString("utf8").split("\n").length;
  if (lines > LEAN_MAX_LINES) {
    return { code: "INVALID_SUBMISSION", message: `the Lean source exceeds ${LEAN_MAX_LINES} lines` };
  }
  const detected = detectContentType(file.body, file.filename, "lean_source");
  if (!detected) return { code: "INVALID_SUBMISSION", message: "the Lean source must be a .lean text file" };
  const filename = sanitizeFilename(file.filename, "proof.lean");
  return {
    kind: "lean_source",
    filename: filename.endsWith(".lean") ? filename : `${filename}.lean`,
    contentType: detected.contentType,
    body: file.body,
    sha256: sha256Hex(file.body),
    metadata: { lines },
  };
}

/** Validate the optional documents and data: count, sizes, types, zip contents. */
export function validateDocuments(files: IncomingFile[]): ValidatedAttachment[] | AttachmentProblem {
  if (files.length > DOCUMENT_MAX_FILES) {
    return { code: "INVALID_SUBMISSION", message: `at most ${DOCUMENT_MAX_FILES} documents may be attached` };
  }
  let total = 0;
  const out: ValidatedAttachment[] = [];
  for (const file of files) {
    if (file.body.length === 0) return { code: "INVALID_SUBMISSION", message: `${file.filename} is empty` };
    if (file.body.length > DOCUMENT_MAX_BYTES) {
      return { code: "INVALID_SUBMISSION", message: `${file.filename} exceeds ${DOCUMENT_MAX_BYTES} bytes` };
    }
    total += file.body.length;
    if (total > DOCUMENT_TOTAL_MAX_BYTES) {
      return { code: "INVALID_SUBMISSION", message: `attachments exceed ${DOCUMENT_TOTAL_MAX_BYTES} bytes in total` };
    }
    const detected = detectContentType(file.body, file.filename, "document");
    if (!detected) {
      return {
        code: "INVALID_SUBMISSION",
        message: `${file.filename} is not an allowed type (PDF, Markdown, text, CSV, JSON, zip, or .lean)`,
      };
    }
    const metadata: Record<string, unknown> = {};
    if (detected.contentType === ALLOWED_CONTENT_TYPES.zip) {
      const zip = inspectZip(file.body);
      if (!zip.ok) return { code: "INVALID_SUBMISSION", message: `${file.filename}: ${zip.reason}` };
      metadata.entries = zip.entries.slice(0, 200);
    }
    out.push({
      kind: detected.kind,
      filename: sanitizeFilename(file.filename),
      contentType: detected.contentType,
      body: file.body,
      sha256: sha256Hex(file.body),
      metadata,
    });
  }
  return out;
}

/** A tax form (W-9 or W-8BEN): a PDF or plain text, bounded, always restricted. */
export function validateTaxForm(file: IncomingFile): ValidatedAttachment | AttachmentProblem {
  if (file.body.length === 0) return { code: "INVALID_SUBMISSION", message: "the tax form is empty" };
  if (file.body.length > DOCUMENT_MAX_BYTES) {
    return { code: "INVALID_SUBMISSION", message: `the tax form exceeds ${DOCUMENT_MAX_BYTES} bytes` };
  }
  const detected = detectContentType(file.body, file.filename, "tax_form");
  if (!detected) return { code: "INVALID_SUBMISSION", message: "a tax form must be a PDF or a plain-text file" };
  return {
    kind: "tax_form",
    filename: sanitizeFilename(file.filename, "tax-form.pdf"),
    contentType: detected.contentType,
    body: file.body,
    sha256: sha256Hex(file.body),
    metadata: {},
  };
}

export interface AttachmentRow {
  id: string;
  contribution_id: string;
  owner_id: string;
  kind: AttachmentKind;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  storage: string;
  visibility: AttachmentVisibility;
  scan_status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const ATTACHMENT_COLS = `id, contribution_id, owner_id, kind, filename, content_type, size_bytes,
  sha256, storage, visibility, scan_status, metadata, created_at`;

/** Insert one attachment (inside the caller's transaction when given). */
export async function insertAttachment(
  input: ValidatedAttachment & { contributionId: string; ownerId: string; visibility?: AttachmentVisibility },
  tx?: Runner
): Promise<string> {
  const [row] = await asRunner(tx).query<{ id: string }>(
    `INSERT INTO attachments
       (contribution_id, owner_id, kind, filename, content_type, size_bytes,
        sha256, storage, body, visibility, scan_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'db', $8, $9, 'skipped', $10::jsonb)
     RETURNING id`,
    [
      input.contributionId,
      input.ownerId,
      input.kind,
      input.filename,
      input.contentType,
      input.body.length,
      input.sha256,
      input.body,
      input.visibility ?? "restricted",
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return row!.id;
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const [row] = await rawQuery<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLS} FROM attachments WHERE id = $1`,
    [id]
  );
  return row ?? null;
}

export async function getAttachmentBody(id: string): Promise<Buffer | null> {
  const [row] = await rawQuery<{ body: Buffer | null }>(
    `SELECT body FROM attachments WHERE id = $1 AND storage = 'db'`,
    [id]
  );
  return row?.body ?? null;
}

export async function listAttachmentsForContribution(
  contributionId: string,
  tx?: Runner
): Promise<AttachmentRow[]> {
  return asRunner(tx).query<AttachmentRow>(
    `SELECT ${ATTACHMENT_COLS} FROM attachments WHERE contribution_id = $1
      ORDER BY created_at ASC, id ASC`,
    [contributionId]
  );
}

/** The Lean source's text for a contribution, or null. */
export async function getLeanSourceForContribution(
  contributionId: string,
  tx?: Runner
): Promise<{ id: string; sha256: string; source: string; filename: string } | null> {
  const [row] = await asRunner(tx).query<{ id: string; sha256: string; body: Buffer; filename: string }>(
    `SELECT id, sha256, body, filename FROM attachments
      WHERE contribution_id = $1 AND kind = 'lean_source'
      ORDER BY created_at ASC LIMIT 1`,
    [contributionId]
  );
  if (!row) return null;
  return { id: row.id, sha256: row.sha256, source: row.body.toString("utf8"), filename: row.filename };
}

/**
 * Visibility transitions (§8.4): a Lean source (and the documents) become
 * public when the Steward accepts the claim; a rejected source stays
 * restricted until the bounty closes. A tax form never becomes public.
 */
export async function setAttachmentsVisibility(
  contributionId: string,
  visibility: AttachmentVisibility,
  tx?: Runner
): Promise<number> {
  const rows = await asRunner(tx).query<{ id: string }>(
    `UPDATE attachments SET visibility = $2
      WHERE contribution_id = $1 AND kind <> 'tax_form' AND visibility <> $2
      RETURNING id`,
    [contributionId, visibility]
  );
  return rows.length;
}

/** Who may read a body (§8.4, §8.11). */
export function canReadAttachment(
  row: { kind: AttachmentKind; visibility: AttachmentVisibility; owner_id: string },
  viewer: { userId: string | null; isService: boolean; isOperator: boolean }
): boolean {
  if (row.kind === "tax_form") {
    return viewer.isOperator || (viewer.userId !== null && viewer.userId === row.owner_id);
  }
  if (row.visibility === "public") return true;
  if (viewer.isOperator) return true;
  if (viewer.userId !== null && viewer.userId === row.owner_id) return true;
  return viewer.isService;
}

/** The headers a body is served with: attachment, nosniff, a sandboxing CSP. */
export function downloadHeaders(row: { filename: string; content_type: string; size_bytes: number }): Record<string, string> {
  const safe = sanitizeFilename(row.filename);
  return {
    "content-type": row.content_type,
    "content-length": String(row.size_bytes),
    "content-disposition": `attachment; filename="${safe}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    "cache-control": "private, no-store",
  };
}

/** Earlier submissions of the same bytes by another account (§8.4, duplicate_of). */
export async function findDuplicateSubmissions(
  sha256: string,
  ownerId: string,
  before: Date
): Promise<Array<{ attachment_id: string; contribution_id: string; owner_id: string; created_at: string }>> {
  const rows = await rawQuery<{ id: string; contribution_id: string; owner_id: string; created_at: Date }>(
    `SELECT id, contribution_id, owner_id, created_at FROM attachments
      WHERE sha256 = $1 AND kind = 'lean_source' AND owner_id <> $2 AND created_at < $3
      ORDER BY created_at ASC LIMIT 10`,
    [sha256, ownerId, before]
  );
  return rows.map((r) => ({
    attachment_id: r.id,
    contribution_id: r.contribution_id,
    owner_id: r.owner_id,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export function attachmentPublicView(row: AttachmentRow, includeLink: boolean) {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    sha256: row.sha256,
    visibility: row.visibility,
    created_at: new Date(row.created_at).toISOString(),
    ...(includeLink ? { url: `/attachments/${row.id}` } : {}),
  };
}
