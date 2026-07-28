import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const mocks = vi.hoisted(() => ({
  startAnalysis: vi.fn(),
  getAnalysisByHash: vi.fn(),
  chatAboutPage: vi.fn(),
  usageContexts: [] as unknown[],
}));

vi.mock("../../../src/services/extension-service.js", () => ({
  startAnalysis: mocks.startAnalysis,
  getAnalysisByHash: mocks.getAnalysisByHash,
  chatAboutPage: mocks.chatAboutPage,
}));

// Capture the ambient usage context the route establishes for metering (#70).
vi.mock("../../../src/llm/usage-context.js", () => ({
  runWithUsageContext: (ctx: unknown, fn: () => unknown) => {
    mocks.usageContexts.push(ctx);
    return fn();
  },
}));

const userAuth: RequestAuth = {
  method: "api_key",
  userId: "user-1",
  apiKeyId: "key-1",
  contributorExternalId: "github:1",
  isService: false,
  isSession: false,
};

async function buildTestApp() {
  const { extensionRoutes } = await import("../../../src/routes/extension.js");
  const app = Fastify();
  app.decorateRequest("auth", null);
  const gates = { authenticate: 0, quota: 0 };
  app.decorate("authenticate", async (request: any) => {
    gates.authenticate++;
    request.auth = userAuth;
  });
  app.decorate("requireAgenticQuota", async () => {
    gates.quota++;
  });
  await app.register(extensionRoutes, { prefix: "/extension" });
  return { app, gates };
}

const HASH = "a".repeat(64);

const ANALYSIS = {
  url: "https://example.com/a",
  content_hash: HASH,
  annotations: [],
  stats: { extracted: 0, matched: 0 },
  analyzed_at: "2026-07-10T00:00:00.000Z",
};

describe("extension routes", () => {
  beforeEach(() => {
    mocks.startAnalysis.mockReset();
    mocks.getAnalysisByHash.mockReset();
    mocks.chatAboutPage.mockReset();
    mocks.usageContexts.length = 0;
  });

  it("POST /extension/analyze returns 200 with the result when ready in time", async () => {
    mocks.startAnalysis.mockResolvedValue({
      state: "ready",
      analysis: ANALYSIS,
      cached: false,
    });
    const { app, gates } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: {
        url: "https://example.com/a",
        title: "A",
        content: "x".repeat(200),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ...ANALYSIS, cached: false });
    expect(gates.authenticate).toBe(1);
    expect(gates.quota).toBe(1);
    expect(mocks.usageContexts[0]).toMatchObject({
      userId: "user-1",
      apiKeyId: "key-1",
    });
  });

  it("POST /extension/analyze returns 202 + content_hash when the run outlasts the grace window (#93)", async () => {
    mocks.startAnalysis.mockResolvedValue({
      state: "running",
      content_hash: HASH,
    });
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "x".repeat(200) },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ content_hash: HASH, status: "running" });
  });

  it("GET /extension/analysis/:hash maps ready/running/failed/unknown to 200/202/502/404", async () => {
    const { app, gates } = await buildTestApp();
    const cases = [
      [{ state: "ready", analysis: ANALYSIS, cached: true }, 200],
      [{ state: "running", content_hash: HASH }, 202],
      [{ state: "failed", content_hash: HASH, error: "boom" }, 502],
      [{ state: "unknown" }, 404],
    ] as const;

    for (const [state, expected] of cases) {
      mocks.getAnalysisByHash.mockReturnValueOnce(state);
      const res = await app.inject({
        method: "GET",
        url: `/extension/analysis/${HASH}`,
      });
      expect(res.statusCode).toBe(expected);
    }
    // Poll is authenticated but NOT quota-gated: it does no LLM work.
    expect(gates.authenticate).toBe(4);
    expect(gates.quota).toBe(0);
  });

  it("GET /extension/analysis rejects a malformed hash", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/extension/analysis/not-a-hash",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.getAnalysisByHash).not.toHaveBeenCalled();
  });

  it("POST /extension/chat forwards history + page context and returns citations", async () => {
    mocks.chatAboutPage.mockResolvedValue({
      reply: "Grounded answer [claim:11111111-2222-3333-4444-555555555555]",
      citations: [
        {
          id: "11111111-2222-3333-4444-555555555555",
          canonical_form: "C",
          status: "verified",
          url: "https://minerval.ai/claims/11111111-2222-3333-4444-555555555555",
        },
      ],
    });
    const { app, gates } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/chat",
      payload: {
        messages: [{ role: "user", content: "is this true?" }],
        page: { url: "https://example.com/a", title: "A", claims: [] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().citations).toHaveLength(1);
    expect(gates.quota).toBe(1);
    expect(mocks.chatAboutPage).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "is this true?" }],
      })
    );
  });

  it("rejects a chat whose last message is not from the user", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/extension/chat",
      payload: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.chatAboutPage).not.toHaveBeenCalled();
  });

  it("rejects content that is too short to analyze", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "too short" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
});
