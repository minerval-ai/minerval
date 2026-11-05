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
      limit: (n: number) => {
        const page = Promise.resolve(rows.slice(0, n)) as Promise<unknown> & {
          offset: (o: number) => Promise<unknown>;
        };
        page.offset = (o: number) => Promise.resolve(rows.slice(o, o + n));
        return page;
      },
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

import {
  executeGovernanceTool,
  getClaimContextToolDefinitions,
} from "../../../../src/llm/tools/governance-tools.js";
import { rawQuery } from "../../../../src/db/client.js";
import { MANDATE_LABEL } from "../../../../src/services/contribution-service.js";

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
  vi.mocked(rawQuery).mockReset();
  vi.mocked(rawQuery).mockImplementation(async () => []);
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

// Audit reaches a decision through get_recent_decisions and must be able to
// load the contribution behind it (#495).
describe("decision → contribution link", () => {
  it("get_recent_decisions rows carry contribution_id", async () => {
    mocks.rows.contribution_reviews = [
      {
        reviewId: REVIEW_ID,
        contributionId: CONTRIBUTION_ID,
        decision: "accept",
        reasoning: "Sound edit.",
        confidence: 0.72,
        policyCitations: [],
        reviewedAt: new Date("2026-07-02T00:00:00Z"),
        contributionType: "propose_edit",
        contributorId: CONTRIBUTOR_ID,
        claimId: null,
      },
    ];

    const out = JSON.parse(
      await executeGovernanceTool("get_recent_decisions", {
        claim_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      })
    );

    expect(out.decisions[0]).toMatchObject({
      review_id: REVIEW_ID,
      contribution_id: CONTRIBUTION_ID,
    });
  });

  it("get_recent_decisions carries the bad-faith flag and says when another page exists", async () => {
    const row = (i: number) => ({
      reviewId: `r${i}`,
      contributionId: CONTRIBUTION_ID,
      decision: "reject",
      reasoning: "Spam.",
      confidence: 0.9,
      policyCitations: ["§13"],
      suspectedBadFaith: true,
      badFaithCategory: "spam",
      reviewedAt: new Date("2026-07-02T00:00:00Z"),
      contributionType: "challenge",
      contributorId: CONTRIBUTOR_ID,
      claimId: null,
    });
    mocks.rows.contribution_reviews = [row(1), row(2), row(3)];

    const out = JSON.parse(
      await executeGovernanceTool("get_recent_decisions", {
        limit: 2,
        since: "2026-07-01T00:00:00Z",
        bad_faith_only: true,
      })
    );
    expect(out.decisions).toHaveLength(2);
    expect(out.decisions[0]).toMatchObject({ suspected_bad_faith: true, bad_faith_category: "spam" });
    expect(out.has_more).toBe(true);
    expect(out.offset).toBe(0);
  });

  it("get_recent_decisions refuses an unparseable since", async () => {
    const out = JSON.parse(
      await executeGovernanceTool("get_recent_decisions", { since: "last tuesday" })
    );
    expect(out.error).toMatch(/not an ISO 8601 time/);
  });

  it("get_contribution_details accepts a review_id", async () => {
    mocks.rows.contributions = [baseContribution()];
    mocks.rows.contribution_reviews = [
      {
        id: REVIEW_ID,
        contributionId: CONTRIBUTION_ID,
        decision: "accept",
        reasoning: "Sound edit.",
        confidence: 0.72,
        policyCitations: [],
        reviewedAt: new Date("2026-07-02T00:00:00Z"),
      },
    ];

    const out = JSON.parse(
      await executeGovernanceTool("get_contribution_details", {
        review_id: REVIEW_ID,
      })
    );

    expect(out.contribution.id).toBe(CONTRIBUTION_ID);
    expect(out.contribution.content).toBe("The cited study was retracted.");
    expect(out.existing_review).toMatchObject({ id: REVIEW_ID, decision: "accept" });
  });

  it("reports an unknown review_id, and a call with neither key", async () => {
    const missing = JSON.parse(
      await executeGovernanceTool("get_contribution_details", {
        review_id: REVIEW_ID,
      })
    );
    expect(missing.error).toBe(`Review not found: ${REVIEW_ID}`);

    const neither = JSON.parse(
      await executeGovernanceTool("get_contribution_details", {})
    );
    expect(neither.error).toBe("Pass contribution_id or review_id");
  });
});

