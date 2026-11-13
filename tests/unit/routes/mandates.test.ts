import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

/**
 * GET /mandates/:id (docs/mathematics.md §8.3): the public dashboard
 * carries the Prizes block and the house solver's attempts under the
 * mandate; a failure in either leaves the page standing.
 */
const mocks = vi.hoisted(() => ({
  getPublicMandate: vi.fn(),
  listMandateAttempts: vi.fn(),
  mandatePrizesBlock: vi.fn(),
  readableMandateRef: vi.fn(),
  listMandatesPage: vi.fn(),
  listMandateWork: vi.fn(),
  listMandateUpdates: vi.fn(),
}));

vi.mock("../../../src/services/mandate-service.js", () => ({
  listMandatesPage: mocks.listMandatesPage,
  MANDATE_SCOPES: ["all", "platform", "mine"],
  MANDATE_LIST_STATES: ["live", "any", "active", "paused", "finished", "needs_you"],
  MANDATE_ORDERS: ["budget", "recent", "newest", "backers", "needs_you"],
  getPublicMandate: mocks.getPublicMandate,
  getMandateAllocationView: vi.fn(),
  contributeToMandate: vi.fn(),
  listMandateAttempts: mocks.listMandateAttempts,
  readableMandateRef: mocks.readableMandateRef,
}));
vi.mock("../../../src/services/mandate-work-service.js", () => ({
  MANDATE_WORK_KINDS: ["assessments", "sources", "requests", "research", "proposals"],
  JUDGED_NODE_KINDS: ["claim", "question", "quantity"],
  listMandateWork: mocks.listMandateWork,
  listMandateUpdates: mocks.listMandateUpdates,
}));
vi.mock("../../../src/services/bounty-service.js", () => ({
  mandatePrizesBlock: mocks.mandatePrizesBlock,
}));

import { mandateRoutes } from "../../../src/routes/mandates.js";

const MANDATE_ID = "d1d1d1d1-0000-4000-8000-000000000001";

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async () => {});
  app.decorate("requireUser", async () => {});
  await app.register(mandateRoutes, { prefix: "/mandates" });
  return app;
}

const mandate = { id: MANDATE_ID, title: "Mathematics", status: "active", budget_owls: 100 };
const attempt = {
  id: "a-1",
  claim_id: "claim-1",
  variant: "max",
  effort: "high",
  status: "completed",
  outcome: "negative",
  is_calibration: false,
  spent_micro_usd: 12_000_000,
  turns: 40,
  started_at: "2026-08-01T00:00:00.000Z",
  finished_at: "2026-08-01T02:00:00.000Z",
  published_at: "2026-08-02T00:00:00.000Z",
  report: null,
  notebook: null,
};

beforeEach(() => {
  mocks.getPublicMandate.mockReset();
  mocks.listMandateAttempts.mockReset();
  mocks.mandatePrizesBlock.mockReset();
  mocks.readableMandateRef.mockReset();
  mocks.listMandatesPage.mockReset();
  mocks.listMandateWork.mockReset();
  mocks.listMandateUpdates.mockReset();
});

