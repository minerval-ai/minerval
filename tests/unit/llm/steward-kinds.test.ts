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

import { runClaimSteward, stewardPassNote } from "../../../src/llm/agents/claim-steward.js";
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
    // Both always refuse a quantity (#711); the Quantities section maps them.
    expect(names).not.toContain("update_claim_assessment");
    expect(names).not.toContain("record_claim_instance");
    expect(opts.system[0]).toMatch(/update_quantity_estimate and record_estimate\s+take the place of/);
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

describe("the pass note says what the node has (#883)", () => {
  it("calls a pass first only when the node has no structure and no assessment", () => {
    const blank = stewardPassNote("claim", "structure_and_assess", { judged: false, structured: false });
    expect(blank).toContain("first pass");
    expect(blank).toContain("no structure or assessment yet");
    // The same blank node under another trigger is not called a first pass.
    expect(stewardPassNote("claim", "user_order", { judged: false, structured: false })).not.toContain(
      "first pass"
    );
  });

  it("never tells a Steward a structured or assessed node is blank, whatever the trigger", () => {
    for (const node of [
      { judged: true, structured: true },
      { judged: true, structured: false },
      { judged: false, structured: true },
      { judged: true, structured: null },
      { judged: false, structured: null },
    ]) {
      const note = stewardPassNote("claim", "structure_and_assess", node);
      expect(note).not.toContain("first pass");
      expect(note).not.toContain("no structure or assessment");
      expect(note.includes("an assessment but\nno structure")).toBe(node.judged && node.structured === false);
    }
    expect(stewardPassNote("claim", "structure_and_assess", { judged: true, structured: true })).toContain(
      "already\nhas structure and an assessment"
    );
  });

  it("reads the node's state, not a stale structure_and_assess trigger", async () => {
    const { rawQuery } = await import("../../../src/db/client.js");
    vi.mocked(rawQuery).mockImplementation((async (sql: string) => {
      if (sql.includes("FROM assessments_in_force")) return [{ one: 1 }];
      if (sql.includes("AS structured")) return [{ structured: true }];
      return [];
    }) as typeof rawQuery);
    try {
      const opts = await run("claim");
      const message = opts.initialMessages[0]!.content;
      expect(message).not.toContain("first pass");
      expect(message).toContain("has a current assessment");
      expect(message).not.toContain("has no current assessment");
    } finally {
      vi.mocked(rawQuery).mockImplementation((async () => []) as typeof rawQuery);
    }
  });
});

describe("a pass on a judged node opens with what changed under the judgment (#566)", () => {
  const PREMISE = "bbbbbbbb-0000-4000-8000-000000000001";

  /** The node has an assessment with a record, and one premise judged again since. */
  async function withJudgedNode<T>(fn: () => Promise<T>): Promise<T> {
    const { rawQuery } = await import("../../../src/db/client.js");
    vi.mocked(rawQuery).mockImplementation((async (sql: string) => {
      if (sql.includes("FROM premise_rows")) {
        return [{ node_id: PREMISE, relation: "requires", judged_against: "j1", in_force_now: "j2", state: "rejudged" }];
      }
      if (sql.includes("FROM source_rows") || sql.includes("FROM event_rows")) return [];
      if (sql.includes("FROM judged")) {
        return [{ kind: "assessment", id: "j0", assessed_at: new Date("2026-10-02T00:00:00Z"), inputs_recorded: true }];
      }
      if (sql.includes("SELECT id FROM claims")) return [{ id: CLAIM_ID }];
      if (sql.includes("text AS name FROM claims")) return [{ id: PREMISE, name: "The trial was randomized" }];
      if (sql.includes("FROM assessments_in_force")) return [{ one: 1 }];
      return [];
    }) as typeof rawQuery);
    try {
      return await fn();
    } finally {
      vi.mocked(rawQuery).mockImplementation((async () => []) as typeof rawQuery);
    }
  }

  it("names the premise judged again, after the task", async () => {
    const message = await withJudgedNode(async () => (await run("claim")).initialMessages[0]!.content);
    const task = message.indexOf("The claim has a current assessment.");
    const note = message.indexOf("What has changed in the graph under the current assessment since it was recorded on 2026-10-02:");
    expect(task).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(task);
    expect(message).toContain(`- ${PREMISE} "The trial was randomized" (requires)`);
  });

  it("leaves it out of a formalization pass, which is not about the assessment", async () => {
    const message = await withJudgedNode(async () => {
      mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind: "claim" };
      await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
        runClaimSteward({ trigger: "formalize", claimId: CLAIM_ID, context: "" })
      );
      return (mocks.loopOptions.at(-1) as unknown as LoopOptions).initialMessages[0]!.content;
    });
    expect(message).not.toContain("What has changed in the graph");
  });

  it("says nothing on a node with no judgment", async () => {
    const message = (await run("claim")).initialMessages[0]!.content;
    expect(message).not.toContain("What has changed in the graph");
    expect(message).not.toContain("Since the current assessment");
  });
});
