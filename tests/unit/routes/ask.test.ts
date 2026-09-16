import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

/**
 * POST /ask (#312): authenticated, quota-gated at the graph_chat cap, runs
 * in the caller's usage context, maps the request's context shapes to the
 * agent's, and answers 404 when claim mode names a claim the graph lacks.
 */
const mocks = vi.hoisted(() => ({
  askGraph: vi.fn(),
  usageContexts: [] as unknown[],
  charges: [] as string[],
  refunds: [] as string[],
}));

vi.mock("../../../src/services/graph-chat-service.js", () => {
  class UnknownClaimError extends Error {
    constructor(readonly claimId: string) {
      super(`Claim not found: ${claimId}`);
    }
  }
  return { askGraph: mocks.askGraph, UnknownClaimError };
});

vi.mock("../../../src/llm/usage-context.js", () => ({
  runWithUsageContext: (ctx: unknown, fn: () => unknown) => {
    mocks.usageContexts.push(ctx);
    return fn();
  },
}));

vi.mock("../../../src/server/plugins/quota.js", () => ({
  withAgenticCharge: async (
    _auth: unknown,
    op: string,
    _refs: unknown,
    fn: () => Promise<unknown>
  ) => {
    mocks.charges.push(op);
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      mocks.refunds.push(op);
      throw err;
    }
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
  const { askRoutes } = await import("../../../src/routes/ask.js");
  const app = Fastify();
  app.decorateRequest("auth", null);
  const gates = { authenticate: 0, quota: [] as string[] };
  app.decorate("authenticate", async (request: any) => {
    gates.authenticate++;
    request.auth = userAuth;
  });
  app.decorate("requireAgenticQuota", (op: string) => async () => {
    gates.quota.push(op);
  });
  app.decorate("sendQuotaDenial", (reply: any, decision: any) =>
    reply.code(decision.statusCode).send({ code: decision.code })
  );
  await app.register(askRoutes, { prefix: "/ask" });
  return { app, gates };
}

const CLAIM = "11111111-2222-3333-4444-555555555555";
const ANSWER = {
  reply: `Grounded answer [claim:${CLAIM}]`,
  citations: [
    {
      id: CLAIM,
      canonical_form: "C",
      status: "verified",
      url: `https://minerval.ai/claims/${CLAIM}`,
    },
  ],
  model: "test-model",
};

describe("POST /ask", () => {
  beforeEach(() => {
    mocks.askGraph.mockReset();
    mocks.usageContexts.length = 0;
    mocks.charges.length = 0;
    mocks.refunds.length = 0;
  });

  it("defaults to graph mode, charges graph_chat, and returns the answer", async () => {
    mocks.askGraph.mockResolvedValue(ANSWER);
    const { app, gates } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { messages: [{ role: "user", content: "is it true?" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ANSWER);
    expect(gates.authenticate).toBe(1);
    expect(gates.quota).toEqual(["graph_chat"]);
    expect(mocks.charges).toEqual(["graph_chat"]);
    expect(mocks.askGraph).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "is it true?" }],
      context: { kind: "graph" },
    });
    expect(mocks.usageContexts[0]).toMatchObject({
      userId: "user-1",
      apiKeyId: "key-1",
    });
  });

  it("maps claim and page contexts to the agent's shapes", async () => {
    mocks.askGraph.mockResolvedValue(ANSWER);
    const { app } = await buildTestApp();

    await app.inject({
      method: "POST",
      url: "/ask",
      payload: {
        messages: [{ role: "user", content: "what does this rest on?" }],
        context: { kind: "claim", claim_id: CLAIM },
      },
    });
    expect(mocks.askGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ context: { kind: "claim", claimId: CLAIM } })
    );

    await app.inject({
      method: "POST",
      url: "/ask",
      payload: {
        messages: [{ role: "user", content: "is this page right?" }],
        context: { kind: "page", url: "https://example.com/a", title: "A" },
      },
    });
    expect(mocks.askGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: { kind: "page", url: "https://example.com/a", title: "A", claims: [] },
      })
    );
  });

  it("answers 404 for an unknown claim and the charge is refunded", async () => {
    const { UnknownClaimError } = await import(
      "../../../src/services/graph-chat-service.js"
    );
    mocks.askGraph.mockRejectedValue(new UnknownClaimError(CLAIM));
    const { app } = await buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: {
        messages: [{ role: "user", content: "hi" }],
        context: { kind: "claim", claim_id: CLAIM },
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "CLAIM_NOT_FOUND" });
    expect(mocks.refunds).toEqual(["graph_chat"]);
  });

  it("rejects a conversation that does not end with the reader's turn", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.askGraph).not.toHaveBeenCalled();
  });

  it("rejects a malformed context", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/ask",
      payload: {
        messages: [{ role: "user", content: "hi" }],
        context: { kind: "claim", claim_id: "not-a-uuid" },
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.askGraph).not.toHaveBeenCalled();
  });
});
