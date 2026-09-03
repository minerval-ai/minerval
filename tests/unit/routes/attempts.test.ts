import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

/**
 * The attempts routes (docs/mathematics.md §11.1): the public attempt log,
 * the single attempt with its transcript for service callers only, and the
 * service-key cancel that sets `cancelling`.
 */
const mocks = vi.hoisted(() => ({
  loadAttemptExtras: vi.fn(),
  getAttemptPublic: vi.fn(),
  getAttempt: vi.fn(),
  cancelAttempt: vi.fn(),
}));

vi.mock("../../../src/services/attempt-extras.js", () => ({
  loadAttemptExtras: mocks.loadAttemptExtras,
}));
vi.mock("../../../src/services/attempt-service.js", () => ({
  getAttemptPublic: mocks.getAttemptPublic,
  getAttempt: mocks.getAttempt,
  cancelAttempt: mocks.cancelAttempt,
}));

import { attemptsRoutes } from "../../../src/routes/attempts.js";

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

const ATTEMPT_ID = "a1a1a1a1-0000-4000-8000-000000000001";
const CLAIM_ID = "c1c1c1c1-0000-4000-8000-000000000001";

async function buildApp(auth: RequestAuth) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.decorate("authenticate", async (request: any) => {
    request.auth = auth;
  });
  app.decorate("requireService", async (request: any, reply: any) => {
    if (!request.auth?.isService) {
      return reply.code(403).send({ error: "service key required", code: "SERVICE_KEY_REQUIRED" });
    }
  });
  await app.register(attemptsRoutes);
  return app;
}

beforeEach(() => {
  mocks.loadAttemptExtras.mockReset();
  mocks.getAttemptPublic.mockReset();
  mocks.getAttempt.mockReset();
  mocks.cancelAttempt.mockReset();
});

describe("GET /claims/:id/attempts", () => {
  it("returns the attempt log", async () => {
    mocks.loadAttemptExtras.mockResolvedValueOnce([{ id: ATTEMPT_ID, variant: "max", status: "completed" }]);
    const app = await buildApp(userAuth);
    const res = await app.inject({ method: "GET", url: `/claims/${CLAIM_ID}/attempts` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      claim_id: CLAIM_ID,
      attempts: [{ id: ATTEMPT_ID, variant: "max", status: "completed" }],
    });
    expect(mocks.loadAttemptExtras).toHaveBeenCalledWith(CLAIM_ID);
  });
});

describe("GET /attempts/:id", () => {
  it("404s on an unknown attempt and returns the public projection otherwise", async () => {
    const app = await buildApp(userAuth);
    mocks.getAttemptPublic.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "GET", url: `/attempts/${ATTEMPT_ID}` })).statusCode).toBe(404);
    mocks.getAttemptPublic.mockResolvedValueOnce({ id: ATTEMPT_ID, status: "completed", report: null });
    const res = await app.inject({ method: "GET", url: `/attempts/${ATTEMPT_ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ATTEMPT_ID, status: "completed", report: null });
    expect(mocks.getAttemptPublic).toHaveBeenLastCalledWith(ATTEMPT_ID, { includeTranscript: false });
  });

  it("serves the transcript to service callers only", async () => {
    // Anonymous: no credentials, no transcript.
    const anon = await buildApp(userAuth);
    const denied = await anon.inject({ method: "GET", url: `/attempts/${ATTEMPT_ID}?include=transcript` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("SERVICE_KEY_REQUIRED");
    expect(mocks.getAttemptPublic).not.toHaveBeenCalled();

    // A user key: authenticated, not service.
    const asUser = await anon.inject({
      method: "GET",
      url: `/attempts/${ATTEMPT_ID}?include=transcript`,
      headers: { "x-api-key": "k" },
    });
    expect(asUser.statusCode).toBe(403);

    const service = await buildApp(serviceAuth);
    mocks.getAttemptPublic.mockResolvedValueOnce({ id: ATTEMPT_ID, transcript: [{ seq: 0 }] });
    const ok = await service.inject({
      method: "GET",
      url: `/attempts/${ATTEMPT_ID}?include=transcript`,
      headers: { "x-api-key": "k" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().transcript).toEqual([{ seq: 0 }]);
    expect(mocks.getAttemptPublic).toHaveBeenLastCalledWith(ATTEMPT_ID, { includeTranscript: true });
  });
});

describe("POST /admin/attempts/:id/cancel", () => {
  it("requires a service key", async () => {
    const app = await buildApp(userAuth);
    const res = await app.inject({ method: "POST", url: `/admin/attempts/${ATTEMPT_ID}/cancel` });
    expect(res.statusCode).toBe(403);
    expect(mocks.cancelAttempt).not.toHaveBeenCalled();
  });

  it("sets cancelling on a running attempt", async () => {
    const app = await buildApp(serviceAuth);
    mocks.cancelAttempt.mockResolvedValueOnce({ id: ATTEMPT_ID, status: "cancelling" });
    const res = await app.inject({ method: "POST", url: `/admin/attempts/${ATTEMPT_ID}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ATTEMPT_ID, status: "cancelling" });
    expect(mocks.cancelAttempt).toHaveBeenCalledWith(ATTEMPT_ID);
  });

  it("409s on an attempt that is not running and 404s on an unknown or malformed id", async () => {
    const app = await buildApp(serviceAuth);
    mocks.cancelAttempt.mockResolvedValueOnce(null);
    mocks.getAttempt.mockResolvedValueOnce({ id: ATTEMPT_ID, status: "completed" });
    const conflict = await app.inject({ method: "POST", url: `/admin/attempts/${ATTEMPT_ID}/cancel` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "ATTEMPT_NOT_RUNNING", status: "completed" });

    mocks.cancelAttempt.mockResolvedValueOnce(null);
    mocks.getAttempt.mockResolvedValueOnce(null);
    expect((await app.inject({ method: "POST", url: `/admin/attempts/${ATTEMPT_ID}/cancel` })).statusCode).toBe(404);

    expect((await app.inject({ method: "POST", url: `/admin/attempts/not-a-uuid/cancel` })).statusCode).toBe(404);
  });
});
