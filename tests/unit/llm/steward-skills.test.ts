import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward's toolset and prompt with and without a domain tag (docs/
 * mathematics.md §3.4, §3.5, §6.2): the Mathematics skill's block and Lean
 * tools join a run exactly when the claim carries the `mathematics` domain,
 * the tools sit after the Elicit tools and before web_search, the per-run
 * caps refuse the call past the backstop, and the Matcher receives the
 * domains the Steward knows.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  loopSkills: [] as Array<string[] | undefined>,
  claim: null as null | Record<string, unknown>,
  executeMatcherTool: vi.fn(async () => JSON.stringify({ is_match: false })),
  config: {
    env: "test",
    stewardModel: "claude-fable-5-1",
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
    registerLeanTools: (register: (name: string, executor: () => Promise<string>) => void) => {
      for (const name of names) {
        register(name, async () =>
          JSON.stringify({ success: false, message: `${name}: stub executor reached` })
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
import { getSkill } from "../../../src/llm/prompts/skills.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type LoopOptions = {
  tools: Array<{ name: string }>;
  system: string[];
  initialMessages: Array<{ content: string }>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

async function run(domains: string[]): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains };
  await runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "" });
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
  mocks.loopSkills.length = 0;
  mocks.executeMatcherTool.mockClear();
});

describe("Steward toolset without a domain tag", () => {
  it("carries no skill block and no skill tools", async () => {
    const opts = await run([]);
    const names = opts.tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("lean_"))).toEqual([]);
    expect(names).not.toContain("publish_formalization");
    expect(names.at(-1)).toBe("web_search");
    // One block: the constitution and role, with no skill block after it.
    expect(opts.system).toHaveLength(1);
    expect(opts.system[0]).not.toContain("# Domain skill:");
    // The role prompt still lists the skills that exist.
    expect(opts.system[0]).toContain("## Domain skills");
    expect(opts.system[0]).toContain("Skills that exist: mathematics");
    expect(opts.initialMessages[0]!.content).not.toContain("Domain skills active");
    expect(mocks.loopSkills).toEqual([[]]);
  });

  it("passes no domains to the Matcher", async () => {
    const opts = await run([]);
    await opts.executeTool("match_claim", { text: "x" });
    expect(mocks.executeMatcherTool).toHaveBeenCalledWith(
      "match_claim",
      { text: "x" },
      { domains: [] }
    );
  });
});

describe("Steward toolset with the mathematics tag", () => {
  it("splices the skill block after the role and the Lean tools before web_search", async () => {
    const opts = await run(["mathematics"]);
    const names = opts.tools.map((t) => t.name);
    // The skill's tools sit as one block after match_claim (and the Elicit
    // tools, absent here) and before web_search, the Lean four first.
    const first = names.indexOf("lean_search");
    expect(names.indexOf("match_claim")).toBe(first - 1);
    expect(names.slice(first, first + 4)).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "publish_formalization",
    ]);
    expect(names.at(-1)).toBe("web_search");
    const skillTools = getSkill("mathematics").tools.map((t) => t.name);
    expect(names.slice(first, -1).every((n) => skillTools.includes(n))).toBe(true);

    // Two cached blocks: the constitution-plus-role block, unchanged, then
    // the skill's Steward view as its own block.
    expect(opts.system).toHaveLength(2);
    expect(opts.system[0]).toContain("# Your Specific Role");
    expect(opts.system[0]).not.toContain("# Domain skill:");
    const skill = opts.system[1]!;
    expect(skill.startsWith("# Domain skill: Mathematics (version 1)")).toBe(true);
    expect(skill).toContain("## For the Claim Steward");
    expect(skill).not.toContain("## For the solver");
    expect(skill).not.toContain("## Failure modes");

    expect(opts.initialMessages[0]!.content).toContain(
      "Domain skills active for this run: mathematics (version 1)"
    );
    expect(mocks.loopSkills).toEqual([["mathematics"]]);
  });

  it("ignores tags that name no skill", async () => {
    const opts = await run(["economics"]);
    expect(opts.tools.map((t) => t.name)).not.toContain("lean_search");
    expect(opts.system).toHaveLength(1);
  });

  it("passes the claim's domains to the Matcher", async () => {
    const opts = await run(["mathematics"]);
    await opts.executeTool("match_claim", { text: "x" });
    expect(mocks.executeMatcherTool).toHaveBeenCalledWith(
      "match_claim",
      { text: "x" },
      { domains: ["mathematics"] }
    );
  });

  it("routes skill tools to the registry's executors", async () => {
    const opts = await run(["mathematics"]);
    const out = JSON.parse(await opts.executeTool("lean_elaborate", { statement: "theorem t : True := trivial" }));
    expect(out).toEqual({
      success: false,
      message: "lean_elaborate: stub executor reached",
    });
  });
});

