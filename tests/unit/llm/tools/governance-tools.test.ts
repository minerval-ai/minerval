/**
 * get_contribution_details must carry the full case record (#178): the
 * reviewer's escalation reason, any appeals with the appellant's reasoning,
 * and prior arbitration results — otherwise the Arbitrator adjudicates an
 * appeal without being able to read it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CONTRIBUTION_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONTRIBUTOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const REVIEW_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const APPEAL_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const mocks = vi.hoisted(() => ({
  // Rows returned per source table name for db.select().from(table) chains.
  rows: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("../../../../src/db/client.js", async () => {
  const { getTableName } = await import("drizzle-orm");
  // Minimal fluent stand-in for a drizzle select chain: joins/filters are
  // no-ops, the from() table decides the rows, and the chain is awaitable
  // both directly and after .limit().
  function chain(rows: Array<Record<string, unknown>>) {
    const c: Record<string, unknown> = {
      innerJoin: () => c,
      leftJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
      then: (
        resolve: (rows: unknown) => unknown,
        reject: (err: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return c;
  }
  return {
    getDb: () => ({
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) =>
          chain(mocks.rows[getTableName(table)] ?? []),
      }),
    }),
    rawQuery: vi.fn(async () => []),
  };
});

vi.mock("../../../../src/services/formalization-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/formalization-service.js")>()),
  getClaimFormalizationRecord: vi.fn(async () => ({
    formalization: null,
    formalization_pending: null,
    formalization_history: [],
    verification: null,
    lean_checks: [],
    lean_checks_total: 0,
  })),
}));

import { executeGovernanceTool } from "../../../../src/llm/tools/governance-tools.js";

function baseContribution(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTRIBUTION_ID,
    claimId: null,
    contributorId: CONTRIBUTOR_ID,
    contributionType: "challenge",
    content: "The cited study was retracted.",
    evidenceUrls: [],
    submittedAt: new Date("2026-07-01T00:00:00Z"),
    reviewStatus: "escalated",
    escalationReason: null,
    mergeTargetClaimId: null,
    proposedCanonicalForm: null,
    sourceId: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(mocks.rows)) delete mocks.rows[key];
});

describe("get_contribution_details", () => {
  it("includes escalation reason, appeals, and arbitration history", async () => {
    mocks.rows.contributions = [
      baseContribution({
        reviewStatus: "rejected",
        escalationReason: "credible sources conflict",
      }),
    ];
    mocks.rows.contributors = [
      {
        id: CONTRIBUTOR_ID,
        displayName: "Ada",
        reputationScore: 50,
        contributionsAccepted: 3,
        contributionsRejected: 1,
        isVerified: false,
      },
    ];
    mocks.rows.contribution_reviews = [
      {
        decision: "reject",
        reasoning: "Insufficient sourcing.",
        confidence: 0.8,
        policyCitations: ["SH"],
        reviewedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ];
    // The appeals select names its fields, so rows arrive in that shape.
    mocks.rows.appeals = [
      {
        id: APPEAL_ID,
        appealReasoning: "The rejection ignored the primary source I cited.",
        appellantId: CONTRIBUTOR_ID,
        appellantName: "Ada",
        originalReviewId: REVIEW_ID,
        status: "pending",
        submittedAt: new Date("2026-07-03T00:00:00Z"),
      },
    ];
    mocks.rows.arbitration_results = [
      {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        appealId: null,
        outcome: "uphold_original",
        decision: "The rejection stands.",
        reasoning: "The primary source does not support the challenge.",
        humanReviewRecommended: false,
        arbitratedAt: new Date("2026-07-02T12:00:00Z"),
      },
    ];

    const out = JSON.parse(
      await executeGovernanceTool("get_contribution_details", {
        contribution_id: CONTRIBUTION_ID,
      })
    );

    expect(out.contribution.escalation_reason).toBe(
      "credible sources conflict"
    );
    expect(out.appeals).toHaveLength(1);
    expect(out.appeals[0]).toMatchObject({
      id: APPEAL_ID,
      appeal_reasoning: "The rejection ignored the primary source I cited.",
      appellant: { id: CONTRIBUTOR_ID, display_name: "Ada" },
      original_review_id: REVIEW_ID,
      status: "pending",
    });
    expect(out.arbitration_history).toHaveLength(1);
    expect(out.arbitration_history[0]).toMatchObject({
      outcome: "uphold_original",
      reasoning: "The primary source does not support the challenge.",
    });
    expect(out.existing_review).toMatchObject({ decision: "reject" });
  });

  it("omits appeal and arbitration keys when the case record has none", async () => {
    mocks.rows.contributions = [baseContribution()];

    const out = JSON.parse(
      await executeGovernanceTool("get_contribution_details", {
        contribution_id: CONTRIBUTION_ID,
      })
    );

    expect(out.contribution.escalation_reason).toBeNull();
    expect(out).not.toHaveProperty("appeals");
    expect(out).not.toHaveProperty("arbitration_history");
    expect(out.existing_review).toBeNull();
    expect(out.contributor).toBeNull();
  });
});
