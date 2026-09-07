/**
 * Prize owls are excluded from the leaderboard (docs/mathematics.md §8.7):
 * the leaderboard ranks lifetime owls EARNED, and neither its query nor the
 * award path touches owls_prized_micro_usd; the prize path touches only
 * owls_prized_micro_usd.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const sqls = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("INSERT INTO owl_ledger")) return [{ id: "row" }];
    return [];
  }),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));

import { getLeaderboard, awardContributionOwls } from "../../../src/services/contribution-award-service.js";

beforeEach(() => {
  sqls.length = 0;
});

describe("the leaderboard sum", () => {
  it("orders and filters by owls_earned_micro_usd and never mentions owls_prized_micro_usd", async () => {
    await getLeaderboard(10);
    const sql = sqls.find((s) => s.includes("FROM contributors"))!;
    expect(sql).toMatch(/owls_earned_micro_usd > 0/);
    expect(sql).toMatch(/ORDER BY owls_earned_micro_usd DESC/);
    expect(sql).not.toMatch(/owls_prized/);
  });

  it("a contribution award increments owls_earned only", async () => {
    await awardContributionOwls({ contributorId: "u", contributionId: "c", owls: 2, awardKey: "k" });
    const update = sqls.find((s) => s.includes("UPDATE contributors"))!;
    expect(update).toMatch(/owls_earned_micro_usd = owls_earned_micro_usd \+/);
    expect(update).not.toMatch(/owls_prized/);
  });

  it("the payout service increments owls_prized only and the leaderboard source never reads it", () => {
    const payout = readFileSync(new URL("../../../src/services/prize-payout-service.ts", import.meta.url), "utf8");
    expect(payout).toMatch(/owls_prized_micro_usd = owls_prized_micro_usd \+ \$1/);
    expect(payout).not.toMatch(/owls_earned_micro_usd/);
    const awards = readFileSync(new URL("../../../src/services/contribution-award-service.ts", import.meta.url), "utf8");
    expect(awards).not.toMatch(/owls_prized/);
  });
});
