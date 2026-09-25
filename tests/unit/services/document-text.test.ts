import { describe, it, expect } from "vitest";
import {
  bodyToText,
  extractPdfText,
  looksLikePdf,
  sanitizeStoredText,
} from "../../../src/services/document-text.js";

// The fetched-body-to-text step (#430): a PDF has its text extracted
// rather than its bytes decoded, and nothing that reaches the store
// carries the NUL bytes Postgres refuses.

/** A one-page, uncompressed PDF whose page shows `text` in Helvetica. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  // The binary-marker comment line is what makes a naive UTF-8 decode of
  // a real PDF carry NUL and other control bytes.
  let out = "%PDF-1.4\n%âãÏÓ\u0000\u0001\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("sanitizeStoredText", () => {
  it("removes NUL and other control characters but keeps tabs and newlines", () => {
    expect(sanitizeStoredText("a\u0000b\u0001c\u001Fd\u007Fe")).toBe("abcde");
    expect(sanitizeStoredText("line\tone\nline two\r\n")).toBe("line\tone\nline two\r\n");
    expect(sanitizeStoredText("déjà vu — “quoted”")).toBe("déjà vu — “quoted”");
  });
});

describe("looksLikePdf", () => {
  it("recognises the header, the content type, and neither", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.7\n"), null)).toBe(true);
    expect(looksLikePdf(Buffer.from("<html>"), "application/pdf")).toBe(true);
    expect(looksLikePdf(Buffer.from("<html>"), "application/pdf; charset=binary")).toBe(true);
    expect(looksLikePdf(Buffer.from("<html>"), "text/html; charset=utf-8")).toBe(false);
    expect(looksLikePdf(Buffer.from("%PD"), null)).toBe(false);
  });
});

describe("extractPdfText / bodyToText", () => {
  it("extracts a PDF's text instead of decoding its bytes", async () => {
    const pdf = minimalPdf("Hello from a PDF page");
    expect(pdf.toString("utf8")).toContain("\u0000");
    expect(await extractPdfText(pdf)).toBe("Hello from a PDF page");
    const text = await bodyToText(pdf, "application/pdf", "https://x.example/a.pdf");
    expect(text).toBe("Hello from a PDF page");
    expect(text).not.toContain("\u0000");
  });

  it("fails cleanly on a body that claims to be a PDF but is not one", async () => {
    await expect(
      bodyToText(Buffer.from("%PDF-1.4\nnot really"), null, "https://x.example/bad.pdf")
    ).rejects.toThrow(/Could not extract text from the PDF at https:\/\/x\.example\/bad\.pdf/);
  });

  it("decodes anything else as UTF-8 and scrubs it", async () => {
    const html = Buffer.from("<p>café\u0000</p>", "utf8");
    expect(await bodyToText(html, "text/html", "https://x.example/")).toBe("<p>café</p>");
  });
});
