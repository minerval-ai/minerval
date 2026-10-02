import { describe, it, expect, vi } from "vitest";

// The facts fetcher's pure parts (#507, phase 3): what a page's metadata
// says about it, dates kept at the precision they state, Crossref update
// types onto event kinds, and the archive lookup. The writes are covered in
// tests/db/source-facts.test.ts.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));

import {
  eventKindForCrossref,
  findArchivedCopy,
  isoDatePrefix,
  parsePageFacts,
} from "../../../src/services/source-facts-service.js";

describe("parsePageFacts", () => {
  it("reads scholarly citation tags first, one author per tag, entities decoded", () => {
    const html = `<!doctype html><html><head>
      <meta name="citation_title" content="Night work and diabetes">
      <meta name="citation_author" content="Smith, Jane">
      <meta name="citation_author" content="M&uuml;ller, K.">
      <meta name="citation_journal_title" content="Journal of Shift Work">
      <meta name="citation_publication_date" content="2022/03/07">
      <meta name="citation_doi" content="doi:10.1234/ABC.5">
      <meta property="og:title" content="Ignored">
      </head><body><p>x</p></body></html>`;
    expect(parsePageFacts(html)).toEqual({
      title: "Night work and diabetes",
      authors: ["Smith, Jane", "Müller, K."],
      publisher: "Journal of Shift Work",
      published_date: "2022-03-07",
      doi: "10.1234/abc.5",
    });
  });

  it("falls back to Dublin Core and Open Graph, and never splits a byline", () => {
    const html = `<html><head>
      <meta property="og:title" content='Half of new jobs are part-time'>
      <meta property="og:site_name" content="Daily Paper">
      <meta property="article:published_time" content="2024-05-14T09:00:00Z">
      <meta name="author" content="Jane Smith and Ken Jones">
      </head><body></body></html>`;
    expect(parsePageFacts(html)).toEqual({
      title: "Half of new jobs are part-time",
      authors: ["Jane Smith and Ken Jones"],
      publisher: "Daily Paper",
      published_date: "2024-05-14",
      doi: null,
    });
  });

  it("finds nothing in plain text or an empty document", () => {
    const empty = { title: null, authors: [], publisher: null, published_date: null, doi: null };
    expect(parsePageFacts("Just some text about 10.1234/x")).toEqual(empty);
    expect(parsePageFacts(null)).toEqual(empty);
  });
});

describe("isoDatePrefix", () => {
  it("keeps the precision a date states, and no more", () => {
    expect(isoDatePrefix("2023")).toBe("2023");
    expect(isoDatePrefix("2023-5")).toBe("2023-05");
    expect(isoDatePrefix("2023/05/14 10:00")).toBe("2023-05-14");
    expect(isoDatePrefix("2023-13-01")).toBe("2023");
    expect(isoDatePrefix("May 2023")).toBeNull();
    expect(isoDatePrefix(null)).toBeNull();
  });
});

describe("eventKindForCrossref", () => {
  it("maps Crossref update types, keeping a concern apart from a correction", () => {
    expect(eventKindForCrossref("retraction")).toBe("retraction");
    expect(eventKindForCrossref("withdrawal")).toBe("retraction");
    expect(eventKindForCrossref("erratum")).toBe("correction");
    expect(eventKindForCrossref("expression_of_concern")).toBe("expression_of_concern");
    expect(eventKindForCrossref("new_version")).toBe("update");
    expect(eventKindForCrossref(null)).toBe("update");
  });
});

describe("findArchivedCopy", () => {
  it("returns the closest snapshot over https, and null when there is none or the lookup fails", async () => {
    const ok = vi.fn(async () =>
      JSON.stringify({ archived_snapshots: { closest: { available: true, status: "200", url: "http://web.archive.org/web/2024/https://x.org/a" } } })
    );
    expect(await findArchivedCopy("https://x.org/a", ok)).toBe("https://web.archive.org/web/2024/https://x.org/a");
    expect(ok).toHaveBeenCalledWith("https://archive.org/wayback/available?url=https%3A%2F%2Fx.org%2Fa");
    expect(await findArchivedCopy("https://x.org/a", async () => JSON.stringify({ archived_snapshots: {} }))).toBeNull();
    expect(
      await findArchivedCopy("https://x.org/a", async () =>
        JSON.stringify({ archived_snapshots: { closest: { available: true, status: "404", url: "http://w/x" } } })
      )
    ).toBeNull();
    expect(await findArchivedCopy("https://x.org/a", async () => { throw new Error("down"); })).toBeNull();
  });
});
