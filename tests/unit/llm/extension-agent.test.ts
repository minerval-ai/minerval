import { describe, it, expect } from "vitest";
import { getAssessorSystemPrompt } from "../../../src/llm/prompts/extension-agent.js";

describe("extension prompts", () => {
  it("tell the assessor how a quantity and a question are judged", () => {
    const assessor = getAssessorSystemPrompt();
    expect(assessor).toMatch(/compare the page's figure with the graph's estimate/);
    expect(assessor).toMatch(/standing/);
  });

  it("gate 'egregious' on a confident assessment, not a numeric threshold", () => {
    expect(getAssessorSystemPrompt()).not.toMatch(/at least 0\.8/);
  });
});