describe("per-run Lean caps", () => {
  it("refuses lean_search past STEWARD_LEAN_MAX_SEARCHES_PER_RUN", async () => {
    const opts = await run(["mathematics"]);
    const first = JSON.parse(await opts.executeTool("lean_search", { query: "a" }));
    const second = JSON.parse(await opts.executeTool("lean_search", { query: "b" }));
    const third = JSON.parse(await opts.executeTool("lean_search", { query: "c" }));
    expect(first.message).toMatch(/stub executor reached/);
    expect(second.message).toMatch(/stub executor reached/);
    expect(third.success).toBe(false);
    expect(third.message).toMatch(/already made 2 Mathlib searches, the per-run backstop \(2\)/);
  });

  it("refuses lean_elaborate past STEWARD_LEAN_MAX_ELABORATIONS_PER_RUN", async () => {
    const opts = await run(["mathematics"]);
    await opts.executeTool("lean_elaborate", { statement: "x" });
    const refused = JSON.parse(await opts.executeTool("lean_elaborate", { statement: "y" }));
    expect(refused.success).toBe(false);
    expect(refused.message).toMatch(/elaborated 1 drafts, the per-run backstop \(1\)/);
  });

  it("counts a fresh replay of lean_check double against STEWARD_LEAN_MAX_CHECKS_PER_RUN", async () => {
    const opts = await run(["mathematics"]);
    const base = { formalization_id: "f", kind: "proof" };
    const fresh = JSON.parse(await opts.executeTool("lean_check", { ...base, replay: "fresh" }));
    expect(fresh.message).toMatch(/stub executor reached/);
    // 2 of 3 used: another fresh replay would need 4.
    const secondFresh = JSON.parse(await opts.executeTool("lean_check", { ...base, replay: "fresh" }));
    expect(secondFresh.success).toBe(false);
    expect(secondFresh.message).toMatch(/used 2 of its 3 proof checks/);
    // A module replay still fits (3 of 3), then nothing does.
    const plain = JSON.parse(await opts.executeTool("lean_check", base));
    expect(plain.message).toMatch(/stub executor reached/);
    const over = JSON.parse(await opts.executeTool("lean_check", base));
    expect(over.success).toBe(false);
    expect(over.message).toMatch(/used 3 of its 3 proof checks/);
  });

  it("leaves publish_formalization uncapped", async () => {
    const opts = await run(["mathematics"]);
    for (let i = 0; i < 5; i++) {
      const out = JSON.parse(
        await opts.executeTool("publish_formalization", { claim_id: CLAIM_ID })
      );
      expect(out.message).toMatch(/stub executor reached/);
    }
  });
});

describe("Steward toolset with the mathematics tag but no checker", () => {
  const withoutChecker = async (domains: string[]) => {
    const saved = mocks.config.leanCheckerUrl;
    mocks.config.leanCheckerUrl = "";
    try {
      return await run(domains);
    } finally {
      mocks.config.leanCheckerUrl = saved;
    }
  };

  it("keeps the skill block but withholds the Lean tools, and says so in the task", async () => {
    const opts = await withoutChecker(["mathematics"]);
    const names = opts.tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("lean_"))).toEqual([]);
    expect(names).not.toContain("publish_formalization");
    expect(names.at(-1)).toBe("web_search");
    // The skill itself is still active: its block and its name in the task.
    expect(opts.system).toHaveLength(2);
    expect(opts.system[1]!.startsWith("# Domain skill: Mathematics")).toBe(true);
    const task = opts.initialMessages[0]!.content;
    expect(task).toContain("Domain skills active for this run: mathematics (version 1)");
    expect(task).toContain("formal tools are unavailable this run");
    expect(task).toContain("formal verification was unavailable");
    expect(mocks.loopSkills).toEqual([["mathematics"]]);
  });

  it("says nothing about formal tools on a claim outside the domain", async () => {
    const opts = await withoutChecker([]);
    expect(opts.initialMessages[0]!.content).not.toContain("formal tools are unavailable");
  });

  it("the ordinary toolset is unchanged by the checker being absent", async () => {
    const withChecker = (await run(["mathematics"])).tools.map((t) => t.name);
    const without = (await withoutChecker(["mathematics"])).tools.map((t) => t.name);
    expect(without).toEqual(
      withChecker.filter((n) => !n.startsWith("lean_") && n !== "publish_formalization")
    );
  });
});
