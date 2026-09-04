/**
 * Audit tools (#180): findings persist, consequences require a finding, and
 * standing changes route through the reputation service instead of raw
 * UPDATEs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const FINDING_ID = "f1f1f1f1-1111-1111-1111-111111111111";
const CONTRIBUTION_ID = "c2c2c2c2-2222-2222-2222-222222222222";
const CONTRIBUTOR_ID = "d3d3d3d3-3333-3333-3333-333333333333";
const RUN_ID = "e4e4e4e4-4444-4444-4444-444444444444";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  updateSets: [] as Array<Record<string, unknown>>,
  updateReturning: [[{ id: "some-id" }]] as unknown[][],
  enqueueContribution: vi.fn(async () => {}),
  adjustReputation: vi.fn(async () => ({
    contributorId: "d3",
    previousScore: 50,
    newScore: 45,
    suspended: false,
  })),
  neutralizeReviewOutcome: vi.fn(async () => ({
    contributorId: "d3",
    supersededReviewId: "r1",
    previousScore: 34,
    newScore: 50,
    badFaithFlagCleared: true,
    kudosReversed: 0,
    unsuspended: false,
  })),
  withdrawBounty: vi.fn(async (input: { bountyId: string }) => ({ ok: true, status: "withdrawn", effective_at: null, bountyId: input.bountyId })),
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => ({
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.updateSets.push(v);
        return {
          where: () => {
            const result = mocks.updateReturning[0] ?? [{ id: "some-id" }];
            const promise = Promise.resolve(undefined) as Promise<unknown> & {
              returning: () => Promise<unknown[]>;
            };
            promise.returning = async () => result;
            return promise;
          },
        };
      },
    }),
  }),
}));

vi.mock("../../../../src/services/queue-service.js", () => ({
  enqueueContribution: mocks.enqueueContribution,
}));

vi.mock("../../../../src/services/bounty-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/bounty-service.js")>()),
  withdrawBounty: mocks.withdrawBounty,
}));

vi.mock("../../../../src/services/reputation-service.js", () => ({
  adjustReputation: mocks.adjustReputation,
  neutralizeReviewOutcome: mocks.neutralizeReviewOutcome,
  AUDIT_SUSPENSION_PREFIX: "audit:",
}));

import { executeAuditTool } from "../../../../src/llm/tools/audit-tools.js";

/** Route finding-existence checks and finding inserts. */
function primeFindings(opts: { exists?: boolean } = {}) {
  mocks.rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id FROM audit_findings")) {
      return opts.exists === false ? [] : [{ id: FINDING_ID }];
    }
    if (sql.includes("INSERT INTO audit_findings")) {
      return [{ id: FINDING_ID }];
    }
    if (sql.includes("UPDATE audit_findings")) {
      return [{ id: FINDING_ID }];
    }
    return [];
  });
}

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.updateSets.length = 0;
  mocks.updateReturning = [[{ id: "some-id" }]];
  mocks.enqueueContribution.mockClear();
  mocks.adjustReputation.mockClear();
  mocks.neutralizeReviewOutcome.mockClear();
  mocks.withdrawBounty.mockClear();
  primeFindings();
});

describe("withdraw_bounty_after_audit", () => {
  it("withdraws through the bounty service with the finding and the audit actor, before opening or with notice", async () => {
    const out = JSON.parse(
      await executeAuditTool(
        "withdraw_bounty_after_audit",
        { bounty_id: "b-1", reason: "the statement proves a weaker theorem than the claim", finding_id: FINDING_ID },
        { runId: RUN_ID }
      )
    );
    expect(out).toMatchObject({ success: true, bounty_id: "b-1", status: "withdrawn", effective_at: null });
    expect(out.message).toMatch(/before opening/);
    expect(mocks.withdrawBounty).toHaveBeenCalledWith({
      bountyId: "b-1",
      rationale: `audit finding ${FINDING_ID}: the statement proves a weaker theorem than the claim`,
      actor: `audit_agent:${RUN_ID}`,
    });

    mocks.withdrawBounty.mockResolvedValueOnce({ ok: true, status: "open", effective_at: "2026-10-04T00:00:00.000Z" } as never);
    const noticed = JSON.parse(
      await executeAuditTool("withdraw_bounty_after_audit", { bounty_id: "b-2", reason: "outside the mandate's bounds", finding_id: FINDING_ID }, {})
    );
    expect(noticed).toMatchObject({ success: true, status: "open", effective_at: "2026-10-04T00:00:00.000Z" });
    expect(noticed.message).toMatch(/with notice/);
  });

  it("requires a persisted finding and passes the service's refusal through", async () => {
    primeFindings({ exists: false });
    const out = await executeAuditTool("withdraw_bounty_after_audit", { bounty_id: "b-1", reason: "r", finding_id: FINDING_ID }, {});
    expect(out).toMatch(/requires the finding_id/);
    expect(mocks.withdrawBounty).not.toHaveBeenCalled();

    primeFindings();
    mocks.withdrawBounty.mockResolvedValueOnce({ ok: false, code: "BAD_STATE", message: "bounty is already paid" } as never);
    const refused = JSON.parse(await executeAuditTool("withdraw_bounty_after_audit", { bounty_id: "b-1", reason: "r", finding_id: FINDING_ID }, {}));
    expect(refused).toEqual({ success: false, code: "BAD_STATE", message: "bounty is already paid" });
  });
});

