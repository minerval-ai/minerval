import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Steward's domain tagging (docs/mathematics.md §2.1, §3.4):
 * set_claim_domains records the authoritative judgment, a new subclaim
 * inherits its parent's tags unless the Steward passes its own,
 * update_canonical_form can correct the claim type, and every assessment
 * records the skills the run carried.
 */

const NEW_CLAIM_ID = "11111111-1111-1111-1111-111111111111";

const { insertedValues, updatedValues, selectRows } = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
  updatedValues: [] as Record<string, unknown>[],
  // Rows the next select(...).limit() resolves to, consumed in order.
  selectRows: [] as Array<Record<string, unknown>[]>,
}));

vi.mock("../../../../src/db/client.js", () => {
  const values = (row: Record<string, unknown>) => {
    insertedValues.push(row);
    const p = Promise.resolve([{ id: NEW_CLAIM_ID }]);
    return Object.assign(p, { returning: () => Promise.resolve([{ id: NEW_CLAIM_ID }]) });
  };
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => selectRows.shift() ?? [] }),
    }),
  });
  const update = () => ({
    set: (row: Record<string, unknown>) => {
      updatedValues.push(row);
      return { where: async () => undefined };
    },
  });
  return {
    getDb: () => ({ insert: () => ({ values }), select, update }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
}));

vi.mock("../../../../src/services/argument-service.js", () => ({
  ARGUMENT_VERDICTS: [],
  addArgument: vi.fn(),
  getArgument: vi.fn(),
  getArgumentSubclaims: vi.fn(),
  getEvaluationStateForClaim: vi.fn(async () => []),
  isArgumentVerdict: () => false,
  parseClaimLinks: () => [],
  setArgumentContent: vi.fn(),
  setArgumentEvaluation: vi.fn(),
}));

import {
  executeStewardTool,
  getStewardToolDefinitions,
} from "../../../../src/llm/tools/steward-tools.js";
import { runWithUsageContext } from "../../../../src/llm/usage-context.js";

const PARENT = "22222222-2222-2222-2222-222222222222";
const CLAIM = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  updatedValues.length = 0;
  selectRows.length = 0;
});

describe("set_claim_domains", () => {
  it("is in the Steward's toolset with the three required arguments", () => {
    const def = getStewardToolDefinitions().find((t) => t.name === "set_claim_domains");
    expect(def).toBeDefined();
    expect(def!.input_schema.required).toEqual(["claim_id", "domains", "reasoning"]);
  });

  it("records the tags with domains_source = steward", async () => {
    const out = JSON.parse(
      await executeStewardTool("set_claim_domains", {
        claim_id: CLAIM,
        domains: ["Mathematics", "mathematics"],
        reasoning: "A theorem.",
      })
    );
    expect(out.success).toBe(true);
    expect(out.domains).toEqual(["mathematics"]);
    expect(out.message).toMatch(/next pass/);
    const row = updatedValues.find((r) => "domains" in r);
    expect(row).toMatchObject({ domains: ["mathematics"], domainsSource: "steward" });
  });

  it("accepts an empty list for a claim that belongs to no domain", async () => {
    const out = JSON.parse(
      await executeStewardTool("set_claim_domains", {
        claim_id: CLAIM,
        domains: [],
        reasoning: "Empirical economics.",
      })
    );
    expect(out.success).toBe(true);
    expect(updatedValues.find((r) => "domains" in r)).toMatchObject({
      domains: [],
      domainsSource: "steward",
    });
  });

  it("refuses a domain outside the closed list and names the list", async () => {
    const out = JSON.parse(
      await executeStewardTool("set_claim_domains", {
        claim_id: CLAIM,
        domains: ["alchemy"],
        reasoning: "r",
      })
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/Unknown domain\(s\): alchemy/);
    expect(out.message).toMatch(/mathematics/);
    expect(updatedValues).toEqual([]);
  });
});

