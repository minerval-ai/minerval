/**
 * Consistency sweeps (#330; docs/allocation.md, "Consistency sweeps").
 *
 * The constitution asks for it in so many words (Part VII, §21): "The
 * graph's assessments must cohere along its edges... Periodic sweeps hunt
 * for incoherence. Each find is a defect in an assessment or in the
 * structure." This module is the MECHANISM around the agent that does the
 * hunting, in the ledger's sense:
 *
 *   - sweep bookkeeping (consistency_sweeps): which partition of the graph
 *     a sweep covered, when, and what it found, which is the coverage
 *     record the scheduler reads to pick the next partition;
 *   - the candidate list a sweep is shown: the coherence pre-filter's
 *     shortlist (coherence-service.ts) minus what is already in hand (a
 *     primary with an open flag) or already judged tenable on the same
 *     assessments (a live dismissal);
 *   - the flag write path, which mirrors a Lookout's flag_reassessment
 *     step for step: the primary claim's Steward is enqueued with the
 *     tension as context, its assess group is ensured, and its standard
 *     action is valued on the General mandate at the checker's urgency,
 *     clamped to a ceiling. The General formula honors that value while
 *     the action stays open (mandate-valuer-service.ts); whether the pass
 *     RUNS is the allocator's call, like every other row;
 *   - the flag record, so the checker's precision ("did the passes its
 *     flags bought change anything?") is a query, as a Lookout's is.
 *
 * What the checker can cause is deliberately a candidate on the ledger,
 * never a conclusion: it writes no assessment, no edge and no importance,
 * and it moves no money.
 */
import { rawQuery } from "../db/client.js";
import { ensureAssessActions, ASSESS_GROUP } from "./action-service.js";
import { getGeneralMandate } from "./allocation-policy-service.js";
import {
  COHERENCE_KINDS,
  listCoherenceCandidates,
  type CoherenceCandidate,
  type CoherenceScope,
} from "./coherence-service.js";
import { setMandateValuations } from "./mandate-valuer-service.js";
import { enqueueSteward } from "./queue-service.js";

/** Kinds a flag or dismissal may carry: the pre-filter's, or a tension it cannot see. */
export const CONSISTENCY_FLAG_KINDS = [...COHERENCE_KINDS, "other"] as const;
export type ConsistencyFlagKind = (typeof CONSISTENCY_FLAG_KINDS)[number];

export const CONSISTENCY_BOUNDS = {
  rationaleChars: 2_000,
  noteChars: 2_000,
  /** Claims one flag, dismissal or comparison may name. */
  maxClaims: 8,
  /** A running sweep older than this is treated as abandoned. */
  reclaimHours: 2,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function clampReal(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** The claim ids a model named, de-duplicated, uuids only, primary first. */
function normalizeClaimIds(primary: string, raw: unknown): string[] {
  const out = [primary];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const id = String(v).trim();
      if (isUuid(id) && !out.includes(id)) out.push(id);
    }
  }
  return out.slice(0, CONSISTENCY_BOUNDS.maxClaims);
}

// ---------------------------------------------------------------------------
// Partitions and sweeps
// ---------------------------------------------------------------------------

export type SweepPartition =
  | { partition: "tag"; tagId: string; label: string }
  | { partition: "residual"; tagId: null; label: string }
  | { partition: "graph"; tagId: null; label: string };

export interface PartitionStatus {
  partition: "tag" | "residual";
  tag_id: string | null;
  label: string;
  /** Live claims in the partition. */
  claims: number;
  /** Sum of those claims' importance: where a sweep's budget lands first. */
  importance_mass: number;
  last_swept_at: Date | null;
  /** Assessments written on the partition's claims since its last sweep. */
  changed_since: number;
}

/**
 * Every sweep partition with its coverage record: each tag carrying at
 * least `minTagClaims` live claims, then one residual bucket for the live
 * claims no such tag covers. A two-claim tag cannot hold a cross-claim
 * tension worth a sweep of its own, so the long tail of small tags is
 * swept through the bucket instead.
 */
