import { describe, it, expect } from "vitest";
import {
  analyzeCascade,
  cascadeHeadline,
  drainShape,
  renderCascade,
  type CascadeInput,
} from "../../../scripts/corpus/cascade-lib.js";

const t = (s: number) => new Date(Date.UTC(2026, 8, 18, 12, 0, s)).toISOString();

/**
 * A three-generation lineage on a chain of claims P (root) → Q → R, plus a
 * sibling S notified but not materially changed, and a claim X onboarded
 * independently:
 *
 *   run1 (P, structure_and_assess, first assessment) notifies Q and S
 *   run2 (Q, subclaim_change from run1): material change → notifies R
 *   run3 (S, subclaim_change from run1): minor change
 *   run4 (R, subclaim_change from run2): material change, nothing downstream
 *   run5 (X, structure_and_assess, first) — a second root, no propagation
 */
function fixture(): CascadeInput {
  return {
    runs: [
      { id: "run1", claimId: "P", startedAt: t(10), finishedAt: t(12), outcome: "ok" },
      { id: "run2", claimId: "Q", startedAt: t(20), finishedAt: t(22), outcome: "ok" },
      { id: "run3", claimId: "S", startedAt: t(24), finishedAt: t(26), outcome: "ok" },
      { id: "run4", claimId: "R", startedAt: t(30), finishedAt: t(32), outcome: "ok" },
      { id: "run5", claimId: "X", startedAt: t(40), finishedAt: t(42), outcome: "ok" },
    ],
    events: [
      { id: "e1", claimId: "P", trigger: "structure_and_assess", sourceRunId: null, sourceAgent: null, coalesced: false, createdAt: t(5) },
      { id: "e2", claimId: "Q", trigger: "subclaim_change", sourceRunId: "run1", sourceAgent: "steward", coalesced: false, createdAt: t(11) },
      { id: "e3", claimId: "S", trigger: "subclaim_change", sourceRunId: "run1", sourceAgent: "steward", coalesced: false, createdAt: t(11) },
      // A second notification to S while it is still pending: coalesced.
      { id: "e4", claimId: "S", trigger: "subclaim_change", sourceRunId: "run1", sourceAgent: "steward", coalesced: true, createdAt: t(11.5) },
      { id: "e5", claimId: "R", trigger: "subclaim_change", sourceRunId: "run2", sourceAgent: "steward", coalesced: false, createdAt: t(21) },
      { id: "e6", claimId: "X", trigger: "structure_and_assess", sourceRunId: null, sourceAgent: null, coalesced: false, createdAt: t(35) },
    ],
    assessments: [
      // Prior verdicts on Q, S, R (before the window's runs).
      { claimId: "Q", status: "supported", credence: 0.7, assessedAt: t(1), trigger: "structure_and_assess" },
      { claimId: "S", status: "supported", credence: 0.6, assessedAt: t(1), trigger: "structure_and_assess" },
      { claimId: "R", status: "contested", credence: 0.5, assessedAt: t(1), trigger: "structure_and_assess" },
      { claimId: "P", status: "supported", credence: 0.8, assessedAt: t(11), trigger: "structure_and_assess" },
      { claimId: "Q", status: "contested", credence: 0.45, assessedAt: t(21), trigger: "subclaim_change" },
      { claimId: "S", status: "supported", credence: 0.63, assessedAt: t(25), trigger: "subclaim_change" },
      { claimId: "R", status: "unsupported", credence: 0.3, assessedAt: t(31), trigger: "subclaim_change" },
      { claimId: "X", status: "verified", credence: 0.95, assessedAt: t(41), trigger: "structure_and_assess" },
    ],
  };
}

