import { markSeveralInForce } from "./judgment-version-service.js";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  claims,
  assessmentsInForce,
  bounties,
  quantityDefinitions,
  quantityEstimatesInForce,
  questionAssessmentsInForce,
  type NewClaim,
} from "../db/schema.js";
import { generateEmbedding } from "./embedding-service.js";
import { createJob } from "./job-service.js";
import { enqueueClaimPipeline } from "./queue-service.js";
import { loadConfig } from "../config.js";
import { currentLabel } from "../llm/usage-context.js";
import { LIVE_BOUNTY_STATUSES, checkedKindSql } from "./formalization-service.js";
import { listOrderedClaimInstances } from "./claim-instance-service.js";
import { kindFields } from "./search-service.js";
import type { NodeKind } from "../schemas/kinds.js";
import { importanceSql, nodeValueOverlays } from "./overlay-service.js";
import { layered } from "./layer-service.js";

/**
 * Create a new claim, generate its embedding, and enqueue it for processing.
 * It starts with no arguments: those come through reviewed contributions.
 */
export async function proposeClaim(input: {
  claim: string;
  kind?: NodeKind;
  createdBy?: string;
  /** Metering attribution (#70): the requesting account/key. */
  attribution?: { userId?: string | null; apiKeyId?: string | null };
}) {
  const db = getDb();
  const createdBy = input.createdBy ?? "user";

  // Generate embedding
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(input.claim);
  } catch {
    // Proceed without embedding; will be retried in pipeline
  }

  // Create claim
  const newClaim: NewClaim = {
    text: input.claim,
    kind: input.kind ?? "claim",
    createdBy,
    embedding,
    pipelineEpoch: loadConfig().pipelineEpoch,
    // The node carries the label of the request or run that proposed it
    // (src/labels.ts); its onboarding, enqueued below, carries the same.
    sensitivityLabel: currentLabel(),
  };

  const [claim] = await db.insert(claims).values(newClaim).returning();

  // Create tracking job (carrying metering attribution to the pipeline)
  const job = await createJob(
    "claim_pipeline",
    { claimId: claim!.id },
    input.attribution
  );

  // Onboard the new claim (the Steward will structure + assess it)
  await enqueueClaimPipeline({
    claimId: claim!.id,
    jobId: job.id,
  });

  return { claim: claim!, jobId: job.id };
}

// Opaque keyset cursor over (updated_at, id) — the sort key for the browse feed.
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const [updatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    return updatedAt && id ? { updatedAt, id } : null;
  } catch {
    return null;
  }
}

/**
 * List claims for browsing, most-recently-updated first, with each claim's
 * current assessment (if any) joined in. Excludes claims merged into another.
 *
 * Uses keyset pagination on (updated_at, id) rather than LIMIT/OFFSET so it
 * stays O(limit) regardless of how deep the feed goes, and returns no exact
 * total (a count over the full table doesn't scale and isn't needed for a
 * recency feed). For discovery at scale, search and faceted filters are the
 * primary access paths; this is the "recent activity" stream.
 */
