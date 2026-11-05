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
  // The id every SUBMISSION names: a submission may only name ids the run's
  // searches returned (#470), so each script searches once before deciding.
  findSimilarClaims: vi.fn(async () => [
    { id: "43d6b1fa-0289-4f4c-b3bf-39567ab24629", text: "IUT structures.", similarity_score: 0.9 },
  ]),
  keywordClaimSearch: vi.fn(async () => []),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () =>
    ["search_claims", "get_claim", "get_decomposition", "get_dependents"].map((name) => ({
      name,
      description: "",
      input_schema: { type: "object" },
    })),
  executeGraphReadTool: vi.fn(async (name: string) => JSON.stringify({ read: name })),
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    matcherModel: "openai/gpt-6-luna",
    matchingTopK: 20,
    matcherBudgetUsd: 0.1,
    agentReportsPerRun: 3,
  }),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue", description: "", input_schema: { type: "object" } }],
    execute: async () => null,
  }),
}));

import { matchClaim, priorSearchesNote } from "../../../src/llm/agents/matcher.js";
import { findSimilarClaims, keywordClaimSearch } from "../../../src/services/search-service.js";
import { generateEmbedding } from "../../../src/services/embedding-service.js";
import { getUsageContext, withCostMeter } from "../../../src/llm/usage-context.js";

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
  it("warns the Matcher before its turn guard runs out", async () => {
    script = async (opts) => {
      await opts.executeTool("search_similar_claims", { query: "IUT" });
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    await matchClaim(INPUT);
    const opts = loopCalls[0]!;
    expect(opts.maxIterations).toBe(30);
    expect(opts.iterationBudgetNotice.warnWithin).toBe(2);
    expect(opts.iterationBudgetNotice.message(1)).toMatch(/submit_match_decision/);
  });

  it("returns a decided outcome from a submission, derived from the ids", async () => {
    script = async (opts) => {
      await opts.executeTool("search_similar_claims", { query: "IUT" });
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
      if (index === 0) await opts.executeTool("search_similar_claims", { query: "IUT" });
      if (index === 1) opts.onFinalTool("submit_match_decision", SUBMISSION);
    };
    const d = await matchClaim(INPUT);
    expect(loopCalls).toHaveLength(2);
    const retry = loopCalls[1]!;
    expect(retry.maxIterations).toBe(3);
    const content = retry.initialMessages[0].content as Array<{ text: string }>;
    expect(content[1]!.text).toMatch(/ended without calling submit_match_decision/);
    // The retry's own prompt states its own turns and money (#727).
    expect(content[0]!.text).toMatch(/up to 3 tool-use turns/);
    expect(content[0]!.text).not.toMatch(/up to 30 tool-use turns/);
    expect(content[0]!.text).toMatch(/budget of \$0\.03/);
    expect(d.outcome).toBe("match");
  });

  it("hands the retry the first run's searches and top hits (#467)", async () => {
    vi.mocked(findSimilarClaims)
      .mockResolvedValueOnce([
        { id: "c1", text: "Convex Wolff axioms imply the Kakeya conjecture.", similarity_score: 0.8123 },
      ] as any)
      .mockResolvedValueOnce([]);
    script = async (opts, index) => {
      if (index === 0) {
        await opts.executeTool("search_similar_claims", { query: "Kakeya via Wolff axioms" });
        await opts.executeTool("search_similar_claims", { query: "Kakeya conjecture fails" });
      } else {
        await opts.executeTool("search_similar_claims", { query: "IUT" });
        opts.onFinalTool("submit_match_decision", SUBMISSION);
      }
    };
    const d = await matchClaim(INPUT);
    expect(d.outcome).toBe("match");
    const retry = loopCalls[1]!;
    const note = (retry.initialMessages[0].content as Array<{ text: string }>)[1]!.text;
    expect(note).toMatch(/Searches from the previous attempt \(2\)/);
    expect(note).toContain('Query: "Kakeya via Wolff axioms"');
    expect(note).toContain("c1 (score 0.812): Convex Wolff axioms imply the Kakeya conjecture.");
    expect(note).toContain('Query: "Kakeya conjecture fails"');
    expect(note).toContain("(no results above the floor)");
    // The instruction to decide still follows the record.
    expect(note).toMatch(/at most one more search_similar_claims query/);
  });

  it("tells the Matcher its budget and turn guard up front and that searches batch (#467, #727)", async () => {
    script = async (opts) => {
      await opts.executeTool("search_similar_claims", { query: "IUT" });
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    await matchClaim(INPUT);
    const first = loopCalls[0]!;
    expect(first.initialMessages[0].content).toMatch(/budget of \$0\.10/);
    expect(first.initialMessages[0].content).toMatch(/up to 30 tool-use turns/);
    expect(first.initialMessages[0].content).toMatch(/several tool calls at once/);
  });

  it("ends a run whose budget is spent, after one turn to submit (#727)", async () => {
    let turnsAllowed = 0;
    script = async (opts) => {
      // The meter crosses the ceiling; the next turn is the grace turn, the
      // one after it is refused.
      getUsageContext().passBudget!.meter.billedMicroUsd = 500_000;
      await opts.beforeTurn(0);
      turnsAllowed++;
      await opts.beforeTurn(1);
      turnsAllowed++;
    };
    const d = await matchClaim(INPUT);
    // One grace turn in each of the two loops, then the run ends undecided.
    expect(turnsAllowed).toBe(2);
    expect(d.outcome).toBe("undecided");
  });

  it("adds what the decision billed to the caller's meter (#727)", async () => {
    script = async (opts) => {
      getUsageContext().passBudget!.meter.billedMicroUsd += 1234;
      await opts.executeTool("search_similar_claims", { query: "IUT" });
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    const { billedMicroUsd } = await withCostMeter(() => matchClaim(INPUT));
    expect(billedMicroUsd).toBe(1234);
  });

  it("passes the surrounding passage to the Matcher (#721)", async () => {
    script = async (opts) => {
      await opts.executeTool("search_similar_claims", { query: "IUT" });
      await opts.executeTool("submit_match_decision", SUBMISSION);
    };
    await matchClaim({ ...INPUT, context: "Critics reject this reading of the papers." });
    expect(loopCalls[0]!.initialMessages[0].content).toMatch(
      /Surrounding passage[^\n]*Critics reject this reading/
    );
  });

  it("adds keyword hits to a search, and falls back to keywords when embedding fails (#725)", async () => {
    const KW = "8a1d2c3e-0000-4000-8000-000000000001";
    vi.mocked(keywordClaimSearch).mockResolvedValue([
      { id: KW, kind: "claim", text: "Erdős Problem 1234 holds.", similarity_score: 0.2 },
    ] as any);
    let first = "";
    let second = "";
    script = async (opts) => {
      first = await opts.executeTool("search_similar_claims", { query: "IUT", keywords: "Problem 1234" });
      vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error("embeddings down"));
      second = await opts.executeTool("search_similar_claims", { query: "Problem 1234" });
    };
    await matchClaim(INPUT);
    vi.mocked(keywordClaimSearch).mockResolvedValue([]);
    const a = JSON.parse(first);
    expect(a.results.map((r: { id: string }) => r.id)).toEqual(["43d6b1fa-0289-4f4c-b3bf-39567ab24629", KW]);
    expect(a.results[1].found_by).toBe("keywords");
    const b = JSON.parse(second);
    expect(b.note).toMatch(/keyword search/);
    expect(b.results.map((r: { id: string }) => r.id)).toEqual([KW]);
  });

  it("gives the Matcher get_claim and get_decomposition, and no other graph read (#725)", async () => {
    let read = "";
    script = async (opts) => {
      read = await opts.executeTool("get_decomposition", { claim_id: "x" });
    };
    await matchClaim(INPUT);
    const names = loopCalls[0]!.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_claim", "get_decomposition"]));
    expect(names).not.toContain("search_claims");
    expect(names).not.toContain("get_dependents");
    expect(read).toBe(JSON.stringify({ read: "get_decomposition" }));
  });

  it("keeps the retry note plain when the first run never searched", () => {
    expect(priorSearchesNote([])).toBe("");
  });

  it("caps the hits per query and clips long wording in the retry note", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      id: `id${i}`,
      canonical_form: "x".repeat(400),
      score: 0.5,
    }));
    const note = priorSearchesNote([{ query: "q", results }]);
    expect(note.match(/^  - id/gm)).toHaveLength(5);
    expect(note).not.toContain("id5");
    expect(note).not.toContain("x".repeat(201));
    expect(note).toContain("…");
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
