/**
 * get_claim_dependents lists the claims that cut a quantity, with their
 * credence (#767). What get_claim itself carries is tested on the unified
 * view (tests/unit/services/claim-view-judgment.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CLAIM = "11111111-1111-1111-1111-111111111111";
const SUB = "22222222-2222-2222-2222-222222222222";
const RIVAL = "33333333-3333-3333-3333-333333333333";
const CUTTER = "44444444-4444-4444-4444-444444444444";

const mocks = vi.hoisted(() => ({
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  findingTotal: 0,
}));

vi.mock("../../../../src/db/client.js", async () => {
  const { getTableName } = await import("drizzle-orm");
  function chain(rows: Array<Record<string, unknown>>) {
    const c: Record<string, unknown> = {
      where: () => c,
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
      then: (resolve: (rows: unknown) => unknown, reject: (err: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return c;
  }
  return {
    getDb: () => ({
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => chain(mocks.rows[getTableName(table)] ?? []),
      }),
    }),
    rawQuery: vi.fn(async (sql: string) => {
      if (sql.includes("FROM claim_relationships cr")) {
        return [
          {
            edge_id: "e1",
            child_id: SUB,
            child_text: "A premise",
            child_type: "empirical_derived",
            relation_type: "requires",
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
      if (sql.includes("FROM quantity_cuts")) {
        return [
          {
            id: CUTTER,
            text: "The toll exceeded 50 million",
            claim_type: "empirical_derived",
            direction: "above",
            value: 50_000_000,
            status: "doubtful",
            confidence: 0.6,
            credence: 0.3,
          },
        ];
      }
      return [];
    }),
  };
});

vi.mock("../../../../src/services/formalization-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/formalization-service.js")>()),
  getClaimFormalizationRecord: vi.fn(async () => ({})),
}));
vi.mock("../../../../src/services/claim-instance-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/claim-instance-service.js")>()),
  countClaimInstances: vi.fn(async () => 0),
}));
vi.mock("../../../../src/services/source-map-service.js", () => ({
  getSourceMapSummary: vi.fn(async () => null),
}));
vi.mock("../../../../src/services/finding-service.js", () => ({
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
vi.mock("../../../../src/services/claim-link-service.js", () => ({
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
vi.mock("../../../../src/services/quantity-service.js", () => ({
  getQuantityDetail: vi.fn(),
  getThresholdOf: vi.fn(async () => null),
}));
vi.mock("../../../../src/services/request-service.js", () => ({
  listRequests: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("../../../../src/services/tree-service.js", () => ({
  getClaimDependents: vi.fn(async () => []),
}));

import { executeGovernanceTool } from "../../../../src/llm/tools/governance-tools.js";

beforeEach(() => {
  for (const key of Object.keys(mocks.rows)) delete mocks.rows[key];
  mocks.findingTotal = 10;
  mocks.rows.claims = [
    {
      id: CLAIM,
      kind: "claim",
      text: "The claim",
      claimType: "empirical_derived",
      state: "active",
      decompositionStatus: "complete",
      stewardState: "done",
      stewardedAt: null,
      importance: 0.6,
      contestation: 0.7,
      domains: ["economics"],
      canonicalDirectionNote: null,
      seedCredence: null,
      seedNote: null,
    },
  ];
  mocks.rows.assessments = [
    {
      status: "supported",
      confidence: 0.8,
      claimCredence: 0.75,
      marginalYield: 0.2,
      summary: "The reader-facing account.",
      reasoningTrace: "The trace.",
      assessedAt: new Date("2026-10-01T00:00:00Z"),
    },
  ];
});

describe("get_claim_dependents", () => {
  it("lists the claims that cut a quantity, with their credence", async () => {
    const out = JSON.parse(await executeGovernanceTool("get_claim_dependents", { claim_id: CLAIM }));
    expect(out.count).toBe(1);
    expect(out.dependents[0]).toMatchObject({
      id: CUTTER,
      relation: "cuts",
      cut: { direction: "above", value: 50_000_000 },
      credence: 0.3,
    });
  });
});