// Who filed a contribution, without their standing beside the merits
// (#702), and a mandate's contribution shown as the mandate (#705).
describe("who filed it", () => {
  const ADA = {
    id: CONTRIBUTOR_ID,
    displayName: "Ada",
    reputationScore: 50,
    contributionsAccepted: 3,
    contributionsRejected: 1,
    contributionsEscalated: 0,
    isVerified: false,
    isSuspended: false,
    owlsEarnedMicroUsd: 0,
    lastActiveAt: new Date("2026-07-01T00:00:00Z"),
  };

  it("names the contributor and leaves reputation to the profile", async () => {
    mocks.rows.contributions = [baseContribution()];
    mocks.rows.contributors = [ADA];
    const out = JSON.parse(
      await executeGovernanceTool("get_contribution_details", { contribution_id: CONTRIBUTION_ID })
    );
    expect(out.filed_by).toBe("Ada");
    expect(out.contributor).toEqual({ id: CONTRIBUTOR_ID, display_name: "Ada" });
  });

  it("shows a mandate's contribution as the mandate, with no account behind it", async () => {
    mocks.rows.contributions = [baseContribution({ grantId: "99999999-9999-9999-9999-999999999999" })];
    mocks.rows.contributors = [ADA];
    const out = JSON.parse(
      await executeGovernanceTool("get_contribution_details", { contribution_id: CONTRIBUTION_ID })
    );
    expect(out.filed_by).toBe(MANDATE_LABEL);
    expect(out.contributor).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Ada");

    const profile = JSON.parse(
      await executeGovernanceTool("get_contributor_profile", { contribution_id: CONTRIBUTION_ID })
    );
    expect(profile.profile).toBeNull();
    expect(profile.filed_by).toBe(MANDATE_LABEL);
  });

  it("profile counts the appeals a contributor has filed", async () => {
    mocks.rows.contributors = [ADA];
    vi.mocked(rawQuery).mockImplementation(async (sql: string) =>
      sql.includes("FROM appeals") ? ([{ n: 2 }] as never) : ([] as never)
    );
    const out = JSON.parse(
      await executeGovernanceTool("get_contributor_profile", { contributor_id: CONTRIBUTOR_ID })
    );
    expect(out.appeals_filed).toBe(2);
    expect(out.reputation_score).toBe(50);
  });
});

describe("get_review_history", () => {
  const CLAIM = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    contribution_type: "challenge",
    claim_id: CLAIM,
    content: "The same objection as before.",
    evidence_urls: [],
    review_status: "rejected",
    submitted_at: new Date("2026-06-01T00:00:00Z"),
    same_filer: false,
    decision: "reject",
    decision_reasoning: "Answered: the study was replicated.",
    appeals: [{ status: "resolved", reasoning: "I disagree." }],
    arbitrations: [{ outcome: "uphold_original", decision: "Stands." }],
    ...overrides,
  });

  it("lists the claim's other contributions and the filer's, with decisions and appeals", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(rawQuery).mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("SELECT claim_id, contributor_id, grant_id")) {
        return [{ claim_id: CLAIM, contributor_id: CONTRIBUTOR_ID, grant_id: null }] as never;
      }
      if (sql.includes("c.claim_id = $3")) return [row("11111111-1111-1111-1111-111111111111")] as never;
      return [row("22222222-2222-2222-2222-222222222222", { same_filer: true, content: "y".repeat(2000) })] as never;
    });
    const out = JSON.parse(
      await executeGovernanceTool("get_review_history", { contribution_id: CONTRIBUTION_ID })
    );
    expect(out.on_same_target[0]).toMatchObject({
      decision_in_force: { decision: "reject", reasoning: "Answered: the study was replicated." },
      appeals: [{ status: "resolved" }],
      arbitrations: [{ outcome: "uphold_original" }],
    });
    expect(out.from_same_filer[0].content).toMatch(/first 1500 of 2000 characters/);
    // Decided contributions only by default.
    expect(calls[1]!.sql).toContain("NOT IN ('pending', 'escalated')");
    // A personal filer's history leaves out what a mandate filed under the account.
    expect(calls[2]!.sql).toContain("c.grant_id IS NULL");
  });

  it("keys a mandate's history on the mandate, and includes pending on request", async () => {
    const GRANT = "99999999-9999-9999-9999-999999999999";
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(rawQuery).mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes("SELECT claim_id, contributor_id, grant_id")) {
        return [{ claim_id: null, contributor_id: CONTRIBUTOR_ID, grant_id: GRANT }] as never;
      }
      return [] as never;
    });
    const out = JSON.parse(
      await executeGovernanceTool("get_review_history", {
        contribution_id: CONTRIBUTION_ID,
        include_pending: true,
      })
    );
    expect(out.filed_by).toBe(MANDATE_LABEL);
    expect(typeof out.on_same_target).toBe("string");
    expect(calls[1]!.sql).toContain("c.grant_id = $2");
    expect(calls[1]!.params[1]).toBe(GRANT);
    expect(calls[1]!.sql).not.toContain("NOT IN ('pending'");
  });
});

describe("claim-context set", () => {
  // The Steward is handed contributions by id (#697) and can read them.
  it("includes get_contribution_details but not the contributor or history tools", () => {
    const names = getClaimContextToolDefinitions().map((t) => t.name);
    expect(names).toContain("get_contribution_details");
    expect(names).not.toContain("get_contributor_profile");
    expect(names).not.toContain("get_review_history");
  });
});