export async function listPartitions(minTagClaims: number): Promise<PartitionStatus[]> {
  const rows = await rawQuery<{
    partition: "tag" | "residual";
    tag_id: string | null;
    label: string;
    claims: number;
    importance_mass: number;
    last_swept_at: Date | null;
    changed_since: number;
  }>(
    `WITH live AS (
       SELECT id, importance FROM claims WHERE state = 'active' AND merged_into IS NULL
     ),
     tagged AS (
       SELECT tg.tag_id, l.id AS claim_id, l.importance
         FROM taggings tg
         JOIN live l ON l.id = tg.subject_id
         JOIN tags t ON t.id = tg.tag_id AND t.status = 'active'
        WHERE tg.subject_kind = 'claim'
     ),
     sweepable AS (
       SELECT tag_id FROM tagged GROUP BY tag_id HAVING COUNT(*) >= $1
     ),
     members AS (
       SELECT tag_id, claim_id, importance FROM tagged
        WHERE tag_id IN (SELECT tag_id FROM sweepable)
       UNION ALL
       SELECT NULL::uuid, l.id, l.importance FROM live l
        WHERE NOT EXISTS (SELECT 1 FROM tagged t
                           WHERE t.claim_id = l.id
                             AND t.tag_id IN (SELECT tag_id FROM sweepable))
     ),
     last_sweep AS (
       SELECT tag_id, partition, MAX(started_at) AS at
         FROM consistency_sweeps WHERE status = 'done'
        GROUP BY tag_id, partition
     )
     SELECT CASE WHEN m.tag_id IS NULL THEN 'residual' ELSE 'tag' END AS partition,
            m.tag_id,
            COALESCE(t.slug, 'residual') AS label,
            COUNT(*)::int AS claims,
            COALESCE(SUM(m.importance), 0)::real AS importance_mass,
            ls.at AS last_swept_at,
            (SELECT COUNT(*)::int FROM assessments a
              WHERE a.claim_id IN (SELECT claim_id FROM members m2
                                    WHERE m2.tag_id IS NOT DISTINCT FROM m.tag_id)
                AND (ls.at IS NULL OR a.assessed_at > ls.at)) AS changed_since
       FROM members m
       LEFT JOIN tags t ON t.id = m.tag_id
       LEFT JOIN last_sweep ls
              ON ls.tag_id IS NOT DISTINCT FROM m.tag_id
             AND ls.partition = CASE WHEN m.tag_id IS NULL THEN 'residual' ELSE 'tag' END
      GROUP BY m.tag_id, t.slug, ls.at`,
    [minTagClaims]
  );
  return rows.map((r) => ({
    ...r,
    claims: Number(r.claims),
    importance_mass: Number(r.importance_mass),
    changed_since: Number(r.changed_since),
  }));
}

/**
 * The partition due next, or null when nothing has changed anywhere since
 * its last sweep: never-swept partitions first, then the most assessments
 * written since the last sweep, then the most importance. A partition with
 * a sweep still running (younger than the reclaim window) is skipped.
 */
export async function nextSweepPartition(minTagClaims: number): Promise<SweepPartition | null> {
  const [partitions, running] = await Promise.all([
    listPartitions(minTagClaims),
    rawQuery<{ tag_id: string | null; partition: string }>(
      `SELECT tag_id, partition FROM consistency_sweeps
        WHERE status = 'running'
          AND started_at > now() - make_interval(hours => $1)`,
      [CONSISTENCY_BOUNDS.reclaimHours]
    ),
  ]);
  const busy = (p: PartitionStatus) =>
    running.some((r) => r.partition === p.partition && r.tag_id === p.tag_id);
  const due = partitions
    .filter((p) => p.claims > 0 && !busy(p))
    .filter((p) => p.last_swept_at === null || p.changed_since > 0)
    .sort((a, b) => {
      const neverA = a.last_swept_at === null ? 1 : 0;
      const neverB = b.last_swept_at === null ? 1 : 0;
      if (neverA !== neverB) return neverB - neverA;
      if (a.changed_since !== b.changed_since) return b.changed_since - a.changed_since;
      return b.importance_mass - a.importance_mass;
    });
  const next = due[0];
  if (!next) return null;
  return next.partition === "tag"
    ? { partition: "tag", tagId: next.tag_id!, label: next.label }
    : { partition: "residual", tagId: null, label: next.label };
}