describe("add_decomposition_edge domains", () => {
  const edge = (extra: Record<string, unknown> = {}) =>
    executeStewardTool("add_decomposition_edge", {
      parent_id: PARENT,
      child_text: "A dependency",
      relation: "requires",
      reasoning: "needed",
      ...extra,
    });

  it("inherits the parent's tags when the Steward passes none", async () => {
    selectRows.push([{ domains: ["mathematics"] }]);
    const out = JSON.parse(await edge());
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/domains \[mathematics\] \(inherited\)/);
    const row = insertedValues.find((r) => "text" in r);
    expect(row).toMatchObject({ domains: ["mathematics"], domainsSource: "inherited" });
  });

  it("leaves an untagged parent's subclaim untagged", async () => {
    selectRows.push([{ domains: [] }]);
    const out = JSON.parse(await edge());
    expect(out.success).toBe(true);
    const row = insertedValues.find((r) => "text" in r)!;
    expect("domains" in row).toBe(false);
    expect("domainsSource" in row).toBe(false);
  });

  it("takes the Steward's own list over the parent's, source steward", async () => {
    selectRows.push([{ domains: ["mathematics"] }]);
    const out = JSON.parse(await edge({ domains: [] }));
    expect(out.success).toBe(true);
    const row = insertedValues.find((r) => "text" in r);
    expect(row).toMatchObject({ domains: [], domainsSource: "steward" });
    // The parent was not consulted: its row is still queued.
    expect(selectRows).toHaveLength(1);
  });

  it("refuses an unknown domain without creating the subclaim", async () => {
    const out = JSON.parse(await edge({ domains: ["alchemy"] }));
    expect(out.success).toBe(false);
    expect(insertedValues).toEqual([]);
  });
});

describe("update_canonical_form claim_type", () => {
  it("sets the type when given a recognized value", async () => {
    const out = JSON.parse(
      await executeStewardTool("update_canonical_form", {
        claim_id: CLAIM,
        new_text: "There are infinitely many primes.",
        claim_type: "mathematical",
        reasoning: "A theorem is not empirical.",
      })
    );
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/claim_type set to mathematical/);
    expect(updatedValues[0]).toMatchObject({
      text: "There are infinitely many primes.",
      claimType: "mathematical",
    });
  });

  it("leaves the type alone when omitted and refuses an unknown value", async () => {
    await executeStewardTool("update_canonical_form", {
      claim_id: CLAIM,
      new_text: "Reworded.",
      reasoning: "r",
    });
    expect("claimType" in updatedValues[0]!).toBe(false);

    const out = JSON.parse(
      await executeStewardTool("update_canonical_form", {
        claim_id: CLAIM,
        new_text: "Reworded.",
        claim_type: "poetic",
        reasoning: "r",
      })
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/Unknown claim_type "poetic"/);
    expect(updatedValues).toHaveLength(1);
  });
});

describe("update_claim_assessment skills stamp", () => {
  const assess = () =>
    executeStewardTool("update_claim_assessment", {
      claim_id: CLAIM,
      status: "supported",
      confidence: 0.8,
      assessment: "Stands.",
      reasoning_trace: "Because.",
    });

  it("records the skills the run carried, from the usage context", async () => {
    const out = JSON.parse(
      await runWithUsageContext({ skills: ["mathematics"] }, assess)
    );
    expect(out.success).toBe(true);
    const row = insertedValues.find((r) => "reasoningTrace" in r);
    expect(row?.skills).toEqual(["mathematics"]);
  });

  it("records [] for an unskilled run and null outside any run", async () => {
    await runWithUsageContext({ skills: [] }, assess);
    expect(insertedValues.find((r) => "reasoningTrace" in r)?.skills).toEqual([]);
    insertedValues.length = 0;
    await assess();
    expect(insertedValues.find((r) => "reasoningTrace" in r)?.skills).toBeNull();
  });
});
