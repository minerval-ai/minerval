import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  getClaimById: vi.fn(async () => ({ id: "claim-1" })),
  getOrCreateContributor: vi.fn(),
  createContribution: vi.fn(async () => ({
    id: "co-1",
    claimId: "claim-1",
    contributorId: "c-1",
    contributionType: "challenge",
    content: "x",
    evidenceUrls: [],
    submittedAt: new Date(),
    reviewStatus: "pending",
    mergeTargetClaimId: null,
    proposedCanonicalForm: null,
  })),
  enqueueContribution: vi.fn(async () => {}),
  checkContributionRateLimit: vi.fn(() => ({
    limited: false,
    limitPerHour: 10,
    sandboxed: false,
  })),
  getContributionById: vi.fn(),
  getReviewForContribution: vi.fn(async () => null),
  listContributions: vi.fn(async () => [] as unknown[]),
  getRequest: vi.fn(),
}));

// No node in these tests is a merged alias (#884): ids resolve to themselves.
vi.mock("../../../src/services/claim-alias-service.js", async (importOriginal) =>
  (await import("../../../tests/unit/claim-alias-mock.js")).passthroughClaimAlias(importOriginal)
);
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: mocks.getOrCreateContributor,
}));
// The formatter and the answer_request check are the real ones; only the
// reads and writes are stubbed.
vi.mock("../../../src/services/contribution-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/contribution-service.js")>()),
  createContribution: mocks.createContribution,
  getContributionById: mocks.getContributionById,
  listContributions: mocks.listContributions,
  getReviewForContribution: mocks.getReviewForContribution,
}));
vi.mock("../../../src/services/request-service.js", () => ({
  getRequest: mocks.getRequest,
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueContribution: mocks.enqueueContribution,
}));
vi.mock("../../../src/services/reputation-service.js", () => ({
  checkContributionRateLimit: mocks.checkContributionRateLimit,
}));

import { contributionRoutes } from "../../../src/routes/contributions.js";

function contributor(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    externalId: "github:1",
    displayName: "Ada",
    reputationScore: 50,
    contributionStanding: "good",
    badFaithFlags: 0,
    isSuspended: false,
    suspensionReason: null,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

async function buildApp(externalId: string | null = "github:1", userId: string | null = "c-1") {
  const app = Fastify();
  app.decorateRequest("contributorExternalId", null);
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.contributorExternalId = externalId;
    request.auth = userId ? { userId } : null;
  });
  await app.register(contributionRoutes, { prefix: "/contributions" });
  return app;
}

const BODY = {
  claim_id: CLAIM_ID,
  contribution_type: "challenge",
  content: "The cited statistic is misquoted.",
};

beforeEach(() => {
  mocks.getOrCreateContributor.mockReset().mockResolvedValue(contributor());
  mocks.createContribution.mockClear();
  mocks.enqueueContribution.mockClear();
  mocks.checkContributionRateLimit
    .mockReset()
    .mockReturnValue({ limited: false, limitPerHour: 10, sandboxed: false });
});

describe("POST /contributions gates (#71)", () => {
  it("accepts a contribution from a good-standing contributor", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      payload: BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.createContribution).toHaveBeenCalled();
    expect(mocks.enqueueContribution).toHaveBeenCalled();
  });

  it("requires a signed-in contributor identity (403)", async () => {
    const app = await buildApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NO_CONTRIBUTOR_IDENTITY");
    expect(mocks.createContribution).not.toHaveBeenCalled();
  });

  it("blocks suspended contributors (403)", async () => {
    mocks.getOrCreateContributor.mockResolvedValue(
      contributor({ isSuspended: true, suspensionReason: "abuse" })
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      payload: BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CONTRIBUTOR_SUSPENDED");
  });

  it("returns 402 DEPOSIT_REQUIRED for must-pay standing (the payment seam)", async () => {
    mocks.getOrCreateContributor.mockResolvedValue(
      contributor({ contributionStanding: "must_pay", badFaithFlags: 1 })
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      payload: BODY,
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("DEPOSIT_REQUIRED");
    expect(res.json().error.message).toContain("appeal");
    expect(mocks.createContribution).not.toHaveBeenCalled();
  });

  it("returns 429 when the sybil sandbox rate limit trips", async () => {
    mocks.checkContributionRateLimit.mockReturnValue({
      limited: true,
      limitPerHour: 3,
      sandboxed: true,
    });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/contributions",
      payload: BODY,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("CONTRIBUTION_RATE_LIMITED");
    expect(mocks.createContribution).not.toHaveBeenCalled();
  });
});

