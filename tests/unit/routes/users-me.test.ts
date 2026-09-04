import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

/**
 * GET /users/me (docs/mathematics.md §8.7): the account carries its prize
 * owls beside, never inside, its earned owls, and the payload lists the
 * claimant's prize claims in the account shape. A failure in the prize
 * query must not hide the account.
 */
const mocks = vi.hoisted(() => ({
  getContributorById: vi.fn(),
  provisionUser: vi.fn(),
  getEntitlement: vi.fn(),
  listOpenPrizeClaimsFor: vi.fn(),
}));

vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorById: mocks.getContributorById,
  provisionUser: mocks.provisionUser,
}));
vi.mock("../../../src/services/billing-service.js", () => ({
  getEntitlement: mocks.getEntitlement,
  serializeEntitlement: (e: unknown) => e,
  serializeOwlPacks: () => [],
}));
vi.mock("../../../src/services/prize-account-service.js", () => ({
  listOpenPrizeClaimsFor: mocks.listOpenPrizeClaimsFor,
}));

import { userRoutes, serializeUser } from "../../../src/routes/users.js";
import { owlCostMicroUsd } from "../../../src/services/owl.js";

const sessionAuth: RequestAuth = {
  method: "env_key",
  userId: "user-1",
  apiKeyId: null,
  contributorExternalId: "github:1",
  isService: true,
  isSession: true,
};

function contributor(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    externalId: "github:1",
    displayName: "Ada",
    email: null,
    avatarUrl: null,
    reputationScore: 55,
    owlsEarnedMicroUsd: 3 * owlCostMicroUsd(),
    owlsPrizedMicroUsd: 500 * owlCostMicroUsd(),
    contributionStanding: "good",
    badFaithFlags: 0,
    contributionsAccepted: 2,
    contributionsRejected: 0,
    contributionsEscalated: 0,
    isVerified: false,
    isSuspended: false,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActiveAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const openClaim = {
  id: "pc-1",
  credit_name: "Ada",
  direction: "proof",
  submitted_at: "2026-08-01T00:00:00.000Z",
  status: "payable",
  rejected_stage: null,
  contribution_id: "co-1",
  claim_id: "claim-1",
  claim_text: "Every even integer greater than two is the sum of two primes.",
  amount_micro_usd: 500_000_000,
  window_ends_at: "2026-08-20T00:00:00.000Z",
  payee_deadline_at: "2026-11-18T00:00:00.000Z",
  payee_status: "pending",
  tax_form_status: "pending",
  screening_status: "pending",
  paid_at: null,
};

async function buildApp(auth: RequestAuth) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.auth = auth;
  });
  app.decorate("requireUser", async (request: any, reply: any) => {
    if (!request.auth?.userId) return reply.code(403).send({ error: "user required" });
  });
  app.decorate("requireService", async () => {});
  await app.register(userRoutes, { prefix: "/users" });
  return app;
}

beforeEach(() => {
  mocks.getContributorById.mockReset();
  mocks.getEntitlement.mockReset();
  mocks.listOpenPrizeClaimsFor.mockReset();
  mocks.getEntitlement.mockResolvedValue({ owl_balance: 1 });
});

describe("serializeUser", () => {
  it("serves owls_prized converted like owls_earned, and never folds it into owls_earned", () => {
    const user = serializeUser(contributor() as any);
    expect(user.owls_earned).toBe(3);
    expect(user.owls_prized).toBe(500);
  });

  it("reads a missing prize column as zero", () => {
    const user = serializeUser(contributor({ owlsPrizedMicroUsd: undefined }) as any);
    expect(user.owls_prized).toBe(0);
  });
});

describe("GET /users/me", () => {
  it("returns the account with owls_prized and the claimant's prize claims in the account shape", async () => {
    mocks.getContributorById.mockResolvedValueOnce(contributor());
    mocks.listOpenPrizeClaimsFor.mockResolvedValueOnce([openClaim]);
    const app = await buildApp(sessionAuth);
    const res = await app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.owls_prized).toBe(500);
    expect(body.user.owls_earned).toBe(3);
    expect(body.open_prize_claims).toEqual([openClaim]);
    expect(Object.keys(body.open_prize_claims[0]).sort()).toEqual(
      [
        "amount_micro_usd", "claim_id", "claim_text", "contribution_id", "credit_name",
        "direction", "id", "paid_at", "payee_deadline_at", "payee_status",
        "rejected_stage", "screening_status", "status", "submitted_at",
        "tax_form_status", "window_ends_at",
      ].sort()
    );
    expect(mocks.listOpenPrizeClaimsFor).toHaveBeenCalledWith("user-1");
  });

  it("serves an empty list, not an error, when the prize query fails", async () => {
    mocks.getContributorById.mockResolvedValueOnce(contributor());
    mocks.listOpenPrizeClaimsFor.mockRejectedValueOnce(new Error("relation prize_claims does not exist"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp(sessionAuth);
    const res = await app.inject({ method: "GET", url: "/users/me" });
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json().open_prize_claims).toEqual([]);
  });

  it("404s an unknown account", async () => {
    mocks.getContributorById.mockResolvedValueOnce(null);
    mocks.listOpenPrizeClaimsFor.mockResolvedValueOnce([]);
    const app = await buildApp(sessionAuth);
    const res = await app.inject({ method: "GET", url: "/users/me" });
    expect(res.statusCode).toBe(404);
  });
});
