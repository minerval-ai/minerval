import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  bandStat,
  compareBand,
  compareScorecards,
  formatSide,
  formatVerdict,
  HEADLINE_METRICS,
} from "../../../scripts/corpus/band.js";
import type { Scorecard } from "../../../scripts/corpus/score.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(
  here,
  "../../../corpus/scorecards/blackholes/2026-08-09T15-47-32-753Z.json"
);

describe("bandStat", () => {
  it("has no spread below two samples", () => {
    expect(bandStat([])).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
    expect(bandStat([0.7])).toEqual({ n: 1, mean: 0.7, sd: null, min: 0.7, max: 0.7 });
  });

  it("computes mean, sample sd and range, ignoring nulls", () => {
    const s = bandStat([2, 4, null, 6, undefined]);
    expect(s.n).toBe(3);
    expect(s.mean).toBe(4);
    expect(s.sd).toBeCloseTo(2, 10);
    expect(s.min).toBe(2);
    expect(s.max).toBe(6);
  });
});

describe("compareBand", () => {
  it("gives no verdict when either side is a single sample", () => {
    const r = compareBand("m", [0.6], [0.9]);
    expect(r.verdict).toBe("single-sample");
    expect(r.delta).toBeCloseTo(0.3, 10);
    expect(r.band).toBeNull();
  });

  it("is n/a when a side has no value at all (e.g. unjudged)", () => {
    expect(compareBand("m", [null, undefined], [0.5, 0.6]).verdict).toBe("n/a");
  });

  it("calls a delta real only beyond the combined spread", () => {
    // A: 0.60, 0.62, 0.64 (sd 0.02); B: 0.70, 0.72, 0.74 (sd 0.02) → band 0.04, Δ 0.10
    const real = compareBand("m", [0.6, 0.62, 0.64], [0.7, 0.72, 0.74]);
    expect(real.verdict).toBe("clears-band");
    expect(real.oneSided).toBe(false);
    expect(real.band).toBeCloseTo(0.04, 10);
    // Same means, wide spread → noise.
    const noise = compareBand("m", [0.5, 0.7, 0.6], [0.6, 0.8, 0.7]);
    expect(noise.verdict).toBe("within-band");
  });

  it("falls back to a one-sided band when only one side has repeats", () => {
    const r = compareBand("m", [0.6, 0.62, 0.64], [0.9]);
    expect(r.verdict).toBe("clears-band");
    expect(r.oneSided).toBe(true);
    expect(formatVerdict(r)).toMatch(/one-sided/);
    const within = compareBand("m", [0.6, 0.62, 0.64], [0.61]);
    expect(within.verdict).toBe("within-band");
  });
});

describe("compareScorecards over the committed baseline", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf-8")) as Scorecard;

  it("reads every headline metric off a real scorecard", () => {
    for (const m of HEADLINE_METRICS) {
      const v = m.get(baseline);
      expect(v === null || typeof v === "number").toBe(true);
    }
    expect(HEADLINE_METRICS.find((m) => m.label.includes("claim-bar"))!.get(baseline)).toBe(0.69);
  });

  it("compares a baseline against itself as single samples with zero delta", () => {
    const rows = compareScorecards([baseline], [baseline]);
    const bar = rows.find((r) => r.label.includes("claim-bar"))!;
    expect(bar.verdict).toBe("single-sample");
    expect(bar.delta).toBe(0);
    expect(formatSide(bar.a)).toBe("0.69");
  });

  it("gets spread once a side has repeats", () => {
    const shifted = structuredClone(baseline);
    shifted.judged!.claimBarPassRate = 0.75;
    const rows = compareScorecards([baseline, shifted], [baseline]);
    const bar = rows.find((r) => r.label.includes("claim-bar"))!;
    expect(bar.a.n).toBe(2);
    expect(bar.a.sd).toBeGreaterThan(0);
    expect(formatSide(bar.a)).toMatch(/±/);
    expect(bar.oneSided).toBe(true);
  });
});
