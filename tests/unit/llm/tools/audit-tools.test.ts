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
const CLAIM_ID = "a5a5a5a5-5555-4555-8555-555555555555";

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  updateSets: [] as Array<Record<string, unknown>>,
  updateReturning: [[{ id: "some-id" }]] as unknown[][],
  enqueueContribution: vi.fn(async () => {}),
  enqueueSteward: vi.fn(async (_m: Record<string, unknown>) => {}),
  requestCuration: vi.fn(async (_i: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    ok: true,
    requestId: "req-1",
    actionId: "act-1",
    repeat: false,
  })),
  getClaimById: vi.fn(async (id: string): Promise<Record<string, unknown> | null> => ({
    id,
    createdBy: "u",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })),
  getAssessmentHistory: vi.fn(async () => ({ assessments: [] as unknown[], total: 0 })),
  getClaimEvents: vi.fn(async () => ({ events: [] as unknown[], total: 0 })),
  contribution: { contribution_type: "challenge" } as Record<string, unknown> | null,
  contributor: { is_suspended: true, suspension_reason: null } as Record<string, unknown> | null,
  claim: { id: "x", state: "active" } as Record<string, unknown> | null,
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
  enqueueSteward: mocks.enqueueSteward,
}));

vi.mock("../../../../src/services/curation-service.js", () => ({
  requestCuration: mocks.requestCuration,
}));

vi.mock("../../../../src/services/claim-service.js", () => ({
  getClaimById: mocks.getClaimById,
}));

vi.mock("../../../../src/services/assessment-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/assessment-service.js")>()),
  getAssessmentHistory: mocks.getAssessmentHistory,
}));

vi.mock("../../../../src/services/claim-events-service.js", () => ({
  getClaimEvents: mocks.getClaimEvents,
}));

vi.mock("../../../../src/services/bounty-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/services/bounty-service.js")>()),
  withdrawBounty: mocks.withdrawBounty,
}));

vi.mock("../../../../src/services/reputation-service.js", () => ({
  adjustReputation: mocks.adjustReputation,
  neutralizeReviewOutcome: mocks.neutralizeReviewOutcome,
  AUDIT_SUSPENSION_PREFIX: "audit:",
  REPUTATION_RULES: {
    min: 0,
    max: 100,
    accepted: 2,
    rejected: -1,
    escalated: 0,
    badFaithFlag: -15,
    suspendBelow: 10,
  },
}));

import { executeAuditTool, getAuditToolDefinitions } from "../../../../src/llm/tools/audit-tools.js";

