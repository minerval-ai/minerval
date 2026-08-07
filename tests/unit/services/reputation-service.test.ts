import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture every rawQuery so the tests can assert on the SQL the service
// emits without a Postgres instance (matching the reviewer-tools pattern).
const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []),
  awardContributionOwls: vi.fn(async (input: { owls: number }) => input.owls),
  clawbackContributionOwls: vi.fn(async () => 0),
  refundChargeForContribution: vi.fn(async () => false),
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  getDb: () => {
    throw new Error("reputation-service must not use getDb");
  },
}));

vi.mock(
  "../../../src/services/contribution-award-service.js",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../../../src/services/contribution-award-service.js")
    >();
    return {
      ...original,
      awardContributionOwls: mocks.awardContributionOwls,
      clawbackContributionOwls: mocks.clawbackContributionOwls,
    };
  }
);
vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  refundChargeForContribution: mocks.refundChargeForContribution,
}));

// Awards are OFF by default at launch (contributionAwardOwlPerPoint 0);
// these tests exercise the award-on-accept wiring, so pin the reference
// rate the config documents for enabling.
vi.mock("../../../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config.js")>();
  return {
    ...original,
    loadConfig: () => ({
      ...original.loadConfig(),
      contributionAwardOwlPerPoint: 0.25,
    }),
  };
});

import {
  applyReviewOutcome,
  applyArbitrationOutcome,
  reverseReviewOutcome,
  neutralizeReviewOutcome,
  adjustReputation,
  clampScore,
  reputationDeltaFor,
  trustLevelFor,
  checkContributionRateLimit,
  resetContributionRateLimiter,
  REPUTATION_RULES,
  REPUTATION_REASONS,
  AUTO_SUSPENSION_PREFIX,
} from "../../../src/services/reputation-service.js";

const CONTRIBUTION_ID = "11111111-1111-1111-1111-111111111111";
const CONTRIBUTOR_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID = "33333333-3333-3333-3333-333333333333";

function primeContributor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    reputation_score: 50,
    bad_faith_flags: 0,
    contribution_standing: "good",
    is_suspended: false,
    suspension_reason: null,
    ...overrides,
  };
}

/** Route the mock by SQL shape: contribution join, contributor row, events. */
function routeQueries(opts: {
  contributor?: Record<string, unknown>;
  importance?: number;
  events?: Array<{ delta: number; reason: string }>;
  escalationReview?: boolean;
}) {
  mocks.rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM contribution_reviews")) {
      return opts.escalationReview ? [{ id: REVIEW_ID }] : [];
    }
    if (sql.includes("FROM contributions")) {
      return [
        {
          contributor_id: CONTRIBUTOR_ID,
          importance: opts.importance ?? 0.5,
        },
      ];
    }
    if (sql.includes("FROM contributors")) {
      return [primeContributor(opts.contributor)];
    }
    if (sql.includes("FROM reputation_events")) {
      return opts.events ?? [];
    }
    return [];
  });
}

function contributionQuery(): string {
  const call = mocks.rawQuery.mock.calls.find(([sql]) =>
    (sql as string).includes("FROM contributions")
  );
  expect(call).toBeDefined();
  return call![0] as string;
}

function updateCall(): { sql: string; params: unknown[] } {
  const call = mocks.rawQuery.mock.calls.find(([sql]) =>
    (sql as string).includes("UPDATE contributors")
  );
  expect(call).toBeDefined();
  return { sql: call![0] as string, params: call![1] as unknown[] };
}

function eventInserts(): unknown[][] {
  return mocks.rawQuery.mock.calls
    .filter(([sql]) => (sql as string).includes("INSERT INTO reputation_events"))
    .map(([, params]) => params as unknown[]);
}

beforeEach(() => {
  mocks.rawQuery.mockReset();
  mocks.awardContributionOwls
    .mockReset()
    .mockImplementation(async (input: { owls: number }) => input.owls);
  mocks.clawbackContributionOwls.mockReset().mockResolvedValue(0);
  mocks.refundChargeForContribution.mockReset().mockResolvedValue(false);
});

