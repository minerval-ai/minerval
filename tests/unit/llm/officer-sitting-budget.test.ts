import { describe, it, expect, vi } from "vitest";

// A program officer's brief states its sitting's own budget apart from what it
// may commit (#1049): an officer read a 1-owl sitting budget as a cap on a
// 5.5-owl pass its 6-owl limit allowed, and escalated it.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));

import { COMMISSION_FOR_MANDATE, sittingBudgetSentence } from "../../../src/llm/agents/program-officer.js";
import { owlsToMicroUsd } from "../../../src/services/owl.js";

describe("the officer brief's budget sentence", () => {
  it("states the sitting's budget and the per-decision limit as different figures", () => {
    const s = sittingBudgetSentence(owlsToMicroUsd(1), owlsToMicroUsd(6));
    expect(s).toMatch(/This sitting has a budget of 1 owl \(\$1\.00\)/);
    expect(s).toMatch(/pays only for your own reading and deciding/);
    expect(s).toMatch(/not a limit on what you commit/);
    expect(s).toMatch(/paid from the mandate's escrow, not this sitting's budget, up to 6 owls in one decision/);
  });

  it("leaves the limit out for a run with none, and says nothing without a budget", () => {
    expect(sittingBudgetSentence(owlsToMicroUsd(2), null)).not.toMatch(/in one decision/);
    expect(sittingBudgetSentence(null, owlsToMicroUsd(6))).toBe("");
  });

  it("tells the commission tool its runs are paid from the escrow, not the run's budget", () => {
    expect(COMMISSION_FOR_MANDATE.description).toMatch(/mandate's escrow, not this run's own budget/);
  });
});
