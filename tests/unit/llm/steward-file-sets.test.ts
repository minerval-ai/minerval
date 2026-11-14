import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward and file sets (src/file-sets.ts). A Steward of any kind of
 * node is given the tools that run commands against the sets of files the
 * deployment holds, and its brief says which sets it has. Where the
 * deployment has no set, nothing it is sent changes: the same tools in the
 * same order, and the same task message, byte for byte.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  claim: null as null | Record<string, unknown>,
  queries: [] as string[],
  // What createFileSetTools returns: null lets the real function answer.
  bundle: null as null | {
    definitions: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    note: string;
    execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
  },
  executed: [] as Array<{ name: string; input: Record<string, unknown> }>,
  config: {
    env: "test",
    stewardModel: "claude-opus-5-5",
    stewardMaxIterations: 50,
    elicitApiKey: "",
    leanCheckerUrl: "",
    traceLevel: "off",
    researcherEnabled: true,
    researcherMaxWallMinutes: 20,
    researcherStrongModel: "claude-opus-5-5",
    researcherStandardModel: "claude-sonnet-5-5",
    researcherCheapModel: "z-ai/glm-5.3",
  } as Record<string, unknown>,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  rawQuery: vi.fn(async (q: string) => {
    mocks.queries.push(q);
    return [];
  }),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(async () => mocks.claim),
}));

vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  getElicitToolDefinitions: async () => [],
  executeElicitTool: vi.fn(),
  isElicitTool: (name: string) => name.startsWith("elicit_"),
  ELICIT_TOOL_PREFIX: "elicit_",
}));

vi.mock("../../../src/llm/tools/file-set-tools.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/llm/tools/file-set-tools.js")>();
  return {
    ...original,
    createFileSetTools: vi.fn(async (opts: Parameters<typeof original.createFileSetTools>[0]) =>
      mocks.bundle ?? original.createFileSetTools(opts)
    ),
  };
});

vi.mock("../../../src/llm/tools/steward-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/tools/steward-tools.js")>()),
  executeStewardTool: vi.fn(async () => JSON.stringify({ success: true })),
}));

vi.mock("../../../src/llm/tools/matcher-tools.js", () => ({
  getMatcherToolDefinition: () => ({ name: "match_claim", description: "m", input_schema: { type: "object", properties: {} } }),
  executeMatcherTool: vi.fn(async () => JSON.stringify({ is_match: false })),
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.loopOptions.push(options);
    return { content: "", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runClaimSteward } from "../../../src/llm/agents/claim-steward.js";
import { NO_FILE_SET_TOOLS, createFileSetTools } from "../../../src/llm/tools/file-set-tools.js";
import { withPassBudget } from "../../../src/llm/usage-context.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000005";
const NOTE =
  "This deployment holds sets of files that were added for its agents to read, and runs a sandbox where " +
  'you can explore them with commands of your own:\n- "Refund ledger", files of Halden Evaluations: 3 files, 48 MB, at /sets/refund-ledger.';
const NAMES = ["run_command", "open_output", "keep_analysis", "keep_file"];

type LoopOptions = {
  tools: Array<{ name: string }>;
  initialMessages: Array<{ content: string }>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

async function run(kind: string): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind };
  await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "", model: "claude-sonnet-5-5" })
  );
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

const withSet = () => ({
  definitions: NAMES.map((name) => ({ name, description: name, input_schema: { type: "object", properties: {} } })),
  note: NOTE,
  execute: async (name: string, input: Record<string, unknown>) => {
    if (!NAMES.includes(name)) return null;
    mocks.executed.push({ name, input });
    return JSON.stringify({ success: true, call: "c1" });
  },
});

beforeEach(() => {
  mocks.loopOptions.length = 0;
  mocks.queries.length = 0;
  mocks.executed.length = 0;
  mocks.bundle = null;
  delete mocks.config.reads;
  delete mocks.config.sandboxUrl;
});

