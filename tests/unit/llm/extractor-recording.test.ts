import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Extractor records claims with tool calls (record_claims, then
 * finish_extraction) on a streamed loop, rather than one structured answer:
 * a turn cut off at the output limit loses nothing already recorded, each
 * claim is checked as it is recorded, and a batch recorded in the same turn
 * as the finish is kept.
 */

const createMock = vi.fn();
const streamMock = vi.fn();
const promptArgs = vi.hoisted(() => [] as unknown[][]);

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: createMock, stream: streamMock } };
  },
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({
    anthropicApiKey: "test-key",
    extractorModel: "claude-opus-5-5",
    extractorFallbackModel: "claude-sonnet-5-5",
    extractionMaxTokens: 16384,
  }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));
vi.mock("../../../src/llm/prompts/extractor.js", () => ({
  getExtractorSystemPromptBlocks: () => ["system"],
  getExtractionPrompt: (...args: unknown[]) => {
    promptArgs.push(args);
    return "prompt:";
  },
}));
vi.mock("../../../src/llm/prompts/skills.js", () => ({
  listSkills: () => [],
  knownDomains: () => ["mathematics"],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [], execute: async () => null, raisedCount: 0 }),
}));

import { extractClaims, ExtractionIncompleteError } from "../../../src/llm/agents/extractor.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

const claim = (text: string, extra: Record<string, unknown> = {}) => ({
  verbatim_text: text,
  context: null,
  proposed_canonical_form: text,
  claim_type: "empirical_verifiable",
  kind: "claim",
  confidence: 0.9,
  importance: 0.5,
  contestation: 0.4,
  source_location: null,
  domains: [],
  ...extra,
});

let ids = 0;
const turn = (calls: Array<[string, Record<string, unknown>]>, stop = "tool_use") => ({
  content: calls.map(([name, input]) => ({ type: "tool_use", id: `t${ids++}`, name, input })),
  usage: { input_tokens: 10, output_tokens: 10 },
  stop_reason: stop,
  container: null,
});
const cut = {
  content: [{ type: "text", text: "Still reading the" }],
  usage: { input_tokens: 10, output_tokens: 16384 },
  stop_reason: "max_tokens",
  container: null,
};

function respondWith(...messages: unknown[]) {
  for (const m of messages) {
    streamMock.mockImplementationOnce(() => ({ on: () => undefined, finalMessage: async () => m }));
  }
}

/** The tool_result the Extractor sent back for the n-th request's last turn. */
function toolResults(request: number): Array<Record<string, unknown>> {
  const messages = streamMock.mock.calls[request]![0].messages;
  const last = messages.at(-1).content as Array<{ type: string; content: string }>;
  return last.filter((b) => b.type === "tool_result").map((b) => JSON.parse(b.content));
}

