import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []
  ),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => {
    throw new Error("contribution-award-service must not use getDb");
  },
}));

import {
  awardPointsForImportance,
  owlsForImportance,
  awardContributionOwls,
  clawbackContributionOwls,
} from "../../../src/services/contribution-award-service.js";

beforeEach(() => mocks.rawQuery.mockReset().mockResolvedValue([]));

describe("awardPointsForImportance", () => {
  it("scales 1..5 with claim importance (the old kudos rule)", () => {
    expect(awardPointsForImportance(0)).toBe(1);
    expect(awardPointsForImportance(0.5)).toBe(3);
    expect(awardPointsForImportance(1)).toBe(5);
  });

  it("clamps out-of-range importance", () => {
    expect(awardPointsForImportance(-2)).toBe(1);
    expect(awardPointsForImportance(7)).toBe(5);
  });
});

describe("owlsForImportance", () => {
  it("pays points × the configured owl rate (default 0.25/point)", () => {
    expect(owlsForImportance(0)).toBe(0.25);
    expect(owlsForImportance(1)).toBe(1.25);
  });
});

describe("awardContributionOwls", () => {
  it("appends a ledger award and keeps lifetime-earned in sync", async () => {
    const awarded = await awardContributionOwls({
      contributorId: "c-1",
      contributionId: "k-1",
      owls: 0.75,
    });
    expect(awarded).toBe(0.75);

    const [insert, update] = mocks.rawQuery.mock.calls;
    expect(insert[0]).toContain("INSERT INTO owl_ledger");
    // 0.75 owls at the $4 face = 3,000,000 micro-USD.
    expect(insert[1]).toEqual(["c-1", 750_000, "contribution_award", "k-1"]);
    expect(update[0]).toContain(
      "owls_earned_micro_usd = owls_earned_micro_usd + $1"
    );
    expect(update[1]).toEqual([750_000, "c-1"]);
  });

  it("ignores non-positive awards", async () => {
    await awardContributionOwls({ contributorId: "c-1", owls: 0 });
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });
});

describe("clawbackContributionOwls", () => {
  it("writes a compensating negative award for everything earned", async () => {
    mocks.rawQuery.mockResolvedValueOnce([{ total: 5_000_000 }]);
    const reversed = await clawbackContributionOwls({
      contributorId: "c-1",
      contributionId: "k-1",
    });
    expect(reversed).toBe(5);

    const [, insert, update] = mocks.rawQuery.mock.calls;
    expect(insert[0]).toContain("INSERT INTO owl_ledger");
    expect(insert[1]).toEqual(["c-1", -5_000_000, "contribution_award", "k-1"]);
    expect(update[0]).toContain(
      "owls_earned_micro_usd = owls_earned_micro_usd - $1"
    );
    expect(update[1]).toEqual([5_000_000, "c-1"]);
  });

  it("is a no-op when the contribution earned nothing", async () => {
    mocks.rawQuery.mockResolvedValueOnce([{ total: 0 }]);
    const reversed = await clawbackContributionOwls({
      contributorId: "c-1",
      contributionId: "k-1",
    });
    expect(reversed).toBe(0);
    expect(mocks.rawQuery).toHaveBeenCalledTimes(1);
  });
});
