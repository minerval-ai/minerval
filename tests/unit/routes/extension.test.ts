import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const mocks = vi.hoisted(() => ({
  startAnalysis: vi.fn(),
  getAnalysisByHash: vi.fn(),
  chatAboutPage: vi.fn(),
  whenAnalysisSettles: vi.fn(),
  shareIfPublic: vi.fn(),
  listSharedHashes: vi.fn(),
  getSharedAnalysis: vi.fn(),
  usageContexts: [] as unknown[],
  charges: [] as string[],
  refunds: [] as string[],
}));

vi.mock("../../../src/services/extension-service.js", () => ({
  startAnalysis: mocks.startAnalysis,
  getAnalysisByHash: mocks.getAnalysisByHash,
  chatAboutPage: mocks.chatAboutPage,
  whenAnalysisSettles: mocks.whenAnalysisSettles,
}));

vi.mock("../../../src/services/shared-analysis-service.js", () => ({
  shareIfPublic: mocks.shareIfPublic,
  listSharedHashes: mocks.listSharedHashes,
  getSharedAnalysis: mocks.getSharedAnalysis,
}));

// Capture the ambient usage context the route establishes for metering (#70).
vi.mock("../../../src/llm/usage-context.js", () => ({
  runBudget: () => null,
  budgetRefusal: () => null,
  runWithUsageContext: (ctx: unknown, fn: () => unknown) => {
    mocks.usageContexts.push(ctx);
    return fn();
  },
}));

// Charge-at-start helpers (owl economy): record the ops charged/refunded.
vi.mock("../../../src/server/plugins/quota.js", () => ({
  withAgenticCharge: async (
    _auth: unknown,
    op: string,
    _refs: unknown,
    fn: () => Promise<unknown>
  ) => {
    mocks.charges.push(op);
    return { ok: true, value: await fn() };
  },
  refundAgenticOp: async (_auth: unknown, op: string) => {
    mocks.refunds.push(op);
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
  app.decorate("requireAgenticQuota", () => async () => {
    gates.quota++;
  });
  app.decorate("sendQuotaDenial", (reply: any, decision: any) =>
    reply.code(decision.statusCode).send({ code: decision.code })
  );
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
    mocks.whenAnalysisSettles.mockReset();
    mocks.shareIfPublic.mockReset().mockResolvedValue({ shared: true });
    mocks.listSharedHashes.mockReset();
    mocks.getSharedAnalysis.mockReset();
    mocks.usageContexts.length = 0;
    mocks.charges.length = 0;
    mocks.refunds.length = 0;
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
    expect(mocks.charges).toEqual(["extension_analysis"]);
    expect(mocks.refunds).toEqual([]);
    expect(mocks.usageContexts[0]).toMatchObject({
      userId: "user-1",
      apiKeyId: "key-1",
    });
  });

  it("POST /extension/analyze refunds the charge on a cache hit", async () => {
    mocks.startAnalysis.mockResolvedValue({
      state: "ready",
      analysis: ANALYSIS,
      cached: true,
    });
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "x".repeat(200) },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.charges).toEqual(["extension_analysis"]);
    expect(mocks.refunds).toEqual(["extension_analysis"]);
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

  it("POST /extension/analyze shares nothing unless the reader asked", async () => {
    mocks.startAnalysis.mockResolvedValue({ state: "ready", analysis: ANALYSIS, cached: false });
    const { app } = await buildTestApp();

    await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "x".repeat(200) },
    });
    await new Promise((r) => setImmediate(r));
    expect(mocks.shareIfPublic).not.toHaveBeenCalled();
  });

  it("POST /extension/analyze with share=true offers the finished analysis for sharing", async () => {
    mocks.startAnalysis.mockResolvedValue({ state: "ready", analysis: ANALYSIS, cached: false });
    const { app } = await buildTestApp();

    await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "x".repeat(200), share: true },
    });
    await new Promise((r) => setImmediate(r));
    expect(mocks.shareIfPublic).toHaveBeenCalledWith("https://example.com/a", ANALYSIS);
  });

  it("POST /extension/analyze with share=true shares a 202 run once it settles", async () => {
    mocks.startAnalysis.mockResolvedValue({ state: "running", content_hash: HASH });
    mocks.whenAnalysisSettles.mockResolvedValue(ANALYSIS);
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/analyze",
      payload: { url: "https://example.com/a", content: "x".repeat(200), share: true },
    });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(mocks.whenAnalysisSettles).toHaveBeenCalledWith(HASH);
    expect(mocks.shareIfPublic).toHaveBeenCalledWith("https://example.com/a", ANALYSIS);
  });

  it("GET /extension/shared lists a prefix bucket without authenticating", async () => {
    mocks.listSharedHashes.mockResolvedValue([HASH]);
    const { app, gates } = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/extension/shared?prefix=aaaa" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hashes: [HASH] });
    expect(gates.authenticate).toBe(0);

    const bad = await app.inject({ method: "GET", url: "/extension/shared?prefix=aaaaaa" });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("GET /extension/shared/:hash serves a shared analysis, 404 when none", async () => {
    mocks.getSharedAnalysis.mockResolvedValueOnce({ ...ANALYSIS, shared: true });
    mocks.getSharedAnalysis.mockResolvedValueOnce(null);
    const { app, gates } = await buildTestApp();

    const hit = await app.inject({ method: "GET", url: `/extension/shared/${HASH}` });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({ shared: true, url: ANALYSIS.url });
    const miss = await app.inject({ method: "GET", url: `/extension/shared/${HASH}` });
    expect(miss.statusCode).toBe(404);
    expect(gates.authenticate).toBe(0);
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

  it("POST /extension/chat streams the reply as it forms when asked for an event stream", async () => {
    mocks.chatAboutPage.mockImplementation(
      async (input: { onText?: (delta: string, turn: number) => void }) => {
        input.onText?.("Checking the graph.", 0);
        input.onText?.("Grounded ", 1);
        input.onText?.("answer.", 1);
        return { reply: "Grounded answer.", citations: [] };
      }
    );
    const { app, gates } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/extension/chat",
      headers: { accept: "text/event-stream" },
      payload: {
        messages: [{ role: "user", content: "is this true?" }],
        page: { url: "https://example.com/a", title: "A", claims: [] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(gates.quota).toBe(1);
    const events = res.body
      .trim()
      .split("\n\n")
      .map((block) => {
        const [event, data] = block.split("\n");
        return { event: event!.slice("event: ".length), data: JSON.parse(data!.slice("data: ".length)) };
      });
    expect(events).toEqual([
      { event: "text", data: { delta: "Checking the graph.", turn: 0 } },
      { event: "text", data: { delta: "Grounded ", turn: 1 } },
      { event: "text", data: { delta: "answer.", turn: 1 } },
      { event: "done", data: { reply: "Grounded answer.", citations: [] } },
    ]);
  });

  it("POST /extension/chat ends the stream with an error event when the agent fails mid-answer", async () => {
    mocks.chatAboutPage.mockImplementation(
      async (input: { onText?: (delta: string, turn: number) => void }) => {
        input.onText?.("Half an", 0);
        throw new Error("provider went away");
      }
    );
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/extension/chat",
      headers: { accept: "text/event-stream" },
      payload: {
        messages: [{ role: "user", content: "is this true?" }],
        page: { url: "https://example.com/a", title: "A", claims: [] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: text");
    expect(res.body.trim().split("\n\n").at(-1)).toMatch(/^event: error\n/);
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