describe("reputation rules (pure)", () => {
  it("maps decisions to deltas", () => {
    expect(reputationDeltaFor("accept")).toBe(REPUTATION_RULES.accepted);
    expect(reputationDeltaFor("reject")).toBe(REPUTATION_RULES.rejected);
    expect(reputationDeltaFor("escalate")).toBe(0);
  });

  it("clamps to [0, 100]", () => {
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(104)).toBe(100);
    expect(clampScore(37)).toBe(37);
  });

  it("derives trust levels from score and suspension", () => {
    expect(trustLevelFor(90, false)).toBe("trusted");
    expect(trustLevelFor(50, false)).toBe("standard");
    expect(trustLevelFor(30, false)).toBe("probationary");
    expect(trustLevelFor(10, false)).toBe("restricted");
    expect(trustLevelFor(90, true)).toBe("suspended");
  });
});

describe("applyReviewOutcome", () => {
  it("accept: raises reputation, logs the event, awards importance-scaled owls", async () => {
    routeQueries({ importance: 1 });
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      reviewId: REVIEW_ID,
      decision: "accept",
    });

    expect(outcome).toMatchObject({
      contributorId: CONTRIBUTOR_ID,
      previousScore: 50,
      newScore: 50 + REPUTATION_RULES.accepted,
      standing: "good",
      suspended: false,
      owlsAwarded: 1.25, // importance 1 → 5 points × 0.25 owl
    });

    const { sql, params } = updateCall();
    expect(sql).toContain("contributions_accepted = contributions_accepted + 1");
    expect(params[0]).toBe(52);

    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.accepted);

    expect(mocks.awardContributionOwls).toHaveBeenCalledWith(
      expect.objectContaining({
        contributorId: CONTRIBUTOR_ID,
        owls: 1.25,
      })
    );
  });

  it("sincere reject: small penalty, no standing change, no award, charge refunded", async () => {
    routeQueries({});
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
    });

    expect(outcome!.newScore).toBe(50 + REPUTATION_RULES.rejected);
    expect(outcome!.standing).toBe("good");
    expect(mocks.awardContributionOwls).not.toHaveBeenCalled();
    // Good-faith submission is free: a rejection returns any proposal charge.
    expect(mocks.refundChargeForContribution).toHaveBeenCalledWith(
      CONTRIBUTION_ID
    );
    expect(eventInserts()).toHaveLength(1);
  });

  it("bad-faith reject: heavy penalty, must_pay standing, two ledger events", async () => {
    routeQueries({});
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
      suspectedBadFaith: true,
      badFaithCategory: "spam",
    });

    expect(outcome!.newScore).toBe(
      50 + REPUTATION_RULES.rejected + REPUTATION_RULES.badFaithFlag
    );
    expect(outcome!.standing).toBe("must_pay");
    expect(outcome!.suspended).toBe(false);

    const events = eventInserts();
    expect(events).toHaveLength(2);
    expect(events[0]).toContain(REPUTATION_REASONS.rejected);
    expect(events[1]).toContain(REPUTATION_REASONS.badFaith);
  });

  it("ignores the bad-faith flag on non-reject decisions", async () => {
    routeQueries({});
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "accept",
      suspectedBadFaith: true,
    });
    expect(outcome!.standing).toBe("good");
    expect(outcome!.newScore).toBe(50 + REPUTATION_RULES.accepted);
  });

  it("auto-suspends when the score falls below the threshold", async () => {
    routeQueries({
      contributor: primeContributor({
        reputation_score: 20,
        bad_faith_flags: 2,
        contribution_standing: "must_pay",
      }),
    });
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
      suspectedBadFaith: true,
    });

    expect(outcome!.newScore).toBe(4);
    expect(outcome!.suspended).toBe(true);
    const { params } = updateCall();
    // $4 = suspend flag, $5 = auto-suspension reason
    expect(params[3]).toBe(true);
    expect(String(params[4])).toContain(AUTO_SUSPENSION_PREFIX);
  });

  it("escalate: counter only, no reputation event, no award", async () => {
    routeQueries({});
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "escalate",
    });
    expect(outcome!.newScore).toBe(50);
    expect(eventInserts()).toHaveLength(0);
    expect(mocks.awardContributionOwls).not.toHaveBeenCalled();
    expect(updateCall().sql).toContain(
      "contributions_escalated = contributions_escalated + 1"
    );
  });

  it("returns null for an unknown contribution", async () => {
    mocks.rawQuery.mockResolvedValue([]);
    expect(
      await applyReviewOutcome({
        contributionId: CONTRIBUTION_ID,
        decision: "accept",
      })
    ).toBeNull();
  });

  // Intake contributions can carry no claim_id (#179): a rejected
  // propose_claim never materializes and propose_source never gets one, yet
  // reputation and the bad-faith defense (#157) must still apply.
  it("penalizes claim-less intake rejections: LEFT JOIN, full bad-faith consequences", async () => {
    routeQueries({ importance: 0 });
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
      suspectedBadFaith: true,
      badFaithCategory: "spam",
    });

    expect(outcome!.standing).toBe("must_pay");
    expect(outcome!.newScore).toBe(
      50 + REPUTATION_RULES.rejected + REPUTATION_RULES.badFaithFlag
    );
    expect(contributionQuery()).toContain("LEFT JOIN claims");
    expect(contributionQuery()).toContain("COALESCE(cl.importance, 0)");
  });

  it("credits a claim-less acceptance with the minimum award", async () => {
    routeQueries({ importance: 0 });
    const outcome = await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "accept",
    });
    expect(outcome!.newScore).toBe(50 + REPUTATION_RULES.accepted);
    expect(outcome!.owlsAwarded).toBe(0.25);
  });
});