export async function listClaims(opts: {
  limit: number;
  cursor?: string;
  state?: string;
  // "assessed" ⇒ has a current verdict of its kind (a claim's status, a
  // question's standing, a quantity's estimate); "unassessed" ⇒ none yet
  // (matches the badge rule — a NULL status reads as unassessed).
  assessed?: "all" | "assessed" | "unassessed";
  minImportance?: number;
  // Mathematics (docs/mathematics.md §8.3): only claims with a live bounty,
  // and only claims of one type (the Mathematics territory).
  withPrizes?: boolean;
  claimType?: string;
  // Only claims carrying this tag (#272), by tag id (resolve a slug first).
  tagId?: string;
  // Only nodes of this kind: claims, quantities or questions.
  kind?: NodeKind;
}) {
  const db = getDb();

  // Default to active-only: archived epoch cohorts and deprecated merge losers
  // stay out of the activity stream. Passing an explicit state (e.g. 'archived')
  // still works — that is how the archive remains browsable on request.
  const filters = [isNull(claims.mergedInto)];
  filters.push(eq(claims.state, opts.state ?? "active"));
  // Same predicate as search's ASSESSED_SQL: each kind by its own table.
  const hasVerdict = sql`(CASE ${claims.kind} WHEN 'question' THEN ${questionAssessmentsInForce.id} IS NOT NULL
    WHEN 'quantity' THEN ${quantityEstimatesInForce.id} IS NOT NULL ELSE ${assessmentsInForce.status} IS NOT NULL END)`;
  if (opts.assessed === "assessed") filters.push(hasVerdict);
  else if (opts.assessed === "unassessed") filters.push(sql`NOT ${hasVerdict}`);
  if (opts.minImportance && opts.minImportance > 0) {
    filters.push(sql`${sql.raw(importanceSql("claims"))} >= ${opts.minImportance}`);
  }
  if (opts.withPrizes) filters.push(isNotNull(bounties.id));
  if (opts.claimType) filters.push(eq(claims.claimType, opts.claimType));
  if (opts.kind) filters.push(eq(claims.kind, opts.kind));
  if (opts.tagId) {
    filters.push(
      // The same slug held at two layers is two tag rows (layer-service.ts): a node tagged under either carries the tag.
      layered()
        ? sql`EXISTS (SELECT 1 FROM taggings tg WHERE tg.subject_kind = 'claim' AND tg.subject_id = ${claims.id}
                       AND tg.tag_id IN (SELECT same_slug.id FROM tags named_tag JOIN tags same_slug ON same_slug.slug = named_tag.slug
                                          WHERE named_tag.id = ${opts.tagId}::uuid))`
        : sql`EXISTS (SELECT 1 FROM taggings tg WHERE tg.subject_kind = 'claim'
                   AND tg.subject_id = ${claims.id} AND tg.tag_id = ${opts.tagId}::uuid)`
    );
  }

  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    // Row-value comparison: strictly "older" than the cursor under the
    // (updated_at DESC, id DESC) ordering. Seeks via idx_claims_updated.
    filters.push(
      sql`(${claims.updatedAt}, ${claims.id}) < (${cur.updatedAt}::timestamptz, ${cur.id}::uuid)`
    );
  }

  // Fetch one extra row to determine whether a further page exists.
  const rows = await db
    .select({
      id: claims.id,
      kind: claims.kind,
      text: claims.text,
      claim_type: claims.claimType,
      state: claims.state,
      importance: sql<number>`${sql.raw(importanceSql("claims"))}`.as("importance"),
      updated_at: claims.updatedAt,
      standing: questionAssessmentsInForce.standing,
      estimate: quantityEstimatesInForce.estimate,
      unit: quantityDefinitions.unit,
      assessment_status: assessmentsInForce.status,
      assessment_confidence: assessmentsInForce.confidence,
      prize_micro_usd: bounties.amountMicroUsd,
      checked: sql<string | null>`${sql.raw(checkedKindSql(`"claims"."id"`))}`,
    })
    .from(claims)
    .leftJoin(assessmentsInForce, eq(assessmentsInForce.claimId, claims.id))
    // The live bounty, at most one per claim by the partial unique index.
    .leftJoin(
      bounties,
      and(eq(bounties.claimId, claims.id), inArray(bounties.status, [...LIVE_BOUNTY_STATUSES]))
    )
    // The kinds' verdicts, at most one current row each by partial unique index.
    .leftJoin(quantityEstimatesInForce, eq(quantityEstimatesInForce.claimId, claims.id))
    .leftJoin(quantityDefinitions, eq(quantityDefinitions.claimId, claims.id))
    .leftJoin(questionAssessmentsInForce, eq(questionAssessmentsInForce.claimId, claims.id))
    .where(and(...filters))
    .orderBy(desc(claims.updatedAt), desc(claims.id))
    .limit(opts.limit + 1);

  const hasMore = rows.length > opts.limit;
  const results = (hasMore ? rows.slice(0, opts.limit) : rows).map(
    ({ kind, standing, estimate, unit, ...r }) => ({
      ...r,
      ...kindFields({ kind, standing, estimate, unit }),
      prize_micro_usd: r.prize_micro_usd === null || r.prize_micro_usd === undefined ? null : Number(r.prize_micro_usd),
      checked: r.checked === "proof" || r.checked === "disproof" ? r.checked : null,
    })
  );
  const last = results[results.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor(last.updated_at, last.id) : null;

  // Where more than one judgment of a node is in force for the reader, the row says how many.
  await markSeveralInForce(results, (r) => r.id);
  return { results, next_cursor };
}

/**
 * Get a claim by ID.
 */
export async function getClaimById(claimId: string) {
  const db = getDb();
  const [claim] = await db
    .select()
    .from(claims)
    .where(eq(claims.id, claimId))
    .limit(1);
  if (!claim) return null;
  // Where a label the reader reads holds its own importance or
  // contestation for the node (overlay-service.ts), the reader goes by
  // that: the node is given with the values in effect for them, and
  // `valuesByLabel` lists each label's beside the node's own. Nothing is
  // asked on a graph with one label.
  const held = await nodeValueOverlays(claim.id, { importance: claim.importance, contestation: claim.contestation }).catch(() => null);
  if (!held) return claim;
  return {
    ...claim,
    importance: held.importance,
    contestation: held.contestation,
    valuesByLabel: {
      ...(held.held.importance
        ? {
            importance_by_label: [
              ...held.held.importance.map((o) => ({ label: o.label, value: o.value, in_effect: o.in_effect })),
              { label: claim.sensitivityLabel, value: held.below.importance, in_effect: false },
            ],
          }
        : {}),
      ...(held.held.contestation
        ? {
            contestation_by_label: [
              ...held.held.contestation.map((o) => ({ label: o.label, value: o.value, in_effect: o.in_effect })),
              { label: claim.sensitivityLabel, value: held.below.contestation, in_effect: false },
            ],
          }
        : {}),
    },
  };
}


/**
 * Source instances of a claim: where in the corpus it was asserted. The MCP
 * `get_claim` tool (#73) and the agents' graph read share this shape. Only
 * the instances the claim carries (detached ones are not its), in the order
 * a reader sees them: the Steward's ranks, then the provenance story's
 * order, then the date of the statement. Each carries its stance, so a
 * reader can tell the sources that take a side from those that pose the
 * claim or only mention it, and the interest recorded for its source on
 * this claim (§9), null where none is.
 */
export async function getClaimInstances(claimId: string) {
  const rows = await listOrderedClaimInstances(claimId);
  return rows.map((r) => ({
    id: r.id,
    source_id: r.source_id,
    verbatim_text: r.verbatim_text,
    context: r.context,
    stance: r.stance,
    confidence: r.confidence,
    source_title: r.source_title,
    source_url: r.source_url,
    source_interest: r.source_interest,
  }));
}

/**
 * Update claim fields.
 */
export async function updateClaim(
  claimId: string,
  updates: Partial<Pick<NewClaim, "state" | "decompositionStatus">>
) {
  const db = getDb();
  const [updated] = await db
    .update(claims)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(claims.id, claimId))
    .returning();
  return updated ?? null;
}