/** The live claims no sweepable tag covers: the residual bucket's scope. */
export async function residualClaimIds(minTagClaims: number): Promise<string[]> {
  const rows = await rawQuery<{ id: string }>(
    `WITH sweepable AS (
       SELECT tg.tag_id
         FROM taggings tg
         JOIN claims c ON c.id = tg.subject_id
         JOIN tags t ON t.id = tg.tag_id AND t.status = 'active'
        WHERE tg.subject_kind = 'claim' AND c.state = 'active' AND c.merged_into IS NULL
        GROUP BY tg.tag_id HAVING COUNT(*) >= $1
     )
     SELECT c.id FROM claims c
      WHERE c.state = 'active' AND c.merged_into IS NULL
        AND NOT EXISTS (SELECT 1 FROM taggings tg
                         WHERE tg.subject_kind = 'claim' AND tg.subject_id = c.id
                           AND tg.tag_id IN (SELECT tag_id FROM sweepable))`,
    [minTagClaims]
  );
  return rows.map((r) => r.id);
}

/** The pre-filter scope a partition covers. */
export async function scopeForPartition(
  p: SweepPartition,
  minTagClaims: number
): Promise<CoherenceScope> {
  if (p.partition === "tag") return { tagId: p.tagId };
  if (p.partition === "residual") return { claimIds: await residualClaimIds(minTagClaims) };
  return {};
}

export async function startSweep(p: SweepPartition): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO consistency_sweeps (tag_id, partition) VALUES ($1, $2) RETURNING id`,
    [p.tagId, p.partition]
  );
  return row!.id;
}

export async function finishSweep(input: {
  sweepId: string;
  status: "done" | "error";
  runId?: string | null;
  candidatesFound: number;
  flagsRaised: number;
  dismissed: number;
  note?: string | null;
  error?: string | null;
}): Promise<void> {
  await rawQuery(
    `UPDATE consistency_sweeps
        SET status = $2, run_id = COALESCE($3, run_id), candidates_found = $4,
            flags_raised = $5, dismissed = $6, note = $7, error = $8,
            finished_at = now()
      WHERE id = $1`,
    [
      input.sweepId,
      input.status,
      input.runId ?? null,
      input.candidatesFound,
      input.flagsRaised,
      input.dismissed,
      input.note ? input.note.slice(0, CONSISTENCY_BOUNDS.noteChars) : null,
      input.error ? input.error.slice(0, 2_000) : null,
    ]
  );
}

/** Sweeps started at or after `since` (the per-period guard across tasks). */
export async function sweepsStartedSince(since: Date): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM consistency_sweeps WHERE started_at >= $1`,
    [since.toISOString()]
  );
  return Number(row?.n ?? 0);
}

/** Sweeps started since the start of the current UTC day (the daily cap). */
export async function sweepsStartedToday(now: Date = new Date()): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM consistency_sweeps
      WHERE started_at >= date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [now.toISOString()]
  );
  return Number(row?.n ?? 0);
}

