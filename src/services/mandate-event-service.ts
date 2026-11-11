/**
 * A mandate's inbox: what its work produced since its Grantmaker last
 * looked, and the wake that brings a review pass when there is something to
 * look at.
 *
 * A mandate used to learn what its money bought only on its next scheduled
 * review, a day later; digging one level deeper took a day per level. Now:
 *
 *  - collectMandateEvents reads the graph since each mandate's watermark
 *    (`grants.events_scanned_at`) and records what bears on its work: an
 *    assessment on a node it funded (with the children that pass left
 *    waiting), a decision on a contribution it submitted, a source in its
 *    pipeline whose extraction finished, a lookout's flag. Collecting from the tables, not from hooks
 *    in every lane, means no Steward lane or reviewer path can skip it.
 *  - wakeDueMandateReviews reopens the review row of a mandate with pending
 *    events once its last pass is WAKE_AFTER_MINUTES old; the drain funds it
 *    from the escrow, within the daily rate, like any of the mandate's own
 *    rows (fundGrantSelfActions). The daily review stays as a heartbeat.
 *  - The review pass reads the pending events in its briefing and marks the
 *    ones it was shown consumed.
 */
import { rawQuery } from "../db/client.js";
import type { OperatingPolicy } from "./operating-policy-service.js";
import { REVIEW_GROUP, grantmakerShareLeftMicroUsd, reviewPassBudgetMicroUsd } from "./action-service.js";

/**
 * How long after a review pass ends before events can wake the next one. A
 * coalescing window, not a spending limit (the daily rate and the escrow
 * bound spending): a burst of finished passes is judged by one review rather
 * than one review each, so the money goes to the work. Stated to the agent
 * in its briefing.
 */
export const WAKE_AFTER_MINUTES = 15;

/** How often the drain collects events and checks for due wakes. */
const TICK_MS = 60_000;
/** How far each scan reaches back past its watermark, for rows committed late. */
const OVERLAP_MINUTES = 5;

let lastTickAt = Number.NEGATIVE_INFINITY;

/** Test hook. */
export function resetMandateEventTick(): void {
  lastTickAt = Number.NEGATIVE_INFINITY;
}

/** The nodes a mandate's work touches: what it paid for, planned, or is scoped to. */
const INTEREST_SQL = (node: string) => `(
     ${node}.funded_by_job_id = g.budget_job_id
  OR EXISTS (SELECT 1 FROM action_allocations al
              WHERE al.grant_id = g.id AND al.exclusion_group = 'assess:' || ${node}.claim_id::text)
  OR ${node}.claim_id = g.scope_claim_id
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
              WHERE it->>'claim_id' = ${node}.claim_id::text))`;

/** What a node's children look like now: how many, and how many wait. */
const CHILDREN_SQL = (node: string) => `jsonb_build_object(
     'children', (SELECT COUNT(*) FROM claim_relationships cr WHERE cr.parent_claim_id = ${node}.claim_id),
     'children_unassessed', (SELECT COUNT(*) FROM claim_relationships cr
                               JOIN claims ch ON ch.id = cr.child_claim_id AND ch.state = 'active'
                              WHERE cr.parent_claim_id = ${node}.claim_id
                                AND NOT EXISTS (SELECT 1 FROM assessments_in_force x WHERE x.claim_id = ch.id)
                                AND NOT EXISTS (SELECT 1 FROM quantity_estimates_in_force q WHERE q.claim_id = ch.id)
                                AND NOT EXISTS (SELECT 1 FROM question_assessments_in_force qa WHERE qa.claim_id = ch.id)),
     'children_deferred', (SELECT COUNT(*) FROM claim_relationships cr
                             JOIN claims ch ON ch.id = cr.child_claim_id AND ch.state = 'active'
                            WHERE cr.parent_claim_id = ${node}.claim_id AND ch.steward_state = 'deferred'))`;

/**
 * Record what happened to each active mandate's work since its watermark.
 * A mandate scanned for the first time starts from now. Returns the number
 * of events recorded. Idempotent: an event is unique per (mandate, kind,
 * row), so an overlapping rescan records nothing twice.
 */
