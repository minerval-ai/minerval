/**
 * The unified get_claim view carries the whole prior judgment and every
 * credence the Steward must keep coherent (#760, §21): the assessment's
 * marginal_yield, a credence on each subclaim and related claim, a
 * quantity's and a question's own judgment fields (#755), and a note when
 * the findings list is cut (#762).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CLAIM = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const RIVAL = "33333333-3333-3333-3333-333333333333";

const mocks = vi.hoisted(() => ({
  kind: "claim" as string,
  findingTotal: 0,
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ publicWebBaseUrl: "https://example.test" }),
}));
vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string) => {
    if (sql.includes("FROM claim_relationships cr")) {
      return [
        {
          edge_id: "e1",
          child_id: SUB,
          child_text: "A premise",
          child_type: "empirical_derived",
          relation_type: "requires",
          reasoning: null,
          confidence: 1,
          child_status: "supported",
          child_confidence: 0.7,
          child_credence: 0.8,
          argument_id: null,
          argument_name: null,
          child_kind: "claim",
          child_estimate: null,
          child_standing: null,
        },
      ];
    }
    if (sql.includes("FROM agent_findings")) return [{ n: mocks.findingTotal }];
    if (sql.includes("FROM quantity_estimates")) return [{ marginal_yield: 0.1 }];
    if (sql.includes("FROM question_assessments")) return [{ confidence: 0.65, marginal_yield: 0.3 }];
    return [];
  }),
}));
vi.mock("../../../src/services/claim-service.js", () => ({
  getClaimById: vi.fn(async () => ({
    id: CLAIM,
    kind: mocks.kind,
    text: "The claim",
    claimType: "empirical_derived",
    state: "active",
    decompositionStatus: "complete",
    importance: 0.6,
    contestation: 0.7,
    domains: ["economics"],
    stewardState: "done",
    stewardedAt: null,
    canonicalDirectionNote: null,
    seedCredence: null,
    seedNote: null,
  })),
  getClaimInstances: vi.fn(async () => []),
}));
vi.mock("../../../src/services/assessment-service.js", () => ({
  getCurrentAssessment: vi.fn(async () =>
    mocks.kind === "claim"
      ? {
          status: "supported",
          confidence: 0.8,
          claimCredence: 0.75,
          marginalYield: 0.2,
          summary: "The reader-facing account.",
          reasoningTrace: "The trace.",
          assessedAt: new Date("2026-10-01T00:00:00Z"),
        }
      : null
  ),
}));
vi.mock("../../../src/services/argument-service.js", () => ({
  getArgumentsForClaim: vi.fn(async () => []),
  getEvaluationStateForClaim: vi.fn(async () => []),
  getRetiredArgumentsForClaim: vi.fn(async () => []),
  hasWrittenForm: vi.fn(() => true),
}));
vi.mock("../../../src/services/tree-service.js", () => ({
  getSubclaimCount: vi.fn(async () => 1),
  listClaimDependents: vi.fn(async () => ({ dependents: [], total: 0 })),
}));
vi.mock("../../../src/services/tag-service.js", () => ({ getTagsForSubject: vi.fn(async () => []) }));
vi.mock("../../../src/services/formalization-service.js", () => ({
  getClaimFormalizationRecord: vi.fn(async () => ({})),
  leanChecksByArgument: vi.fn(async () => new Map()),
  listLeanChecksForClaim: vi.fn(async () => []),
}));
vi.mock("../../../src/services/quantity-service.js", () => ({
  getQuantityDetail: vi.fn(async () => ({ definition: {}, estimate: null })),
  getThresholdOf: vi.fn(async () => null),
}));
vi.mock("../../../src/services/question-service.js", () => ({
  getQuestionDetail: vi.fn(async () => ({ standing: "open", answers: [] })),
}));
vi.mock("../../../src/services/request-service.js", () => ({
  listRequests: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("../../../src/services/claim-instance-service.js", () => ({
  countClaimInstances: vi.fn(async () => 0),
}));
vi.mock("../../../src/services/source-map-service.js", () => ({
  getClaimSourceMap: vi.fn(async () => null),
  getSourceMapSummary: vi.fn(async () => null),
}));
vi.mock("../../../src/services/claim-link-service.js", () => ({
  listRelatedClaims: vi.fn(async () => [
    {
      id: RIVAL,
      text: "A rival explanation",
      kind: "rival",
      reasoning: "same event",
      assessment_status: "inconclusive",
      assessment_confidence: 0.5,
      assessment_credence: 0.4,
    },
  ]),
}));
vi.mock("../../../src/services/finding-service.js", () => ({
  listFindings: vi.fn(async () =>
    Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      first_noted_at: new Date(),
      agent: "steward",
      importance: 0.5,
      sighting_count: 1,
      headline: `finding ${i}`,
      refs: [],
      stale: false,
    }))
  ),
}));

import { getClaimView } from "../../../src/services/claim-view-service.js";

beforeEach(() => {
  mocks.kind = "claim";
  mocks.findingTotal = 10;
});

describe("get_claim's view of the prior judgment", () => {
  it("carries the prior summary, credence, yield, contestation and domains", async () => {
    const out = (await getClaimView(CLAIM))!;
    expect(out.claim).toMatchObject({ contestation: 0.7, domains: ["economics"], importance: 0.6 });
    expect(out.assessment).toMatchObject({
      summary: "The reader-facing account.",
      reasoning_trace: "The trace.",
      claim_credence: 0.75,
      marginal_yield: 0.2,
    });
  });

  it("gives each subclaim and related claim its credence (§21)", async () => {
    const out = (await getClaimView(CLAIM, { include: ["subclaims", "related"] }))!;
    expect((out.subclaims as unknown[])[0]).toMatchObject({ id: SUB, assessment_credence: 0.8 });
    expect((out.related as unknown[])[0]).toMatchObject({
      id: RIVAL,
      assessment_credence: 0.4,
      assessment_confidence: 0.5,
    });
  });

  it("gives a quantity its estimate's yield, and a question its confidence and yield", async () => {
    mocks.kind = "quantity";
    const q = (await getClaimView(CLAIM))!;
    expect(q.quantity).toMatchObject({ marginal_yield: 0.1 });
    mocks.kind = "question";
    const qu = (await getClaimView(CLAIM))!;
    expect(qu.question).toMatchObject({ standing: "open", confidence: 0.65, marginal_yield: 0.3 });
  });

  it("says when findings are cut and where the rest is", async () => {
    mocks.findingTotal = 14;
    const out = (await getClaimView(CLAIM, { include: ["findings"] }))!;
    expect(out.findings).toHaveLength(10);
    expect(out.findings_note).toMatch(/10 most recent of 14/);
    expect(out.findings_note).toMatch(/search_findings/);
  });

  it("adds no note when every finding is shown", async () => {
    const out = (await getClaimView(CLAIM, { include: ["findings"] }))!;
    expect(out.findings_note).toBeUndefined();
  });
});