describe("applyArbitrationOutcome (escalation resolution)", () => {
  it("accept: credits the acceptance, resolves the escalated counter, awards owls", async () => {
    routeQueries({ importance: 0.5, escalationReview: true });
    const outcome = await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "accept",
    });

    expect(outcome).toMatchObject({
      contributorId: CONTRIBUTOR_ID,
      previousScore: 50,
      newScore: 50 + REPUTATION_RULES.accepted,
      standing: "good",
      suspended: false,
      owlsAwarded: 0.75, // importance 0.5 → 3 points, no appeal bonus
    });

    const { sql } = updateCall();
    expect(sql).toContain(
      "contributions_escalated = GREATEST(0, contributions_escalated - 1)"
    );
    expect(sql).toContain("contributions_accepted = contributions_accepted + 1");

    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.accepted);
    expect(mocks.awardContributionOwls).toHaveBeenCalledWith(
      expect.objectContaining({ owls: 0.75 })
    );
  });

  it("reject: applies the ordinary rejection penalty", async () => {
    routeQueries({ escalationReview: true });
    const outcome = await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "reject",
    });

    expect(outcome!.newScore).toBe(50 + REPUTATION_RULES.rejected);
    expect(updateCall().sql).toContain(
      "contributions_rejected = contributions_rejected + 1"
    );
    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.rejected);
    expect(mocks.awardContributionOwls).not.toHaveBeenCalled();
  });

  it("reject with bad faith: two events, flag count, must-pay standing (#213)", async () => {
    routeQueries({ escalationReview: true });
    const outcome = await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "reject",
      suspectedBadFaith: true,
    });

    expect(outcome).toMatchObject({
      newScore:
        50 + REPUTATION_RULES.rejected + REPUTATION_RULES.badFaithFlag,
      standing: "must_pay",
      suspended: false,
    });

    const { sql, params } = updateCall();
    expect(sql).toContain("bad_faith_flags = bad_faith_flags + $3");
    expect(params[1]).toBe("must_pay");
    expect(params[2]).toBe(1);

    // The same rejection+flag event pair applyReviewOutcome writes, so
    // reverseReviewOutcome can undo an arbitrated flag on a later appeal.
    const events = eventInserts();
    expect(events).toHaveLength(2);
    expect(events[0]).toContain(REPUTATION_REASONS.rejected);
    expect(events[1]).toContain(REPUTATION_REASONS.badFaith);
    expect(mocks.awardContributionOwls).not.toHaveBeenCalled();
  });

  it("bad faith drives the auto-suspension check off the flagged score", async () => {
    routeQueries({
      contributor: primeContributor({ reputation_score: 20 }),
      escalationReview: true,
    });
    const outcome = await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "reject",
      suspectedBadFaith: true,
    });

    expect(outcome!.newScore).toBe(4);
    expect(outcome!.suspended).toBe(true);
    const { params } = updateCall();
    expect(params[4]).toContain(AUTO_SUSPENSION_PREFIX);
    expect(params[4]).toContain("suspected bad-faith contribution");
  });

  it("ignores the flag on an accepting resolution", async () => {
    routeQueries({ escalationReview: true });
    const outcome = await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "accept",
      suspectedBadFaith: true,
    });

    expect(outcome).toMatchObject({
      newScore: 50 + REPUTATION_RULES.accepted,
      standing: "good",
    });
    expect(eventInserts()).toHaveLength(1);
    expect(updateCall().params[2]).toBe(0);
  });

  it("no-ops when the review already applied an outcome", async () => {
    routeQueries({
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
      ],
    });
    expect(
      await applyArbitrationOutcome({
        contributionId: CONTRIBUTION_ID,
        finalDecision: "accept",
      })
    ).toBeNull();
    expect(eventInserts()).toHaveLength(0);
    expect(mocks.awardContributionOwls).not.toHaveBeenCalled();
  });

  it("is idempotent: a second resolution finds its own event and no-ops", async () => {
    routeQueries({
      events: [
        { delta: REPUTATION_RULES.accepted, reason: REPUTATION_REASONS.accepted },
      ],
    });
    expect(
      await applyArbitrationOutcome({
        contributionId: CONTRIBUTION_ID,
        finalDecision: "accept",
      })
    ).toBeNull();
  });

  it("skips the escalated-counter move when no escalate review was recorded", async () => {
    routeQueries({ escalationReview: false });
    await applyArbitrationOutcome({
      contributionId: CONTRIBUTION_ID,
      finalDecision: "accept",
    });
    expect(updateCall().sql).not.toContain("contributions_escalated");
  });
});

