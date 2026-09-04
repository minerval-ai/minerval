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
}));

vi.mock("../../../src/services/mandate-service.js", () => ({
  listPublicMandates: vi.fn(async () => []),
  getPublicMandate: mocks.getPublicMandate,
  getMandateAllocationView: vi.fn(),
  contributeToMandate: vi.fn(),
  listMandateAttempts: mocks.listMandateAttempts,
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