export async function collectMandateEvents(grantId?: string): Promise<number> {
  // Timestamps travel as text: a JS Date would drop Postgres's microseconds
  // and the watermark's compare-and-set below would never match.
  const grants = await rawQuery<{ id: string; from: string | null; to: string }>(
    `SELECT id, events_scanned_at::text AS "from", now()::text AS "to" FROM grants
      WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1)`,
    [grantId ?? null]
  );
  let recorded = 0;
  for (const g of grants) {
    if (g.from) {
      // The window reaches back OVERLAP_MINUTES past the watermark: a row's
      // timestamp is its transaction's start, so one committed just after the
      // last scan can carry a time before it. Rescanning the overlap records
      // nothing twice.
      const window = [g.id, g.from, g.to];
      const assessed = await rawQuery(
        `INSERT INTO mandate_events (grant_id, kind, claim_id, ref_id, payload)
         SELECT g.id, 'assessed', x.claim_id, x.id,
                jsonb_build_object('node_kind', c.kind, 'text', LEFT(c.text, 240),
                                   'outcome', x.outcome) || ${CHILDREN_SQL("x")}
           FROM grants g
           JOIN (
             SELECT id, claim_id, funded_by_job_id, assessed_at, status AS outcome FROM assessments_in_force
             UNION ALL
             SELECT id, claim_id, funded_by_job_id, assessed_at, LEFT(summary, 160) FROM quantity_estimates_in_force
             UNION ALL
             SELECT id, claim_id, funded_by_job_id, assessed_at, standing FROM question_assessments_in_force
           ) x ON x.assessed_at > $2::timestamptz - make_interval(mins => ${OVERLAP_MINUTES}) AND x.assessed_at <= $3
           JOIN claims c ON c.id = x.claim_id
          WHERE g.id = $1 AND ${INTEREST_SQL("x")}
         ON CONFLICT (grant_id, kind, ref_id) DO NOTHING
         RETURNING id`,
        window
      );
      const reviewed = await rawQuery(
        `INSERT INTO mandate_events (grant_id, kind, claim_id, ref_id, payload)
         SELECT ct.grant_id, 'contribution_reviewed', ct.claim_id, r.id,
                jsonb_build_object('contribution_id', ct.id, 'type', ct.contribution_type,
                                   'decision', r.decision,
                                   'proposed', LEFT(ct.proposed_canonical_form, 240),
                                   'text', (SELECT LEFT(c.text, 240) FROM claims c WHERE c.id = ct.claim_id))
           FROM contributions ct
           JOIN contribution_reviews r ON r.contribution_id = ct.id AND NOT r.superseded
          WHERE ct.grant_id = $1 AND r.reviewed_at > $2::timestamptz - make_interval(mins => ${OVERLAP_MINUTES}) AND r.reviewed_at <= $3
         ON CONFLICT (grant_id, kind, ref_id) DO NOTHING
         RETURNING id`,
        window
      );
      // A source is news once its extraction has finished, not when it was
      // submitted: the event carries the outcome and the nodes linked as of
      // then (#898). It falls in the window that holds the later of the
      // extraction's end and the mandate's attribution, so an extraction
      // that ends days after submission is recorded when it ends, and a
      // mandate attributed to a source extracted long ago is told when it is
      // attributed; the unique (mandate, kind, row) records each once. A row
      // with no extraction job on record is settled as it stands.
      const ingested = await rawQuery(
        `INSERT INTO mandate_events (grant_id, kind, ref_id, payload)
         SELECT gs.grant_id, 'source_ingested', gs.id,
                jsonb_build_object('url', gs.url,
                  'outcome', COALESCE(j.status, 'unknown'),
                  'already_extracted', j.completed_at IS NOT NULL AND j.completed_at < gs.created_at,
                  'error', LEFT(j.error, 200),
                  'document_problem', j.result->>'document_problem',
                  'nodes', (SELECT COUNT(DISTINCT ci.claim_id) FROM claim_instances ci
                             WHERE ci.source_id = gs.source_id AND ci.detached_at IS NULL))
           FROM grant_sources gs
           LEFT JOIN jobs j ON j.id = gs.job_id
          WHERE gs.grant_id = $1
            AND (j.id IS NULL OR j.status IN ('completed', 'failed'))
            AND GREATEST(gs.created_at, COALESCE(j.completed_at, gs.created_at))
                  > $2::timestamptz - make_interval(mins => ${OVERLAP_MINUTES})
            AND GREATEST(gs.created_at, COALESCE(j.completed_at, gs.created_at)) <= $3
         ON CONFLICT (grant_id, kind, ref_id) DO NOTHING
         RETURNING id`,
        window
      );
      const flagged = await rawQuery(
        `INSERT INTO mandate_events (grant_id, kind, claim_id, ref_id, payload)
         SELECT l.grant_id, 'lookout_flag', f.claim_id, f.id,
                jsonb_build_object('flag', f.kind, 'url', f.url, 'rationale', LEFT(f.rationale, 300))
           FROM lookout_flags f JOIN lookouts l ON l.id = f.lookout_id
          WHERE l.grant_id = $1 AND f.created_at > $2::timestamptz - make_interval(mins => ${OVERLAP_MINUTES}) AND f.created_at <= $3
         ON CONFLICT (grant_id, kind, ref_id) DO NOTHING
         RETURNING id`,
        window
      );
      recorded += assessed.length + reviewed.length + ingested.length + flagged.length;
    }
    // Advance only from the watermark this scan read: a concurrent scan that
    // already moved it (or started it) keeps its own.
    await rawQuery(
      `UPDATE grants SET events_scanned_at = $2
        WHERE id = $1 AND events_scanned_at IS NOT DISTINCT FROM $3::timestamptz`,
      [g.id, g.to, g.from]
    );
  }
  return recorded;
}

