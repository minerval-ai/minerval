import { describe, it, expect } from "vitest";

/**
 * The attempt record's shaping (docs/mathematics.md §7.10), pure: the
 * outcome buckets from status and outcome, the medians, the variant table,
 * the calibration series with its pass rate and cost per pass, the split of
 * house solves into novel proofs and rediscoveries, the withheld outcome
 * on a bounty-bearing claim, and live attempts kept out of the record.
 */
import {
  medianOwls,
  recordOutcome,
  shapeAttemptStats,
  type AttemptStatRow,
} from "../../../src/services/attempt-stats-service.js";

const OWL = 1_000_000;

function row(over: Partial<AttemptStatRow> = {}): AttemptStatRow {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    claim_id: "c1",
    claim_text: "Claim one",
    grant_id: "g1",
    variant: "max",
    status: "completed",
    outcome: "negative",
    is_calibration: false,
    spent_micro_usd: 10 * OWL,
    finished_at: "2026-09-01T00:00:00.000Z",
    published_at: "2026-09-02T00:00:00.000Z",
    withheld: false,
    settled_before: false,
    ...over,
  };
}

describe("recordOutcome", () => {
  it("maps status and outcome onto the record's buckets", () => {
    expect(recordOutcome({ status: "completed", outcome: "proof", withheld: false })).toBe("proved");
    expect(recordOutcome({ status: "completed", outcome: "disproof", withheld: false })).toBe("disproved");
    expect(recordOutcome({ status: "completed", outcome: "partial", withheld: false })).toBe("lead");
    expect(recordOutcome({ status: "completed", outcome: "reduction", withheld: false })).toBe("lead");
    expect(recordOutcome({ status: "completed", outcome: "negative", withheld: false })).toBe("no_result");
    expect(recordOutcome({ status: "completed", outcome: "none", withheld: false })).toBe("no_result");
    expect(recordOutcome({ status: "completed", outcome: null, withheld: false })).toBe("no_result");
    expect(recordOutcome({ status: "refused", outcome: null, withheld: false })).toBe("refused");
    expect(recordOutcome({ status: "cancelled", outcome: null, withheld: false })).toBe("cancelled");
    for (const status of ["failed", "budget", "orphaned", "stale_formalization"]) {
      expect(recordOutcome({ status, outcome: null, withheld: false })).toBe("error");
    }
    // An unpublished result on a bounty-bearing claim shows no outcome at all.
    expect(recordOutcome({ status: "completed", outcome: "proof", withheld: true })).toBe("withheld");
  });
});

describe("medianOwls", () => {
  it("is null for nothing, the middle value for odd counts, and the mean of the two middles for even", () => {
    expect(medianOwls([])).toBeNull();
    expect(medianOwls([3 * OWL])).toBe(3);
    expect(medianOwls([9 * OWL, 1 * OWL, 5 * OWL])).toBe(5);
    expect(medianOwls([1 * OWL, 2 * OWL, 3 * OWL, 10 * OWL])).toBe(2.5);
  });
});

