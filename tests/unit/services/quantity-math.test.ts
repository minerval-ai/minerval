import { describe, it, expect } from "vitest";
import { credenceGap, impliedProbability } from "../../../src/services/quantity-math.js";

// What an estimate implies about a claim on one side of a figure (§21).

describe("impliedProbability", () => {
  const dist = { form: "distribution" as const, quantiles: [{ p: 0.05, v: 10 }, { p: 0.5, v: 30 }, { p: 0.95, v: 100 }] };

  it("interpolates between quantiles, either side", () => {
    expect(impliedProbability(dist, "above", 30)).toEqual({ p: 0.5, bound: null });
    const above65 = impliedProbability(dist, "above", 65)!;
    expect(above65.p).toBeCloseTo(1 - (0.5 + (35 / 70) * 0.45), 6);
    expect(impliedProbability(dist, "below", 65)!.p).toBeCloseTo(1 - above65.p, 6);
  });

  it("reports only a bound beyond the outermost quantiles", () => {
    expect(impliedProbability(dist, "above", 200)).toEqual({ p: expect.closeTo(0.05, 6), bound: "at_most" });
    expect(impliedProbability(dist, "above", 1)).toEqual({ p: expect.closeTo(0.95, 6), bound: "at_least" });
  });

  it("reads a 90% interval as its tail quantiles, and counts the share outside every value against the claim", () => {
    const interval = { form: "interval" as const, low: 10, high: 100, level: 0.9, central: 30 };
    expect(impliedProbability(interval, "above", 30)!.p).toBeCloseTo(0.5, 6);
    const withOutside = { ...interval, outside: { share: 0.2, meaning: "the event does not happen" } };
    expect(impliedProbability(withOutside, "above", 30)!.p).toBeCloseTo(0.4, 6);
  });

  it("implies nothing for a point, a bound, an order of magnitude, or no figure", () => {
    expect(impliedProbability({ form: "point", central: 5 }, "above", 4)).toBeNull();
    expect(impliedProbability({ form: "bound", bound: { side: "above", value: 3 } }, "above", 4)).toBeNull();
    expect(impliedProbability({ form: "magnitude", magnitude: 6 }, "above", 4)).toBeNull();
    expect(impliedProbability({ form: "none", reason: "undefined" }, "above", 4)).toBeNull();
  });
});

describe("credenceGap", () => {
  it("measures the distance, honouring a bound", () => {
    expect(credenceGap(0.9, { p: 0.5, bound: null })).toBeCloseTo(0.4, 6);
    expect(credenceGap(0.03, { p: 0.05, bound: "at_most" })).toBe(0);
    expect(credenceGap(0.2, { p: 0.05, bound: "at_most" })).toBeCloseTo(0.15, 6);
    expect(credenceGap(0.99, { p: 0.95, bound: "at_least" })).toBe(0);
  });
});
