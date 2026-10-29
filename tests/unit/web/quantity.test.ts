import { describe, it, expect } from "vitest";

// The quantity library on the web side (constitution §2, §10): one place
// that states any estimate in words and fits any value to an axis, whatever
// its unit and however wide its uncertainty.
import {
  describeEstimate, formatRange, makeScale, probAbove, valuesOf,
} from "../../../web/lib/quantity";
import type { QuantityEstimate, QuantityUnit } from "../../../web/lib/types";

const COUNT: QuantityUnit = { kind: "count", noun: "deaths", min: 0 };
const DIST: QuantityEstimate = {
  form: "distribution",
  quantiles: [
    { p: 0.05, v: 17e6 }, { p: 0.25, v: 26e6 }, { p: 0.5, v: 35e6 }, { p: 0.75, v: 50e6 }, { p: 0.95, v: 80e6 },
  ],
};

describe("describeEstimate", () => {
  it("states a distribution by its median and its interval", () => {
    const w = describeEstimate(DIST, COUNT);
    expect(w.lead).toBe("≈ 35 million");
    expect(w.words).toBe("most likely about 35 million; 90% interval 17 to 80 million");
  });

  it("keeps a source's own precision when asked to", () => {
    const stated: QuantityEstimate = { form: "interval", low: 24.7e6, high: 39.3e6 };
    expect(describeEstimate(stated, COUNT, 3).words).toBe("between 24.7 and 39.3 million");
  });

  it("states bounds, orders of magnitude and no figure for what they are", () => {
    expect(describeEstimate({ form: "bound", bound: { side: "above", value: 50e6 } }, COUNT).lead).toBe("≥ 50 million");
    expect(describeEstimate({ form: "magnitude", magnitude: 11 }, { kind: "count", noun: "stars" }).lead).toBe("~10¹¹");
    expect(describeEstimate({ form: "none", reason: "No figure would be honest." }, COUNT).words).toBe("No figure would be honest.");
  });

  it("states the share of probability that lies outside every value", () => {
    const year: QuantityEstimate = {
      form: "distribution",
      quantiles: [{ p: 0.05, v: 2041 }, { p: 0.5, v: 2063 }, { p: 0.95, v: 2100 }],
      outside: { share: 0.15, meaning: "it never happens" },
    };
    expect(describeEstimate(year, { kind: "year" }).words).toMatch(/, with a 15% chance that it never happens$/);
  });
});

describe("formatRange", () => {
  it("says a shared unit once, and puts rare rates' shorter wait first", () => {
    expect(formatRange(21e6, 70e6, COUNT)).toBe("21 to 70 million");
    expect(formatRange(1e-6, 4e-6, { kind: "rate", noun: "impact", per: "per year" })).toBe("once every 250,000 to 1 million years");
  });
});

describe("makeScale", () => {
  it("starts a count's axis at zero rather than cropping it", () => {
    const s = makeScale(COUNT, valuesOf(DIST));
    expect(s.kind).toBe("linear");
    expect(s.lo).toBe(0);
  });

  it("goes logarithmic across orders of magnitude, never for years or shares", () => {
    expect(makeScale(COUNT, [1e3, 1e7]).kind).toBe("log");
    expect(makeScale({ kind: "year" }, [1900, 2100]).kind).toBe("linear");
    expect(makeScale({ kind: "proportion", min: 0, max: 1 }, [0.001, 0.5]).kind).toBe("linear");
  });

  it("ticks a rare rate at round waiting times", () => {
    const s = makeScale({ kind: "rate", noun: "impact", per: "per year", min: 0 }, [1e-6, 4e-6]);
    for (const t of s.ticks.filter((t) => t.v > 0)) {
      const wait = 1 / t.v;
      expect(Number(wait.toPrecision(1))).toBeCloseTo(wait, -1);
    }
  });
});

describe("probAbove", () => {
  it("reads a claim's implied credence off the estimate, and reports tails as bounds", () => {
    expect(probAbove(DIST, 50e6)!.p).toBeCloseTo(0.25, 6);
    expect(probAbove(DIST, 100e6)).toEqual({ p: expect.closeTo(0.05, 6), tail: "below" });
  });
});
