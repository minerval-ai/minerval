/**
 * GET /setup/preflight (src/routes/preflight.ts): the report whole, for the
 * operator key and nobody else.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";

const REPORT = {
  holds_private_material: true,
  ready: false,
  agent_work: "refused",
  checks: [
    { name: "database", status: "pass", blocking: true, message: "The database is reachable." },
    { name: "run_log", status: "fail", blocking: true, message: "The run log is in best-effort mode." },
    { name: "page_reading", status: "not_applicable", blocking: false, message: "Nothing to configure." },
  ],
};

const mocks = vi.hoisted(() => ({ runPreflight: vi.fn() }));

vi.mock("../../../src/preflight.js", () => ({
  runPreflight: mocks.runPreflight,
  PREFLIGHT_CHECKS: [{ name: "database" }, { name: "run_log" }, { name: "page_reading" }],
}));
vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: vi.fn(async () => null),
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorByExternalId: vi.fn(async () => null),
  getOrCreateContributor: vi.fn(),
}));

async function buildApp(operatorKey: string | undefined) {
  if (operatorKey === undefined) delete process.env.MINERVAL_OPERATOR_KEY;
  else process.env.MINERVAL_OPERATOR_KEY = operatorKey;
  process.env.API_KEYS = "service-key";
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { preflightRoutes } = await import("../../../src/routes/preflight.js");
  const app = Fastify();
  await registerAuth(app);
  await app.register(preflightRoutes, { prefix: "/setup" });
  return app;
}

afterEach(() => {
  delete process.env.MINERVAL_OPERATOR_KEY;
  delete process.env.API_KEYS;
  mocks.runPreflight.mockReset();
});

describe("GET /setup/preflight", () => {
  it("serves the report whole to the operator key", async () => {
    mocks.runPreflight.mockResolvedValue(REPORT);
    const app = await buildApp("op-key");
    const res = await app.inject({ url: "/setup/preflight", headers: { "x-operator-key": "op-key" } });
    expect(res.statusCode).toBe(200);
    // Nothing is dropped by the response schema.
    expect(res.json()).toEqual(REPORT);
  });

  it("refuses a caller with no key, the wrong key, or the service key, and runs nothing", async () => {
    const app = await buildApp("op-key");
    for (const headers of [{}, { "x-operator-key": "nope" }, { "x-api-key": "service-key" }]) {
      const res = await app.inject({ url: "/setup/preflight", headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("OPERATOR_KEY_REQUIRED");
    }
    expect(mocks.runPreflight).not.toHaveBeenCalled();
  });

  it("is closed to everyone where no operator key is set", async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({ url: "/setup/preflight", headers: { "x-operator-key": "" } });
    expect(res.statusCode).toBe(403);
    expect(mocks.runPreflight).not.toHaveBeenCalled();
  });
});
