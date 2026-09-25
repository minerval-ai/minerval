/**
 * Consistency sweeps (#330; docs/allocation.md, "Consistency sweeps").
 *
 * The constitution asks for it (Part VII, §21): the graph's assessments
 * must cohere, and periodic sweeps hunt for incoherence. The incoherence
 * worth hunting is rarely two verdicts flatly opposed; it is reasoning in
 * one assessment that conflicts with reasoning in a neighbor's, evidence
 * recorded under one claim that another's assessment never weighed, a
 * verdict that is not a defensible function of what it rests on. Finding
 * that takes reading, so the Consistency Checker is an agent that reads a
 * partition of the graph; there is no mechanical pre-filter. This module
 * is the MECHANISM around it, in the ledger's sense:
 *
 *   - sweep bookkeeping (consistency_sweeps): which partition of the graph
 *     a sweep covered, when, and what it found, which is the coverage
 *     record the scheduler reads to pick the next partition, and the
 *     sweep's note, which briefs the next sweep of the same partition;
 *   - the partition's claims as the agent reads them: assessed claims,
 *     those re-assessed since the last sweep first, then by importance;
 *   - the flag write path: the primary claim's Steward is enqueued with
 *     the tension as context, which opens its assess group on the ledger,
 *     and the flag records the checker's estimate that a fresh pass would
 *     change something (expected_gain). That estimate is the flag's whole
 *     say in allocation: while the group stays open it enters the formula
 *     mandates' expected-quality-gain term beside the Steward's own
 *     marginal-yield estimate and staleness (mandate-valuer-service.ts),
 *     so importance and contestation weigh a flagged pass exactly as they
 *     weigh any other, and the allocator decides whether it runs;
 *   - the flag record, so the checker's precision ("did the passes its
 *     flags bought change anything?") is a query, as a Lookout's is.
 *
 * What the checker can cause is deliberately a candidate, never a
 * conclusion: it writes no assessment, no edge, no importance and no
 * valuation, and it moves no money.
 */
import { rawQuery } from "../db/client.js";
import { ensureAssessActions, ASSESS_GROUP } from "./action-service.js";
import { enqueueSteward } from "./queue-service.js";

/**
 * What kind of incoherence a flag names. A label for the record and the
 * precision read, not a rule: the checker's rationale is the substance.
 */
export const CONSISTENCY_FLAG_KINDS = [
  // Two assessments rest on reasoning that cannot both hold: one treats as
  // established what the other argues is doubtful, or they read the same
  // evidence in incompatible ways.
  "reasoning_conflict",
  // An assessment never weighs evidence or argument recorded under another
  // claim that bears on it directly.
  "overlooked_evidence",
  // A verdict that is not a defensible function of its subclaims and direct
  // evidence, or dependents that presuppose different verdicts on the same
  // upstream claim.
  "dependency_mismatch",
  // An assessment that rests on a neighbor's verdict that has since changed.
  "stale_premise",
  "other",
] as const;
export type ConsistencyFlagKind = (typeof CONSISTENCY_FLAG_KINDS)[number];

