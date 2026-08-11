import { describe, it, expect } from "vitest";
import {
  brier,
  logScore,
  calibrationCurve,
  expectedCalibrationError,
  compareToBaseline,
  scoreCalibration,
  scoreBySlice,
  horizonSlice,
  partitionScorable,
  formatCalibration,
  SUFFICIENT_N,
  type ResolvedForecast,
} from "../../../scripts/corpus/calibration-scoring.js";

function f(
  credence: number | null,
  outcome: 0 | 1,
  extra: Partial<ResolvedForecast> = {}
): ResolvedForecast {
  return { id: Math.random().toString(36).slice(2), credence, outcome, ...extra };
}

describe("brier", () => {
  it("is 0 for perfect confident forecasts and 1 for maximally wrong ones", () => {
    expect(brier([{ credence: 1, outcome: 1 }, { credence: 0, outcome: 0 }])).toBe(0);
    expect(brier([{ credence: 0, outcome: 1 }, { credence: 1, outcome: 0 }])).toBe(1);
  });

  it("is 0.25 for a coin-flip forecast regardless of outcome", () => {
    expect(brier([{ credence: 0.5, outcome: 1 }, { credence: 0.5, outcome: 0 }])).toBeCloseTo(0.25);
  });
});

describe("logScore", () => {
  it("is 0 for a perfect confident forecast", () => {
    expect(logScore([{ credence: 1, outcome: 1 }])).toBeCloseTo(0, 5);
  });

  it("is ln(2) for a coin flip", () => {
    expect(logScore([{ credence: 0.5, outcome: 1 }])).toBeCloseTo(Math.log(2), 6);
  });

  it("keeps a maximally-wrong forecast finite rather than infinite", () => {
    const s = logScore([{ credence: 0, outcome: 1 }]);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(10); // severe, as it should be
    expect(s).toBeLessThan(20);
  });
});

describe("partitionScorable", () => {
  it("counts null credences as excluded instead of dropping them silently", () => {
    const p = partitionScorable([f(0.6, 1), f(null, 0), f(null, 1)]);
    expect(p.scorable).toHaveLength(1);
    expect(p.nullCredence).toBe(2);
  });

  it("rejects out-of-range credences", () => {
    const p = partitionScorable([f(1.5, 1), f(-0.2, 0), f(0.5, 1)]);
    expect(p.scorable).toHaveLength(1);
    expect(p.outOfRange).toBe(2);
  });
});

describe("calibrationCurve", () => {
  it("puts a credence of exactly 1.0 in the top bin, not off the end", () => {
    const bins = calibrationCurve([{ credence: 1, outcome: 1 }], 10);
    expect(bins[9]!.n).toBe(1);
    expect(bins.reduce((s, b) => s + b.n, 0)).toBe(1);
  });

  it("reports realized frequency per bucket", () => {
    const bins = calibrationCurve(
      [
        { credence: 0.85, outcome: 1 },
        { credence: 0.82, outcome: 1 },
        { credence: 0.88, outcome: 0 },
        { credence: 0.15, outcome: 0 },
      ],
      10
    );
    const high = bins[8]!; // [0.8, 0.9)
    expect(high.n).toBe(3);
    expect(high.realizedFrequency).toBeCloseTo(2 / 3);
    const low = bins[1]!; // [0.1, 0.2)
    expect(low.n).toBe(1);
    expect(low.realizedFrequency).toBe(0);
  });
});

describe("expectedCalibrationError", () => {
  it("is 0 for a perfectly calibrated set", () => {
    // 10 forecasts at 0.5, exactly half of which come true.
    const forecasts = Array.from({ length: 10 }, (_, i) => ({
      credence: 0.5,
      outcome: (i % 2 === 0 ? 1 : 0) as 0 | 1,
    }));
    expect(expectedCalibrationError(calibrationCurve(forecasts))).toBeCloseTo(0);
  });

  it("grows with systematic overconfidence", () => {
    // Claims 90% but is right only half the time.
    const forecasts = Array.from({ length: 10 }, (_, i) => ({
      credence: 0.9,
      outcome: (i % 2 === 0 ? 1 : 0) as 0 | 1,
    }));
    expect(expectedCalibrationError(calibrationCurve(forecasts))).toBeCloseTo(0.4);
  });
});

describe("compareToBaseline", () => {
  it("returns null when no forecast carries a baseline", () => {
    expect(compareToBaseline([{ credence: 0.5, outcome: 1 }])).toBeNull();
  });

  it("scores positive skill when we beat the crowd", () => {
    const c = compareToBaseline([
      { credence: 0.9, outcome: 1, baseline: 0.6 },
      { credence: 0.1, outcome: 0, baseline: 0.4 },
    ])!;
    expect(c.ourBrier).toBeLessThan(c.baselineBrier);
    expect(c.skillScore).toBeGreaterThan(0);
  });

  it("credits a divergence only when we moved toward what happened", () => {
    const c = compareToBaseline([
      { credence: 0.9, outcome: 1, baseline: 0.5 }, // diverged up, came true → right
      { credence: 0.2, outcome: 1, baseline: 0.5 }, // diverged down, came true → wrong
    ])!;
    expect(c.divergence.n).toBe(2);
    expect(c.divergence.weWereRightShare).toBeCloseTo(0.5);
  });

  it("ignores divergences below the threshold", () => {
    const c = compareToBaseline([{ credence: 0.55, outcome: 1, baseline: 0.5 }], 0.1)!;
    expect(c.n).toBe(1);
    expect(c.divergence.n).toBe(0);
  });

  it("does not report infinite skill against a flawless baseline", () => {
    const c = compareToBaseline([{ credence: 0.8, outcome: 1, baseline: 1 }])!;
    expect(Number.isFinite(c.skillScore)).toBe(true);
    expect(c.skillScore).toBe(0);
  });
});