/** Close sweeps left running past the reclaim window (a crashed process). */
export async function reclaimAbandonedSweeps(): Promise<number> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE consistency_sweeps
        SET status = 'error', error = 'abandoned', finished_at = now()
      WHERE status = 'running'
        AND started_at < now() - make_interval(hours => $1)
     RETURNING id`,
    [CONSISTENCY_BOUNDS.reclaimHours]
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function pairKey(kind: string, claimIds: readonly string[]): string {
  return `${kind}:${[...claimIds].sort().join(",")}`;
}

/**
 * The shortlist a sweep is shown: the pre-filter's candidates in scope,
 * most important first, minus
 *  - pairs dismissed on assessments that are all still current (a new
 *    assessment on either side reopens the question), and
 *  - pairs whose primary already carries an open consistency flag (its
 *    pass is already asked for; the pre-filter itself drops a primary
 *    whose Steward is pending or running).
 * Returns the filtered list and how many were suppressed.
 */
export async function sweepCandidates(
  scope: CoherenceScope,
  limit: number
): Promise<{ candidates: CoherenceCandidate[]; suppressed: number }> {
  // Over-fetch so suppression does not starve the sweep.
  const raw = await listCoherenceCandidates(scope, { limit: Math.min(500, limit * 3) });
  if (raw.length === 0) return { candidates: [], suppressed: 0 };
  const ids = [...new Set(raw.flatMap((c) => c.claim_ids))];
  const [dismissals, openFlags] = await Promise.all([
    rawQuery<{ kind: string; claim_ids: string[] }>(
      `SELECT d.kind, d.claim_ids FROM consistency_dismissals d
        WHERE d.claim_ids && $1::uuid[]
          AND NOT EXISTS (
            SELECT 1 FROM unnest(d.assessment_ids) x(id)
              LEFT JOIN assessments a ON a.id = x.id
             WHERE a.is_current IS DISTINCT FROM true)`,
      [ids]
    ),
    rawQuery<{ primary_claim_id: string }>(
      `SELECT DISTINCT f.primary_claim_id FROM consistency_flags f
         JOIN actions a ON a.id = f.action_id
        WHERE f.primary_claim_id = ANY($1::uuid[])
          AND a.status IN ('open', 'running')`,
      [ids]
    ),
  ]);
  const dismissed = new Set(dismissals.map((d) => pairKey(d.kind, d.claim_ids)));
  const flagged = new Set(openFlags.map((f) => f.primary_claim_id));
  const kept: CoherenceCandidate[] = [];
  let suppressed = 0;
  for (const c of raw) {
    if (dismissed.has(pairKey(c.kind, c.claim_ids)) || flagged.has(c.primary_claim_id)) {
      suppressed++;
      continue;
    }
    if (kept.length < limit) kept.push(c);
  }
  return { candidates: kept, suppressed };
}

export interface ComparedClaim {
  claim_id: string;
  text: string;
  importance: number;
  status: string | null;
  credence: number | null;
  confidence: number | null;
  assessed_at: string | null;
  model: string | null;
  summary: string | null;
  /** The head of the reasoning trace: where the verdict is argued. */
  trace_excerpt: string | null;
}

export interface ComparedRelation {
  kind: "edge" | "link";
  /** Edge: parent → child. Link: a ↔ b. */
  from: string;
  to: string;
  relation: string;
  reasoning: string;
}

const TRACE_EXCERPT_CHARS = 2_500;

/**
 * Up to CONSISTENCY_BOUNDS.maxClaims claims side by side with their current
 * assessments and every edge or link among them: the one read a coherence
 * judgment needs, so the agent does not rebuild it from a handful of
 * get_claim calls.
 */
export async function compareAssessments(
  rawIds: unknown
): Promise<{ claims: ComparedClaim[]; relations: ComparedRelation[]; unknown: string[] }> {
  const ids = (Array.isArray(rawIds) ? rawIds : [])
    .map((v) => String(v).trim())
    .filter(isUuid)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, CONSISTENCY_BOUNDS.maxClaims);
  if (ids.length === 0) return { claims: [], relations: [], unknown: [] };
  const rows = await rawQuery<{
    id: string;
    text: string;
    importance: number;
    status: string | null;
    claim_credence: number | null;
    confidence: number | null;
    assessed_at: Date | null;
    model: string | null;
    summary: string | null;
    reasoning_trace: string | null;
  }>(
    `SELECT c.id, c.text, c.importance, a.status, a.claim_credence, a.confidence,
            a.assessed_at, a.model, a.summary, a.reasoning_trace
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const claims: ComparedClaim[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      unknown.push(id);
      continue;
    }
    claims.push({
      claim_id: r.id,
      text: r.text,
      importance: Number(r.importance),
      status: r.status,
      credence: r.claim_credence,
      confidence: r.confidence,
      assessed_at: r.assessed_at ? new Date(r.assessed_at).toISOString() : null,
      model: r.model,
      summary: r.summary,
      trace_excerpt: r.reasoning_trace ? r.reasoning_trace.slice(0, TRACE_EXCERPT_CHARS) : null,
    });
  }
  const known = claims.map((c) => c.claim_id);
  const [edges, links] = await Promise.all([
    rawQuery<{ parent_claim_id: string; child_claim_id: string; relation_type: string; reasoning: string }>(
      `SELECT parent_claim_id, child_claim_id, relation_type, reasoning
         FROM claim_relationships
        WHERE parent_claim_id = ANY($1::uuid[]) AND child_claim_id = ANY($1::uuid[])`,
      [known]
    ),
    rawQuery<{ claim_a_id: string; claim_b_id: string; kind: string; reasoning: string }>(
      `SELECT claim_a_id, claim_b_id, kind, reasoning
         FROM claim_links
        WHERE claim_a_id = ANY($1::uuid[]) AND claim_b_id = ANY($1::uuid[])`,
      [known]
    ),
  ]);
  const relations: ComparedRelation[] = [
    ...edges.map((e) => ({
      kind: "edge" as const,
      from: e.parent_claim_id,
      to: e.child_claim_id,
      relation: e.relation_type,
      reasoning: e.reasoning,
    })),
    ...links.map((l) => ({
      kind: "link" as const,
      from: l.claim_a_id,
      to: l.claim_b_id,
      relation: l.kind,
      reasoning: l.reasoning,
    })),
  ];
  return { claims, relations, unknown };
}

