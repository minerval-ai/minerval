import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../src/services/search-service.js", () => ({
  findSimilarClaims: vi.fn(async () => []),
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
} from "../../../../src/llm/tools/graph-tools.js";

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
