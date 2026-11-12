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
 *  - every request names the structural defect it suspects (#955), who raised
 *    it and, when there is one, the other node; a producer with nothing to
 *    name opens no row;
 *  - one live request per (anchor, other claim, source): a repeat is a repeat;
 *    distinct concerns are never refused, since a request only waits on the
 *    ledger until someone values and funds the curation that reads it;
 *  - the reconcile-candidate scan raises at most its policy's per-sweep cap.
 *
 * The one entry point for opening a curate row. The lockdown test
 * (tests/unit/workers/curation-trigger-lockdown.test.ts) holds every other
 * path under src/ to it.
 */
import { rawQuery } from "../db/client.js";
import { ensureCurateAction } from "./action-service.js";
import { recordEnqueueEvent } from "./enqueue-events-service.js";

// Who asked. Every source but the scan is an agent's or a person's
// judgment; the General mandate's officers read the source when deciding
// whether the curation is worth commissioning:
//  - steward_escalation: a Steward, about its own claim;
//  - consistency_sweep: the Consistency Checker found a structural defect
//    (two nodes that are one, a conflation, a wrong kind, a mislabeled edge)
//    while reading a partition side by side (#742);
//  - audit: the Audit Agent, on a finding it recorded (#784);
//  - matcher: at ingestion, the Matcher minted a node on balance and named
//    a near-miss a Curator should check (curator_review, #738);
//  - reconcile_candidate: the similarity scan;
//  - operator: a person running the platform.
export const CURATION_SOURCES = [
  "steward_escalation",
  "consistency_sweep",
  "audit",
  "matcher",
  "reconcile_candidate",
  "operator",
] as const;
export type CurationSource = (typeof CURATION_SOURCES)[number];

// What the requester suspects is wrong (#955). Every request names one, so
// what reaches the officers and the Curator says what opened the row rather
// than only which node it is about; a producer with no defect to name opens
// no curate row. `other` is for a structural defect none of these fits, and
// its concern must say what it is.
//  - duplicate: the anchor and another node are one node (in other words, or
//    as its negation): a merge;
//  - conflation: the anchor holds distinct propositions: a split;
//  - wrong_kind: the anchor is a claim that should be a quantity or a
//    question, or the reverse;
//  - mislabeled_edge: an edge between the anchor and another node carries the
//    wrong relation;
//  - missing_link: the anchor and another node constrain each other and are
//    not linked;
//  - bad_merge: a merge into the anchor joined nodes that were distinct;
//  - other: another structural defect, said in the concern.
export const CURATION_DEFECTS = [
  "duplicate",
  "conflation",
  "wrong_kind",
  "mislabeled_edge",
  "missing_link",
  "bad_merge",
  "other",
] as const;
export type CurationDefect = (typeof CURATION_DEFECTS)[number];

/** The defects, in the words a tool description or a briefing uses. */
export const CURATION_DEFECT_WORDS: Record<CurationDefect, string> = {
  duplicate: "suspected duplicate (the same node in other words, or its negation)",
  conflation: "suspected conflation (one node holding distinct propositions)",
  wrong_kind: "suspected wrong kind (claim, quantity or question)",
  mislabeled_edge: "an edge that looks mislabeled",
  missing_link: "a missing lateral link",
  bad_merge: "a suspected bad merge",
  other: "another structural defect",
};

/** A tool's description of the defect parameter, kept in one place. */
export const CURATION_DEFECT_DESCRIPTION =
  "What you suspect is wrong: " +
  CURATION_DEFECTS.map((d) => `${d}: ${CURATION_DEFECT_WORDS[d]}`).join("; ") +
  ". Required: a concern with no structural defect to name opens no curation. " +
  "Use 'other' only when none fits, and say in the concern what the defect is.";

export function isCurationDefect(v: unknown): v is CurationDefect {
  return typeof v === "string" && (CURATION_DEFECTS as readonly string[]).includes(v);
}

export interface CurationRequestInput {
  anchorClaimId: string;
  otherClaimId?: string | null;
  source: CurationSource;
  /** What the requester suspects is wrong; required (#955). */
  defect: CurationDefect;
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
 * The longest concern a request records: the Curator's run reads every
 * concern on its anchor in its briefing. An over-long one is refused with
 * the limit named, never cut, so the requester can say it more briefly.
 */
export const CURATION_CONCERN_MAX_CHARS = 4_000;

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
  if (!isCurationDefect(input.defect)) {
    return {
      ok: false,
      problem:
        `defect ${JSON.stringify(input.defect ?? null)} is not one of ${CURATION_DEFECTS.join(", ")}. ` +
        `Nothing was recorded: a curation is opened only for a structural defect it names.`,
    };
  }
  if (!concern) return { ok: false, problem: "a concern is required" };
  if (concern.length > CURATION_CONCERN_MAX_CHARS) {
    return {
      ok: false,
      problem:
        `the concern is ${concern.length} characters; it may be at most ` +
        `${CURATION_CONCERN_MAX_CHARS}. Nothing was recorded: state it more briefly.`,
    };
  }

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

  const inserted = await rawQuery<{ id: string }>(
    `INSERT INTO curation_requests
       (anchor_claim_id, other_claim_id, source, concern, signal,
        requested_by_claim_id, requested_by_run_id, defect)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.anchorClaimId,
      input.otherClaimId ?? null,
      input.source,
      concern,
      input.signal ?? null,
      input.requestedByClaimId ?? null,
      input.requestedByRunId ?? null,
      input.defect,
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
      await fundCurationNow(actionId, { requestId: inserted[0]!.id });
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
  /** The other node's text when it is active, read with the request. */
  other_claim_text: string | null;
  source: CurationSource;
  /** Null only on a request recorded before requests named one (#955). */
  defect: CurationDefect | null;
  concern: string;
  signal: number | null;
  requested_by_claim_id: string | null;
  created_at: Date;
}

/**
 * The columns a LiveCurationRequest reads, from `curation_requests r` joined
 * to the other node as `o`.
 */
export const LIVE_CURATION_REQUEST_SELECT = `
  SELECT r.id, r.other_claim_id, o.text AS other_claim_text, r.source, r.defect,
         r.concern, r.signal, r.requested_by_claim_id, r.created_at
    FROM curation_requests r
    LEFT JOIN claims o ON o.id = r.other_claim_id AND o.state = 'active'`;

/** Every live request on an anchor, oldest first: what one run reads. */
export async function liveCurationRequests(
  anchorClaimId: string
): Promise<LiveCurationRequest[]> {
  return rawQuery<LiveCurationRequest>(
    `${LIVE_CURATION_REQUEST_SELECT}
      WHERE r.anchor_claim_id = $1 AND r.consumed_at IS NULL
      ORDER BY r.created_at ASC
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

/**
 * Who raised a request, in words. Given the anchor, a Steward that escalated
 * about its own node reads as "this node's Steward".
 */
export function describeCurationRaiser(
  r: Pick<LiveCurationRequest, "source" | "signal" | "requested_by_claim_id">,
  anchorClaimId?: string | null
): string {
  switch (r.source) {
    case "steward_escalation":
      return r.requested_by_claim_id && r.requested_by_claim_id !== anchorClaimId
        ? `the Steward of ${r.requested_by_claim_id}`
        : "this node's Steward";
    case "consistency_sweep":
      return "a consistency sweep, reading its partition side by side";
    case "audit":
      return "the Audit Agent, on a finding it recorded";
    case "matcher":
      return "the Matcher, which minted this node at ingestion on balance";
    case "reconcile_candidate":
      return `the reconcile-candidate scan (embedding similarity ${Number(r.signal ?? 0).toFixed(3)}; a scan, not a judgment)`;
    case "operator":
      return "an operator";
  }
}

/**
 * One request as the officers and the Curator read it (#955): the defect
 * suspected, who raised it, the other node with its text, and the concern in
 * the requester's words.
 */
export function describeCurationRequest(
  r: Pick<
    LiveCurationRequest,
    "source" | "signal" | "requested_by_claim_id" | "defect" | "other_claim_id" | "other_claim_text" | "concern"
  >,
  anchorClaimId?: string | null,
  opts: { maxConcernChars?: number } = {}
): string {
  const max = opts.maxConcernChars;
  const said = r.concern.trim();
  const concern = max && said.length > max ? `${said.slice(0, max)}… (cut here; the Curator reads it whole)` : said;
  const defect = r.defect
    ? CURATION_DEFECT_WORDS[r.defect]
    : "defect not classified (recorded before requests named one; the concern says what was seen)";
  const other = r.other_claim_id
    ? `; the other node: ${r.other_claim_id}` +
      (r.other_claim_text ? ` ("${r.other_claim_text.slice(0, 200)}")` : " (no longer active)")
    : "";
  return `${defect}, raised by ${describeCurationRaiser(r, anchorClaimId)}${other}. Concern: ${concern}`;
}

/** The run's briefing: each live request, as describeCurationRequest says it. */
export function describeCurationRequests(
  requests: LiveCurationRequest[],
  anchorClaimId?: string | null
): string {
  if (requests.length === 0) return "(no live requests)";
  return requests.map((r, i) => `${i + 1}. ${describeCurationRequest(r, anchorClaimId)}`).join("\n");
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
      defect: "duplicate",
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
