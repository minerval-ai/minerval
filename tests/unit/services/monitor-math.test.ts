/**
 * Production monitors (#334 S9), the pure aggregation: overturn-rate bins,
 * evidence-monotonicity classification, cascade R, snapshot trend, agent
 * rollups. The SQL half is covered by tests/db/monitors.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  cascadeSeries,
  classifyMonotonicity,
  mergeAgentRollups,
  snapshotTrend,
  summarizeOverturnBins,
  type MonotonicityRow,
} from "../../../src/services/monitor-math.js";

describe("summarizeOverturnBins", () => {
  it("bins 1..10, folds width_bucket's 11 into 10, and computes shares", () => {
    const r = summarizeOverturnBins([
      { bin: 1, n: 10, reversed: 5 },
      { bin: 5, n: 20, reversed: 10 },
      { bin: 6, n: 20, reversed: 8 },
      { bin: 9, n: 10, reversed: 1 },
      { bin: 11, n: 4, reversed: 0 },
    ]);
    expect(r.bins).toHaveLength(10);
    expect(r.bins[9]).toMatchObject({ bin: 10, lo: 0.9, hi: 1, n: 4, reversed: 0, share: 0 });
    expect(r.bins[4]!.share).toBeCloseTo(0.5);
    expect(r.assessed).toBe(64);
    expect(r.reversed).toBe(24);
    // confident = bins 1,2,9,10: 24 assessed, 6 reversed; uncertain = bins 5,6: 40 assessed, 18 reversed
    expect(r.confidentN).toBe(24);
    expect(r.confidentShare).toBeCloseTo(0.25);
    expect(r.uncertainN).toBe(40);
    expect(r.uncertainShare).toBeCloseTo(0.45);
    expect(r.discriminating).toBe(true);
  });

  it("gives no verdict below the minimum sample and a false when confident reverses as often", () => {
    expect(summarizeOverturnBins([{ bin: 9, n: 3, reversed: 0 }, { bin: 5, n: 3, reversed: 2 }]).discriminating).toBeNull();
    const flat = summarizeOverturnBins([
      { bin: 10, n: 20, reversed: 10 },
      { bin: 5, n: 20, reversed: 10 },
    ]);
    expect(flat.discriminating).toBe(false);
    expect(summarizeOverturnBins([]).assessed).toBe(0);
  });
});

describe("classifyMonotonicity", () => {
  const base = { claimId: "c", claimText: "t", reviewedAt: "2026-01-01T00:00:00Z", statusBefore: "supported", statusAfter: "supported" };
  const row = (id: string, type: string, before: number | null, after: number | null): MonotonicityRow => ({
    ...base,
    contributionId: id,
    contributionType: type,
    credenceBefore: before,
    credenceAfter: after,
    assessedAfterAt: after == null ? null : "2026-01-02T00:00:00Z",
  });

  it("flags a support that lowered credence and a challenge that raised it, within tolerance", () => {
    const r = classifyMonotonicity(
      [
        row("a", "support", 0.6, 0.4),
        row("b", "challenge", 0.6, 0.7),
        row("c", "support", 0.6, 0.58), // noise, inside tolerance
        row("d", "challenge", 0.6, 0.3),
        row("e", "support", 0.5, null), // not yet re-assessed
        row("f", "support", null, 0.7), // no prior credence: unchecked
      ],
      0.05
    );
    expect(r.accepted).toBe(6);
    expect(r.checked).toBe(4);
    expect(r.unassessed).toBe(1);
    expect(r.violations.map((v) => [v.contributionId, v.kind])).toEqual([
      ["a", "support_lowered"],
      ["b", "challenge_raised"],
    ]);
    expect(r.violations[0]!.delta).toBeCloseTo(-0.2);
    expect(r.correct).toEqual({ support: 1, challenge: 1 });
  });

  it("orders violations by magnitude", () => {
    const r = classifyMonotonicity([row("small", "support", 0.6, 0.5), row("big", "support", 0.9, 0.2)], 0);
    expect(r.violations.map((v) => v.contributionId)).toEqual(["big", "small"]);
  });
});

describe("cascadeSeries", () => {
  it("computes per-day and pooled R and the coalescing share", () => {
    const r = cascadeSeries(
      [
        { day: "2026-09-01T00:00:00.000Z", runs: 10, materialRuns: 4, materialChildren: 2 },
        { day: "2026-09-02T00:00:00.000Z", runs: 6, materialRuns: 2, materialChildren: 3 },
      ],
      [
        { day: "2026-09-01T00:00:00.000Z", enqueues: 8, coalesced: 2 },
        { day: "2026-09-03T00:00:00.000Z", enqueues: 4, coalesced: 4 },
      ]
    );
    expect(r.days.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(r.days[0]!.r).toBeCloseTo(0.5);
    expect(r.days[0]!.coalescedShare).toBeCloseTo(0.25);
    expect(r.days[1]!.r).toBeCloseTo(1.5);
    expect(r.days[2]).toMatchObject({ runs: 0, materialRuns: 0, r: null, enqueues: 4, coalesced: 4, coalescedShare: 1 });
    expect(r.materialRuns).toBe(6);
    expect(r.materialChildren).toBe(5);
    expect(r.r).toBeCloseTo(5 / 6);
    expect(r.supercritical).toBe(false);
    expect(r.coalescedShare).toBeCloseTo(0.5);
  });

  it("is null with nothing to divide by, and supercritical at R ≥ 1", () => {
    expect(cascadeSeries([], []).r).toBeNull();
    expect(cascadeSeries([], []).supercritical).toBeNull();
    expect(cascadeSeries([{ day: "2026-09-01", runs: 2, materialRuns: 2, materialChildren: 2 }], []).supercritical).toBe(true);
  });
});

describe("snapshotTrend", () => {
  it("sorts oldest-first, reports delta and a slope per hour", () => {
    const r = snapshotTrend([
      { periodKey: "c", stewardPending: 30, createdAt: "2026-09-01T02:00:00Z" },
      { periodKey: "a", stewardPending: 10, createdAt: "2026-09-01T00:00:00Z" },
      { periodKey: "b", stewardPending: 20, createdAt: "2026-09-01T01:00:00Z" },
    ]);
    expect(r.points.map((p) => p.periodKey)).toEqual(["a", "b", "c"]);
    expect(r.earliest).toBe(10);
    expect(r.latest).toBe(30);
    expect(r.delta).toBe(20);
    expect(r.slopePerHour).toBeCloseTo(10);
  });
  it("handles zero and one point", () => {
    expect(snapshotTrend([]).delta).toBeNull();
    const one = snapshotTrend([{ periodKey: null, stewardPending: 3, createdAt: "2026-09-01T00:00:00Z" }]);
    expect(one.delta).toBe(0);
    expect(one.slopePerHour).toBeNull();
  });
});

describe("mergeAgentRollups", () => {
  it("joins usage and runs per agent for both windows and orders by 7d cost", () => {
    const r = mergeAgentRollups({
      usage24h: [{ agent: "steward", calls: 5, costMicroUsd: 500 }],
      runs24h: [{ agent: "steward", runs: 4, errors: 1, running: 1 }],
      usage7d: [
        { agent: "steward", calls: 50, costMicroUsd: 5000 },
        { agent: "matcher", calls: 90, costMicroUsd: 9000 },
      ],
      runs7d: [{ agent: "audit", runs: 2, errors: 0, running: 0 }],
    });
    expect(r.map((a) => a.agent)).toEqual(["matcher", "steward", "audit"]);
    const steward = r[1]!;
    expect(steward.last24h).toMatchObject({ calls: 5, costMicroUsd: 500, runs: 4, errors: 1, running: 1 });
    expect(steward.last24h.errorRate).toBeCloseTo(1 / 3); // errors over finished runs
    expect(steward.last7d).toMatchObject({ calls: 50, runs: 0, errorRate: null });
    expect(r[2]!.last7d).toMatchObject({ runs: 2, errors: 0, errorRate: 0, calls: 0 });
  });
});