/**
 * Reopen the review of every active mandate with pending events whose last
 * pass ended at least WAKE_AFTER_MINUTES ago. A decomposition mandate whose
 * Grantmaker share is spent is not woken (its reviews are paid from the
 * share). Returns the number of reviews reopened.
 */
export async function wakeDueMandateReviews(): Promise<number> {
  const due = await rawQuery<{
    id: string;
    mandate: { grantmaker_share_owls?: number | null; operating_policy?: OperatingPolicy | null } | null;
  }>(
    `SELECT g.id, g.mandate FROM grants g
       JOIN actions a ON a.exclusion_group = 'review:' || g.id::text AND a.kind = 'mandate_review'
      WHERE g.status = 'active'
        AND a.status IN ('done', 'superseded', 'cancelled')
        AND a.updated_at < now() - make_interval(mins => ${WAKE_AFTER_MINUTES})
        AND EXISTS (SELECT 1 FROM mandate_events e WHERE e.grant_id = g.id AND e.consumed_at IS NULL)`
  );
  let woken = 0;
  for (const g of due) {
    const share = await grantmakerShareLeftMicroUsd(g).catch(() => null);
    if (share && share.leftMicroUsd <= 0) continue;
    // Reopened at the pass budget as it stands now (the policy may have
    // changed it, and a pass started short lowered the row's estimate).
    const rows = await rawQuery(
      `UPDATE actions SET status = 'open', cost_est_micro_usd = $2, updated_at = now()
        WHERE exclusion_group = $1 AND kind = 'mandate_review'
          AND status IN ('done', 'superseded', 'cancelled')
        RETURNING id`,
      [REVIEW_GROUP(g.id), await reviewPassBudgetMicroUsd(g, "review", share)]
    );
    woken += rows.length;
  }
  return woken;
}

