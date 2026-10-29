import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward runner by node kind (constitution §2, §7a): a question gets
 * the Question Steward's role and tools and owes update_question_assessment;
 * a quantity keeps the Claim Steward's role, gains the quantity tools, and
 * owes update_quantity_estimate; every kind can file requests.
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
    researcherMaxRunsPerLauncherRun: 3,
    researcherMaxWallMinutes: 20,
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

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000002";

type LoopOptions = {
  tools: Array<{ name: string }>;
  system: string[];
  initialMessages: Array<{ content: string }>;
  finalToolNudge: { max: number; message: string; when: () => boolean };
};

async function run(kind: string): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind };
  // A pass the lane funds, so the Steward is offered research to launch.
  await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "" })
  );
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
});

describe("Steward runner by kind", () => {
  it("gives a question the Question Steward's role and tools", async () => {
    const opts = await run("question");
    const names = opts.tools.map((t) => t.name);
    expect(opts.system[0]).toContain("# Your Role: Question Steward");
    for (const t of ["add_answer", "add_subquestion", "add_presupposition", "update_question_assessment", "record_question_instance", "file_request"]) {
      expect(names).toContain(t);
    }
    for (const t of ["update_claim_assessment", "record_claim_instance", "add_argument", "update_quantity_estimate"]) {
      expect(names).not.toContain(t);
    }
    expect(opts.initialMessages[0]!.content).toContain("update_question_assessment");
    expect(opts.finalToolNudge.message).toContain("update_question_assessment");
  });

  it("gives a quantity the Claim Steward's role with the quantity tools", async () => {
    const opts = await run("quantity");
    const names = opts.tools.map((t) => t.name);
    expect(opts.system[0]).toContain("# Your Role: Claim Steward");
    expect(opts.system[0]).toContain("## Quantities");
    for (const t of ["update_quantity_estimate", "record_estimate", "set_quantity_definition", "record_quantity_reading", "add_argument", "file_request"]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("add_answer");
    expect(opts.initialMessages[0]!.content).toContain("Quantity ID:");
    expect(opts.initialMessages[0]!.content).toContain("update_quantity_estimate");
  });

  it("keeps a claim's pass as it was, with requests and figures added", async () => {
    const opts = await run("claim");
    const names = opts.tools.map((t) => t.name);
    expect(names).toContain("update_claim_assessment");
    expect(names).toContain("record_estimate");
    expect(names).toContain("file_request");
    expect(names).not.toContain("set_request_targets");
    expect(opts.initialMessages[0]!.content).toContain("update_claim_assessment");
  });
});
