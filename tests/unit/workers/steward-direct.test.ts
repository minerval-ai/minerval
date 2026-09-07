import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Direct invocation of the Steward on the money triggers (docs/mathematics.md
 * §6.4): the strong model, the funding job's usage context, never the
 * queue, and the refusal when the claim's recorded domains activate no
 * skill carrying the trigger's tools (§3.4): a money run without its own
 * tool would decide nothing.
 */
const mocks = vi.hoisted(() => ({
  runClaimSteward: vi.fn(async () => undefined),
  config: { stewardStrongModel: "strong-model", stewardModel: "standard-model", env: "development" as string },
  skills: [] as Array<{ name: string }>,
  toolsByRole: { "claim-steward": [] as string[] },
}));

vi.mock("../../../src/llm/agents/claim-steward.js", () => ({ runClaimSteward: mocks.runClaimSteward }));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));
vi.mock("../../../src/llm/agents/skill-selection.js", () => ({
  skillsForClaim: vi.fn(async () => mocks.skills),
}));
vi.mock("../../../src/llm/tools/skill-tools.js", () => ({
  getActiveSkillToolDefinitions: vi.fn((skills: Array<{ name: string }>, role: "claim-steward") =>
    skills.length > 0 ? mocks.toolsByRole[role].map((name) => ({ name, description: "", input_schema: {} })) : []
  ),
}));

import { getUsageContext } from "../../../src/llm/usage-context.js";
import {
  invokeStewardDirect,
  isMoneyTrigger,
  missingTriggerTools,
  moneyTriggerModel,
  MONEY_TRIGGERS,
  REQUIRED_TOOLS_BY_TRIGGER,
} from "../../../src/workers/steward-direct.js";

const MATHEMATICS_TOOLS = [
  "lean_search",
  "lean_elaborate",
  "lean_check",
  "publish_formalization",
  "get_proof_attempt",
  "mark_problem_solved_by_platform",
  "get_prize_claim",
  "decide_prize_claim",
];

describe("invokeStewardDirect", () => {
  beforeEach(() => {
    mocks.runClaimSteward.mockClear();
    mocks.config.stewardStrongModel = "strong-model";
    mocks.config.env = "development";
    mocks.skills = [{ name: "mathematics" }];
    mocks.toolsByRole["claim-steward"] = [...MATHEMATICS_TOOLS];
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

describe("the trigger's tools must come from the claim's skills (§3.4)", () => {
  beforeEach(() => {
    mocks.runClaimSteward.mockClear();
    mocks.config.stewardStrongModel = "strong-model";
    mocks.config.env = "development";
    mocks.skills = [{ name: "mathematics" }];
    mocks.toolsByRole["claim-steward"] = [...MATHEMATICS_TOOLS];
  });

  it("requires the writing tool each trigger exists to reach", () => {
    expect(REQUIRED_TOOLS_BY_TRIGGER).toEqual({
      formalize: ["publish_formalization"],
      formalization_review: ["publish_formalization"],
      prize_claim: ["get_prize_claim", "decide_prize_claim"],
      prize_claim_voided: ["get_prize_claim"],
      prize_window_closed: ["get_prize_claim"],
      attempt_completed: ["get_proof_attempt"],
    });
  });

  it("refuses every money trigger on an untagged claim, loudly, and never runs the model", async () => {
    mocks.skills = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const trigger of MONEY_TRIGGERS) {
      await expect(invokeStewardDirect({ trigger, claimId: "c-untagged", context: "x" })).rejects.toThrow(
        new RegExp(`refusing the ${trigger} trigger on claim c-untagged: its recorded domains activate no skill`)
      );
    }
    expect(mocks.runClaimSteward).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(MONEY_TRIGGERS.length);
    expect(String(error.mock.calls[0]![0])).toMatch(/\[steward-direct\] refusing the formalize trigger .*\(set_claim_domains\)/);
    error.mockRestore();
  });

  it("names the skills that are active and the tools they lack", async () => {
    mocks.skills = [{ name: "mathematics" }];
    mocks.toolsByRole["claim-steward"] = ["lean_search", "get_prize_claim"];
    const missing = await missingTriggerTools("prize_claim", "c1");
    expect(missing).toEqual({ skills: ["mathematics"], active: ["lean_search", "get_prize_claim"], missing: ["decide_prize_claim"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(invokeStewardDirect({ trigger: "prize_claim", claimId: "c1", context: "x" })).rejects.toThrow(
      /the skill\(s\) mathematics, which carry none of decide_prize_claim/
    );
    error.mockRestore();
    expect(mocks.runClaimSteward).not.toHaveBeenCalled();
  });

  it("runs when the claim's skills carry the trigger's tools", async () => {
    for (const trigger of MONEY_TRIGGERS) {
      await invokeStewardDirect({ trigger, claimId: "c1", context: "x" });
    }
    expect(mocks.runClaimSteward).toHaveBeenCalledTimes(MONEY_TRIGGERS.length);
  });
});
