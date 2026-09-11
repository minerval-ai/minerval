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
    responses: new Map<string, string>(),
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
}));

import {
  checkDoi,
  extractDois,
  htmlToText,
  readPage,
  recentRetractions,
} from "../../../src/services/source-watch-service.js";

beforeEach(() => {
  state.responses = new Map();
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

describe("htmlToText / readPage", () => {
  it("drops scripts, styles and tags, keeps line structure, and bounds the length", () => {
    const html = "<html><head><style>p{}</style><script>x()</script></head><body><h1>Title</h1><p>One &amp; two</p><p>Three</p></body></html>";
    expect(htmlToText(html)).toBe("Title\nOne & two\nThree");
    expect(htmlToText("<p>" + "a".repeat(50) + "</p>", 10)).toBe("aaaaaaaaaa\n[truncated]");
  });

  it("returns a problem rather than throwing on an unfetchable page", async () => {
    const res = await readPage("https://nowhere.example/x");
    expect(res).toMatchObject({ ok: false, problem: expect.stringContaining("no response") });
  });
});
