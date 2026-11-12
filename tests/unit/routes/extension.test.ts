import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const mocks = vi.hoisted(() => ({
  startAnalysis: vi.fn(),
  getAnalysisByHash: vi.fn(),
  whenAnalysisSettles: vi.fn(),
  shareIfPublic: vi.fn(),
  listSharedHashes: vi.fn(),
  listRecordedHashes: vi.fn(async () => [] as string[]),
  getRecordedPage: vi.fn(async () => null as unknown),
  getSharedAnalysis: vi.fn(),
  usageContexts: [] as unknown[],
  charges: [] as string[],
  refunds: [] as string[],
}));

vi.mock("../../../src/services/extension-service.js", () => ({
  startAnalysis: mocks.startAnalysis,
  getAnalysisByHash: mocks.getAnalysisByHash,
  whenAnalysisSettles: mocks.whenAnalysisSettles,
}));

vi.mock("../../../src/services/shared-analysis-service.js", () => ({
  shareIfPublic: mocks.shareIfPublic,
  listSharedHashes: mocks.listSharedHashes,
  getSharedAnalysis: mocks.getSharedAnalysis,
}));

vi.mock("../../../src/services/recorded-page-service.js", () => ({
  listRecordedHashes: mocks.listRecordedHashes,
  getRecordedPage: mocks.getRecordedPage,
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
const RECORDED_HASH = `aaaa${"b".repeat(60)}`;

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

  // A cache hit is metered at zero, so withAgenticCharge's settlement returns
  // the whole cap. A second, explicit refund would credit it twice and mint
  // owls on every repeated request.
  it("POST /extension/analyze leaves a cache hit's refund to the meter settlement", async () => {
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
    expect(mocks.refunds).toEqual([]);
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
    mocks.listRecordedHashes.mockResolvedValue([RECORDED_HASH]);
    const { app, gates } = await buildTestApp();

    const res = await app.inject({ method: "GET", url: "/extension/shared?prefix=aaaa" });
    expect(res.statusCode).toBe(200);
    // Shared analyses, and apart from them the pages the graph read.
    expect(res.json()).toEqual({ hashes: [HASH], recorded: [RECORDED_HASH] });
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

  it("GET /extension/recorded/:hash serves what the graph recorded, keyless, 404 when nothing", async () => {
    const page = {
      sources: [{ id: "s1", title: "A paper", url: "https://minerval.ai/sources/s1", retrieved_at: "2026-07-22T00:00:00.000Z" }],
      passages: [{ verbatim_text: "A passage.", stance: "affirms", instance_id: "i1", source_id: "s1", claim: { id: "c1" } }],
      total: 1,
    };
    mocks.getRecordedPage.mockResolvedValueOnce(page);
    mocks.getRecordedPage.mockResolvedValueOnce(null);
    const { app, gates } = await buildTestApp();

    const hit = await app.inject({ method: "GET", url: `/extension/recorded/${RECORDED_HASH}` });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toEqual(page);
    const miss = await app.inject({ method: "GET", url: `/extension/recorded/${RECORDED_HASH}` });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe("NOT_RECORDED");
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