describe("reverseReviewOutcome (appeal overturn)", () => {
  it("compensates penalties, clears the flag, restores standing, lifts auto-suspension", async () => {
    routeQueries({
      importance: 0.5,
      contributor: primeContributor({
        reputation_score: 8,
        bad_faith_flags: 1,
        contribution_standing: "must_pay",
        is_suspended: true,
        suspension_reason: `${AUTO_SUSPENSION_PREFIX} score fell below 10`,
      }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: REPUTATION_RULES.badFaithFlag, reason: REPUTATION_REASONS.badFaith },
      ],
    });

    const result = await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID });

    // 8 - (-16) + 2 = 26
    expect(result).toMatchObject({
      previousScore: 8,
      newScore: 26,
      standingRestored: true,
      unsuspended: true,
    });
    expect(result!.owlsAwarded).toBe(1.25); // (3 + 2 bonus) points × 0.25

    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.overturned);

    expect(mocks.awardContributionOwls).toHaveBeenCalledWith(
      expect.objectContaining({ owls: 1.25 })
    );
  });

  it("keeps must_pay standing when other bad-faith flags remain", async () => {
    routeQueries({
      contributor: primeContributor({
        reputation_score: 20,
        bad_faith_flags: 2,
        contribution_standing: "must_pay",
      }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: REPUTATION_RULES.badFaithFlag, reason: REPUTATION_REASONS.badFaith },
      ],
    });

    const result = await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID });
    expect(result!.standingRestored).toBe(false);
  });

  it("does not lift a manual (non-reputation) suspension", async () => {
    routeQueries({
      contributor: primeContributor({
        reputation_score: 40,
        bad_faith_flags: 1,
        contribution_standing: "must_pay",
        is_suspended: true,
        suspension_reason: "manual: ToS violation",
      }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: REPUTATION_RULES.badFaithFlag, reason: REPUTATION_REASONS.badFaith },
      ],
    });

    const result = await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID });
    expect(result!.unsuspended).toBe(false);
  });

  it("reverses claim-less intake rejections (LEFT JOIN)", async () => {
    routeQueries({
      importance: 0,
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
      ],
    });
    const result = await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID });
    // 50 - (-1) + 2 = 53
    expect(result!.newScore).toBe(53);
    expect(result!.owlsAwarded).toBe(0.75); // (1 + 2 bonus) points × 0.25
    expect(contributionQuery()).toContain("LEFT JOIN claims");
  });

  it("is idempotent: a second overturn is a no-op", async () => {
    routeQueries({
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: 3, reason: REPUTATION_REASONS.overturned },
      ],
    });
    expect(
      await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID })
    ).toBeNull();
  });

  it("no-ops when the contribution was never penalized", async () => {
    routeQueries({
      events: [
        { delta: REPUTATION_RULES.accepted, reason: REPUTATION_REASONS.accepted },
      ],
    });
    expect(
      await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID })
    ).toBeNull();
  });
});