/** Route finding-existence checks and finding inserts. */
function primeFindings(opts: { exists?: boolean } = {}) {
  mocks.rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM audit_findings WHERE id")) {
      return opts.exists === false
        ? []
        : [{
            id: FINDING_ID,
            severity: "high",
            category: "decision_quality",
            description: "The verdict outruns its reasoning.",
            evidence: "The trace cites one preprint.",
          }];
    }
    if (sql.includes("SELECT contribution_type FROM contributions")) {
      return mocks.contribution ? [mocks.contribution] : [];
    }
    if (sql.includes("SELECT is_suspended, suspension_reason FROM contributors")) {
      return mocks.contributor ? [mocks.contributor] : [];
    }
    if (sql.includes("SELECT id, state FROM claims")) {
      return mocks.claim ? [mocks.claim] : [];
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
  mocks.enqueueSteward.mockClear();
  mocks.requestCuration.mockClear();
  mocks.getClaimById.mockClear();
  mocks.getAssessmentHistory.mockClear();
  mocks.getClaimEvents.mockClear();
  mocks.contribution = { contribution_type: "challenge" };
  mocks.contributor = { is_suspended: true, suspension_reason: null };
  mocks.claim = { id: "x", state: "active" };
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

describe("triage_report", () => {
  it("refuses a note over the limit with a message naming it, recording nothing", async () => {
    const result = JSON.parse(
      await executeAuditTool("triage_report", {
        report_id: "11111111-1111-4111-8111-111111111111",
        status: "triaged",
        note: "x".repeat(4001),
      })
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/limit is 4000/);
    expect(
      mocks.rawQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE agent_reports"))
    ).toBe(false);
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
    [
      "recommend_reassessment",
      { claim_id: CLAIM_ID, finding_id: FINDING_ID, reason: "x" },
    ],
    [
      "recommend_recuration",
      { claim_id: CLAIM_ID, finding_id: FINDING_ID, reason: "x" },
    ],
  ])("%s refuses when the finding does not exist", async (tool, input) => {
    primeFindings({ exists: false });
    const out = await executeAuditTool(tool as string, input as Record<string, unknown>);
    expect(out).toContain("Error");
    expect(out).toContain("flag_issue first");
    expect(mocks.adjustReputation).not.toHaveBeenCalled();
    expect(mocks.enqueueContribution).not.toHaveBeenCalled();
    expect(mocks.enqueueSteward).not.toHaveBeenCalled();
    expect(mocks.requestCuration).not.toHaveBeenCalled();
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
    expect(mocks.updateSets[0]).toMatchObject({
      reviewStatus: "pending",
      reviewClaimedAt: null,
      reviewAttempts: 0,
    });
    expect(mocks.enqueueContribution).toHaveBeenCalledWith({
      contributionId: CONTRIBUTION_ID,
    });
    expect(out.neutralized).toMatchObject({ bad_faith_flag_cleared: true });
  });

  it("refuses a prize claim before undoing anything, pointing at the prize send-back", async () => {
    mocks.contribution = { contribution_type: "claim_prize" };
    const out = JSON.parse(
      await executeAuditTool("recommend_re_review", {
        contribution_id: CONTRIBUTION_ID,
        finding_id: FINDING_ID,
        reason: "x",
      })
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/record_prize_audit_outcome/);
    expect(mocks.neutralizeReviewOutcome).not.toHaveBeenCalled();
    expect(mocks.enqueueContribution).not.toHaveBeenCalled();
    expect(mocks.updateSets).toHaveLength(0);
  });
});

describe("recommend_reassessment", () => {
  it("queues the Steward with audit_send_back and the finding in its own words", async () => {
    const out = JSON.parse(
      await executeAuditTool("recommend_reassessment", {
        claim_id: CLAIM_ID,
        finding_id: FINDING_ID,
        reason: "Weigh the replication failures the trace skipped.",
      })
    );
    expect(out.success).toBe(true);
    expect(mocks.enqueueSteward).toHaveBeenCalledTimes(1);
    const msg = mocks.enqueueSteward.mock.calls[0]![0] as { claimId: string; trigger: string; context: string };
    expect(msg.claimId).toBe(CLAIM_ID);
    expect(msg.trigger).toBe("audit_send_back");
    expect(msg.context).toContain(FINDING_ID);
    expect(msg.context).toContain("The verdict outruns its reasoning.");
    expect(msg.context).toContain("The trace cites one preprint.");
    expect(msg.context).toContain("Weigh the replication failures");
  });

  it("refuses a claim no Steward runs on", async () => {
    mocks.claim = { id: CLAIM_ID, state: "merged" };
    const out = JSON.parse(
      await executeAuditTool("recommend_reassessment", { claim_id: CLAIM_ID, finding_id: FINDING_ID, reason: "x" })
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/merged/);
    expect(mocks.enqueueSteward).not.toHaveBeenCalled();
  });
});

describe("recommend_recuration", () => {
  it("opens a curation request carrying the finding", async () => {
    const out = JSON.parse(
      await executeAuditTool("recommend_recuration", {
        claim_id: CLAIM_ID,
        other_claim_id: CONTRIBUTION_ID,
        finding_id: FINDING_ID,
        reason: "These were merged but say different things.",
      })
    );
    expect(out.success).toBe(true);
    const req = mocks.requestCuration.mock.calls[0]![0] as Record<string, unknown>;
    expect(req).toMatchObject({ anchorClaimId: CLAIM_ID, otherClaimId: CONTRIBUTION_ID, source: "audit" });
    expect(String(req.concern)).toContain(`Audit finding ${FINDING_ID}`);
    expect(String(req.concern)).toContain("merged but say different things");
  });

  it("passes the service's refusal through", async () => {
    mocks.requestCuration.mockResolvedValueOnce({ ok: false, problem: "claim x is not an active claim" });
    const out = JSON.parse(
      await executeAuditTool("recommend_recuration", { claim_id: CLAIM_ID, finding_id: FINDING_ID, reason: "x" })
    );
    expect(out).toEqual({ success: false, message: "claim x is not an active claim" });
  });
});

describe("reading other decisions", () => {
  it("get_assessment_history and get_claim_events read through the shared services", async () => {
    mocks.getAssessmentHistory.mockResolvedValueOnce({
      assessments: [
        {
          id: "as1",
          claimId: CLAIM_ID,
          status: "supported",
          confidence: 0.7,
          claimCredence: null,
          summary: null,
          reasoningTrace: "Because.",
          isCurrent: true,
          subclaimSummary: null,
          trigger: "staleness_check",
          triggerContext: null,
          assessedAt: new Date("2026-08-01T00:00:00Z"),
          model: "m",
        },
      ],
      total: 3,
    });
    const hist = JSON.parse(
      await executeAuditTool("get_assessment_history", { claim_id: CLAIM_ID, limit: 1 })
    );
    expect(hist.assessments[0]).toMatchObject({ id: "as1", reasoning_trace: "Because.", summary: "Because." });
    expect(hist.has_more).toBe(true);
    expect(mocks.getAssessmentHistory).toHaveBeenCalledWith(CLAIM_ID, { limit: 1, offset: 0 });

    const events = JSON.parse(await executeAuditTool("get_claim_events", { claim_id: CLAIM_ID }));
    expect(events).toMatchObject({ events: [], total: 0, has_more: false });
    expect(mocks.getClaimEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: CLAIM_ID }),
      { limit: 50, offset: 0 }
    );
  });

  it("reports an unknown claim", async () => {
    mocks.getClaimById.mockResolvedValueOnce(null);
    const out = JSON.parse(await executeAuditTool("get_claim_events", { claim_id: CLAIM_ID }));
    expect(out.success).toBe(false);
  });

  it("get_recent_arbitrations filters, pages, and carries the bad-faith finding", async () => {
    mocks.rawQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM arbitration_results")) {
        return [1, 2].map((i) => ({
          id: `arb${i}`,
          contribution_id: CONTRIBUTION_ID,
          appeal_id: null,
          outcome: "uphold_original",
          decision: "Upheld.",
          reasoning: "Spam.",
          suspected_bad_faith: true,
          bad_faith_category: "spam",
          human_review_recommended: false,
          arbitrated_at: new Date("2026-08-01T00:00:00Z"),
          contribution_type: "challenge",
          contributor_id: CONTRIBUTOR_ID,
          claim_id: CLAIM_ID,
        }));
      }
      return [];
    });
    const out = JSON.parse(
      await executeAuditTool("get_recent_arbitrations", {
        bad_faith_only: true,
        outcome: "uphold_original",
        since: "2026-07-01T00:00:00Z",
        limit: 1,
      })
    );
    expect(out.arbitrations).toHaveLength(1);
    expect(out.arbitrations[0]).toMatchObject({ suspected_bad_faith: true, bad_faith_category: "spam" });
    expect(out.has_more).toBe(true);
    const [sql, params] = mocks.rawQuery.mock.calls.find(([q]) => String(q).includes("arbitration_results"))!;
    expect(String(sql)).toContain("a.suspected_bad_faith = true");
    expect(params).toEqual(["uphold_original", new Date("2026-07-01T00:00:00Z"), 2, 0]);
  });
});

