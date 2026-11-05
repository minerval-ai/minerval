import { describe, it, expect, vi } from "vitest";

/**
 * Scoped ingest, the pure half (services/ingest-focus-service.ts): a focus
 * is normalized so the same subject written twice is one group; a
 * whole-document ingest keeps the URL's original group and a scoped one
 * gets its own; the extraction prompt carries the focus and says to leave
 * other subjects out; a plan's ingest focus must be text.
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import { ingestCoverage, ingestGroup, normalizeFocus, FOCUS_MAX_CHARS } from "../../../src/services/ingest-focus-service.js";
import { rawQuery } from "../../../src/db/client.js";
import { getExtractionPrompt } from "../../../src/llm/prompts/extractor.js";
import { validatePlanItems, type PlanItem } from "../../../src/services/grant-service.js";

const URL = "https://example.org/essay";

describe("normalizeFocus", () => {
  it("trims, collapses whitespace, caps the length, and treats empty as none", () => {
    expect(normalizeFocus("  claims about   grid\nreliability ")).toBe("claims about grid reliability");
    expect(normalizeFocus("   ")).toBeNull();
    expect(normalizeFocus(undefined)).toBeNull();
    expect(normalizeFocus(42)).toBeNull();
    expect(normalizeFocus("x".repeat(FOCUS_MAX_CHARS + 50))).toHaveLength(FOCUS_MAX_CHARS);
  });
});

describe("ingestGroup", () => {
  it("keeps the URL's own group for a whole-document ingest", () => {
    expect(ingestGroup(URL)).toBe(`ingest:${URL}`);
    expect(ingestGroup(URL, null)).toBe(`ingest:${URL}`);
    expect(ingestGroup(URL, "  ")).toBe(`ingest:${URL}`);
  });

  it("gives each focus its own group, the same one however the focus is spaced", () => {
    const a = ingestGroup(URL, "claims about housing policy");
    expect(a).toMatch(/^ingest:https:\/\/example\.org\/essay#focus:[0-9a-f]{16}$/);
    expect(ingestGroup(URL, " claims  about housing policy ")).toBe(a);
    expect(ingestGroup(URL, "claims about monetary policy")).not.toBe(a);
  });
});

describe("getExtractionPrompt with a focus", () => {
  it("names the subject, asks for the whole document to be read, and for other subjects to be left out", () => {
    const p = getExtractionPrompt("article", "A title", 0, "claims about grid reliability");
    expect(p).toContain('"claims about grid reliability"');
    expect(p).toContain("Read the whole article");
    expect(p).toContain("Leave out claims about other subjects");
    expect(p).toContain("propose nothing");
  });

  it("says nothing of a focus when there is none", () => {
    expect(getExtractionPrompt("article", "A title")).not.toContain("scoped reading");
  });
});

describe("validatePlanItems", () => {
  it("accepts an ingest with a text focus and refuses one that is not text", () => {
    const ok: PlanItem[] = [{ action: "ingest", url: URL, rationale: "r", focus: "claims about X" }];
    expect(validatePlanItems(ok)).toBeNull();
    const bad = [{ action: "ingest", url: URL, rationale: "r", focus: 7 }] as unknown as PlanItem[];
    expect(validatePlanItems(bad)).toMatch(/focus must be text/);
  });
});

describe("ingestCoverage: only a complete reading covers (#738, #740)", () => {
  const source = { id: "s1", title: "Essay" };
  const answer = (records: Array<{ focus: string | null; complete: boolean }>) =>
    vi.mocked(rawQuery).mockImplementation(async (sql: string) =>
      (/FROM sources/.test(sql) ? [source] : /FROM source_extractions/.test(sql) ? records : []) as never
    );

  it("treats a whole reading that left proposals undecided or could not read the page as not covering", async () => {
    answer([{ focus: null, complete: false }]);
    expect(await ingestCoverage(URL, null)).toEqual({ covered: false });
    answer([{ focus: null, complete: true }]);
    expect(await ingestCoverage(URL, null)).toMatchObject({ covered: true, by: "whole" });
  });
});

describe("the extraction prompt's confidence floor (#748)", () => {
  it("is stated when the caller has one", () => {
    expect(getExtractionPrompt("article", undefined, 0, null, 0.3)).toMatch(/confidence below 0\.3 are dropped/);
    expect(getExtractionPrompt("article")).not.toMatch(/are dropped/);
  });
});