// ---------------------------------------------------------------------------
// Flags and dismissals
// ---------------------------------------------------------------------------

export type ConsistencyFlagResult =
  | {
      ok: true;
      flag_id: string;
      duplicate: false;
      action_id: string | null;
      value_written: number | null;
      note: string;
    }
  | { ok: true; flag_id: string; duplicate: true; note: string }
  | { ok: false; code: string; problem: string };

function describeAssessment(a: { status: string | null; claim_credence: number | null } | undefined): string {
  if (!a || !a.status) return "unassessed";
  return a.claim_credence !== null && a.claim_credence !== undefined
    ? `${a.status}, credence ${Number(a.claim_credence).toFixed(2)}`
    : a.status;
}

/**
 * The Steward's trigger context for a flag: the tension in the checker's
 * words, the neighbors with their current verdicts, and the three ways a
 * reconciliation can go.
 */
export function consistencyFlagContext(input: {
  kind: string;
  rationale: string;
  primary: { id: string; status: string | null; claim_credence: number | null };
  others: Array<{ id: string; text: string; status: string | null; claim_credence: number | null }>;
}): string {
  const neighbors = input.others
    .map((o) => `- ${o.id} "${o.text.slice(0, 160)}" (${describeAssessment(o)})`)
    .join("\n");
  return (
    `A consistency sweep finds that this claim's assessment (${describeAssessment(input.primary)}) ` +
    `cannot stand together with its neighbors' as the edges between them read ` +
    `(check: ${input.kind}).\n${neighbors}\n` +
    `The checker's reading: ${input.rationale}\n` +
    `Reconcile it. The defect may be in this verdict (revise it), in a ` +
    `neighbor's (say so in your reasoning), or in the edge itself (fix it if ` +
    `it is in your decomposition, else escalate to the Curator). Or the ` +
    `tension may be apparent and your reasoning should say why both verdicts ` +
    `stand. The checker judges coherence, never truth: verify before anything ` +
    `changes.`
  );
}