describe("neutralizeReviewOutcome (audit re-review, #180)", () => {
  /** Route the mock for the neutralization query shapes. */
  function routeNeutralize(opts: {
    reviewStatus?: string;
    review?: {
      id: string;
      decision: string;
      suspected_bad_faith: boolean;
    } | null;
    contributor?: Record<string, unknown>;
    events?: Array<{ delta: number; reason: string }>;
  }) {
    mocks.rawQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM contributions ")) {
        return [
          {
            contributor_id: CONTRIBUTOR_ID,
            review_status: opts.reviewStatus ?? "rejected",
          },
        ];
      }
      if (sql.includes("FROM contribution_reviews")) {
        return opts.review ? [opts.review] : [];
      }
      if (sql.includes("FROM contributors")) {
        return [primeContributor(opts.contributor)];
      }
      if (sql.includes("FROM reputation_events")) {
        return opts.events ?? [];
      }
      return [];
    });
  }

  function supersededMark(): unknown[] | undefined {
    const call = mocks.rawQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("SET superseded = true")
    );
    return call?.[1] as unknown[] | undefined;
  }

  it("bad-faith rejection: zeroes the ledger, decrements the counter, clears flag and standing", async () => {
    routeNeutralize({
      review: { id: REVIEW_ID, decision: "reject", suspected_bad_faith: true },
      contributor: primeContributor({
        reputation_score: 34,
        bad_faith_flags: 1,
        contribution_standing: "must_pay",
      }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: REPUTATION_RULES.badFaithFlag, reason: REPUTATION_REASONS.badFaith },
      ],
    });

    const result = await neutralizeReviewOutcome({
      contributionId: CONTRIBUTION_ID,
    });

    expect(result).toMatchObject({
      contributorId: CONTRIBUTOR_ID,
      supersededReviewId: REVIEW_ID,
      previousScore: 34,
      newScore: 50, // 34 - (-16)
      badFaithFlagCleared: true,
    });
    expect(supersededMark()).toEqual([CONTRIBUTION_ID]);

    const { sql, params } = updateCall();
    expect(sql).toContain(
      "contributions_rejected = GREATEST(0, contributions_rejected - 1)"
    );
    expect(params[0]).toBe(50);
    expect(params[1]).toBe(0); // remaining flags
    expect(params[2]).toBe("good"); // standing restored

    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.superseded);
    expect(events[0]).toContain(16); // -netDelta
  });

  it("accepted contribution: reverses the credit and claws back the owls", async () => {
    routeNeutralize({
      reviewStatus: "accepted",
      review: { id: REVIEW_ID, decision: "accept", suspected_bad_faith: false },
      contributor: primeContributor({ reputation_score: 52 }),
      events: [
        { delta: REPUTATION_RULES.accepted, reason: REPUTATION_REASONS.accepted },
      ],
    });
    mocks.clawbackContributionOwls.mockResolvedValue(1.25);

    const result = await neutralizeReviewOutcome({
      contributionId: CONTRIBUTION_ID,
    });

    expect(result!.newScore).toBe(50);
    expect(result!.owlsReversed).toBe(1.25);
    expect(updateCall().sql).toContain(
      "contributions_accepted = GREATEST(0, contributions_accepted - 1)"
    );
    expect(mocks.clawbackContributionOwls).toHaveBeenCalledWith({
      contributorId: CONTRIBUTOR_ID,
      contributionId: CONTRIBUTION_ID,
    });
  });

  it("after an overturn, the accepted counter holds the contribution and the flag is already gone", async () => {
    routeNeutralize({
      reviewStatus: "accepted",
      review: { id: REVIEW_ID, decision: "reject", suspected_bad_faith: true },
      contributor: primeContributor({ reputation_score: 52 }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
        { delta: REPUTATION_RULES.badFaithFlag, reason: REPUTATION_REASONS.badFaith },
        { delta: 18, reason: REPUTATION_REASONS.overturned },
      ],
    });

    const result = await neutralizeReviewOutcome({
      contributionId: CONTRIBUTION_ID,
    });

    // net = -1 - 15 + 18 = +2; the compensation removes it.
    expect(result!.newScore).toBe(50);
    expect(result!.badFaithFlagCleared).toBe(false);
    expect(updateCall().sql).toContain(
      "contributions_accepted = GREATEST(0, contributions_accepted - 1)"
    );
  });

  it("no live review → nothing to neutralize", async () => {
    routeNeutralize({ review: null });
    expect(
      await neutralizeReviewOutcome({ contributionId: CONTRIBUTION_ID })
    ).toBeNull();
  });

  it("an arbitrated escalation: the final disposition's counter is the one decremented", async () => {
    // Escalated review, then uphold_original resolved the escalated counter
    // into rejected (#179) — review_status, not the review's own decision,
    // says where the count sits now.
    routeNeutralize({
      reviewStatus: "rejected",
      review: { id: REVIEW_ID, decision: "escalate", suspected_bad_faith: false },
      contributor: primeContributor({ reputation_score: 49 }),
      events: [
        { delta: REPUTATION_RULES.rejected, reason: REPUTATION_REASONS.rejected },
      ],
    });

    const result = await neutralizeReviewOutcome({
      contributionId: CONTRIBUTION_ID,
    });

    expect(result!.newScore).toBe(50);
    expect(updateCall().sql).toContain(
      "contributions_rejected = GREATEST(0, contributions_rejected - 1)"
    );
  });
});

