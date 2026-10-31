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
  getExtractionPrompt: () => "prompt:",
}));
vi.mock("../../../src/llm/prompts/skills.js", () => ({
  listSkills: () => [],
  knownDomains: () => ["mathematics"],
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({ definitions: [], execute: async () => null, raisedCount: 0 }),
}));

import { extractClaims, ExtractionIncompleteError } from "../../../src/llm/agents/extractor.js";

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
});
