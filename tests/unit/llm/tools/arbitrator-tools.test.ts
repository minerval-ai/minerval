/**
 * Arbitrator lift_suspension (#180): the judgment path for suspensions the
 * mechanical overturn restoration cannot lift, resolving the audit finding
 * an audit suspension rests on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const CONTRIBUTOR_ID = "d3d3d3d3-3333-3333-3333-333333333333";
const FINDING_ID = "f1f1f1f1-1111-1111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  contributorRow: null as Record<string, unknown> | null,
  updateSets: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mocks.contributorRow ? [mocks.contributorRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.updateSets.push(v);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: async () => undefined,
    }),
  }),
}));
vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueSteward: vi.fn(),
  requestAudit: vi.fn(async () => "run-1"),
}));
vi.mock("../../../../src/services/reputation-service.js", () => ({
  reverseReviewOutcome: vi.fn(async () => null),
  applyArbitrationOutcome: vi.fn(async () => null),
  AUDIT_SUSPENSION_PREFIX: "audit:",
  BAD_FAITH_CATEGORIES: ["spam", "vandalism", "sybil", "misinformation"],
}));
vi.mock("../../../../src/services/intake-service.js", () => ({
  isIntakeContributionType: () => false,
  materializeAcceptedIntake: vi.fn(),
}));
vi.mock("../../../../src/services/contribution-service.js", () => ({
  getContributionById: vi.fn(async () => null),
}));

import { executeArbitratorTool } from "../../../../src/llm/tools/arbitrator-tools.js";

beforeEach(() => {
  mocks.rawQuery.mockReset().mockResolvedValue([{ id: FINDING_ID }]);
  mocks.contributorRow = null;
  mocks.updateSets.length = 0;
});

describe("lift_suspension", () => {
  it("lifts an audit suspension and resolves the finding it cites", async () => {
    mocks.contributorRow = {
      id: CONTRIBUTOR_ID,
      isSuspended: true,
      suspensionReason: `audit:${FINDING_ID} Coordinated sybil accounts.`,
    };

    const out = JSON.parse(
      await executeArbitratorTool("lift_suspension", {
        contributor_id: CONTRIBUTOR_ID,
        reasoning: "The accounts belong to one research group posting openly.",
      })
    );

    expect(out.success).toBe(true);
    expect(out.resolved_finding_id).toBe(FINDING_ID);
    expect(mocks.updateSets[0]).toMatchObject({
      isSuspended: false,
      suspensionReason: null,
      suspendedAt: null,
    });

    const findingUpdate = mocks.rawQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE audit_findings")
    );
    expect(findingUpdate).toBeDefined();
    expect((findingUpdate![1] as unknown[])[1]).toBe(FINDING_ID);
  });

  it("lifts a reputation suspension without touching findings", async () => {
    mocks.contributorRow = {
      id: CONTRIBUTOR_ID,
      isSuspended: true,
      suspensionReason: "reputation: score fell below 10",
    };

    const out = JSON.parse(
      await executeArbitratorTool("lift_suspension", {
        contributor_id: CONTRIBUTOR_ID,
        reasoning: "The penalties behind the score were overturned.",
      })
    );

    expect(out.success).toBe(true);
    expect(out.resolved_finding_id).toBeUndefined();
    expect(
      mocks.rawQuery.mock.calls.find(([sql]) =>
        (sql as string).includes("UPDATE audit_findings")
      )
    ).toBeUndefined();
  });

  it("refuses truthfully when the contributor is not suspended", async () => {
    mocks.contributorRow = {
      id: CONTRIBUTOR_ID,
      isSuspended: false,
      suspensionReason: null,
    };

    const out = JSON.parse(
      await executeArbitratorTool("lift_suspension", {
        contributor_id: CONTRIBUTOR_ID,
        reasoning: "x",
      })
    );

    expect(out.success).toBe(false);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("refuses truthfully when the contributor does not exist", async () => {
    const out = JSON.parse(
      await executeArbitratorTool("lift_suspension", {
        contributor_id: CONTRIBUTOR_ID,
        reasoning: "x",
      })
    );
    expect(out.success).toBe(false);
  });
});