describe("flag_issue", () => {
  it("persists the finding with its run and typed targets, returning finding_id", async () => {
    const out = JSON.parse(
      await executeAuditTool(
        "flag_issue",
        {
          severity: "high",
          category: "decision_quality",
          description: "Reasoning contradicts the outcome",
          evidence: "The review cites V yet accepts an unsourced edit.",
          recommendation: "Re-review the contribution.",
          contribution_id: CONTRIBUTION_ID,
        },
        { runId: RUN_ID }
      )
    );

    expect(out.success).toBe(true);
    expect(out.finding_id).toBe(FINDING_ID);

    const insert = mocks.rawQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO audit_findings")
    );
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    expect(params[0]).toBe(RUN_ID);
    expect(params).toContain(CONTRIBUTION_ID);
  });
});

describe("consequences require a persisted finding", () => {
  it.each([
    [
      "recommend_re_review",
      { contribution_id: CONTRIBUTION_ID, finding_id: FINDING_ID, reason: "x" },
    ],
    [
      "adjust_contributor_reputation",
      { contributor_id: CONTRIBUTOR_ID, finding_id: FINDING_ID, delta: -5, reason: "x" },
    ],
    [
      "suspend_contributor",
      { contributor_id: CONTRIBUTOR_ID, finding_id: FINDING_ID, reason: "x" },
    ],
  ])("%s refuses when the finding does not exist", async (tool, input) => {
    primeFindings({ exists: false });
    const out = await executeAuditTool(tool as string, input as Record<string, unknown>);
    expect(out).toContain("Error");
    expect(out).toContain("flag_issue first");
    expect(mocks.adjustReputation).not.toHaveBeenCalled();
    expect(mocks.enqueueContribution).not.toHaveBeenCalled();
    expect(mocks.updateSets).toHaveLength(0);
  });
});

describe("recommend_re_review", () => {
  it("neutralizes the old decision, resets the contribution, and re-enqueues", async () => {
    const out = JSON.parse(
      await executeAuditTool("recommend_re_review", {
        contribution_id: CONTRIBUTION_ID,
        finding_id: FINDING_ID,
        reason: "The decision contradicts its reasoning.",
      })
    );

    expect(out.success).toBe(true);
    expect(mocks.neutralizeReviewOutcome).toHaveBeenCalledWith({
      contributionId: CONTRIBUTION_ID,
    });
    expect(mocks.updateSets[0]).toMatchObject({ reviewStatus: "pending" });
    expect(mocks.enqueueContribution).toHaveBeenCalledWith({
      contributionId: CONTRIBUTION_ID,
    });
    expect(out.neutralized).toMatchObject({ bad_faith_flag_cleared: true });
  });
});

describe("adjust_contributor_reputation", () => {
  it("routes through the reputation service, never a raw score UPDATE", async () => {
    const out = JSON.parse(
      await executeAuditTool("adjust_contributor_reputation", {
        contributor_id: CONTRIBUTOR_ID,
        finding_id: FINDING_ID,
        delta: -5,
        reason: "Pattern of unsourced edits.",
      })
    );

    expect(out.success).toBe(true);
    expect(out.new_score).toBe(45);
    expect(mocks.adjustReputation).toHaveBeenCalledWith({
      contributorId: CONTRIBUTOR_ID,
      delta: -5,
    });
    const rawContributorWrite = mocks.rawQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE contributors")
    );
    expect(rawContributorWrite).toBeUndefined();
  });
});

describe("suspend_contributor / unsuspend_contributor", () => {
  it("suspends with the audit:<finding_id> reason and a timestamp", async () => {
    const out = JSON.parse(
      await executeAuditTool("suspend_contributor", {
        contributor_id: CONTRIBUTOR_ID,
        finding_id: FINDING_ID,
        reason: "Coordinated sybil accounts.",
      })
    );

    expect(out.success).toBe(true);
    expect(mocks.updateSets[0]).toMatchObject({ isSuspended: true });
    expect(String(mocks.updateSets[0]!.suspensionReason)).toBe(
      `audit:${FINDING_ID} Coordinated sybil accounts.`
    );
    expect(mocks.updateSets[0]!.suspendedAt).toBeInstanceOf(Date);
  });

  it("reports not-found truthfully", async () => {
    mocks.updateReturning = [[]];
    const out = JSON.parse(
      await executeAuditTool("suspend_contributor", {
        contributor_id: CONTRIBUTOR_ID,
        finding_id: FINDING_ID,
        reason: "x",
      })
    );
    expect(out.success).toBe(false);
  });

  it("unsuspend clears reason and timestamp without needing a finding", async () => {
    const out = JSON.parse(
      await executeAuditTool("unsuspend_contributor", {
        contributor_id: CONTRIBUTOR_ID,
      })
    );
    expect(out.success).toBe(true);
    expect(mocks.updateSets[0]).toMatchObject({
      isSuspended: false,
      suspensionReason: null,
      suspendedAt: null,
    });
  });
});

describe("resolve_finding", () => {
  it("closes a finding with the resolution and note", async () => {
    const out = JSON.parse(
      await executeAuditTool("resolve_finding", {
        finding_id: FINDING_ID,
        resolution: "dismissed",
        note: "Re-examination shows consistent decisions.",
      })
    );
    expect(out.success).toBe(true);

    const update = mocks.rawQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("UPDATE audit_findings")
    );
    expect(update![1]).toEqual([
      "dismissed",
      "Re-examination shows consistent decisions.",
      FINDING_ID,
    ]);
  });
});
