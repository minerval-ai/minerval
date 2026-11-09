import { describe, it, expect, vi, beforeEach } from "vitest";

// What a session needs from the loop (session-service.ts): input that
// arrived mid-run shown in the next tool result, and the whole conversation
// handed back when the loop ends, so a run that pauses can resume from it.

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: vi.fn() } };
  },
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => ({ anthropicApiKey: "test-key" }) }));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn(), recordUsage: vi.fn() }));

import { toolUseLoop } from "../../../src/llm/client.js";
import { MODELS } from "../../../src/llm/models.js";

const call = {
  content: [{ type: "tool_use", id: "t1", name: "look", input: {} }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "tool_use",
  container: null,
};
const done = {
  content: [{ type: "text", text: "Waiting for the report." }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "end_turn",
  container: null,
};
const tools = [{ name: "look", description: "d", input_schema: { type: "object" as const } }];

beforeEach(() => createMock.mockReset());

describe("toolUseLoop and sessions", () => {
  it("shows what arrived mid-run in the next tool result, once", async () => {
    createMock.mockResolvedValueOnce(call).mockResolvedValueOnce(call).mockResolvedValueOnce(done);
    const arrivals = ["## Arrived while you worked\n\nThe report.", null];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 5,
      executeTool: async () => "ok",
      pendingInput: async () => arrivals.shift() ?? null,
    });
    const second = JSON.stringify(createMock.mock.calls[1]![0].messages.at(-1).content);
    expect(second).toContain("Arrived while you worked");
    const third = JSON.stringify(createMock.mock.calls[2]![0].messages.at(-1).content);
    expect(third).not.toContain("Arrived while you worked");
  });

  it("hands back the whole conversation, the final turn included", async () => {
    createMock.mockResolvedValueOnce(call).mockResolvedValueOnce(done);
    let transcript: unknown[] = [];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 5,
      executeTool: async () => "ok",
      onEnd: (t) => {
        transcript = t;
      },
    });
    expect(transcript.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(transcript.at(-1))).toContain("Waiting for the report.");
  });
});
