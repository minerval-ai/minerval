/**
 * The cascade and history loaders (#334 S3, from #295) against a real
 * schema: a tiny synthetic lineage seeded into enqueue_events, agent_runs,
 * assessments, contributions and contribution_reviews, read back through
 * loadCascadeInput / loadHistoryInput and analysed. This is the join
 * contract the pure libraries assume (column names, the is_current unique
 * index, the review lateral), which the mocked suite cannot see.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { TEST_DATABASE_URL } from "./urls.js";
import { seedClaim, seedUser } from "./helpers.js";
import { loadCascadeInput, loadHistoryInput } from "../../scripts/corpus/cascade-load.js";
import { analyzeCascade } from "../../scripts/corpus/cascade-lib.js";
import { analyzeHistory } from "../../scripts/corpus/history-lib.js";

const T0 = Date.UTC(2030, 0, 1, 0, 0, 0); // far from any other test's rows
const at = (s: number) => new Date(T0 + s * 1000);

async function seedRun(claimId: string, start: number, end: number): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO agent_runs (agent, claim_id, started_at, finished_at, outcome)
     VALUES ('steward', $1, $2, $3, 'ok') RETURNING id`,
    [claimId, at(start), at(end)]
  );
  return rows[0]!.id;
}

async function seedEvent(input: { claimId: string; trigger: string; sourceRunId: string | null; coalesced: boolean; t: number }): Promise<void> {
  await rawQuery(
    `INSERT INTO enqueue_events (queue, trigger, claim_id, source_agent, source_run_id, coalesced, created_at)
     VALUES ('steward', $1, $2, $3, $4, $5, $6)`,
    [input.trigger, input.claimId, input.sourceRunId ? "steward" : null, input.sourceRunId, input.coalesced, at(input.t)]
  );
}

async function seedAssessment(input: { claimId: string; status: string; credence: number | null; t: number; trigger: string; current: boolean }): Promise<void> {
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace, is_current, trigger, assessed_at)
     VALUES ($1, $2, 0.8, $3, 'db-test', $4, $5, $6)`,
    [input.claimId, input.status, input.credence, input.current, input.trigger, at(input.t)]
  );
}

describe("cascade + history loaders (S3)", () => {
  let P: string;
  let Q: string;
  let R: string;
  let contributionId: string;
  const since = at(-100).toISOString();

  beforeAll(async () => {
    P = await seedClaim("cascade-P");
    Q = await seedClaim("cascade-Q");
    R = await seedClaim("cascade-R");
    // Prior verdicts.
    await seedAssessment({ claimId: Q, status: "supported", credence: 0.7, t: -50, trigger: "structure_and_assess", current: false });
    await seedAssessment({ claimId: R, status: "contested", credence: 0.5, t: -50, trigger: "structure_and_assess", current: false });
    // run1: P onboarded (root), first assessment, notifies Q twice (the second coalesces).
    await seedEvent({ claimId: P, trigger: "structure_and_assess", sourceRunId: null, coalesced: false, t: 5 });
    const run1 = await seedRun(P, 10, 12);
    await seedAssessment({ claimId: P, status: "supported", credence: 0.8, t: 11, trigger: "structure_and_assess", current: true });
    await seedEvent({ claimId: Q, trigger: "subclaim_change", sourceRunId: run1, coalesced: false, t: 11 });
    await seedEvent({ claimId: Q, trigger: "subclaim_change", sourceRunId: run1, coalesced: true, t: 11.5 });
    // run2: Q reassessed, material change, notifies R.
    const run2 = await seedRun(Q, 20, 22);
    await seedAssessment({ claimId: Q, status: "contested", credence: 0.45, t: 21, trigger: "subclaim_change", current: true });
    await seedEvent({ claimId: R, trigger: "subclaim_change", sourceRunId: run2, coalesced: false, t: 21 });
    // run3: R reassessed, minor.
    await seedRun(R, 30, 32);
    await seedAssessment({ claimId: R, status: "contested", credence: 0.52, t: 31, trigger: "subclaim_change", current: false });
    // A challenge on R accepted, then R's credence RISES (a monotonicity violation).
    const user = await seedUser("cascade");
    const k = await rawQuery<{ id: string }>(
      `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, review_status, submitted_at)
       VALUES ($1, $2, 'challenge', 'db-test challenge', 'accepted', $3) RETURNING id`,
      [R, user, at(40)]
    );
    contributionId = k[0]!.id;
    await rawQuery(
      `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence, reviewed_at)
       VALUES ($1, 'accept', 'db-test', 0.9, $2)`,
      [contributionId, at(41)]
    );
    await seedEvent({ claimId: R, trigger: "contribution_accepted", sourceRunId: null, coalesced: false, t: 41 });
    await seedRun(R, 50, 52);
    await seedAssessment({ claimId: R, status: "supported", credence: 0.7, t: 51, trigger: "contribution_accepted", current: true });
  });

  it("reconstructs the lineage and computes R from the real tables", async () => {
    const input = await loadCascadeInput(TEST_DATABASE_URL, { since });
    const mine = new Set([P, Q, R]);
    // Other test files may have left steward rows; restrict to ours.
    input.runs = input.runs.filter((r) => r.claimId && mine.has(r.claimId));
    input.events = input.events.filter((e) => e.claimId && mine.has(e.claimId));
    input.assessments = input.assessments.filter((a) => mine.has(a.claimId));
    expect(input.runs).toHaveLength(4);
    expect(input.events).toHaveLength(5);
    expect(input.assessments).toHaveLength(6);
    expect(input.depthSamples).toEqual([]);

    const report = analyzeCascade(input);
    const gens = report.runs.map((n) => [n.claimId === P ? "P" : n.claimId === Q ? "Q" : "R", n.generation, n.change]);
    expect(gens).toEqual([
      ["P", 0, "first"],
      ["Q", 1, "material"],
      ["R", 2, "minor"],
      ["R", 0, "material"], // the contribution-triggered run is a new root
    ]);
    // Changed parents: run1 (first), run2 (material), run4 (material); material children: run2.
    expect(report.changedParents).toBe(3);
    expect(report.materialChildren).toBe(1);
    expect(report.R).toBe(0.333);
    expect(report.coalescing).toEqual({ events: 5, coalesced: 1, share: 0.2 });
    expect(report.rootsByTrigger).toEqual({ structure_and_assess: 1, contribution_accepted: 1 });
    expect(report.cascades.maxDepth).toBe(2);
  });

  it("reads evidence monotonicity and overturn bins from the real tables", async () => {
    const input = await loadHistoryInput(TEST_DATABASE_URL, { since });
    const mine = new Set([P, Q, R]);
    input.assessments = input.assessments.filter((a) => mine.has(a.claimId));
    input.contributions = input.contributions.filter((k) => k.claimId && mine.has(k.claimId));
    expect(input.contributions).toHaveLength(1);
    expect(input.contributions[0]).toMatchObject({ id: contributionId, type: "challenge", decision: "accept", reviewStatus: "accepted" });
    expect(input.contributions[0]!.reviewedAt).toBe(at(41).toISOString());

    const report = analyzeHistory(input, { minBin: 1 });
    expect(report.monotonicity.linked).toBe(1);
    expect(report.monotonicity.violations).toBe(1);
    expect(report.monotonicity.items[0]).toMatchObject({ contributionId, claimId: R, expected: "down", before: 0.52, after: 0.7, outcome: "violation", linkedBy: "trigger" });
    // First credences: P 0.8 (never reassessed), Q 0.7 → 0.45 (changed AND reversed: crossed 0.5), R 0.5 (changed: status moved).
    const hi = report.overturn.bins.find((b) => b.bin === "0.8-1.0")!;
    expect(hi).toMatchObject({ n: 1, reassessed: 0, changed: 0 });
    const mid = report.overturn.bins.find((b) => b.bin === "0.6-0.8")!;
    expect(mid).toMatchObject({ n: 1, reassessed: 1, changed: 1, reversed: 1 });
    expect(report.overturn.neverReassessed).toBe(1);
  });

  it("refuses the main database by name", async () => {
    const u = new URL(TEST_DATABASE_URL);
    u.pathname = "/episteme";
    await expect(loadCascadeInput(u.toString())).rejects.toThrow(/Refusing/);
  });

  it("ignores rows outside the window", async () => {
    const input = await loadCascadeInput(TEST_DATABASE_URL, { since: at(45).toISOString() });
    const mine = new Set([P, Q, R]);
    expect(input.runs.filter((r) => r.claimId && mine.has(r.claimId))).toHaveLength(1);
    expect(input.events.filter((e) => e.claimId && mine.has(e.claimId))).toHaveLength(0);
  });
});
