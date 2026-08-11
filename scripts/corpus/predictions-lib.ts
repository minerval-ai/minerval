/**
 * Turning resolved predictions into scorable forecasts (#334 S6, from #296).
 *
 * The bridge between the resolvability overlay on `claims` and the pure
 * instruments in calibration-scoring.ts. Two things happen here, and both are
 * correctness-critical in ways that are easy to get quietly wrong:
 *
 * CREDENCE FREEZING IS A QUERY, NOT A WRITE. #296 asks for the credence to be
 * "frozen at assessment time" so scoring reads the contemporaneous belief. It
 * needs no new storage: `assessments` is append-only — the only UPDATE
 * anywhere in the repo sets `is_current = false` — so every historical
 * `claim_credence` is already immutable at rest, with its `assessed_at`. The
 * freeze is therefore a SELECTION: the assessment current as of the cutoff.
 * Copying the number into a second column would add a way for the two to
 * disagree and buy nothing.
 *
 * THE CUTOFF IS A LEAKAGE GUARD. Scoring must use what the system believed
 * BEFORE the answer was available, so the cutoff is the EARLIER of the
 * scheduled resolution date and the actual resolution — a question that
 * settles early leaves a window in which an assessment could have peeked, and
 * `LEAST` closes it. Without this the track record scores hindsight and reads
 * beautifully for the wrong reason.
 *
 * ABSTENTIONS ARE COUNTED, NOT DROPPED. A prediction with no usable credence
 * is not scored — but it is recorded and reported, because silently skipping
 * the questions the system declined to answer is a live gaming channel: a
 * forecaster that abstains on everything hard posts a magnificent Brier score.
 * The reasons are distinguished, because they mean different things: a
 * withheld credence is legitimate under §7, while "assessed only after the
 * cutoff" is the leakage guard doing its job.
 */

import type { ResolvedForecast } from "./calibration-scoring.js";

/** One resolved-prediction row as the SQL below returns it. */
export interface PredictionRow {
  id: string;
  claimType: string | null;
  resolutionOutcome: number;
  resolvedAt: Date;
  resolvesAt: Date | null;
  baselineCredence: number | null;
  baselineAsOf: Date | null;
  mergedOpposed: boolean;
  mergedInto: string | null;
  /** Credence of the assessment current as of the cutoff; NULL if none/withheld. */
  frozenCredence: number | null;
  frozenAt: Date | null;
  /** Whether the claim has ANY assessment, ignoring the cutoff. */
  hasAnyAssessment: boolean;
}

export type AbstentionReason =
  /** Never assessed at all — the prediction resolved before anyone judged it. */
  | "never_assessed"
  /** Assessed, but only after the leakage cutoff. */
  | "assessed_after_cutoff"
  /** Assessed in time, but credence deliberately withheld (§7). */
  | "credence_withheld"
  /** Merged into a survivor as its negation; polarity handling not implemented. */
  | "opposed_merge_unsupported";

export interface Abstention {
  claimId: string;
  reason: AbstentionReason;
}

export interface ForecastLoad {
  forecasts: ResolvedForecast[];
  abstentions: Abstention[];
}

/** Whole days between two instants, floored at 0. */
export function horizonDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Decide whether one resolved prediction is scorable, and if not, why.
 * Pure, so every branch is unit-testable without a database.
 */
export function classifyRow(row: PredictionRow): ResolvedForecast | Abstention {
  // An opposed-merged loser's credence is P(NOT the survivor). If it also
  // inherited the survivor's outcome, scoring it unflipped inverts the sign.
  // Rather than guess, abstain loudly: the flag exists so this case is
  // visible, and handling it correctly needs the merge chain walked, which is
  // deliberately out of this first cut.
  if (row.mergedOpposed && row.mergedInto !== null) {
    return { claimId: row.id, reason: "opposed_merge_unsupported" };
  }
  if (row.frozenCredence === null) {
    if (!row.hasAnyAssessment) {
      return { claimId: row.id, reason: "never_assessed" };
    }
    // It has assessments; either none landed before the cutoff, or the one
    // that did withheld its credence. `frozenAt` distinguishes them: it is
    // set only when an in-time assessment was actually selected.
    return {
      claimId: row.id,
      reason: row.frozenAt === null ? "assessed_after_cutoff" : "credence_withheld",
    };
  }

  // The outcome column is a `real` so partial resolutions are representable,
  // but the scorer's Brier/log formulas treat outcome as an indicator. Round
  // to the nearer pole and let a genuinely fractional outcome be visible as
  // such rather than silently distorting the curve.
  const outcome: 0 | 1 = row.resolutionOutcome >= 0.5 ? 1 : 0;

  return {
    id: row.id,
    credence: row.frozenCredence,
    outcome,
    baseline: row.baselineCredence,
    horizonDays: row.frozenAt ? horizonDays(row.frozenAt, row.resolvedAt) : null,
    claimType: row.claimType,
  };
}

export function partitionRows(rows: PredictionRow[]): ForecastLoad {
  const forecasts: ResolvedForecast[] = [];
  const abstentions: Abstention[] = [];
  for (const row of rows) {
    const out = classifyRow(row);
    if ("reason" in out) abstentions.push(out);
    else forecasts.push(out);
  }
  return { forecasts, abstentions };
}

/**
 * The as-of selection. Kept as an exported string so the leakage guard is
 * reviewable in one place and testable against a real database.
 *
 * `LEAST` ignores NULLs in Postgres, so a prediction with no scheduled date
 * still gets its actual resolution as the cutoff.
 */
export const RESOLVED_PREDICTIONS_SQL = `
  SELECT c.id,
         c.claim_type                          AS "claimType",
         c.resolution_outcome                  AS "resolutionOutcome",
         c.resolved_at                         AS "resolvedAt",
         c.resolves_at                         AS "resolvesAt",
         c.baseline_credence                   AS "baselineCredence",
         c.baseline_as_of                      AS "baselineAsOf",
         c.merged_opposed                      AS "mergedOpposed",
         c.merged_into                         AS "mergedInto",
         a.claim_credence                      AS "frozenCredence",
         a.assessed_at                         AS "frozenAt",
         EXISTS (SELECT 1 FROM assessments x WHERE x.claim_id = c.id) AS "hasAnyAssessment"
    FROM claims c
    LEFT JOIN LATERAL (
      SELECT claim_credence, assessed_at
        FROM assessments
       WHERE claim_id = c.id
         AND assessed_at <= LEAST(c.resolves_at, c.resolved_at)
       ORDER BY assessed_at DESC
       LIMIT 1
    ) a ON TRUE
   WHERE c.resolution_criterion IS NOT NULL
     AND c.resolved_at IS NOT NULL
     AND c.resolution_outcome IS NOT NULL
`;

/**
 * Abstention counts by reason, for reporting NEXT TO the Brier score. A track
 * record that omits this is not a track record.
 */
export function summarizeAbstentions(
  abstentions: Abstention[]
): Record<AbstentionReason, number> {
  const out = {
    never_assessed: 0,
    assessed_after_cutoff: 0,
    credence_withheld: 0,
    opposed_merge_unsupported: 0,
  } as Record<AbstentionReason, number>;
  for (const a of abstentions) out[a.reason]++;
  return out;
}