/** The drain's tick: collect, then wake. At most once a minute; never throws. */
export async function mandateEventsTick(now: number = Date.now()): Promise<{ recorded: number; woken: number }> {
  if (now - lastTickAt < TICK_MS) return { recorded: 0, woken: 0 };
  lastTickAt = now;
  const recorded = await collectMandateEvents().catch((err: unknown) => {
    console.error(`[mandate-events] collect failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  });
  const woken = await wakeDueMandateReviews().catch((err: unknown) => {
    console.error(`[mandate-events] wake failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  });
  return { recorded, woken };
}

export interface MandateEventRow {
  id: string;
  kind: string;
  claim_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** The mandate's pending events, oldest first, and how many there are in all. */
export async function pendingMandateEvents(
  grantId: string,
  limit = 100
): Promise<{ events: MandateEventRow[]; total: number }> {
  const events = await rawQuery<MandateEventRow & { total: number }>(
    `SELECT id, kind, claim_id, payload, created_at, COUNT(*) OVER()::int AS total
       FROM mandate_events WHERE grant_id = $1 AND consumed_at IS NULL
      ORDER BY created_at, id LIMIT $2`,
    [grantId, limit]
  );
  return { events, total: Number(events[0]?.total ?? 0) };
}

export async function consumeMandateEvents(grantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await rawQuery(
    `UPDATE mandate_events SET consumed_at = now()
      WHERE grant_id = $1 AND id = ANY($2::uuid[]) AND consumed_at IS NULL`,
    [grantId, ids]
  );
}

/**
 * A finished ingest as a briefing line, stating the extraction's outcome so
 * "no nodes" can only mean an extraction that found none (#898).
 */
function describeIngest(p: Record<string, unknown>): string {
  const nodes = Number(p.nodes ?? 0);
  const linked = `${nodes} node${nodes === 1 ? "" : "s"} linked to it`;
  // Recorded at submission, before events waited for the extraction.
  if (p.outcome === undefined) return `Submitted ${p.url} for extraction; ${linked} at the time.`;
  if (p.outcome === "failed") {
    return (
      `Ingesting ${p.url} failed${p.error ? `: ${p.error}` : ""}.` +
      (nodes > 0 ? ` ${linked} from earlier readings.` : " Nothing was extracted from it.")
    );
  }
  if (p.outcome === "unknown") return `${p.url} is in your pipeline with no extraction on record; ${linked}.`;
  const problem = p.document_problem ? ` The Extractor reported the document as ${p.document_problem}.` : "";
  if (p.already_extracted) {
    return `${p.url} was already in the graph, extracted before your mandate asked for it: ${linked}.${problem}`;
  }
  return nodes > 0
    ? `Ingested ${p.url}: extraction completed, ${linked}.${problem}`
    : `Ingested ${p.url}: extraction completed and found no claims; no nodes linked to it.${problem}`;
}

/** One event as a line of the review briefing. */
export function describeMandateEvent(e: MandateEventRow): string {
  const p = e.payload as Record<string, unknown>;
  const node = e.claim_id ? ` (${e.claim_id})` : "";
  switch (e.kind) {
    case "assessed": {
      const waiting = Number(p.children_unassessed ?? 0);
      const deferred = Number(p.children_deferred ?? 0);
      const kids = Number(p.children ?? 0);
      return (
        `Assessed ${p.node_kind ?? "node"} "${p.text}"${node}: ${p.outcome ?? "recorded"}. ` +
        (kids > 0
          ? `${kids} children, ${waiting} not yet assessed${deferred ? `, ${deferred} deferred` : ""}.`
          : "No children recorded.")
      );
    }
    case "contribution_reviewed":
      return (
        `Your ${p.type} contribution was ${
          p.decision === "accept" ? "accepted" : p.decision === "reject" ? "rejected" : "escalated to the Dispute Arbitrator"
        }` +
        (p.text ? `; it bears on "${p.text}"${node}` : p.proposed ? `: "${p.proposed}"` : "") +
        "."
      );
    case "source_ingested":
      return describeIngest(p);
    case "lookout_flag":
      return `A lookout raised a ${p.flag}${node}${p.url ? ` (${p.url})` : ""}: ${p.rationale}`;
    default:
      return `${e.kind}${node}`;
  }
}
