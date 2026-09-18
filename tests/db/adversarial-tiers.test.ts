/**
 * Capability tiers (#334 S4): the contribution driver's applyTier writes the
 * standing the Reviewer's get_contributor_profile reads, and leaves the
 * append-only reputation ledger reconstructible. Real SQL against the real
 * schema, because the tier is a direct write (the reputation service has no
 * "set" path, only outcome deltas) and a column that drifts would silently
 * make every adversarial run measure the wrong account.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { applyTier, TIER_PROFILES } from "../../scripts/corpus/contribution-driver.js";
import { trustLevelFor } from "../../src/services/reputation-service.js";

async function seedContributor(): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO contributors (display_name, external_id) VALUES ($1, $2) RETURNING id`,
    ["tier test", `dbtest:tier:${randomUUID()}`]
  );
  return rows[0]!.id;
}

async function profile(id: string) {
  const [row] = await rawQuery<{
    reputation_score: number;
    contributions_accepted: number;
    contributions_rejected: number;
    is_suspended: boolean;
    age_days: number;
  }>(
    `SELECT reputation_score, contributions_accepted, contributions_rejected, is_suspended,
            EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS age_days
       FROM contributors WHERE id = $1`,
    [id]
  );
  return row!;
}

describe("applyTier", () => {
  it("gives each tier the standing the Reviewer will read", async () => {
    for (const tier of ["fresh", "standard", "trusted"] as const) {
      const id = await seedContributor();
      await applyTier(id, tier);
      const p = await profile(id);
      const expected = TIER_PROFILES[tier];
      expect(p.reputation_score).toBeCloseTo(expected.reputation, 5);
      expect(p.contributions_accepted).toBe(expected.accepted);
      expect(p.contributions_rejected).toBe(expected.rejected);
      expect(Math.round(Number(p.age_days))).toBe(expected.ageDays);
      expect(p.is_suspended).toBe(false);
    }
  });

  it("lands each tier on the trust level the scenario intends", async () => {
    expect(trustLevelFor(TIER_PROFILES.fresh.reputation, false)).toBe("restricted");
    expect(trustLevelFor(TIER_PROFILES.standard.reputation, false)).toBe("standard");
    expect(trustLevelFor(TIER_PROFILES.trusted.reputation, false)).toBe("trusted");
  });

  it("leaves a fresh account one bad-faith flag above auto-suspension", () => {
    // REPUTATION_RULES: badFaithFlag −15, suspendBelow 10. A fresh account at
    // 15 is burned by exactly one flag, which is the cost-of-attack instrument.
    expect(TIER_PROFILES.fresh.reputation - 15).toBeLessThan(10);
    expect(TIER_PROFILES.standard.reputation - 15).toBeGreaterThanOrEqual(10);
  });

  it("records the change in the append-only ledger, so the score stays reconstructible", async () => {
    const id = await seedContributor();
    await applyTier(id, "trusted");
    const events = await rawQuery<{ delta: number; score_after: number; reason: string }>(
      `SELECT delta, score_after, reason FROM reputation_events WHERE contributor_id = $1 ORDER BY created_at`,
      [id]
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("harness_tier");
    expect(events[0]!.score_after).toBeCloseTo(TIER_PROFILES.trusted.reputation, 5);
    // 50 is the minted default; the delta carries the account from there.
    expect(events[0]!.delta).toBeCloseTo(TIER_PROFILES.trusted.reputation - 50, 5);
  });

  it("writes no ledger event when the tier is already the account's score", async () => {
    const id = await seedContributor();
    await applyTier(id, "standard"); // 50, the minted default
    const events = await rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM reputation_events WHERE contributor_id = $1`, [id]);
    expect(Number(events[0]!.n)).toBe(0);
  });
});
