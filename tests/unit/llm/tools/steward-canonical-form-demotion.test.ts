import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * update_canonical_form's mechanical consequence (docs/mathematics.md
 * §5.7): a canonical-form change on a claim with a published formal
 * statement returns the statement to reviewed, moves an open bounty bound
 * to it to rebinding, and says so in the tool result. A claim without a
 * published statement is untouched, and the result says nothing about it.
 */

const CLAIM = "22222222-2222-4222-8222-222222222222";
const FORMALIZATION = "f2222222-2222-4222-8222-222222222222";

const { updatedValues, demotions } = vi.hoisted(() => ({
  updatedValues: [] as Record<string, unknown>[],
  demotions: [] as Array<{ claimId: string; reason: string }>,
}));

vi.mock("../../../../src/db/client.js", () => {
  const select = () => ({
    from: () => ({ where: () => ({ limit: async () => [] }) }),
  });
  const update = () => ({
    set: (row: Record<string, unknown>) => {
      updatedValues.push(row);
      return { where: async () => undefined };
    },
  });
  return {
    getDb: () => ({ insert: () => ({ values: vi.fn() }), select, update }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueClaimPipeline: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async () => {}),
  enqueueCurator: vi.fn(async () => {}),
}));

const mocks = vi.hoisted(() => ({
  demote: vi.fn(async (_claimId: string, _opts: { reason: string }) => ({
    formalization: null as null | Record<string, unknown>,
    bounties: [] as string[],
  })),
}));

vi.mock("../../../../src/services/formalization-service.js", () => ({
  demotePublishedFormalization: (claimId: string, opts: { reason: string }) => {
    demotions.push({ claimId, reason: opts.reason });
    return mocks.demote(claimId, opts);
  },
}));

import { executeStewardTool } from "../../../../src/llm/tools/steward-tools.js";

beforeEach(() => {
  updatedValues.length = 0;
  demotions.length = 0;
  mocks.demote.mockReset();
  mocks.demote.mockResolvedValue({ formalization: null, bounties: [] });
});

describe("update_canonical_form and the published formal statement", () => {
  it("returns a published statement to reviewed and moves the open bounty to rebinding, and says so", async () => {
    mocks.demote.mockResolvedValueOnce({
      formalization: { id: FORMALIZATION, version: 2, status: "reviewed" },
      bounties: ["b-1"],
    });
    const out = JSON.parse(
      await executeStewardTool("update_canonical_form", {
        claim_id: CLAIM,
        new_text: "There are infinitely many primes p such that p + 2 is prime.",
        reasoning: "Name the proposition as the discourse states it.",
      })
    );
    expect(out.success).toBe(true);
    expect(updatedValues[0]).toMatchObject({
      text: "There are infinitely many primes p such that p + 2 is prime.",
    });
    expect(demotions).toEqual([
      {
        claimId: CLAIM,
        reason: "canonical form changed (Name the proposition as the discourse states it.)",
      },
    ]);
    expect(out.formalization_demoted).toBe(FORMALIZATION);
    expect(out.bounties_rebinding).toEqual(["b-1"]);
    expect(out.message).toMatch(/version 2/);
    expect(out.message).toMatch(/returned to reviewed pending re-publication/);
    expect(out.message).toMatch(/bounty bound to it \(b-1\) is now rebinding/);
  });

  it("says nothing about a statement when the claim has none published", async () => {
    const out = JSON.parse(
      await executeStewardTool("update_canonical_form", {
        claim_id: CLAIM,
        new_text: "Reworded.",
        reasoning: "r",
      })
    );
    expect(out.success).toBe(true);
    expect(out.formalization_demoted).toBeNull();
    expect(out.bounties_rebinding).toEqual([]);
    expect(out.message).not.toMatch(/formal statement/);
    expect(out.message).not.toMatch(/rebinding/);
    // The demotion is always attempted: the service decides there is nothing to do.
    expect(demotions).toHaveLength(1);
  });

  it("runs the demotion after the wording write, not instead of it", async () => {
    mocks.demote.mockImplementationOnce(async () => {
      expect(updatedValues).toHaveLength(1);
      return { formalization: null, bounties: [] };
    });
    const out = JSON.parse(
      await executeStewardTool("update_canonical_form", {
        claim_id: CLAIM,
        new_text: "Reworded again.",
        claim_type: "mathematical",
        reasoning: "r",
      })
    );
    expect(out.success).toBe(true);
    expect(out.message).toMatch(/claim_type set to mathematical/);
  });
});
