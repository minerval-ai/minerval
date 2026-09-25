/**
 * Production monitors (#334 S9): pure SQL readers over the live graph and
 * the L0 trace substrate, each returning a typed report. docs/monitors.md
 * carries every query here VERBATIM (a unit test keeps the two in step), so
 * a reader of the evals page can see exactly what each signal computes.
 *
 * Two kinds of signal:
 *
 *  - CANDIDATE DETECTORS (performed settling, empty chairs; #289): they list
 *    claims whose record looks inconsistent with their verdict. A hit is a
 *    candidate for the Audit Agent to look at, and nothing else — no status,
 *    credence, or standing changes on a hit, and the Audit Agent may well
 *    conclude the verdict holds. monitor-scheduler.ts hands hits over via
 *    requestAudit as anomaly_investigation INPUT.
 *
 *  - CONTINUOUS CHECKS (overturn-rate discrimination, evidence
 *    monotonicity — #295 tier 2; cascade and queue health; agent rollups):
 *    numbers over the graph's own history that need no external referent.
 *    They say whether the system is behaving like itself, not whether any
 *    claim is right.
 *
 * Everything is a read. Thresholds come from config (MONITOR_* env,
 * docs/monitors.md lists them) and can be overridden per call.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  cascadeSeries,
  classifyMonotonicity,
  mergeAgentRollups,
  snapshotTrend,
  summarizeOverturnBins,
  type AgentRollup,
  type CascadeReport,
  type MonotonicityReport,
  type MonotonicityRow,
  type OverturnReport,
  type SnapshotTrend,
} from "./monitor-math.js";

export const MONITOR_SIGNALS = [
  "performed_settling",
  "empty_chairs",
  "overturn_rate",
  "evidence_monotonicity",
  "cascade_health",
  "queue_health",
  "agent_rollups",
] as const;
export type MonitorSignal = (typeof MONITOR_SIGNALS)[number];

export interface MonitorThresholds {
  /** A verdict at or above this confidence, with a settled status, "reads as settled". */
  settledConfidence: number;
  /** Statuses that read as settled. */
  settledStatuses: readonly string[];
  /** |Δcredence| at or above this is a material change (reversal criterion, cascade materiality). */
  materialCredenceDelta: number;
  /** An accepted challenge within this many days is live disagreement. */
  recentChallengeDays: number;
  /** Instances must come from at least this many distinct sources, on both stances, to count as live disagreement. */
  minDisagreeingSources: number;
  /** Empty chairs: at least this many instances, all one stance, on a contested claim. */
  emptyChairMinInstances: number;
  /** Evidence monotonicity: credence may move against the contribution's sign by up to this much. */
  monotonicityTolerance: number;
  /** Evidence monotonicity: the re-assessment must land within this many days of acceptance. */
  monotonicityHorizonDays: number;
  /** Evidence monotonicity: accepted contributions this recent are examined. */
  monotonicityWindowDays: number;
  /** Overturn rate: a bin side needs at least this many assessments before a verdict on discrimination. */
  overturnMinSample: number;
  /** Cascade health: how many days back. */
  cascadeDays: number;
  /** Queue health: how many queue_depth_snapshots points. */
  snapshotPoints: number;
  /** Candidate lists and error-parked lists are cut here. */
  limit: number;
}

