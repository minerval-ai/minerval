/**
 * Coherence pre-filter (#330, Phase 0): the mechanical half of the
 * consistency sweep the constitution calls for (Part VII, §21: "The graph's
 * assessments must cohere along its edges... Periodic sweeps hunt for
 * incoherence").
 *
 * Pure SQL over current assessments joined through the dependency edges and
 * the lateral links: it shortlists the NEIGHBORHOODS where the recorded
 * verdicts cannot all stand at once by the relation's own logic. That is
 * all it does. A candidate is a place to look, never a finding: whether the
 * tension is real, already weighed in a reasoning trace, or a sign that an
 * edge mischaracterizes a dependency is the judgment the Consistency
 * Checker agent (Phase 1) spends its reading on. Mechanism picks what to
 * look at; judgment decides (Part VIII).
 *
 * The thresholds are deliberately in one place and deliberately loose: the
 * pre-filter's job is recall over a small graph, and Phase 0's purpose is
 * to measure how often each kind fires on the live graph before any agent
 * spend, so the numbers below are the first draft of that measurement, not
 * a settled standard.
 */
import { rawQuery } from "../db/client.js";

/**
 * Tunable slack. Each is the amount of disagreement the mechanical pass
 * treats as noise rather than tension.
 */
export const COHERENCE_THRESHOLDS = {
  /**
   * A conclusion is no likelier than a premise it needs, so a parent's
   * credence may exceed a `requires` child's only by this much before the
   * pair is shortlisted.
   */
  requiresMargin: 0.15,
  /** Two claims joined by `contradicts` are both "confidently affirmed" above this. */
  highCredence: 0.7,
  /**
   * Rival explanations of the same event must be jointly tenable (§21):
   * their credences may sum past 1 by at most this much.
   */
  rivalTolerance: 0.1,
} as const;

export const COHERENCE_KINDS = [
  // parent verified/supported while a `requires` child is contradicted/unsupported
  "requires_status",
  // parent credence exceeds a `requires` child's by more than the margin
  "requires_credence",
  // both ends of a `contradicts` edge affirmed (by status or by credence)
  "contradicts_both_high",
  // a `rival_explanation` link whose credences sum past 1 + tolerance
  "rivals_jointly_untenable",
  // parent assessed before a requires/contradicts child changed its verdict
  "stale_vs_neighbor",
] as const;
export type CoherenceKind = (typeof COHERENCE_KINDS)[number];

const AFFIRMED = `('verified', 'supported')`;
const DENIED = `('contradicted', 'unsupported')`;

export interface CoherenceEndpoint {
  claim_id: string;
  text: string;
  status: string;
  credence: number | null;
  assessed_at: string;
}

export interface CoherenceCandidate {
  kind: CoherenceKind;
  /**
   * The claim a flag would name: the one whose assessment looks wrong given
   * its neighbor, or the parent when the defect is compositional.
   */
  primary_claim_id: string;
  /** Every claim in the tension, primary first. */
  claim_ids: string[];
  /** The primary claim's importance: the shortlist's ordering key. */
  importance: number;
  /** The edge or link the tension runs along. */
  relation: string;
  /** The primary claim's side of the pair. */
  primary: CoherenceEndpoint;
  /** The other side. */
  other: CoherenceEndpoint;
  /**
   * stale_vs_neighbor only: what the neighbor's status was when the primary
   * was last assessed, versus its status now.
   */
  neighbor_status_then?: string;
}

export interface CoherenceScope {
  /**
   * Restrict to tensions touching a claim carrying this tag (either end of
   * the pair counts). Null or undefined = the whole graph.
   */
  tagId?: string | null;
  /**
   * Restrict to tensions touching one of these claims (either end counts):
   * the residual bucket a sweep covers when no sweepable tag does. Combined
   * with tagId, either set admits a pair.
   */
  claimIds?: string[] | null;
}