describe("shapeAttemptStats", () => {
  it("counts, sums, and takes medians by outcome and by variant, keeping live attempts out of the record", () => {
    const rows = [
      row({ outcome: "proof", spent_micro_usd: 40 * OWL, variant: "max" }),
      row({ outcome: "negative", spent_micro_usd: 20 * OWL, variant: "max" }),
      row({ outcome: "partial", spent_micro_usd: 30 * OWL, variant: "standard" }),
      row({ status: "refused", outcome: null, spent_micro_usd: 1 * OWL, variant: "standard" }),
      row({ status: "running", outcome: null, spent_micro_usd: 5 * OWL, finished_at: null, published_at: null }),
    ];
    const stats = shapeAttemptStats(rows, { grantId: "g1", now: new Date("2026-09-04T00:00:00Z") });
    expect(stats.grant_id).toBe("g1");
    expect(stats.generated_at).toBe("2026-09-04T00:00:00.000Z");
    expect(stats.totals).toEqual({ attempts: 4, live: 1, owls_spent: 91, median_cost_owls: 25 });
    expect(stats.by_outcome).toEqual([
      { outcome: "proved", count: 1, owls_spent: 40, median_cost_owls: 40 },
      { outcome: "lead", count: 1, owls_spent: 30, median_cost_owls: 30 },
      { outcome: "no_result", count: 1, owls_spent: 20, median_cost_owls: 20 },
      { outcome: "refused", count: 1, owls_spent: 1, median_cost_owls: 1 },
    ]);
    expect(stats.by_variant).toEqual([
      { variant: "max", count: 2, settled: 1, owls_spent: 60, median_cost_owls: 30 },
      { variant: "standard", count: 2, settled: 0, owls_spent: 31, median_cost_owls: 15.5 },
    ]);
    // No stated probability is stored, so the deciles are absent.
    expect(stats.calibration).toBeNull();
  });

  it("builds the calibration series per settled problem with the pass rate and the cost per pass", () => {
    const rows = [
      row({ claim_id: "erdos-2", claim_text: "Erdős problem 2", is_calibration: true, outcome: "disproof", spent_micro_usd: 30 * OWL, finished_at: "2026-08-01T00:00:00.000Z" }),
      row({ claim_id: "erdos-2", claim_text: "Erdős problem 2", is_calibration: true, outcome: "negative", spent_micro_usd: 10 * OWL, finished_at: "2026-08-02T00:00:00.000Z" }),
      row({ claim_id: "lemma", claim_text: "A Mathlib lemma", is_calibration: true, outcome: "proof", spent_micro_usd: 2 * OWL, finished_at: "2026-08-03T00:00:00.000Z" }),
      row({ claim_id: "open", claim_text: "An open problem", outcome: "negative", spent_micro_usd: 50 * OWL }),
    ];
    const stats = shapeAttemptStats(rows);
    expect(stats.calibration_series).toEqual({
      attempts: 3,
      passes: 2,
      pass_rate: 0.667,
      owls_spent: 42,
      cost_per_pass_owls: 21,
      problems: [
        {
          claim_id: "lemma",
          claim_text: "A Mathlib lemma",
          attempts: 1,
          passes: 1,
          pass_rate: 1,
          owls_spent: 2,
          cost_per_pass_owls: 2,
          last_finished_at: "2026-08-03T00:00:00.000Z",
        },
        {
          claim_id: "erdos-2",
          claim_text: "Erdős problem 2",
          attempts: 2,
          passes: 1,
          pass_rate: 0.5,
          owls_spent: 40,
          cost_per_pass_owls: 40,
          last_finished_at: "2026-08-02T00:00:00.000Z",
        },
      ],
    });
    // A calibration solve is a rediscovery by definition, never a novel proof.
    expect(stats.novel_proofs.count).toBe(0);
    expect(stats.rediscoveries.count).toBe(2);
  });

  it("lists novel proofs apart from rediscoveries and never lists a withheld result", () => {
    const rows = [
      row({ id: "novel-1", claim_id: "c-open", claim_text: "Open claim", outcome: "proof", spent_micro_usd: 60 * OWL, finished_at: "2026-08-10T00:00:00.000Z" }),
      row({ id: "redis-1", claim_id: "c-known", claim_text: "Known claim", outcome: "disproof", settled_before: true, spent_micro_usd: 20 * OWL, finished_at: "2026-08-11T00:00:00.000Z" }),
      row({ id: "held-1", claim_id: "c-prize", claim_text: "Prized claim", outcome: "proof", withheld: true, published_at: null, spent_micro_usd: 70 * OWL }),
      row({ id: "lead-1", claim_id: "c-open", claim_text: "Open claim", outcome: "partial" }),
    ];
    const stats = shapeAttemptStats(rows);
    expect(stats.novel_proofs).toEqual({
      count: 1,
      items: [
        {
          attempt_id: "novel-1",
          claim_id: "c-open",
          claim_text: "Open claim",
          outcome: "proof",
          variant: "max",
          finished_at: "2026-08-10T00:00:00.000Z",
          owls_spent: 60,
        },
      ],
    });
    expect(stats.rediscoveries.count).toBe(1);
    expect(stats.rediscoveries.items[0]!.attempt_id).toBe("redis-1");
    // The withheld attempt is counted and its spend is on the record, but it
    // appears under no outcome and in no list.
    expect(stats.totals.attempts).toBe(4);
    expect(stats.by_outcome.find((o) => o.outcome === "withheld")).toEqual({
      outcome: "withheld",
      count: 1,
      owls_spent: 70,
      median_cost_owls: 70,
    });
    expect(stats.by_outcome.find((o) => o.outcome === "proved")!.count).toBe(1);
  });

  it("is empty and well-formed with no attempts", () => {
    const stats = shapeAttemptStats([]);
    expect(stats.totals).toEqual({ attempts: 0, live: 0, owls_spent: 0, median_cost_owls: null });
    expect(stats.by_outcome).toEqual([]);
    expect(stats.by_variant).toEqual([]);
    expect(stats.calibration_series).toEqual({
      attempts: 0,
      passes: 0,
      pass_rate: null,
      owls_spent: 0,
      cost_per_pass_owls: null,
      problems: [],
    });
    expect(stats.novel_proofs).toEqual({ count: 0, items: [] });
    expect(stats.rediscoveries).toEqual({ count: 0, items: [] });
  });
});
