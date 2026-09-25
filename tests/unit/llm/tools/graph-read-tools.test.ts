import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../src/services/search-service.js", () => ({
  hybridSearch: vi.fn(),
}));
vi.mock("../../../../src/db/client.js", () => ({ rawQuery: vi.fn() }));
vi.mock("../../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(),
  getClaimInstances: vi.fn(),
}));
vi.mock("../../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: vi.fn(),
}));
vi.mock("../../../../src/services/argument-service.js", () => ({
  getArgumentsForClaim: vi.fn(),
}));
vi.mock("../../../../src/services/tree-service.js", () => ({
  getTransitiveDependents: vi.fn(),
  getClaimTree: vi.fn(),
  getSubclaimCount: vi.fn(),
  listClaimDependents: vi.fn(),
}));
vi.mock("../../../../src/services/tag-service.js", () => ({
  attachClaimTags: vi.fn(async (rows: unknown[]) => rows.map((r) => ({ ...(r as object), tags: [] }))),
  getTagsForSubject: vi.fn(async () => []),
  resolveTagBySlug: vi.fn(),
}));
vi.mock("../../../../src/services/formalization-service.js", () => ({
  getClaimFormalizationRecord: vi.fn(),
}));

import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../../../../src/llm/tools/graph-read-tools.js";
import { hybridSearch } from "../../../../src/services/search-service.js";
import { rawQuery } from "../../../../src/db/client.js";
import { getClaimById } from "../../../../src/services/claim-service.js";
import { getCurrentAssessment } from "../../../../src/services/assessment-service.js";
import {
  getTransitiveDependents,
  getClaimTree,
  getSubclaimCount,
} from "../../../../src/services/tree-service.js";
import { getClaimFormalizationRecord } from "../../../../src/services/formalization-service.js";

const mockHybrid = vi.mocked(hybridSearch);
const mockRawQuery = vi.mocked(rawQuery);
const mockGetClaim = vi.mocked(getClaimById);
const mockAssessment = vi.mocked(getCurrentAssessment);
const mockTree = vi.mocked(getClaimTree);
const mockTransitiveDeps = vi.mocked(getTransitiveDependents);
const mockSubclaimCount = vi.mocked(getSubclaimCount);
const mockFormalizationRecord = vi.mocked(getClaimFormalizationRecord);

const EMPTY_RECORD = {
  formalization: null,
  formalization_pending: null,
  formalization_history: [],
  verification: null,
  lean_checks: [],
  lean_checks_total: 0,
};

