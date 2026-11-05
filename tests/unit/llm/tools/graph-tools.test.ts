import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSimilarClaims: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));

vi.mock("../../../../src/services/search-service.js", () => ({
  findSimilarClaims: mocks.findSimilarClaims,
}));
vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));
vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
}));

import {
  executeGraphTool,
  getGraphToolDefinitions,
  SIMILAR_CLAIMS_FLOOR,
} from "../../../../src/llm/tools/graph-tools.js";

describe("search_similar_claims floor (#773)", () => {
  it("searches at the Matcher's floor and says what it is", async () => {
    expect(SIMILAR_CLAIMS_FLOOR).toBe(0.4);
    await executeGraphTool("search_similar_claims", { query: "GDP fell in 2020" });
    expect(mocks.findSimilarClaims).toHaveBeenCalledWith(expect.anything(), {
      limit: 10,
      minSimilarity: SIMILAR_CLAIMS_FLOOR,
    });
    const tool = getGraphToolDefinitions().find((t) => t.name === "search_similar_claims")!;
    expect(tool.description).toContain(`at least ${SIMILAR_CLAIMS_FLOOR}`);
  });
});

// #774: a node is read with the one get_claim. This family keeps the
// neighborhood reads and no longer carries readers of the node itself
// under other names.
describe("graph-tools", () => {
  it("carries the neighborhood reads only", () => {
    expect(getGraphToolDefinitions().map((t) => t.name)).toEqual([
      "search_similar_claims",
      "get_parent_claims",
    ]);
  });

  it("no longer answers get_claim_details or get_claim_subclaims", async () => {
    for (const name of ["get_claim_details", "get_claim_subclaims"]) {
      expect(await executeGraphTool(name, { claim_id: "c1" })).toMatch(/^Error: /);
    }
  });
});
