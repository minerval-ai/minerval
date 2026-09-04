/**
 * /reports (#366): service-scoped read and triage of agent reports.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const REPORT_ID = "a1a1a1a1-1111-4111-8111-111111111111";
const OTHER_ID = "b2b2b2b2-2222-4222-8222-222222222222";

const ROW = {
  id: REPORT_ID,
  kind: "tool_gap",
  severity: "degraded",
  title: "add_relationship_edge has no relation type for counterparts",
  body: "details",
  surface: "add_relationship_edge",
  origin: "internal",
  agent: "steward",
  model: null,
  reporter_contributor_id: null,
  context_refs: {},
  run_id: null,
  job_id: null,
  claim_id: null,
  status: "new",
  triage_note: null,
  triaged_by: null,
  triaged_at: null,
  duplicate_of_id: null,
  occurrence_count: 3,
  first_seen_at: new Date("2026-08-01T00:00:00Z"),
  last_seen_at: new Date("2026-08-02T00:00:00Z"),
};

const mocks = vi.hoisted(() => ({
  listAgentReports: vi.fn(),
  getAgentReportById: vi.fn(),
  triageAgentReport: vi.fn(),
}));

vi.mock("../../../src/services/report-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/report-service.js")
  >()),
  listAgentReports: mocks.listAgentReports,
  getAgentReportById: mocks.getAgentReportById,
  triageAgentReport: mocks.triageAgentReport,
}));

import { reportRoutes } from "../../../src/routes/reports.js";

async function buildApp(isService: boolean) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.auth = {
      method: isService ? "env_key" : "api_key",
      userId: null,
      apiKeyId: isService ? null : "key-1",
      contributorExternalId: null,
      isService,
      isSession: false,
    };
  });
  app.decorate("requireService", async (request: any, reply: any) => {
    if (!request.auth?.isService) {
      return reply.code(403).send({ error: "nope", code: "SERVICE_KEY_REQUIRED" });
    }
  });
  await app.register(reportRoutes, { prefix: "/reports" });
  return app;
}

beforeEach(() => {
  mocks.listAgentReports.mockReset().mockResolvedValue([ROW]);
  mocks.getAgentReportById.mockReset().mockResolvedValue(ROW);
  mocks.triageAgentReport.mockReset().mockResolvedValue({
    ...ROW,
    status: "triaged",
    triage_note: "real gap",
    triaged_by: "service:env_key",
    triaged_at: new Date("2026-08-03T00:00:00Z"),
  });
});

describe("GET /reports", () => {
  it("is refused without a service key", async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: "GET", url: "/reports" });
    expect(res.statusCode).toBe(403);
    expect(mocks.listAgentReports).not.toHaveBeenCalled();
  });

  it("lists with parsed filters and serializes the wire shape", async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: "GET",
      url: "/reports?status=new&origin=internal&limit=5&since=2026-08-01T00:00:00Z",
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.listAgentReports).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "new",
        origin: "internal",
        limit: 5,
        offset: 0,
        since: new Date("2026-08-01T00:00:00Z"),
      })
    );
    const body = res.json();
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({
      id: REPORT_ID,
      occurrence_count: 3,
      status: "new",
      last_seen_at: "2026-08-02T00:00:00.000Z",
    });
  });

  it("rejects an unknown status filter", async () => {
    const app = await buildApp(true);
    const res = await app.inject({ method: "GET", url: "/reports?status=bogus" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_QUERY");
  });
});

describe("GET /reports/:id", () => {
  it("404s on an unknown report", async () => {
    mocks.getAgentReportById.mockResolvedValue(null);
    const app = await buildApp(true);
    const res = await app.inject({ method: "GET", url: `/reports/${OTHER_ID}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /reports/:id", () => {
  it("triages with the service caller recorded as triager", async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: "PATCH",
      url: `/reports/${REPORT_ID}`,
      payload: { status: "triaged", triage_note: "real gap" },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.triageAgentReport).toHaveBeenCalledWith(REPORT_ID, {
      status: "triaged",
      triageNote: "real gap",
      duplicateOfId: null,
      triagedBy: "service:env_key",
    });
    expect(res.json().report).toMatchObject({
      status: "triaged",
      triage_note: "real gap",
      triaged_at: "2026-08-03T00:00:00.000Z",
    });
  });

  it("surfaces a triage rule violation as 400", async () => {
    mocks.triageAgentReport.mockRejectedValue(
      new Error("a duplicate report must name the report it duplicates")
    );
    const app = await buildApp(true);
    const res = await app.inject({
      method: "PATCH",
      url: `/reports/${REPORT_ID}`,
      payload: { status: "duplicate" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_TRIAGE");
  });

  it("rejects an unknown status", async () => {
    const app = await buildApp(true);
    const res = await app.inject({
      method: "PATCH",
      url: `/reports/${REPORT_ID}`,
      payload: { status: "closed" },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.triageAgentReport).not.toHaveBeenCalled();
  });
});
