import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Matcher's run-shape (#419): a budget notice before the cap, one bounded
 * retry when the first loop ends without a submission, and an explicitly
 * undecided result (never "new") when both loops end without one.
 */

const { loopCalls } = vi.hoisted(() => ({
  loopCalls: [] as Array<Record<string, any>>,
}));

// Each test installs a script: given the loop options (and which loop this
// is), call executeTool / onFinalTool as the model would.
let script: (opts: any, index: number) => Promise<void> = async () => {};

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: Record<string, unknown>) => {
    loopCalls.push(opts);
    await script(opts, loopCalls.length - 1);
    return { messages: [], finalResult: null };
  }),
}));
vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2]),
}));
vi.mock("../../../src/services/search-service.js", () => ({
  findSimilarClaims: vi.fn(async () => []),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    matcherModel: "z-ai/glm-5.3-flash",
    matchingTopK: 20,
    agentReportsPerRun: 3,
  }),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue", description: "", input_schema: { type: "object" } }],
    execute: async () => null,
  }),
}));

import { matchClaim } from "../../../src/llm/agents/matcher.js";

const INPUT = {
  extractedText: "Arithmetic holomorphic structures in the IUT papers can be distinct.",
  proposedCanonical: "Arithmetic holomorphic structures in IUT can be distinct.",
};

const SUBMISSION = {
  is_match: true,
  matched_claim_id: "43d6b1fa-0289-4f4c-b3bf-39567ab24629",
  new_canonical_form: null,
  instance_stance: "affirms",
  confidence: 0.8,
  reasoning: "Same proposition.",
  alternative_matches: [],
  relationship_notes: null,
};

beforeEach(() => {
  loopCalls.length = 0;
  script = async () => {};
});

describe("matchClaim", () => {
  it("warns the Matcher before its search budget runs out", async () => {
    script = async (opts) => {
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    await matchClaim(INPUT);
    const opts = loopCalls[0]!;
    expect(opts.maxIterations).toBe(8);
    expect(opts.iterationBudgetNotice.warnWithin).toBe(2);
    expect(opts.iterationBudgetNotice.message(1)).toMatch(/submit_match_decision/);
  });

  it("returns a decided outcome from a submission, derived from the ids", async () => {
    script = async (opts) => {
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    const d = await matchClaim(INPUT);
    expect(d.outcome).toBe("match");
    expect(d.matched_claim_id).toBe(SUBMISSION.matched_claim_id);
    expect(loopCalls).toHaveLength(1);

    script = async (opts) => {
      await opts.executeTool("submit_match_decision", {
        ...SUBMISSION,
        is_match: false,
        matched_claim_id: null,
        new_canonical_form: "A new wording.",
      });
    };
    const n = await matchClaim(INPUT);
    expect(n.outcome).toBe("new");
    expect(n.new_canonical_form).toBe("A new wording.");
  });

  it("retries once, short and told to decide, when the first loop never submits", async () => {
    script = async (opts, index) => {
      if (index === 1) opts.onFinalTool("submit_match_decision", SUBMISSION);
    };
    const d = await matchClaim(INPUT);
    expect(loopCalls).toHaveLength(2);
    const retry = loopCalls[1]!;
    expect(retry.maxIterations).toBe(3);
    const content = retry.initialMessages[0].content as Array<{ text: string }>;
    expect(content[1]!.text).toMatch(/ran out of search budget/);
    expect(d.outcome).toBe("match");
  });

  it("reports undecided, not new, when both loops end without a submission", async () => {
    const d = await matchClaim(INPUT);
    expect(loopCalls).toHaveLength(2);
    expect(d.outcome).toBe("undecided");
    expect(d.is_match).toBe(false);
    expect(d.matched_claim_id).toBeNull();
    // Nothing to mint from: a timeout proposes no canonical form.
    expect(d.new_canonical_form).toBeNull();
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toMatch(/not a finding that the claim is new/);
  });
});