interface CandidateRow {
  kind: CoherenceKind;
  primary_claim_id: string;
  other_claim_id: string;
  importance: number;
  relation: string;
  p_text: string;
  p_status: string;
  p_credence: number | null;
  p_assessed_at: Date;
  o_text: string;
  o_status: string;
  o_credence: number | null;
  o_assessed_at: Date;
  neighbor_status_then: string | null;
}

/**
 * One CTE of live claims with a current assessment; every check joins two
 * rows of it. A claim already waiting for (or under) its Steward is left
 * out as a primary: a flag on it would be a repeat of work already queued.
 * Parameters: $1 tag id (nullable uuid), $2 requires margin, $3 high
 * credence, $4 rival tolerance, $5 explicit claim ids (nullable uuid[]).
 */
const CANDIDATE_CTE = `
  WITH cur AS (
    SELECT a.claim_id,
           a.status,
           a.claim_credence AS credence,
           a.assessed_at,
           c.text,
           c.importance,
           c.steward_state
      FROM assessments a
      JOIN claims c ON c.id = a.claim_id
     WHERE a.is_current = true
       AND c.state = 'active'
       AND c.merged_into IS NULL
  ),
  scoped AS (
    SELECT subject_id AS claim_id FROM taggings
     WHERE $1::uuid IS NOT NULL AND tag_id = $1::uuid AND subject_kind = 'claim'
    UNION
    SELECT unnest($5::uuid[])
  ),
  -- Dependency edges with both ends live and assessed. p = parent, ch = child.
  edges AS (
    SELECT r.relation_type AS relation,
           p.claim_id AS p_id, p.status AS p_status, p.credence AS p_credence,
           p.assessed_at AS p_assessed_at, p.text AS p_text, p.importance AS p_importance,
           p.steward_state AS p_steward_state,
           ch.claim_id AS ch_id, ch.status AS ch_status, ch.credence AS ch_credence,
           ch.assessed_at AS ch_assessed_at, ch.text AS ch_text, ch.importance AS ch_importance,
           ch.steward_state AS ch_steward_state
      FROM claim_relationships r
      JOIN cur p ON p.claim_id = r.parent_claim_id
      JOIN cur ch ON ch.claim_id = r.child_claim_id
     WHERE (($1::uuid IS NULL AND $5::uuid[] IS NULL)
            OR r.parent_claim_id IN (SELECT claim_id FROM scoped)
            OR r.child_claim_id IN (SELECT claim_id FROM scoped))
  ),
  candidates AS (
    -- 1. A conclusion standing while a premise it needs has fallen.
    SELECT 'requires_status' AS kind, p_id AS primary_claim_id, ch_id AS other_claim_id,
           p_importance AS importance, relation,
           p_text, p_status, p_credence, p_assessed_at,
           ch_text AS o_text, ch_status AS o_status, ch_credence AS o_credence, ch_assessed_at AS o_assessed_at,
           NULL::text AS neighbor_status_then
      FROM edges
     WHERE relation = 'requires'
       AND p_status IN ${AFFIRMED}
       AND ch_status IN ${DENIED}
       AND p_steward_state NOT IN ('pending', 'running')

    UNION ALL

    -- 2. A conclusion priced likelier than a premise it needs (beyond the margin),
    --    where the statuses alone did not already shortlist the pair.
    SELECT 'requires_credence', p_id, ch_id, p_importance, relation,
           p_text, p_status, p_credence, p_assessed_at,
           ch_text, ch_status, ch_credence, ch_assessed_at, NULL
      FROM edges
     WHERE relation = 'requires'
       AND p_credence IS NOT NULL AND ch_credence IS NOT NULL
       AND p_credence > ch_credence + $2::real
       AND NOT (p_status IN ${AFFIRMED} AND ch_status IN ${DENIED})
       AND p_steward_state NOT IN ('pending', 'running')

    UNION ALL

    -- 3. Both ends of a contradiction affirmed. The parent is primary: its
    --    Steward recorded the edge, so the tension is on its page.
    SELECT 'contradicts_both_high', p_id, ch_id, p_importance, relation,
           p_text, p_status, p_credence, p_assessed_at,
           ch_text, ch_status, ch_credence, ch_assessed_at, NULL
      FROM edges
     WHERE relation = 'contradicts'
       AND ((p_status IN ${AFFIRMED} AND ch_status IN ${AFFIRMED})
            OR (p_credence IS NOT NULL AND ch_credence IS NOT NULL
                AND p_credence >= $3::real AND ch_credence >= $3::real))
       AND p_steward_state NOT IN ('pending', 'running')

    UNION ALL

    -- 4. Rival explanations whose credences are not jointly tenable (§21).
    --    The likelier one is primary: it is the one carrying the excess.
    SELECT 'rivals_jointly_untenable',
           CASE WHEN a.credence >= b.credence THEN a.claim_id ELSE b.claim_id END,
           CASE WHEN a.credence >= b.credence THEN b.claim_id ELSE a.claim_id END,
           CASE WHEN a.credence >= b.credence THEN a.importance ELSE b.importance END,
           'rival_explanation',
           CASE WHEN a.credence >= b.credence THEN a.text ELSE b.text END,
           CASE WHEN a.credence >= b.credence THEN a.status ELSE b.status END,
           CASE WHEN a.credence >= b.credence THEN a.credence ELSE b.credence END,
           CASE WHEN a.credence >= b.credence THEN a.assessed_at ELSE b.assessed_at END,
           CASE WHEN a.credence >= b.credence THEN b.text ELSE a.text END,
           CASE WHEN a.credence >= b.credence THEN b.status ELSE a.status END,
           CASE WHEN a.credence >= b.credence THEN b.credence ELSE a.credence END,
           CASE WHEN a.credence >= b.credence THEN b.assessed_at ELSE a.assessed_at END,
           NULL
      FROM claim_links l
      JOIN cur a ON a.claim_id = l.claim_a_id
      JOIN cur b ON b.claim_id = l.claim_b_id
     WHERE l.kind = 'rival_explanation'
       AND a.credence IS NOT NULL AND b.credence IS NOT NULL
       AND a.credence + b.credence > 1 + $4::real
       AND (($1::uuid IS NULL AND $5::uuid[] IS NULL)
            OR l.claim_a_id IN (SELECT claim_id FROM scoped)
            OR l.claim_b_id IN (SELECT claim_id FROM scoped))
       AND (CASE WHEN a.credence >= b.credence THEN a.steward_state ELSE b.steward_state END)
           NOT IN ('pending', 'running')

    UNION ALL

    -- 5. A parent whose assessment predates a change of verdict on a
    --    load-bearing neighbor: the child's status as of the parent's
    --    assessment (its assessment history) differs from its status now.
    --    A child first assessed AFTER the parent is not shortlisted here:
    --    that ordering is the pipeline's normal course, not a change.
    SELECT 'stale_vs_neighbor', e.p_id, e.ch_id, e.p_importance, e.relation,
           e.p_text, e.p_status, e.p_credence, e.p_assessed_at,
           e.ch_text, e.ch_status, e.ch_credence, e.ch_assessed_at,
           h.status
      FROM edges e
      JOIN LATERAL (
        SELECT status FROM assessments
         WHERE claim_id = e.ch_id AND assessed_at <= e.p_assessed_at
         ORDER BY assessed_at DESC LIMIT 1
      ) h ON true
     WHERE e.relation IN ('requires', 'contradicts')
       AND e.ch_assessed_at > e.p_assessed_at
       AND h.status <> e.ch_status
       AND e.p_steward_state NOT IN ('pending', 'running')
  )
`;

