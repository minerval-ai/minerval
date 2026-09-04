import { describe, it, expect } from "vitest";
import {
  brier,
  calibrationCurve,
  expectedCalibrationError,
  frozenCredence,
  logScore,
  scoreCalibration,
} from "../../../scripts/corpus/prediction-score.js";

const d = (s: string) => new Date(s);

describe("frozenCredence", () => {
  const history = [
    { credence: null, assessedAt: d("2026-09-01") },
    { credence: 0.3, assessedAt: d("2026-09-10") },
    { credence: 0.6, assessedAt: d("2026-11-01") },
    { credence: 0.9, assessedAt: d("2027-02-01") },
  ];

  it("takes the last stated credence at or before the cutoff, never a later revision", () => {
    expect(frozenCredence(history, d("2026-12-31"))).toEqual({
      credence: 0.6,
      assessedAt: d("2026-11-01"),
    });
    expect(frozenCredence(history, d("2026-09-10"))!.credence).toBe(0.3);
  });

  it("is null when nothing was stated in time, and skips null credences", () => {
    expect(frozenCredence(history, d("2026-09-05"))).toBeNull();
    expect(frozenCredence([], d("2027-01-01"))).toBeNull();
  });
});

describe("proper scores", () => {
  it("brier rewards confidence in the right direction", () => {
    expect(brier(1, true)).toBe(0);
    expect(brier(0, true)).toBe(1);
    expect(brier(0.5, false)).toBe(0.25);
  });

  it("log score is finite at the extremes and higher for a better forecast", () => {
    expect(Number.isFinite(logScore(0, true))).toBe(true);
    expect(logScore(0.9, true)).toBeGreaterThan(logScore(0.6, true));
    expect(logScore(0.1, false)).toBeCloseTo(Math.log(0.9), 6);
  });
});

describe("calibration curve and ECE", () => {
  const items = [
    { credence: 0.1, outcome: false },
    { credence: 0.15, outcome: false },
    { credence: 0.12, outcome: true },
    { credence: 0.85, outcome: true },
    { credence: 0.89, outcome: true },
    { credence: 0.88, outcome: false },
  ];

  it("buckets by credence and reports realized frequency per bucket", () => {
    const curve = calibrationCurve(items, 10);
    expect(curve).toHaveLength(10);
    expect(curve[1]!.n).toBe(3);
    expect(curve[1]!.realized).toBeCloseTo(1 / 3, 10);
    expect(curve[8]!.n).toBe(3);
    expect(curve[8]!.realized).toBeCloseTo(2 / 3, 10);
    expect(curve[5]!.n).toBe(0);
    expect(curve[5]!.realized).toBeNull();
    // A credence of exactly 1.0 lands in the top bucket, not off the end.
    expect(calibrationCurve([{ credence: 1, outcome: true }], 10)[9]!.n).toBe(1);
  });

  it("ECE is zero for a perfectly calibrated set and null for an empty one", () => {
    expect(expectedCalibrationError([], 10)).toBeNull();
    const perfect = [
      { credence: 0.5, outcome: true },
      { credence: 0.5, outcome: false },
    ];
    expect(expectedCalibrationError(perfect, 10)).toBeCloseTo(0, 10);
    expect(expectedCalibrationError(items, 10)).toBeGreaterThan(0);
  });
});

describe("scoreCalibration", () => {
  it("reports Minerval alone, the comparative over the baselined subset, and per-domain slices", () => {
    const report = scoreCalibration([
      { id: "a", credence: 0.8, outcome: true, baseline: 0.6, domain: "economics" },
      { id: "b", credence: 0.2, outcome: false, baseline: 0.5, domain: "economics" },
      { id: "c", credence: 0.7, outcome: false, baseline: null, domain: "science" },
    ]);
    expect(report.minerval.n).toBe(3);
    expect(report.comparative!.minerval.n).toBe(2);
    expect(report.comparative!.baseline.n).toBe(2);
    // Minerval was sharper and right on both baselined questions.
    expect(report.comparative!.minerval.brier!).toBeLessThan(report.comparative!.baseline.brier!);
    expect(Object.keys(report.byDomain)).toEqual(["economics", "science"]);
    expect(report.byDomain.science!.brier).toBeCloseTo(0.49, 10);
    expect(report.baseRate).toBeCloseTo(1 / 3, 10);
  });

  it("handles an empty set without dividing by zero", () => {
    const report = scoreCalibration([]);
    expect(report.minerval).toEqual({ n: 0, brier: null, logScore: null, ece: null });
    expect(report.comparative).toBeNull();
    expect(report.baseRate).toBeNull();
  });
});
