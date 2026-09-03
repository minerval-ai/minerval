/**
 * The fund's arithmetic and the bounty bounds (docs/mathematics.md §8.1,
 * §10.4): three numbers, only the first stored; a bounty never opens beyond
 * `available`; the per-claim, per-pass, and per-day bounds; the deposit key.
 */
import { describe, it, expect } from "vitest";
import {
  computeAvailable,
  depositIdempotencyKey,
  RESERVING_BOUNTY_STATUSES,
  FUND_DEBIT_REASONS,
} from "../../../src/services/prize-pool-service.js";
import {
  checkBountyBounds,
  reserveMicroUsdFor,
  formatUsd,
  usdToMicro,
  bountyStateSentence,
  LIVE_BOUNTY_STATUSES,
} from "../../../src/services/bounty-service.js";

describe("the fund's three numbers", () => {
  it("available = balance − reserved, and reserved sums exactly the four live statuses", () => {
    expect(computeAvailable(10_000_000_000, 2_500_000_000)).toBe(7_500_000_000);
    expect(computeAvailable(1_000, 2_000)).toBe(-1_000);
    expect([...RESERVING_BOUNTY_STATUSES]).toEqual(["open", "claim_pending", "house_result_pending", "rebinding"]);
    expect(LIVE_BOUNTY_STATUSES).toContain("requested");
    expect(RESERVING_BOUNTY_STATUSES as readonly string[]).not.toContain("requested");
  });

  it("names exactly the debit reasons the design allows", () => {
    expect([...FUND_DEBIT_REASONS]).toEqual(["owl_prize", "withholding_remitted", "defect_award", "review_award", "payout"]);
  });

  it("keys a deposit by domain and batch", () => {
    expect(depositIdempotencyKey("mathematics", "wire-2026-03")).toBe("deposit:mathematics:wire-2026-03");
  });
});

describe("the bounty bounds", () => {
  const base = {
    minUsd: 250,
    maxUsd: 5000,
    balanceMicroUsd: usdToMicro(10_000),
    availableMicroUsd: usdToMicro(10_000),
    committedThisPassMicroUsd: 0,
    committedTodayMicroUsd: 0,
    fractionPerPass: 0.1,
    fractionPerDay: 0.25,
  };

  it("accepts an in-bounds posting", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(500) })).toEqual({ ok: true });
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(250) })).toEqual({ ok: true });
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(1000) })).toEqual({ ok: true });
  });

  it("refuses below the minimum and above the maximum per claim", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(249) })).toMatchObject({ ok: false, code: "AMOUNT_OUT_OF_BOUNDS" });
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(5001), balanceMicroUsd: usdToMicro(100_000), availableMicroUsd: usdToMicro(100_000) })).toMatchObject({ ok: false, code: "AMOUNT_OUT_OF_BOUNDS" });
  });

  it("caps a pass at its fraction of the fund, counting what the pass already committed", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(1001) })).toMatchObject({ ok: false, code: "PASS_FRACTION_EXCEEDED" });
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(600), committedThisPassMicroUsd: usdToMicro(500) })).toMatchObject({ ok: false, code: "PASS_FRACTION_EXCEEDED" });
  });

  it("caps a day at its fraction of the fund", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(600), committedTodayMicroUsd: usdToMicro(2000) })).toMatchObject({ ok: false, code: "DAY_FRACTION_EXCEEDED" });
  });

  it("never opens beyond available: the reservation must be covered even when the balance is large", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(500), availableMicroUsd: usdToMicro(499) })).toMatchObject({ ok: false, code: "INSUFFICIENT_AVAILABLE" });
    expect(checkBountyBounds({ ...base, amountMicroUsd: usdToMicro(500), availableMicroUsd: usdToMicro(500) })).toEqual({ ok: true });
  });
});

describe("the reserve and the money formatting", () => {
  it("mints the configured fraction of the bounty, floored", () => {
    expect(reserveMicroUsdFor(usdToMicro(500), 0.1)).toBe(usdToMicro(50));
    expect(reserveMicroUsdFor(1_000_001, 0.1)).toBe(100_000);
    expect(reserveMicroUsdFor(usdToMicro(500), 0)).toBe(0);
  });

  it("renders dollars with grouping and no owl marks", () => {
    expect(formatUsd(usdToMicro(2500))).toBe("$2,500");
    expect(formatUsd(usdToMicro(84.5))).toBe("$84.50");
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("the state sentence", () => {
  const opened = new Date("2026-03-12T00:00:00Z");
  const base = { amountMicroUsd: usdToMicro(2500), openedAt: opened, withdrawEffectiveAt: null, liveClaim: null, awarded: null };
  it("speaks in the graph's voice for each state", () => {
    expect(bountyStateSentence({ ...base, status: "open" })).toBe("Open since 12 March 2026.");
    expect(bountyStateSentence({ ...base, status: "open", liveClaim: { status: "checking", credit_name: null, window_ends_at: null, accepted_at: null } })).toBe("A submission is being checked.");
    expect(bountyStateSentence({ ...base, status: "claim_pending", liveClaim: { status: "in_review", credit_name: null, window_ends_at: null, accepted_at: null } })).toBe("A submission passed the checker and awaits review.");
    expect(
      bountyStateSentence({
        ...base,
        status: "claim_pending",
        liveClaim: { status: "in_challenge_window", credit_name: "A", window_ends_at: new Date("2026-04-14T00:00:00Z"), accepted_at: new Date("2026-03-15T00:00:00Z") },
      })
    ).toBe("Accepted on 15 March 2026 and payable after 14 April 2026 unless a challenge succeeds.");
    expect(bountyStateSentence({ ...base, status: "paid", awarded: { credit_name: "Ada", paid_at: new Date("2026-05-01T00:00:00Z"), amount_micro_usd: usdToMicro(2500) } })).toBe(
      "Settled by a checked proof submitted by Ada on 1 May 2026; prize of $2,500 paid."
    );
    expect(bountyStateSentence({ ...base, status: "resolved_internally" })).toMatch(/Minerval's own solver/);
    expect(bountyStateSentence({ ...base, status: "resolved_unpaid" })).toMatch(/no eligible claimant/);
    expect(bountyStateSentence({ ...base, status: "rebinding" })).toMatch(/revised after this prize was posted/);
    expect(bountyStateSentence({ ...base, status: "open", withdrawEffectiveAt: new Date("2026-04-11T00:00:00Z") })).toMatch(/withdrawn from 11 April 2026/);
  });
});
