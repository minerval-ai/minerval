/**
 * The mathematics fields on the claims routes (docs/mathematics.md §11.1):
 * the claim payload carries the formal statement, the derived badge, the
 * domains, the bounty, the attempts, and the prize claims at every depth,
 * each argument in the deep payload carries its check, and the list and
 * search items carry prize_micro_usd and checked with the with_prizes and
 * claim_type filters passed through. The response schemas are the public
 * field filter, so these tests prove the serializer lets the fields out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
const ARGUMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";

const CLAIM_ROW = {
  id: CLAIM_ID,
  text: "There are infinitely many primes p such that p + 2 is prime.",
  claimType: "mathematical",
  state: "active",
  decompositionStatus: "decomposed",
  importance: 0.5,
  stewardState: "done",
  seedCredence: null,
  seedNote: null,
  seedSourceClaimId: null,
  createdBy: "extractor",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const EXTRAS = {
  formalization: {
    id: "f1111111-1111-4111-8111-111111111111",
    version: 1,
    status: "published",
    pin_id: "mathlib-v4.33.0",
    lean_toolchain: "leanprover/lean4:v4.33.0",
    mathlib_rev: "0",
    mathlib_tag: "v4.33.0",
    namespace: "Minerval.S11111111_v1",
    statement_source: "import Mathlib\n",
    pp_type: "…",
    source_hash: "src",
    expr_hash: "expr",
    correspondence: "The statement is the twin prime conjecture over ℕ.",
    published_at: "2026-02-02T00:00:00.000Z",
    review_period_ends_at: "2026-02-16T00:00:00.000Z",
  },
  verification: {
    kind: "proof",
    lean_check_id: "lc-1",
    checked_at: "2026-03-01T00:00:00.000Z",
    formalization_id: "f1111111-1111-4111-8111-111111111111",
    pin_id: "mathlib-v4.33.0",
  },
  domains: ["mathematics"],
  bounty: { id: "b-1", amount_micro_usd: 2_500_000_000, status: "open", state_sentence: "Open." },
  attempts: [{ id: "att-1", variant: "max", outcome: "negative", spent_micro_usd: 84_000_000 }],
  prize_claims: [{ id: "pc-1", credit_name: "A. Solver", status: "in_review" }],
};

const LEAN_CHECK = {
  id: "lc-1",
  kind: "proof",
  verdict: "accepted",
  checked_at: "2026-03-01T00:00:00.000Z",
  pin_id: "mathlib-v4.33.0",
  submission_sha256: "abc",
  submitted_by: "claim_steward",
};

const mocks = vi.hoisted(() => ({
  getClaimById: vi.fn(),
  listClaims: vi.fn(),
  hybridSearch: vi.fn(),
  loadClaimExtras: vi.fn(),
  leanChecksByArgument: vi.fn(),
  getArgumentsForClaim: vi.fn(),
  getEvaluationStateForClaim: vi.fn(async () => []),
}));

vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
  listClaims: mocks.listClaims,
  proposeClaim: vi.fn(),
}));
vi.mock("../../../src/services/search-service.js", () => ({
  hybridSearch: mocks.hybridSearch,
}));
vi.mock("../../../src/services/claim-extras-service.js", () => ({
  loadClaimExtras: mocks.loadClaimExtras,
  emptyClaimExtras: () => ({
    formalization: null,
    verification: null,
    domains: [],
    bounty: null,
    attempts: [],
    prize_claims: [],
  }),
}));
vi.mock("../../../src/services/formalization-service.js", () => ({
  leanChecksByArgument: mocks.leanChecksByArgument,
}));
vi.mock("../../../src/services/tree-service.js", () => ({
  getClaimTree: vi.fn(async () => null),
  getSubclaimCount: vi.fn(async () => 0),
  getClaimDependents: vi.fn(async () => []),
  getTransitiveDependents: vi.fn(),
  listClaimDependents: vi.fn(),
}));
vi.mock("../../../src/services/argument-service.js", () => ({
  addArgument: vi.fn(),
  getArgumentsForClaim: mocks.getArgumentsForClaim,
  getEvaluationStateForClaim: mocks.getEvaluationStateForClaim,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getAssessmentHistory: vi.fn(),
  getAssessmentTrajectory: vi.fn(),
}));
vi.mock("../../../src/services/claim-events-service.js", () => ({
  getClaimEvents: vi.fn(),
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionRecordForClaim: vi.fn(),
}));
vi.mock("../../../src/services/intake-service.js", () => ({
  createClaimProposal: vi.fn(),
}));
vi.mock("../../../src/services/citation-service.js", () => ({
  assembleClaimCitation: vi.fn(),
}));
vi.mock("../../../src/services/nanopub-service.js", () => ({
  assembleClaimNanopub: vi.fn(),
}));
vi.mock("../../../src/services/grant-service.js", () => ({
  getFundingLabelForJob: vi.fn(async () => null),
}));
vi.mock("../../../src/server/contributor-gate.js", () => ({
  gateContributor: vi.fn(),
}));
// The route reads the current assessment and the instances through the
// query builder; both resolve empty here.
vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve([]), { limit: async () => [] }),
        innerJoin: () => ({ where: async () => [] }),
      }),
    }),
  }),
}));

import { claimRoutes } from "../../../src/routes/claims.js";

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async () => {});
  app.decorate("requireAgenticQuota", () => async () => {});
  app.decorate("requireUser", async () => {});
  await app.register(claimRoutes, { prefix: "/claims" });
  return app;
}

beforeEach(() => {
  mocks.getClaimById.mockReset().mockImplementation(async (id: string) => (id === CLAIM_ID ? CLAIM_ROW : null));
  mocks.loadClaimExtras.mockReset().mockResolvedValue(EXTRAS);
  mocks.leanChecksByArgument.mockReset().mockResolvedValue(new Map([[ARGUMENT_ID, LEAN_CHECK]]));
  mocks.getArgumentsForClaim.mockReset().mockResolvedValue([
    {
      id: ARGUMENT_ID,
      claimId: CLAIM_ID,
      name: "Proof by strong induction (machine-checked)",
      description: null,
      stance: "for",
      content: "The proof checks.",
      evidenceUrls: [`/lean-checks/lc-1`],
      createdBy: "claim_steward",
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  ]);
  mocks.listClaims.mockReset().mockResolvedValue({
    results: [
      {
        id: CLAIM_ID,
        text: CLAIM_ROW.text,
        claim_type: "mathematical",
        state: "active",
        importance: 0.5,
        updated_at: CLAIM_ROW.updatedAt,
        assessment_status: null,
        assessment_confidence: null,
        prize_micro_usd: 2_500_000_000,
        checked: "proof",
      },
    ],
    next_cursor: null,
  });
  mocks.hybridSearch.mockReset().mockResolvedValue({
    results: [
      {
        id: CLAIM_ID,
        text: CLAIM_ROW.text,
        claim_type: "mathematical",
        state: "active",
        similarity_score: 0.9,
        importance: 0.5,
        assessment_status: null,
        assessment_confidence: null,
        prize_micro_usd: null,
        checked: "disproof",
      },
    ],
    total: 1,
  });
});

describe("GET /claims/:id and the mathematics read models", () => {
  it("serves the formal statement, the badge, the domains, the bounty, the attempts, and the prize claims at every depth", async () => {
    const app = await buildApp();
    for (const depth of ["cursory", "standard", "deep"]) {
      const res = await app.inject({
        method: "GET",
        url: `/claims/${CLAIM_ID}?information_depth=${depth}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.formalization).toEqual(EXTRAS.formalization);
      expect(body.verification).toEqual(EXTRAS.verification);
      expect(body.domains).toEqual(["mathematics"]);
      expect(body.bounty).toEqual(EXTRAS.bounty);
      expect(body.attempts).toEqual(EXTRAS.attempts);
      expect(body.prize_claims).toEqual(EXTRAS.prize_claims);
    }
    expect(mocks.loadClaimExtras).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("carries each argument's accepted check in the deep payload", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${CLAIM_ID}?information_depth=deep`,
    });
    expect(res.statusCode).toBe(200);
    const [argument] = res.json().arguments;
    expect(argument).toMatchObject({
      id: ARGUMENT_ID,
      name: "Proof by strong induction (machine-checked)",
      lean_check: LEAN_CHECK,
    });
    await app.close();
  });

  it("degrades to empty read models when the extras loader fails, never a failed page", async () => {
    mocks.loadClaimExtras.mockRejectedValueOnce(new Error("checker tables missing"));
    const muted = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.claim.id).toBe(CLAIM_ID);
      expect(body.formalization).toBeNull();
      expect(body.verification).toBeNull();
      expect(body.attempts).toEqual([]);
      expect(body.prize_claims).toEqual([]);
    } finally {
      muted.mockRestore();
      await app.close();
    }
  });
});

describe("the list and search items", () => {
  it("carry prize_micro_usd and checked, and pass with_prizes and claim_type through", async () => {
    const app = await buildApp();
    const list = await app.inject({
      method: "GET",
      url: "/claims?with_prizes=true&claim_type=mathematical",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().results[0]).toMatchObject({
      id: CLAIM_ID,
      prize_micro_usd: 2_500_000_000,
      checked: "proof",
    });
    expect(mocks.listClaims).toHaveBeenLastCalledWith(
      expect.objectContaining({ withPrizes: true, claimType: "mathematical" })
    );

    const search = await app.inject({
      method: "GET",
      url: "/claims/search/twin%20primes?with_prizes=true",
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results[0]).toMatchObject({
      id: CLAIM_ID,
      prize_micro_usd: null,
      checked: "disproof",
    });
    expect(mocks.hybridSearch).toHaveBeenLastCalledWith(
      "twin primes",
      expect.objectContaining({ withPrizes: true, claimType: undefined })
    );

    // Filters absent: nothing filtered, and an unknown claim_type is refused.
    await app.inject({ method: "GET", url: "/claims" });
    expect(mocks.listClaims).toHaveBeenLastCalledWith(
      expect.objectContaining({ withPrizes: false, claimType: undefined })
    );
    const bad = await app.inject({ method: "GET", url: "/claims?claim_type=poetic" });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
