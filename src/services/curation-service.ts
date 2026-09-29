/**
 * Curation requests — the producer side of the `curate` ledger action
 * (#363; docs/allocation.md, "Maintenance and audit").
 *
 * Curation is real work the graph needs, and it is paid for like any other:
 * a request records a structural concern about an anchor claim and opens (or
 * reopens) that claim's `curate:<claim_id>` row; the mandates value the row
 * (the General formula, a judgment mandate's Grantmaker) and fund it through
 * the ordinary allocator; the engine executor runs the Curator once the row
 * is covered, and the run reads every live request on its anchor.
 *
 * Nothing here decides whether curation runs. That is the valuation's call.
 * These functions only say what is being asked for, and bound how much can
 * be asked:
 *
 *  - one live request per (anchor, other claim, source): a repeat is a repeat;
 *  - at most CURATION_ESCALATIONS_PER_CLAIM live Steward escalations from any
 *    one claim, so a single run cannot flood the ledger;
 *  - the reconcile-candidate scan raises at most its policy's per-sweep cap.
 *
 * The one entry point for opening a curate row. The lockdown test
 * (tests/unit/workers/curation-trigger-lockdown.test.ts) holds every other
 * path under src/ to it.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { ensureCurateAction } from "./action-service.js";
import { recordEnqueueEvent } from "./enqueue-events-service.js";

export type CurationSource = "steward_escalation" | "reconcile_candidate" | "operator";

export interface CurationRequestInput {
  anchorClaimId: string;
  otherClaimId?: string | null;
  source: CurationSource;
  concern: string;
  /** reconcile_candidate: the scan's similarity score. */
  signal?: number | null;
  requestedByClaimId?: string | null;
  requestedByRunId?: string | null;
}