beforeEach(() => {
  promptArgs.length = 0;
  streamMock.mockReset();
  createMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("the Extractor's recording", () => {
  it("keeps a batch recorded in the same turn as the finish, and streams", async () => {
    respondWith(
      turn([
        ["record_claims", { claims: [claim("A"), claim("B", { domains: ["mathematics"] })] }],
        ["finish_extraction", {}],
      ])
    );
    const seen: number[] = [];
    const claims = await extractClaims({ content: "doc", onClaims: (c) => seen.push(c.length) });
    expect(claims.map((c) => c.verbatim_text)).toEqual(["A", "B"]);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(seen).toEqual([0, 2]);
  });

  it("returns each bad claim with its problem, for the Extractor to fix", async () => {
    respondWith(
      turn([
        [
          "record_claims",
          {
            claims: [
              claim("good"),
              claim("bad type", { claim_type: "vibes" }),
              claim("bad domain", { domains: ["astrology"] }),
              claim("bad score", { importance: 3 }),
            ],
          },
        ],
      ]),
      turn([["record_claims", { claims: [claim("fixed")] }], ["finish_extraction", {}]])
    );
    const claims = await extractClaims({ content: "doc" });
    expect(claims.map((c) => c.verbatim_text)).toEqual(["good", "fixed"]);
    const [first] = toolResults(1);
    expect(first).toMatchObject({ success: false, recorded_now: 1, recorded_total: 1 });
    const problems = (first!.rejected as Array<{ problem: string }>).map((r) => r.problem);
    expect(problems[0]).toMatch(/claim_type must be one of/);
    expect(problems[0]).toContain("mathematical");
    expect(problems[1]).toMatch(/unknown domains: astrology/);
    expect(problems[2]).toMatch(/importance must be a number from 0 to 1/);
  });

  it("holds to a stated cap, and says how many remain", async () => {
    respondWith(
      turn([["record_claims", { claims: [claim("A"), claim("B"), claim("C")] }]]),
      turn([["finish_extraction", {}]])
    );
    const claims = await extractClaims({ content: "doc", maxClaims: 2 });
    expect(claims).toHaveLength(2);
    expect(toolResults(1)[0]).toMatchObject({ recorded_total: 2, remaining: 0, not_recorded_over_cap: 1 });
  });

  it("keeps what was recorded when the run is cut off before finishing", async () => {
    respondWith(turn([["record_claims", { claims: [claim("A")] }]]), cut, cut, cut);
    const claims = await extractClaims({ content: "a very long paper" });
    expect(claims.map((c) => c.verbatim_text)).toEqual(["A"]);
  });

  it("fails, rather than report no claims, when cut off with nothing recorded", async () => {
    respondWith(cut, cut, cut);
    await expect(extractClaims({ content: "a very long paper" })).rejects.toBeInstanceOf(
      ExtractionIncompleteError
    );
  });

  it("accepts finishing with nothing recorded as a document with no claims", async () => {
    respondWith(turn([["finish_extraction", {}]]));
    await expect(extractClaims({ content: "a recipe" })).resolves.toEqual([]);
  });

  it("reports a document problem given on finish_extraction, and refuses one without a kind (#740)", async () => {
    respondWith(
      turn([["finish_extraction", { document_problem: { kind: "paywall", note: "x" } }]]),
      turn([["finish_extraction", { document_problem: { kind: "unreadable", note: "A paywall page." } }]])
    );
    const problems: unknown[] = [];
    const claims = await extractClaims({ content: "subscribe to read", onDocumentProblem: (p) => problems.push(p) });
    expect(claims).toEqual([]);
    expect(toolResults(1)[0]).toMatchObject({ success: false });
    expect(problems).toEqual([{ kind: "unreadable", note: "A paywall page." }]);
  });

  it("keeps a quantity's stated figure and a stated probability, and refuses a figure on a claim (#744)", async () => {
    respondWith(
      turn([
        [
          "record_claims",
          {
            claims: [
              claim("CPI rose 6.5%", { kind: "quantity", stated_value: { form: "point", central: 6.5, low: null } }),
              claim("a 30% chance", { stated_probability: 0.3 }),
              claim("bad figure", { stated_value: { form: "point", central: 1 } }),
              claim("bad interval", { kind: "quantity", stated_value: { form: "interval", low: 5 } }),
            ],
          },
        ],
      ]),
      turn([["finish_extraction", {}]])
    );
    const claims = await extractClaims({ content: "doc" });
    expect(claims.map((c) => c.verbatim_text)).toEqual(["CPI rose 6.5%", "a 30% chance"]);
    expect(claims[0]!.stated_value).toEqual({ form: "point", central: 6.5 });
    expect(claims[1]!.stated_probability).toBe(0.3);
    const problems = (toolResults(1)[0]!.rejected as Array<{ problem: string }>).map((r) => r.problem);
    expect(problems[0]).toMatch(/stated_value is for a quantity/);
    expect(problems[1]).toMatch(/an interval gives low and high/);
  });
});

describe("the Extractor's budget", () => {
  /** Run under a pass budget of `ceiling` micro-USD with `spent` already billed. */
  const underBudget = <T>(ceiling: number, spent: number, fn: () => Promise<T>) => {
    const meter = { billedMicroUsd: spent };
    return runWithUsageContext(
      { meter, passBudget: { microUsd: ceiling, source: "the cap quoted for this operation", meter } },
      fn
    );
  };

  it("is stated in the task message, with what a match costs, when the run has one", async () => {
    respondWith(turn([["finish_extraction", {}]]));
    await underBudget(1_000_000, 50_000, () => extractClaims({ content: "doc", matchMicroUsd: 100_000 }));
    expect(promptArgs[0]![4]).toEqual({
      ceilingMicroUsd: 1_000_000,
      spentMicroUsd: 50_000,
      source: "the cap quoted for this operation",
      matchMicroUsd: 100_000,
    });
  });

  it("states none when the run has none", async () => {
    respondWith(turn([["finish_extraction", {}]]));
    await extractClaims({ content: "doc" });
    expect(promptArgs[0]![4]).toBeNull();
  });

  it("ends the run one turn after the budget is spent, keeping what was recorded", async () => {
    respondWith(
      turn([["record_claims", { claims: [claim("A")] }]]),
      turn([["record_claims", { claims: [claim("never")] }]])
    );
    const claims = await underBudget(100, 1_000, () => extractClaims({ content: "doc" }));
    expect(claims.map((c) => c.verbatim_text)).toEqual(["A"]);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});