/**
 * Raise a flag: the primary claim becomes a candidate (enqueued to the
 * Steward lane with trigger consistency_flag, which opens its assess
 * group), and the General mandate values its standard variant at the
 * checker's urgency clamped to `maxValue`. The value is recorded on the
 * flag, and the General formula refresh keeps it as a floor while the
 * action stays open. Whether the pass runs is the allocator's call.
 *
 * Folding: a flag on a primary that already carries an open flag (its
 * action open or running, or no action yet and under a week old) is a
 * repeat, not a new flag, and rewrites nothing.
 */
export async function flagInconsistency(input: {
  sweepId: string | null;
  kind: string;
  primaryClaimId: string;
  claimIds: unknown;
  rationale: string;
  urgency: number;
  maxValue: number;
}): Promise<ConsistencyFlagResult> {
  const rationale = String(input.rationale ?? "").trim().slice(0, CONSISTENCY_BOUNDS.rationaleChars);
  if (rationale.length < 20) {
    return { ok: false, code: "RATIONALE", problem: "Say which verdicts cannot both stand and why, in a sentence or two" };
  }
  if (!(CONSISTENCY_FLAG_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, code: "KIND", problem: `kind must be one of ${CONSISTENCY_FLAG_KINDS.join(", ")}` };
  }
  if (!isUuid(input.primaryClaimId)) {
    return { ok: false, code: "CLAIM", problem: "primary_claim_id must be a claim id you saw in a tool result" };
  }
  const claimIds = normalizeClaimIds(input.primaryClaimId, input.claimIds);
  if (claimIds.length < 2) {
    return { ok: false, code: "CLAIMS", problem: "Name at least one other claim in the tension (claim_ids)" };
  }
  const rows = await rawQuery<{ id: string; text: string; state: string; status: string | null; claim_credence: number | null; assessment_id: string | null }>(
    `SELECT c.id, c.text, c.state, a.status, a.claim_credence, a.id AS assessment_id
       FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      WHERE c.id = ANY($1::uuid[])`,
    [claimIds]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const primary = byId.get(input.primaryClaimId);
  if (!primary || primary.state !== "active") {
    return { ok: false, code: "CLAIM", problem: "No active claim with that primary_claim_id" };
  }
  const missing = claimIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { ok: false, code: "CLAIMS", problem: `Unknown claim id(s): ${missing.join(", ")}` };
  }

  const [open] = await rawQuery<{ id: string; created_at: Date }>(
    `SELECT f.id, f.created_at
       FROM consistency_flags f
       LEFT JOIN actions a ON a.id = f.action_id
      WHERE f.primary_claim_id = $1
        AND (a.status IN ('open', 'running')
             OR (f.action_id IS NULL AND f.created_at > now() - interval '7 days'))
      ORDER BY f.created_at DESC LIMIT 1`,
    [input.primaryClaimId]
  );
  if (open) {
    await rawQuery(
      `UPDATE consistency_flags SET repeats = repeats + 1, updated_at = now() WHERE id = $1`,
      [open.id]
    );
    return {
      ok: true,
      flag_id: open.id,
      duplicate: true,
      note:
        `This claim was already flagged on ${new Date(open.created_at).toISOString().slice(0, 10)} ` +
        `and its pass is still waiting; counted as a repeat, nothing rewritten.`,
    };
  }

  const urgency = clampReal(input.urgency, 0, 10, 5);
  const value = Math.min(urgency, clampReal(input.maxValue, 0, 10, 0));
  const others = claimIds.slice(1).map((id) => {
    const r = byId.get(id)!;
    return { id, text: r.text, status: r.status, claim_credence: r.claim_credence };
  });

  await enqueueSteward({
    claimId: input.primaryClaimId,
    trigger: "consistency_flag",
    context: consistencyFlagContext({
      kind: input.kind,
      rationale,
      primary: { id: primary.id, status: primary.status, claim_credence: primary.claim_credence },
      others,
    }),
  });
  await ensureAssessActions(input.primaryClaimId);
  const [standard] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions
      WHERE exclusion_group = $1 AND variant = 'standard' AND status = 'open'
      LIMIT 1`,
    [ASSESS_GROUP(input.primaryClaimId)]
  );
  const general = await getGeneralMandate();
  let valueWritten: number | null = null;
  if (general && standard && value > 0) {
    const res = await setMandateValuations(general.grantId, [
      { action_id: standard.id, value, rationale: `[consistency] ${rationale}` },
    ]);
    if (res.written > 0) valueWritten = value;
  }
  const [flag] = await rawQuery<{ id: string }>(
    `INSERT INTO consistency_flags
       (sweep_id, kind, primary_claim_id, claim_ids, grant_id, action_id, rationale,
        urgency, value_written, status_at_flag, credence_at_flag, assessment_id_at_flag)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.sweepId,
      input.kind,
      input.primaryClaimId,
      claimIds,
      valueWritten !== null ? general!.grantId : null,
      standard?.id ?? null,
      rationale,
      urgency,
      valueWritten,
      primary.status,
      primary.claim_credence,
      primary.assessment_id,
    ]
  );
  return {
    ok: true,
    flag_id: flag!.id,
    duplicate: false,
    action_id: standard?.id ?? null,
    value_written: valueWritten,
    note:
      valueWritten === null
        ? "Recorded, and the claim's Steward is queued with your reading; no valuation written (no General mandate, a ceiling of 0, or no open ledger row)."
        : `Recorded. The claim is a candidate for a reassessment valued at ${valueWritten}/10; the allocator decides whether that buys a pass.`,
  };
}

