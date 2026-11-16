import { describe, it, expect } from "vitest";

// The source page shows a section only when it has something in it (#507).
// A source quoted once for one claim, with nothing else recorded, is a quiet
// page: no outline rail, facts band, prominence figures or passage map, and
// one line for what has not happened instead of a row of empty sections.
import { getSourcePageFixture } from "../../../web/lib/fixtures-source";
import {
  absentLine, examViews, findingsBySegment, groupsOf, sourceShape,
} from "../../../web/components/source/model";
import type { SourcePage } from "../../../web/lib/types";

function shapeOf(page: SourcePage) {
  const groups = groupsOf(page.document);
  const findings = new Set(findingsBySegment(examViews(page)).keys());
  return sourceShape(page, groups, findings);
}

describe("sourceShape", () => {
  it("reads a post quoted once, with nothing else recorded, as quiet", () => {
    const page = getSourcePageFixture("transit-post")!;
    const shape = shapeOf(page);
    expect(shape).toMatchObject({ touched: 1, examined: 0, lineage: 0, facts: 0, history: 0, busy: false });
  });

  it("reads an examined paper with lineage as busy", () => {
    const shape = shapeOf(getSourcePageFixture("registry-study")!);
    expect(shape.examined).toBeGreaterThan(0);
    expect(shape.busy).toBe(true);
  });

  it("reads a report with copies as busy though nothing examined it", () => {
    const page = getSourcePageFixture("think-tank-report")!;
    page.context!.reviews!.requests = [];
    const shape = shapeOf(page);
    expect(shape.examined).toBe(0);
    expect(shape.facts).toBeGreaterThan(0);
    expect(shape.busy).toBe(true);
  });

  it("counts a Steward's reading as history beyond intake", () => {
    expect(shapeOf(getSourcePageFixture("council-transcript")!).history).toBe(1);
  });

  it("reads three marked passages as busy", () => {
    const page = getSourcePageFixture("transit-post")!;
    const segs = page.document!.segments;
    const marked = segs.find((s) => s.instances.length > 0)!.instances;
    for (const s of segs.filter((s) => s.kind === "passage").slice(1, 3)) s.instances = marked;
    expect(shapeOf(page)).toMatchObject({ touched: 3, busy: true });
  });
});

describe("absentLine", () => {
  it("says once, in the page's words, what a quiet page leaves out", () => {
    const page = getSourcePageFixture("transit-post")!;
    expect(absentLine(page, shapeOf(page))).toBe(
      "Not examined or reviewed. No other source draws on it or is drawn on by it.",
    );
  });

  it("names a review that has been asked for", () => {
    const page = getSourcePageFixture("transit-post")!;
    page.context!.reviews!.requests = [
      { id: "r1", ask: "Review this post", state: "open" as never, filed_at: "2025-03-05T00:00:00Z", live: true },
    ];
    expect(absentLine(page, shapeOf(page))).toBe(
      "Not examined; a review has been asked for. No other source draws on it or is drawn on by it.",
    );
  });

  it("says nothing about lineage when the graph has not served it", () => {
    const page = { ...getSourcePageFixture("transit-post")!, context: null };
    expect(absentLine(page, shapeOf(page))).toBe("Not examined or reviewed.");
  });

  it("is null when nothing it covers is missing", () => {
    const page = getSourcePageFixture("registry-study")!;
    expect(absentLine(page, shapeOf(page))).toBeNull();
  });
});