export function defaultThresholds(overrides: Partial<MonitorThresholds> = {}): MonitorThresholds {
  const cfg = loadConfig();
  return {
    settledConfidence: cfg.monitorSettledConfidence,
    settledStatuses: ["verified", "contradicted"],
    materialCredenceDelta: cfg.monitorMaterialCredenceDelta,
    recentChallengeDays: cfg.monitorRecentChallengeDays,
    minDisagreeingSources: 2,
    emptyChairMinInstances: 2,
    monotonicityTolerance: cfg.monitorMonotonicityTolerance,
    monotonicityHorizonDays: cfg.monitorMonotonicityHorizonDays,
    monotonicityWindowDays: 90,
    overturnMinSample: 10,
    cascadeDays: 14,
    snapshotPoints: 48,
    limit: 25,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The queries, verbatim in docs/monitors.md
// ---------------------------------------------------------------------------

export const MONITOR_SQL = {
  performed_settling: `WITH settled AS (
  SELECT c.id, c.text, c.importance, a.status, a.confidence, a.claim_credence, a.assessed_at
    FROM claims c
    JOIN assessments a ON a.claim_id = c.id AND a.is_current
   WHERE c.state = 'active'
     AND a.status = ANY($1::text[])
     AND a.confidence >= $2
),
stances AS (
  SELECT ci.claim_id,
         COUNT(*) FILTER (WHERE ci.stance = 'affirms')::int AS affirms,
         COUNT(*) FILTER (WHERE ci.stance = 'denies')::int  AS denies,
         COUNT(DISTINCT ci.source_id) FILTER (WHERE ci.stance IN ('affirms', 'denies'))::int AS sources
    FROM claim_instances ci
    JOIN settled s ON s.id = ci.claim_id
   GROUP BY ci.claim_id
),
challenges AS (
  SELECT co.claim_id, MAX(r.reviewed_at) AS last_accepted_challenge_at
    FROM contributions co
    JOIN contribution_reviews r ON r.contribution_id = co.id AND NOT r.superseded
    JOIN settled s ON s.id = co.claim_id
   WHERE co.contribution_type = 'challenge'
     AND r.decision = 'accept'
     AND r.reviewed_at >= now() - make_interval(days => $3::int)
   GROUP BY co.claim_id
),
contested_children AS (
  SELECT cr.parent_claim_id AS claim_id, COUNT(*)::int AS n
    FROM claim_relationships cr
    JOIN settled s ON s.id = cr.parent_claim_id
    JOIN claims ch ON ch.id = cr.child_claim_id AND ch.state = 'active'
    JOIN assessments ca ON ca.claim_id = ch.id AND ca.is_current AND ca.status = 'contested'
   WHERE cr.relation_type = 'requires'
   GROUP BY cr.parent_claim_id
)
SELECT s.id, s.text, s.importance, s.status, s.confidence, s.claim_credence, s.assessed_at,
       COALESCE(st.affirms, 0) AS affirms, COALESCE(st.denies, 0) AS denies, COALESCE(st.sources, 0) AS sources,
       ch.last_accepted_challenge_at,
       COALESCE(cc.n, 0) AS contested_requires_children
  FROM settled s
  LEFT JOIN stances st ON st.claim_id = s.id
  LEFT JOIN challenges ch ON ch.claim_id = s.id
  LEFT JOIN contested_children cc ON cc.claim_id = s.id
 WHERE (st.affirms > 0 AND st.denies > 0 AND st.sources >= $4::int)
    OR ch.claim_id IS NOT NULL
    OR cc.claim_id IS NOT NULL
 ORDER BY s.importance DESC, s.assessed_at DESC
 LIMIT $5::int`,

  empty_chairs: `WITH contested AS (
  SELECT c.id, c.text, c.importance, a.status, a.confidence, a.claim_credence, a.assessed_at
    FROM claims c
    JOIN assessments a ON a.claim_id = c.id AND a.is_current
   WHERE c.state = 'active' AND a.status = 'contested'
),
inst AS (
  SELECT ci.claim_id, COUNT(*)::int AS n, COUNT(DISTINCT ci.stance)::int AS stances, MIN(ci.stance) AS stance
    FROM claim_instances ci
    JOIN contested c ON c.id = ci.claim_id
   WHERE ci.stance IN ('affirms', 'denies')
   GROUP BY ci.claim_id
),
args AS (
  SELECT ar.claim_id, COUNT(*)::int AS n, COUNT(DISTINCT ar.stance)::int AS stances, MIN(ar.stance) AS stance
    FROM arguments ar
    JOIN contested c ON c.id = ar.claim_id
   WHERE ar.stance IN ('for', 'against')
   GROUP BY ar.claim_id
)
SELECT c.id, c.text, c.importance, c.status, c.confidence, c.claim_credence, c.assessed_at,
       COALESCE(i.n, 0) AS instances, CASE WHEN i.stances = 1 THEN i.stance END AS instance_stance,
       COALESCE(ar.n, 0) AS arguments, CASE WHEN ar.stances = 1 THEN ar.stance END AS argument_stance
  FROM contested c
  LEFT JOIN inst i ON i.claim_id = c.id
  LEFT JOIN args ar ON ar.claim_id = c.id
 WHERE (i.n >= $1::int AND i.stances = 1)
    OR (ar.n >= 1 AND ar.stances = 1)
 ORDER BY c.importance DESC, c.assessed_at DESC
 LIMIT $2::int`,

  overturn_rate: `WITH ordered AS (
  SELECT a.claim_id, a.status, a.claim_credence,
         LEAD(a.status) OVER w AS next_status,
         LEAD(a.claim_credence) OVER w AS next_credence
    FROM assessments a
    JOIN claims c ON c.id = a.claim_id AND c.state = 'active'
  WINDOW w AS (PARTITION BY a.claim_id ORDER BY a.assessed_at, a.id)
)
SELECT width_bucket(claim_credence, 0, 1, 10) AS bin,
       COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE next_status <> status
                           OR abs(next_credence - claim_credence) >= $1)::int AS reversed
  FROM ordered
 WHERE next_status IS NOT NULL AND claim_credence IS NOT NULL
 GROUP BY bin
 ORDER BY bin`,

  evidence_monotonicity: `WITH accepted AS (
  SELECT co.id AS contribution_id, co.claim_id, co.contribution_type, r.reviewed_at
    FROM contributions co
    JOIN contribution_reviews r ON r.contribution_id = co.id AND NOT r.superseded
   WHERE r.decision = 'accept'
     AND co.contribution_type IN ('support', 'challenge')
     AND co.claim_id IS NOT NULL
     AND r.reviewed_at >= now() - make_interval(days => $2::int)
)
SELECT ac.contribution_id, ac.claim_id, c.text, ac.contribution_type, ac.reviewed_at,
       before.claim_credence AS credence_before, before.status AS status_before,
       after.claim_credence  AS credence_after,  after.status  AS status_after,
       after.assessed_at AS assessed_after_at
  FROM accepted ac
  JOIN claims c ON c.id = ac.claim_id
  LEFT JOIN LATERAL (
    SELECT claim_credence, status FROM assessments
     WHERE claim_id = ac.claim_id AND assessed_at <= ac.reviewed_at
     ORDER BY assessed_at DESC, id DESC LIMIT 1
  ) before ON true
  LEFT JOIN LATERAL (
    SELECT claim_credence, status, assessed_at FROM assessments
     WHERE claim_id = ac.claim_id
       AND assessed_at > ac.reviewed_at
       AND assessed_at <= ac.reviewed_at + make_interval(days => $1::int)
     ORDER BY assessed_at ASC, id ASC LIMIT 1
  ) after ON true
 ORDER BY ac.reviewed_at DESC`,

  cascade_runs: `WITH runs AS (
  SELECT r.id, r.claim_id, r.started_at, r.finished_at, date_trunc('day', r.started_at) AS day
    FROM agent_runs r
   WHERE r.agent = 'steward'
     AND r.claim_id IS NOT NULL
     AND r.finished_at IS NOT NULL
     AND r.started_at >= now() - make_interval(days => $1::int)
),
assessed AS (
  SELECT a.claim_id, a.assessed_at, a.status, a.claim_credence,
         LAG(a.id) OVER w AS prev_id,
         LAG(a.status) OVER w AS prev_status,
         LAG(a.claim_credence) OVER w AS prev_credence
    FROM assessments a
   WHERE a.claim_id IN (SELECT claim_id FROM runs)
  WINDOW w AS (PARTITION BY a.claim_id ORDER BY a.assessed_at, a.id)
),
material AS (
  SELECT ru.id, ru.day
    FROM runs ru
   WHERE EXISTS (
     SELECT 1 FROM assessed x
      WHERE x.claim_id = ru.claim_id
        AND x.assessed_at >= ru.started_at AND x.assessed_at <= ru.finished_at
        AND (x.prev_id IS NULL
             OR x.prev_status <> x.status
             OR abs(COALESCE(x.claim_credence, 0) - COALESCE(x.prev_credence, 0)) >= $2)
   )
),
children AS (
  SELECT m.id AS parent_id, m.day, ch.id AS child_id
    FROM material m
    JOIN enqueue_events e ON e.source_run_id = m.id AND e.queue = 'steward' AND e.claim_id IS NOT NULL
    JOIN LATERAL (
      SELECT r.id FROM runs r
       WHERE r.claim_id = e.claim_id AND r.started_at >= e.created_at
       ORDER BY r.started_at ASC LIMIT 1
    ) ch ON true
)
SELECT ru.day,
       COUNT(DISTINCT ru.id)::int AS runs,
       COUNT(DISTINCT m.id)::int AS material_runs,
       (SELECT COUNT(DISTINCT c.child_id) FROM children c
          JOIN material cm ON cm.id = c.child_id
         WHERE c.day = ru.day)::int AS material_children
  FROM runs ru
  LEFT JOIN material m ON m.id = ru.id
 GROUP BY ru.day
 ORDER BY ru.day`,

  cascade_coalescing: `SELECT date_trunc('day', created_at) AS day,
       COUNT(*)::int AS enqueues,
       COUNT(*) FILTER (WHERE coalesced)::int AS coalesced
  FROM enqueue_events
 WHERE queue = 'steward'
   AND created_at >= now() - make_interval(days => $1::int)
 GROUP BY 1
 ORDER BY 1`,

  queue_states: `SELECT steward_state, COUNT(*)::int AS n
  FROM claims
 WHERE state = 'active'
 GROUP BY steward_state`,

  queue_oldest_pending: `SELECT c.id, c.text, c.importance, last.created_at AS enqueued_at,
       EXTRACT(EPOCH FROM now() - last.created_at)::float8 AS age_seconds
  FROM claims c
  JOIN LATERAL (
    SELECT created_at FROM enqueue_events e
     WHERE e.claim_id = c.id AND e.queue = 'steward' AND e.coalesced IS NOT TRUE
     ORDER BY created_at DESC LIMIT 1
  ) last ON true
 WHERE c.state = 'active' AND c.steward_state = 'pending'
 ORDER BY last.created_at ASC
 LIMIT 1`,

  queue_snapshots: `SELECT period_key, steward_pending, created_at
  FROM queue_depth_snapshots
 ORDER BY created_at DESC
 LIMIT $1::int`,

  queue_error_parked: `SELECT id, text, importance, steward_error, steward_attempts, stewarded_at
  FROM claims
 WHERE state = 'active' AND steward_state = 'error'
 ORDER BY importance DESC, stewarded_at DESC NULLS LAST
 LIMIT $1::int`,

  rollup_usage: `SELECT agent, COUNT(*)::int AS calls, COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost_micro_usd
  FROM llm_usage
 WHERE created_at >= now() - make_interval(hours => $1::int)
 GROUP BY agent`,

  rollup_runs: `SELECT agent, COUNT(*)::int AS runs,
       COUNT(*) FILTER (WHERE outcome = 'error')::int AS errors,
       COUNT(*) FILTER (WHERE finished_at IS NULL)::int AS running
  FROM agent_runs
 WHERE started_at >= now() - make_interval(hours => $1::int)
 GROUP BY agent`,
} as const;

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function iso(d: unknown): string | null {
  if (d == null) return null;
  return d instanceof Date ? d.toISOString() : new Date(String(d)).toISOString();
}

export interface PerformedSettlingCandidate {
  claimId: string;
  text: string;
  importance: number;
  status: string;
  confidence: number;
  credence: number | null;
  assessedAt: string;
  /** Which of the three disagreement records fired. */
  reasons: Array<"opposed_instances" | "recent_accepted_challenge" | "contested_requires_child">;
  affirms: number;
  denies: number;
  sources: number;
  lastAcceptedChallengeAt: string | null;
  contestedRequiresChildren: number;
}

export interface PerformedSettlingReport {
  signal: "performed_settling";
  description: string;
  thresholds: Pick<MonitorThresholds, "settledConfidence" | "settledStatuses" | "recentChallengeDays" | "minDisagreeingSources" | "limit">;
  candidates: PerformedSettlingCandidate[];
}

/**
 * Performed settling (#289): a claim whose assessment reads as settled
 * (verified/contradicted, confidence ≥ threshold) while its own record
 * shows live disagreement — instances on both stances from ≥ N sources, an
 * accepted challenge in the recent window, or a contested child under a
 * `requires` edge. A CANDIDATE for audit: the verdict may be earned (the
 * dissent may be weak and the assessment may say so), which is exactly what
 * the Audit Agent is for. Not a verdict mechanism; nothing changes on a hit.
 */
export async function performedSettling(t: MonitorThresholds = defaultThresholds()): Promise<PerformedSettlingReport> {
  const rows = await rawQuery<{
    id: string; text: string; importance: number; status: string; confidence: number;
    claim_credence: number | null; assessed_at: Date; affirms: number; denies: number; sources: number;
    last_accepted_challenge_at: Date | null; contested_requires_children: number;
  }>(MONITOR_SQL.performed_settling, [
    [...t.settledStatuses], t.settledConfidence, t.recentChallengeDays, t.minDisagreeingSources, t.limit,
  ]);
  return {
    signal: "performed_settling",
    description:
      "Claims whose current assessment reads as settled while the record shows live disagreement. " +
      "Candidates for the Audit Agent, not verdicts.",
    thresholds: {
      settledConfidence: t.settledConfidence,
      settledStatuses: t.settledStatuses,
      recentChallengeDays: t.recentChallengeDays,
      minDisagreeingSources: t.minDisagreeingSources,
      limit: t.limit,
    },
    candidates: rows.map((r) => {
      const reasons: PerformedSettlingCandidate["reasons"] = [];
      if (r.affirms > 0 && r.denies > 0 && r.sources >= t.minDisagreeingSources) reasons.push("opposed_instances");
      if (r.last_accepted_challenge_at) reasons.push("recent_accepted_challenge");
      if (r.contested_requires_children > 0) reasons.push("contested_requires_child");
      return {
        claimId: r.id,
        text: r.text,
        importance: r.importance,
        status: r.status,
        confidence: r.confidence,
        credence: r.claim_credence,
        assessedAt: iso(r.assessed_at)!,
        reasons,
        affirms: r.affirms,
        denies: r.denies,
        sources: r.sources,
        lastAcceptedChallengeAt: iso(r.last_accepted_challenge_at),
        contestedRequiresChildren: r.contested_requires_children,
      };
    }),
  };
}

export interface EmptyChairCandidate {
  claimId: string;
  text: string;
  importance: number;
  status: string;
  confidence: number;
  credence: number | null;
  assessedAt: string;
  reasons: Array<"instances_one_stance" | "arguments_one_stance">;
  instances: number;
  instanceStance: string | null;
  arguments: number;
  argumentStance: string | null;
}

export interface EmptyChairsReport {
  signal: "empty_chairs";
  description: string;
  thresholds: Pick<MonitorThresholds, "emptyChairMinInstances" | "limit">;
  candidates: EmptyChairCandidate[];
}

/**
 * Empty chairs (#289): a contested claim whose record carries only one side —
 * every instance on one stance (≥ N of them), or every named argument on one
 * stance. The assessment says the question is open, but nobody sitting in
 * the other chair is on record. A coverage CANDIDATE for the Audit Agent
 * (or the Steward): the missing side may simply not exist in the sources
 * ingested so far. Not a verdict; a hit changes nothing.
 */
export async function emptyChairs(t: MonitorThresholds = defaultThresholds()): Promise<EmptyChairsReport> {
  const rows = await rawQuery<{
    id: string; text: string; importance: number; status: string; confidence: number;
    claim_credence: number | null; assessed_at: Date; instances: number; instance_stance: string | null;
    arguments: number; argument_stance: string | null;
  }>(MONITOR_SQL.empty_chairs, [t.emptyChairMinInstances, t.limit]);
  return {
    signal: "empty_chairs",
    description:
      "Contested claims whose instances or named arguments are all on one side. " +
      "Coverage candidates for the Audit Agent, not verdicts.",
    thresholds: { emptyChairMinInstances: t.emptyChairMinInstances, limit: t.limit },
    candidates: rows.map((r) => {
      const reasons: EmptyChairCandidate["reasons"] = [];
      if (r.instances >= t.emptyChairMinInstances && r.instance_stance) reasons.push("instances_one_stance");
      if (r.arguments >= 1 && r.argument_stance) reasons.push("arguments_one_stance");
      return {
        claimId: r.id,
        text: r.text,
        importance: r.importance,
        status: r.status,
        confidence: r.confidence,
        credence: r.claim_credence,
        assessedAt: iso(r.assessed_at)!,
        reasons,
        instances: r.instances,
        instanceStance: r.instance_stance,
        arguments: r.arguments,
        argumentStance: r.argument_stance,
      };
    }),
  };
}

export interface OverturnRateReport extends OverturnReport {
  signal: "overturn_rate";
  description: string;
  thresholds: Pick<MonitorThresholds, "materialCredenceDelta" | "overturnMinSample">;
}

/**
 * Overturn-rate discrimination (#295 tier 2): bin every assessment by the
 * credence it recorded and ask how often the NEXT assessment of the same
 * claim materially reversed it (status change, or |Δcredence| ≥ threshold).
 * If confident credences reverse as often as uncertain ones, the credences
 * are not discriminating. Runs over the whole history; needs no referent.
 * Says nothing about whether any assessment was right.
 */
export async function overturnRate(t: MonitorThresholds = defaultThresholds()): Promise<OverturnRateReport> {
  const rows = await rawQuery<{ bin: number; n: number; reversed: number }>(MONITOR_SQL.overturn_rate, [
    t.materialCredenceDelta,
  ]);
  return {
    signal: "overturn_rate",
    description:
      "Share of assessments later materially reversed, by the credence they recorded. " +
      "Discriminating credences reverse less often when confident.",
    thresholds: { materialCredenceDelta: t.materialCredenceDelta, overturnMinSample: t.overturnMinSample },
    ...summarizeOverturnBins(rows, { minSample: t.overturnMinSample }),
  };
}

export interface EvidenceMonotonicityReport extends MonotonicityReport {
  signal: "evidence_monotonicity";
  description: string;
  thresholds: Pick<MonitorThresholds, "monotonicityTolerance" | "monotonicityHorizonDays" | "monotonicityWindowDays">;
}

/**
 * Evidence monotonicity (#295 tier 2): after an ACCEPTED support the next
 * assessment's credence should not fall; after an accepted challenge it
 * should not rise. Sign, not magnitude; a move within the tolerance is
 * noise. A violation is a candidate for reading the Steward's reasoning —
 * it may be right (the challenge exposed a weaker support), which is why
 * this is a list and not a gate.
 */
export async function evidenceMonotonicity(t: MonitorThresholds = defaultThresholds()): Promise<EvidenceMonotonicityReport> {
  const rows = await rawQuery<{
    contribution_id: string; claim_id: string; text: string; contribution_type: string; reviewed_at: Date;
    credence_before: number | null; status_before: string | null; credence_after: number | null;
    status_after: string | null; assessed_after_at: Date | null;
  }>(MONITOR_SQL.evidence_monotonicity, [t.monotonicityHorizonDays, t.monotonicityWindowDays]);
  const mapped: MonotonicityRow[] = rows.map((r) => ({
    contributionId: r.contribution_id,
    claimId: r.claim_id,
    claimText: r.text,
    contributionType: r.contribution_type,
    reviewedAt: iso(r.reviewed_at)!,
    credenceBefore: r.credence_before,
    statusBefore: r.status_before,
    credenceAfter: r.credence_after,
    statusAfter: r.status_after,
    assessedAfterAt: iso(r.assessed_after_at),
  }));
  return {
    signal: "evidence_monotonicity",
    description:
      "Accepted supports whose next assessment lowered the credence, and accepted challenges that raised it. " +
      "Sign-correctness of updates, not magnitude.",
    thresholds: {
      monotonicityTolerance: t.monotonicityTolerance,
      monotonicityHorizonDays: t.monotonicityHorizonDays,
      monotonicityWindowDays: t.monotonicityWindowDays,
    },
    ...classifyMonotonicity(mapped, t.monotonicityTolerance),
  };
}

export interface CascadeHealthReport extends CascadeReport {
  signal: "cascade_health";
  description: string;
  thresholds: Pick<MonitorThresholds, "materialCredenceDelta" | "cascadeDays">;
}

/**
 * Cascade health (#295 "cascade stability", from the L0 enqueue events):
 * per day, the empirical branching factor R = materially-changed steward
 * runs caused per materially-changed steward run, and the share of steward
 * enqueues absorbed by an already-pending slot (coalescing). R < 1 means a
 * change peters out; R ≥ 1 is the explosion. Attribution runs through
 * enqueue_events.source_run_id, so a notification sent outside a traced run
 * is invisible here.
 */
export async function cascadeHealth(t: MonitorThresholds = defaultThresholds()): Promise<CascadeHealthReport> {
  const [runRows, coalesceRows] = await Promise.all([
    rawQuery<{ day: Date; runs: number; material_runs: number; material_children: number }>(MONITOR_SQL.cascade_runs, [
      t.cascadeDays,
      t.materialCredenceDelta,
    ]),
    rawQuery<{ day: Date; enqueues: number; coalesced: number }>(MONITOR_SQL.cascade_coalescing, [t.cascadeDays]),
  ]);
  return {
    signal: "cascade_health",
    description:
      "Per-day empirical R (materially-changed steward runs caused per materially-changed run) and the coalescing share of steward enqueues.",
    thresholds: { materialCredenceDelta: t.materialCredenceDelta, cascadeDays: t.cascadeDays },
    ...cascadeSeries(
      runRows.map((r) => ({ day: iso(r.day)!, runs: r.runs, materialRuns: r.material_runs, materialChildren: r.material_children })),
      coalesceRows.map((r) => ({ day: iso(r.day)!, enqueues: r.enqueues, coalesced: r.coalesced }))
    ),
  };
}

export interface QueueHealthReport {
  signal: "queue_health";
  description: string;
  thresholds: Pick<MonitorThresholds, "snapshotPoints" | "limit">;
  states: { pending: number; running: number; done: number; error: number; deferred: number };
  oldestPending: { claimId: string; text: string; importance: number; enqueuedAt: string; ageSeconds: number } | null;
  snapshots: SnapshotTrend;
  errorParked: Array<{ claimId: string; text: string; importance: number; error: string | null; attempts: number; stewardedAt: string | null }>;
}

/**
 * Queue health: the steward lane by state right now, the oldest pending
 * claim's age (from its last non-coalesced enqueue), the queue_depth_snapshots
 * trend, and the claims parked in `error`. Operational; says nothing about
 * content.
 */
export async function queueHealth(t: MonitorThresholds = defaultThresholds()): Promise<QueueHealthReport> {
  const [states, oldest, snaps, parked] = await Promise.all([
    rawQuery<{ steward_state: string; n: number }>(MONITOR_SQL.queue_states),
    rawQuery<{ id: string; text: string; importance: number; enqueued_at: Date; age_seconds: number }>(MONITOR_SQL.queue_oldest_pending),
    rawQuery<{ period_key: string | null; steward_pending: number; created_at: Date }>(MONITOR_SQL.queue_snapshots, [t.snapshotPoints]),
    rawQuery<{ id: string; text: string; importance: number; steward_error: string | null; steward_attempts: number; stewarded_at: Date | null }>(
      MONITOR_SQL.queue_error_parked,
      [t.limit]
    ),
  ]);
  const counts = { pending: 0, running: 0, done: 0, error: 0, deferred: 0 };
  for (const s of states) if (s.steward_state in counts) counts[s.steward_state as keyof typeof counts] = s.n;
  const o = oldest[0];
  return {
    signal: "queue_health",
    description:
      "Steward lane by state, oldest pending age, queue-depth snapshot trend, and error-parked claims.",
    thresholds: { snapshotPoints: t.snapshotPoints, limit: t.limit },
    states: counts,
    oldestPending: o
      ? { claimId: o.id, text: o.text, importance: o.importance, enqueuedAt: iso(o.enqueued_at)!, ageSeconds: Number(o.age_seconds) }
      : null,
    snapshots: snapshotTrend(
      snaps.map((s) => ({ periodKey: s.period_key, stewardPending: s.steward_pending, createdAt: iso(s.created_at)! }))
    ),
    errorParked: parked.map((p) => ({
      claimId: p.id,
      text: p.text,
      importance: p.importance,
      error: p.steward_error,
      attempts: p.steward_attempts,
      stewardedAt: iso(p.stewarded_at),
    })),
  };
}

export interface AgentRollupsReport {
  signal: "agent_rollups";
  description: string;
  agents: AgentRollup[];
}

/** Calls, metered cost, runs and error rate per agent over 24h and 7d. */
export async function agentRollups(): Promise<AgentRollupsReport> {
  const usage = (hours: number) =>
    rawQuery<{ agent: string; calls: number; cost_micro_usd: string | number }>(MONITOR_SQL.rollup_usage, [hours]).then((rows) =>
      rows.map((r) => ({ agent: r.agent, calls: r.calls, costMicroUsd: Number(r.cost_micro_usd) }))
    );
  const runs = (hours: number) =>
    rawQuery<{ agent: string; runs: number; errors: number; running: number }>(MONITOR_SQL.rollup_runs, [hours]);
  const [usage24h, runs24h, usage7d, runs7d] = await Promise.all([usage(24), runs(24), usage(168), runs(168)]);
  return {
    signal: "agent_rollups",
    description: "LLM calls, metered cost, runs and error rate per agent over the last 24 hours and 7 days.",
    agents: mergeAgentRollups({ usage24h, runs24h, usage7d, runs7d }),
  };
}

export interface MonitorOverview {
  generatedAt: string;
  thresholds: MonitorThresholds;
  performedSettling: PerformedSettlingReport;
  emptyChairs: EmptyChairsReport;
  overturnRate: OverturnRateReport;
  evidenceMonotonicity: EvidenceMonotonicityReport;
  cascadeHealth: CascadeHealthReport;
  queueHealth: QueueHealthReport;
  agentRollups: AgentRollupsReport;
}

export async function overview(t: MonitorThresholds = defaultThresholds()): Promise<MonitorOverview> {
  const [ps, ec, or, em, ch, qh, ar] = await Promise.all([
    performedSettling(t),
    emptyChairs(t),
    overturnRate(t),
    evidenceMonotonicity(t),
    cascadeHealth(t),
    queueHealth(t),
    agentRollups(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    thresholds: t,
    performedSettling: ps,
    emptyChairs: ec,
    overturnRate: or,
    evidenceMonotonicity: em,
    cascadeHealth: ch,
    queueHealth: qh,
    agentRollups: ar,
  };
}

export async function signalReport(signal: MonitorSignal, t: MonitorThresholds = defaultThresholds()): Promise<unknown> {
  switch (signal) {
    case "performed_settling": return performedSettling(t);
    case "empty_chairs": return emptyChairs(t);
    case "overturn_rate": return overturnRate(t);
    case "evidence_monotonicity": return evidenceMonotonicity(t);
    case "cascade_health": return cascadeHealth(t);
    case "queue_health": return queueHealth(t);
    case "agent_rollups": return agentRollups();
  }
}
