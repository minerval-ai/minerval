/**
 * The platform-mandate routes (#529): the operator routes accept the
 * operator key and nothing else (not the service key, which acts for any
 * user), map the funding refusals to statuses, and the public read of a
 * platform conversation needs no credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

const mocks = vi.hoisted(() => ({
  fundPlatformConversation: vi.fn(),
  createPlatformGrantmakingKey: vi.fn(),
  listPlatformGrantmakingKeys: vi.fn(async () => []),
  revokePlatformGrantmakingKey: vi.fn(),
  getPublicPlatformConversation: vi.fn(),
}));

vi.mock("../../../src/services/platform-mandate-service.js", () => mocks);
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
vi.mock("../../../src/services/grant-conversation-service.js", () => ({
  startConversation: vi.fn(),
  addMessage: vi.fn(),
  fundConversationMandate: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  serializeConversation: vi.fn(),
}));

const CONVO = "c0c0c0c0-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const fundBody = {
  conversation_id: CONVO,
  budget_owls: 500,
  mandate_sha256: SHA,
  approval_url: "https://github.com/minerval-ai/minerval/pull/1",
  approved_by: "jacksonqueenking",
};

async function buildApp() {
  process.env.MINERVAL_OPERATOR_KEY = "op-key";
  process.env.API_KEYS = "service-key";
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { platformMandateRoutes } = await import("../../../src/routes/platform-mandates.js");
  const { grantConversationRoutes } = await import("../../../src/routes/grant-conversations.js");
  const app = Fastify();
  await registerAuth(app);
  await app.register(platformMandateRoutes, { prefix: "/operator" });
  await app.register(grantConversationRoutes, { prefix: "/grant-conversations" });
  return app;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(() => {
  delete process.env.MINERVAL_OPERATOR_KEY;
  delete process.env.API_KEYS;
});

describe("POST /operator/platform-mandates/fund", () => {
  it("funds with the operator key and reports a fresh grant as 201", async () => {
    mocks.fundPlatformConversation.mockResolvedValue({ ok: true, grantId: "g-1", alreadyFunded: false });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/operator/platform-mandates/fund",
      headers: { "x-operator-key": "op-key" },
      payload: fundBody,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ grant_id: "g-1", already_funded: false });
    expect(mocks.fundPlatformConversation).toHaveBeenCalledWith({
      conversationId: CONVO,
      budgetOwls: 500,
      mandateSha256: SHA,
      approvalUrl: fundBody.approval_url,
      approvedBy: fundBody.approved_by,
    });
  });

  it("reports an already-funded conversation as 200", async () => {
    mocks.fundPlatformConversation.mockResolvedValue({ ok: true, grantId: "g-1", alreadyFunded: true });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/operator/platform-mandates/fund", headers: { "x-operator-key": "op-key" }, payload: fundBody });
    expect(res.statusCode).toBe(200);
  });

  it("maps a revised draft to 409 and an unknown conversation to 404", async () => {
    const app = await buildApp();
    mocks.fundPlatformConversation.mockResolvedValueOnce({ ok: false, code: "DRAFT_CHANGED", message: "changed" });
    const changed = await app.inject({ method: "POST", url: "/operator/platform-mandates/fund", headers: { "x-operator-key": "op-key" }, payload: fundBody });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("DRAFT_CHANGED");
    mocks.fundPlatformConversation.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND", message: "none" });
    const missing = await app.inject({ method: "POST", url: "/operator/platform-mandates/fund", headers: { "x-operator-key": "op-key" }, payload: fundBody });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses the service key and a missing key: neither moves the platform's money", async () => {
    const app = await buildApp();
    for (const headers of [{ "x-api-key": "service-key" }, {}] as Array<Record<string, string>>) {
      const res = await app.inject({ method: "POST", url: "/operator/platform-mandates/fund", headers, payload: fundBody });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("OPERATOR_KEY_REQUIRED");
    }
    expect(mocks.fundPlatformConversation).not.toHaveBeenCalled();
  });

  it("refuses a malformed pin before reaching the service", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/operator/platform-mandates/fund",
      headers: { "x-operator-key": "op-key" },
      payload: { ...fundBody, mandate_sha256: "not-a-hash" },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.fundPlatformConversation).not.toHaveBeenCalled();
  });
});

describe("platform-grantmaking keys", () => {
  it("are minted only with the operator key, plaintext returned once", async () => {
    mocks.createPlatformGrantmakingKey.mockResolvedValue({
      key: { id: "k-1", name: "agent", keyPrefix: "epk_abcdefgh", scope: "platform_grantmaking", createdAt: new Date(), lastUsedAt: null, revokedAt: null },
      plaintext: "epk_secret",
    });
    const app = await buildApp();
    const denied = await app.inject({ method: "POST", url: "/operator/platform-grantmaking-keys", headers: { "x-api-key": "service-key" }, payload: { name: "agent" } });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/operator/platform-grantmaking-keys", headers: { "x-operator-key": "op-key" }, payload: { name: "agent" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ plaintext: "epk_secret", key: { id: "k-1", scope: "platform_grantmaking" } });
  });

  it("revoke answers 404 for a key that is not a live platform-grantmaking key", async () => {
    mocks.revokePlatformGrantmakingKey.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/operator/platform-grantmaking-keys/d1d1d1d1-0000-4000-8000-000000000001",
      headers: { "x-operator-key": "op-key" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /grant-conversations/platform/:id", () => {
  it("is public", async () => {
    mocks.getPublicPlatformConversation.mockResolvedValue({ id: CONVO, funder: "Minerval", status: "proposed" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/grant-conversations/platform/${CONVO}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation).toMatchObject({ id: CONVO, funder: "Minerval" });
  });

  it("answers 404 for anything that is not a platform conversation", async () => {
    mocks.getPublicPlatformConversation.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/grant-conversations/platform/${CONVO}` });
    expect(res.statusCode).toBe(404);
  });
});
