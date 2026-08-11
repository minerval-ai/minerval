import { describe, it, expect } from "vitest";
import {
  classifyRow,
  partitionRows,
  horizonDays,
  summarizeAbstentions,
  RESOLVED_PREDICTIONS_SQL,
  type PredictionRow,
} from "../../../scripts/corpus/predictions-lib.js";

const RESOLVED = new Date("2026-06-01T00:00:00Z");

function row(over: Partial<PredictionRow> = {}): PredictionRow {
  return {
    id: "c1",
    claimType: "empirical_verifiable",
    resolutionOutcome: 1,
    resolvedAt: RESOLVED,
    resolvesAt: RESOLVED,
    baselineCredence: null,
    baselineAsOf: null,
    mergedOpposed: false,
    mergedInto: null,
    frozenCredence: 0.7,
    frozenAt: new Date("2026-01-01T00:00:00Z"),
    hasAnyAssessment: true,
    ...over,
  };
}

describe("horizonDays", () => {
  it("counts whole days and never goes negative", () => {
    expect(horizonDays(new Date("2026-01-01"), new Date("2026-01-31"))).toBe(30);
    expect(horizonDays(new Date("2026-02-01"), new Date("2026-01-01"))).toBe(0);
  });
});

describe("classifyRow", () => {
  it("produces a scorable forecast with horizon and baseline", () => {
    const out = classifyRow(row({ baselineCredence: 0.55, baselineAsOf: new Date("2026-01-01") }));
    expect("reason" in out).toBe(false);
    const f = out as Exclude<typeof out, { reason: unknown }>;
    expect(f.credence).toBe(0.7);
    expect(f.outcome).toBe(1);
    expect(f.baseline).toBe(0.55);
    expect(f.horizonDays).toBe(151);
    expect(f.claimType).toBe("empirical_verifiable");
  });

  it("abstains when the claim was never assessed", () => {
    const out = classifyRow(row({ frozenCredence: null, frozenAt: null, hasAnyAssessment: false }));
    expect(out).toEqual({ claimId: "c1", reason: "never_assessed" });
  });

  it("distinguishes an assessment that missed the cutoff from a withheld credence", () => {
    // Assessed, but nothing landed before the cutoff: the lateral found no row.
    expect(
      classifyRow(row({ frozenCredence: null, frozenAt: null, hasAnyAssessment: true }))
    ).toEqual({ claimId: "c1", reason: "assessed_after_cutoff" });

    // An in-time assessment WAS selected; it simply stated no credence (§7).
    expect(
      classifyRow(
        row({ frozenCredence: null, frozenAt: new Date("2026-01-01"), hasAnyAssessment: true })
      )
    ).toEqual({ claimId: "c1", reason: "credence_withheld" });
  });

  it("abstains on an opposed merge rather than scoring an inverted credence", () => {
    const out = classifyRow(row({ mergedOpposed: true, mergedInto: "survivor" }));
    expect(out).toEqual({ claimId: "c1", reason: "opposed_merge_unsupported" });
  });

  it("scores an opposed-flagged claim that was never actually merged", () => {
    // merged_opposed defaults false, but a stray true with no survivor must
    // not silently drop a scorable forecast.
    const out = classifyRow(row({ mergedOpposed: true, mergedInto: null }));
    expect("reason" in out).toBe(false);
  });

  it("rounds a partial outcome to the nearer pole", () => {
    expect((classifyRow(row({ resolutionOutcome: 0.6 })) as { outcome: 0 | 1 }).outcome).toBe(1);
    expect((classifyRow(row({ resolutionOutcome: 0.4 })) as { outcome: 0 | 1 }).outcome).toBe(0);
    expect((classifyRow(row({ resolutionOutcome: 0.5 })) as { outcome: 0 | 1 }).outcome).toBe(1);
  });

  it("keeps a zero credence scorable rather than treating it as absent", () => {
    const out = classifyRow(row({ frozenCredence: 0 }));
    expect("reason" in out).toBe(false);
    expect((out as { credence: number }).credence).toBe(0);
  });
});

describe("partitionRows", () => {
  it("splits scorable forecasts from abstentions and counts the reasons", () => {
    const { forecasts, abstentions } = partitionRows([
      row({ id: "a" }),
      row({ id: "b", frozenCredence: null, frozenAt: null, hasAnyAssessment: false }),
      row({ id: "c", frozenCredence: null, frozenAt: new Date("2026-01-01") }),
      row({ id: "d", mergedOpposed: true, mergedInto: "s" }),
    ]);
    expect(forecasts.map((f) => f.id)).toEqual(["a"]);
    expect(summarizeAbstentions(abstentions)).toEqual({
      never_assessed: 1,
      assessed_after_cutoff: 0,
      credence_withheld: 1,
      opposed_merge_unsupported: 1,
    });
  });
});

describe("RESOLVED_PREDICTIONS_SQL", () => {
  it("guards against leakage with LEAST of the scheduled and actual resolution", () => {
    expect(RESOLVED_PREDICTIONS_SQL).toContain("LEAST(c.resolves_at, c.resolved_at)");
    expect(RESOLVED_PREDICTIONS_SQL).toContain("assessed_at <=");
  });

  it("selects only predictions that actually resolved", () => {
    expect(RESOLVED_PREDICTIONS_SQL).toContain("c.resolution_criterion IS NOT NULL");
    expect(RESOLVED_PREDICTIONS_SQL).toContain("c.resolved_at IS NOT NULL");
    expect(RESOLVED_PREDICTIONS_SQL).toContain("c.resolution_outcome IS NOT NULL");
  });
});
