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
  getArgumentsForClaim: vi.fn(async () => []),
  getEvaluationStateForClaim: vi.fn(async () => []),
  hasWrittenForm: (content: string | null) => !!content && content.length > 40,
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
  leanChecksByArgument: vi.fn(async () => new Map()),
  listLeanChecksForClaim: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/quantity-service.js", () => ({
  getQuantityDetail: vi.fn(),
  getThresholdOf: vi.fn(async () => null),
}));
vi.mock("../../../../src/services/request-service.js", () => ({
  listRequests: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("../../../../src/services/claim-instance-service.js", () => ({
  countClaimInstances: vi.fn(async () => 0),
}));
vi.mock("../../../../src/services/source-map-service.js", () => ({
  getSourceMapSummary: vi.fn(async () => null),
  getClaimSourceMap: vi.fn(async () => null),
}));
vi.mock("../../../../src/services/claim-link-service.js", () => ({
  listRelatedClaims: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/finding-service.js", () => ({
  listFindings: vi.fn(async () => []),
}));
vi.mock("../../../../src/services/question-service.js", () => ({
  getQuestionDetail: vi.fn(),
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
import { getQuantityDetail } from "../../../../src/services/quantity-service.js";
import { getQuestionDetail } from "../../../../src/services/question-service.js";
import {
  getArgumentsForClaim,
  getEvaluationStateForClaim,
} from "../../../../src/services/argument-service.js";
import { listClaimDependents } from "../../../../src/services/tree-service.js";
import { listRequests } from "../../../../src/services/request-service.js";
import { countClaimInstances } from "../../../../src/services/claim-instance-service.js";
import { getSourceMapSummary } from "../../../../src/services/source-map-service.js";
import { listRelatedClaims } from "../../../../src/services/claim-link-service.js";
import { listFindings } from "../../../../src/services/finding-service.js";

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

    // #628: a quantity's estimate and a question's standing live outside
    // `assessments`; the hit says which kind it is and reads recency there.
    it("carries each hit's kind and reads recency from the kind's own table", async () => {
      mockHybrid.mockResolvedValue({
        results: [{ id: "q1", text: "How large is X?", importance: 0.5 }],
        total: 1,
      } as never);
      mockRawQuery.mockResolvedValue([
        { id: "q1", kind: "quantity", contestation: 0.2, steward_state: "done", days_since_assessed: 3 },
      ] as never);

      const out = JSON.parse(
        (await executeGraphReadTool("search_claims", { query: "x" }))!
      );

      expect(out.claims[0]).toMatchObject({ id: "q1", kind: "quantity", days_since_assessed: 3 });
      const sql = String(mockRawQuery.mock.calls[0]![0]);
      expect(sql).toContain("quantity_estimates");
      expect(sql).toContain("question_assessments");
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

    it("answers a malformed id with a tool error, not a thrown query error", async () => {
      mockGetClaim.mockRejectedValue(Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" }) as never);

      const out = JSON.parse(
        (await executeGraphReadTool("get_claim", { claim_id: "dd99c243" }))!
      );

      expect(out.error).toMatch(/full claim id/);
    });

    it("still throws any other failure", async () => {
      mockGetClaim.mockRejectedValue(new Error("connection reset") as never);

      await expect(executeGraphReadTool("get_claim", { claim_id: "c1" })).rejects.toThrow("connection reset");
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
        status: "inconclusive",
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

      expect(out.assessment.status).toBe("inconclusive");
      expect(out.assessment.reasoning_trace).toBe("The audit trail");
      expect(out.assessment.claim_credence).toBeNull();
      expect(out.subclaim_count).toBe(3);
    });

    it("carries a quantity's estimate and a question's structure, which are their assessment (#628)", async () => {
      const base = {
        text: "node",
        claimType: "empirical_derived",
        state: "active",
        decompositionStatus: "done",
        importance: 0.5,
      };
      mockSubclaimCount.mockResolvedValue(0 as never);
      mockAssessment.mockResolvedValue(null as never);
      vi.mocked(getQuantityDetail).mockResolvedValue({
        definition: { measures: "m", population: null, conditions: null, unit: null },
        estimate: { form: "point", central: 4 },
        assessed: { summary: "s", work: "w", model: "m", assessed_at: "2026-01-01" },
        estimates: [{}, {}],
        readings: [],
        cuts: [],
      } as never);
      vi.mocked(getQuestionDetail).mockResolvedValue({ standing: "open", answers: [] } as never);

      mockGetClaim.mockResolvedValueOnce({ id: "q1", kind: "quantity", ...base } as never);
      const qty = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: "q1" }))!);
      expect(qty.claim.kind).toBe("quantity");
      expect(qty.quantity.estimate).toEqual({ form: "point", central: 4 });
      expect(qty.quantity.estimates).toHaveLength(2);
      expect(qty.question).toBeNull();

      mockGetClaim.mockResolvedValueOnce({ id: "k1", kind: "question", ...base } as never);
      const qn = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: "k1" }))!);
      expect(qn.claim.kind).toBe("question");
      expect(qn.question).toEqual({ standing: "open", answers: [] });
      expect(qn.quantity).toBeNull();
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
    // #774: one get_claim for every agent. What the governance roles' reader
    // returned is reachable here, by default or by `include`.
    describe("the governance record (#774)", () => {
      const row = {
        id: "c1",
        kind: "claim",
        text: "A claim",
        claimType: "empirical_derived",
        state: "active",
        decompositionStatus: "complete",
        importance: 0.6,
        stewardState: "pending",
        stewardedAt: null,
        canonicalDirectionNote: "Stated positively, as the literature does.",
        seedCredence: 0.7,
        seedNote: "Likely, per the parent's review.",
        seedSourceClaimId: "p1",
      };

      beforeEach(() => {
        mockGetClaim.mockResolvedValue(row as never);
        mockSubclaimCount.mockResolvedValue(2 as never);
        mockAssessment.mockResolvedValue(null as never);
      });

      it("always carries Steward state, the seed while unassessed, counts and the source map", async () => {
        vi.mocked(countClaimInstances).mockResolvedValue(4 as never);
        vi.mocked(getSourceMapSummary).mockResolvedValue({ summary: "Rests on one survey" } as never);
        vi.mocked(listRequests).mockResolvedValue({
          items: [{ id: "r1", keeper: { kind: "steward" }, bears_on: [{ id: "c1" }] }],
          total: 1,
        } as never);

        const out = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: "c1" }))!);

        expect(out.claim).toMatchObject({
          kind: "claim",
          canonical_form: "A claim",
          steward_state: "pending",
          stewarded_at: null,
          canonical_direction_note: "Stated positively, as the literature does.",
        });
        expect(out.preliminary_seed).toEqual({
          credence: 0.7,
          note: "Likely, per the parent's review.",
          seeded_by_claim_id: "p1",
        });
        expect(out.instance_count).toBe(4);
        expect(out.subclaim_count).toBe(2);
        expect(out.source_map).toEqual({ summary: "Rests on one survey" });
        expect(out.requests[0].kept_by_this_node).toBe(true);
        // Sections that grow with the graph come only when asked for.
        for (const key of ["arguments", "subclaims", "instances", "dependents", "related", "findings", "proofs"]) {
          expect(out[key]).toBeUndefined();
        }
      });

      it("drops the seed once the node has its own assessment", async () => {
        mockAssessment.mockResolvedValue({
          status: "supported",
          confidence: 0.8,
          claimCredence: 0.8,
          summary: "s",
          reasoningTrace: "t",
          assessedAt: new Date("2026-01-01T00:00:00Z"),
        } as never);
        const out = JSON.parse((await executeGraphReadTool("get_claim", { claim_id: "c1" }))!);
        expect(out.preliminary_seed).toBeUndefined();
      });

      it("serves arguments with evaluations, subclaims by argument, related links and findings on request", async () => {
        vi.mocked(getArgumentsForClaim).mockResolvedValue([
          { id: "a1", name: "Survey", stance: "supports", content: "label", evidenceUrls: [], shows: null },
        ] as never);
        vi.mocked(getEvaluationStateForClaim).mockResolvedValue([
          { argument_id: "a1", argument_name: "Survey", verdict: "holds", decisive: true, content: "Sound.", stale: false },
        ] as never);
        mockRawQuery.mockResolvedValue([
          {
            edge_id: "e1",
            child_id: "k1",
            child_text: "A subclaim",
            child_type: "empirical_derived",
            relation_type: "requires",
            reasoning: "The parent needs the survey to hold.",
            confidence: 0.9,
            child_status: "supported",
            child_confidence: 0.7,
            argument_id: "a1",
            argument_name: "Survey",
            child_kind: "claim",
            child_estimate: null,
            child_standing: null,
          },
        ] as never);
        vi.mocked(listRelatedClaims).mockResolvedValue([
          { id: "r1", text: "A neighbour", kind: "see_also", reasoning: "Same survey", assessment_status: null, assessment_confidence: null },
        ] as never);
        vi.mocked(listFindings).mockResolvedValue([
          {
            id: "f1",
            first_noted_at: new Date("2026-02-01T00:00:00Z"),
            agent: "audit",
            importance: "0.5",
            sighting_count: "2",
            headline: "Seed unexamined",
            refs: [{ kind: "claim", id: "c1" }],
            stale: true,
          },
        ] as never);

        const out = JSON.parse(
          (await executeGraphReadTool("get_claim", {
            claim_id: "c1",
            include: ["arguments", "subclaims", "related", "findings"],
          }))!
        );

        expect(out.arguments).toEqual([
          expect.objectContaining({
            id: "a1",
            has_written_form: false,
            evaluation: { verdict: "holds", decisive: true, content: "Sound.", stale: false },
          }),
        ]);
        expect(out.subclaims).toEqual([
          expect.objectContaining({
            id: "k1",
            edge_id: "e1",
            reasoning: "The parent needs the survey to hold.",
            argument_id: "a1",
            assessment_status: "supported",
          }),
        ]);
        expect(out.related).toEqual([
          expect.objectContaining({ id: "r1", link_kind: "see_also", reasoning: "Same survey" }),
        ]);
        expect(out.findings).toEqual([
          expect.objectContaining({
            id: "f1",
            noted_at: "2026-02-01T00:00:00.000Z",
            importance: 0.5,
            sighting_count: 2,
            cites: ["claim c1"],
            stale: expect.any(String),
          }),
        ]);
      });

      it("pages dependents as MCP does", async () => {
        vi.mocked(listClaimDependents).mockResolvedValue({ dependents: [{ id: "d1" }], total: 40 } as never);
        const out = JSON.parse(
          (await executeGraphReadTool("get_claim", {
            claim_id: "c1",
            include: ["dependents"],
            dependents_limit: 500,
            dependents_offset: 25,
          }))!
        );
        expect(listClaimDependents).toHaveBeenCalledWith("c1", { limit: 100, offset: 25 });
        expect(out.dependents).toEqual([{ id: "d1" }]);
        expect(out.dependents_total).toBe(40);
      });
    });
  });
});