describe("adjust_contributor_reputation's scale", () => {
  it("states the 0-100 scale and the automatic suspension threshold", () => {
    const tool = getAuditToolDefinitions().find((t) => t.name === "adjust_contributor_reputation")!;
    const delta = (tool.input_schema.properties as Record<string, { description: string }>).delta!.description;
    expect(delta).toContain("0-100");
    expect(delta).toContain("below 10 suspends");
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

  it("unsuspend requires a reason", async () => {
    const out = JSON.parse(
      await executeAuditTool("unsuspend_contributor", { contributor_id: CONTRIBUTOR_ID })
    );
    expect(out.success).toBe(false);
    expect(mocks.updateSets).toHaveLength(0);
  });

  it("unsuspend with no finding records the lift as a resolved finding", async () => {
    const out = JSON.parse(
      await executeAuditTool(
        "unsuspend_contributor",
        { contributor_id: CONTRIBUTOR_ID, reason: "The basis was a misread record." },
        { runId: RUN_ID }
      )
    );
    expect(out.success).toBe(true);
    expect(mocks.updateSets[0]).toMatchObject({
      isSuspended: false,
      suspensionReason: null,
      suspendedAt: null,
    });
    expect(out.recorded_finding_id).toBe(FINDING_ID);
    const insert = mocks.rawQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO audit_findings"));
    expect(insert![1]).toContain("The basis was a misread record.");
    expect(insert![1]).toContain(CONTRIBUTOR_ID);
  });

  it("unsuspend resolves the audit suspension's finding with the reason", async () => {
    mocks.contributor = { is_suspended: true, suspension_reason: `audit:${FINDING_ID} sybil ring` };
    const out = JSON.parse(
      await executeAuditTool("unsuspend_contributor", { contributor_id: CONTRIBUTOR_ID, reason: "Accounts proven distinct." })
    );
    expect(out.resolved_finding_ids).toEqual([FINDING_ID]);
    expect(out).not.toHaveProperty("recorded_finding_id");
    const update = mocks.rawQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE audit_findings"));
    expect(update![1]).toEqual(["Suspension lifted by audit: Accounts proven distinct.", FINDING_ID]);
  });

  it("unsuspend refuses a contributor who is not suspended", async () => {
    mocks.contributor = { is_suspended: false, suspension_reason: null };
    const out = JSON.parse(
      await executeAuditTool("unsuspend_contributor", { contributor_id: CONTRIBUTOR_ID, reason: "x" })
    );
    expect(out.success).toBe(false);
    expect(mocks.updateSets).toHaveLength(0);
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
