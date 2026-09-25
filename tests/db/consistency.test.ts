/**
 * The Consistency Checker's mechanism (#330) against real Postgres: the
 * flag write path and its folding, the flag's expected gain entering the
 * formula valuation, partitions and what makes one due, the partition
 * listing a sweep reads, the ledger rows a sweep runs on and their daily
 * cap, and the precision read.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

// Read by loadConfig on first use, which is after this line.
process.env.CONSISTENCY_MAX_SWEEPS_PER_DAY = "2";
process.env.CONSISTENCY_MIN_TAG_CLAIMS = "3";

import { rawQuery } from "../../src/db/client.js";
import { seedClaim as seedPendingClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  consistencyPrecision,
  duePartitions,
  finishSweep,
  flagInconsistency,
  listPartitions,
  partitionClaims,
  startSweep,
} from "../../src/services/consistency-service.js";
import { reconcileActions, ASSESS_GROUP } from "../../src/services/action-service.js";
import { refreshFormulaValuations } from "../../src/services/mandate-valuer-service.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";

async function seedClaim(label: string, importance = 0.5): Promise<string> {
  const id = await seedPendingClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done', importance = $2 WHERE id = $1`, [id, importance]);
  return id;
}

async function assess(
  claimId: string,
  input: { status: string; credence?: number | null; when?: Date; marginalYield?: number | null }
): Promise<string> {
  const id = randomUUID();
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments
       (id, claim_id, status, confidence, claim_credence, reasoning_trace, is_current,
        assessed_at, marginal_yield)
     VALUES ($1, $2, $3, 0.8, $4, 'trace', true, $5, $6)`,
    [id, claimId, input.status, input.credence ?? null, input.when ?? new Date(), input.marginalYield ?? null]
  );
  return id;
}

async function seedTag(slug: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO tags (slug, name) VALUES ($1, $1) RETURNING id`,
    [`${slug}-${randomUUID().slice(0, 8)}`]
  );
  return row!.id;
}

async function tag(tagId: string, claimIds: string[]): Promise<void> {
  for (const id of claimIds) {
    await rawQuery(
      `INSERT INTO taggings (tag_id, subject_kind, subject_id, source) VALUES ($1, 'claim', $2, 'dbtest')`,
      [tagId, id]
    );
  }
}

describe("consistency flags (#330)", () => {
  it("enqueues the primary's Steward with the tension, opens its assess group, and snapshots the assessment", async () => {
    const a = await seedClaim("primary");
    const b = await seedClaim("neighbor");
    const assessmentId = await assess(a, { status: "supported", credence: 0.8 });
    await assess(b, { status: "contradicted", credence: 0.1 });

    const res = await flagInconsistency({
      sweepId: null,
      kind: "overlooked_evidence",
      primaryClaimId: a,
      claimIds: [b],
      rationale: "The primary's reasoning never weighs the neighbor, which undercuts its key premise.",
      expectedGain: 0.7,
    });
    expect(res.ok && !res.duplicate).toBe(true);

    const [claim] = await rawQuery<{ steward_state: string; steward_trigger: string; steward_context: string }>(
      `SELECT steward_state, steward_trigger, steward_context FROM claims WHERE id = $1`,
      [a]
    );
    expect(claim!.steward_state).toBe("pending");
    expect(claim!.steward_trigger).toBe("consistency_flag");
    expect(claim!.steward_context).toContain(b);
    expect(claim!.steward_context).toContain("contradicted");

    const [flag] = await rawQuery<{
      claim_ids: string[]; action_id: string | null; expected_gain: number;
      status_at_flag: string; assessment_id_at_flag: string;
    }>(`SELECT claim_ids, action_id, expected_gain, status_at_flag, assessment_id_at_flag
          FROM consistency_flags WHERE primary_claim_id = $1`, [a]);
    expect(flag!.claim_ids).toEqual([a, b]);
    expect(flag!.expected_gain).toBeCloseTo(0.7);
    expect(flag!.status_at_flag).toBe("supported");
    expect(flag!.assessment_id_at_flag).toBe(assessmentId);
    const [action] = await rawQuery<{ exclusion_group: string; kind: string }>(
      `SELECT exclusion_group, kind FROM actions WHERE id = $1`,
      [flag!.action_id]
    );
    expect(action!.exclusion_group).toBe(ASSESS_GROUP(a));
    expect(action!.kind).toBe("reassess");
  });

  it("folds a second flag on a primary whose pass is still waiting", async () => {
    const a = await seedClaim("primary");
    const b = await seedClaim("neighbor");
    const c = await seedClaim("another");
    await assess(a, { status: "supported", credence: 0.8 });
    await assess(b, { status: "supported", credence: 0.8 });
    await assess(c, { status: "supported", credence: 0.8 });
    const input = {
      sweepId: null,
      kind: "reasoning_conflict",
      primaryClaimId: a,
      rationale: "These two assessments read the same study in incompatible ways.",
      expectedGain: 0.5,
    };
    const first = await flagInconsistency({ ...input, claimIds: [b] });
    const second = await flagInconsistency({ ...input, claimIds: [c] });
    expect(first.ok && !first.duplicate).toBe(true);
    expect(second.ok && second.duplicate).toBe(true);
    const rows = await rawQuery<{ repeats: number }>(
      `SELECT repeats FROM consistency_flags WHERE primary_claim_id = $1`,
      [a]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeats).toBe(1);
  });

  it("folds a repeat into the waiting flag: the larger gain, the union of claims", async () => {
    const a = await seedClaim("primary");
    const b = await seedClaim("b");
    const c = await seedClaim("c");
    for (const id of [a, b, c]) await assess(id, { status: "supported" });
    const base = { sweepId: null, kind: "reasoning_conflict", primaryClaimId: a, rationale: "These assessments read the same data incompatibly." };
    await flagInconsistency({ ...base, claimIds: [b], expectedGain: 0.3 });
    await flagInconsistency({ ...base, claimIds: [c], expectedGain: 0.7 });
    const [row] = await rawQuery<{ expected_gain: number; claim_ids: string[] }>(
      `SELECT expected_gain, claim_ids FROM consistency_flags WHERE primary_claim_id = $1`,
      [a]
    );
    expect(row!.expected_gain).toBeCloseTo(0.7);
    expect([...row!.claim_ids].sort()).toEqual([a, b, c].sort());
  });

  it("lapses once its pass lands, even when the claim's assess row reopens later", async () => {
    resetAllocationPolicyCache();
    const funder = await seedUser("general-lapse");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000, policy: "general" });
    const a = await seedClaim("flagged", 0.8);
    const b = await seedClaim("neighbor");
    await assess(a, { status: "supported", marginalYield: 0.1 });
    await assess(b, { status: "supported" });
    await flagInconsistency({
      sweepId: null, kind: "overlooked_evidence", primaryClaimId: a, claimIds: [b],
      rationale: "The flagged claim never weighs the neighbor's evidence.", expectedGain: 0.9,
    });
    const valueOf = async () => {
      await refreshFormulaValuations(grantId, { scopeClaimId: a, scopeQuery: null });
      const [row] = await rawQuery<{ value_est: number }>(
        `SELECT mv.value_est FROM mandate_valuations mv JOIN actions x ON x.id = mv.action_id
          WHERE mv.grant_id = $1 AND x.claim_id = $2 AND x.variant = 'standard'`,
        [grantId, a]
      );
      return Number(row?.value_est ?? NaN);
    };
    const flagged = await valueOf();
    // The pass lands: a new assessment, the row done. Later the claim is
    // wanted again and the same row reopens.
    await assess(a, { status: "contested", marginalYield: 0.1 });
    await rawQuery(`UPDATE actions SET status = 'done' WHERE exclusion_group = $1`, [ASSESS_GROUP(a)]);
    await rawQuery(`UPDATE actions SET status = 'open' WHERE exclusion_group = $1`, [ASSESS_GROUP(a)]);
    const reopened = await valueOf();
    expect(reopened).toBeLessThan(flagged);
    expect(reopened / flagged).toBeCloseTo(0.1 / 0.9, 1);
    // And a new flag on it is a new flag, not a repeat of the spent one.
    const again = await flagInconsistency({
      sweepId: null, kind: "stale_premise", primaryClaimId: a, claimIds: [b],
      rationale: "Its new verdict still rests on the neighbor's old reading.", expectedGain: 0.5,
    });
    expect(again.ok && !again.duplicate).toBe(true);
  });

  it("refuses what it cannot act on: no other claim, an unassessed primary, an unknown kind", async () => {
    const a = await seedClaim("primary");
    const b = await seedClaim("neighbor");
    const base = { sweepId: null, kind: "other", rationale: "A long enough rationale to pass the check.", expectedGain: 0.5 };
    expect(await flagInconsistency({ ...base, primaryClaimId: a, claimIds: [b] })).toMatchObject({ ok: false, code: "UNASSESSED" });
    await assess(a, { status: "supported" });
    expect(await flagInconsistency({ ...base, primaryClaimId: a, claimIds: [] })).toMatchObject({ ok: false, code: "CLAIMS" });
    expect(await flagInconsistency({ ...base, kind: "vibes", primaryClaimId: a, claimIds: [b] })).toMatchObject({ ok: false, code: "KIND" });
  });

  it("raises the formula's expected gain while the flagged group is open, and only raises it", async () => {
    resetAllocationPolicyCache();
    const funder = await seedUser("general");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10_000_000, policy: "general" });
    const a = await seedClaim("flagged", 0.8);
    const b = await seedClaim("neighbor");
    // The Steward's own estimate: another pass would change little.
    await assess(a, { status: "supported", credence: 0.8, marginalYield: 0.1 });
    await assess(b, { status: "supported" });
    await flagInconsistency({
      sweepId: null,
      kind: "overlooked_evidence",
      primaryClaimId: a,
      claimIds: [b],
      rationale: "The flagged claim's reasoning never weighs the neighbor's evidence.",
      expectedGain: 0.6,
    });
    const valueOf = async () => {
      await refreshFormulaValuations(grantId, { scopeClaimId: a, scopeQuery: null });
      const [row] = await rawQuery<{ value_est: number }>(
        `SELECT mv.value_est FROM mandate_valuations mv JOIN actions x ON x.id = mv.action_id
          WHERE mv.grant_id = $1 AND x.claim_id = $2 AND x.variant = 'standard'`,
        [grantId, a]
      );
      return Number(row!.value_est);
    };
    const flagged = await valueOf();
    await rawQuery(`UPDATE consistency_flags SET expected_gain = 0.05 WHERE primary_claim_id = $1`, [a]);
    const lowFlag = await valueOf();
    // A flag below the Steward's own estimate changes nothing.
    await rawQuery(`DELETE FROM consistency_flags WHERE primary_claim_id = $1`, [a]);
    const unflagged = await valueOf();
    expect(flagged).toBeGreaterThan(unflagged);
    expect(flagged / unflagged).toBeCloseTo(0.6 / 0.1, 1);
    expect(lowFlag).toBeCloseTo(unflagged, 5);
  });
});

describe("partitions and sweeps (#330)", () => {
  let tagA: string;
  let tagSmall: string;
  let claimsA: string[];

  beforeAll(async () => {
    tagA = await seedTag("sweepable");
    tagSmall = await seedTag("too-small");
    claimsA = [await seedClaim("a1", 0.9), await seedClaim("a2", 0.5), await seedClaim("a3", 0.2)];
    for (const id of claimsA) await assess(id, { status: "supported", when: new Date(Date.now() - 3_600_000) });
    await tag(tagA, claimsA);
    const small = await seedClaim("s1");
    await assess(small, { status: "supported" });
    await tag(tagSmall, [small]);
  });

  it("makes a tag a partition only at the claim threshold; the rest fall in the residual bucket", async () => {
    const partitions = await listPartitions(3);
    expect(partitions.find((p) => p.tag_id === tagA)?.claims).toBe(3);
    expect(partitions.some((p) => p.tag_id === tagSmall)).toBe(false);
    expect(partitions.some((p) => p.partition === "residual")).toBe(true);
  });

  it("is due until swept, then again once something in it changed and the re-sweep interval passed", async () => {
    const isDue = async () => (await duePartitions(3)).some((p) => p.tagId === tagA);
    expect(await isDue()).toBe(true);
    const sweepId = await startSweep({ partition: "tag", tagId: tagA, label: "a" });
    // A running sweep blocks a second one.
    expect(await isDue()).toBe(false);
    await finishSweep({ sweepId, status: "done", claimsInScope: 3, flagsRaised: 0, note: "read all three" });
    expect(await isDue()).toBe(false);
    await assess(claimsA[2]!, { status: "contested", when: new Date(Date.now() + 1_000) });
    // Changed, but swept moments ago: not yet.
    expect(await isDue()).toBe(false);
    await rawQuery(`UPDATE consistency_sweeps SET started_at = now() - interval '25 hours' WHERE id = $1`, [sweepId]);
    await rawQuery(`UPDATE assessments SET assessed_at = now() WHERE claim_id = $1 AND is_current`, [claimsA[2]]);
    expect(await isDue()).toBe(true);
  });

  it("lists a partition's claims re-assessed since the last sweep first, then by importance", async () => {
    const since = new Date(Date.now() - 60_000);
    const { total, claims } = await partitionClaims({ tagId: tagA }, { since });
    expect(total).toBe(3);
    // a3 was re-assessed after `since`; a1 and a2 follow by importance.
    expect(claims.map((c) => c.claim_id)).toEqual([claimsA[2], claimsA[0], claimsA[1]]);
    expect(claims[0]!.changed).toBe(true);
    expect(claims[1]!.changed).toBe(false);
  });

  it("opens sweep rows for due partitions and funds them from the General mandate within the daily cap", async () => {
    resetAllocationPolicyCache();
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true`);
    const funder = await seedUser("platform");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000, policy: "general" });
    await rawQuery(`UPDATE grants SET is_platform = true WHERE id = $1`, [grantId]);

    await reconcileActions();
    const open = await rawQuery<{ id: string; exclusion_group: string }>(
      `SELECT id, exclusion_group FROM actions WHERE kind = 'consistency_sweep' AND status = 'open'`
    );
    // At most the day's cap of rows is opened.
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThanOrEqual(2);

    await fundGrantSelfActions();
    await fundGrantSelfActions();
    const funded = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM action_allocations
        WHERE exclusion_group LIKE 'consistency:%' AND grant_id = $1`,
      [grantId]
    );
    expect(funded[0]!.n).toBe(open.length);
    expect(funded[0]!.n).toBeLessThanOrEqual(2);
  });
});

describe("precision (#330)", () => {
  it("counts a flag as ran when a new assessment lands, and moved when it changes the verdict", async () => {
    const before = await consistencyPrecision();
    const a = await seedClaim("primary");
    const b = await seedClaim("neighbor");
    await assess(a, { status: "supported", credence: 0.8 });
    await assess(b, { status: "supported" });
    await flagInconsistency({
      sweepId: null,
      kind: "stale_premise",
      primaryClaimId: a,
      claimIds: [b],
      rationale: "The primary rests on the neighbor's old verdict, which has since changed.",
      expectedGain: 0.8,
    });
    await assess(a, { status: "contested", credence: 0.5 });
    const after = await consistencyPrecision();
    expect(after.flagged - before.flagged).toBe(1);
    expect(after.ran - before.ran).toBe(1);
    expect(after.moved - before.moved).toBe(1);
  });
});
