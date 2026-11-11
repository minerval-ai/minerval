import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Source watching (services/source-watch-service.ts): DOIs are found in
 * text and URLs; a DOI check reads the Crossref work AND the notices that
 * update it, so a retraction of the paper itself surfaces; the retraction
 * poll asks for the right filter; HTML reduces to bounded text. Network
 * mocked at the guarded fetch.
 */

const { state } = vi.hoisted(() => ({
  state: {
    responses: new Map<string, string | Buffer>(),
    /** What the server calls a body, by the same prefix; HTML when unset. */
    contentTypes: new Map<string, string | null>(),
    fetched: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));
vi.mock("../../../src/services/url-guard.js", () => ({
  fetchPublicUrl: vi.fn(async (url: string) => {
    state.fetched.push(url);
    for (const [prefix, body] of state.responses) {
      if (url.startsWith(prefix)) return body;
    }
    throw new Error(`no response for ${url}`);
  }),
  // readPage reads bytes and what the server called them (#912).
  fetchPublicBytes: vi.fn(async (url: string) => {
    state.fetched.push(url);
    for (const [prefix, body] of state.responses) {
      if (url.startsWith(prefix)) {
        return {
          bytes: typeof body === "string" ? Buffer.from(body, "utf8") : body,
          contentType: state.contentTypes.get(prefix) ?? "text/html; charset=utf-8",
          url,
        };
      }
    }
    throw new Error(`no response for ${url}`);
  }),
}));

import {
  checkDoi,
  extractDois,
  htmlToText,
  readPage,
  recentRetractions,
  recentRetractionsPage,
  retractionNoticesSince,
} from "../../../src/services/source-watch-service.js";

beforeEach(() => {
  state.responses = new Map();
  state.contentTypes = new Map();
  state.fetched = [];
});

describe("extractDois", () => {
  it("finds DOIs in URLs and prose, lower-cased and without trailing punctuation", () => {
    expect(extractDois("see https://doi.org/10.1000/ABC.123, and 10.5555/x-y).")).toEqual([
      "10.1000/abc.123",
      "10.5555/x-y",
    ]);
    expect(extractDois("nothing here")).toEqual([]);
  });
});

describe("checkDoi", () => {
  it("reads the work and the notices that update it", async () => {
    state.responses.set(
      "https://api.crossref.org/works/10.1000%2Fpaper",
      JSON.stringify({
        message: {
          DOI: "10.1000/paper",
          title: ["A result"],
          type: "journal-article",
          "is-referenced-by-count": 12,
          published: { "date-parts": [[2021, 3]] },
        },
      })
    );
    state.responses.set(
      "https://api.crossref.org/works?filter=updates:10.1000%2Fpaper",
      JSON.stringify({
        message: {
          items: [
            {
              DOI: "10.1000/paper-retraction",
              source: "retraction-watch",
              "update-to": [{ DOI: "10.1000/PAPER", type: "retraction", label: "Retraction", updated: { "date-time": "2026-08-01T00:00:00Z" } }],
            },
          ],
        },
      })
    );
    const res = await checkDoi("https://doi.org/10.1000/paper");
    expect(res).toMatchObject({
      doi: "10.1000/paper",
      found: true,
      title: "A result",
      published: "2021-03",
      cited_by: 12,
      updates: [{ doi: "10.1000/paper-retraction", type: "retraction", label: "Retraction", source: "retraction-watch" }],
    });
  });

  it("returns not-found for a malformed DOI without touching the network", async () => {
    const res = await checkDoi("not a doi");
    expect(res.found).toBe(false);
    expect(state.fetched).toEqual([]);
  });
});

describe("recentRetractions", () => {
  it("asks Crossref for the update types since the date and maps the notices", async () => {
    state.responses.set(
      "https://api.crossref.org/works?filter=",
      JSON.stringify({
        message: {
          items: [
            { DOI: "10.2/N", title: ["Retraction notice"], source: "publisher", "update-to": [{ DOI: "10.2/P", type: "retraction" }] },
          ],
        },
      })
    );
    const rows = await recentRetractions({ since: new Date("2026-09-01T00:00:00Z"), types: ["retraction", "correction"] });
    expect(decodeURIComponent(state.fetched[0]!)).toContain("update-type:retraction,update-type:correction,from-update-date:2026-09-01");
    expect(rows).toEqual([
      { notice_doi: "10.2/n", retracted_dois: ["10.2/p"], type: "retraction", title: "Retraction notice", updated: null, source: "publisher" },
    ]);
  });
});

describe("recentRetractionsPage", () => {
  it("passes the offset and reports the total and where the next page starts", async () => {
    state.responses.set(
      "https://api.crossref.org/works?filter=",
      JSON.stringify({
        message: {
          "total-results": 3,
          items: [
            { DOI: "10.2/A", "update-to": [{ DOI: "10.2/X", type: "retraction" }] },
            { DOI: "10.2/B", "update-to": [{ DOI: "10.2/Y", type: "retraction" }] },
          ],
        },
      })
    );
    const page = await recentRetractionsPage({ since: new Date("2026-09-01T00:00:00Z"), rows: 2, offset: 0 });
    expect(state.fetched[0]).toContain("&rows=2&offset=0");
    expect(page).toMatchObject({ total: 3, offset: 0, next_offset: 2 });
    expect(page!.rows.map((r) => r.notice_doi)).toEqual(["10.2/a", "10.2/b"]);
  });

  it("returns null when Crossref cannot be read", async () => {
    expect(await recentRetractionsPage({ since: new Date("2026-09-01T00:00:00Z") })).toBeNull();
  });
});

describe("retractionNoticesSince", () => {
  const item = (doi: string, deposited: string) => ({
    DOI: doi, "update-to": [{ DOI: `${doi}-paper`, type: "retraction" }], deposited: { "date-time": deposited },
  });

  it("follows the cursor oldest first until the window is exhausted", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    const page = (body: unknown) => async (url: string) => {
      state.fetched.push(url);
      return JSON.stringify(body);
    };
    vi.mocked(fetchPublicUrl)
      .mockImplementationOnce(page({ message: { items: [item("10.3/a", "2026-09-01T01:00:00Z"), item("10.3/b", "2026-09-01T02:00:00Z")], "next-cursor": "C2" } }))
      .mockImplementationOnce(page({ message: { items: [item("10.3/c", "2026-09-02T00:00:00Z")], "next-cursor": "C3" } }));
    const w = await retractionNoticesSince({ since: new Date("2026-09-01T00:00:00Z"), types: ["retraction"], pageRows: 2 });
    expect(state.fetched).toHaveLength(2);
    expect(state.fetched[0]).toContain("cursor=*");
    expect(state.fetched[1]).toContain("cursor=C2");
    expect(state.fetched[0]).toContain("order=asc");
    expect(w).toEqual({
      notices: expect.any(Array),
      complete: true,
      readThrough: new Date("2026-09-02T00:00:00Z"),
    });
    expect(w.notices.map((n) => n.notice_doi)).toEqual(["10.3/a", "10.3/b", "10.3/c"]);
  });

  it("stops early on a failed page or at maxPages, saying how far it read", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    const first = async (url: string) => {
      state.fetched.push(url);
      return JSON.stringify({ message: { items: [item("10.3/a", "2026-09-01T01:00:00Z")], "next-cursor": "C2" } });
    };
    vi.mocked(fetchPublicUrl)
      .mockImplementationOnce(first)
      .mockImplementationOnce(async () => {
        throw new Error("network");
      })
      .mockImplementationOnce(first);
    const failed = await retractionNoticesSince({ since: new Date("2026-09-01T00:00:00Z"), types: ["retraction"], pageRows: 1 });
    expect(failed).toMatchObject({ complete: false, readThrough: new Date("2026-09-01T01:00:00Z") });
    expect(failed.notices).toHaveLength(1);

    const capped = await retractionNoticesSince({ since: new Date("2026-09-01T00:00:00Z"), types: ["retraction"], pageRows: 1, maxPages: 1 });
    expect(capped).toMatchObject({ complete: false, readThrough: new Date("2026-09-01T01:00:00Z") });
  });
});

