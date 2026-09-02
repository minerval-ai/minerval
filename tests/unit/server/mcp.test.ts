/**
 * Remote MCP server (#73): end-to-end over real streamable HTTP with the
 * official MCP client, against a Fastify app whose DB/LLM services are
 * mocked. Covers the three tool tiers — free reads, agentic (quota-gated,
 * usage-attributed), and the contribution write path — plus auth.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLAIM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const CLAIM_ROW = {
  id: CLAIM_ID,
  text: "Inflation in 2022 was primarily driven by supply-chain disruption",
  claimType: "causal",
  state: "active",
  decompositionStatus: "decomposed",
  importance: 0.9,
  stewardState: "done",
  createdBy: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

const ASSESSMENT_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  status: "well_supported",
  confidence: 0.82,
  reasoningTrace: "Subclaims largely settled.",
  assessedAt: new Date("2026-01-03T00:00:00Z"),
};

const mocks = vi.hoisted(() => ({
  hybridSearch: vi.fn(),
  getClaimById: vi.fn(),
  getClaimInstances: vi.fn(async () => []),
  listClaims: vi.fn(async () => ({ results: [], next_cursor: null })),
  getCurrentAssessment: vi.fn(),
  getClaimTree: vi.fn(),
  getSubclaimCount: vi.fn(async () => 3),
  listClaimDependents: vi.fn(async () => ({ dependents: [], total: 0 })),
  getTransitiveDependents: vi.fn(async () => ({
    dependents: [],
    total: 0,
    truncated: false,
  })),
  getArgumentsForClaim: vi.fn(async () => []),
  matchClaim: vi.fn(),
  extractClaims: vi.fn(),
  createContribution: vi.fn(),
  getContributionById: vi.fn(),
  getReviewForContribution: vi.fn(async () => null),
  getOrCreateContributor: vi.fn(),
  getContributorByExternalId: vi.fn(async () => null),
  enqueueContribution: vi.fn(async () => undefined),
  resolveApiKey: vi.fn(async () => null as unknown),
  resolveAccessToken: vi.fn(async () => null as unknown),
  checkSpend: vi.fn(),
  chargeOwls: vi.fn(async () => ({ charged: true, entryId: "entry-1" })),
  refundOwls: vi.fn(async () => {}),
  usageContexts: [] as unknown[],
}));

vi.mock("../../../src/services/search-service.js", () => ({
  hybridSearch: mocks.hybridSearch,
}));
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
  getClaimInstances: mocks.getClaimInstances,
  listClaims: mocks.listClaims,
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: mocks.getCurrentAssessment,
}));
vi.mock("../../../src/services/tree-service.js", () => ({
  getClaimTree: mocks.getClaimTree,
  getSubclaimCount: mocks.getSubclaimCount,
  listClaimDependents: mocks.listClaimDependents,
  getTransitiveDependents: mocks.getTransitiveDependents,
}));
vi.mock("../../../src/services/argument-service.js", () => ({
  getArgumentsForClaim: mocks.getArgumentsForClaim,
}));
vi.mock("../../../src/llm/agents/matcher.js", () => ({
  matchClaim: mocks.matchClaim,
}));
vi.mock("../../../src/llm/agents/extractor.js", () => ({
  extractClaims: mocks.extractClaims,
}));
vi.mock("../../../src/services/contribution-service.js", () => ({
  createContribution: mocks.createContribution,
  getContributionById: mocks.getContributionById,
  getReviewForContribution: mocks.getReviewForContribution,
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: mocks.getOrCreateContributor,
  getContributorByExternalId: mocks.getContributorByExternalId,
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueContribution: mocks.enqueueContribution,
}));
vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: mocks.resolveApiKey,
}));
vi.mock("../../../src/services/oauth-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/oauth-service.js")
  >()),
  resolveAccessToken: mocks.resolveAccessToken,
}));
vi.mock("../../../src/services/billing-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/billing-service.js")
  >()),
  checkSpend: mocks.checkSpend,
  getEntitlement: vi.fn(),
  serializeOwlPacks: () => [],
}));
vi.mock("../../../src/services/owl-ledger-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/owl-ledger-service.js")
  >()),
  chargeOwls: mocks.chargeOwls,
  refundOwls: mocks.refundOwls,
}));

let app: FastifyInstance;
let baseUrl: string;

async function connect(headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function parseText(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

beforeAll(async () => {
  // Two env keys: "boundkey" is bound to a contributor identity, "freekey"
  // is not. DB-backed keys go through the resolveApiKey mock.
  process.env.API_KEYS = "freekey,boundkey:mcp:tester";
  process.env.ENVIRONMENT = "development";
  vi.resetModules();

  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { registerQuota } = await import("../../../src/server/plugins/quota.js");
  const { mcpRoutes } = await import("../../../src/routes/mcp.js");

  app = Fastify();
  await registerAuth(app);
  await registerQuota(app);
  await app.register(mcpRoutes, { prefix: "/mcp" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "string" || !address) throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const { resetRateLimiter } = await import(
    "../../../src/server/plugins/quota.js"
  );
  resetRateLimiter();
  mocks.usageContexts.length = 0;
  mocks.hybridSearch.mockReset().mockResolvedValue({
    results: [
      {
        id: CLAIM_ID,
        text: CLAIM_ROW.text,
        claim_type: "causal",
        state: "active",
        similarity_score: 0.91,
        importance: 0.9,
        assessment_status: "well_supported",
        assessment_confidence: 0.82,
      },
    ],
    total: 1,
  });
  mocks.getClaimById
    .mockReset()
    .mockImplementation(async (id: string) =>
      id === CLAIM_ID ? CLAIM_ROW : null
    );
  mocks.resolveAccessToken.mockReset().mockResolvedValue(null);
  mocks.getCurrentAssessment.mockReset().mockResolvedValue(ASSESSMENT_ROW);
  mocks.getClaimTree.mockReset().mockResolvedValue({
    id: CLAIM_ID,
    text: CLAIM_ROW.text,
    children: [],
  });
  mocks.matchClaim.mockReset().mockImplementation(async () => {
    const { getUsageContext } = await import(
      "../../../src/llm/usage-context.js"
    );
    mocks.usageContexts.push(getUsageContext());
    return {
      is_match: true,
      matched_claim_id: CLAIM_ID,
      new_canonical_form: null,
      instance_stance: "affirms",
      confidence: 0.88,
      reasoning: "Same proposition.",
      alternative_matches: [],
      relationship_notes: null,
    };
  });
  mocks.extractClaims.mockReset().mockResolvedValue([
    {
      original_text: "Inflation was caused by supply chains",
      context: null,
      proposed_canonical_form: CLAIM_ROW.text,
      claim_type: "causal",
      confidence: 0.9,
      importance: 0.8,
      source_location: null,
    },
  ]);
  mocks.createContribution.mockReset().mockResolvedValue({
    id: OTHER_ID,
    claimId: CLAIM_ID,
    contributorId: "contrib-1",
    contributionType: "challenge",
    content: "This ignores monetary policy.",
    evidenceUrls: [],
    submittedAt: new Date("2026-02-01T00:00:00Z"),
    reviewStatus: "pending",
    mergeTargetClaimId: null,
    proposedCanonicalForm: null,
  });
  mocks.getOrCreateContributor.mockReset().mockResolvedValue({
    id: "contrib-1",
    externalId: "mcp:tester",
    displayName: "mcp:tester",
    isSuspended: false,
    suspensionReason: null,
    contributionStanding: "good",
    reputationScore: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const { resetContributionRateLimiter } = await import(
    "../../../src/services/reputation-service.js"
  );
  resetContributionRateLimiter();
  mocks.enqueueContribution.mockReset().mockResolvedValue(undefined);
  mocks.resolveApiKey.mockReset().mockResolvedValue(null);
  mocks.checkSpend.mockReset().mockResolvedValue({
    allowed: true,
    capOwls: 0.1,
    entitlement: {
      owlBalance: 5,
      owlBalanceMicroUsd: 20_000_000,
      owlPriceMicroUsd: 4_000_000,
      capsOwls: { text_analysis: 0.1 },
      creditsEnabled: false,
      signupGrantOwls: 5,
      monthlyGrantOwls: 1,
    },
  });
  mocks.chargeOwls
    .mockReset()
    .mockResolvedValue({ charged: true, entryId: "entry-1" });
});

describe("MCP endpoint auth", () => {
  it("rejects unauthenticated clients", async () => {
    await expect(connect({})).rejects.toThrow(/Invalid or missing API key/);
  });

  it("accepts Authorization: Bearer <api-key>", async () => {
    const client = await connect({ Authorization: "Bearer boundkey" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("rejects GET (stateless: no SSE stream)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { "x-api-key": "boundkey", accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });

  it("accepts an OAuth access token and resolves the consenting user", async () => {
    mocks.resolveAccessToken.mockResolvedValue({
      token: { id: "tok-1", userId: "contrib-1", scope: "mcp" },
      user: {
        id: "contrib-1",
        externalId: "github:42",
        displayName: "Consenting User",
        isSuspended: false,
      },
    });
    const client = await connect({ Authorization: "Bearer eoat_test-token" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(mocks.resolveAccessToken).toHaveBeenCalledWith("eoat_test-token");
    await client.close();
  });

  it("rejects unknown OAuth access tokens without falling back to api keys", async () => {
    mocks.resolveAccessToken.mockResolvedValue(null);
    await expect(
      connect({ Authorization: "Bearer eoat_bogus" })
    ).rejects.toThrow(/Invalid or expired access token/);
    expect(mocks.resolveApiKey).not.toHaveBeenCalledWith("eoat_bogus");
  });

  it("401s carry the RFC 9728 WWW-Authenticate challenge", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      '/.well-known/oauth-protected-resource/mcp"'
    );
  });
});

describe("MCP tools", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect({ "x-api-key": "boundkey" });
  });

  it("lists the expected tools, resources, and prompts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "assess_text",
      "extract_claims",
      "get_claim",
      "get_contribution_status",
      "get_decomposition",
      "get_dependents",
      "match_claim",
      "search_claims",
      "submit_contribution",
    ]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "check_assertion",
      "fact_check_document",
    ]);
    await client.close();
  });

  it("search_claims returns ranked claims with page links", async () => {
    const result = await client.callTool({
      name: "search_claims",
      arguments: { query: "inflation" },
    });
    const payload = parseText(result) as {
      results: Array<Record<string, unknown>>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      id: CLAIM_ID,
      canonical_form: CLAIM_ROW.text,
      assessment_status: "well_supported",
      page_url: `https://minerval.ai/claims/${CLAIM_ID}`,
    });
    await client.close();
  });

  it("get_claim returns assessment and provenance; 404s unknown ids", async () => {
    mocks.getClaimInstances.mockResolvedValueOnce([
      {
        id: "i-1",
        source_id: "s-1",
        original_text: "quoted text",
        context: null,
        confidence: 0.9,
        source_title: "A paper",
        source_url: "https://example.org/paper",
      },
    ] as never);
    const result = await client.callTool({
      name: "get_claim",
      arguments: { claim_id: CLAIM_ID },
    });
    const payload = parseText(result);
    expect(payload.claim).toMatchObject({ id: CLAIM_ID });
    expect(payload.assessment).toMatchObject({
      status: "well_supported",
      confidence: 0.82,
    });
    expect(payload.instances).toHaveLength(1);

    const missing = await client.callTool({
      name: "get_claim",
      arguments: { claim_id: OTHER_ID },
    });
    expect(missing.isError).toBe(true);
    expect(parseText(missing).error).toMatchObject({ code: "NOT_FOUND" });
    await client.close();
  });

  it("get_decomposition returns the subclaim tree", async () => {
    const result = await client.callTool({
      name: "get_decomposition",
      arguments: { claim_id: CLAIM_ID, max_depth: 3 },
    });
    const payload = parseText(result);
    expect(payload.tree).toMatchObject({ id: CLAIM_ID });
    expect(mocks.getClaimTree).toHaveBeenCalledWith(CLAIM_ID, 3);
    await client.close();
  });

  it("get_decomposition walks three levels when no depth is asked for", async () => {
    await client.callTool({
      name: "get_decomposition",
      arguments: { claim_id: CLAIM_ID },
    });
    expect(mocks.getClaimTree).toHaveBeenCalledWith(CLAIM_ID, 3);
    await client.close();
  });

  it("get_dependents walks upward, three levels by default", async () => {
    mocks.getTransitiveDependents.mockResolvedValueOnce({
      dependents: [
        { id: OTHER_ID, text: "Rests on it", importance: 0.9, depth: 2 },
      ],
      total: 1,
      truncated: false,
    } as never);

    const result = await client.callTool({
      name: "get_dependents",
      arguments: { claim_id: CLAIM_ID },
    });

    const payload = parseText(result);
    expect(mocks.getTransitiveDependents).toHaveBeenCalledWith(CLAIM_ID, 3);
    // The depth tag is the point: it says how far up the weight sits.
    expect(payload.dependents).toEqual([
      { id: OTHER_ID, text: "Rests on it", importance: 0.9, depth: 2 },
    ]);
    expect(payload.truncated).toBe(false);
    await client.close();
  });

  it("get_dependents 404s an unknown claim and honours an explicit depth", async () => {
    await client.callTool({
      name: "get_dependents",
      arguments: { claim_id: CLAIM_ID, max_depth: 5 },
    });
    expect(mocks.getTransitiveDependents).toHaveBeenCalledWith(CLAIM_ID, 5);

    const missing = await client.callTool({
      name: "get_dependents",
      arguments: { claim_id: OTHER_ID },
    });
    expect(missing.isError).toBe(true);
    expect(parseText(missing).error).toMatchObject({ code: "NOT_FOUND" });
    await client.close();
  });

  it("get_claim pages dependents and reports the full count", async () => {
    // A hub claim: far more dependents than one page, which used to come back
    // in full because the tool called the unbounded query.
    mocks.listClaimDependents.mockResolvedValueOnce({
      dependents: [{ id: OTHER_ID, text: "A dependent", importance: 0.9 }],
      total: 240,
    } as never);

    const result = await client.callTool({
      name: "get_claim",
      arguments: { claim_id: CLAIM_ID, include: ["dependents"] },
    });

    const payload = parseText(result);
    // Still an array, so callers that iterate it are unaffected...
    expect(payload.dependents).toHaveLength(1);
    // ...but the count they used to take from its length is now explicit.
    expect(payload.dependents_total).toBe(240);
    expect(mocks.listClaimDependents).toHaveBeenCalledWith(CLAIM_ID, {
      limit: 25,
      offset: 0,
    });
    await client.close();
  });

  it("get_claim honours an explicit dependents page", async () => {
    await client.callTool({
      name: "get_claim",
      arguments: {
        claim_id: CLAIM_ID,
        include: ["dependents"],
        dependents_limit: 5,
        dependents_offset: 10,
      },
    });
    expect(mocks.listClaimDependents).toHaveBeenCalledWith(CLAIM_ID, {
      limit: 5,
      offset: 10,
    });
    await client.close();
  });

  it("match_claim runs the Matcher and returns the canonical claim + assessment", async () => {
    const result = await client.callTool({
      name: "match_claim",
      arguments: { assertion: "Supply chains caused 2022 inflation" },
    });
    const payload = parseText(result);
    expect(payload.matched).toBe(true);
    expect(payload.claim).toMatchObject({ id: CLAIM_ID });
    expect(payload.stance).toBe("affirms");
    expect(payload.assessment).toMatchObject({ status: "well_supported" });
    await client.close();
  });

  it("assess_text composes extract → match → graph verdicts", async () => {
    mocks.extractClaims.mockResolvedValueOnce([
      {
        original_text: "Inflation was caused by supply chains",
        context: null,
        proposed_canonical_form: CLAIM_ROW.text,
        claim_type: "causal",
        confidence: 0.9,
        importance: 0.8,
        source_location: null,
      },
      {
        original_text: "The moon is made of cheese",
        context: null,
        proposed_canonical_form: "The moon is made of cheese",
        claim_type: "empirical_verifiable",
        confidence: 0.9,
        importance: 0.1,
        source_location: null,
      },
    ]);
    mocks.matchClaim
      .mockImplementationOnce(async () => ({
        is_match: true,
        matched_claim_id: CLAIM_ID,
        new_canonical_form: null,
        instance_stance: "affirms",
        confidence: 0.88,
        reasoning: "Same proposition.",
        alternative_matches: [],
        relationship_notes: null,
      }))
      .mockImplementationOnce(async () => ({
        is_match: false,
        matched_claim_id: null,
        new_canonical_form: "The moon is made of cheese",
        instance_stance: "affirms",
        confidence: 0.7,
        reasoning: "No such claim.",
        alternative_matches: [],
        relationship_notes: null,
      }));

    const result = await client.callTool({
      name: "assess_text",
      arguments: { text: "Some passage.", max_claims: 5 },
    });
    const payload = parseText(result) as {
      judgments: Array<Record<string, unknown>>;
    };
    expect(payload.judgments).toHaveLength(2);
    expect(payload.judgments[0]).toMatchObject({ verdict: "well_supported" });
    expect(payload.judgments[1]).toMatchObject({ verdict: "unknown" });
    expect(mocks.extractClaims).toHaveBeenCalledWith(
      expect.objectContaining({ maxClaims: 5 })
    );
    await client.close();
  });

  it("submit_contribution routes through the contribution pipeline", async () => {
    const result = await client.callTool({
      name: "submit_contribution",
      arguments: {
        claim_id: CLAIM_ID,
        contribution_type: "challenge",
        content: "This ignores monetary policy.",
      },
    });
    const payload = parseText(result) as {
      contribution: Record<string, unknown>;
    };
    expect(payload.contribution).toMatchObject({
      id: OTHER_ID,
      review_status: "pending",
    });
    expect(mocks.getOrCreateContributor).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "mcp:tester" })
    );
    expect(mocks.enqueueContribution).toHaveBeenCalledWith({
      contributionId: OTHER_ID,
    });
    await client.close();
  });

  it("submit_contribution blocks must-pay standing (bad-faith flag, #71)", async () => {
    mocks.getOrCreateContributor.mockResolvedValueOnce({
      id: "contrib-1",
      externalId: "mcp:tester",
      displayName: "mcp:tester",
      isSuspended: false,
      suspensionReason: null,
      contributionStanding: "must_pay",
      reputationScore: 40,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await client.callTool({
      name: "submit_contribution",
      arguments: {
        claim_id: CLAIM_ID,
        contribution_type: "challenge",
        content: "x",
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result).error).toMatchObject({ code: "DEPOSIT_REQUIRED" });
    expect(mocks.createContribution).not.toHaveBeenCalled();
    await client.close();
  });

  it("submit_contribution sandboxes brand-new accounts (#71)", async () => {
    mocks.getOrCreateContributor.mockResolvedValue({
      id: "contrib-new",
      externalId: "mcp:tester",
      displayName: "mcp:tester",
      isSuspended: false,
      suspensionReason: null,
      contributionStanding: "good",
      reputationScore: 0,
      createdAt: new Date(), // brand-new → sandboxed cap (3/hour default)
    });
    const submit = () =>
      client.callTool({
        name: "submit_contribution",
        arguments: {
          claim_id: CLAIM_ID,
          contribution_type: "challenge",
          content: "x",
        },
      });
    for (let i = 0; i < 3; i++) {
      expect((await submit()).isError).toBeFalsy();
    }
    const limited = await submit();
    expect(limited.isError).toBe(true);
    expect(parseText(limited).error).toMatchObject({
      code: "CONTRIBUTION_RATE_LIMITED",
    });
    await client.close();
  });

  it("submit_contribution rejects suspended contributors", async () => {
    mocks.getOrCreateContributor.mockResolvedValueOnce({
      id: "contrib-1",
      externalId: "mcp:tester",
      displayName: "mcp:tester",
      isSuspended: true,
      suspensionReason: "bad faith",
      contributionStanding: "good",
      reputationScore: 40,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await client.callTool({
      name: "submit_contribution",
      arguments: {
        claim_id: CLAIM_ID,
        contribution_type: "challenge",
        content: "x",
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result).error).toMatchObject({
      code: "CONTRIBUTOR_SUSPENDED",
    });
    expect(mocks.createContribution).not.toHaveBeenCalled();
    await client.close();
  });

  it("reads the claim:// resource", async () => {
    const resource = await client.readResource({
      uri: `claim://${CLAIM_ID}`,
    });
    const body = JSON.parse(
      (resource.contents[0] as { text: string }).text
    );
    expect(body.claim).toMatchObject({ id: CLAIM_ID });
    expect(body.assessment).toMatchObject({ status: "well_supported" });
    await client.close();
  });
});

describe("MCP identity & metering", () => {
  it("keys without a contributor identity cannot contribute", async () => {
    const client = await connect({ "x-api-key": "freekey" });
    const result = await client.callTool({
      name: "submit_contribution",
      arguments: {
        claim_id: CLAIM_ID,
        contribution_type: "challenge",
        content: "x",
      },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result).error).toMatchObject({
      code: "NO_CONTRIBUTOR_IDENTITY",
    });
    await client.close();
  });

  it("attributes agentic LLM work to the calling account and key", async () => {
    mocks.resolveApiKey.mockResolvedValue({
      key: { id: "key-1", scope: "consumer" },
      user: {
        id: "user-1",
        externalId: "auth0:jane",
        isSuspended: false,
      },
    });
    const client = await connect({ "x-api-key": "ep_user_key" });
    await client.callTool({
      name: "match_claim",
      arguments: { assertion: "anything" },
    });
    expect(mocks.usageContexts[0]).toMatchObject({
      userId: "user-1",
      apiKeyId: "key-1",
    });
    await client.close();
  });

  it("runs on-demand analysis untraced: the caller's text leaves no transcript (#356)", async () => {
    mocks.resolveApiKey.mockResolvedValue({
      key: { id: "key-1", scope: "consumer" },
      user: { id: "user-1", externalId: "auth0:jane", isSuspended: false },
    });
    const client = await connect({ "x-api-key": "ep_user_key" });
    await client.callTool({
      name: "match_claim",
      arguments: { assertion: "a passage from a private memo" },
    });
    expect(mocks.usageContexts[0]).toMatchObject({ untraced: true, userId: "user-1" });
    expect((mocks.usageContexts[0] as { trace?: unknown }).trace).toBeUndefined();
    await client.close();
  });

  it("denies agentic tools once the owl balance is empty", async () => {
    mocks.resolveApiKey.mockResolvedValue({
      key: { id: "key-1", scope: "consumer" },
      user: { id: "user-1", externalId: "auth0:jane", isSuspended: false },
    });
    mocks.checkSpend.mockResolvedValue({
      allowed: false,
      capOwls: 0.1,
      entitlement: {
        owlBalance: 0,
        owlBalanceMicroUsd: 0,
        owlPriceMicroUsd: 4_000_000,
        capsOwls: { text_analysis: 0.1 },
        creditsEnabled: false,
        signupGrantOwls: 5,
        monthlyGrantOwls: 1,
      },
    });
    const client = await connect({ "x-api-key": "ep_user_key" });

    const denied = await client.callTool({
      name: "match_claim",
      arguments: { assertion: "anything" },
    });
    expect(denied.isError).toBe(true);
    expect(parseText(denied).error).toMatchObject({
      code: "INSUFFICIENT_OWLS",
    });
    expect(mocks.matchClaim).not.toHaveBeenCalled();

    // Free reads stay available even when the grant is exhausted.
    const search = await client.callTool({
      name: "search_claims",
      arguments: { query: "inflation" },
    });
    expect(search.isError).toBeFalsy();
    await client.close();
  });
});
