import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A mandate's structural proposals (#699): a Grantmaker or lookout may
 * propose a merge, a split or an edit through the Contribution Reviewer,
 * like anyone (§19). A merge names the other node; an edit carries its
 * proposed wording; both land on the row the Reviewer reads.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const { state } = vi.hoisted(() => ({
  state: { active: new Set<string>(), inserts: [] as unknown[][] },
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM claims WHERE id::text")) {
      return state.active.has(String(params[0])) ? [{ id: params[0] }] : [];
    }
    return [];
  }),
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM grants g JOIN budget_jobs")) {
          return [{ funder_user_id: "u-1", status: "active", budget_job_id: "job-1", budget: "100000000" }];
        }
        if (sql.includes("COUNT(*)")) return [{ n: 0 }];
        if (sql.includes("INSERT INTO contributions")) {
          state.inserts.push(params);
          return [{ id: "c-1" }];
        }
        return [];
      },
    })
  ),
}));
vi.mock("../../../src/services/regrant-service.js", () => ({
  grantCommittedMicroUsd: async () => 0,
}));
vi.mock("../../../src/services/queue-service.js", () => ({
  enqueueContribution: async () => {},
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ contributionReviewEstimateMicroUsd: 50_000 }),
}));

import {
  GRANTMAKER_CONTRIBUTION_TYPES,
  submitGrantContribution,
} from "../../../src/services/contribution-service.js";

const content = "These two nodes state the same proposition in different words, per their texts.";

beforeEach(() => {
  state.active = new Set([A, B]);
  state.inserts = [];
});

describe("a mandate's structural proposals", () => {
  it("are among the types a mandate may submit; a source is ingested, not proposed", () => {
    expect(GRANTMAKER_CONTRIBUTION_TYPES).toEqual(
      expect.arrayContaining(["propose_merge", "propose_split", "propose_edit"])
    );
    expect(GRANTMAKER_CONTRIBUTION_TYPES).not.toContain("propose_source");
  });

  it("propose_merge names the other active node, and records it", async () => {
    const missing = await submitGrantContribution({
      grantId: "g-1",
      input: { contribution_type: "propose_merge", claim_id: A, content },
    });
    expect(missing).toMatchObject({ success: false, message: expect.stringContaining("merge_target_claim_id") });
    const self = await submitGrantContribution({
      grantId: "g-1",
      input: { contribution_type: "propose_merge", claim_id: A, merge_target_claim_id: A, content },
    });
    expect(self.success).toBe(false);
    const ok = await submitGrantContribution({
      grantId: "g-1",
      input: { contribution_type: "propose_merge", claim_id: A, merge_target_claim_id: B, content },
    });
    expect(ok.success).toBe(true);
    const row = state.inserts[0]!;
    expect(row[0]).toBe(A);
    expect(row[2]).toBe("propose_merge");
    expect(row[8]).toBe(B);
  });

  it("propose_edit carries its wording as the proposed canonical form", async () => {
    const missing = await submitGrantContribution({
      grantId: "g-1",
      input: { contribution_type: "propose_edit", claim_id: A, content },
    });
    expect(missing.success).toBe(false);
    const ok = await submitGrantContribution({
      grantId: "g-1",
      input: { contribution_type: "propose_edit", claim_id: A, proposed_text: "Better wording.", content },
    });
    expect(ok.success).toBe(true);
    expect(state.inserts[0]![4]).toBe("Better wording.");
    expect(state.inserts[0]![8]).toBeNull();
  });
});
