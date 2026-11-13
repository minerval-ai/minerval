import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Matcher's reads repair a retyped id (#884) through the mechanism every
 * agent's reads share (#934): the tool loop keeps the run's record of the
 * ids it has been shown (llm/seen-ids.ts), and executeGraphReadTool repairs
 * a miss against it (tools/id-repair.ts). The Matcher keeps one record
 * across its first run and its retry. Its submitted decisions resolve their
 * ids against what its searches returned, by the same rule (#470).
 */

const mocks = vi.hoisted(() => ({
  loops: [] as Array<Record<string, any>>,
  reads: [] as Array<{ name: string; input: Record<string, unknown> }>,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ matcherModel: "openai/gpt-6-luna", matchingTopK: 20, matcherBudgetUsd: 0.1 }),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: Record<string, any>) => {
    mocks.loops.push(opts);
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
  keywordClaimSearch: vi.fn(async () => []),
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
// reads themselves, and their repair, are the real ones.
vi.mock("../../../src/services/claim-view-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/claim-view-service.js")>()),
  getClaimView: vi.fn(async (id: string) => {
    mocks.reads.push({ name: "get_claim", input: { claim_id: id } });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" });
    }
    return NODES.has(id) ? { claim: { id, canonical_form: NODES.get(id) } } : null;
  }),
}));
vi.mock("../../../src/services/graph-read-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/graph-read-service.js")>()),
  runGraphRead: vi.fn(async (name: string, input: Record<string, unknown>) => {
    mocks.reads.push({ name, input });
    const id = String(input.claim_id ?? "");
    return NODES.has(id)
      ? { ok: true, payload: { claim_id: id, tree: {} } }
      : { ok: false, code: "NOT_FOUND", message: "Claim not found" };
  }),
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (_sql: string, [ids]: [string[]]) =>
    ids.filter((id) => NODES.has(id)).map((id) => ({ id, text: NODES.get(id) }))
  ),
}));

import { matchClaim } from "../../../src/llm/agents/matcher.js";
import { observedExecutor } from "./observed-loop.js";

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

/** The first loop's tools, run as the real loop runs them: inside the run's record. */
async function tools(opts: { search?: boolean } = {}) {
  await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
  const loop = mocks.loops[0]!;
  const { execute } = observedExecutor(loop as never);
  if (opts.search !== false) await execute("search_similar_claims", { query: "x" });
  mocks.reads.length = 0;
  return execute;
}

beforeEach(() => {
  mocks.loops.length = 0;
  mocks.reads.length = 0;
});

describe("Matcher read repair (#884, #934)", () => {
  it("keeps one record across the first run and the retry", async () => {
    await matchClaim({ extractedText: "x", proposedCanonical: "x", domains: [] });
    // No decision was submitted, so the retry ran too.
    expect(mocks.loops).toHaveLength(2);
    expect(mocks.loops[0]!.seenIds).toBeDefined();
    expect(mocks.loops[1]!.seenIds).toBe(mocks.loops[0]!.seenIds);
  });

  it("reads an id a search returned as given, with no correction", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_claim", { claim_id: LEADING, include: ["subclaims"] }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected).toBeUndefined();
    expect(mocks.reads).toHaveLength(1);
  });

  it("reads an id no search returned as given when the graph holds it", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_claim", { claim_id: FROM_PROMPT }));
    expect(out.claim.id).toBe(FROM_PROMPT);
    expect(out.id_corrected).toBeUndefined();
  });

  it("repairs a retyped id that begins like exactly one retrieved id, and says so", async () => {
    const execute = await tools();
    // The first group of the leading candidate, the tail of a neighbour.
    const spliced = "edb65b17-bc3e-43ab-9dba-f9546f1a856e";
    const out = JSON.parse(await execute("get_claim", { claim_id: spliced, include: ["subclaims"] }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected).toMatchObject({ requested_id: spliced, resolved_id: LEADING, rule: "first_group" });
    expect(out.id_corrected.note).toContain("No node has the id you asked for");
    // The correction leads the payload, so it is read before the view.
    expect(Object.keys(out)[0]).toBe("id_corrected");
    expect(mocks.reads.map((r) => r.input.claim_id)).toEqual([spliced, LEADING]);
  });

  it("repairs an id with one hex digit too many (#934's shape)", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_claim", { claim_id: `${NEIGHBOUR}6` }));
    expect(out.claim.id).toBe(NEIGHBOUR);
    expect(out.id_corrected.rule).toBe("one_character");
  });

  it("repairs get_decomposition the same way", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_decomposition", { claim_id: "f02c5d2d-0000-4000-8000-000000000000" }));
    expect(out.claim_id).toBe(NEIGHBOUR);
    expect(out.id_corrected.resolved_id).toBe(NEIGHBOUR);
  });

  it("repairs a shortened id by its first group", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_claim", { claim_id: "edb65b17" }));
    expect(out.claim.id).toBe(LEADING);
    expect(out.id_corrected.requested_id).toBe("edb65b17");
  });

  it("does not guess between two retrieved ids, and lists them first", async () => {
    const execute = await tools();
    const ambiguous = "5b6a73ad-9999-4999-8999-999999999999";
    const out = JSON.parse(await execute("get_claim", { claim_id: ambiguous }));
    expect(out.claim).toBeUndefined();
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.requested_id).toBe(ambiguous);
    expect(out.error).toContain("Nothing is missing from the graph");
    expect(out.error).toContain("2 ids this run has seen");
    expect(out.nearest_seen_ids.slice(0, 2).map((r: { id: string }) => r.id)).toEqual([TWIN_A, TWIN_B]);
    expect(out.nearest_seen_ids[0].text).toBe("claim 2");
    // One read, no second attempt at a guess.
    expect(mocks.reads).toHaveLength(1);
  });

  it("does not repair an id that resembles no seen id, and lists the nearest", async () => {
    const execute = await tools();
    const out = JSON.parse(await execute("get_claim", { claim_id: "deadbeef-0000-4000-8000-000000000000" }));
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.nearest_seen_ids).toHaveLength(4);
    expect(out.error).toContain("No id this run has seen is one character away from it");
  });

  it("before any tool result, a miss says there is nothing to copy from yet", async () => {
    const execute = await tools({ search: false });
    const out = JSON.parse(await execute("get_claim", { claim_id: "edb65b17-bc3e-43ab-9dba-f9546f1a856e" }));
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.nearest_seen_ids).toEqual([]);
    expect(out.error).toContain("No tool result in this run has shown an id yet");
  });

  it("resolves a submitted match's id against what its searches returned, by the shared rule", async () => {
    const execute = await tools();
    const out = JSON.parse(
      await execute("submit_match_decision", {
        is_match: true,
        matched_claim_id: `${LEADING.slice(0, -1)}`,
        instance_stance: "affirms",
        confidence: 0.9,
        reasoning: "same proposition",
        alternative_matches: [`${NEIGHBOUR}0`, FROM_PROMPT],
      })
    );
    expect(out.success).toBe(true);
    const decision = mocks.loops[0]!.onFinalTool("submit_match_decision", {
      is_match: true,
      matched_claim_id: `${LEADING.slice(0, -1)}`,
      instance_stance: "affirms",
      confidence: 0.9,
      reasoning: "same proposition",
      alternative_matches: [`${NEIGHBOUR}0`, FROM_PROMPT],
    });
    expect(decision.matched_claim_id).toBe(LEADING);
    // A prompt id no search returned is not a candidate a caller may weigh.
    expect(decision.alternative_matches).toEqual([NEIGHBOUR]);
  });
});