describe("graph-read-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFormalizationRecord.mockResolvedValue(EMPTY_RECORD as never);
  });

  it("exposes the four reads every agent gets", () => {
    expect(getGraphReadToolDefinitions().map((t) => t.name)).toEqual([
      "search_claims",
      "get_claim",
      "get_decomposition",
      "get_dependents",
    ]);
  });

  it("returns null for a tool it does not own, so callers can fall through", async () => {
    expect(await executeGraphReadTool("set_valuations", {})).toBeNull();
  });

  describe("search_claims", () => {
    it("retrieves through hybridSearch rather than a keyword match", async () => {
      mockHybrid.mockResolvedValue({ results: [], total: 0 } as never);
      mockRawQuery.mockResolvedValue([] as never);

      await executeGraphReadTool("search_claims", { query: "wages" });

      expect(mockHybrid).toHaveBeenCalledWith("wages", { limit: 15 });
    });

    it("decorates hits with the allocation signals hybridSearch omits", async () => {
      mockHybrid.mockResolvedValue({
        results: [{ id: "c1", text: "A claim", importance: 0.8 }],
        total: 1,
      } as never);
      mockRawQuery.mockResolvedValue([
        {
          id: "c1",
          contestation: 0.6,
          steward_state: "pending",
          days_since_assessed: 40,
        },
      ] as never);

      const out = JSON.parse(
        (await executeGraphReadTool("search_claims", { query: "wages" }))!
      );

      expect(out.claims[0]).toMatchObject({
        id: "c1",
        importance: 0.8,
        contestation: 0.6,
        steward_state: "pending",
        days_since_assessed: 40,
      });
    });

    it("skips the signals query when nothing matched", async () => {
      mockHybrid.mockResolvedValue({ results: [], total: 0 } as never);

      await executeGraphReadTool("search_claims", { query: "nothing" });

      expect(mockRawQuery).not.toHaveBeenCalled();
    });
  });

  describe("depth handling", () => {
    beforeEach(() => {
      mockGetClaim.mockResolvedValue({ id: "c1", text: "A claim" } as never);
      mockTree.mockResolvedValue(null as never);
      mockTransitiveDeps.mockResolvedValue({
        dependents: [],
        total: 0,
        truncated: false,
      } as never);
    });

    it("defaults both walks to three levels", async () => {
      await executeGraphReadTool("get_decomposition", { claim_id: "c1" });
      await executeGraphReadTool("get_dependents", { claim_id: "c1" });

      expect(mockTree).toHaveBeenCalledWith("c1", 3);
      expect(mockTransitiveDeps).toHaveBeenCalledWith("c1", 3);
    });

    it("clamps a greedy depth request to the ceiling", async () => {
      await executeGraphReadTool("get_decomposition", {
        claim_id: "c1",
        max_depth: 50,
      });

      expect(mockTree).toHaveBeenCalledWith("c1", 8);
    });

    it("ignores a nonsense depth instead of walking zero levels", async () => {
      await executeGraphReadTool("get_dependents", {
        claim_id: "c1",
        max_depth: "deep",
      });

      expect(mockTransitiveDeps).toHaveBeenCalledWith("c1", 3);
    });
  });

  describe("get_claim", () => {
    it("reports a missing claim rather than throwing", async () => {
      mockGetClaim.mockResolvedValue(null as never);

      const out = JSON.parse(
        (await executeGraphReadTool("get_claim", { claim_id: "gone" }))!
      );

      expect(out.error).toBe("claim not found");
    });

    it("carries the assessment's reasoning, not just its status", async () => {
      mockGetClaim.mockResolvedValue({
        id: "c1",
        text: "A claim",
        claimType: "causal",
        state: "active",
        decompositionStatus: "done",
        importance: 0.7,
      } as never);
      mockSubclaimCount.mockResolvedValue(3 as never);
      mockAssessment.mockResolvedValue({
        status: "contested",
        confidence: 0.5,
        claimCredence: null,
        summary: "Reader-facing body",
        reasoningTrace: "The audit trail",
        assessedAt: new Date("2026-01-01T00:00:00Z"),
        model: "claude-opus-5-5",
      } as never);

      const out = JSON.parse(
        (await executeGraphReadTool("get_claim", { claim_id: "c1" }))!
      );

      expect(out.assessment.status).toBe("contested");
      expect(out.assessment.reasoning_trace).toBe("The audit trail");
      expect(out.assessment.claim_credence).toBeNull();
      expect(out.subclaim_count).toBe(3);
    });

    // #435: a Grantmaker valuing attempt_proof must read the published
    // statement for fidelity, and one valuing formalize must be able to tell
    // whether an earlier run ran at all. The record rides on every read.
    it("carries the formalization record: statement, pending version, history, and checks", async () => {
      mockGetClaim.mockResolvedValue({ id: "c1", text: "A claim" } as never);
      mockSubclaimCount.mockResolvedValue(0 as never);
      mockAssessment.mockResolvedValue(null as never);
      mockFormalizationRecord.mockResolvedValue({
        formalization: {
          id: "f2",
          version: 2,
          status: "published",
          statement_source: "theorem ...",
          source_hash: "abc",
          pin_id: "mathlib-v4.33.1",
          correspondence: "Statement 2 says what the claim says.",
          review_period_ends_at: "2026-10-01T00:00:00Z",
        },
        formalization_pending: {
          id: "f3",
          version: 3,
          status: "reviewed",
          review_notes: "Hypothesis tightened; awaiting second pass.",
        },
        formalization_history: [
          { id: "f3", version: 3, status: "reviewed" },
          { id: "f2", version: 2, status: "published" },
          { id: "f1", version: 1, status: "retired", retire_reason: "vacuous" },
        ],
        verification: null,
        lean_checks: [{ id: "lc1", verdict: "rejected", mode: "attempt", failed_gate: "kernel" }],
        lean_checks_total: 1,
      } as never);

      const out = JSON.parse(
        (await executeGraphReadTool("get_claim", { claim_id: "c1" }))!
      );

      expect(mockFormalizationRecord).toHaveBeenCalledWith("c1");
      expect(out.formalization.statement_source).toBe("theorem ...");
      expect(out.formalization.review_period_ends_at).toBe("2026-10-01T00:00:00Z");
      expect(out.formalization_pending.status).toBe("reviewed");
      expect(out.formalization_history.map((h: { status: string }) => h.status)).toEqual([
        "reviewed",
        "published",
        "retired",
      ]);
      expect(out.lean_checks[0].failed_gate).toBe("kernel");
      expect(out.lean_checks_total).toBe(1);
    });

    it("says explicitly when nothing has ever been formalized", async () => {
      mockGetClaim.mockResolvedValue({ id: "c1", text: "A claim" } as never);
      mockSubclaimCount.mockResolvedValue(0 as never);
      mockAssessment.mockResolvedValue(null as never);

      const out = JSON.parse(
        (await executeGraphReadTool("get_claim", { claim_id: "c1" }))!
      );

      expect(out.formalization).toBeNull();
      expect(out.formalization_pending).toBeNull();
      expect(out.formalization_history).toEqual([]);
      expect(out.lean_checks_total).toBe(0);
    });
  });
});
