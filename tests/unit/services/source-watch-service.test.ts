import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    maxBytes: [] as Array<number | undefined>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));
vi.mock("../../../src/services/url-guard.js", async (importOriginal) => ({
  // The error classes and the document cap are the real ones, so a refusal is classified as the fetcher throws it.
  ...(({ HttpStatusError, UnsafeUrlError, ResponseTooLargeError, DOCUMENT_MAX_DOWNLOAD_BYTES, DOCUMENT_MAX_DOWNLOAD_MB }) => ({
    HttpStatusError,
    UnsafeUrlError,
    ResponseTooLargeError,
    DOCUMENT_MAX_DOWNLOAD_BYTES,
    DOCUMENT_MAX_DOWNLOAD_MB,
  }))(await importOriginal<typeof import("../../../src/services/url-guard.js")>()),
  fetchPublicUrl: vi.fn(async (url: string) => {
    state.fetched.push(url);
    for (const [prefix, body] of state.responses) {
      if (url.startsWith(prefix)) return body;
    }
    throw new Error(`no response for ${url}`);
  }),
  // readPage reads bytes and what the server called them (#912).
  fetchPublicBytes: vi.fn(async (url: string, init?: { maxBytes?: number }) => {
    state.fetched.push(url);
    state.maxBytes.push(init?.maxBytes);
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

import { HttpStatusError, UnsafeUrlError } from "../../../src/services/url-guard.js";
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
  state.maxBytes = [];
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

  it("says why when Crossref cannot be read", async () => {
    expect(await recentRetractionsPage({ since: new Date("2026-09-01T00:00:00Z") })).toMatchObject({
      ok: false,
      retryable: false,
      attempts: 1,
      problem: expect.stringContaining("no response for"),
    });
  });
});

// A passing Crossref failure is asked again, briefly, before it is
// reported; one that will not pass is reported at once (#1034).
describe("Crossref retries", () => {
  const since = new Date("2026-09-01T00:00:00Z");
  const okPage = JSON.stringify({ message: { "total-results": 0, items: [] } });
  const failWith = (err: unknown) => async (url: string) => {
    state.fetched.push(url);
    throw err;
  };
  const succeed = async (url: string) => {
    state.fetched.push(url);
    return okPage;
  };
  const settle = async <T>(p: Promise<T>): Promise<T> => {
    await vi.runAllTimersAsync();
    return p;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 503 and a network error, and returns the page that then comes back", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    vi.mocked(fetchPublicUrl)
      .mockImplementationOnce(failWith(new HttpStatusError("https://api.crossref.org/works", 503, null)))
      .mockImplementationOnce(failWith(new TypeError("fetch failed")))
      .mockImplementationOnce(succeed);
    const page = await settle(recentRetractionsPage({ since }));
    expect(state.fetched).toHaveLength(3);
    expect(page).toMatchObject({ total: 0, rows: [] });
  });

  it("gives up after three attempts, saying it was retried and that trying later can help", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    vi.mocked(fetchPublicUrl).mockImplementation(
      failWith(new HttpStatusError("https://api.crossref.org/works", 429, "1"))
    );
    const page = await settle(recentRetractionsPage({ since }));
    vi.mocked(fetchPublicUrl).mockReset();
    expect(state.fetched).toHaveLength(3);
    expect(page).toMatchObject({ ok: false, retryable: true, attempts: 3 });
    expect((page as { problem: string }).problem).toMatch(/429.*3 attempts/);
  });

  it("waits out a short Retry-After, and reports a long one without waiting", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    vi.mocked(fetchPublicUrl)
      .mockImplementationOnce(failWith(new HttpStatusError("https://api.crossref.org/works", 429, "3")))
      .mockImplementationOnce(succeed);
    const pending = recentRetractionsPage({ since });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(state.fetched).toHaveLength(1);
    expect(await settle(pending)).toMatchObject({ total: 0 });
    expect(state.fetched).toHaveLength(2);

    state.fetched = [];
    vi.mocked(fetchPublicUrl).mockImplementationOnce(
      failWith(new HttpStatusError("https://api.crossref.org/works", 429, "120"))
    );
    const long = await settle(recentRetractionsPage({ since }));
    expect(state.fetched).toHaveLength(1);
    expect(long).toMatchObject({ ok: false, retryable: true, attempts: 1, problem: expect.stringContaining("120s") });
  });

  it("does not retry a refusal that will not change, a timeout, or a 404", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const cases: Array<[unknown, boolean]> = [
      [new UnsafeUrlError("Hostname does not resolve: api.crossref.org"), false],
      [Object.assign(new Error("web_pages is not cleared"), { name: "ProviderNotClearedError" }), false],
      [new HttpStatusError("https://api.crossref.org/works", 404, null), false],
      [timeout, true],
    ];
    for (const [err, retryable] of cases) {
      state.fetched = [];
      vi.mocked(fetchPublicUrl).mockImplementationOnce(failWith(err));
      const page = await settle(recentRetractionsPage({ since }));
      expect(state.fetched).toHaveLength(1);
      expect(page).toMatchObject({ ok: false, retryable, attempts: 1 });
    }
  });

  it("marks a DOI check whose read failed, so not-found is not taken as a finding", async () => {
    const { fetchPublicUrl } = await import("../../../src/services/url-guard.js");
    vi.mocked(fetchPublicUrl).mockImplementation(
      failWith(new HttpStatusError("https://api.crossref.org/works", 502, null))
    );
    const res = await settle(checkDoi("10.1000/paper"));
    vi.mocked(fetchPublicUrl).mockReset();
    expect(res).toMatchObject({ found: false, updates: [], retryable: true, problem: expect.stringContaining("502") });
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
    expect(htmlToText(html)).toBe("# Title\n\nOne & two\n\nThree");
    expect(htmlToText("<p>" + "a".repeat(50) + "</p>", 10)).toBe("aaaaaaaaaa\n[truncated]");
  });

  it("decodes an entity once: an escaped entity stays as written", () => {
    expect(htmlToText("<p>write &amp;lt;b&amp;gt; for bold</p>")).toBe("write &lt;b&gt; for bold");
  });

  it("keeps the edge cases of its stripping: tag case, unclosed elements, `<>`", () => {
    expect(
      htmlToText("<div><SCRIPT type=x>if (a < b) {}</Script>Kept <style>p{}</STYLE><noscript>x</noscript>.</div>")
    ).toBe("Kept .");
    // An unclosed <script> is read on from its opening tag and does not hide a closed <style> after it.
    expect(htmlToText("<p>x <script never closed>y <style>gone</style>z</p>")).toBe("x y z");
    expect(htmlToText("<p>a</p><p>b <style>never closed")).toBe("a\n\nb never closed");
    expect(htmlToText("a<script>x</script >b</script>c")).toBe("abc");
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

  it("reads a document up to the document cap, and says what to try when one is over it (#1068)", async () => {
    state.responses.set("https://plain.example/a", "Hello");
    await readPage("https://plain.example/a");
    expect(state.maxBytes).toEqual([50 * 1024 * 1024]);

    const { fetchPublicBytes, ResponseTooLargeError } = await import("../../../src/services/url-guard.js");
    vi.mocked(fetchPublicBytes).mockRejectedValueOnce(
      new ResponseTooLargeError("https://big.example/card.pdf", 50 * 1024 * 1024)
    );
    const res = await readPage("https://big.example/card.pdf");
    expect(res).toMatchObject({ ok: false });
    const problem = (res as { problem: string }).problem;
    expect(problem).toMatch(/over 50 MB and was not fetched/);
    expect(problem).toMatch(/memory of the server every agent runs on, which no budget bounds/);
    expect(problem).toMatch(/an ingest of this URL fails at the same limit/);
    expect(problem).toMatch(/HTML version/);
  });

  it("returns a problem rather than throwing on an unfetchable page", async () => {
    const res = await readPage("https://nowhere.example/x");
    expect(res).toMatchObject({ ok: false, problem: expect.stringContaining("no response") });
  });
});
