import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The tagger (#272): a tool-use loop with search_tags and submit_tags. The
 * loop is mocked so the test drives the tool executor directly: what a
 * search returns to the model, what a submit yields, the fallback when the
 * model never submits, and the attribution every call carries.
 */

const { loopCalls, searchCalls } = vi.hoisted(() => ({
  loopCalls: [] as Array<Record<string, unknown>>,
  searchCalls: [] as string[],
}));

// Each test installs a script: given the loop options, call executeTool as
// the model would and return.
let script: (opts: any) => Promise<void> = async () => {};

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (opts: Record<string, unknown>) => {
    loopCalls.push(opts);
    await script(opts);
    return { messages: [], finalResult: null };
  }),
}));

vi.mock("../../../src/services/tag-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/tag-service.js")>()),
  searchTags: vi.fn(async (query: string) => {
    searchCalls.push(query);
    return [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        slug: "vaccine-safety",
        name: "Vaccine safety",
        description: "Adverse effects and risk of vaccines.",
        similarity: 0.87,
        claim_count: 12,
      },
    ];
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ taggerModel: "deepseek/deepseek-v4-flash", agentReportsPerRun: 3 }),
}));

vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue", description: "", input_schema: { type: "object" } }],
    execute: async () => null,
  }),
}));

import { tagClaim } from "../../../src/llm/agents/tagger.js";
import { getUsageContext } from "../../../src/llm/usage-context.js";

const CLAIM = {
  claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  text: "mRNA vaccines cause myocarditis in young men at a rate above the background rate.",
  claimType: "causal",
  domains: [] as string[],
};

beforeEach(() => {
  loopCalls.length = 0;
  searchCalls.length = 0;
  script = async () => {};
});

describe("tagClaim", () => {
  it("arms the loop with search_tags, submit_tags, and the report channel on the tagger model", async () => {
    await tagClaim(CLAIM);
    const opts = loopCalls[0]!;
    expect((opts.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "search_tags",
      "submit_tags",
      "raise_issue",
    ]);
    expect(opts.model).toBe("deepseek/deepseek-v4-flash");
    // No constitution: the system prompt is the tagger's own, and short.
    expect(typeof opts.system).toBe("string");
    expect((opts.system as string).length).toBeLessThan(6000);
    expect(opts.system as string).toMatch(/never judgment/i);
  });

  it("answers search_tags with the vocabulary hits the model needs to reuse", async () => {
    let out = "";
    script = async (opts) => {
      out = await opts.executeTool("search_tags", { query: "vaccine adverse effects" });
    };
    await tagClaim(CLAIM);
    expect(searchCalls).toEqual(["vaccine adverse effects"]);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.tags[0]).toEqual({
      slug: "vaccine-safety",
      name: "Vaccine safety",
      description: "Adverse effects and risk of vaccines.",
      claims: 12,
      similarity: 0.87,
    });
  });

  it("returns the submitted tags, clamped and capped, with slug-or-name kept apart", async () => {
    script = async (opts) => {
      await opts.executeTool("submit_tags", {
        tags: [
          { slug: "vaccine-safety", confidence: 0.95 },
          { name: "Myocarditis", description: "Inflammation of the heart muscle.", confidence: 1.7 },
          { slug: "", name: "", confidence: 0.5 },
          { name: "Immunology", confidence: 0.6 },
          { name: "Cardiology", confidence: 0.6 },
          { name: "One too many", confidence: 0.6 },
        ],
        reasoning: "A specific safety question under the vaccine-safety field.",
      });
    };
    const d = await tagClaim(CLAIM);
    expect(d.submitted).toBe(true);
    expect(d.tags).toHaveLength(4);
    expect(d.tags[0]).toEqual({ slug: "vaccine-safety", confidence: 0.95 });
    expect(d.tags[1]).toEqual({
      name: "Myocarditis",
      description: "Inflammation of the heart muscle.",
      confidence: 1,
    });
    expect(d.reasoning).toMatch(/vaccine-safety field/);
  });

  it("reports an unsubmitted run rather than inventing tags", async () => {
    const d = await tagClaim(CLAIM);
    expect(d.submitted).toBe(false);
    expect(d.tags).toEqual([]);
  });

  it("attributes every call to the tagger", async () => {
    let agent: string | undefined;
    script = async () => {
      agent = getUsageContext().agent;
    };
    await tagClaim(CLAIM);
    expect(agent).toBe("tagger");
  });

  it("hands the model the claim, its kind, its domains, and the tags others recorded", async () => {
    await tagClaim({
      ...CLAIM,
      domains: ["mathematics"],
      existing: [{ name: "Number theory", source: "steward" }],
    });
    const prompt = (loopCalls[0]!.initialMessages as Array<{ content: string }>)[0]!.content;
    expect(prompt).toContain(CLAIM.text);
    expect(prompt).toContain("causal");
    expect(prompt).toContain("mathematics");
    expect(prompt).toContain('"Number theory" (steward)');
  });
});
