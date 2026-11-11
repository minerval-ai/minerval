/**
 * The claim card (GET /claims/:id/card), the batch read (GET /claims/cards),
 * and `fields=` on real claim routes. The card service runs for real over a
 * mocked query, so the row-to-card mapping is under test too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";
const MISSING = "99999999-9999-9999-9999-999999999999";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  listClaims: vi.fn(),
}));

// The claims route module pulls in the whole read stack; stub the service
// imports so registering the routes needs no database.
// No node in these tests is a merged alias (#884): ids resolve to themselves.
vi.mock("../../../src/services/claim-alias-service.js", async (importOriginal) =>
  (await import("../../../tests/unit/claim-alias-mock.js")).passthroughClaimAlias(importOriginal)
);
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(),
  listClaims: mocks.listClaims,
  proposeClaim: vi.fn(),
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  getContributionRecordForClaim: vi.fn(),
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
vi.mock("../../../src/services/tag-service.js", () => ({
  attachClaimTags: vi.fn(async (rows: object[]) => rows.map((r) => ({ ...r, tags: [] }))),
  getTagsForSubject: vi.fn(),
  resolveTagBySlug: vi.fn(),
}));
vi.mock("../../../src/server/contributor-gate.js", () => ({
  gateContributor: vi.fn(),
}));
vi.mock("../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  rawQuery: mocks.rawQuery,
}));

import { claimRoutes } from "../../../src/routes/claims.js";
import { CLAIM_CARDS_MAX_IDS } from "../../../src/services/claim-card-service.js";
import { registerErrorHandler } from "../../../src/server/plugins/error-handler.js";
import { registerPartialResponse } from "../../../src/server/plugins/partial-response.js";

async function buildApp() {
  process.env.LOG_LEVEL = "fatal";
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async () => {});
  app.decorate("requireAgenticQuota", () => async () => {});
  app.decorate("requireUser", async () => {});
  await registerErrorHandler(app);
  await registerPartialResponse(app);
  await app.register(claimRoutes, { prefix: "/claims" });
  return app;
}

/** A row as the card query returns it. */
function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "claim",
    text: `Claim ${id.slice(0, 4)}`,
    state: "active",
    contestation: 0.35,
    updated_at: new Date("2026-10-02T08:00:00.000Z"),
    assessment_status: "supported",
    assessment_confidence: 0.8,
    standing: null,
    estimate: null,
    unit: null,
    assessed_at: new Date("2026-09-30T12:00:00.000Z"),
    ...over,
  };
}

const CARD_KEYS = [
  "id",
  "kind",
  "text",
  "state",
  "assessment_status",
  "assessment_confidence",
  "standing",
  "estimate",
  "unit",
  "contestation",
  "assessed_at",
  "updated_at",
  "page_url",
  "resolved_from",
];

beforeEach(() => {
  mocks.rawQuery.mockReset().mockResolvedValue([]);
  mocks.listClaims.mockReset();
});