function toEndpoint(
  id: string,
  text: string,
  status: string,
  credence: number | null,
  assessedAt: Date
): CoherenceEndpoint {
  return {
    claim_id: id,
    text,
    status,
    credence,
    assessed_at:
      assessedAt instanceof Date ? assessedAt.toISOString() : String(assessedAt),
  };
}

function scopeParams(scope: CoherenceScope): unknown[] {
  return [
    scope.tagId ?? null,
    COHERENCE_THRESHOLDS.requiresMargin,
    COHERENCE_THRESHOLDS.highCredence,
    COHERENCE_THRESHOLDS.rivalTolerance,
    scope.claimIds ?? null,
  ];
}

/**
 * The shortlist: every mechanically suspect pair in scope, most important
 * primary first, then the kind's declared order. A pair can appear under
 * more than one kind when more than one rule fires on it; each kind names
 * a different thing to check, so that is information, not duplication.
 */
export async function listCoherenceCandidates(
  scope: CoherenceScope = {},
  opts: { limit?: number; offset?: number } = {}
): Promise<CoherenceCandidate[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await rawQuery<CandidateRow>(
    `${CANDIDATE_CTE}
     SELECT * FROM candidates
      ORDER BY importance DESC, kind ASC, primary_claim_id ASC, other_claim_id ASC
      LIMIT $6 OFFSET $7`,
    [...scopeParams(scope), limit, offset]
  );
  return rows.map((r) => ({
    kind: r.kind,
    primary_claim_id: r.primary_claim_id,
    claim_ids: [r.primary_claim_id, r.other_claim_id],
    importance: Number(r.importance),
    relation: r.relation,
    primary: toEndpoint(r.primary_claim_id, r.p_text, r.p_status, r.p_credence, r.p_assessed_at),
    other: toEndpoint(r.other_claim_id, r.o_text, r.o_status, r.o_credence, r.o_assessed_at),
    ...(r.neighbor_status_then !== null
      ? { neighbor_status_then: r.neighbor_status_then }
      : {}),
  }));
}

