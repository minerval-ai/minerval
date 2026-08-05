/**
 * Governed intake on the write surfaces (#157): POST /claims/propose and
 * POST /sources write directly only for DIRECT service callers (internal
 * seeding). Every other caller's submission becomes a pending intake
 * contribution — a suggestion for review — and nothing is written to the
 * claims table or extracted until the Contribution Reviewer accepts it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const mocks = vi.hoisted(() => ({
  proposeClaim: vi.fn(),
  submitSource: vi.fn(),
  createClaimProposal: vi.fn(),
  createSourceProposal: vi.fn(),
  gateContributor: vi.fn(),
  chargeAgenticOp: vi.fn(async () => ({
    allowed: true,
    entryId: "charge-1",
  })),
  attachChargeContribution: vi.fn(async () => {}),
}));

// The claims route module pulls in the whole read stack; stub every service
// import so registering the routes needs no database.
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(),
  listClaims: vi.fn(),
  proposeClaim: mocks.proposeClaim,
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
vi.mock("../../../src/services/source-service.js", () => ({
  submitSource: mocks.submitSource,
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  createClaimProposal: mocks.createClaimProposal,
  createSourceProposal: mocks.createSourceProposal,
}));
vi.mock("../../../src/services/citation-service.js", () => ({
  assembleClaimCitation: vi.fn(),
}));
vi.mock("../../../src/services/nanopub-service.js", () => ({
  assembleClaimNanopub: vi.fn(),
}));
vi.mock("../../../src/server/contributor-gate.js", () => ({
  gateContributor: mocks.gateContributor,
}));
// The routes charge owls at operation start (quota module) and link the
// charge to the created contribution (owl-ledger-service) — stub both.
vi.mock("../../../src/server/plugins/quota.js", () => ({
  chargeAgenticOp: mocks.chargeAgenticOp,
}));
vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  attachChargeContribution: mocks.attachChargeContribution,
}));
vi.mock("../../../src/db/client.js", () => ({ getDb: vi.fn() }));

const serviceAuth: RequestAuth = {
  method: "env_key",
  userId: null,
  apiKeyId: null,
  contributorExternalId: "ops",
  isService: true,
  isSession: false,
};

const userAuth: RequestAuth = {
  method: "api_key",
  userId: "user-1",
  apiKeyId: "key-1",
  contributorExternalId: "github:1",
  isService: false,
  isSession: false,
};

// The web BFF: a service key acting on behalf of a signed-in user.
const sessionAuth: RequestAuth = {
  ...serviceAuth,
  userId: "user-9",
  contributorExternalId: "github:9",
  isSession: true,
};

const CONTRIBUTOR = { id: "contrib-1", displayName: "Alice" };

const PENDING_CONTRIBUTION = {
  id: "66666666-6666-6666-6666-666666666666",
  contributionType: "propose_claim",
  reviewStatus: "pending",
  submittedAt: new Date("2026-07-16T00:00:00.000Z"),
};

async function buildTestApp(auth: RequestAuth) {
  const { claimRoutes } = await import("../../../src/routes/claims.js");
  const { sourceRoutes } = await import("../../../src/routes/sources.js");

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.auth = auth;
    request.contributorExternalId = auth.contributorExternalId;
  });
  app.decorate("requireAgenticQuota", () => async () => {});
  app.decorate("sendQuotaDenial", (reply: any, decision: any) =>
    reply.code(decision.statusCode).send({ code: decision.code })
  );
  await app.register(claimRoutes, { prefix: "/claims" });
  await app.register(sourceRoutes, { prefix: "/sources" });
  return app;
}

describe("write-surface governance (#157)", () => {
  beforeEach(() => {
    mocks.proposeClaim.mockReset();
    mocks.submitSource.mockReset();
    mocks.createClaimProposal.mockReset();
    mocks.createSourceProposal.mockReset();
    mocks.gateContributor.mockReset().mockResolvedValue(CONTRIBUTOR);
  });

  describe("POST /claims/propose", () => {
    it("routes user-scope callers to intake: 202, pending contribution, no claim written", async () => {
      mocks.createClaimProposal.mockResolvedValue(PENDING_CONTRIBUTION);
      const app = await buildTestApp(userAuth);
      const res = await app.inject({
        method: "POST",
        url: "/claims/propose",
        payload: { claim: "The sky is blue", argument: "Look up." },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().contribution).toMatchObject({
        id: PENDING_CONTRIBUTION.id,
        contribution_type: "propose_claim",
        review_status: "pending",
      });
      expect(mocks.createClaimProposal).toHaveBeenCalledWith({
        claimText: "The sky is blue",
        argumentText: "Look up.",
        contributorId: CONTRIBUTOR.id,
      });
      expect(mocks.proposeClaim).not.toHaveBeenCalled();
    });

    it("routes a web-BFF session (service key + acting user) to intake, not the fast path", async () => {
      mocks.createClaimProposal.mockResolvedValue(PENDING_CONTRIBUTION);
      const app = await buildTestApp(sessionAuth);
      const res = await app.inject({
        method: "POST",
        url: "/claims/propose",
        payload: { claim: "The sky is blue", argument: "Look up." },
      });
      expect(res.statusCode).toBe(202);
      expect(mocks.proposeClaim).not.toHaveBeenCalled();
    });

    it("stops at the contributor gate without creating anything", async () => {
      // gateContributor sends its own error reply and returns null.
      mocks.gateContributor.mockImplementation(async (_req, reply) => {
        await reply.code(429).send({
          error: { code: "CONTRIBUTION_RATE_LIMITED", message: "slow down" },
        });
        return null;
      });
      const app = await buildTestApp(userAuth);
      const res = await app.inject({
        method: "POST",
        url: "/claims/propose",
        payload: { claim: "The sky is blue", argument: "Look up." },
      });
      expect(res.statusCode).toBe(429);
      expect(mocks.createClaimProposal).not.toHaveBeenCalled();
      expect(mocks.proposeClaim).not.toHaveBeenCalled();
    });

    it("keeps the direct fast path for internal service seeding: 201", async () => {
      mocks.proposeClaim.mockResolvedValue({
        claim: {
          id: "11111111-1111-1111-1111-111111111111",
          text: "The sky is blue",
          claimType: "empirical_direct",
          state: "active",
          decompositionStatus: "pending",
          importance: 0.5,
          stewardState: "pending",
          createdBy: "user",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        argument: {
          id: "22222222-2222-2222-2222-222222222222",
          stance: "for",
          content: "Look up.",
          createdBy: "user",
          createdAt: new Date(),
        },
        jobId: "33333333-3333-3333-3333-333333333333",
      });
      const app = await buildTestApp(serviceAuth);
      const res = await app.inject({
        method: "POST",
        url: "/claims/propose",
        payload: { claim: "The sky is blue", argument: "Look up." },
      });
      expect(res.statusCode).toBe(201);
      expect(mocks.proposeClaim).toHaveBeenCalledOnce();
      expect(mocks.createClaimProposal).not.toHaveBeenCalled();
    });
  });

  describe("POST /sources", () => {
    it("routes user-scope callers to intake: 202 pending_review, no extraction enqueued", async () => {
      mocks.createSourceProposal.mockResolvedValue({
        contribution: {
          ...PENDING_CONTRIBUTION,
          contributionType: "propose_source",
        },
        sourceId: "44444444-4444-4444-4444-444444444444",
      });
      const app = await buildTestApp(userAuth);
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        payload: { url: "https://example.com/article" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        status: "pending_review",
        contribution_id: PENDING_CONTRIBUTION.id,
        source_id: "44444444-4444-4444-4444-444444444444",
      });
      expect(mocks.submitSource).not.toHaveBeenCalled();
    });

    it("keeps the direct fast path for internal service seeding: 202 queued", async () => {
      mocks.submitSource.mockResolvedValue({
        sourceId: "44444444-4444-4444-4444-444444444444",
        jobId: "55555555-5555-5555-5555-555555555555",
      });
      const app = await buildTestApp(serviceAuth);
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        payload: { url: "https://example.com/article" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("queued");
      expect(mocks.createSourceProposal).not.toHaveBeenCalled();
    });

    it("routes a web-BFF session to intake, not the fast path", async () => {
      mocks.createSourceProposal.mockResolvedValue({
        contribution: {
          ...PENDING_CONTRIBUTION,
          contributionType: "propose_source",
        },
        sourceId: "44444444-4444-4444-4444-444444444444",
      });
      const app = await buildTestApp(sessionAuth);
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        payload: { url: "https://example.com/article" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("pending_review");
      expect(mocks.submitSource).not.toHaveBeenCalled();
    });
  });
});
