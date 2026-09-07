/**
 * The bounty bounds and the owl formatting (docs/mathematics.md §8.1,
 * §10.4): a bounty is owls held against the posting mandate's escrow, so
 * the bounds are the per-claim minimum and maximum, the per-pass and
 * per-day fractions of the escrow budget, and the mandate's headroom
 * covering the amount. Every prize amount renders as owls, never dollars.
 */
import { describe, it, expect } from "vitest";
import {
  checkBountyBounds,
  reserveMicroUsdFor,
  formatOwls,
  owlsToMicro,
  microToOwls,
  bountyStateSentence,
  LIVE_BOUNTY_STATUSES,
  HOLDING_BOUNTY_STATUSES,
  isHoldingBountyStatus,
  closureBlockedMessage,
} from "../../../src/services/bounty-service.js";

describe("the holding statuses", () => {
  it("hold in exactly the five statuses after a request, and a requested bounty holds nothing", () => {
    expect([...HOLDING_BOUNTY_STATUSES]).toEqual(["confirm_pending", "open", "claim_pending", "house_result_pending", "rebinding"]);
    expect(LIVE_BOUNTY_STATUSES).toContain("requested");
    expect(isHoldingBountyStatus("requested")).toBe(false);
    expect(isHoldingBountyStatus("confirm_pending")).toBe(true);
    expect(isHoldingBountyStatus("paid")).toBe(false);
  });
});

describe("the bounty bounds", () => {
  const base = {
    minOwls: 250,
    maxOwls: 5000,
    escrowMicroUsd: owlsToMicro(2500),
    headroomMicroUsd: owlsToMicro(2500),
    committedThisPassMicroUsd: 0,
    committedTodayMicroUsd: 0,
    fractionPerPass: 0.4,
    fractionPerDay: 0.5,
  };

  it("accepts an in-bounds posting", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(500) })).toEqual({ ok: true });
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(250) })).toEqual({ ok: true });
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(1000) })).toEqual({ ok: true });
  });

  it("refuses below the minimum and above the maximum per claim, in owls", () => {
    const low = checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(249) });
    expect(low).toMatchObject({ ok: false, code: "AMOUNT_OUT_OF_BOUNDS" });
    if (!low.ok) expect(low.message).toBe("a bounty is between 250 owls and 5,000 owls per claim; 249 owls was asked");
    expect(
      checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(5001), escrowMicroUsd: owlsToMicro(100_000), headroomMicroUsd: owlsToMicro(100_000) })
    ).toMatchObject({ ok: false, code: "AMOUNT_OUT_OF_BOUNDS" });
  });

  it("caps a pass at its fraction of the escrow, counting what the pass already committed", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(1001) })).toMatchObject({ ok: false, code: "PASS_FRACTION_EXCEEDED" });
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(1000) })).toEqual({ ok: true });
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(600), committedThisPassMicroUsd: owlsToMicro(500) })).toMatchObject({ ok: false, code: "PASS_FRACTION_EXCEEDED" });
  });

  it("caps a day at its fraction of the escrow", () => {
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(300), committedTodayMicroUsd: owlsToMicro(1000) })).toMatchObject({ ok: false, code: "DAY_FRACTION_EXCEEDED" });
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(250), committedTodayMicroUsd: owlsToMicro(1000) })).toEqual({ ok: true });
  });

  it("never opens beyond the mandate's headroom, even with a large escrow", () => {
    const refused = checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(500), headroomMicroUsd: owlsToMicro(499) });
    expect(refused).toMatchObject({ ok: false, code: "INSUFFICIENT_ESCROW" });
    if (!refused.ok) expect(refused.message).toMatch(/headroom is 499 owls/);
    expect(checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(500), headroomMicroUsd: owlsToMicro(500) })).toEqual({ ok: true });
    const negative = checkBountyBounds({ ...base, amountMicroUsd: owlsToMicro(500), headroomMicroUsd: -owlsToMicro(10) });
    if (!negative.ok) expect(negative.message).toMatch(/headroom is 0 owls/);
  });
});

describe("the reserve and the owl formatting", () => {
  it("mints the configured fraction of the bounty, floored", () => {
    expect(reserveMicroUsdFor(owlsToMicro(500), 0.1)).toBe(owlsToMicro(50));
    expect(reserveMicroUsdFor(1_000_001, 0.1)).toBe(100_000);
    expect(reserveMicroUsdFor(owlsToMicro(500), 0)).toBe(0);
  });

  it("renders owls with grouping, a fraction only when needed, and never a dollar sign", () => {
    expect(formatOwls(owlsToMicro(2500))).toBe("2,500 owls");
    expect(formatOwls(owlsToMicro(1000))).toBe("1,000 owls");
    expect(formatOwls(owlsToMicro(250))).toBe("250 owls");
    expect(formatOwls(owlsToMicro(12.5))).toBe("12.5 owls");
    expect(formatOwls(owlsToMicro(84.5))).toBe("84.5 owls");
    expect(formatOwls(0)).toBe("0 owls");
    expect(formatOwls(owlsToMicro(1))).toBe("1 owl");
    expect(formatOwls(owlsToMicro(0.42))).toBe("0.42 owls");
    expect(formatOwls(owlsToMicro(2500))).not.toContain("$");
  });

  it("converts between owls and micro-USD at cost", () => {
    expect(owlsToMicro(500)).toBe(500_000_000);
    expect(microToOwls(500_000_000)).toBe(500);
    expect(microToOwls(12_500_000)).toBe(12.5);
  });

  it("names the count in the closure refusal", () => {
    expect(closureBlockedMessage(1)).toMatch(/1 live bounty held/);
    expect(closureBlockedMessage(3)).toMatch(/3 live bounties held/);
    expect(closureBlockedMessage(3)).toMatch(/withdraw_bounty gives thirty days' notice/);
  });
});

describe("the state sentence", () => {
  const opened = new Date("2026-03-12T00:00:00Z");
  const base = { amountMicroUsd: owlsToMicro(2500), openedAt: opened, withdrawEffectiveAt: null, liveClaim: null, awarded: null };
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
    expect(bountyStateSentence({ ...base, status: "paid", awarded: { credit_name: "Ada", paid_at: new Date("2026-05-01T00:00:00Z"), amount_micro_usd: owlsToMicro(2500) } })).toBe(
      "Settled by a checked proof submitted by Ada on 1 May 2026; prize of 2,500 owls paid."
    );
    expect(bountyStateSentence({ ...base, status: "resolved_internally" })).toMatch(/Minerval's own solver/);
    expect(bountyStateSentence({ ...base, status: "resolved_unpaid" })).toMatch(/no eligible claimant/);
    expect(bountyStateSentence({ ...base, status: "rebinding" })).toMatch(/revised after this prize was posted/);
    expect(bountyStateSentence({ ...base, status: "open", withdrawEffectiveAt: new Date("2026-04-11T00:00:00Z") })).toMatch(/withdrawn from 11 April 2026/);
  });
});
