/**
 * The public contribution record endpoint (#171): GET /claims/:id/record
 * assembles contribution → review → appeal → arbitration per exchange. The
 * response schema is also the public-field filter — internal review fields
 * (suspected bad faith) and arbitration model votes must never serialize.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  getClaimById: vi.fn(),
  getContributionRecordForClaim: vi.fn(),
}));

// The claims route module pulls in the whole read stack; stub every service
// import so registering the routes needs no database.
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
  listClaims: vi.fn(),
  proposeClaim: vi.fn(),
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionRecordForClaim: mocks.getContributionRecordForClaim,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getAssessmentHistory: vi.fn(),
  getAssessmentTrajectory: vi.fn(),
}));
vi.mock("../../../src/services/search-service.js", () => ({
  hybridSearch: vi.fn(),
}));
vi.mock("../../../src/services/tree-service.js", () => ({
  getClaimTree: vi.fn(),
  getSubclaimCount: vi.fn(),
  getClaimDependents: vi.fn(),
  listClaimDependents: vi.fn(),
}));
vi.mock("../../../src/services/argument-service.js", () => ({
  addArgument: vi.fn(),
  getArgumentsForClaim: vi.fn(),
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  createClaimProposal: vi.fn(),
}));
vi.mock("../../../src/services/citation-service.js", () => ({
  assembleClaimCitation: vi.fn(),
}));
vi.mock("../../../src/server/contributor-gate.js", () => ({
  gateContributor: vi.fn(),
}));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn() }));

import { claimRoutes } from "../../../src/routes/claims.js";

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async () => {});
  app.decorate("requireAgenticQuota", async () => {});
  await app.register(claimRoutes, { prefix: "/claims" });
  return app;
}

// A full exchange as the service returns it: raw DB rows (camelCase, Date
// objects) including the internal fields the endpoint must not expose.
function fullExchange() {
  return {
    contribution: {
      id: "22222222-2222-2222-2222-222222222222",
      claimId: CLAIM_ID,
      contributorId: "33333333-3333-3333-3333-333333333333",
      contributionType: "challenge",
      content: "The cited statistic is misquoted.",
      evidenceUrls: ["https://example.com/primary"],
      submittedAt: new Date("2026-07-01T00:00:00.000Z"),
      reviewStatus: "rejected",
      mergeTargetClaimId: null,
      proposedCanonicalForm: null,
      sourceId: null,
    },
    contributorDisplayName: "Ada",
    review: {
      id: "44444444-4444-4444-4444-444444444444",
      contributionId: "22222222-2222-2222-2222-222222222222",
      decision: "reject",
      reasoning: "The primary source says otherwise.",
      confidence: 0.9,
      policyCitations: ["§4"],
      suspectedBadFaith: true,
      badFaithCategory: "misinformation",
      reviewedAt: new Date("2026-07-02T00:00:00.000Z"),
      reviewedBy: "contribution_reviewer",
    },
    appeal: {
      id: "55555555-5555-5555-5555-555555555555",
      contributionId: "22222222-2222-2222-2222-222222222222",
      originalReviewId: "44444444-4444-4444-4444-444444444444",
      appellantId: "33333333-3333-3333-3333-333333333333",
      appellantDisplayName: "Ada",
      appealReasoning: "The review misread my evidence.",
      submittedAt: new Date("2026-07-03T00:00:00.000Z"),
      status: "resolved",
    },
    arbitration: {
      id: "66666666-6666-6666-6666-666666666666",
      contributionId: "22222222-2222-2222-2222-222222222222",
      appealId: "55555555-5555-5555-5555-555555555555",
      outcome: "uphold_original",
      decision: "Rejection upheld.",
      reasoning: "The appeal restates the original claim.",
      consensusAchieved: true,
      modelVotes: { "model-a": "uphold", "model-b": "uphold" },
      humanReviewRecommended: false,
      arbitratedAt: new Date("2026-07-04T00:00:00.000Z"),
      arbitratedBy: "dispute_arbitrator",
    },
  };
}

beforeEach(() => {
  mocks.getClaimById.mockReset().mockResolvedValue({ id: CLAIM_ID });
  mocks.getContributionRecordForClaim.mockReset().mockResolvedValue([]);
});

describe("GET /claims/:claim_id/record (#171)", () => {
  it("404s for an unknown claim", async () => {
    mocks.getClaimById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/record` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns an empty record for a claim with no contributions", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/record` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ record: [], total: 0 });
  });

  it("serializes a full exchange in snake_case", async () => {
    mocks.getContributionRecordForClaim.mockResolvedValue([fullExchange()]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/record` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.record[0]).toEqual({
      contribution: {
        id: "22222222-2222-2222-2222-222222222222",
        contributor: {
          id: "33333333-3333-3333-3333-333333333333",
          display_name: "Ada",
        },
        contribution_type: "challenge",
        content: "The cited statistic is misquoted.",
        evidence_urls: ["https://example.com/primary"],
        submitted_at: "2026-07-01T00:00:00.000Z",
        review_status: "rejected",
      },
      review: {
        id: "44444444-4444-4444-4444-444444444444",
        decision: "reject",
        reasoning: "The primary source says otherwise.",
        confidence: 0.9,
        policy_citations: ["§4"],
        reviewed_at: "2026-07-02T00:00:00.000Z",
        reviewed_by: "contribution_reviewer",
      },
      appeal: {
        id: "55555555-5555-5555-5555-555555555555",
        appellant: {
          id: "33333333-3333-3333-3333-333333333333",
          display_name: "Ada",
        },
        appeal_reasoning: "The review misread my evidence.",
        submitted_at: "2026-07-03T00:00:00.000Z",
        status: "resolved",
      },
      arbitration: {
        id: "66666666-6666-6666-6666-666666666666",
        outcome: "uphold_original",
        decision: "Rejection upheld.",
        reasoning: "The appeal restates the original claim.",
        consensus_achieved: true,
        human_review_recommended: false,
        arbitrated_at: "2026-07-04T00:00:00.000Z",
        arbitrated_by: "dispute_arbitrator",
      },
    });
  });

  it("never exposes internal fields (bad-faith flags, model votes)", async () => {
    mocks.getContributionRecordForClaim.mockResolvedValue([fullExchange()]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/record` });
    const raw = res.body;
    expect(raw).not.toContain("bad_faith");
    expect(raw).not.toContain("suspectedBadFaith");
    expect(raw).not.toContain("model_votes");
    expect(raw).not.toContain("misinformation");
  });

  it("keeps a pending contribution's review, appeal, and arbitration null", async () => {
    const pending = fullExchange();
    mocks.getContributionRecordForClaim.mockResolvedValue([
      {
        ...pending,
        contribution: { ...pending.contribution, reviewStatus: "pending" },
        review: null,
        appeal: null,
        arbitration: null,
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/record` });
    const entry = res.json().record[0];
    expect(entry.contribution.review_status).toBe("pending");
    expect(entry.review).toBeNull();
    expect(entry.appeal).toBeNull();
    expect(entry.arbitration).toBeNull();
  });
});
