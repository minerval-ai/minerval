import { describe, it, expect, vi } from "vitest";

/**
 * What a Grantmaker's own pass is told about its budget (#820): whose
 * figure it is and why, that it is held against the day while the pass
 * runs, how to add to it, and, with figures, when the pass was started
 * short. And that the budget line no longer tells these passes their
 * budget is "the high end of what work like this usually costs".
 */

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({ owlCostMicroUsd: 1_000_000 }),
}));

import { planningPassBudgetBasis, reviewPassBudgetBasis } from "../../../../src/llm/prompts/pass-budget.js";
import { turnBudgetLine } from "../../../../src/llm/prompts/turn-budget.js";
import { withPassBudget } from "../../../../src/llm/usage-context.js";

const facts = (over: Partial<Parameters<typeof reviewPassBudgetBasis>[0]> = {}) => ({
  ceilingMicroUsd: 5_000_000,
  figure: { microUsd: 5_000_000, fromPolicy: false, reason: "the platform's default until the Grantmaker sets one" },
  fromShare: false,
  floorOwls: 1,
  windowMicroUsd: 25_000_000,
  windowUsedMicroUsd: 9_000_000,
  escrowFreeMicroUsd: 400_000_000,
  ...over,
});

describe("reviewPassBudgetBasis", () => {
  it("says the default is the platform's, why it applies, and that the figure is the Grantmaker's to set", () => {
    const b = reviewPassBudgetBasis(facts());
    expect(b).toContain("the platform's default for a review pass, 5 owls");
    expect(b).toContain("because your operating policy names none");
    expect(b).toContain("review_pass_owls in write_operating_policy");
    expect(b).toContain("held against your pace's window while this pass runs");
    expect(b).toContain("opening turn");
    expect(b).toContain("add_to_pass_budget");
    expect(b).not.toContain("started with less");
  });

  it("names the policy's own figure with the Grantmaker's reason", () => {
    const b = reviewPassBudgetBasis(
      facts({ ceilingMicroUsd: 8_000_000, figure: { microUsd: 8_000_000, fromPolicy: true, reason: "A survey and valuations cost about eight." } })
    );
    expect(b).toContain("review_pass_owls in your operating policy, 8 owls (A survey and valuations cost about eight.)");
    expect(b).not.toContain("platform's default");
  });

  it("states a short start with the figures and the floor", () => {
    const b = reviewPassBudgetBasis(
      facts({
        ceilingMicroUsd: 3_000_000,
        figure: { microUsd: 8_000_000, fromPolicy: true, reason: "r" },
        windowMicroUsd: 10_000_000,
        windowUsedMicroUsd: 10_000_000,
        escrowFreeMicroUsd: 40_000_000,
      })
    );
    expect(b).toContain("This pass was started with less than that, 3 owls");
    expect(b).toContain("10 of 10 owls of the pace's window are committed, this pass's budget included");
    expect(b).toContain("40 owls of escrow are uncommitted");
    expect(b).toContain("at least 1 owls can be found");
    expect(b).toContain("the pace is the funder's to change");
  });

  it("speaks of the escrow alone for a mandate with no daily rate", () => {
    const b = reviewPassBudgetBasis(facts({ windowMicroUsd: null, windowUsedMicroUsd: null }));
    expect(b).toContain("held from your escrow while this pass runs");
    expect(b).not.toContain("pace's window");
    expect(b).not.toContain("the pace is the funder's to change");
  });

  it("tells a decomposition its share is the bound, and offers no addition", () => {
    const b = reviewPassBudgetBasis(facts({ fromShare: true }));
    expect(b).toContain("Grantmaker share");
    expect(b).toContain("no adding to it");
    expect(b).not.toContain("add_to_pass_budget");
  });
});

describe("planningPassBudgetBasis", () => {
  const plan = (over: Partial<Parameters<typeof planningPassBudgetBasis>[0]> = {}) => ({
    ceilingMicroUsd: 5_000_000,
    defaultMicroUsd: 5_000_000,
    fromShare: false,
    floorOwls: 1,
    escrowMicroUsd: 100_000_000,
    ...over,
  });

  it("says why a planning pass works to the platform's default", () => {
    const b = planningPassBudgetBasis(plan());
    expect(b).toContain("the platform's default for a Grantmaker's pass, 5 owls");
    expect(b).toContain("before the mandate has an operating policy");
    expect(b).toContain("cannot be added to during the pass");
  });

  it("states a short start against a small escrow", () => {
    const b = planningPassBudgetBasis(plan({ ceilingMicroUsd: 2_000_000, escrowMicroUsd: 2_000_000 }));
    expect(b).toContain("started with less than that, 2 owls");
    expect(b).toContain("the mandate's escrow is 2 owls");
  });

  it("names the share for a decomposition", () => {
    expect(planningPassBudgetBasis(plan({ fromShare: true }))).toContain("half of this mandate's Grantmaker share");
  });
});

describe("the budget line with a basis", () => {
  it("replaces the costing-estimate sentence, and keeps the rest", async () => {
    const { value: line } = await withPassBudget(
      { microUsd: 5_000_000, source: "the mandate's allocation for this pass" },
      async () => turnBudgetLine(200, { basis: "It is your mandate's own figure." })
    );
    expect(line).toContain("This run has a budget of $5.00, from the mandate's allocation for this pass. It is your mandate's own figure. Use what the work needs");
    expect(line).not.toContain("for doing this work properly");
    expect(line).not.toContain("high end of what work like this usually costs");
    expect(line).toContain("metered at real cost");
  });

  it("says what the budget is for to every other agent", async () => {
    const { value: line } = await withPassBudget({ microUsd: 2_000_000, source: "a commission" }, async () =>
      turnBudgetLine(200)
    );
    expect(line).toContain("This run has a budget of $2.00, from a commission, for doing this work properly. Use what the work needs");
    // The old sentence taught runs to finish well inside their budgets.
    expect(line).not.toContain("most runs finish well inside it");
  });
});