describe("scoreCalibration", () => {
  it("handles an empty set without dividing by zero", () => {
    const r = scoreCalibration([]);
    expect(r.n).toBe(0);
    expect(r.sufficient).toBe(false);
    expect(Number.isFinite(r.brier)).toBe(true);
  });

  it("carries excluded counts and the small-n flag", () => {
    const r = scoreCalibration([f(0.7, 1), f(null, 0)]);
    expect(r.n).toBe(1);
    expect(r.excluded.nullCredence).toBe(1);
    expect(r.sufficient).toBe(false);
  });

  it("flags sufficiency once enough forecasts resolve", () => {
    const many = Array.from({ length: SUFFICIENT_N }, (_, i) =>
      f(0.5, (i % 2 === 0 ? 1 : 0) as 0 | 1)
    );
    expect(scoreCalibration(many).sufficient).toBe(true);
  });

  it("decomposes Brier with a residual that is ~0 when forecasts sit on bin means", () => {
    // All forecasts at 0.5 and 0.9 exactly — no within-bin spread, so Murphy's
    // identity should close almost exactly.
    const forecasts = [
      f(0.5, 1), f(0.5, 0), f(0.5, 1), f(0.5, 0),
      f(0.9, 1), f(0.9, 1), f(0.9, 1), f(0.9, 0),
    ];
    const r = scoreCalibration(forecasts);
    expect(Math.abs(r.decomposition.residual)).toBeLessThan(1e-9);
    const rebuilt =
      r.decomposition.reliability - r.decomposition.resolution + r.decomposition.uncertainty;
    expect(rebuilt).toBeCloseTo(r.brier, 9);
  });

  it("rewards discrimination: a sharp correct forecaster beats climatology", () => {
    const forecasts = [
      f(0.95, 1), f(0.93, 1), f(0.05, 0), f(0.07, 0),
    ];
    const r = scoreCalibration(forecasts);
    expect(r.skillVsClimatology).toBeGreaterThan(0.8);
    expect(r.sharpness).toBeGreaterThan(0.4);
  });

  it("gives no skill credit when every outcome is identical", () => {
    const r = scoreCalibration([f(0.8, 1), f(0.9, 1)]);
    expect(r.baseRate).toBe(1);
    expect(r.skillVsClimatology).toBe(0); // climatology is already perfect
  });
});

describe("scoreBySlice", () => {
  it("splits by horizon and measures each slice's departure from pooled", () => {
    const forecasts = [
      // short horizon: well calibrated
      f(0.5, 1, { horizonDays: 10 }),
      f(0.5, 0, { horizonDays: 20 }),
      // long horizon: badly overconfident
      f(0.95, 0, { horizonDays: 500 }),
      f(0.95, 0, { horizonDays: 600 }),
    ];
    const { pooled, slices } = scoreBySlice(forecasts, horizonSlice);
    expect(pooled.n).toBe(4);
    const short = slices.find((s) => s.slice === "<=30d")!;
    const long = slices.find((s) => s.slice === ">365d")!;
    expect(short.result.ece).toBeCloseTo(0);
    expect(long.result.ece).toBeCloseTo(0.95);
    // The singularity hunt has to name WHICH slice is anomalous. Signed,
    // against the complement: long-horizon is much worse calibrated than the
    // rest (+), short-horizon much better (−). A |slice − pooled| distance
    // would tie these two at 0.475 apiece and identify nothing.
    expect(long.eceVsComplement).toBeCloseTo(0.95);
    expect(short.eceVsComplement).toBeCloseTo(-0.95);
    expect(long.eceVsComplement).toBeGreaterThan(short.eceVsComplement);
    expect(long.complementN).toBe(2);
  });

  it("skips forecasts the slicer cannot place", () => {
    const { slices } = scoreBySlice([f(0.5, 1), f(0.5, 0, { horizonDays: 5 })], horizonSlice);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.result.n).toBe(1);
  });
});

describe("formatCalibration", () => {
  it("says so when there is nothing scorable", () => {
    expect(formatCalibration(scoreCalibration([f(null, 1)]))).toContain("no scorable forecasts");
  });

  it("marks small samples as descriptive only", () => {
    expect(formatCalibration(scoreCalibration([f(0.6, 1)]))).toContain("descriptive only");
  });
});