describe("analyzeCascade", () => {
  it("reconstructs parents, generations and change kinds", () => {
    const r = analyzeCascade(fixture());
    const by = new Map(r.runs.map((n) => [n.id, n]));
    expect(by.get("run1")!.parentId).toBeNull();
    expect(by.get("run1")!.generation).toBe(0);
    expect(by.get("run1")!.change).toBe("first");
    expect(by.get("run2")!.parentId).toBe("run1");
    expect(by.get("run2")!.generation).toBe(1);
    expect(by.get("run2")!.change).toBe("material");
    expect(by.get("run3")!.change).toBe("minor");
    expect(by.get("run4")!.parentId).toBe("run2");
    expect(by.get("run4")!.generation).toBe(2);
    expect(by.get("run4")!.rootId).toBe("run1");
    expect(by.get("run5")!.generation).toBe(0);
    expect(by.get("run5")!.change).toBe("first");
    expect(by.get("run1")!.notified).toBe(3);
    expect(by.get("run1")!.notifiedCoalesced).toBe(1);
  });

  it("computes R as material children per changed parent", () => {
    const r = analyzeCascade(fixture());
    // Changed parents: run1 (first), run2 (material), run4 (material), run5 (first) = 4.
    // Material children: run2 (of run1), run4 (of run2) = 2.
    expect(r.changedParents).toBe(4);
    expect(r.materialChildren).toBe(2);
    expect(r.R).toBe(0.5);
    // Over material reassessments only: run2 → run4 (1), run4 → none: 1/2.
    expect(r.rReassessment).toBe(0.5);
    expect(r.reading).toMatch(/cascades die out/);
  });

  it("tabulates per generation: notified, ran, materially changed", () => {
    const r = analyzeCascade(fixture());
    const g0 = r.perGeneration.find((g) => g.generation === 0)!;
    expect(g0.runs).toBe(2);
    expect(g0.firstAssessed).toBe(2);
    expect(g0.notified).toBe(3);
    expect(g0.coalesced).toBe(1);
    expect(g0.ran).toBe(3); // e2 → run2, e3 and e4 → run3
    expect(g0.ranMaterial).toBe(1); // only run2
    expect(g0.R).toBe(0.5); // run2 material / (run1, run5 changed)
    const g1 = r.perGeneration.find((g) => g.generation === 1)!;
    expect(g1.runs).toBe(2);
    expect(g1.materiallyChanged).toBe(1);
    expect(g1.minor).toBe(1);
    expect(g1.R).toBe(1); // run4 / run2
  });

  it("measures coalescing, cascade shape and roots by trigger", () => {
    const r = analyzeCascade(fixture());
    expect(r.coalescing).toEqual({ events: 6, coalesced: 1, share: 0.167 });
    expect(r.cascades.roots).toBe(2);
    expect(r.cascades.propagating).toBe(1);
    expect(r.cascades.maxSize).toBe(4);
    expect(r.cascades.maxDepth).toBe(2);
    expect(r.cascades.sizeHistogram).toEqual({ 1: 1, 4: 1 });
    expect(r.rootsByTrigger).toEqual({ structure_and_assess: 2 });
    expect(r.unattributedRuns).toBe(0);
  });

  it("counts oscillations on a claim's history", () => {
    const input = fixture();
    input.assessments.push(
      { claimId: "Q", status: "supported", credence: 0.7, assessedAt: t(50), trigger: "staleness_check" },
      { claimId: "Q", status: "contested", credence: 0.45, assessedAt: t(60), trigger: "staleness_check" }
    );
    const r = analyzeCascade(input);
    // supported → contested → supported → contested: two A→B→A windows.
    expect(r.oscillations.status).toBe(2);
    expect(r.oscillations.credence).toBe(2);
    expect(r.oscillations.claims).toEqual(["Q"]);
    expect(r.reading).toMatch(/oscillation/);
  });

  it("treats a run without slot events as an unattributed root", () => {
    const input = fixture();
    input.events = input.events.filter((e) => e.id !== "e5");
    const r = analyzeCascade(input);
    const run4 = r.runs.find((n) => n.id === "run4")!;
    expect(run4.parentId).toBeNull();
    expect(run4.unattributed).toBe(true);
    expect(r.unattributedRuns).toBe(1);
    expect(r.rootsByTrigger["(unattributed)"]).toBe(1);
    expect(r.reading).toMatch(/telemetry gap/);
  });

  it("honours the material threshold", () => {
    const loose = analyzeCascade(fixture(), { materialCredenceDelta: 0.02 });
    // S's 0.60 → 0.63 now counts.
    expect(loose.runs.find((n) => n.id === "run3")!.change).toBe("material");
    expect(loose.materialChildren).toBe(3);
  });

  it("is empty-safe", () => {
    const r = analyzeCascade({ runs: [], events: [], assessments: [] });
    expect(r.R).toBeNull();
    expect(r.reading).toMatch(/No Steward runs/);
    expect(r.drain.source).toBe("none");
    expect(renderCascade(r)).toContain("Cascade stability");
  });
});

describe("drainShape", () => {
  it("prefers sampled depth and reads a monotone drain", () => {
    const input: CascadeInput = {
      runs: [],
      events: [],
      assessments: [],
      depthSamples: [
        { at: t(0), stewardPending: 2 },
        { at: t(1), stewardPending: 5 },
        { at: t(2), stewardPending: 3 },
        { at: t(3), stewardPending: 0 },
      ],
    };
    const d = drainShape(input, [], []);
    expect(d.source).toBe("queue_depth_snapshots");
    expect(d.peak).toBe(5);
    expect(d.final).toBe(0);
    expect(d.risesAfterPeak).toBe(0);
    expect(d.monotoneDrain).toBe(true);
  });

  it("reconstructs depth from enqueues and run starts, flagging re-growth", () => {
    const input = fixture();
    const r = analyzeCascade(input);
    expect(r.drain.source).toBe("reconstructed");
    // e1 (+1) run1 (−1) e2,e3 (+2) run2 (−1) run3 (−1) e5 (+1)… peak 2, then
    // e5 after run3 and e6 after run4: the lane refills twice after the peak.
    expect(r.drain.peak).toBe(2);
    expect(r.drain.final).toBe(0);
    expect(r.drain.risesAfterPeak).toBe(2);
    expect(r.drain.monotoneDrain).toBe(false);
    expect(r.reading).toMatch(/reconstructed from the telemetry, approximate/);
  });
});

describe("cascadeHeadline", () => {
  it("carries the scorecard-sized numbers", () => {
    const h = cascadeHeadline(analyzeCascade(fixture()));
    expect(h.R).toBe(0.5);
    expect(h.oscillations).toBe(0);
    expect(h.roots).toBe(2);
    expect(h.maxDepth).toBe(2);
    expect(h.drainSource).toBe("reconstructed");
    expect(h.runs).toBe(5);
  });
});
