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
    stewardModel: "claude-opus-5-5",
    stewardMaxIterations: 50,
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

import { runClaimSteward } from "../../../src/llm/agents/claim-steward.js";
import { withPassBudget } from "../../../src/llm/usage-context.js";
import { getSkill } from "../../../src/llm/prompts/skills.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type LoopOptions = {
  tools: Array<{ name: string }>;
  system: string[];
  initialMessages: Array<{ content: string }>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  finalToolNudge: { max: number; message: string; when: () => boolean };
};

async function run(domains: string[]): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains };
  // A pass the lane funds, so the Steward is offered research to launch.
  await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "" })
  );
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
  mocks.loopSkills.length = 0;
  mocks.executeMatcherTool.mockClear();
});

const PROVENANCE_TOOLS = [
  "provenance_get_map",
  "provenance_read_source",
  "provenance_record_reading",
  "provenance_record_edge",
  "provenance_record_source_relationship",
  "provenance_record_root",
  "provenance_write_map",
  "provenance_cite_findings",
];

describe("Steward toolset without a domain tag", () => {
  it("offers every skill's tools and load_skill, splices no skill, and points to none", async () => {
    const opts = await run([]);
    const names = opts.tools.map((t) => t.name);
    // Skill tools are offered whether or not a skill is loaded, so the
    // Mathematics tools are here on an untagged claim too.
    expect(names).toContain("lean_search");
    expect(names).toContain("publish_formalization");
    // load_skill, then the skills' tools in skill order, sit after
    // match_claim and before the delegation channel.
    const first = names.indexOf("load_skill");
    expect(names.indexOf("match_claim")).toBe(first - 1);
    const skillTools = [
      ...getSkill("costing").tools.map((t) => t.name),
      ...getSkill("mathematics").tools.map((t) => t.name),
      ...PROVENANCE_TOOLS,
    ];
    expect(names.slice(first + 1, first + 1 + skillTools.length)).toEqual(skillTools);
    expect(names.slice(-9)).toEqual([
      "delegate_research",
      "get_research_run",
      "raise_issue",
      "update_issue",
      "search_issues",
      "get_issue",
      "note_finding",
      "search_findings",
      "web_search",
    ]);
    // One block: the constitution and role, with the catalog of skills to load.
    expect(opts.system).toHaveLength(1);
    expect(opts.system[0]).not.toContain("# Method skill:");
    expect(opts.system[0]).toContain("## Skills");
    expect(opts.system[0]).toContain("- provenance (version 1, a method skill");
    expect(opts.initialMessages[0]!.content).not.toContain("Skills that cover this run's subject");
    // The run opens with nothing loaded.
    expect(mocks.loopSkills).toEqual([[]]);
  });

  it("returns a skill's Steward view on load_skill and records the load", async () => {
    const opts = await run([]);
    const { runWithUsageContext, getUsageContext } = await import("../../../src/llm/usage-context.js");
    const skills: string[] = [];
    const { view, recorded } = await runWithUsageContext({ skills }, async () => ({
      view: await opts.executeTool("load_skill", { name: "provenance" }),
      recorded: [...(getUsageContext().skills ?? [])],
    }));
    expect(view.startsWith("# Method skill: Provenance (version 1)")).toBe(true);
    expect(view).toContain("## For the Claim Steward");
    expect(recorded).toEqual(["provenance"]);
    const unknown = JSON.parse(await opts.executeTool("load_skill", { name: "alchemy" }));
    expect(unknown.success).toBe(false);
    expect(unknown.message).toContain("mathematics, provenance");
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
  it("points the task to the Mathematics skill without loading it", async () => {
    const opts = await run(["mathematics"]);
    expect(opts.system).toHaveLength(1);
    expect(opts.system[0]).not.toContain("# Domain skill:");
    const task = opts.initialMessages[0]!.content;
    expect(task).toContain("Skills that cover this run's subject: the Mathematics skill (mathematics).");
    expect(task).toContain("Load one with load_skill if the work calls for it.");
    expect(mocks.loopSkills).toEqual([[]]);
    // The toolset is the same as on an untagged claim.
    const untagged = (await run([])).tools.map((t) => t.name);
    expect(opts.tools.map((t) => t.name)).toEqual(untagged);
  });

  it("ignores tags that name no skill", async () => {
    const opts = await run(["economics"]);
    expect(opts.system).toHaveLength(1);
    expect(opts.initialMessages[0]!.content).not.toContain("Skills that cover this run's subject");
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

describe("Lean tools under the run's budget", () => {
  it("has no count on searches, elaborations or checks", async () => {
    const opts = await run(["mathematics"]);
    const base = { formalization_id: "f", kind: "proof" };
    for (let i = 0; i < 5; i++) {
      expect(JSON.parse(await opts.executeTool("lean_search", { query: `q${i}` })).message).toMatch(/stub executor reached/);
      expect(JSON.parse(await opts.executeTool("lean_elaborate", { statement: `s${i}` })).message).toMatch(/stub executor reached/);
      expect(JSON.parse(await opts.executeTool("lean_check", base)).message).toMatch(/stub executor reached/);
    }
  });

  it("declines a proof check once the run's budget is spent", async () => {
    const opts = await run(["mathematics"]);
    const { withPassBudget, getUsageContext } = await import("../../../src/llm/usage-context.js");
    const { value } = await withPassBudget({ microUsd: 1_000_000, source: "the test" }, async () => {
        getUsageContext().meter!.billedMicroUsd = 1_000_000;
        return opts.executeTool("lean_check", { formalization_id: "f", kind: "proof" });
      });
    const out = JSON.parse(value);
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/A proof check would cost/);
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

  it("withholds the Lean tools and, on a claim pointed to Mathematics, says so in the task", async () => {
    const opts = await withoutChecker(["mathematics"]);
    const names = opts.tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("lean_"))).toEqual([]);
    expect(names).not.toContain("publish_formalization");
    expect(names.at(-1)).toBe("web_search");
    const task = opts.initialMessages[0]!.content;
    expect(task).toContain("the Mathematics skill (mathematics)");
    expect(task).toContain("formal tools are unavailable this run");
    expect(task).toContain("formal verification was unavailable");
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

describe("Steward toolset on a non-Anthropic model", () => {
  const onModel = async (model: string) => {
    const saved = mocks.config.stewardModel;
    mocks.config.stewardModel = model;
    try {
      return await run([]);
    } finally {
      mocks.config.stewardModel = saved;
    }
  };

  it("carries the client-side web_search in the server tool's place, with nothing said in the task", async () => {
    const opts = await onModel("openai/gpt-6-luna");
    const last = opts.tools.at(-1)!;
    expect(last.name).toBe("web_search");
    expect("input_schema" in last).toBe(true);
    expect(opts.initialMessages[0]!.content).not.toContain("web_search is unavailable");
  });

  it("keeps the server web_search on a Claude model", async () => {
    const opts = await onModel("claude-sonnet-5-5");
    const last = opts.tools.at(-1)!;
    expect(last.name).toBe("web_search");
    expect("input_schema" in last).toBe(false);
  });
});

describe("Steward final-action nudge", () => {
  it("nudges only while no assessment has been recorded", async () => {
    const opts = await run([]);
    expect(opts.finalToolNudge.max).toBe(1);
    expect(opts.finalToolNudge.message).toContain("update_claim_assessment");
    expect(opts.finalToolNudge.when()).toBe(true);
    await opts.executeTool("log_stewardship_decision", {});
    expect(opts.finalToolNudge.when()).toBe(true);
    await opts.executeTool("update_claim_assessment", { status: "supported" });
    expect(opts.finalToolNudge.when()).toBe(false);
  });
});

/**
 * What each pass owes (#706, #709): a first judgment must be recorded, a
 * revisit of a node with a current assessment may end on a logged "no
 * change", and the formalization, prize and attempt triggers are told and
 * nudged toward their own tool rather than toward a generic assessment.
 */
describe("Steward pass task by trigger", () => {
  const runTrigger = async (
    trigger: string,
    opts: { current?: boolean; domains?: string[]; context?: string } = {}
  ): Promise<LoopOptions> => {
    const { rawQuery } = await import("../../../src/db/client.js");
    const mocked = vi.mocked(rawQuery);
    mocked.mockImplementation((async (sql: string) =>
      opts.current && /is_current = true/.test(sql) ? [{ one: 1 }] : []) as never);
    try {
      mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: opts.domains ?? [] };
      await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
        runClaimSteward({ trigger, claimId: CLAIM_ID, context: opts.context ?? "" })
      );
      return mocks.loopOptions.at(-1) as unknown as LoopOptions;
    } finally {
      mocked.mockImplementation((async () => []) as never);
    }
  };

  it("lets a revisit with a current assessment end on a logged no-change", async () => {
    const opts = await runTrigger("subclaim_change", { current: true });
    const task = opts.initialMessages[0]!.content;
    expect(task).toContain("no_action_needed");
    expect(task).not.toContain("must record one");
    expect(opts.finalToolNudge.when()).toBe(true);
    await opts.executeTool("log_stewardship_decision", { action_taken: "no_action_needed" });
    expect(opts.finalToolNudge.when()).toBe(false);
  });

  it("still requires an assessment on a revisit of a node that has none", async () => {
    const opts = await runTrigger("subclaim_change", { current: false });
    expect(opts.initialMessages[0]!.content).toContain("must record one");
    await opts.executeTool("log_stewardship_decision", {});
    expect(opts.finalToolNudge.when()).toBe(true);
  });

  it("states the budget with the shared line, not a hand-rolled assessment demand", async () => {
    const task = (await runTrigger("subclaim_change", { current: true })).initialMessages[0]!.content;
    expect(task).toContain("This run has a budget of $5.00");
    expect(task).toContain("tool-use turns in this run");
    expect(task).not.toContain("Make sure you have recorded an assessment");
  });

  it("never nudges a no-checker formalization toward an assessment", async () => {
    const saved = mocks.config.leanCheckerUrl;
    mocks.config.leanCheckerUrl = "";
    try {
      const opts = await runTrigger("formalize", { domains: ["mathematics"] });
      expect(opts.initialMessages[0]!.content).toContain("Do not record or publish anything");
      expect(opts.finalToolNudge.message).not.toContain("update_claim_assessment");
      expect(opts.finalToolNudge.when()).toBe(true);
      await opts.executeTool("log_stewardship_decision", {});
      expect(opts.finalToolNudge.when()).toBe(false);
    } finally {
      mocks.config.leanCheckerUrl = saved;
    }
  });

  it("gives a prize claim its own task and nudges toward decide_prize_claim", async () => {
    const opts = await runTrigger("prize_claim", { domains: ["mathematics"] });
    const task = opts.initialMessages[0]!.content;
    expect(task).toContain("decide a prize claim");
    expect(task).toContain("get_prize_claim");
    expect(opts.finalToolNudge.message).toContain("decide_prize_claim");
    // An assessment alone does not settle a prize claim.
    await opts.executeTool("update_claim_assessment", { status: "verified" });
    expect(opts.finalToolNudge.when()).toBe(true);
  });

  it("gives the window-closed, voided and attempt triggers their own tasks", async () => {
    expect((await runTrigger("prize_window_closed")).initialMessages[0]!.content).toContain(
      "without the provisional caveat"
    );
    expect((await runTrigger("prize_claim_voided")).initialMessages[0]!.content).toContain(
      "without the voided result"
    );
    const attempt = await runTrigger("attempt_completed");
    expect(attempt.initialMessages[0]!.content).toContain("get_proof_attempt");
    await attempt.executeTool("log_stewardship_decision", {});
    expect(attempt.finalToolNudge.when()).toBe(false);
  });
});
