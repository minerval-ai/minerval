import { describe, expect, it } from "vitest";
import { hasCut, MAX_CUT_CHARS, placePieces, quotedParts, quotePieces, substringsFrom } from "../../../src/services/quote-elision.js";

describe("quotePieces", () => {
  it("splits on every mark of a cut and drops the empty ends", () => {
    for (const mark of ["[...]", "[…]", "[ . . . ]", "(...)", "(…)", "…", "...", ". . ."]) {
      expect(quotePieces(`the board said ${mark} a spokesperson clarified`)).toEqual([
        "the board said",
        "a spokesperson clarified",
      ]);
    }
    // A cut at the start or end joins nothing: one piece, no cut.
    expect(quotePieces("... will not be working with Nvidia ...")).toEqual(["will not be working with Nvidia"]);
    expect(hasCut("... will not be working with Nvidia")).toBe(false);
    expect(hasCut("said in a statement. [...] A company spokesperson")).toBe(true);
    // A decimal or a single full stop is not a cut.
    expect(hasCut("rose 6.5 percent. Then it fell.")).toBe(false);
  });
});

describe("placePieces", () => {
  const text = "one two three. four five six. seven eight nine.";
  const find = (pieces: string[], maxCut?: number) =>
    placePieces(pieces, (p, from) => substringsFrom(text, p, from), maxCut);

  it("places each piece after the one before", () => {
    const placed = find(["one two", "seven eight"]);
    expect(placed).toEqual({ spans: [{ start: 0, end: 7 }, { start: 30, end: 41 }] });
    expect(quotedParts(text, (placed as { spans: Array<{ start: number; end: number }> }).spans)).toEqual([
      { text: "one two" },
      { text: "three. four five six.", omitted: true },
      { text: "seven eight" },
    ]);
  });

  it("names the first piece that is not where it should be", () => {
    expect(find(["seven eight", "one two"])).toEqual({ missing: 1 });
    expect(find(["ten", "one"])).toEqual({ missing: 0 });
    expect(find(["one", "five", "zero"])).toEqual({ missing: 2 });
  });

  it("refuses a cut that leaves out more than the limit, and tries a later placement of an earlier piece", () => {
    expect(find(["one two", "seven eight"], 10)).toEqual({ missing: 1 });
    const far = "alpha " + "x".repeat(MAX_CUT_CHARS + 10) + " alpha beta omega";
    expect(placePieces(["alpha", "omega"], (p, from) => substringsFrom(far, p, from))).toMatchObject({
      spans: [{ start: far.lastIndexOf("alpha") }, { start: far.indexOf("omega") }],
    });
  });
});