export type CoherenceCounts = Record<CoherenceKind, number>;

export interface CoherenceStats {
  /** Live claims with a current assessment: the population the checks run over. */
  assessed_claims: number;
  /** Dependency edges with both ends assessed: the population of pair checks. */
  assessed_edges: number;
  /** Candidates by kind. */
  counts: CoherenceCounts;
  /** Distinct primary claims across every kind. */
  distinct_primaries: number;
}

/** The incoherence rate by kind: the number Phase 0 exists to observe. */
export async function coherenceStats(scope: CoherenceScope = {}): Promise<CoherenceStats> {
  const [byKind, population] = await Promise.all([
    rawQuery<{ kind: CoherenceKind; n: number; primaries: number }>(
      `${CANDIDATE_CTE}
       SELECT kind, COUNT(*)::int AS n, COUNT(DISTINCT primary_claim_id)::int AS primaries
         FROM candidates GROUP BY kind`,
      scopeParams(scope)
    ),
    rawQuery<{ assessed_claims: number; assessed_edges: number; primaries: number }>(
      `${CANDIDATE_CTE}
       SELECT (SELECT COUNT(*)::int FROM cur
                WHERE ($1::uuid IS NULL AND $5::uuid[] IS NULL)
                   OR claim_id IN (SELECT claim_id FROM scoped)) AS assessed_claims,
              (SELECT COUNT(*)::int FROM edges) AS assessed_edges,
              (SELECT COUNT(DISTINCT primary_claim_id)::int FROM candidates) AS primaries`,
      scopeParams(scope)
    ),
  ]);
  const counts = Object.fromEntries(
    COHERENCE_KINDS.map((k) => [k, 0])
  ) as CoherenceCounts;
  for (const row of byKind) counts[row.kind] = Number(row.n);
  const pop = population[0];
  return {
    assessed_claims: Number(pop?.assessed_claims ?? 0),
    assessed_edges: Number(pop?.assessed_edges ?? 0),
    counts,
    distinct_primaries: Number(pop?.primaries ?? 0),
  };
}
