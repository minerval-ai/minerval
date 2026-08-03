import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { complete, completeStructured } from "../../../../src/llm/client.js";
import { getAdapter } from "../../../../src/llm/providers/index.js";
import { MODELS } from "../../../../src/llm/models.js";

describe("getAdapter", () => {
  it("hands each ID shape to the adapter that serves it", () => {
    expect(getAdapter(MODELS.sonnet).name).toBe("anthropic");
    expect(getAdapter("gpt-5-nano").name).toBe("openai");
    expect(getAdapter("o3").name).toBe("openai");
    expect(getAdapter("qwen/qwen3-235b-a22b").name).toBe("openrouter");
  });

  it("throws on an ID that matches no shape", () => {
    expect(() => getAdapter("llama-3-70b")).toThrow(/does not resolve/);
    expect(() => getAdapter("us.anthropic.claude-sonnet-5")).toThrow(/Bedrock/);
  });
});

describe("the seam fails at call time on an unroutable model", () => {
  it("complete() names the accepted shapes", async () => {
    await expect(
      complete({ messages: [{ role: "user", content: "hi" }], model: "gemini-2.5-pro" })
    ).rejects.toThrow(/does not resolve to a known provider/);
  });

  it("completeStructured() names the accepted shapes", async () => {
    await expect(
      completeStructured({
        messages: [{ role: "user", content: "hi" }],
        schema: { type: "object", properties: {}, required: [], additionalProperties: false },
        schemaName: "Thing",
        model: "us.anthropic.claude-sonnet-5",
      })
    ).rejects.toThrow(/Bedrock/);
  });
});
