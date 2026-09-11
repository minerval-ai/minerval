import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Matcher accepts a submitted decision only when it is whole. Providers
 * that do not enforce tool schemas (GLM 5.3 Flash on OpenRouter, observed on
 * the golden pairs) can submit a decision that names the matched claim in its
 * reasoning yet carries no is_match / matched_claim_id; read as-is, that is
 * silently "no match". The Matcher refuses the call and the model resubmits.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: null as null | Record<string, any>,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ matcherModel: "z-ai/glm-5.3-flash", matchingTopK: 20 }),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: Record<string, any>) => {
    mocks.loopOptions = opts;
    return { content: "", toolUses: [], stopReason: "end_turn" };
  }),
}));
vi.mock("../../../src/llm/prompts/matcher.js", () => ({
  getMatcherSystemPromptBlocks: () => ["system"],
  getMatchingPrompt: () => "prompt",
}));
vi.mock("../../../src/llm/prompts/skills.js", () => ({ skillsForDomains: () => [] }));
vi.mock("../../../src/services/embedding-service.js", () => ({ generateEmbedding: vi.fn() }));
vi.mock("../../../src/services/search-service.js", () => ({ findSimilarClaims: vi.fn() }));
vi.mock("../../../src/llm/usage-context.js", () => ({
  withAgent: (_: string, fn: () => unknown) => fn(),
  withSkills: (_: string[], fn: () => unknown) => fn(),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [], execute: async () => null }),
}));

import { matchClaim } from "../../../src/llm/agents/matcher.js";

const whole = {
  is_match: true,
  matched_claim_id: "5c25a52c",
  new_canonical_form: null,
  instance_stance: "affirms",
  direction_note: null,
  confidence: 0.93,
  reasoning: "same proposition",
  alternative_matches: [],
  relationship_notes: null,
};

beforeEach(() => {
  mocks.loopOptions = null;
});

describe("Matcher decision validation", () => {
  it("refuses a submission with no is_match, telling the model to resubmit", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    const { is_match: _omitted, matched_claim_id: _also, ...defective } = whole;

    expect(onFinalTool("submit_match_decision", defective)).toBeNull();
    const reply = JSON.parse(await executeTool("submit_match_decision", defective));
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("is_match");
  });

  it("refuses a match that names no claim", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool } = mocks.loopOptions!;
    const reply = JSON.parse(
      await executeTool("submit_match_decision", { ...whole, matched_claim_id: null })
    );
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("matched_claim_id");
  });

  it("accepts a whole decision as final", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    expect(onFinalTool("submit_match_decision", whole)).toEqual(whole);
    expect(JSON.parse(await executeTool("submit_match_decision", whole)).success).toBe(true);
  });

  it("still defaults to a new claim when nothing whole was ever submitted", async () => {
    const decision = await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    expect(decision.is_match).toBe(false);
    expect(decision.confidence).toBe(0.3);
  });
});
