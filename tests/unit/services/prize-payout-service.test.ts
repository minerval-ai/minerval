/**
 * The pure payout rules (docs/mathematics.md §8.7, §8.9): withholding,
 * the tranche schedule and its keys, and the refusal before the window
 * ends, without an audit outcome, without sign-off where required, and
 * before the payee steps.
 */
import { describe, it, expect } from "vitest";
import {
  withholdingMicroUsd,
  trancheSchedule,
  trancheKey,
  payRefusal,
} from "../../../src/services/prize-payout-service.js";

const USD = 1_000_000;

describe("withholding", () => {
  it("is 30 percent for a non-U.S. person with no treaty position", () => {
    expect(withholdingMicroUsd(1000 * USD, { usPerson: false, hasTin: false, treatyPosition: false })).toBe(300 * USD);
    expect(withholdingMicroUsd(1000 * USD, { usPerson: false, hasTin: true, treatyPosition: false })).toBe(300 * USD);
  });
  it("is zero for a non-U.S. person with a treaty position", () => {
    expect(withholdingMicroUsd(1000 * USD, { usPerson: false, hasTin: false, treatyPosition: true })).toBe(0);
  });
  it("is 24 percent backup withholding for a U.S. person without a TIN, else zero", () => {
    expect(withholdingMicroUsd(1000 * USD, { usPerson: true, hasTin: false, treatyPosition: false })).toBe(240 * USD);
    expect(withholdingMicroUsd(1000 * USD, { usPerson: true, hasTin: true, treatyPosition: false })).toBe(0);
  });
});

describe("the tranche schedule", () => {
  const paidAt = new Date("2026-05-01T09:00:00Z");
  it("writes one tranche at or under the size, keyed prize:<id>:owls", () => {
    const s = trancheSchedule("pc1", 1500 * USD, paidAt, 2000);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ index: 0, amount_micro_usd: 1500 * USD, idempotency_key: "prize:pc1:owls", due_at: paidAt.toISOString() });
  });
  it("splits a larger grant into daily tranches of at most the size, in order, with numbered keys", () => {
    const s = trancheSchedule("pc1", 5000 * USD, paidAt, 2000);
    expect(s.map((t) => t.amount_micro_usd)).toEqual([2000 * USD, 2000 * USD, 1000 * USD]);
    expect(s.map((t) => t.idempotency_key)).toEqual(["prize:pc1:owls", "prize:pc1:owls:2", "prize:pc1:owls:3"]);
    expect(s.map((t) => t.due_at)).toEqual([
      "2026-05-01T09:00:00.000Z",
      "2026-05-02T09:00:00.000Z",
      "2026-05-03T09:00:00.000Z",
    ]);
    expect(trancheKey("pc1", 0)).toBe("prize:pc1:owls");
  });
  it("is empty for nothing", () => {
    expect(trancheSchedule("pc1", 0, paidAt, 2000)).toEqual([]);
  });
});

describe("payPrize's refusals", () => {
  const steps = {
    identity_recorded_at: "2026-05-01T00:00:00Z",
    tax_form_recorded_at: "2026-05-01T00:00:00Z",
    screening_result: "clear",
  };
  const ready = { status: "payable", windowElapsed: true, auditOutcome: "clear", signoffRequired: false, signedOff: false, payee: steps };

  it("pays a ready claim", () => {
    expect(payRefusal(ready)).toBeNull();
    expect(payRefusal({ ...ready, status: "defect_award_pending" })).toBeNull();
  });
  it("refuses unless payable", () => {
    expect(payRefusal({ ...ready, status: "in_challenge_window" })?.code).toBe("NOT_PAYABLE");
    expect(payRefusal({ ...ready, status: "paid" })?.code).toBe("ALREADY_PAID");
  });
  it("refuses before the window ends", () => {
    expect(payRefusal({ ...ready, windowElapsed: false })?.code).toBe("WINDOW_OPEN");
  });
  it("refuses without an audit outcome, and after a send-back", () => {
    expect(payRefusal({ ...ready, auditOutcome: null })?.code).toBe("AUDIT_OUTCOME_MISSING");
    expect(payRefusal({ ...ready, auditOutcome: "send_back" })?.code).toBe("AUDIT_SEND_BACK");
  });
  it("refuses without sign-off where required, and passes once recorded", () => {
    expect(payRefusal({ ...ready, signoffRequired: true })?.code).toBe("SIGNOFF_REQUIRED");
    expect(payRefusal({ ...ready, signoffRequired: true, signedOff: true })).toBeNull();
  });
  it("refuses before each payee step, and on a screening that is not clear", () => {
    expect(payRefusal({ ...ready, payee: null })?.code).toBe("PAYEE_STEPS_INCOMPLETE");
    expect(payRefusal({ ...ready, payee: { ...steps, identity_recorded_at: undefined } })?.code).toBe("PAYEE_STEPS_INCOMPLETE");
    expect(payRefusal({ ...ready, payee: { ...steps, tax_form_recorded_at: undefined } })?.code).toBe("PAYEE_STEPS_INCOMPLETE");
    expect(payRefusal({ ...ready, payee: { ...steps, screening_result: null } })?.code).toBe("PAYEE_STEPS_INCOMPLETE");
    expect(payRefusal({ ...ready, payee: { ...steps, screening_result: "potential_match" } })?.message).toMatch(/potential_match/);
  });
});