describe("GET /claims/:claim_id/card", () => {
  it("serves the judgment whole, in the fixed shape", async () => {
    mocks.rawQuery.mockResolvedValue([row(A)]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${A}/card` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: A,
      kind: "claim",
      text: "Claim 1111",
      state: "active",
      assessment_status: "supported",
      assessment_confidence: 0.8,
      standing: null,
      estimate: null,
      unit: null,
      contestation: 0.35,
      assessed_at: "2026-09-30T12:00:00.000Z",
      updated_at: "2026-10-02T08:00:00.000Z",
      page_url: `https://minerval.ai/claims/${A}`,
      resolved_from: null,
    });
    expect(Object.keys(res.json())).toEqual(CARD_KEYS);
  });

  it("reads an unassessed claim as unassessed, not as a failure", async () => {
    mocks.rawQuery.mockResolvedValue([
      row(A, {
        contestation: null,
        assessment_status: null,
        assessment_confidence: null,
        assessed_at: null,
      }),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${A}/card` });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    // Every key is still there; the judgment is null.
    expect(Object.keys(card)).toEqual(CARD_KEYS);
    expect(card).toMatchObject({
      id: A,
      state: "active",
      assessment_status: null,
      assessment_confidence: null,
      contestation: null,
      assessed_at: null,
      updated_at: "2026-10-02T08:00:00.000Z",
    });
  });

  it("carries a question's standing and a quantity's estimate and unit", async () => {
    const app = await buildApp();
    mocks.rawQuery.mockResolvedValue([
      row(A, {
        kind: "question",
        assessment_status: null,
        assessment_confidence: 0.6,
        standing: "open",
      }),
    ]);
    const question = (await app.inject({ method: "GET", url: `/claims/${A}/card` })).json();
    expect(question).toMatchObject({
      kind: "question",
      assessment_status: null,
      assessment_confidence: 0.6,
      standing: "open",
      estimate: null,
      unit: null,
    });

    mocks.rawQuery.mockResolvedValue([
      row(B, {
        kind: "quantity",
        assessment_status: null,
        assessment_confidence: null,
        estimate: { form: "point", value: 9.81 },
        unit: { symbol: "m/s^2" },
      }),
    ]);
    const quantity = (await app.inject({ method: "GET", url: `/claims/${B}/card` })).json();
    expect(quantity).toMatchObject({
      kind: "quantity",
      assessment_status: null,
      standing: null,
      estimate: { form: "point", value: 9.81 },
      unit: { symbol: "m/s^2" },
    });
  });

  it("404s for a claim the graph does not hold", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/${MISSING}/card` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("400s for an id that is not a uuid", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/claims/not-a-uuid/card" });
    expect(res.statusCode).toBe(400);
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("takes fields, keeping nulls that were asked for", async () => {
    mocks.rawQuery.mockResolvedValue([
      row(A, { assessment_status: null, assessment_confidence: null, assessed_at: null }),
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/${A}/card?fields=text,assessment_status,assessment_confidence,contestation`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: "Claim 1111",
      assessment_status: null,
      assessment_confidence: null,
      contestation: 0.35,
    });
  });
});

describe("GET /claims/cards", () => {
  it("is not captured by /claims/:claim_id", async () => {
    mocks.rawQuery.mockResolvedValue([row(A)]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/cards?ids=${A}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().cards).toHaveLength(1);
  });

  it("answers in the order asked, in one query, naming ids it does not hold", async () => {
    // The database answers in its own order.
    mocks.rawQuery.mockResolvedValue([row(C), row(A), row(B)]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/cards?ids=${B},${MISSING},${A},${C}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual([B, A, C]);
    expect(body.not_found).toEqual([MISSING]);
    expect(Object.keys(body.cards[0])).toEqual(CARD_KEYS);

    expect(mocks.rawQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.rawQuery.mock.calls[0]!;
    expect(sql).toContain("ANY($1::uuid[])");
    expect(params).toEqual([[B, MISSING, A, C]]);
  });

  it("answers 200 with every id in not_found when none exist", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/cards?ids=${MISSING}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cards: [], not_found: [MISSING] });
  });

  it("serves an unassessed claim beside assessed ones", async () => {
    mocks.rawQuery.mockResolvedValue([
      row(A),
      row(B, { assessment_status: null, assessment_confidence: null, assessed_at: null }),
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/claims/cards?ids=${A},${B}` });
    const [, unassessed] = res.json().cards;
    expect(unassessed).toMatchObject({ id: B, assessment_status: null, assessed_at: null });
    expect(res.json().not_found).toEqual([]);
  });

  it("takes a repeated id once, spaces around ids, and either letter case", async () => {
    mocks.rawQuery.mockResolvedValue([row(A)]);
    const app = await buildApp();
    const upper = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
    const res = await app.inject({
      method: "GET",
      url: "/claims/cards",
      query: { ids: `${A}, ${A},${upper}` },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.rawQuery.mock.calls[0]![1]).toEqual([[A, upper.toLowerCase()]]);
    expect(res.json().not_found).toEqual([upper.toLowerCase()]);
  });

  it.each([
    ["an id that is not a uuid", `${A},nope`],
    ["a stray comma", `${A},`],
    ["only spaces", "  "],
  ])("400s in the error envelope for %s", async (_name, ids) => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/claims/cards", query: { ids } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("400s when ids is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/claims/cards" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/ids/);
  });

  it("takes the stated cap and refuses one more, saying the cap", async () => {
    const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    const app = await buildApp();
    const atCap = Array.from({ length: CLAIM_CARDS_MAX_IDS }, (_, i) => id(i));
    const ok = await app.inject({
      method: "GET",
      url: "/claims/cards",
      query: { ids: atCap.join(",") },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().not_found).toHaveLength(CLAIM_CARDS_MAX_IDS);

    mocks.rawQuery.mockClear();
    const over = await app.inject({
      method: "GET",
      url: "/claims/cards",
      query: { ids: [...atCap, id(CLAIM_CARDS_MAX_IDS)].join(",") },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toContain(String(CLAIM_CARDS_MAX_IDS));
    expect(mocks.rawQuery).not.toHaveBeenCalled();
  });

  it("declares the cap in the ids parameter", async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/claims/cards",
      query: { ids: "x".repeat(CLAIM_CARDS_MAX_IDS * 38 + 1) },
    });
    // Over the declared maxLength: refused by the schema itself.
    expect(res.statusCode).toBe(400);
  });

  it("takes fields through the list", async () => {
    mocks.rawQuery.mockResolvedValue([row(A), row(B)]);
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/claims/cards?ids=${A},${MISSING},${B}&fields=cards.id,cards.assessment_status,cards.assessment_confidence,cards.contestation,not_found`,
    });
    expect(res.json()).toEqual({
      cards: [
        { id: A, assessment_status: "supported", assessment_confidence: 0.8, contestation: 0.35 },
        { id: B, assessment_status: "supported", assessment_confidence: 0.8, contestation: 0.35 },
      ],
      not_found: [MISSING],
    });
  });
});

describe("fields on GET /claims", () => {
  beforeEach(() => {
    mocks.listClaims.mockResolvedValue({
      results: [
        {
          id: A,
          kind: "claim",
          text: "First",
          claim_type: "empirical",
          state: "active",
          importance: 0.7,
          assessment_status: "supported",
          assessment_confidence: 0.8,
          prize_micro_usd: null,
          checked: null,
        },
        {
          id: B,
          kind: "claim",
          text: "Second",
          claim_type: "empirical",
          state: "active",
          importance: 0.2,
          assessment_status: null,
          assessment_confidence: null,
          prize_micro_usd: null,
          checked: null,
        },
      ],
      next_cursor: "abc",
    });
  });

  it("serves the full list without fields", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/claims" });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ id: A, text: "First", importance: 0.7 });
    expect(res.json().next_cursor).toBe("abc");
  });

  it("prunes each result and keeps the route's own parameters working", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/claims?limit=2&fields=results.id,results.assessment_status,next_cursor",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      results: [
        { id: A, assessment_status: "supported" },
        { id: B, assessment_status: null },
      ],
      next_cursor: "abc",
    });
    expect(mocks.listClaims).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it("400s for malformed fields before the handler runs", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/claims?fields=results..id" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(mocks.listClaims).not.toHaveBeenCalled();
  });
});