/**
 * The same fast-json-stringify stripping class as #16 (see
 * claims-serialization.test.ts), recurred on this endpoint: the 200 schema
 * declared `contribution: { type: "object" }` with no properties and no
 * additionalProperties, so the serializer dropped every key and the endpoint
 * answered `{"contribution": {}, "review": null}` for a row it had loaded.
 *
 * That blanked payload then broke the public record page: `{}` is truthy, so it
 * slipped past the not-found check and threw on the first field access, turning
 * every /contributions/:id into a server-side exception. Asserted through
 * app.inject so the response really passes through the compiled serializer —
 * testing the schema object alone would not have caught it.
 */
describe("GET /contributions/:id serialization", () => {
  const row = {
    id: "852cbfdf-1c5b-477d-8e02-e96f891a0a5c",
    claimId: CLAIM_ID,
    contributorId: "c-1",
    contributionType: "challenge",
    content: "This claim has not been reassessed in a while.",
    evidenceUrls: ["https://example.org/paper"],
    submittedAt: new Date("2026-08-09T14:55:22.635Z"),
    reviewStatus: "pending",
    mergeTargetClaimId: null,
    proposedCanonicalForm: null,
  };

  it("returns the contribution's fields instead of an empty object", async () => {
    mocks.getContributionById.mockResolvedValueOnce(row as never);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: `/contributions/${row.id}` });

    expect(res.statusCode).toBe(200);
    const { contribution } = res.json();
    expect(contribution).not.toEqual({});
    expect(contribution).toMatchObject({
      id: row.id,
      claim_id: CLAIM_ID,
      contribution_type: "challenge",
      content: row.content,
      review_status: "pending",
      evidence_urls: ["https://example.org/paper"],
      submitted_at: "2026-08-09T14:55:22.635Z",
    });
  });

  it("keeps an intake proposal's null claim_id null rather than coercing it", async () => {
    mocks.getContributionById.mockResolvedValueOnce({
      ...row,
      claimId: null,
      contributionType: "propose_claim",
      proposedCanonicalForm: "A proposed claim.",
    } as never);
    const app = await buildApp();

    const { contribution } = (
      await app.inject({ method: "GET", url: `/contributions/${row.id}` })
    ).json();

    expect(contribution.claim_id).toBeNull();
    expect(contribution.proposed_canonical_form).toBe("A proposed claim.");
    expect(contribution.became_claim_id).toBeNull();
    expect(contribution.page_url).toBeNull();
  });

  it("names the node an accepted proposal became, with its page", async () => {
    mocks.getContributionById.mockResolvedValueOnce({
      ...row,
      contributionType: "propose_question",
      reviewStatus: "accepted",
      proposedCanonicalForm: "What sets the colour of the sky?",
    } as never);
    const app = await buildApp();

    const { contribution } = (
      await app.inject({ method: "GET", url: `/contributions/${row.id}` })
    ).json();

    expect(contribution.became_claim_id).toBe(CLAIM_ID);
    expect(contribution.page_url).toMatch(new RegExp(`/claims/${CLAIM_ID}$`));
  });

  it("does not call an ordinary contribution's target something it became", async () => {
    mocks.getContributionById.mockResolvedValueOnce(row as never);
    const app = await buildApp();
    const { contribution } = (
      await app.inject({ method: "GET", url: `/contributions/${row.id}` })
    ).json();
    expect(contribution.became_claim_id).toBeNull();
    expect(contribution.page_url).toMatch(new RegExp(`/claims/${CLAIM_ID}$`));
  });

  it("serializes the review's reasoning when one has landed", async () => {
    mocks.getContributionById.mockResolvedValueOnce({
      ...row,
      reviewStatus: "rejected",
    } as never);
    mocks.getReviewForContribution.mockResolvedValueOnce({
      id: "rev-1",
      decision: "reject",
      reasoning: "The cited source does not support the challenge.",
      confidence: 0.8,
      policyCitations: ["§7"],
      reviewedAt: new Date("2026-08-09T15:00:00.000Z"),
      reviewedBy: "contribution_reviewer",
    } as never);
    const app = await buildApp();

    const { review } = (
      await app.inject({ method: "GET", url: `/contributions/${row.id}` })
    ).json();

    expect(review).not.toEqual({});
    expect(review.reasoning).toBe("The cited source does not support the challenge.");
    expect(review.policy_citations).toEqual(["§7"]);
    expect(review.reviewed_by).toBe("contribution_reviewer");
  });

  it("404s an unknown contribution", async () => {
    mocks.getContributionById.mockResolvedValueOnce(null as never);
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: `/contributions/${row.id}` });

    expect(res.statusCode).toBe(404);
  });
});