/**
 * Record that a candidate was read and judged jointly tenable. The pair is
 * suppressed from later sweeps while every assessment it was judged on
 * stays current.
 */
export async function dismissCandidate(input: {
  sweepId: string | null;
  kind: string;
  claimIds: unknown;
  reason: string;
}): Promise<{ ok: true; dismissal_id: string } | { ok: false; code: string; problem: string }> {
  const reason = String(input.reason ?? "").trim().slice(0, CONSISTENCY_BOUNDS.rationaleChars);
  if (reason.length < 10) return { ok: false, code: "REASON", problem: "Say why both verdicts can stand" };
  if (!(CONSISTENCY_FLAG_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, code: "KIND", problem: `kind must be one of ${CONSISTENCY_FLAG_KINDS.join(", ")}` };
  }
  const ids = (Array.isArray(input.claimIds) ? input.claimIds : [])
    .map((v) => String(v).trim())
    .filter(isUuid)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, CONSISTENCY_BOUNDS.maxClaims)
    .sort();
  if (ids.length < 2) return { ok: false, code: "CLAIMS", problem: "Name the claims in the candidate (claim_ids)" };
  const current = await rawQuery<{ id: string }>(
    `SELECT id FROM assessments WHERE claim_id = ANY($1::uuid[]) AND is_current = true`,
    [ids]
  );
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO consistency_dismissals (sweep_id, kind, claim_ids, assessment_ids, reason)
     VALUES ($1, $2, $3::uuid[], $4::uuid[], $5) RETURNING id`,
    [input.sweepId, input.kind, ids, current.map((c) => c.id), reason]
  );
  return { ok: true, dismissal_id: row!.id };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface ConsistencyFlagRow {
  id: string;
  sweep_id: string | null;
  kind: string;
  primary_claim_id: string;
  claim_text: string | null;
  claim_ids: string[];
  action_id: string | null;
  action_status: string | null;
  rationale: string;
  urgency: number | null;
  value_written: number | null;
  status_at_flag: string | null;
  credence_at_flag: number | null;
  status_now: string | null;
  credence_now: number | null;
  /** A new assessment landed on the primary after the flag. */
  ran: boolean;
  /** ...and it changed status, or credence by more than 0.1. */
  moved: boolean;
  repeats: number;
  created_at: Date;
}

const FLAG_SELECT = `
  SELECT f.id, f.sweep_id, f.kind, f.primary_claim_id, c.text AS claim_text, f.claim_ids,
         f.action_id, a.status AS action_status, f.rationale, f.urgency, f.value_written,
         f.status_at_flag, f.credence_at_flag,
         cur.status AS status_now, cur.claim_credence AS credence_now,
         (cur.id IS NOT NULL AND cur.id IS DISTINCT FROM f.assessment_id_at_flag) AS ran,
         (cur.id IS NOT NULL AND cur.id IS DISTINCT FROM f.assessment_id_at_flag
          AND (cur.status IS DISTINCT FROM f.status_at_flag
               OR ABS(COALESCE(cur.claim_credence, 0) - COALESCE(f.credence_at_flag, 0)) > 0.1)) AS moved,
         f.repeats, f.created_at
    FROM consistency_flags f
    LEFT JOIN claims c ON c.id = f.primary_claim_id
    LEFT JOIN actions a ON a.id = f.action_id
    LEFT JOIN assessments cur ON cur.claim_id = f.primary_claim_id AND cur.is_current = true`;

export async function listConsistencyFlags(
  opts: { limit?: number; since?: Date | null; sweepId?: string | null } = {}
): Promise<ConsistencyFlagRow[]> {
  return rawQuery<ConsistencyFlagRow>(
    `${FLAG_SELECT}
      WHERE ($2::timestamptz IS NULL OR f.created_at > $2)
        AND ($3::uuid IS NULL OR f.sweep_id = $3)
      ORDER BY f.created_at DESC LIMIT $1`,
    [opts.limit ?? 50, opts.since ?? null, opts.sweepId ?? null]
  );
}

export interface ConsistencyPrecision {
  flagged: number;
  ran: number;
  moved: number;
  repeats: number;
}

/**
 * The checker's track record: of the passes its flags asked for, how many
 * ran and how many changed the primary's verdict or credence. A pass that
 * ran and changed nothing is not necessarily a wasted one (the Steward may
 * have recorded why both verdicts stand), but a checker whose flags never
 * move anything is spending attention on noise.
 */
export async function consistencyPrecision(opts: { since?: Date | null } = {}): Promise<ConsistencyPrecision> {
  const [row] = await rawQuery<{ flagged: number; ran: number; moved: number; repeats: number }>(
    `SELECT COUNT(*)::int AS flagged,
            COUNT(*) FILTER (WHERE ran)::int AS ran,
            COUNT(*) FILTER (WHERE moved)::int AS moved,
            COALESCE(SUM(repeats), 0)::int AS repeats
       FROM (${FLAG_SELECT} WHERE ($1::timestamptz IS NULL OR f.created_at > $1)) flags`,
    [opts.since ?? null]
  );
  return {
    flagged: Number(row?.flagged ?? 0),
    ran: Number(row?.ran ?? 0),
    moved: Number(row?.moved ?? 0),
    repeats: Number(row?.repeats ?? 0),
  };
}

export async function listSweeps(limit = 20): Promise<Array<{
  id: string;
  tag_id: string | null;
  tag_slug: string | null;
  partition: string;
  status: string;
  candidates_found: number;
  flags_raised: number;
  dismissed: number;
  note: string | null;
  started_at: Date;
  finished_at: Date | null;
}>> {
  return rawQuery(
    `SELECT s.id, s.tag_id, t.slug AS tag_slug, s.partition, s.status, s.candidates_found,
            s.flags_raised, s.dismissed, s.note, s.started_at, s.finished_at
       FROM consistency_sweeps s LEFT JOIN tags t ON t.id = s.tag_id
      ORDER BY s.started_at DESC LIMIT $1`,
    [limit]
  );
}