describe("GET /mandates/:id", () => {
  it("serves prizes and the attempts array beside the mandate", async () => {
    mocks.getPublicMandate.mockResolvedValueOnce(mandate);
    mocks.mandatePrizesBlock.mockResolvedValueOnce({ bounties_posted: 1, bounties: [{ id: "b-1", claim_id: "claim-1", text: "The claim" }] });
    mocks.listMandateAttempts.mockResolvedValueOnce([attempt]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mandate).toMatchObject(mandate);
    expect(body.mandate.prizes.bounties[0].text).toBe("The claim");
    expect(body.mandate.attempts).toEqual([attempt]);
    expect(mocks.listMandateAttempts).toHaveBeenCalledWith(MANDATE_ID);
  });

  it("serves an empty attempts array and a null prizes block when their loaders fail", async () => {
    mocks.getPublicMandate.mockResolvedValueOnce(mandate);
    mocks.mandatePrizesBlock.mockRejectedValueOnce(new Error("no fund"));
    mocks.listMandateAttempts.mockRejectedValueOnce(new Error("no table"));
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().mandate).toMatchObject({ ...mandate, prizes: null, attempts: [] });
  });

  it("404s an unknown or private mandate without loading prizes or attempts", async () => {
    mocks.getPublicMandate.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}` });
    expect(res.statusCode).toBe(404);
    expect(mocks.listMandateAttempts).not.toHaveBeenCalled();
    expect(mocks.mandatePrizesBlock).not.toHaveBeenCalled();
  });
});

describe("GET /mandates/:id/work", () => {
  const ref = { id: MANDATE_ID, budgetJobId: "job-1" };

  it("serves one page of one kind, with what the query asked for", async () => {
    mocks.readableMandateRef.mockResolvedValueOnce(ref);
    mocks.listMandateWork.mockResolvedValueOnce({ kind: "assessments", total: 240, items: [{ claim_id: "c-1" }] });
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/mandates/${MANDATE_ID}/work?kind=assessments&node=question&order=importance&offset=100&limit=100`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "assessments", total: 240 });
    expect(mocks.listMandateWork).toHaveBeenCalledWith(ref, {
      kind: "assessments",
      node: "question",
      order: "importance",
      offset: 100,
      limit: 100,
    });
  });

  it("refuses a kind it does not list and a page over a hundred", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/work?kind=everything` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/work` })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/work?kind=sources&limit=500` })).statusCode
    ).toBe(400);
    expect(mocks.listMandateWork).not.toHaveBeenCalled();
  });

  it("404s a mandate the viewer may not read, without listing anything", async () => {
    mocks.readableMandateRef.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/work?kind=sources` });
    expect(res.statusCode).toBe(404);
    expect(mocks.listMandateWork).not.toHaveBeenCalled();
  });
});

describe("GET /mandates/:id/updates", () => {
  it("serves the kept notes a page at a time", async () => {
    mocks.readableMandateRef.mockResolvedValueOnce({ id: MANDATE_ID, budgetJobId: "job-1" });
    mocks.listMandateUpdates.mockResolvedValueOnce({ total: 12, updates: [{ at: "2026-11-01T00:00:00.000Z", note: "n" }] });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/updates?offset=10` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(12);
    expect(mocks.listMandateUpdates).toHaveBeenCalledWith(MANDATE_ID, { offset: 10, limit: 10 });
  });

  it("404s a mandate the viewer may not read", async () => {
    mocks.readableMandateRef.mockResolvedValueOnce(null);
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: `/mandates/${MANDATE_ID}/updates` })).statusCode).toBe(404);
    expect(mocks.listMandateUpdates).not.toHaveBeenCalled();
  });
});

describe("GET /mandates", () => {
  const page = { mandates: [], total: 0, states: {}, scopes: { all: 0, platform: 0, mine: null } };

  it("lists the mandates open to backing when asked for nothing in particular", async () => {
    mocks.listMandatesPage.mockResolvedValueOnce(page);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/mandates" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(page);
    expect(mocks.listMandatesPage).toHaveBeenCalledWith({
      scope: "all", viewerUserId: null, state: "live", q: undefined, order: undefined, offset: 0, limit: 50,
    });
  });

  it("passes the scope, state, words, order and page asked for", async () => {
    mocks.listMandatesPage.mockResolvedValueOnce(page);
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/mandates?scope=platform&state=finished&q=oversight&order=newest&offset=25&limit=25" });
    expect(mocks.listMandatesPage).toHaveBeenCalledWith({
      scope: "platform", viewerUserId: null, state: "finished", q: "oversight", order: "newest", offset: 25, limit: 25,
    });
  });

  it("refuses a caller's own mandates to a caller with no account, and a state it does not know", async () => {
    const app = await buildApp();
    expect((await app.inject({ method: "GET", url: "/mandates?scope=mine" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/mandates?state=secret" })).statusCode).toBe(400);
    expect(mocks.listMandatesPage).not.toHaveBeenCalled();
  });
});