describe("answer_request names its request (#723)", () => {
  const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
  const ANSWER = { ...BODY, contribution_type: "answer_request", content: "The replication data is at the link." };
  const openRequest = (bearsOn: string[] = ["claim-1"], state = "open") => ({
    id: REQUEST_ID,
    bears_on: bearsOn.map((id) => ({ id, text: "x", kind: "claim" })),
    state,
  });

  beforeEach(() => {
    mocks.getClaimById.mockResolvedValue({ id: CLAIM_ID } as never);
    mocks.getRequest.mockReset();
  });

  it("refuses an answer_request with no request_id, before anything is recorded", async () => {
    const res = await (await buildApp()).inject({ method: "POST", url: "/contributions", payload: ANSWER });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("REQUEST_ID_REQUIRED");
    expect(mocks.createContribution).not.toHaveBeenCalled();
  });

  it("carries the request id to the reviewer at the head of the content", async () => {
    mocks.getRequest.mockResolvedValue(openRequest([CLAIM_ID]) as never);
    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/contributions",
      payload: { ...ANSWER, request_id: REQUEST_ID },
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.createContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        content: `Answers request ${REQUEST_ID}.\n\nThe replication data is at the link.`,
      })
    );
  });

  it("refuses a request that does not bear on the node, or is closed", async () => {
    mocks.getRequest.mockResolvedValueOnce(openRequest(["other-node"]) as never);
    let res = await (await buildApp()).inject({
      method: "POST",
      url: "/contributions",
      payload: { ...ANSWER, request_id: REQUEST_ID },
    });
    expect(res.json().error.code).toBe("REQUEST_NOT_ON_NODE");

    mocks.getRequest.mockResolvedValueOnce(openRequest([CLAIM_ID], "met") as never);
    res = await (await buildApp()).inject({
      method: "POST",
      url: "/contributions",
      payload: { ...ANSWER, request_id: REQUEST_ID },
    });
    expect(res.json().error.code).toBe("REQUEST_CLOSED");
    expect(mocks.createContribution).not.toHaveBeenCalled();
  });

  it("refuses request_id on any other type", async () => {
    const res = await (await buildApp()).inject({
      method: "POST",
      url: "/contributions",
      payload: { ...BODY, request_id: REQUEST_ID },
    });
    expect(res.json().error.code).toBe("REQUEST_ID_NOT_EXPECTED");
  });
});

describe("GET /contributions?mine=true (#723)", () => {
  beforeEach(() => mocks.listContributions.mockClear());

  it("lists the caller's own contributions when credentials are presented", async () => {
    const res = await (await buildApp()).inject({
      method: "GET",
      url: "/contributions?mine=true",
      headers: { "x-api-key": "k" },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.listContributions).toHaveBeenCalledWith(
      expect.objectContaining({ contributorId: "c-1" })
    );
  });

  it("needs credentials", async () => {
    const res = await (await buildApp()).inject({ method: "GET", url: "/contributions?mine=true" });
    expect(res.statusCode).toBe(401);
    expect(mocks.listContributions).not.toHaveBeenCalled();
  });

  it("stays open, and unfiltered by contributor, without mine", async () => {
    const res = await (await buildApp()).inject({ method: "GET", url: "/contributions" });
    expect(res.statusCode).toBe(200);
    expect(mocks.listContributions.mock.calls[0]![0]).not.toHaveProperty("contributorId");
  });

  it("refuses a status that is not one", async () => {
    const res = await (await buildApp()).inject({ method: "GET", url: "/contributions?status=done" });
    expect(res.statusCode).toBe(400);
  });
});
