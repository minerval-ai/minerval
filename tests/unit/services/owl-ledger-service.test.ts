import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []
  ),
  inserted: [] as unknown[],
  insertReturns: [] as Array<Array<{ id: string }>>,
}));

// Drizzle insert chain stub: .insert().values().onConflictDoNothing().returning()
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => ({
    insert: () => ({
      values: (v: unknown) => {
        mocks.inserted.push(v);
        return {
          onConflictDoNothing: () => ({
            returning: async () =>
              mocks.insertReturns.shift() ?? [{ id: "row-1" }],
          }),
        };
      },
    }),
    select: () => {
      throw new Error("not exercised in these tests");
    },
  }),
}));

import {
  chargeOwls,
  refundChargeForContribution,
  ensureFreeGrants,
} from "../../../src/services/owl-ledger-service.js";

beforeEach(() => {
  mocks.rawQuery.mockReset().mockResolvedValue([]);
  mocks.inserted.length = 0;
  mocks.insertReturns.length = 0;
});

describe("chargeOwls", () => {
  it("debits the price behind a balance guard and returns the entry id", async () => {
    mocks.rawQuery.mockResolvedValueOnce([{ id: "charge-1" }]);
    const result = await chargeOwls({
      userId: "u-1",
      priceOwls: 1,
      op: "claim_proposal",
      claimId: null,
      contributionId: null,
    });
    expect(result).toEqual({ charged: true, entryId: "charge-1" });

    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO owl_ledger");
    expect(sql).toContain(">= $6"); // the balance guard
    expect(params).toEqual([
      "u-1",
      -4_000_000,
      "claim_proposal",
      null,
      null,
      4_000_000,
    ]);
  });

  it("reports an uncovered charge without writing anything", async () => {
    mocks.rawQuery.mockResolvedValueOnce([]);
    const result = await chargeOwls({
      userId: "u-1",
      priceOwls: 1,
      op: "assessment",
    });
    expect(result).toEqual({ charged: false, entryId: null });
  });

  it("treats a zero price as free", async () => {
    const result = await chargeOwls({
      userId: "u-1",
      priceOwls: 0,
      op: "assessment",
    });
    expect(result.charged).toBe(true);
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });
});

describe("ensureFreeGrants", () => {
  it("writes the signup grant and this month's trickle with idempotency keys", async () => {
    await ensureFreeGrants("u-1");
    expect(mocks.inserted).toHaveLength(2);
    const [signup, monthly] = mocks.inserted as Array<{
      amountMicroUsd: number;
      reason: string;
      idempotencyKey: string;
    }>;
    expect(signup.reason).toBe("signup_grant");
    expect(signup.amountMicroUsd).toBe(20_000_000); // 5 owls
    expect(signup.idempotencyKey).toBe("signup:u-1");
    expect(monthly.reason).toBe("monthly_grant");
    expect(monthly.amountMicroUsd).toBe(4_000_000); // 1 owl
    expect(monthly.idempotencyKey).toMatch(/^monthly:u-1:\d{4}-\d{2}$/);
  });
});

describe("refundChargeForContribution", () => {
  it("refunds each charge row exactly once via idempotency keys", async () => {
    mocks.rawQuery.mockResolvedValueOnce([
      {
        user_id: "u-1",
        amount_micro_usd: -4_000_000,
        op: "claim_proposal",
        claim_id: null,
      },
    ]);
    const refunded = await refundChargeForContribution("contrib-1");
    expect(refunded).toBe(true);
    expect(mocks.inserted).toHaveLength(1);
    const refund = mocks.inserted[0] as {
      amountMicroUsd: number;
      reason: string;
      idempotencyKey: string;
      contributionId: string;
    };
    expect(refund.amountMicroUsd).toBe(4_000_000); // compensates the -4M charge
    expect(refund.reason).toBe("refund");
    expect(refund.idempotencyKey).toBe("refund:contribution:contrib-1:0");
    expect(refund.contributionId).toBe("contrib-1");
  });

  it("does nothing when the contribution carries no charge", async () => {
    mocks.rawQuery.mockResolvedValueOnce([]);
    expect(await refundChargeForContribution("contrib-1")).toBe(false);
    expect(mocks.inserted).toHaveLength(0);
  });

  it("reports false when the refund was already applied", async () => {
    mocks.rawQuery.mockResolvedValueOnce([
      {
        user_id: "u-1",
        amount_micro_usd: -4_000_000,
        op: "claim_proposal",
        claim_id: null,
      },
    ]);
    mocks.insertReturns.push([]); // duplicate idempotency key → no row
    expect(await refundChargeForContribution("contrib-1")).toBe(false);
  });
});
