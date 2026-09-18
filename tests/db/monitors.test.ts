/**
 * Production monitors (#334 S9), the SQL half: seed one instance of each
 * situation a signal is defined over — a performed-settling claim, an empty
 * chair, an evidence-monotonicity violation, a material reversal, a
 * one-generation cascade, an error-parked claim — beside a control that
 * looks similar but should NOT fire, and assert each detector catches only
 * what it defines. Real SQL, real window functions, real LATERAL joins.
 *
 * The scratch DB is shared across files, so every assertion is "my seeded
 * ids are in / not in the result", never "the result is exactly this".
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedUser } from "./helpers.js";
import {
  cascadeHealth,
  defaultThresholds,
  emptyChairs,
  evidenceMonotonicity,
  overturnRate,
  performedSettling,
  queueHealth,
  agentRollups,
  type MonitorThresholds,
} from "../../src/services/monitor-service.js";

const T: MonitorThresholds = {
  settledConfidence: 0.8,
  settledStatuses: ["verified", "contradicted"],
  materialCredenceDelta: 0.1,
  recentChallengeDays: 30,
  minDisagreeingSources: 2,
  emptyChairMinInstances: 2,
  monotonicityTolerance: 0.05,
  monotonicityHorizonDays: 30,
  monotonicityWindowDays: 90,
  overturnMinSample: 10,
  cascadeDays: 14,
  snapshotPoints: 48,
  limit: 1000,
};

async function claim(label: string, opts: { stewardState?: string; importance?: number; error?: string } = {}): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text, steward_state, importance, steward_error)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`monitor test ${label} ${randomUUID()}`, opts.stewardState ?? "done", opts.importance ?? 0.5, opts.error ?? null]
  );
  return row!.id;
}

async function assess(
  claimId: string,
  a: { status: string; confidence?: number; credence: number | null; current?: boolean; agoMinutes?: number }
): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, $3, $4, 'monitor test', $5, now() - make_interval(mins => $6)) RETURNING id`,
    [claimId, a.status, a.confidence ?? 0.9, a.credence, a.current ?? true, a.agoMinutes ?? 0]
  );
  return row!.id;
}

async function source(label: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title) VALUES ($1, $2) RETURNING id`,
    [`https://example.test/${label}/${randomUUID()}`, `monitor test source ${label}`]
  );
  return row!.id;
}

async function instance(claimId: string, sourceId: string, stance: "affirms" | "denies"): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance) VALUES ($1, $2, 'monitor test', $3)`,
    [claimId, sourceId, stance]
  );
}

async function argument(claimId: string, stance: "for" | "against"): Promise<void> {
  await rawQuery(
    `INSERT INTO arguments (claim_id, stance, content, created_by) VALUES ($1, $2, 'monitor test', 'test')`,
    [claimId, stance]
  );
}

async function acceptedContribution(
  claimId: string,
  contributorId: string,
  type: "support" | "challenge",
  reviewedAgoMinutes: number,
  decision = "accept"
): Promise<string> {
  const [c] = await rawQuery<{ id: string }>(
    `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, review_status)
     VALUES ($1, $2, $3, 'monitor test', 'reviewed') RETURNING id`,
    [claimId, contributorId, type]
  );
  await rawQuery(
    `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence, reviewed_at)
     VALUES ($1, $2, 'monitor test', 0.8, now() - make_interval(mins => $3))`,
    [c!.id, decision, reviewedAgoMinutes]
  );
  return c!.id;
}

async function stewardRun(claimId: string, startedAgoMinutes: number, durationMinutes = 5): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO agent_runs (agent, claim_id, started_at, finished_at, outcome)
     VALUES ('steward', $1, now() - make_interval(mins => $2), now() - make_interval(mins => $3), 'ok') RETURNING id`,
    [claimId, startedAgoMinutes, startedAgoMinutes - durationMinutes]
  );
  return row!.id;
}

let contributorId: string;
beforeAll(async () => {
  contributorId = await seedUser("monitor");
});

describe("performed settling", () => {
  it("catches settled verdicts with opposed instances, a recent accepted challenge, or a contested requires-child — and not their controls", async () => {
    const [srcA, srcB] = await Promise.all([source("a"), source("b")]);

    // 1. opposed instances from two sources under a verified verdict at 0.9
    const opposed = await claim("opposed");
    await assess(opposed, { status: "verified", confidence: 0.9, credence: 0.9 });
    await instance(opposed, srcA, "affirms");
    await instance(opposed, srcB, "denies");

    // control: same instances, but confidence below the settled threshold
    const lowConf = await claim("low-confidence");
    await assess(lowConf, { status: "verified", confidence: 0.6, credence: 0.9 });
    await instance(lowConf, srcA, "affirms");
    await instance(lowConf, srcB, "denies");

    // control: opposed instances from ONE source only
    const oneSource = await claim("one-source");
    await assess(oneSource, { status: "verified", confidence: 0.9, credence: 0.9 });
    await instance(oneSource, srcA, "affirms");
    await instance(oneSource, srcA, "denies");

    // control: verified, all instances agree
    const agreed = await claim("agreed");
    await assess(agreed, { status: "verified", confidence: 0.9, credence: 0.9 });
    await instance(agreed, srcA, "affirms");
    await instance(agreed, srcB, "affirms");

    // 2. recent accepted challenge under a contradicted verdict
    const challenged = await claim("challenged");
    await assess(challenged, { status: "contradicted", confidence: 0.85, credence: 0.1 });
    await acceptedContribution(challenged, contributorId, "challenge", 60);

    // control: the challenge was rejected
    const rejected = await claim("rejected-challenge");
    await assess(rejected, { status: "contradicted", confidence: 0.85, credence: 0.1 });
    await acceptedContribution(rejected, contributorId, "challenge", 60, "reject");

    // control: the accepted challenge is older than the window
    const stale = await claim("stale-challenge");
    await assess(stale, { status: "contradicted", confidence: 0.85, credence: 0.1 });
    await acceptedContribution(stale, contributorId, "challenge", 60 * 24 * 45);

    // 3. contested child under a requires edge
    const parent = await claim("parent");
    await assess(parent, { status: "verified", confidence: 0.9, credence: 0.9 });
    const child = await claim("contested-child");
    await assess(child, { status: "contested", confidence: 0.7, credence: 0.5 });
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning) VALUES ($1, $2, 'requires', 'test')`,
      [parent, child]
    );

    // control: the contested child hangs under a `supports` edge, not `requires`
    const parent2 = await claim("parent-supports");
    await assess(parent2, { status: "verified", confidence: 0.9, credence: 0.9 });
    const child2 = await claim("contested-child-2");
    await assess(child2, { status: "contested", confidence: 0.7, credence: 0.5 });
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning) VALUES ($1, $2, 'supports', 'test')`,
      [parent2, child2]
    );

    const report = await performedSettling(T);
    const byId = new Map(report.candidates.map((c) => [c.claimId, c]));
    expect(byId.get(opposed)?.reasons).toEqual(["opposed_instances"]);
    expect(byId.get(challenged)?.reasons).toEqual(["recent_accepted_challenge"]);
    expect(byId.get(parent)?.reasons).toEqual(["contested_requires_child"]);
    expect(byId.get(parent)?.contestedRequiresChildren).toBe(1);
    for (const control of [lowConf, oneSource, agreed, rejected, stale, parent2, child]) {
      expect(byId.has(control)).toBe(false);
    }
  });
});

describe("empty chairs", () => {
  it("catches contested claims whose instances or arguments are all one stance — and not the mixed or settled ones", async () => {
    const [srcA, srcB] = await Promise.all([source("c"), source("d")]);

    const oneSided = await claim("one-sided");
    await assess(oneSided, { status: "contested", confidence: 0.6, credence: 0.5 });
    await instance(oneSided, srcA, "affirms");
    await instance(oneSided, srcB, "affirms");

    const oneSidedArgs = await claim("one-sided-args");
    await assess(oneSidedArgs, { status: "contested", confidence: 0.6, credence: 0.5 });
    await argument(oneSidedArgs, "against");

    // control: contested, both stances on record
    const mixed = await claim("mixed");
    await assess(mixed, { status: "contested", confidence: 0.6, credence: 0.5 });
    await instance(mixed, srcA, "affirms");
    await instance(mixed, srcB, "denies");
    await argument(mixed, "for");
    await argument(mixed, "against");

    // control: only one instance (below the minimum)
    const single = await claim("single-instance");
    await assess(single, { status: "contested", confidence: 0.6, credence: 0.5 });
    await instance(single, srcA, "affirms");

    // control: verified with one-sided instances is normal, not an empty chair
    const settled = await claim("settled-one-sided");
    await assess(settled, { status: "verified", confidence: 0.9, credence: 0.9 });
    await instance(settled, srcA, "affirms");
    await instance(settled, srcB, "affirms");

    const report = await emptyChairs(T);
    const byId = new Map(report.candidates.map((c) => [c.claimId, c]));
    expect(byId.get(oneSided)?.reasons).toEqual(["instances_one_stance"]);
    expect(byId.get(oneSided)?.instanceStance).toBe("affirms");
    expect(byId.get(oneSidedArgs)?.reasons).toEqual(["arguments_one_stance"]);
    expect(byId.get(oneSidedArgs)?.argumentStance).toBe("against");
    for (const control of [mixed, single, settled]) expect(byId.has(control)).toBe(false);
  });
});

describe("evidence monotonicity", () => {
  it("flags a support followed by a lower credence and a challenge followed by a higher one, not sign-correct updates or pending ones", async () => {
    const supportLowered = await claim("support-lowered");
    await assess(supportLowered, { status: "supported", credence: 0.7, current: false, agoMinutes: 300 });
    const c1 = await acceptedContribution(supportLowered, contributorId, "support", 200);
    await assess(supportLowered, { status: "supported", credence: 0.5, agoMinutes: 100 });

    const challengeRaised = await claim("challenge-raised");
    await assess(challengeRaised, { status: "contested", credence: 0.5, current: false, agoMinutes: 300 });
    const c2 = await acceptedContribution(challengeRaised, contributorId, "challenge", 200);
    await assess(challengeRaised, { status: "supported", credence: 0.7, agoMinutes: 100 });

    // control: sign-correct
    const supportRaised = await claim("support-raised");
    await assess(supportRaised, { status: "supported", credence: 0.5, current: false, agoMinutes: 300 });
    const c3 = await acceptedContribution(supportRaised, contributorId, "support", 200);
    await assess(supportRaised, { status: "supported", credence: 0.7, agoMinutes: 100 });

    // control: inside the tolerance
    const noise = await claim("noise");
    await assess(noise, { status: "supported", credence: 0.6, current: false, agoMinutes: 300 });
    const c4 = await acceptedContribution(noise, contributorId, "support", 200);
    await assess(noise, { status: "supported", credence: 0.58, agoMinutes: 100 });

    // control: not yet re-assessed
    const pending = await claim("pending");
    await assess(pending, { status: "supported", credence: 0.6, agoMinutes: 300 });
    const c5 = await acceptedContribution(pending, contributorId, "support", 200);

    const report = await evidenceMonotonicity(T);
    const kinds = new Map(report.violations.map((v) => [v.contributionId, v.kind]));
    expect(kinds.get(c1)).toBe("support_lowered");
    expect(kinds.get(c2)).toBe("challenge_raised");
    for (const control of [c3, c4, c5]) expect(kinds.has(control)).toBe(false);
    expect(report.unassessed).toBeGreaterThanOrEqual(1);
  });
});

describe("overturn rate", () => {
  it("counts a later material reversal in the first credence's bin and not a minor move", async () => {
    const before = await overturnRate(T);
    const bin = (r: typeof before, b: number) => r.bins.find((x) => x.bin === b)!;

    const reversed = await claim("reversed");
    await assess(reversed, { status: "verified", credence: 0.95, current: false, agoMinutes: 200 });
    await assess(reversed, { status: "contradicted", credence: 0.2, agoMinutes: 100 });

    const nudged = await claim("nudged");
    await assess(nudged, { status: "supported", credence: 0.55, current: false, agoMinutes: 200 });
    await assess(nudged, { status: "supported", credence: 0.58, agoMinutes: 100 });

    const after = await overturnRate(T);
    // 0.95 → bin 10 (width_bucket gives 10; 1.0 would give 11 and fold)
    expect(bin(after, 10).n - bin(before, 10).n).toBe(1);
    expect(bin(after, 10).reversed - bin(before, 10).reversed).toBe(1);
    // 0.55 → bin 6, not reversed
    expect(bin(after, 6).n - bin(before, 6).n).toBe(1);
    expect(bin(after, 6).reversed - bin(before, 6).reversed).toBe(0);
    // the second assessment of each claim has no successor and is not counted
    expect(after.assessed - before.assessed).toBe(2);
  });
});

describe("cascade health", () => {
  it("credits a materially-changed child run to its materially-changed parent via enqueue_events, and counts coalescing", async () => {
    const before = await cascadeHealth(T);

    const a = await claim("cascade-a");
    const b = await claim("cascade-b");
    const c = await claim("cascade-c");
    // parent: assessed A (first assessment = material) 60..55 minutes ago
    const parent = await stewardRun(a, 60);
    await assess(a, { status: "supported", credence: 0.7, agoMinutes: 57 });
    // it notified B and C
    await rawQuery(
      `INSERT INTO enqueue_events (queue, trigger, claim_id, source_agent, source_run_id, coalesced, created_at)
       VALUES ('steward', 'subclaim_change', $1, 'steward', $2, false, now() - make_interval(mins => 56)),
              ('steward', 'subclaim_change', $3, 'steward', $2, true,  now() - make_interval(mins => 56))`,
      [b, parent, c]
    );
    // B's run changed materially; C's run recorded nothing new
    await stewardRun(b, 50);
    await assess(b, { status: "contested", credence: 0.5, agoMinutes: 48 });
    await stewardRun(c, 50);

    const after = await cascadeHealth(T);
    expect(after.materialRuns - before.materialRuns).toBe(2); // parent + B
    expect(after.materialChildren - before.materialChildren).toBe(1); // B only
    const today = new Date().toISOString().slice(0, 10);
    const day = after.days.find((d) => d.day === today);
    expect(day).toBeDefined();
    expect(day!.runs).toBeGreaterThanOrEqual(3);
    expect(day!.coalesced).toBeGreaterThanOrEqual(1);
    expect(day!.enqueues).toBeGreaterThanOrEqual(2);
  });
});

describe("queue health", () => {
  it("counts states, finds the oldest pending claim's enqueue age, and lists error-parked claims", async () => {
    const pending = await claim("pending-old", { stewardState: "pending", importance: 0.9 });
    await rawQuery(
      `INSERT INTO enqueue_events (queue, trigger, claim_id, coalesced, created_at)
       VALUES ('steward', 'structure_and_assess', $1, false, now() - make_interval(days => 3))`,
      [pending]
    );
    const parked = await claim("parked", { stewardState: "error", importance: 0.95, error: "boom" });
    await rawQuery(
      `INSERT INTO queue_depth_snapshots (period_key, steward_pending, detail, created_at)
       VALUES ($1, 5, '{}', now() - interval '2 hours'), ($2, 9, '{}', now() - interval '1 hour')`,
      [`monitor-test-${randomUUID()}`, `monitor-test-${randomUUID()}`]
    );

    const report = await queueHealth(T);
    expect(report.states.pending).toBeGreaterThanOrEqual(1);
    expect(report.states.error).toBeGreaterThanOrEqual(1);
    expect(report.oldestPending).not.toBeNull();
    expect(report.oldestPending!.ageSeconds).toBeGreaterThanOrEqual(3 * 86_400 - 5);
    expect(report.errorParked.some((p) => p.claimId === parked && p.error === "boom")).toBe(true);
    expect(report.snapshots.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe("agent rollups", () => {
  it("joins llm_usage calls and cost with agent_runs error rates per agent", async () => {
    const agent = `monitor-test-${randomUUID().slice(0, 8)}`;
    await rawQuery(
      `INSERT INTO llm_usage (model, agent, cost_micro_usd) VALUES ('m', $1, 1500), ('m', $1, 500)`,
      [agent]
    );
    await rawQuery(
      `INSERT INTO agent_runs (agent, started_at, finished_at, outcome)
       VALUES ($1, now() - interval '1 hour', now() - interval '59 minutes', 'ok'),
              ($1, now() - interval '1 hour', now() - interval '59 minutes', 'error'),
              ($1, now() - interval '3 days', now() - interval '3 days', 'ok')`,
      [agent]
    );
    const report = await agentRollups();
    const row = report.agents.find((a) => a.agent === agent)!;
    expect(row.last24h).toMatchObject({ calls: 2, costMicroUsd: 2000, runs: 2, errors: 1, errorRate: 0.5 });
    expect(row.last7d).toMatchObject({ calls: 2, runs: 3, errors: 1 });
    expect(row.last7d.errorRate).toBeCloseTo(1 / 3);
  });
});

describe("defaultThresholds", () => {
  it("reads the config defaults and takes overrides", () => {
    const t = defaultThresholds({ limit: 3 });
    expect(t.settledConfidence).toBe(0.8);
    expect(t.materialCredenceDelta).toBe(0.1);
    expect(t.limit).toBe(3);
  });
});
