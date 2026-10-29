import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A pass's budget (withPassBudget), shown to its agent: the tool loop
 * appends the spend line after every turn and a notice when most of it, and
 * when all of it, is spent; the task message states it up front; and a paid
 * tool declines a call the remainder cannot cover.
 */

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: vi.fn() } };
  },
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ anthropicApiKey: "test-key" }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { toolUseLoop } from "../../../src/llm/client.js";
import { MODELS } from "../../../src/llm/models.js";
import {
  budgetRefusal,
  getUsageContext,
  runBudget,
  withCostMeter,
  withPassBudget,
} from "../../../src/llm/usage-context.js";
import { turnBudgetLine } from "../../../src/llm/prompts/turn-budget.js";
import { actionBudgetMicroUsd } from "../../../src/services/action-service.js";

const search = {
  content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "tool_use",
  container: null,
};
const done = {
  content: [{ type: "text", text: "Done." }],
  usage: { input_tokens: 0, output_tokens: 0 },
  stop_reason: "end_turn",
  container: null,
};
const tools = [{ name: "search", description: "d", input_schema: { type: "object" as const } }];

function trailingText(n: number): string[] {
  const req = createMock.mock.calls[n - 1]![0];
  const last = req.messages.at(-1);
  return (last.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text!);
}

// Each tool call spends this much, so the test controls the meter exactly.
const spend = (micro: number) => async () => {
  getUsageContext().meter!.billedMicroUsd += micro;
  return "ok";
};

beforeEach(() => {
  createMock.mockReset();
});

describe("the run budget on the meter", () => {
  it("is absent without a pass budget, and reads spend against it with one", async () => {
    expect(runBudget()).toBeNull();
    await withCostMeter(async () => expect(runBudget()).toBeNull());
    await withPassBudget({ microUsd: 1_000_000, source: "the test" }, async () => {
      getUsageContext().meter!.billedMicroUsd += 300_000;
      expect(runBudget()).toEqual({
        ceilingMicroUsd: 1_000_000,
        source: "the test",
        spentMicroUsd: 300_000,
        remainingMicroUsd: 700_000,
      });
    });
  });

  it("lets a paid call through when it fits, and says what it costs and what is left when not", async () => {
    expect(budgetRefusal("A search", 5_000_000)).toBeNull();
    await withPassBudget({ microUsd: 500_000, source: "the test" }, async () => {
        expect(budgetRefusal("A search", 400_000)).toBeNull();
        const out = JSON.parse(budgetRefusal("Elicit", 2_000_000)!);
        expect(out.success).toBe(false);
        expect(out.message).toContain("Elicit would cost about $2.00");
        expect(out.message).toContain("$0.50 of its $0.50 budget left");
      });
  });

  it("covers an action for what its funders put up, or its estimate when that is more", () => {
    expect(actionBudgetMicroUsd({ cost_est_micro_usd: 1_400_000, coverage_micro_usd: 2_000_000 })).toBe(2_000_000);
    expect(actionBudgetMicroUsd({ cost_est_micro_usd: "1400000", coverage_micro_usd: "0" })).toBe(1_400_000);
  });
});

describe("the task message", () => {
  it("leads with the budget when the run has one, and keeps the turn guard separate", async () => {
    expect(turnBudgetLine(12)).toMatch(/^Budget: you have up to 12 tool-use turns/);
    await withPassBudget({ microUsd: 1_400_000, source: "the allocations funding this pass" }, async () => {
        const line = turnBudgetLine(200);
        expect(line).toMatch(
          /^Budget: This run has a budget of \$1\.40 \(the allocations funding this pass\), metered at real cost/
        );
        expect(line).toContain("It is what you may spend, not what you should");
        expect(line).toContain("Separately, you have up to 200 tool-use turns");
      });
  });
});

describe("toolUseLoop with a budget", () => {
  it("shows the spend before the turn counter after every turn, and warns near the end and at the end", async () => {
    createMock
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(done);
    await withPassBudget({ microUsd: 1_000_000, source: "the test" }, () =>
        toolUseLoop({
          initialMessages: [{ role: "user", content: "go" }],
          tools,
          model: MODELS.haiku,
          maxIterations: 200,
          executeTool: spend(450_000),
        }));
    const first = trailingText(2);
    expect(first[0]).toBe(
      "Budget: $0.45 of $1.00 spent (45%). Your last turn cost $0.45; at that rate about 1 turn " +
        "remain, fewer as the conversation grows. Turn 1 of 200 used; 199 remain."
    );
    expect(first).toHaveLength(1);
    // Past 85%: the spend line, then the wrap-up notice, once.
    const second = trailingText(3);
    expect(second[0]).toMatch(/^Budget: \$0\.90 of \$1\.00 spent \(90%\)/);
    expect(second[1]).toMatch(/^Budget notice: most of this run's budget is spent/);
    const third = trailingText(4);
    expect(third[0]).toMatch(/^Budget: \$1\.35 of \$1\.00 spent \(100%\)\. Turn 3 of 200/);
    expect(third[1]).toMatch(/^Budget notice: this run has spent its whole budget/);
    expect(third).toHaveLength(2);
  });

  it("shows only the turn counter when the run has no budget", async () => {
    createMock.mockResolvedValueOnce(search).mockResolvedValueOnce(done);
    await withCostMeter(() =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        model: MODELS.haiku,
        maxIterations: 6,
        executeTool: spend(450_000),
      })
    );
    expect(trailingText(2)).toEqual(["Turn 1 of 6 used; 5 remain."]);
  });
});
