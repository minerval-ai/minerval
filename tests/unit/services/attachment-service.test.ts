/**
 * Attachments (docs/mathematics.md §8.4, "Storage"): magic-byte typing
 * against the allowlist, filename sanitization, the Lean file's UTF-8, NUL,
 * size, and line limits, the document limits, zip inspection refusing
 * nested archives, read access, and the download headers.
 */
import { describe, it, expect } from "vitest";
import {
  detectContentType,
  sanitizeFilename,
  inspectZip,
  validateLeanSource,
  validateDocuments,
  validateTaxForm,
  canReadAttachment,
  downloadHeaders,
  LEAN_MAX_BYTES,
  LEAN_MAX_LINES,
  DOCUMENT_MAX_FILES,
} from "../../../src/services/attachment-service.js";

/** A minimal stored zip with the given entry names (empty bodies). */
function zipWith(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    n.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("content-type detection", () => {
  it("decides by magic bytes, never by the client's header", () => {
    expect(detectContentType(Buffer.from("%PDF-1.7 ..."), "anything.txt")?.contentType).toBe("application/pdf");
    expect(detectContentType(zipWith(["a.txt"]), "data.zip")?.contentType).toBe("application/zip");
    expect(detectContentType(Buffer.from("theorem t : True := trivial"), "proof.lean", "lean_source")).toMatchObject({ contentType: "text/x-lean", kind: "lean_source" });
    expect(detectContentType(Buffer.from('{"a":1}'), "rows.json")?.contentType).toBe("application/json");
    expect(detectContentType(Buffer.from("a,b\n1,2"), "rows.csv")?.contentType).toBe("text/csv");
    expect(detectContentType(Buffer.from("# notes"), "notes.md")?.contentType).toBe("text/markdown");
    expect(detectContentType(Buffer.from("plain"), "notes.txt")?.contentType).toBe("text/plain");
  });
  it("refuses binaries outside the allowlist, invalid UTF-8, NUL bytes, and unparsable JSON", () => {
    expect(detectContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "img.png")).toBeNull();
    expect(detectContentType(Buffer.from([0xff, 0xfe, 0x41]), "x.txt")).toBeNull();
    expect(detectContentType(Buffer.from("ab\0cd"), "x.txt")).toBeNull();
    expect(detectContentType(Buffer.from("{not json"), "x.json")).toBeNull();
    expect(detectContentType(Buffer.from("<script>"), "x.html")).toBeNull();
  });
});

describe("filename sanitization", () => {
  it("keeps a safe basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename('we"ird;na<>me.lean')).toBe("weirdname.lean");
    expect(sanitizeFilename('dir\\sub\\file.lean')).toBe("file.lean");
    expect(sanitizeFilename("..hidden")).toBe("hidden");
    expect(sanitizeFilename("   ")).toBe("attachment");
    expect(sanitizeFilename("x".repeat(300)).length).toBe(120);
  });
});

describe("the Lean file", () => {
  it("accepts a small UTF-8 file and reports its lines", () => {
    const v = validateLeanSource({ filename: "proof.lean", body: Buffer.from("theorem t : True := trivial\n") });
    expect("code" in v).toBe(false);
    if (!("code" in v)) expect(v.metadata).toEqual({ lines: 2 });
  });
  it("refuses empty, oversized, too many lines, invalid UTF-8, NUL, and non-.lean names", () => {
    expect(validateLeanSource({ filename: "p.lean", body: Buffer.alloc(0) })).toMatchObject({ code: "INVALID_SUBMISSION" });
    expect(validateLeanSource({ filename: "p.lean", body: Buffer.alloc(LEAN_MAX_BYTES + 1, 0x61) })).toMatchObject({ message: /bytes/ });
    expect(validateLeanSource({ filename: "p.lean", body: Buffer.from("\n".repeat(LEAN_MAX_LINES)) })).toMatchObject({ message: /lines/ });
    expect(validateLeanSource({ filename: "p.lean", body: Buffer.from([0xff, 0xfe]) })).toMatchObject({ message: /UTF-8/ });
    expect(validateLeanSource({ filename: "p.lean", body: Buffer.from("a\0b") })).toMatchObject({ message: /NUL/ });
    expect(validateLeanSource({ filename: "p.txt", body: Buffer.from("a") })).toMatchObject({ message: /\.lean/ });
  });
});