describe("a Steward on a deployment with no file set", () => {
  it("reads nothing about file sets on the public graph, and is sent what it was always sent", async () => {
    // The public graph: READS is not set, and the real function answers.
    expect(await createFileSetTools({ config: {} })).toBe(NO_FILE_SET_TOOLS);
    const open = await run("claim");
    expect(mocks.queries.filter((q) => /file_set|sandbox/.test(q))).toEqual([]);

    // The same run with the empty bundle handed in is the same, to the byte.
    mocks.bundle = NO_FILE_SET_TOOLS;
    const empty = await run("claim");
    expect(JSON.stringify(open.tools)).toBe(JSON.stringify(empty.tools));
    // The message carries the run's date and nothing else that moves.
    expect(open.initialMessages).toEqual(empty.initialMessages);
    expect(open.initialMessages[0]!.content).not.toMatch(/file set|sets of files|scratch directory|run_command|keep_analysis|keep_file/i);
    expect(open.tools.map((t) => t.name).filter((n) => NAMES.includes(n))).toEqual([]);
  });

  it("looks, in a members-only deployment, and is still sent the same where there is none", async () => {
    mocks.bundle = NO_FILE_SET_TOOLS;
    const baseline = await run("claim");
    mocks.bundle = null;
    mocks.config.reads = "members";
    // A sandbox is configured and no set reaches the run: it is not asked anything.
    mocks.config.sandboxUrl = "http://127.0.0.1:9";
    const members = await run("claim");
    // It asked which sets the run has (the mocked database has none).
    expect(mocks.queries.some((q) => /FROM file_sets f/.test(q))).toBe(true);
    expect(JSON.stringify(members.tools)).toBe(JSON.stringify(baseline.tools));
    expect(members.initialMessages).toEqual(baseline.initialMessages);
  });
});

describe("a Steward with a file set", () => {
  for (const kind of ["claim", "quantity", "question"]) {
    it(`has its tools on a ${kind}, after the paid tools and before the skills`, async () => {
      mocks.bundle = NO_FILE_SET_TOOLS;
      const without = (await run(kind)).tools.map((t) => t.name);
      mocks.bundle = withSet();
      const opts = await run(kind);
      const names = opts.tools.map((t) => t.name);
      const at = names.indexOf("run_command");
      expect(names.slice(at, at + 4)).toEqual(NAMES);
      expect(names[at + 4]).toBe("load_skill");
      // Nothing else in the toolset moved.
      expect(names.filter((n) => !NAMES.includes(n))).toEqual(without);
    });
  }

  it("is told of it in its brief, after the task and before the pointer to its skills", async () => {
    mocks.bundle = NO_FILE_SET_TOOLS;
    const without = (await run("claim")).initialMessages[0]!.content;
    mocks.bundle = withSet();
    const withNote = (await run("claim")).initialMessages[0]!.content;
    expect(withNote).toContain(`\n\n${NOTE}`);
    // The brief is the one it always had, with the passage added and nothing else changed.
    expect(withNote.replace(`\n\n${NOTE}`, "")).toBe(without);
    expect(withNote.indexOf(NOTE)).toBeGreaterThan(withNote.indexOf("Trigger: structure_and_assess"));
  });

  it("has its commands run by the bundle, and every other tool as before", async () => {
    mocks.bundle = withSet();
    const opts = await run("claim");
    expect(JSON.parse(await opts.executeTool("run_command", { command: "ls /sets/refund-ledger" }))).toEqual({ success: true, call: "c1" });
    expect(JSON.parse(await opts.executeTool("keep_analysis", { call: "c1" }))).toEqual({ success: true, call: "c1" });
    expect(mocks.executed).toEqual([
      { name: "run_command", input: { command: "ls /sets/refund-ledger" } },
      { name: "keep_analysis", input: { call: "c1" } },
    ]);
    // A tool that is not the bundle's falls through to its own executor.
    await opts.executeTool("log_stewardship_decision", { claim_id: CLAIM_ID, decision: "x" });
    expect(mocks.executed).toHaveLength(2);
  });
});
