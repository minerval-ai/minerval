import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The loop's running turn counter and default budget notice (#474): every
 * tool-result message says where the agent stands, and an agent that set no
 * notice of its own still hears, two turns out, that unrecorded work is lost.
 */

const createMock = vi.fn();
const betaCreateMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: betaCreateMock } };
  },
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ anthropicApiKey: "test-key" }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { toolUseLoop, turnCounterLine } from "../../../src/llm/client.js";
import { MODELS } from "../../../src/llm/models.js";

const search = {
  content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "tool_use",
  container: null,
};
const done = {
  content: [{ type: "text", text: "Done." }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "end_turn",
  container: null,
};
const tools = [{ name: "search", description: "d", input_schema: { type: "object" as const } }];

// The text blocks appended after the tool results of the user message the
// n-th model call received (n is 1-based).
function trailingText(n: number): string[] {
  const req = createMock.mock.calls[n - 1]![0];
  const last = req.messages.at(-1);
  return (last.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text!);
}

beforeEach(() => {
  createMock.mockReset();
});

describe("toolUseLoop turn counter", () => {
  it("appends a running counter to every tool-result message", async () => {
    createMock
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(done);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 6,
      executeTool: async () => "ok",
    });
    expect(trailingText(2)[0]).toBe("Turn 1 of 6 used; 5 remain.");
    expect(trailingText(3)[0]).toBe("Turn 2 of 6 used; 4 remain.");
    expect(turnCounterLine(3, 6)).toBe("Turn 3 of 6 used; 3 remain.");
  });

  it("lets the caller replace the counter's line with its own, and runs beforeTurn before every call", async () => {
    createMock
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(done);
    const before: number[] = [];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 6,
      executeTool: async () => "ok",
      turnNote: (used, max) => `Spent this much after ${used} of ${max}.`,
      beforeTurn: (turn) => {
        before.push(turn);
      },
    });
    expect(trailingText(2)[0]).toBe("Spent this much after 1 of 6.");
    expect(trailingText(3)[0]).toBe("Spent this much after 2 of 6.");
    expect(before).toEqual([0, 1, 2]);
  });

  it("ends the loop when beforeTurn throws, before the call", async () => {
    createMock.mockResolvedValue(search);
    await expect(
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        model: MODELS.haiku,
        maxIterations: 6,
        executeTool: async () => "ok",
        beforeTurn: (turn) => {
          if (turn === 1) throw new Error("stop");
        },
      })
    ).rejects.toThrow("stop");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("adds the default budget notice two turns out when the agent set none", async () => {
    createMock
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(search)
      .mockResolvedValueOnce(done);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool: async () => "ok",
    });
    // After turn 1, three remain: counter only.
    expect(trailingText(2)).toHaveLength(1);
    // After turn 2, two remain: counter, then the notice.
    expect(trailingText(3)).toHaveLength(2);
    expect(trailingText(3)[1]).toMatch(/^Budget notice: 2 tool-use turn\(s\) remain/);
    expect(trailingText(3)[1]).toMatch(/concluding tool call/);
    expect(trailingText(4)[1]).toMatch(/^Budget notice: 1 tool-use turn\(s\) remain/);
  });

  it("uses the agent's own notice over the default, and can drop the counter", async () => {
    createMock.mockResolvedValueOnce(search).mockResolvedValueOnce(done);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 2,
      turnCounter: false,
      iterationBudgetNotice: { warnWithin: 1, message: (r) => `Mine: ${r}` },
      executeTool: async () => "ok",
    });
    expect(trailingText(2)).toEqual(["Mine: 1"]);
  });
});