export type CurationRequestResult =
  | { ok: true; requestId: string | null; actionId: string | null; repeat: boolean }
  | { ok: false; problem: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record a structural concern about an anchor claim and make sure its curate
 * row is open. A repeat of a live request records nothing new but still
 * reports the row, so the caller can say where the concern stands.
 */
export async function requestCuration(
  input: CurationRequestInput
): Promise<CurationRequestResult> {
  const concern = input.concern.trim();
  if (!UUID_RE.test(input.anchorClaimId)) {
    return { ok: false, problem: `claim_id "${input.anchorClaimId}" is not a claim id` };
  }
  if (input.otherClaimId && !UUID_RE.test(input.otherClaimId)) {
    return { ok: false, problem: `other_claim_id "${input.otherClaimId}" is not a claim id` };
  }
  if (input.otherClaimId && input.otherClaimId === input.anchorClaimId) {
    return { ok: false, problem: "other_claim_id is the anchor claim itself" };
  }
  if (!concern) return { ok: false, problem: "a concern is required" };

  const [anchor] = await rawQuery<{ id: string }>(
    `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
    [input.anchorClaimId]
  );
  if (!anchor) {
    return { ok: false, problem: `claim ${input.anchorClaimId} is not an active claim` };
  }
  if (input.otherClaimId) {
    const [other] = await rawQuery<{ id: string }>(
      `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
      [input.otherClaimId]
    );
    if (!other) {
      return { ok: false, problem: `claim ${input.otherClaimId} is not an active claim` };
    }
  }

  // The per-claim bound on live escalations: counted before the insert, so
  // a repeat of a live request (which inserts nothing) is never refused.
  if (input.source === "steward_escalation" && input.requestedByClaimId) {
    const cap = loadConfig().curationEscalationsPerClaim ?? 3;
    const [live] = await rawQuery<{ n: number; repeat: boolean }>(
      `SELECT COUNT(*)::int AS n,
              BOOL_OR(anchor_claim_id = $2
                      AND other_claim_id IS NOT DISTINCT FROM $3::uuid) AS repeat
         FROM curation_requests
        WHERE requested_by_claim_id = $1 AND source = 'steward_escalation'
          AND consumed_at IS NULL`,
      [input.requestedByClaimId, input.anchorClaimId, input.otherClaimId ?? null]
    );
    if (!live?.repeat && Number(live?.n ?? 0) >= cap) {
      return {
        ok: false,
        problem:
          `this claim already has ${live!.n} structural concerns waiting for the ` +
          `Curator (the most one claim may hold at once is ${cap}); they are on the ` +
          `ledger and will be read together when curation is funded`,
      };
    }
  }

  const inserted = await rawQuery<{ id: string }>(
    `INSERT INTO curation_requests
       (anchor_claim_id, other_claim_id, source, concern, signal,
        requested_by_claim_id, requested_by_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.anchorClaimId,
      input.otherClaimId ?? null,
      input.source,
      concern.slice(0, 4000),
      input.signal ?? null,
      input.requestedByClaimId ?? null,
      input.requestedByRunId ?? null,
    ]
  );
  const actionId = await ensureCurateAction(input.anchorClaimId);
  if (inserted.length > 0) {
    // The fan-out telemetry the Curator queue used to feed (#334 L0).
    recordEnqueueEvent({
      queue: "curator",
      trigger: input.source,
      claimId: input.anchorClaimId,
    });
    // Priced and offered to the funders now, not at the next sweep.
    if (actionId) {
      const { fundCurationNow } = await import("./maintenance-funding.js");
      await fundCurationNow(actionId);
    }
  }
  return {
    ok: true,
    requestId: inserted[0]?.id ?? null,
    actionId,
    repeat: inserted.length === 0,
  };
}

export interface LiveCurationRequest {
  id: string;
  other_claim_id: string | null;
  source: CurationSource;
  concern: string;
  signal: number | null;
  created_at: Date;
}

/** Every live request on an anchor, oldest first: what one run reads. */
export async function liveCurationRequests(
  anchorClaimId: string
): Promise<LiveCurationRequest[]> {
  return rawQuery<LiveCurationRequest>(
    `SELECT id, other_claim_id, source, concern, signal, created_at
       FROM curation_requests
      WHERE anchor_claim_id = $1 AND consumed_at IS NULL
      ORDER BY created_at ASC
      LIMIT 50`,
    [anchorClaimId]
  );
}

/**
 * Mark the requests a finished run read as consumed. Stamped at completion,
 * not at start, so a run that dies mid-way leaves its inputs live for the
 * retry the reconcile sweep gives it.
 */
export async function consumeCurationRequests(
  requestIds: string[],
  actionId: string
): Promise<void> {
  if (requestIds.length === 0) return;
  await rawQuery(
    `UPDATE curation_requests
        SET consumed_at = now(), consumed_by_action_id = $2
      WHERE id = ANY($1::uuid[]) AND consumed_at IS NULL`,
    [requestIds, actionId]
  );
}

/** The run's briefing: the concerns, in the requesters' words. */
export function describeCurationRequests(requests: LiveCurationRequest[]): string {
  if (requests.length === 0) return "(no live requests)";
  return requests
    .map((r, i) => {
      const who =
        r.source === "steward_escalation"
          ? "A Steward escalated"
          : r.source === "reconcile_candidate"
            ? `The reconcile-candidate scan paired it (similarity ${Number(r.signal ?? 0).toFixed(3)})`
            : "An operator asked";
      const other = r.other_claim_id ? ` with claim ${r.other_claim_id}` : "";
      return `${i + 1}. ${who}${other}: ${r.concern}`;
    })
    .join("\n");
}

/** How far back the scan looks for claims to pair, and how many it reads. */
const SCAN_WINDOW_DAYS = 14;
const SCAN_OUTER_LIMIT = 200;

/**
 * The reconcile-candidate scan (#363): a scan, not a judgment, in the same
 * sense as the lookouts' retraction poll. It pairs recently created active
 * claims with their nearest active neighbour by embedding and raises a
 * `reconcile_candidate` request for each pair that is at least
 * `reconcile_candidate_min_similarity` alike and carries no edge, no link,
 * and no curation request of any age between them (a pair once asked about,
 * whatever the Curator decided, is never raised again by the scan). No
 * model runs; a candidate is only a request, and whether it is worth a
 * Curator's run is the valuation's call, which weighs a scan's pair below an
 * agent's escalation.
 *
 * Bounded twice: at most `reconcile_candidates_max_per_sweep` requests per
 * sweep (0, the default, is off), and a fixed window of recent claims for
 * the nearest-neighbour search, since claims.embedding carries no vector
 * index and each lookup is a scan.
 */
export async function scanReconcileCandidates(policy: {
  reconcile_candidates_max_per_sweep: number;
  reconcile_candidate_min_similarity: number;
}): Promise<number> {
  const cap = Math.floor(policy.reconcile_candidates_max_per_sweep);
  if (cap <= 0) return 0;
  const pairs = await rawQuery<{ anchor: string; other: string; similarity: number }>(
    `SELECT c.id AS anchor, n.id AS other, n.similarity
       FROM (SELECT id, embedding FROM claims
              WHERE state = 'active' AND embedding IS NOT NULL
                AND created_at > now() - make_interval(days => $3)
              ORDER BY created_at DESC
              LIMIT ${SCAN_OUTER_LIMIT}) c
       CROSS JOIN LATERAL (
         SELECT o.id, (1 - (o.embedding <=> c.embedding))::real AS similarity
           FROM claims o
          WHERE o.state = 'active' AND o.embedding IS NOT NULL AND o.id <> c.id
          ORDER BY o.embedding <=> c.embedding
          LIMIT 1
       ) n
      WHERE n.similarity >= $1
        AND NOT EXISTS (SELECT 1 FROM claim_relationships r
                         WHERE (r.parent_claim_id = c.id AND r.child_claim_id = n.id)
                            OR (r.parent_claim_id = n.id AND r.child_claim_id = c.id))
        AND NOT EXISTS (SELECT 1 FROM claim_links l
                         WHERE l.claim_a_id = LEAST(c.id, n.id)
                           AND l.claim_b_id = GREATEST(c.id, n.id))
        AND NOT EXISTS (SELECT 1 FROM curation_requests q
                         WHERE (q.anchor_claim_id = c.id AND q.other_claim_id = n.id)
                            OR (q.anchor_claim_id = n.id AND q.other_claim_id = c.id))
      ORDER BY n.similarity DESC
      LIMIT $2`,
    [policy.reconcile_candidate_min_similarity, cap * 2, SCAN_WINDOW_DAYS]
  );
  // Each unordered pair once: the newer claim's lookup and the older one's
  // can both find the same pair.
  const seen = new Set<string>();
  let raised = 0;
  for (const p of pairs) {
    if (raised >= cap) break;
    const key = [p.anchor, p.other].sort().join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await requestCuration({
      anchorClaimId: p.anchor,
      otherClaimId: p.other,
      source: "reconcile_candidate",
      signal: Number(p.similarity),
      concern:
        `The reconcile-candidate scan found this claim and claim ${p.other} ` +
        `unusually alike (embedding similarity ${Number(p.similarity).toFixed(3)}) ` +
        `with no edge or link between them. They may be duplicates, ` +
        `counterparts, or simply neighbours; decide which, and do nothing ` +
        `if they are distinct.`,
    });
    if (r.ok && !r.repeat) raised++;
  }
  return raised;
}