describe("adjustReputation (audit ledger, #180)", () => {
  function routeAdjust(contributor: Record<string, unknown> | null) {
    mocks.rawQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM contributors")) {
        return contributor ? [contributor] : [];
      }
      return [];
    });
  }

  it("writes the delta through the ledger with the audit reason", async () => {
    routeAdjust({ reputation_score: 50, is_suspended: false });
    const result = await adjustReputation({
      contributorId: CONTRIBUTOR_ID,
      delta: -5,
    });

    expect(result).toMatchObject({
      previousScore: 50,
      newScore: 45,
      suspended: false,
    });
    const events = eventInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(REPUTATION_REASONS.auditAdjustment);
    expect(events[0]).toContain(45); // score_after
  });

  it("auto-suspends below the threshold with the reputation: reason", async () => {
    routeAdjust({ reputation_score: 12, is_suspended: false });
    const result = await adjustReputation({
      contributorId: CONTRIBUTOR_ID,
      delta: -5,
    });

    expect(result!.suspended).toBe(true);
    const { params } = updateCall();
    expect(params[1]).toBe(true);
    expect(String(params[2])).toContain(AUTO_SUSPENSION_PREFIX);
  });

  it("raising a score never auto-unsuspends (lifting is a judgment)", async () => {
    routeAdjust({ reputation_score: 5, is_suspended: true });
    const result = await adjustReputation({
      contributorId: CONTRIBUTOR_ID,
      delta: 10,
    });

    expect(result!.suspended).toBe(true);
    const { sql } = updateCall();
    expect(sql).toContain("is_suspended = is_suspended OR");
  });

  it("clamps at the floor", async () => {
    routeAdjust({ reputation_score: 3, is_suspended: true });
    const result = await adjustReputation({
      contributorId: CONTRIBUTOR_ID,
      delta: -10,
    });
    expect(result!.newScore).toBe(0);
  });

  it("returns null for an unknown contributor", async () => {
    routeAdjust(null);
    expect(
      await adjustReputation({ contributorId: CONTRIBUTOR_ID, delta: -5 })
    ).toBeNull();
  });
});