describe("documents and zips", () => {
  it("enforces the file count and inspects zips, refusing nested archives", () => {
    const many = Array.from({ length: DOCUMENT_MAX_FILES + 1 }, (_, i) => ({ filename: `d${i}.txt`, body: Buffer.from("x") }));
    expect(validateDocuments(many)).toMatchObject({ message: /at most 5/ });
    expect(inspectZip(zipWith(["a.txt", "dir/b.csv"]))).toMatchObject({ ok: true, entries: ["a.txt", "dir/b.csv"] });
    expect(inspectZip(zipWith(["a.txt", "inner.zip"]))).toMatchObject({ ok: false, reason: /nested archive/ });
    expect(inspectZip(zipWith(["data.tar.gz"]))).toMatchObject({ ok: false });
    expect(inspectZip(zipWith(["../escape.txt"]))).toMatchObject({ ok: false, reason: /escapes/ });
    expect(inspectZip(Buffer.from("PK\x03\x04 truncated"))).toMatchObject({ ok: false });
    const docs = validateDocuments([{ filename: "d.zip", body: zipWith(["a.txt"]) }, { filename: "n.md", body: Buffer.from("# n") }]);
    expect(Array.isArray(docs)).toBe(true);
    if (Array.isArray(docs)) {
      expect(docs[0]!.metadata).toEqual({ entries: ["a.txt"] });
      expect(docs[0]!.sha256).toHaveLength(64);
    }
    expect(validateDocuments([{ filename: "d.zip", body: zipWith(["x.rar"]) }])).toMatchObject({ code: "INVALID_SUBMISSION" });
  });
  it("accepts a PDF tax form and refuses a zip", () => {
    expect(validateTaxForm({ filename: "w9.pdf", body: Buffer.from("%PDF-1.4") })).toMatchObject({ kind: "tax_form", contentType: "application/pdf" });
    expect(validateTaxForm({ filename: "w9.zip", body: zipWith(["w9.pdf"]) })).toMatchObject({ code: "INVALID_SUBMISSION" });
  });
});

describe("read access and headers", () => {
  const restricted = { kind: "lean_source" as const, visibility: "restricted" as const, owner_id: "u1" };
  const pub = { ...restricted, visibility: "public" as const };
  const tax = { kind: "tax_form" as const, visibility: "restricted" as const, owner_id: "u1" };
  it("serves public bodies to anyone, restricted ones to the owner, service, or operator", () => {
    expect(canReadAttachment(pub, { userId: null, isService: false, isOperator: false })).toBe(true);
    expect(canReadAttachment(restricted, { userId: null, isService: false, isOperator: false })).toBe(false);
    expect(canReadAttachment(restricted, { userId: "u1", isService: false, isOperator: false })).toBe(true);
    expect(canReadAttachment(restricted, { userId: "u2", isService: true, isOperator: false })).toBe(true);
    expect(canReadAttachment(restricted, { userId: "u2", isService: false, isOperator: true })).toBe(true);
  });
  it("always restricts a tax form to the owner and the operator, never the service key", () => {
    expect(canReadAttachment(tax, { userId: "u1", isService: false, isOperator: false })).toBe(true);
    expect(canReadAttachment(tax, { userId: null, isService: false, isOperator: true })).toBe(true);
    expect(canReadAttachment(tax, { userId: "u2", isService: true, isOperator: false })).toBe(false);
    expect(canReadAttachment({ ...tax, visibility: "public" }, { userId: null, isService: true, isOperator: false })).toBe(false);
  });
  it("downloads as an attachment with nosniff and a sandboxing CSP", () => {
    const h = downloadHeaders({ filename: 'p"roof.lean', content_type: "text/x-lean", size_bytes: 12 });
    expect(h["content-disposition"]).toBe('attachment; filename="proof.lean"');
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toMatch(/sandbox/);
    expect(h["content-length"]).toBe("12");
  });
});
