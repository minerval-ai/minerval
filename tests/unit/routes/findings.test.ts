/**
 * /findings (#394): public reads, service-only withdrawal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const FINDING_ID = "d4d4d4d4-4444-4444-8444-444444444444";
const CLAIM_ID = "b2b2b2b2-2222-4222-8222-222222222222";
const ASSESSMENT_ID = "a1a1a1a1-1111-4111-8111-111111111111";

const ROW = {
  id: FINDING_ID,
  headline: "The conjecture has a machine-checked proof.",
  account: "The statement was proved and the check accepted.",
  claim_id: CLAIM_ID,
  claim_text: "The conjecture holds.",
  refs: [{ kind: "assessment", id: ASSESSMENT_ID }],
  importance: 7,
  agent: "steward",
  model: null,
  run_id: null,
  skills: ["mathematics"],
  status: "published",
  withdrawn_note: null,
  sighting_count: 2,
  first_noted_at: new Date("2026-09-03T00:00:00Z"),
  last_noted_at: new Date("2026-09-05T00:00:00Z"),
  stale: false,
};

const mocks = vi.hoisted(() => ({
  listFindings: vi.fn(),
  getFindingById: vi.fn(),
  listFindingSightings: vi.fn(),
  setFindingStatus: vi.fn(),
}));

vi.mock("../../../src/services/finding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/finding-service.js")>()),
  listFindings: mocks.listFindings,
  getFindingById: mocks.getFindingById,
  listFindingSightings: mocks.listFindingSightings,
  setFindingStatus: mocks.setFindingStatus,
}));

import { findingRoutes } from "../../../src/routes/findings.js";

async function buildApp(isService: boolean) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.auth = { isService, isSession: false };
  });
  app.decorate("requireService", async (request: any, reply: any) => {
    if (!request.auth?.isService) {
      return reply.code(403).send({ error: "nope", code: "SERVICE_KEY_REQUIRED" });
    }
  });
  await app.register(findingRoutes, { prefix: "/findings" });
  return app;
}

beforeEach(() => {
  mocks.listFindings.mockReset().mockResolvedValue([ROW]);
  mocks.getFindingById.mockReset().mockResolvedValue(ROW);
  mocks.listFindingSightings.mockReset().mockResolvedValue([
    {
      id: "f6f6f6f6-6666-4666-8666-666666666666",
      account: "Met again on re-assessment.",
      refs: [],
      importance: 6,
      agent: "steward",
      model: null,
      noted_at: new Date("2026-09-05T00:00:00Z"),
    },
  ]);
  mocks.setFindingStatus.mockReset().mockResolvedValue({
    ...ROW,
    status: "withdrawn",
    withdrawn_note: "cited a retired statement",
  });
});

describe("GET /findings", () => {
  it("is public and serializes the wire shape with parsed filters", async () => {
    const app = await buildApp(false);
    const res = await app.inject({
      method: "GET",
      url: `/findings?claim_id=${CLAIM_ID}&tag=number-theory&min_importance=4&order=importance&limit=5`,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.listFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: CLAIM_ID,
        tag: "number-theory",
        minImportance: 4,
        order: "importance",
        limit: 5,
        offset: 0,
      })
    );
    const body = res.json();
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      id: FINDING_ID,
      importance: 7,
      sighting_count: 2,
      stale: false,
      refs: [{ kind: "assessment", id: ASSESSMENT_ID }],
      first_noted_at: "2026-09-03T00:00:00.000Z",
    });
  });

  it("rejects an out-of-range importance filter", async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: "GET", url: "/findings?min_importance=11" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_QUERY");
  });
});

describe("GET /findings/:id", () => {
  it("returns the finding with its sightings", async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: "GET", url: `/findings/${FINDING_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.finding.id).toBe(FINDING_ID);
    expect(body.sightings).toHaveLength(1);
    expect(body.sightings[0]).toMatchObject({ agent: "steward", importance: 6, noted_at: "2026-09-05T00:00:00.000Z" });
  });

  it("404s on an unknown or malformed id", async () => {
    mocks.getFindingById.mockResolvedValue(null);
    const app = await buildApp(false);
    expect((await app.inject({ method: "GET", url: `/findings/${CLAIM_ID}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/findings/not-a-uuid" })).statusCode).toBe(404);
  });
});

describe("PATCH /findings/:id", () => {
  it("is refused without a service key", async () => {
    const app = await buildApp(false);
    const res = await app.inject({
      method: "PATCH",
      url: `/findings/${FINDING_ID}`,
      payload: { status: "withdrawn", note: "cited a retired statement" },
    });
    expect(res.statusCode).toBe(403);
    expect(mocks.setFindingStatus).not.toHaveBeenCalled();
  });

  it("withdraws with a note for a service caller", async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: "PATCH",
      url: `/findings/${FINDING_ID}`,
      payload: { status: "withdrawn", note: "cited a retired statement" },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.setFindingStatus).toHaveBeenCalledWith(FINDING_ID, "withdrawn", "cited a retired statement");
    expect(res.json().finding).toMatchObject({ status: "withdrawn", withdrawn_note: "cited a retired statement" });
  });

  it("rejects an unknown status", async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: "PATCH",
      url: `/findings/${FINDING_ID}`,
      payload: { status: "deleted" },
    });
    expect(res.statusCode).toBe(400);
  });
});
