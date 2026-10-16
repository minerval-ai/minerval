import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getClaimById: vi.fn(),
  getCurrentAssessment: vi.fn(),
}));

vi.mock("../../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
}));
vi.mock("../../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: mocks.getCurrentAssessment,
}));
vi.mock("../../../../src/services/search-service.js", () => ({
  findSimilarClaims: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));
vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
}));

import { executeGraphTool } from "../../../../src/llm/tools/graph-tools.js";

const CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const CLAIM = {
  id: CLAIM_ID,
  text: "GDP fell in 2020",
  claimType: "empirical_verifiable",
  state: "active",
  decompositionStatus: "decomposed",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("get_claim_details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the current assessment (status, confidence, reasoning) — #181", async () => {
    mocks.getClaimById.mockResolvedValue(CLAIM);
    mocks.getCurrentAssessment.mockResolvedValue({
      status: "verified",
      confidence: 0.9,
      summary: "Verified against national accounts data.",
      reasoningTrace: "long audit trace",
    });

    const out = JSON.parse(await executeGraphTool("get_claim_details", { claim_id: CLAIM_ID }));

    expect(out.assessment).toEqual({
      status: "verified",
      confidence: 0.9,
      reasoning: "Verified against national accounts data.",
    });
  });

  it("falls back to a truncated reasoning trace when there is no summary", async () => {
    mocks.getClaimById.mockResolvedValue(CLAIM);
    mocks.getCurrentAssessment.mockResolvedValue({
      status: "inconclusive",
      confidence: 0.6,
      summary: null,
      reasoningTrace: "x".repeat(5000),
    });

    const out = JSON.parse(await executeGraphTool("get_claim_details", { claim_id: CLAIM_ID }));

    expect(out.assessment.status).toBe("inconclusive");
    expect(out.assessment.reasoning).toBe("x".repeat(1200));
  });

  it("labels the lifecycle state distinctly from the assessment status and handles unassessed claims", async () => {
    mocks.getClaimById.mockResolvedValue(CLAIM);
    mocks.getCurrentAssessment.mockResolvedValue(null);

    const out = JSON.parse(await executeGraphTool("get_claim_details", { claim_id: CLAIM_ID }));

    expect(out.lifecycle_state).toBe("active");
    expect(out).not.toHaveProperty("state");
    expect(out.assessment).toBeNull();
  });

  it("reports a missing claim as an error", async () => {
    mocks.getClaimById.mockResolvedValue(null);
    mocks.getCurrentAssessment.mockResolvedValue(null);

    const out = await executeGraphTool("get_claim_details", { claim_id: CLAIM_ID });

    expect(out).toBe(`Error: Claim not found: ${CLAIM_ID}`);
  });
});
