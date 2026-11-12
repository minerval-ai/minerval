/**
 * The parts of a page and what a removal does to one (src/services/page-parts.ts).
 */
import { describe, expect, it } from "vitest";
import { RemovalError, applyRemovals, descriptorOf, heldWords, kindWords, locate, overlaps, paragraphsOf } from "../../../src/services/page-parts.js";

describe("dividing a text column", () => {
  it("takes the blocks between blank lines, each exactly as written", () => {
    const text = "First line\nsecond line of the same paragraph.\n\n  An indented one, with $x^2$.  \n \t \n\n\nThird.\r\n\r\nFourth.";
    expect(paragraphsOf(text)).toEqual(["First line\nsecond line of the same paragraph.", "  An indented one, with $x^2$.  ", "Third.", "Fourth."]);
    expect(paragraphsOf("")).toEqual([]);
    expect(paragraphsOf(null)).toEqual([]);
    expect(paragraphsOf("One paragraph only.")).toEqual(["One paragraph only."]);
  });
});

describe("a removal", () => {
  const part = "The plant made 4711 units in March, and 4711 again in April.";

  it("finds a passage given exactly, and asks which where it appears twice", () => {
    expect(locate(part, "in March")).toEqual({ start: 26, end: 34 });
    expect(part.slice(26, 34)).toBe("in March");
    expect(() => locate(part, "4711")).toThrow(/appears 2 times/);
    expect(locate(part, "4711", 2)).toEqual({ start: part.lastIndexOf("4711"), end: part.lastIndexOf("4711") + 4 });
    expect(() => locate(part, "4711", 3)).toThrow(RemovalError);
    expect(() => locate(part, "in  March")).toThrow(/not in this part as written/);
    expect(() => locate(part, "")).toThrow(RemovalError);
  });

  it("leaves the category's mark in the passage's place and changes nothing else", () => {
    const { text, marks } = applyRemovals(part, [
      { ...locate(part, "4711", 2), category: "commercial figures" },
      { ...locate(part, "4711", 1), category: "commercial figures" },
    ]);
    expect(text).toBe("The plant made [redacted: commercial figures] units in March, and [redacted: commercial figures] again in April.");
    expect(marks).toEqual([{ at: 15, category: "commercial figures" }, { at: 66, category: "commercial figures" }]);
    for (const mark of marks) expect(text.startsWith("[redacted: commercial figures]", mark.at)).toBe(true);
    expect(applyRemovals(part, [])).toEqual({ text: part, marks: [] });
    // A mark says the category and nothing about the passage: two passages of different lengths leave the same mark.
    expect(applyRemovals("a", [{ start: 0, end: 1, category: "personal data" }]).text).toBe(applyRemovals("a much longer passage", [{ start: 0, end: 21, category: "personal data" }]).text);
  });

  it("refuses a removal that overlaps another or lies outside the part", () => {
    expect(overlaps([{ start: 15, end: 19, category: "x" }], { start: 17, end: 25 })).toBe(true);
    expect(overlaps([{ start: 15, end: 19, category: "x" }], { start: 19, end: 25 })).toBe(false);
    expect(() => applyRemovals(part, [{ start: 0, end: 10, category: "x" }, { start: 5, end: 12, category: "x" }])).toThrow(RemovalError);
    expect(() => applyRemovals(part, [{ start: 50, end: 500, category: "x" }])).toThrow(RemovalError);
  });
});

describe("what a held part says", () => {
  it("names its kind and who holds it, and nothing else", () => {
    expect(descriptorOf("argument", "against")).toBe("argument:against");
    expect(descriptorOf("argument", null)).toBe("argument");
    expect(descriptorOf("reasoning")).toBe("reasoning");
    expect(heldWords("argument:against", ["Acme"])).toBe("[An argument against, held by Acme]");
    expect(heldWords("reasoning", ["Acme", "Borealis"])).toBe("[A paragraph of reasoning, held by Acme and Borealis]");
    expect(heldWords("subclaim", [])).toBe("[A subclaim with how it bears, held]");
    expect(heldWords("supplier", ["Acme"])).toBe("[A source's supplier and recorded interest, by name, held by Acme]");
    expect(kindWords("argument:against", 2)).toBe("2 arguments against");
    expect(kindWords("reading", 3)).toBe("3 sources' readings");
  });
});
