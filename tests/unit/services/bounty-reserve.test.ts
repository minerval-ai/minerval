/**
 * The prize-review reserve (docs/mathematics.md §8.6) over a scripted
 * runner: minting is an admin_adjust mint plus an escrow_hold into a
 * platform-owned job (the posting mandate's escrow is counted, never
 * moved), idempotent per bounty; the release returns live allocations'
 * unspent parts through refund rows, cancels open actions, and refunds the
 * never-placed remainder of the hold.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }>, job: null as null | Record<string, unknown> }));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: vi.fn(async () => ({ id: "platform" })),
}));
vi.mock("../../../src/services/queue-service.js", () => ({ requestAudit: vi.fn(async () => "run") }));

import { mintPrizeReviewReserve, releasePrizeReviewReserve, PRIZE_RESERVE_JOB_KIND } from "../../../src/services/bounty-service.js";
import { loadConfig } from "../../../src/config.js";

function runner(script: (sql: string, params: unknown[]) => unknown[] | undefined) {
  return {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      state.queries.push({ sql, params });
      return (script(sql, params) ?? []) as T[];
    },
  };
}

beforeEach(() => {
  state.queries = [];
  state.job = null;
});

describe("minting", () => {
  it("mints the fraction at cost into a platform-owned job with a hold, keyed per bounty, and writes no bounty or grant row", async () => {
    const config = loadConfig();
    const r = runner((sql) => {
      if (sql.includes("FROM budget_jobs")) return state.job ? [state.job] : [];
      if (sql.includes("INSERT INTO budget_jobs")) {
        state.job = { id: "job-1", user_id: "platform", budget_micro_usd: 50_000_000, status: "running" };
        return [{ id: "job-1" }];
      }
      return [];
    });
    const job = await mintPrizeReviewReserve({ id: "b-1", claim_id: "claim-1", amount_micro_usd: 500_000_000 }, r);
    expect(job).toMatchObject({ id: "job-1", user_id: "platform", budget_micro_usd: Math.floor(500_000_000 * config.prizeReviewReserveFraction) });
    const mint = state.queries.find((q) => q.sql.includes("'admin_adjust'"))!;
    expect(mint.params).toEqual(["platform", 50_000_000, "claim-1", "prize_reserve_mint:b-1"]);
    const jobInsert = state.queries.find((q) => q.sql.includes("INSERT INTO budget_jobs"))!;
    expect(jobInsert.params[1]).toBe(PRIZE_RESERVE_JOB_KIND);
    expect(JSON.parse(jobInsert.params[4] as string)).toMatchObject({ bounty_id: "b-1" });
    const hold = state.queries.find((q) => q.sql.includes("'escrow_hold'"))!;
    expect(hold.params).toEqual(["platform", -50_000_000, "claim-1", "job-1", "prize_reserve_hold:b-1"]);
    expect(state.queries.some((q) => /UPDATE (bounties|grants|budget_jobs)\b/.test(q.sql))).toBe(false);
    // Idempotent: a second mint finds the job and writes nothing.
    state.queries = [];
    expect(await mintPrizeReviewReserve({ id: "b-1", claim_id: "claim-1", amount_micro_usd: 500_000_000 }, r)).toMatchObject({ id: "job-1" });
    expect(state.queries.filter((q) => q.sql.startsWith("INSERT"))).toHaveLength(0);
  });

  it("mints nothing when the fraction yields zero", async () => {
    const r = runner(() => []);
    expect(await mintPrizeReviewReserve({ id: "b-1", claim_id: "c", amount_micro_usd: 1 }, r)).toBeNull();
    expect(state.queries).toHaveLength(0);
  });
});

describe("release", () => {
  it("releases live allocations with refunds, cancels open actions, refunds the never-placed remainder, and completes the job", async () => {
    const r = runner((sql) => {
      if (sql.includes("FROM budget_jobs")) return [{ id: "job-1", user_id: "platform", budget_micro_usd: 50_000_000, status: "running" }];
      if (sql.includes("AS unspent")) return [{ id: "al-1", user_id: "platform", claim_id: "claim-1", unspent: 1_000_000 }];
      if (sql.includes("SUM(al.amount_micro_usd)")) return [{ total: 3_000_000 }];
      return [];
    });
    const remainder = await releasePrizeReviewReserve("b-1", r);
    expect(remainder).toBe(47_000_000);
    expect(state.queries.find((q) => q.sql.includes("SET released_at = now() WHERE id = $1"))!.params).toEqual(["al-1"]);
    const refund = state.queries.find((q) => q.sql.includes("'refund'"))!;
    expect(refund.params).toEqual(["platform", 1_000_000, "claim-1", "release:al-1"]);
    expect(state.queries.some((q) => q.sql.includes("SET status = 'cancelled'") && q.sql.includes("prize_review"))).toBe(true);
    const release = state.queries.find((q) => q.sql.includes("'escrow_refund'"))!;
    expect(release.params).toEqual(["platform", 47_000_000, "job-1", "prize_reserve_release:b-1"]);
    expect(state.queries.some((q) => q.sql.includes("UPDATE budget_jobs SET status = 'completed'"))).toBe(true);
  });

  it("is a no-op once the job is completed", async () => {
    const r = runner((sql) => (sql.includes("FROM budget_jobs") ? [{ id: "job-1", user_id: "platform", budget_micro_usd: 5, status: "completed" }] : []));
    expect(await releasePrizeReviewReserve("b-1", r)).toBe(0);
    expect(state.queries).toHaveLength(1);
  });
});
