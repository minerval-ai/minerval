/**
 * Contribution service -- DB operations for contributions, reviews, appeals.
 */
import { eq, sql, desc, inArray } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { enqueueContribution } from "./queue-service.js";
import {
  contributions,
  contributionReviews,
  appeals,
  arbitrationResults,
  contributors,
  type NewContribution,
} from "../db/schema.js";

/**
 * A contribution submitted by research a mandate funds (Part VIII): filed
 * under the mandate's funder account but shown as "a funded mandate", its
 * review metered to the mandate's budget job, and queued for review like
 * anyone's. Refusals come back as a message the researcher can act on.
 */
export async function submitMandateContribution(input: {
  grantId: string;
  jobId: string | null;
  input: Record<string, unknown>;
}): Promise<{ success: boolean; message: string; contribution_id?: string }> {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const claimId = text(input.input.claim_id);
  const type = text(input.input.contribution_type);
  const content = text(input.input.content);
  const allowed = ["challenge", "support", "add_instance", "add_estimate", "propose_argument", "propose_answer", "propose_request", "answer_request"];
  if (!allowed.includes(type)) return { success: false, message: `contribution_type must be one of ${allowed.join(", ")}.` };
  if (content.length < 40) return { success: false, message: "content must say what you found and what it rests on." };
  const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id::text = $1 AND state = 'active'`, [claimId]);
  if (!node) return { success: false, message: `No active node ${claimId}.` };
  const [grant] = await rawQuery<{ funder_user_id: string }>(`SELECT funder_user_id FROM grants WHERE id = $1`, [input.grantId]);
  if (!grant) return { success: false, message: "The mandate behind this run no longer exists." };
  const urls = Array.isArray(input.input.evidence_urls)
    ? input.input.evidence_urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20)
    : [];
  const contribution = await createContribution({
    claimId,
    contributorId: grant.funder_user_id,
    contributionType: type,
    content: content.slice(0, 10_000),
    evidenceUrls: urls,
    grantId: input.grantId,
    fundedByJobId: input.jobId,
  });
  await enqueueContribution({ contributionId: contribution.id });
  return {
    success: true,
    message: `Contribution ${contribution.id} submitted for review under the mandate.`,
    contribution_id: contribution.id,
  };
}

/** How a contribution from a mandate's research is shown: the arrangement, not the funder. */
export const MANDATE_LABEL = "a funded mandate";

export async function createContribution(input: {
  claimId: string;
  contributorId: string;
  contributionType: string;
  content: string;
  evidenceUrls?: string[];
  mergeTargetClaimId?: string;
  proposedCanonicalForm?: string;
  /** Submitted by research a mandate funds (Part VIII): the mandate, and the job its review is metered to. */
  grantId?: string | null;
  fundedByJobId?: string | null;
}) {
  const db = getDb();
  const values: NewContribution = {
    claimId: input.claimId,
    contributorId: input.contributorId,
    contributionType: input.contributionType,
    content: input.content,
    evidenceUrls: input.evidenceUrls ?? [],
    mergeTargetClaimId: input.mergeTargetClaimId ?? null,
    proposedCanonicalForm: input.proposedCanonicalForm ?? null,
    grantId: input.grantId ?? null,
    fundedByJobId: input.fundedByJobId ?? null,
  };

  const [contribution] = await db
    .insert(contributions)
    .values(values)
    .returning();

  return contribution!;
}

export async function getContributionById(id: string) {
  const db = getDb();
  const [contribution] = await db
    .select()
    .from(contributions)
    .where(eq(contributions.id, id))
    .limit(1);
  return contribution ?? null;
}

export async function listContributions(filters: {
  claimId?: string;
  contributorId?: string;
  status?: string;
  contributionType?: string;
  limit: number;
  offset: number;
}) {
  const db = getDb();

  let conditions = sql`1=1`;
  if (filters.claimId) {
    conditions = sql`${conditions} AND ${contributions.claimId} = ${filters.claimId}`;
  }
  if (filters.contributorId) {
    conditions = sql`${conditions} AND ${contributions.contributorId} = ${filters.contributorId}`;
  }
  if (filters.status) {
    conditions = sql`${conditions} AND ${contributions.reviewStatus} = ${filters.status}`;
  }
  if (filters.contributionType) {
    conditions = sql`${conditions} AND ${contributions.contributionType} = ${filters.contributionType}`;
  }

  const rows = await db
    .select()
    .from(contributions)
    .where(conditions)
    .orderBy(desc(contributions.submittedAt))
    .limit(filters.limit)
    .offset(filters.offset);

  return rows;
}

export async function getReviewForContribution(contributionId: string) {
  const db = getDb();
  // The decision in force: an audit re-review marks the old row superseded
  // (#180), and an appeal must attach to the live decision, not history.
  const [review] = await db
    .select()
    .from(contributionReviews)
    .where(
      sql`${contributionReviews.contributionId} = ${contributionId} AND ${contributionReviews.superseded} = false`
    )
    .orderBy(desc(contributionReviews.reviewedAt))
    .limit(1);
  return review ?? null;
}

export async function createAppeal(input: {
  contributionId: string;
  originalReviewId: string;
  appellantId: string;
  appealReasoning: string;
}) {
  const db = getDb();
  const [appeal] = await db
    .insert(appeals)
    .values({
      contributionId: input.contributionId,
      originalReviewId: input.originalReviewId,
      appellantId: input.appellantId,
      appealReasoning: input.appealReasoning,
    })
    .returning();

  return appeal!;
}

export async function getAppealById(id: string) {
  const db = getDb();
  const [appeal] = await db
    .select()
    .from(appeals)
    .where(eq(appeals.id, id))
    .limit(1);
  return appeal ?? null;
}

// The assembled public record for one claim (#171): every contribution with
// its review, latest appeal, and arbitration outcome, plus display names for
// attribution. The constitution's Burden of Engagement makes this exchange
// part of the claim's public record, so it is read as one unit rather than
// stitched together client-side from the single-record endpoints.
export async function getContributionRecordForClaim(claimId: string) {
  const db = getDb();

  const rows = await db
    .select({
      contribution: contributions,
      contributorDisplayName: contributors.displayName,
    })
    .from(contributions)
    .innerJoin(contributors, eq(contributions.contributorId, contributors.id))
    .where(eq(contributions.claimId, claimId))
    .orderBy(desc(contributions.submittedAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.contribution.id);

  const [reviewRows, appealRows, arbitrationRows] = await Promise.all([
    db
      .select()
      .from(contributionReviews)
      .where(inArray(contributionReviews.contributionId, ids)),
    db
      .select({
        appeal: appeals,
        appellantDisplayName: contributors.displayName,
      })
      .from(appeals)
      .innerJoin(contributors, eq(appeals.appellantId, contributors.id))
      .where(inArray(appeals.contributionId, ids))
      .orderBy(desc(appeals.submittedAt)),
    db
      .select()
      .from(arbitrationResults)
      .where(inArray(arbitrationResults.contributionId, ids))
      .orderBy(desc(arbitrationResults.arbitratedAt)),
  ]);

  const reviewFor = new Map(reviewRows.map((r) => [r.contributionId, r]));
  // Rows arrive newest-first; first write wins, so each map holds the latest.
  const appealFor = new Map<string, (typeof appealRows)[number]>();
  for (const row of appealRows) {
    if (!appealFor.has(row.appeal.contributionId)) {
      appealFor.set(row.appeal.contributionId, row);
    }
  }
  const arbitrationFor = new Map<string, (typeof arbitrationRows)[number]>();
  for (const row of arbitrationRows) {
    if (!arbitrationFor.has(row.contributionId)) {
      arbitrationFor.set(row.contributionId, row);
    }
  }

  return rows.map((row) => {
    const appealRow = appealFor.get(row.contribution.id);
    return {
      contribution: row.contribution,
      // A mandate's contribution names the arrangement, never the party (§12/§19).
      contributorDisplayName: row.contribution.grantId ? MANDATE_LABEL : row.contributorDisplayName,
      review: reviewFor.get(row.contribution.id) ?? null,
      appeal: appealRow
        ? {
            ...appealRow.appeal,
            appellantDisplayName: appealRow.appellantDisplayName,
          }
        : null,
      arbitration: arbitrationFor.get(row.contribution.id) ?? null,
    };
  });
}

export async function getArbitrationForContribution(contributionId: string) {
  const db = getDb();
  const [result] = await db
    .select()
    .from(arbitrationResults)
    .where(eq(arbitrationResults.contributionId, contributionId))
    .limit(1);
  return result ?? null;
}
