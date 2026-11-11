import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Matcher's reads repair a retyped id (#884). A get_claim on an id the
 * model had spliced together answered "claim not found", and the Matcher
 * reported the graph as broken. Its reads now resolve a missing id against
 * the ids its own searches returned, by the rule submit_match_decision
 * already uses (#470), and say so when they do.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: null as null | Record<string, any>,
  read: null as unknown as ReturnType<typeof import("vitest")["vi"]["fn"]>,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ matcherModel: "openai/gpt-6-luna", matchingTopK: 20, matcherBudgetUsd: 0.1 }),
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
vi.mock("../../../src/llm/tools/skill-load-tools.js", () => ({
  createSkillLoadTools: () => ({ definitions: [], execute: async () => null, pointed: [], pointerNote: "" }),
}));
vi.mock("../../../src/services/embedding-service.js", () => ({ generateEmbedding: vi.fn(async () => [0.1]) }));
vi.mock("../../../src/services/search-service.js", () => ({
  findSimilarClaims: vi.fn(async () => RETRIEVED),
}));
vi.mock("../../../src/llm/usage-context.js", () => ({
  runBudget: () => null,
  budgetRefusal: () => null,
  getUsageContext: () => ({}),
  withPassBudget: async (_: unknown, fn: () => Promise<unknown>) => ({ value: await fn(), billedMicroUsd: 0 }),
  withAgent: (_: string, fn: () => unknown) => fn(),
  withSkills: (_: string[], fn: () => unknown) => fn(),
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [], execute: async () => null }),
}));
// The graph as the reads see it: a node exists when NODES holds its id. The
// miss payloads are the real ones, so the repair is tested against the text
// and code every agent's read returns.
vi.mock("../../../src/llm/tools/graph-read-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/llm/tools/graph-read-tools.js")>();
  mocks.read = vi.fn(async (name: string, input: Record<string, unknown>) => {
    const id = String(input.claim_id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return JSON.stringify({ code: "INVALID_CLAIM_ID", error: "claim_id must be a full claim id" });
    }
    if (!NODES.has(id)) return JSON.stringify(actual.claimNotFoundError(id));
    return JSON.stringify(
      name === "get_claim" ? { claim: { id, canonical_form: NODES.get(id) } } : { claim_id: id, tree: {} }
    );
  });
  return {
    ...actual,
    getGraphReadToolDefinitions: () => [
      { name: "get_claim", description: "", input_schema: { type: "object", properties: {} } },
      { name: "get_decomposition", description: "", input_schema: { type: "object", properties: {} } },
    ],
    executeGraphReadTool: mocks.read,
  };
});

import { matchClaim } from "../../../src/llm/agents/matcher.js";

const LEADING = "edb65b17-29b2-4a3a-9064-7940bcaf287f";
const NEIGHBOUR = "f02c5d2d-bc3e-43ab-9dba-f9546f1a856e";
// Two retrieved ids that share a first group: no retyped id beginning with
// it names one of them.
const TWIN_A = "5b6a73ad-ba15-47ca-b86f-8a401fcb0848";
const TWIN_B = "5b6a73ad-1111-4222-8333-444444444444";
// A node the graph holds that no search in the run returned (the prompt can
// carry such an id).
const FROM_PROMPT = "0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e";
const RETRIEVED = [LEADING, NEIGHBOUR, TWIN_A, TWIN_B].map((id, i) => ({
  id,
  text: `claim ${i}`,
  similarity_score: 0.9 - i * 0.1,
}));
const NODES = new Map<string, string>([
  ...RETRIEVED.map((r) => [r.id, r.text] as [string, string]),
  [FROM_PROMPT, "a node named in the prompt"],
]);

async function tools(opts: { search?: boolean } = {}) {
  await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
  const { executeTool } = mocks.loopOptions!;
  if (opts.search !== false) await executeTool("search_similar_claims", { query: "x" });
  mocks.read.mockClear();
  return executeTool as (name: string, input: Record<string, unknown>) => Promise<string>;
}

beforeEach(() => {
  mocks.loopOptions = null;
});

describe("Matcher read repair (#884)", () => {
  it("reads an id a search returned as given, with no correction", async () => {
    const executeTool = await tools();
    const out = JSON.parse(await executeTool("get_claim", { claim_id: LEADING, include: ["subclaims"] }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith("get_claim", { claim_id: LEADING, include: ["subclaims"] });
  });

  it("reads an id no search returned as given when the graph holds it", async () => {
    const executeTool = await tools();
    const out = JSON.parse(await executeTool("get_claim", { claim_id: FROM_PROMPT }));
    expect(out.claim.id).toBe(FROM_PROMPT);
    expect(out.id_corrected).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("repairs a retyped id that begins like exactly one retrieved id, and says so", async () => {
    const executeTool = await tools();
    // The first group of the leading candidate, the tail of a neighbour.
    const spliced = "edb65b17-bc3e-43ab-9dba-f9546f1a856e";
    const out = JSON.parse(await executeTool("get_claim", { claim_id: spliced, include: ["subclaims"] }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected.requested_id).toBe(spliced);
    expect(out.id_corrected.resolved_id).toBe(LEADING);
    expect(out.id_corrected.note).toContain("No node has the id you asked for");
    // The correction leads the payload, so it is read before the view.
    expect(Object.keys(out)[0]).toBe("id_corrected");
    // The other arguments ride along with the corrected id.
    expect(mocks.read).toHaveBeenLastCalledWith("get_claim", { claim_id: LEADING, include: ["subclaims"] });
  });

  it("repairs get_decomposition the same way", async () => {
    const executeTool = await tools();
    const out = JSON.parse(
      await executeTool("get_decomposition", { claim_id: "f02c5d2d-0000-4000-8000-000000000000" })
    );
    expect(out.claim_id).toBe(NEIGHBOUR);
    expect(out.id_corrected.resolved_id).toBe(NEIGHBOUR);
  });

  it("repairs a shortened id by its first group", async () => {
    const executeTool = await tools();
    const out = JSON.parse(await executeTool("get_claim", { claim_id: "edb65b17" }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected.requested_id).toBe("edb65b17");
  });

  it("does not guess between two retrieved ids, and lists what the searches returned", async () => {
    const executeTool = await tools();
    const ambiguous = "5b6a73ad-9999-4999-8999-999999999999";
    const out = JSON.parse(await executeTool("get_claim", { claim_id: ambiguous }));
    expect(out.claim).toBeUndefined();
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.requested_id).toBe(ambiguous);
    expect(out.error).toContain("Nothing is missing from the graph");
    expect(out.retrieved_ids.map((r: { id: string }) => r.id)).toEqual([LEADING, NEIGHBOUR, TWIN_A, TWIN_B]);
    expect(out.retrieved_ids[0].canonical_form).toBe("claim 0");
    // One read, no second attempt at a guess.
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("does not repair an id that resembles no retrieved id", async () => {
    const executeTool = await tools();
    const out = JSON.parse(
      await executeTool("get_claim", { claim_id: "deadbeef-0000-4000-8000-000000000000" })
    );
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.retrieved_ids).toHaveLength(4);
  });

  it("before any search, a miss says there is nothing to copy from yet", async () => {
    const executeTool = await tools({ search: false });
    const out = JSON.parse(await executeTool("get_claim", { claim_id: "edb65b17-bc3e-43ab-9dba-f9546f1a856e" }));
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.retrieved_ids).toEqual([]);
    expect(out.error).toContain("No search in this run has returned an id yet");
  });
});
