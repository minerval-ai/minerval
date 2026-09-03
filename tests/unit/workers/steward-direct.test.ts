import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runClaimSteward: vi.fn(async () => undefined),
  config: { stewardStrongModel: "strong-model", stewardModel: "standard-model", env: "development" as string },
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({ runClaimSteward: mocks.runClaimSteward }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import { getUsageContext } from "../../../src/llm/usage-context.js";
import { invokeStewardDirect, isMoneyTrigger, moneyTriggerModel, MONEY_TRIGGERS } from "../../../src/workers/steward-direct.js";

describe("invokeStewardDirect", () => {
  beforeEach(() => {
    mocks.runClaimSteward.mockClear();
    mocks.config.stewardStrongModel = "strong-model";
    mocks.config.env = "development";
  });

  it("names exactly the six money triggers", () => {
    expect([...MONEY_TRIGGERS]).toEqual(["formalize", "formalization_review", "prize_claim", "prize_claim_voided", "prize_window_closed", "attempt_completed"]);
    expect(isMoneyTrigger("prize_claim")).toBe(true);
    expect(isMoneyTrigger("steward_reassessment")).toBe(false);
  });

  it("runs the Steward on the strong model under the funding job, never through the queue", async () => {
    let seen: ReturnType<typeof getUsageContext> | null = null;
    mocks.runClaimSteward.mockImplementationOnce(async () => {
      seen = getUsageContext();
    });
    const out = await invokeStewardDirect({ trigger: "prize_claim", claimId: "c1", context: "prize claim pc1", jobId: "job1" });
    expect(out.model).toBe("strong-model");
    expect(mocks.runClaimSteward).toHaveBeenCalledWith({ trigger: "prize_claim", claimId: "c1", context: "prize claim pc1", model: "strong-model" });
    expect(seen).toMatchObject({ jobId: "job1", claimId: "c1" });
  });

  it("refuses a non-money trigger", async () => {
    await expect(invokeStewardDirect({ trigger: "steward_reassessment" as never, claimId: "c", context: "" })).rejects.toThrow(/not a money trigger/);
    expect(mocks.runClaimSteward).not.toHaveBeenCalled();
  });

  it("refuses to run in production without the strong model, and falls back only in development", () => {
    mocks.config.stewardStrongModel = "";
    mocks.config.env = "production";
    expect(() => moneyTriggerModel("attempt_completed")).toThrow(/STEWARD_STRONG_MODEL/);
    mocks.config.env = "development";
    expect(moneyTriggerModel("attempt_completed")).toBe("standard-model");
  });
});
