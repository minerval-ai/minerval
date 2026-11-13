import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward's code-execution sandbox (constitution §9: an assessment may
 * rest on the admin's own analysis). It is an Anthropic server tool, so the
 * Steward has it, and is told its price, only when its model is
 * Anthropic-served; on any other provider the tool is absent and the task
 * message does not mention it.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  loopSkills: [] as Array<string[] | undefined>,
  claim: null as null | Record<string, unknown>,
  executeMatcherTool: vi.fn(async () => JSON.stringify({ is_match: false })),
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
    leanCheckerUrl: "http://lean-checker.test",
    traceLevel: "off",
    researcherEnabled: true,
    researcherRequestMaxWallMinutes: 240,
    researcherStrongModel: "claude-opus-5-5",
    researcherStandardModel: "claude-sonnet-5-5",
    researcherCheapModel: "z-ai/glm-5.3",
  },
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  rawQuery: vi.fn(async () => []),
}));

vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(async () => mocks.claim),
}));

vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  elicitEnabledForImportance: () => false,
  getElicitToolDefinitions: async () => [],
  executeElicitTool: vi.fn(),
  isElicitTool: (name: string) => name.startsWith("elicit_"),
  ELICIT_TOOL_PREFIX: "elicit_",
}));

vi.mock("../../../src/llm/tools/lean-tools.js", () => {
  const names = ["lean_search", "lean_elaborate", "lean_check", "publish_formalization"];
  return {
    LEAN_TOOL_NAMES: names,
    isLeanTool: (name: string) => names.includes(name),
    registerLeanTools: (register: (name: string, executor: (input: Record<string, unknown>) => Promise<string>) => void) => {
      for (const name of names) {
        register(name, async (input: Record<string, unknown>) =>
          JSON.stringify({
            success: false,
            message: `${name}: stub executor reached`,
            ...(input?.proof === "not-a-submission" ? { not_submitted: true } : {}),
          })
        );
      }
    },
  };
});

vi.mock("../../../src/services/formalization-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/formalization-service.js")>()),
  getFormalizationById: vi.fn(async () => null),
  listFormalizations: vi.fn(async () => []),
}));

vi.mock("../../../src/llm/tools/steward-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/tools/steward-tools.js")>()),
  executeStewardTool: vi.fn(async (name: string) =>
    JSON.stringify(name === "update_claim_assessment" ? { success: true } : { ok: true })
  ),
}));

vi.mock("../../../src/llm/tools/matcher-tools.js", () => ({
  getMatcherToolDefinition: () => ({
    name: "match_claim",
    description: "m",
    input_schema: { type: "object", properties: {} },
  }),
  executeMatcherTool: mocks.executeMatcherTool,
}));

vi.mock("../../../src/llm/client.js", async () => {
  const { getUsageContext } = await import("../../../src/llm/usage-context.js");
  return {
    toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
      mocks.loopOptions.push(options);
      mocks.loopSkills.push(getUsageContext().skills);
      return { content: "", toolUses: [], stopReason: "end_turn" };
    }),
  };
});

import { runClaimSteward } from "../../../src/llm/agents/claim-steward.js";
import { withPassBudget } from "../../../src/llm/usage-context.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000003";

type LoopOptions = {
  tools: Array<{ name: string; type?: string }>;
  initialMessages: Array<{ content: string }>;
};

async function run(kind: string, model: string): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind };
  await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "", model })
  );
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
});

describe("the Steward's sandbox by provider", () => {
  for (const kind of ["claim", "quantity", "question"]) {
    it(`gives a ${kind}'s Steward code_execution on an Anthropic-served model, with its price`, async () => {
      const opts = await run(kind, "claude-sonnet-5-5");
      const sandbox = opts.tools.find((t) => t.name === "code_execution");
      expect(sandbox?.type).toBe("code_execution_20260120");
      const message = opts.initialMessages[0]!.content;
      expect(message).toContain("code_execution is in your toolset");
      expect(message).toContain("$0.05 a container-hour");
    });
  }

  it("tells the Steward which research tiers can run code", async () => {
    const opts = await run("claim", "claude-sonnet-5-5");
    // Research is commissioned (kind research); its description names the tiers.
    const commission = opts.tools.find((t) => t.name === "commission") as { description?: string } | undefined;
    expect(commission?.description).toContain(
      "'strong' and 'standard' have a code-execution sandbox (Python, no network); 'cheap' has none and cannot run code."
    );
  });

  it("withholds it on a model no Anthropic server runs, and says nothing of it", async () => {
    const opts = await run("quantity", "z-ai/glm-5.3");
    expect(opts.tools.map((t) => t.name)).not.toContain("code_execution");
    expect(opts.initialMessages[0]!.content).not.toContain("code_execution");
  });
});
