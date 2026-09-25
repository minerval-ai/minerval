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
vi.mock("../../../src/services/search-service.js", () => ({
  findSimilarClaims: vi.fn(async () => RETRIEVED),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  withAgent: (_: string, fn: () => unknown) => fn(),
  withSkills: (_: string[], fn: () => unknown) => fn(),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [], execute: async () => null }),
}));

import { matchClaim } from "../../../src/llm/agents/matcher.js";

// What the one search in each test returns: the Matcher's searches are its
// only source of ids, so a submission may name only these (#470).
const MATCHED = "5c25a52c-1a1a-4b2b-8c3c-0d0d0d0d0d0d";
const NEIGHBOUR = "f02c5d2d-bc3e-43ab-9dba-f9546f1a856e";
const OTHER = "5b6a73ad-ba15-47ca-b86f-8a401fcb0848";
const RETRIEVED = [MATCHED, NEIGHBOUR, OTHER].map((id, i) => ({
  id,
  text: `claim ${i}`,
  similarity_score: 0.9 - i * 0.1,
}));

const whole = {
  is_match: true,
  matched_claim_id: MATCHED,
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
    await executeTool("search_similar_claims", { query: "x" });
    const { is_match: _omitted, matched_claim_id: _also, ...defective } = whole;

    expect(onFinalTool("submit_match_decision", defective)).toBeNull();
    const reply = JSON.parse(await executeTool("submit_match_decision", defective));
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("is_match");
  });

  it("refuses a match that names no claim", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    const reply = JSON.parse(
      await executeTool("submit_match_decision", { ...whole, matched_claim_id: null })
    );
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("matched_claim_id");
  });

  it("accepts a whole decision as final", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    // The outcome is derived from the ids, not trusted from the model (#419).
    expect(onFinalTool("submit_match_decision", whole)).toEqual({ ...whole, outcome: "match" });
    expect(JSON.parse(await executeTool("submit_match_decision", whole)).success).toBe(true);
  });

  it("accepts a posing stance for a source that states the proposition as an open question (#445)", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    const posing = { ...whole, instance_stance: "poses" };
    expect(onFinalTool("submit_match_decision", posing)).toEqual({ ...posing, outcome: "match" });
    expect(JSON.parse(await executeTool("submit_match_decision", posing)).success).toBe(true);
  });

  it("refuses a stance outside affirms/denies/poses", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    const bad = { ...whole, instance_stance: "mentions" };
    expect(onFinalTool("submit_match_decision", bad)).toBeNull();
    const reply = JSON.parse(await executeTool("submit_match_decision", bad));
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("poses");
  });

  it("refuses a match whose id no search returned (#470)", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    // A retyped id: the first group of one neighbour, the tail of another.
    const spliced = { ...whole, matched_claim_id: "0badc0de-bc3e-43ab-9eba-8a401fcb0848" };
    expect(onFinalTool("submit_match_decision", spliced)).toBeNull();
    const reply = JSON.parse(await executeTool("submit_match_decision", spliced));
    expect(reply.success).toBe(false);
    expect(reply.message).toContain("not returned by any search_similar_claims call");
    expect(reply.message).toContain("copied exactly");
  });

  it("refuses a match submitted before any search: there is no id it could have seen (#470)", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { onFinalTool } = mocks.loopOptions!;
    expect(onFinalTool("submit_match_decision", whole)).toBeNull();
  });

  it("repairs a retyped matched id by its first UUID group when that names one retrieved claim (#470)", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    const spliced = { ...whole, matched_claim_id: "f02c5d2d-bc3e-43ab-9eba-8a401fcb0848" };
    const d = onFinalTool("submit_match_decision", spliced);
    expect(d.outcome).toBe("match");
    expect(d.matched_claim_id).toBe(NEIGHBOUR);
  });

  it("repairs or drops alternative_matches ids no search returned, so every id resolves (#470)", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    const { executeTool, onFinalTool } = mocks.loopOptions!;
    await executeTool("search_similar_claims", { query: "x" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = onFinalTool("submit_match_decision", {
      ...whole,
      alternative_matches: [
        // The issue's splice: NEIGHBOUR's first three groups, OTHER's tail.
        "f02c5d2d-bc3e-43ab-9eba-8a401fcb0848",
        OTHER,
        "deadbeef-0000-4000-8000-000000000000",
        MATCHED, // the match itself is not also a near-miss
        OTHER, // duplicates collapse
      ],
    });
    expect(d.alternative_matches).toEqual([NEIGHBOUR, OTHER]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("deadbeef-0000-4000-8000-000000000000");
    warn.mockRestore();
  });

  it("ends undecided, not as a new claim, when nothing whole was ever submitted (#419)", async () => {
    const decision = await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    expect(decision.outcome).toBe("undecided");
    expect(decision.is_match).toBe(false);
    expect(decision.new_canonical_form).toBeNull();
    expect(decision.confidence).toBe(0);
  });
});