export const CONSISTENCY_BOUNDS = {
  rationaleChars: 2_000,
  /** The sweep note is the checker's memory of a partition. */
  noteChars: 4_000,
  /** Claims one flag or comparison may name. */
  maxClaims: 8,
  /** A running sweep older than this is treated as abandoned. */
  reclaimHours: 2,
  /**
   * A partition swept more recently than this is not due, however much in
   * it changed: the passes a sweep's own flags buy land one by one, and the
   * next sweep should read their outcome together, not chase each.
   */
  resweepHours: 24,
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
 * The partitions due a sweep, most due first: never-swept partitions,
 * then the most assessments written since the last sweep, then the most
 * importance. A partition where nothing was re-assessed since its last
 * sweep is not due (the sweep would read what it already read), nor is one
 * swept within CONSISTENCY_BOUNDS.resweepHours, nor one with a sweep still
 * running (younger than the reclaim window).
 */
export async function duePartitions(minTagClaims: number): Promise<SweepPartition[]> {
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
    .filter(
      (p) =>
        p.last_swept_at === null ||
        (p.changed_since > 0 &&
          Date.now() - new Date(p.last_swept_at).getTime() >= CONSISTENCY_BOUNDS.resweepHours * 3_600_000)
    )
    .sort((a, b) => {
      const neverA = a.last_swept_at === null ? 1 : 0;
      const neverB = b.last_swept_at === null ? 1 : 0;
      if (neverA !== neverB) return neverB - neverA;
      if (a.changed_since !== b.changed_since) return b.changed_since - a.changed_since;
      return b.importance_mass - a.importance_mass;
    });
  return due.map(toSweepPartition);
}

function toSweepPartition(p: PartitionStatus): SweepPartition {
  return p.partition === "tag"
    ? { partition: "tag", tagId: p.tag_id!, label: p.label }
    : { partition: "residual", tagId: null, label: p.label };
}

/** The partition due next, or null when none is. */
export async function nextSweepPartition(minTagClaims: number): Promise<SweepPartition | null> {
  return (await duePartitions(minTagClaims))[0] ?? null;
}

/** A sweep row's target_ref: the tag id, or "residual". */
export function partitionRef(p: SweepPartition): string {
  return p.partition === "tag" ? p.tagId : p.partition;
}

/** The partition a sweep row's target_ref names, or null if it no longer exists. */
export async function partitionFromRef(ref: string): Promise<SweepPartition | null> {
  if (ref === "residual") return { partition: "residual", tagId: null, label: "residual" };
  if (ref === "graph") return { partition: "graph", tagId: null, label: "whole graph" };
  if (!isUuid(ref)) return null;
  const [tag] = await rawQuery<{ id: string; slug: string }>(
    `SELECT id, slug FROM tags WHERE id = $1 AND status = 'active'`,
    [ref]
  );
  return tag ? { partition: "tag", tagId: tag.id, label: tag.slug } : null;
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

/**
 * The claims a partition covers: a tag's live claims, the residual
 * bucket's, or null for the whole graph.
 */
export interface PartitionScope {
  tagId?: string | null;
  claimIds?: string[] | null;
}

export async function scopeForPartition(
  p: SweepPartition,
  minTagClaims: number
): Promise<PartitionScope> {
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
  claimsInScope: number;
  flagsRaised: number;
  note?: string | null;
  error?: string | null;
}): Promise<void> {
  await rawQuery(
    `UPDATE consistency_sweeps
        SET status = $2, run_id = COALESCE($3, run_id), claims_in_scope = $4,
            flags_raised = $5, note = $6, error = $7, finished_at = now()
      WHERE id = $1`,
    [
      input.sweepId,
      input.status,
      input.runId ?? null,
      input.claimsInScope,
      input.flagsRaised,
      input.note ? input.note.slice(0, CONSISTENCY_BOUNDS.noteChars) : null,
      input.error ? input.error.slice(0, 2_000) : null,
    ]
  );
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
// What a sweep reads
// ---------------------------------------------------------------------------

export interface PartitionClaim {
  claim_id: string;
  text: string;
  importance: number;
  status: string;
  credence: number | null;
  confidence: number;
  assessed_at: string;
  /** Re-assessed since this partition's last sweep (or never swept). */
  changed: boolean;
  summary: string | null;
  /** Edges out of (subclaims) and into (dependents) this claim. */
  subclaims: number;
  dependents: number;
  /** A consistency flag on this claim is still waiting for its pass. */
  flag_open: boolean;
  /**
   * Its Steward is already queued or running (for any reason): its verdict
   * is about to be looked at again, so flagging it adds nothing, but it
   * stays in the listing as context for reading its neighbors.
   */
  steward_pending: boolean;
}

/**
 * The partition's assessed claims as a sweep reads them: those re-assessed
 * since `since` first (where new incoherence comes from), then by
 * importance. A claim whose Steward is already queued is listed, and
 * marked: it is still the context its neighbors are read against.
 */
export async function partitionClaims(
  scope: PartitionScope,
  opts: { since?: Date | null; limit?: number; offset?: number } = {}
): Promise<{ total: number; claims: PartitionClaim[] }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await rawQuery<PartitionClaim & { total: number; assessed_at: Date }>(
    `WITH scoped AS (
       SELECT subject_id AS claim_id FROM taggings
        WHERE $1::uuid IS NOT NULL AND tag_id = $1::uuid AND subject_kind = 'claim'
       UNION
       SELECT unnest($2::uuid[])
     )
     SELECT c.id AS claim_id, c.text, c.importance, a.status, a.claim_credence AS credence,
            a.confidence, a.assessed_at, a.summary,
            ($3::timestamptz IS NULL OR a.assessed_at > $3) AS changed,
            (SELECT COUNT(*)::int FROM claim_relationships r WHERE r.parent_claim_id = c.id) AS subclaims,
            (SELECT COUNT(*)::int FROM claim_relationships r WHERE r.child_claim_id = c.id) AS dependents,
            EXISTS (SELECT 1 FROM consistency_flags f JOIN actions x ON x.id = f.action_id
                     WHERE f.primary_claim_id = c.id AND x.status IN ('open', 'running')) AS flag_open,
            (c.steward_state IN ('pending', 'running')) AS steward_pending,
            COUNT(*) OVER ()::int AS total
       FROM claims c
       JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      WHERE c.state = 'active' AND c.merged_into IS NULL
        AND (($1::uuid IS NULL AND $2::uuid[] IS NULL) OR c.id IN (SELECT claim_id FROM scoped))
      ORDER BY changed DESC, c.importance DESC, c.id
      LIMIT $4 OFFSET $5`,
    [scope.tagId ?? null, scope.claimIds ?? null, opts.since ?? null, limit, offset]
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    claims: rows.map(({ total: _total, ...r }) => ({
      ...r,
      importance: Number(r.importance),
      assessed_at: new Date(r.assessed_at).toISOString(),
    })),
  };
}

/** When this partition was last swept to completion, and that sweep's note. */
export async function lastSweepOf(
  p: SweepPartition
): Promise<{ started_at: Date; note: string | null } | null> {
  const [row] = await rawQuery<{ started_at: Date; note: string | null }>(
    `SELECT started_at, note FROM consistency_sweeps
      WHERE status = 'done' AND partition = $1 AND tag_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY started_at DESC LIMIT 1`,
    [p.partition, p.tagId]
  );
  return row ?? null;
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
// Flags
// ---------------------------------------------------------------------------

export type ConsistencyFlagResult =
  | {
      ok: true;
      flag_id: string;
      duplicate: false;
      action_id: string | null;
      expected_gain: number;
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
    `does not cohere with what the graph records about these claims (${input.kind}):\n${neighbors}\n` +
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
 * Steward lane with trigger consistency_flag and the tension as context,
 * which opens its assess group), and the flag's expected_gain enters the
 * formula mandates' valuation of that group while it stays open. Nothing
 * here writes a valuation: the formula prices the pass like any other,
 * and the allocator decides whether it runs.
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
  expectedGain: number;
}): Promise<ConsistencyFlagResult> {
  const rationale = String(input.rationale ?? "").trim().slice(0, CONSISTENCY_BOUNDS.rationaleChars);
  if (rationale.length < 20) {
    return { ok: false, code: "RATIONALE", problem: "Say what does not cohere and why, in a few sentences" };
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
  if (!primary.assessment_id) {
    return { ok: false, code: "UNASSESSED", problem: "The primary claim has no assessment yet; there is nothing to reconcile" };
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

  const expectedGain = clampReal(input.expectedGain, 0, 1, 0.5);
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
      WHERE exclusion_group = $1 AND variant = 'standard' AND status IN ('open', 'running')
      LIMIT 1`,
    [ASSESS_GROUP(input.primaryClaimId)]
  );
  const [flag] = await rawQuery<{ id: string }>(
    `INSERT INTO consistency_flags
       (sweep_id, kind, primary_claim_id, claim_ids, action_id, rationale,
        expected_gain, status_at_flag, credence_at_flag, assessment_id_at_flag)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.sweepId,
      input.kind,
      input.primaryClaimId,
      claimIds,
      standard?.id ?? null,
      rationale,
      expectedGain,
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
    expected_gain: expectedGain,
    note:
      "Recorded, and the claim's Steward is queued with your reading. Its " +
      "reassessment is valued by the platform's formula with your expected " +
      "gain; the allocator decides whether it runs.",
  };
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
  expected_gain: number;
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
         f.action_id, a.status AS action_status, f.rationale, f.expected_gain,
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
  claims_in_scope: number;
  flags_raised: number;
  note: string | null;
  started_at: Date;
  finished_at: Date | null;
}>> {
  return rawQuery(
    `SELECT s.id, s.tag_id, t.slug AS tag_slug, s.partition, s.status, s.claims_in_scope,
            s.flags_raised, s.note, s.started_at, s.finished_at
       FROM consistency_sweeps s LEFT JOIN tags t ON t.id = s.tag_id
      ORDER BY s.started_at DESC LIMIT $1`,
    [limit]
  );
}