describe("ledger derivability (property, #180)", () => {
  /**
   * The invariant that makes reputation_events load-bearing: at every point,
   * replaying the ledger from the initial score reproduces the stored score.
   * Runs the full lifecycle — review, audit re-review, second review, appeal
   * overturn, second re-review, final review — against a minimal fake DB
   * that only stores what the service writes.
   */
  it("replaying events reproduces the score across review → re-review → overturn cycles", async () => {
    const INITIAL = 50;
    let score = INITIAL;
    let liveReview: {
      id: string;
      decision: string;
      suspected_bad_faith: boolean;
    } | null = null;
    let reviewStatus = "pending";
    const ledger: Array<{ delta: number; reason: string }> = [];

    mocks.rawQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM contributions ") || sql.includes("FROM contributions\n")) {
          return [
            {
              contributor_id: CONTRIBUTOR_ID,
              importance: 0.5,
              review_status: reviewStatus,
            },
          ];
        }
        if (sql.includes("FROM contribution_reviews")) {
          return liveReview ? [liveReview] : [];
        }
        if (sql.includes("SET superseded = true")) {
          liveReview = null;
          return [];
        }
        if (sql.includes("FROM contributors")) {
          return [primeContributor({ reputation_score: score })];
        }
        if (sql.includes("UPDATE contributors")) {
          // Every score-bearing UPDATE contributors shape writes it as $1.
          score = params![0] as number;
          return [];
        }
        if (sql.includes("INSERT INTO reputation_events")) {
          // The three insert shapes inline NULLs differently, so the delta
          // and reason sit at arity-dependent positions: 6 params (apply,
          // neutralize), 5 (reverse: review_id literal NULL), 4 (adjust:
          // contribution_id and review_id literal NULL).
          const arity = params!.length;
          const deltaIndex = arity === 6 ? 3 : arity === 5 ? 2 : 1;
          ledger.push({
            delta: params![deltaIndex] as number,
            reason: params![arity - 1] as string,
          });
          return [];
        }
        if (sql.includes("FROM reputation_events")) {
          return [...ledger];
        }
        return [];
      }
    );

    const replay = () =>
      ledger.reduce((s, e) => clampScore(s + e.delta), INITIAL);
    const assertDerivable = () => expect(replay()).toBe(score);

    // 1. Reviewer rejects with a bad-faith flag.
    await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
      suspectedBadFaith: true,
    });
    liveReview = { id: "r1", decision: "reject", suspected_bad_faith: true };
    reviewStatus = "rejected";
    assertDerivable();
    expect(score).toBe(34);

    // 2. Audit sends it back; neutralization zeroes the net effect.
    await neutralizeReviewOutcome({ contributionId: CONTRIBUTION_ID });
    assertDerivable();
    expect(score).toBe(INITIAL);

    // 3. Fresh review rejects without the flag.
    await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
    });
    liveReview = { id: "r2", decision: "reject", suspected_bad_faith: false };
    reviewStatus = "rejected";
    assertDerivable();
    expect(score).toBe(49);

    // 4. The contributor appeals; arbitration overturns. Only the live
    //    segment's penalty reverses — the superseded flag must not be
    //    reversed a second time.
    await reverseReviewOutcome({ contributionId: CONTRIBUTION_ID });
    reviewStatus = "accepted";
    assertDerivable();
    expect(score).toBe(52); // 49 + 1 + accepted credit 2

    // 5. Audit sends it back again (accepted counter holds it now).
    await neutralizeReviewOutcome({ contributionId: CONTRIBUTION_ID });
    assertDerivable();
    expect(score).toBe(INITIAL);

    // 6. Final review accepts.
    await applyReviewOutcome({
      contributionId: CONTRIBUTION_ID,
      decision: "accept",
    });
    assertDerivable();
    expect(score).toBe(52);

    // Audit adjustments live in the same ledger.
    await adjustReputation({ contributorId: CONTRIBUTOR_ID, delta: -3 });
    assertDerivable();
    expect(score).toBe(49);
  });
});

describe("contribution rate limit (sybil sandbox)", () => {
  beforeEach(() => resetContributionRateLimiter());

  const DAY = 24 * 3_600_000;

  it("sandboxes brand-new accounts at the tighter limit (default 3/h)", () => {
    const fresh = {
      id: "new-1",
      reputationScore: 50,
      createdAt: new Date(),
    };
    for (let i = 0; i < 3; i++) {
      expect(checkContributionRateLimit(fresh).limited).toBe(false);
    }
    const fourth = checkContributionRateLimit(fresh);
    expect(fourth.limited).toBe(true);
    expect(fourth.sandboxed).toBe(true);
    expect(fourth.limitPerHour).toBe(3);
  });

  it("sandboxes low-reputation accounts regardless of age", () => {
    const lowRep = {
      id: "low-1",
      reputationScore: 30,
      createdAt: new Date(Date.now() - 30 * DAY),
    };
    expect(checkContributionRateLimit(lowRep).sandboxed).toBe(true);
    expect(checkContributionRateLimit(lowRep).limitPerHour).toBe(3);
  });

  it("gives established accounts the standard limit (default 10/h)", () => {
    const established = {
      id: "est-1",
      reputationScore: 60,
      createdAt: new Date(Date.now() - 30 * DAY),
    };
    for (let i = 0; i < 10; i++) {
      expect(checkContributionRateLimit(established).limited).toBe(false);
    }
    const eleventh = checkContributionRateLimit(established);
    expect(eleventh.limited).toBe(true);
    expect(eleventh.sandboxed).toBe(false);
  });

  it("tracks windows per contributor", () => {
    const a = { id: "a", reputationScore: 30, createdAt: new Date() };
    const b = { id: "b", reputationScore: 30, createdAt: new Date() };
    for (let i = 0; i < 3; i++) checkContributionRateLimit(a);
    expect(checkContributionRateLimit(a).limited).toBe(true);
    expect(checkContributionRateLimit(b).limited).toBe(false);
  });
});
