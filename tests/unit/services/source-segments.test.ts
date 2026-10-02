import { describe, it, expect, vi } from "vitest";

// The segmenter (#507, phase 4) as pure functions over readable text: the
// same document always divides the same way, sections nest by heading
// level, reference and note sections mark their contents, and a quotation
// is found across punctuation and line breaks.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));

import { headingOf, locateQuote, segmentAt, segmentText } from "../../../src/services/source-segment-service.js";

const DOC = [
  "Night work and diabetes",
  "Shift workers have long been suspected of higher metabolic risk.",
  "1. Methods",
  "We followed 9,000 nurses for ten years.",
  "1.1 Cohort",
  "Participants were recruited in 2006.",
  "Table 2. Hazard ratios by shift pattern",
  "2. Results",
  "Rotating night work was associated with a 1.4-fold higher risk.",
  "References",
  "Smith J. Shift work. Lancet. 2010.",
  "Jones K. Sleep. BMJ. 2012.",
].join("\n\n");

describe("headingOf", () => {
  it("knows markdown, numbered, and title-like headings, and not sentences or captions", () => {
    expect(headingOf("## Methods")).toEqual({ level: 2, label: "Methods" });
    expect(headingOf("2.1 Statistical analysis")).toEqual({ level: 2, label: "2.1 Statistical analysis" });
    expect(headingOf("Background")).toEqual({ level: 1, label: "Background" });
    expect(headingOf("We followed 9,000 nurses for ten years.")).toBeNull();
    expect(headingOf("Table 2. Hazard ratios")).toBeNull();
    expect(headingOf("lower-case line")).toBeNull();
    expect(headingOf("Two\nlines")).toBeNull();
  });
});

describe("segmentText", () => {
  it("nests sections by level and kinds the leaves by where they sit", () => {
    const segs = segmentText(DOC);
    const shape = segs.map((s) => [s.kind, s.label, s.parent]);
    expect(shape).toEqual([
      ["section", "Night work and diabetes", null],
      ["passage", null, 0],
      ["section", "1. Methods", null],
      ["passage", null, 2],
      ["section", "1.1 Cohort", 2],
      ["passage", null, 4],
      ["table", "Table 2", 4],
      ["section", "2. Results", null],
      ["passage", null, 7],
      ["section", "References", null],
      ["reference", null, 9],
      ["reference", null, 9],
    ]);
    // Every span is the text it claims to be.
    expect(DOC.slice(segs[3]!.start, segs[3]!.end)).toBe("We followed 9,000 nurses for ten years.");
    // A section runs to the next heading at its level or above.
    const methods = segs[2]!;
    expect(DOC.slice(methods.start, methods.end)).toMatch(/^1\. Methods[\s\S]*Hazard ratios by shift pattern$/);
    expect(segs[11]!.end).toBe(DOC.length);
  });

  it("is a single passage for unstructured text, and nothing for nothing", () => {
    expect(segmentText("Just one paragraph, with no heading at all.")).toEqual([
      { parent: null, kind: "passage", label: null, start: 0, end: 43 },
    ]);
    expect(segmentText("   \n\n  ")).toEqual([]);
  });

  it("divides the same text the same way every time", () => {
    expect(segmentText(DOC)).toEqual(segmentText(DOC));
  });
});

describe("locateQuote and segmentAt", () => {
  it("finds a quotation exactly or across punctuation and line breaks, and places it in its leaf", () => {
    const segs = segmentText(DOC);
    const exact = locateQuote(DOC, "a 1.4-fold higher risk")!;
    expect(DOC.slice(exact.start, exact.end)).toBe("a 1.4-fold higher risk");
    expect(segmentAt(segs, exact.start)).toBe(segs[8]);
    const loose = locateQuote(DOC, "“Rotating night work was associated with a 1.4 fold”")!;
    expect(DOC.slice(loose.start, loose.end)).toBe("Rotating night work was associated with a 1.4-fold");
    expect(locateQuote(DOC, "doubles the risk")).toBeNull();
    // An offset on a heading belongs to its section.
    expect(segmentAt(segs, segs[7]!.start)).toBe(segs[7]);
  });
});