describe("htmlToText / readPage", () => {
  it("drops scripts, styles and tags, keeps line structure, and bounds the length", () => {
    const html = "<html><head><style>p{}</style><script>x()</script></head><body><h1>Title</h1><p>One &amp; two</p><p>Three</p></body></html>";
    expect(htmlToText(html)).toBe("Title\nOne & two\nThree");
    expect(htmlToText("<p>" + "a".repeat(50) + "</p>", 10)).toBe("aaaaaaaaaa\n[truncated]");
  });

  it("keeps the edge cases of its stripping: tag case, unclosed elements, `<>`", () => {
    expect(
      htmlToText("<div><SCRIPT type=x>if (a < b) {}</Script>Kept<scripts>gone</SCRIPT> <style>p{}</STYLE><noscript>x</noscript>.</div>")
    ).toBe("Kept .");
    // An unclosed <script> stays as text and does not hide a closed <style> after it.
    expect(htmlToText("<p>x <script never closed <style>gone</style> y</p>")).toBe("x <script never closed y");
    expect(htmlToText("<p>a</p><p>b<style>never closed")).toBe("a\nb never closed");
    expect(htmlToText("a<script>x</script >b</script>c")).toBe("a c");
    expect(htmlToText("<p>1 <> 2 < 3</p>")).toBe("1 <> 2 < 3");
  });

  it("takes linear time on a page built to make it backtrack", async () => {
    // Each took seconds at this size (hours at the 10 MB a read allows) when
    // every later start position was retried after a failed match.
    const n = 100_000;
    const cases: Array<[string, string]> = [
      ["<".repeat(n), "<".repeat(n)],
      ["<script ".repeat(n / 8), "<script ".repeat(n / 8).trim()],
      ["<style ".repeat(n / 10), "<style ".repeat(n / 10).trim()],
      ["<noscript ".repeat(n / 10), "<noscript ".repeat(n / 10).trim()],
    ];
    for (const [input, expected] of cases) {
      const start = performance.now();
      const text = htmlToText(input, 2 * n);
      const ms = performance.now() - start;
      expect(text).toBe(expected);
      expect(ms).toBeLessThan(500);
    }

    state.responses.set("https://attacker.example/", "<".repeat(n));
    const start = performance.now();
    const res = await readPage("https://attacker.example/brief");
    expect(performance.now() - start).toBeLessThan(500);
    expect(res).toEqual({
      ok: true,
      url: "https://attacker.example/brief",
      text: "<".repeat(12_000),
      chars: 12_000,
      total_chars: n,
      offset: 0,
      truncated: true,
      next_offset: 12_000,
    });
  });

  it("reads a long page whole by paging, with the window contract of provenance_read_source", async () => {
    // A paper past the old 12,000-character cut: its methods sit at the end.
    const body = `<html><body><p>${"Introduction. ".repeat(1_500)}</p><p>METHODS: n = 412, randomised.</p></body></html>`;
    state.responses.set("https://journal.example/", body);
    const first = await readPage("https://journal.example/paper");
    expect(first).toMatchObject({ ok: true, offset: 0, chars: 12_000, truncated: true, next_offset: 12_000 });
    if (!first.ok) throw new Error("unreachable");
    expect(first.text).not.toContain("METHODS");

    let window = first;
    const read = [first.text];
    while (window.ok && window.next_offset !== null) {
      window = await readPage("https://journal.example/paper", { offset: window.next_offset });
      if (window.ok) read.push(window.text);
    }
    expect(window).toMatchObject({ ok: true, truncated: false, next_offset: null });
    expect(read.join("")).toHaveLength(first.total_chars);
    expect(read.join("")).toContain("METHODS: n = 412, randomised.");
  });

  it("sizes a window by max_chars, within the reader's maximum", async () => {
    state.responses.set("https://plain.example/", "x".repeat(50_000));
    expect(await readPage("https://plain.example/a", { maxChars: 100, offset: 10 })).toMatchObject({
      chars: 100, offset: 10, next_offset: 110, total_chars: 50_000,
    });
    expect(await readPage("https://plain.example/a", { maxChars: 1_000_000 })).toMatchObject({ chars: 20_000 });
    expect(await readPage("https://plain.example/a", { offset: 60_000 })).toMatchObject({
      chars: 0, truncated: false, next_offset: null,
    });
  });

  it("reads a data or TeX file as written, not as markup to strip (#912)", async () => {
    // htmlToText drops what lies between a `<` and a later `>` and folds tabs and blank lines.
    const tex = "\\begin{tabular}{ll}\nmass\t$m < 3$\\\\\n\nwidth\t$w > 2$\\\\\n\\end{tabular}\n";
    state.responses.set("https://raw.githubusercontent.com/a/b/main/table.tex", tex);
    state.contentTypes.set("https://raw.githubusercontent.com/a/b/main/table.tex", "text/plain; charset=utf-8");
    const res = await readPage("https://raw.githubusercontent.com/a/b/main/table.tex");
    expect(res).toMatchObject({ ok: true, text: tex });

    // A server that says only "octet-stream" is believed about nothing; the extension decides.
    const csv = "x,y\n1,<2\n3,>4\n";
    state.responses.set("https://zenodo.example/files/fig2.csv", csv);
    state.contentTypes.set("https://zenodo.example/files/fig2.csv", "application/octet-stream");
    expect(await readPage("https://zenodo.example/files/fig2.csv")).toMatchObject({ ok: true, text: csv });

    // HTML served as text/plain is still a page.
    state.responses.set("https://odd.example/", "<!doctype html><html><body><p>Hello</p></body></html>");
    state.contentTypes.set("https://odd.example/", "text/plain");
    expect(await readPage("https://odd.example/x")).toMatchObject({ ok: true, text: "Hello" });
  });

  it("names an image or an archive for what it is, with the tool that reads it (#912)", async () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    state.responses.set("https://arxiv.org/html/2401.00001/x1.png", png);
    // Whatever the server calls it.
    state.contentTypes.set("https://arxiv.org/html/2401.00001/x1.png", "text/html");
    const image = await readPage("https://arxiv.org/html/2401.00001/x1.png");
    expect(image).toMatchObject({ ok: false, problem: expect.stringMatching(/is an image \(image\/png, 640 by 480 px\).*view_image/) });

    state.responses.set("https://arxiv.org/e-print/2401.00001", Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]));
    const archive = await readPage("https://arxiv.org/e-print/2401.00001");
    expect(archive).toMatchObject({ ok: false, problem: expect.stringMatching(/gzip archive.*read_arxiv_source/) });
  });

  it("returns a problem rather than throwing on an unfetchable page", async () => {
    const res = await readPage("https://nowhere.example/x");
    expect(res).toMatchObject({ ok: false, problem: expect.stringContaining("no response") });
  });
});
