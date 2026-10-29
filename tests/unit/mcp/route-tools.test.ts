/**
 * Route tools (src/mcp/route-tools.ts) end to end: an MCP client calls a
 * generated tool, the call dispatches into the REST route in-process
 * (src/mcp/dispatch.ts), and the route sees the MCP caller's identity, OAuth
 * included, while an OAuth token presented to the route directly is still
 * refused and a forged dispatch header gets nothing.
 *
 * The routes here are stand-ins registered at real route keys, so the
 * generated tools pick them up; their handlers echo what they received.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  resolveAccessToken: vi.fn(async () => null as unknown),
}));

vi.mock("../../../src/services/oauth-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/oauth-service.js")
  >()),
  resolveAccessToken: mocks.resolveAccessToken,
}));
vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: vi.fn(async () => null),
}));

let app: FastifyInstance;
let baseUrl: string;

const OAUTH_USER = {
  token: { id: "tok-1", userId: "contrib-1", scope: "mcp" },
  user: {
    id: "contrib-1",
    externalId: "github:42",
    displayName: "Consenting User",
    isSuspended: false,
  },
};

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: "Bearer eoat_test-token" } },
  });
  const client = new Client({ name: "route-tools-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function parseText(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

beforeAll(async () => {
  process.env.API_KEYS = "envkey";
  process.env.ENVIRONMENT = "development";
  vi.resetModules();

  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { registerQuota } = await import("../../../src/server/plugins/quota.js");
  const { registerRouteCatalog } = await import(
    "../../../src/server/plugins/route-catalog.js"
  );
  const { mcpRoutes } = await import("../../../src/routes/mcp.js");

  app = Fastify();
  await registerAuth(app);
  await registerQuota(app);
  await registerRouteCatalog(app);

  // GET /users/me → get_account: an account route behind requireUser.
  app.get(
    "/users/me",
    {
      schema: { summary: "Get the authenticated account" },
      preHandler: [app.authenticate, app.requireUser],
    },
    async (request) => ({ auth: request.auth })
  );
  // POST /claims/:claim_id/order → order_assessment: a path param, and a
  // route that refuses with an owl-shaped 402.
  app.post<{ Params: { claim_id: string } }>(
    "/claims/:claim_id/order",
    {
      schema: {
        summary: "Order a (re)assessment of this claim",
        params: {
          type: "object",
          properties: { claim_id: { type: "string", format: "uuid" } },
        },
      },
      preHandler: [app.authenticate, app.requireUser],
    },
    async (request, reply) =>
      reply.code(402).send({
        error: `No owls for ${request.params.claim_id}`,
        code: "INSUFFICIENT_OWLS",
        cap_owls: 1,
      })
  );
  // GET /claims/:claim_id/assessments → get_assessment_history: params and
  // querystring together, error envelope in the nested style.
  app.get<{ Params: { claim_id: string }; Querystring: { limit?: number } }>(
    "/claims/:claim_id/assessments",
    {
      schema: {
        summary: "Get paginated assessment history for a claim",
        params: {
          type: "object",
          properties: { claim_id: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        },
      },
    },
    async (request, reply) => {
      if (request.params.claim_id === "missing") {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "Claim not found" } });
      }
      return { claim_id: request.params.claim_id, limit: request.query.limit };
    }
  );
  // POST /appeals → submit_appeal: a body.
  app.post<{ Body: { contribution_id: string; appeal_reasoning: string } }>(
    "/appeals",
    {
      schema: {
        summary: "Appeal a rejected contribution",
        body: {
          type: "object",
          required: ["contribution_id", "appeal_reasoning"],
          properties: {
            contribution_id: { type: "string" },
            appeal_reasoning: { type: "string" },
          },
        },
      },
      preHandler: app.authenticate,
    },
    async (request) => ({ received: request.body, user: request.auth?.userId })
  );
  // GET /prize-claims/:id → get_prize_claim: open to anyone, answered
  // differently for the owner, so it authenticates only when credentials
  // are presented. A dispatched call presents them.
  const { presentsCredentials } = await import(
    "../../../src/server/plugins/auth.js"
  );
  app.get(
    "/prize-claims/:id",
    {
      schema: {
        summary: "One prize claim's public projection",
        params: { type: "object", properties: { id: { type: "string" } } },
      },
      preHandler: async (request, reply) => {
        if (presentsCredentials(request)) await app.authenticate(request, reply);
      },
    },
    async (request) => ({ viewer: request.auth?.userId ?? null })
  );
  // An excluded route: never a tool.
  app.post("/billing/checkout", async () => ({ ok: true }));

  await app.register(mcpRoutes, { prefix: "/mcp" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mocks.resolveAccessToken.mockReset().mockResolvedValue(OAUTH_USER);
});

describe("route tools", () => {
  it("lists generated tools with the route's summary, and no excluded route", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const account = tools.find((t) => t.name === "get_account");
    expect(account?.description).toContain("Get the authenticated account");
    expect(account?.description).toContain("GET /users/me");
    expect(account?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "order_assessment")?.annotations?.readOnlyHint).toBe(
      false
    );
    expect(tools.some((t) => t.description?.includes("/billing/checkout"))).toBe(false);
    await client.close();
  });

  it("carries the OAuth caller's identity into the route", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_account", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(parseText(result).auth).toMatchObject({
      method: "oauth",
      userId: "contrib-1",
      contributorExternalId: "github:42",
      isService: false,
      isSession: false,
    });
    await client.close();
  });

  it("still refuses the same OAuth token presented to the route directly", async () => {
    const res = await fetch(`${baseUrl}/users/me`, {
      headers: { Authorization: "Bearer eoat_test-token" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("INSUFFICIENT_SCOPE");
  });

  it("refuses a dispatch header that names no in-flight call", async () => {
    const res = await fetch(`${baseUrl}/users/me`, {
      headers: { "x-minerval-mcp-dispatch": "a".repeat(64) },
    });
    expect(res.status).toBe(401);
  });

  it("fills path params and querystring, and passes the body", async () => {
    const client = await connect();
    const history = await client.callTool({
      name: "get_assessment_history",
      arguments: { claim_id: CLAIM_ID, limit: 5 },
    });
    expect(parseText(history)).toEqual({ claim_id: CLAIM_ID, limit: 5 });

    const appeal = await client.callTool({
      name: "submit_appeal",
      arguments: { contribution_id: "c-1", appeal_reasoning: "The reviewer misread the source." },
    });
    expect(parseText(appeal)).toEqual({
      received: { contribution_id: "c-1", appeal_reasoning: "The reviewer misread the source." },
      user: "contrib-1",
    });
    await client.close();
  });

  it("authenticates on open routes that read the viewer when credentials are presented", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_prize_claim",
      arguments: { id: "pc-1" },
    });
    expect(parseText(result)).toEqual({ viewer: "contrib-1" });
    await client.close();
  });

  it("turns route refusals into tool errors that keep the code and the details", async () => {
    const client = await connect();
    const order = await client.callTool({
      name: "order_assessment",
      arguments: { claim_id: CLAIM_ID },
    });
    expect(order.isError).toBe(true);
    expect(parseText(order).error).toEqual({
      code: "INSUFFICIENT_OWLS",
      message: `No owls for ${CLAIM_ID}`,
      status: 402,
      cap_owls: 1,
    });

    const missing = await client.callTool({
      name: "get_assessment_history",
      arguments: { claim_id: "missing" },
    });
    expect(missing.isError).toBe(true);
    expect(parseText(missing).error).toMatchObject({
      code: "NOT_FOUND",
      message: "Claim not found",
      status: 404,
    });
    await client.close();
  });

  it("validates input against the route's schema before dispatching", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_assessment_history",
      arguments: { claim_id: CLAIM_ID, limit: 500 },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
