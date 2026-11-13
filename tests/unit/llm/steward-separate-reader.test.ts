import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward and a separate reader (src/services/separate-reader.ts). Where
 * its node's page is under a standing showing, a Steward is told what it is
 * not given and why, is not offered what the showing's readers cannot read,
 * and can launch a reader. Where no page is shown, and on the public graph,
 * nothing it is sent changes: the same tools and the same task message.
 */

const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  claim: null as null | Record<string, unknown>,
  queries: [] as string[],
  // undefined lets the real lookup answer; null and a rule are handed back as they are.
  rule: undefined as undefined | null | { pageLabel: string; withheldLabels: string[]; reader: boolean },
  notOffered: [] as string[],
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

vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

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

vi.mock("../../../src/services/claim-service.js", () => ({ getClaimById: vi.fn(async () => mocks.claim) }));

vi.mock("../../../src/llm/tools/elicit-tools.js", () => ({
  getElicitToolDefinitions: async () => [],
  executeElicitTool: vi.fn(),
  isElicitTool: (name: string) => name.startsWith("elicit_"),
  ELICIT_TOOL_PREFIX: "elicit_",
}));

vi.mock("../../../src/llm/tools/connection-tools.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/llm/tools/connection-tools.js")>();
  return {
    ...original,
    createConnectionTools: vi.fn(async (opts: Parameters<typeof original.createConnectionTools>[0]) =>
      mocks.notOffered.length > 0 ? { ...original.NO_CONNECTION_TOOLS, notOffered: mocks.notOffered } : original.createConnectionTools(opts)
    ),
  };
});

vi.mock("../../../src/services/separate-reader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/services/separate-reader.js")>();
  return {
    ...original,
    sourceTextRuleFor: vi.fn(async (nodes: string[]) => (mocks.rule === undefined ? original.sourceTextRuleFor(nodes) : mocks.rule)),
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
import { withPassBudget } from "../../../src/llm/usage-context.js";
import { TOOLS_RETURNING_SOURCE_TEXT, returnsSourceText } from "../../../src/llm/run-visibility.js";

const CLAIM_ID = "aaaaaaaa-0000-4000-8000-000000000005";

type LoopOptions = {
  tools: Array<{ name: string; description?: string; input_schema?: { properties?: Record<string, unknown> } }>;
  initialMessages: Array<{ content: string }>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

async function run(kind = "claim"): Promise<LoopOptions> {
  mocks.claim = { id: CLAIM_ID, importance: 0.5, domains: [], kind };
  await withPassBudget({ microUsd: 5_000_000, source: "the test lane" }, () =>
    runClaimSteward({ trigger: "structure_and_assess", claimId: CLAIM_ID, context: "", model: "claude-sonnet-5-5" })
  );
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
  mocks.queries.length = 0;
  mocks.rule = undefined;
  mocks.notOffered = [];
});

describe("a Steward whose node's page is under no showing", () => {
  it("on the public graph asks nothing about showings and is sent what it was always sent", async () => {
    // The real lookup, in a process no database has told of a second label.
    const open = await run();
    expect(mocks.queries.filter((q) => /showings/.test(q))).toEqual([]);
    expect(open.initialMessages[0]!.content).not.toMatch(/standing showing|launch a reader|cannot read/);
    const delegate = open.tools.find((t) => t.name === "delegate_research")!;
    expect(Object.keys(delegate.input_schema!.properties!)).not.toContain("questions");
    expect(delegate.description).not.toContain("reader");

    // The same run with the lookup answering that no rule applies is the same, to the byte.
    mocks.rule = null;
    const none = await run();
    expect(JSON.stringify(none.tools)).toBe(JSON.stringify(open.tools));
    expect(none.initialMessages).toEqual(open.initialMessages);
  });
});

describe("a Steward whose node's page is under a standing showing", () => {
  it.each(["claim", "quantity", "question"])("is told what it is not given and why, and can launch a reader (%s)", async (kind) => {
    mocks.rule = { pageLabel: "restricted", withheldLabels: ["internal", "restricted"], reader: false };
    mocks.notOffered = ["Finance ledger"];
    const shown = await run(kind);
    const message = shown.initialMessages[0]!.content;
    expect(message).toContain("## Sources this page's readers cannot read");
    expect(message).toContain("This node's page at `restricted` is under a standing showing");
    expect(message).toContain('and the connection "Finance ledger" is not offered, nor a reading or an output made from them.');
    expect(message).toContain("A reader opens them for you. delegate_research with `questions` launches the researcher at `restricted`");
    const delegate = shown.tools.find((t) => t.name === "delegate_research")!;
    expect(Object.keys(delegate.input_schema!.properties!)).toContain("questions");
  });

  it("holds no tool that hands it a source's text but the one that asks the rule first", async () => {
    mocks.rule = { pageLabel: "restricted", withheldLabels: ["restricted"], reader: false };
    mocks.notOffered = ["Finance ledger"];
    const shown = await run();
    const holds = shown.tools.map((t) => t.name).filter((n) => returnsSourceText(n));
    // Two stay, and each asks the rule before it hands over text (tests/unit/llm/separate-reader.test.ts,
    // tests/db/separate-reader.test.ts): provenance_read_source, for the open web and for sources the page's
    // readers read, and get_contribution_details, whose excerpt of a proposed source is given on the same terms.
    // No connection's tool, no reading, no command and no output.
    expect(holds).toEqual(["get_contribution_details", "provenance_read_source"]);
    expect(Object.keys(TOOLS_RETURNING_SOURCE_TEXT)).toContain("provenance_read_source");
  });
});
