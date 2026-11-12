import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A Claim Steward's get_claim (served by the claim-context bundle,
 * governance-tools.ts) gets the read repair every agent's graph reads share
 * (#934): an id the run was given in its prompt or saw in a result, and then
 * mistyped, is read as the node it meant, marked id_corrected. The tool loop
 * is stood in for by the real loops' executor (observed-loop.ts); the read
 * and its repair are real, over a mocked view service.
 */

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const SUBCLAIM = "36174f8a-ee30-402f-9277-538a8c48a431";
const NODES = new Map([
  [CLAIM_ID, "The node this run stewards."],
  [SUBCLAIM, "A premise of it."],
]);

const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  claim: null as null | Record<string, unknown>,
  config: {
    env: "test",
    stewardModel: "claude-opus-5-5",
    stewardMaxIterations: 50,
    stewardMaxNewSubclaimsPerRun: 20,
    stewardMaxInstancesPerRun: 10,
    stewardElicitMinImportance: 0.75,
    stewardElicitMaxCallsPerRun: 3,
    stewardLeanMaxSearchesPerRun: 2,
    stewardLeanMaxElaborationsPerRun: 1,
    stewardLeanMaxChecksPerRun: 3,
    elicitApiKey: "",
    leanCheckerUrl: "",
    traceLevel: "off",
    researcherEnabled: false,
    researcherMaxWallMinutes: 20,
    publicWebBaseUrl: "https://minerval.test",
  },
}));

vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));
vi.mock("../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  // Only the nearest-ids lookup answers; every other query finds nothing.
  rawQuery: vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes("FROM claims WHERE id = ANY")) return [];
    const ids = (params?.[0] as string[]) ?? [];
    return ids.filter((id) => NODES.has(id)).map((id) => ({ id, text: NODES.get(id) }));
  }),
}));
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(async () => mocks.claim),
}));
vi.mock("../../../src/services/claim-view-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/claim-view-service.js")>()),
  getClaimView: vi.fn(async (id: string) =>
    NODES.has(id)
      ? {
          claim: { id, canonical_form: NODES.get(id) },
          ...(id === CLAIM_ID ? { subclaims: [{ id: SUBCLAIM, text: NODES.get(SUBCLAIM), relation: "requires" }] } : {}),
        }
      : null
  ),
}));
vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  elicitEnabledForImportance: () => false,
  getElicitToolDefinitions: async () => [],
  executeElicitTool: vi.fn(),
  isElicitTool: (name: string) => name.startsWith("elicit_"),
  ELICIT_TOOL_PREFIX: "elicit_",
}));
vi.mock("../../../src/llm/tools/matcher-tools.js", () => ({
  getMatcherToolDefinition: () => ({ name: "match_claim", description: "m", input_schema: { type: "object", properties: {} } }),
  executeMatcherTool: vi.fn(async () => JSON.stringify({ is_match: false })),
}));
vi.mock("../../../src/llm/tools/steward-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/tools/steward-tools.js")>()),
  executeStewardTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));
vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.loopOptions.push(options);
    return { content: "", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runClaimSteward } from "../../../src/llm/agents/claim-steward.js";
import { withPassBudget } from "../../../src/llm/usage-context.js";
import { observedExecutor } from "./observed-loop.js";

async function stewardTools() {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind: "claim" };
  await withPassBudget({ microUsd: 1_000_000, source: "the test" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "" })
  );
  return observedExecutor(mocks.loopOptions.at(-1) as never);
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
});

describe("a Steward's get_claim repairs a mistyped id (#934)", () => {
  it("reads its own node by an id it mistyped from its prompt", async () => {
    const { record, execute } = await stewardTools();
    expect(record.has(CLAIM_ID)).toBe(true);
    const out = JSON.parse(await execute("get_claim", { claim_id: `${CLAIM_ID.slice(0, -1)}9` }));
    expect(out.claim.id).toBe(CLAIM_ID);
    expect(out.id_corrected).toMatchObject({ resolved_id: CLAIM_ID, rule: "one_character" });
  });

  it("reads a subclaim it saw in an earlier read and then mistyped", async () => {
    const { execute } = await stewardTools();
    await execute("get_claim", { claim_id: CLAIM_ID, include: ["subclaims"] });
    const typo = `${SUBCLAIM.slice(0, 10)}${SUBCLAIM.slice(11)}`; // one digit dropped
    const out = JSON.parse(await execute("get_claim", { claim_id: typo }));
    expect(out.claim.id).toBe(SUBCLAIM);
    expect(out.id_corrected).toMatchObject({ requested_id: typo, resolved_id: SUBCLAIM });
  });

  it("tells it the id was not corrected, and lists the nodes it has seen, when nothing fits", async () => {
    const { execute } = await stewardTools();
    await execute("get_claim", { claim_id: CLAIM_ID, include: ["subclaims"] });
    const out = JSON.parse(await execute("get_claim", { claim_id: "deadbeef-0000-4000-8000-000000000000" }));
    expect(out.code).toBe("CLAIM_NOT_FOUND");
    expect(out.nearest_seen_ids.map((n: { id: string }) => n.id).sort()).toEqual([CLAIM_ID, SUBCLAIM].sort());
  });
});
