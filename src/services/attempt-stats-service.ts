/**
 * The platform's attempt record (docs/mathematics.md §7.10): what the house
 * solver has tried, what it cost, and what came of it, read straight off
 * `proof_attempts` so the record is a by-product of the ledger rather than
 * a report anyone writes.
 *
 * One SQL statement returns one row per attempt with the flags the shaping
 * needs; `shapeAttemptStats` is pure and does the counting, so the numbers
 * are unit-testable without a database. The read is memoized briefly, like
 * the other public read models.
 *
 * Two rules from §7.7 hold here as on the claim page: a live attempt is not
 * part of the record, and an unpublished attempt on a claim with a live
 * bounty shows no outcome (it is counted under `withheld`, never listed as
 * a solve) until the Steward has decided.
 *
 * The Grantmaker's stated probability of success is not stored anywhere
 * the ledger keeps past scheduling (the valuation row is pruned once the
 * action leaves `open`, and the plan item's rationale is prose), so the
 * forecasting-calibration deciles are `null` until a structured figure
 * exists.
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import type { AttemptOutcome } from "./claim-extras-types.js";

/** The record's outcome buckets, mapped from the row's status and outcome. */
export type RecordOutcome =
  | "proved"
  | "disproved"
  | "lead"
  | "no_result"
  | "refused"
  | "cancelled"
  | "error"
  | "withheld";

export const RECORD_OUTCOMES: readonly RecordOutcome[] = [
  "proved",
  "disproved",
  "lead",
  "no_result",
  "refused",
  "cancelled",
  "error",
  "withheld",
];

/** Bounty statuses under which an unpublished attempt's outcome is withheld (§7.7). */
const LIVE_BOUNTY_STATUSES = [
  "requested",
  "confirm_pending",
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
];

/** One attempt as the statement returns it: the row plus the derived flags. */
export interface AttemptStatRow {
  id: string;
  claim_id: string;
  claim_text: string;
  grant_id: string | null;
  variant: string;
  status: string;
  outcome: AttemptOutcome | null;
  is_calibration: boolean;
  spent_micro_usd: number;
  finished_at: Date | string | null;
  published_at: Date | string | null;
  /** Unpublished on a claim with a live bounty: the outcome is not public. */
  withheld: boolean;
  /**
   * The claim was already settled before this attempt closed: a `verified`
   * or `contradicted` assessment, or an argument citing an accepted check,
   * recorded before `finished_at`.
   */
  settled_before: boolean;
}

export interface OutcomeStat {
  outcome: RecordOutcome;
  count: number;
  owls_spent: number;
  median_cost_owls: number | null;
}

export interface VariantStat {
  variant: string;
  count: number;
  /** Attempts that closed with a checked proof or disproof. */
  settled: number;
  owls_spent: number;
  median_cost_owls: number | null;
}

export interface CalibrationProblem {
  claim_id: string;
  claim_text: string;
  attempts: number;
  passes: number;
  pass_rate: number | null;
  owls_spent: number;
  cost_per_pass_owls: number | null;
  last_finished_at: string | null;
}

export interface HouseSolve {
  attempt_id: string;
  claim_id: string;
  claim_text: string;
  outcome: "proof" | "disproof";
  variant: string;
  finished_at: string | null;
  owls_spent: number;
}

export interface AttemptStats {
  grant_id: string | null;
  generated_at: string;
  totals: {
    /** Closed attempts: the record. */
    attempts: number;
    /** Running or cancelling attempts, not yet part of the record. */
    live: number;
    owls_spent: number;
    median_cost_owls: number | null;
  };
  by_outcome: OutcomeStat[];
  by_variant: VariantStat[];
  /** The settled problems the harness was calibrated on (§7.5). */
  calibration_series: {
    attempts: number;
    passes: number;
    pass_rate: number | null;
    owls_spent: number;
    cost_per_pass_owls: number | null;
    problems: CalibrationProblem[];
  };
  /**
   * Forecasting calibration: the Grantmaker's stated probability against
   * the realized rate, by decile. Null while no stated probability is
   * stored (see the module comment).
   */
  calibration: null | {
    deciles: Array<{
      decile: number;
      stated_low: number;
      stated_high: number;
      attempts: number;
      successes: number;
      realized_rate: number | null;
    }>;
  };
  /** House solves of claims that were open with no published proof. */
  novel_proofs: { count: number; items: HouseSolve[] };
  /** House solves of claims already settled, calibration runs included. */
  rediscoveries: { count: number; items: HouseSolve[] };
}

const LIVE_STATUSES = new Set(["running", "cancelling"]);

/** Which bucket a closed attempt lands in. */
export function recordOutcome(row: {
  status: string;
  outcome: AttemptOutcome | null;
  withheld: boolean;
}): RecordOutcome {
  if (row.withheld) return "withheld";
  switch (row.status) {
    case "completed":
      switch (row.outcome) {
        case "proof":
          return "proved";
        case "disproof":
          return "disproved";
        case "partial":
        case "reduction":
          return "lead";
        default:
          return "no_result";
      }
    case "refused":
      return "refused";
    case "cancelled":
      return "cancelled";
    default:
      return "error";
  }
}

/** The median of a list of micro-USD amounts, in owls; null for an empty list. */
export function medianOwls(microUsd: readonly number[]): number | null {
  if (microUsd.length === 0) return null;
  const sorted = [...microUsd].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return microUsdToOwls(median);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function sumOwls(rows: readonly AttemptStatRow[]): number {
  return microUsdToOwls(rows.reduce((acc, r) => acc + Number(r.spent_micro_usd), 0));
}

function rate(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
}

function isSettledOutcome(row: AttemptStatRow): row is AttemptStatRow & {
  outcome: "proof" | "disproof";
} {
  return (
    row.status === "completed" &&
    !row.withheld &&
    (row.outcome === "proof" || row.outcome === "disproof")
  );
}

function houseSolve(row: AttemptStatRow & { outcome: "proof" | "disproof" }): HouseSolve {
  return {
    attempt_id: row.id,
    claim_id: row.claim_id,
    claim_text: row.claim_text,
    outcome: row.outcome,
    variant: row.variant,
    finished_at: iso(row.finished_at),
    owls_spent: microUsdToOwls(Number(row.spent_micro_usd)),
  };
}

/**
 * Shape the record from the statement's rows. Pure: the counts, sums, and
 * medians are computed here so a unit test can pin them without a
 * database.
 */
export function shapeAttemptStats(
  rows: readonly AttemptStatRow[],
  opts: { grantId?: string | null; now?: Date } = {}
): AttemptStats {
  const live = rows.filter((r) => LIVE_STATUSES.has(r.status));
  const closed = rows.filter((r) => !LIVE_STATUSES.has(r.status));
  const spend = (list: readonly AttemptStatRow[]) => list.map((r) => Number(r.spent_micro_usd));

  const byOutcome: OutcomeStat[] = RECORD_OUTCOMES.map((outcome) => {
    const list = closed.filter((r) => recordOutcome(r) === outcome);
    return {
      outcome,
      count: list.length,
      owls_spent: sumOwls(list),
      median_cost_owls: medianOwls(spend(list)),
    };
  }).filter((s) => s.count > 0);

  const variants = [...new Set(closed.map((r) => r.variant))].sort();
  const byVariant: VariantStat[] = variants.map((variant) => {
    const list = closed.filter((r) => r.variant === variant);
    return {
      variant,
      count: list.length,
      settled: list.filter(isSettledOutcome).length,
      owls_spent: sumOwls(list),
      median_cost_owls: medianOwls(spend(list)),
    };
  });

  const calibration = closed.filter((r) => r.is_calibration);
  const byClaim = new Map<string, AttemptStatRow[]>();
  for (const r of calibration) {
    const list = byClaim.get(r.claim_id) ?? [];
    list.push(r);
    byClaim.set(r.claim_id, list);
  }
  const problems: CalibrationProblem[] = [...byClaim.entries()]
    .map(([claimId, list]) => {
      const passes = list.filter(isSettledOutcome).length;
      const owls = sumOwls(list);
      const finished = list
        .map((r) => iso(r.finished_at))
        .filter((d): d is string => d !== null)
        .sort();
      return {
        claim_id: claimId,
        claim_text: list[0]!.claim_text,
        attempts: list.length,
        passes,
        pass_rate: rate(passes, list.length),
        owls_spent: owls,
        cost_per_pass_owls: passes > 0 ? Math.round((owls / passes) * 1000) / 1000 : null,
        last_finished_at: finished.length > 0 ? finished[finished.length - 1]! : null,
      };
    })
    .sort((a, b) => (b.last_finished_at ?? "").localeCompare(a.last_finished_at ?? ""));
  const calibrationPasses = calibration.filter(isSettledOutcome).length;
  const calibrationOwls = sumOwls(calibration);

  const solves = closed.filter(isSettledOutcome);
  const novel = solves.filter((r) => !r.is_calibration && !r.settled_before);
  const rediscovered = solves.filter((r) => r.is_calibration || r.settled_before);
  const newestFirst = (a: HouseSolve, b: HouseSolve) =>
    (b.finished_at ?? "").localeCompare(a.finished_at ?? "");

  return {
    grant_id: opts.grantId ?? null,
    generated_at: (opts.now ?? new Date()).toISOString(),
    totals: {
      attempts: closed.length,
      live: live.length,
      owls_spent: sumOwls(closed),
      median_cost_owls: medianOwls(spend(closed)),
    },
    by_outcome: byOutcome,
    by_variant: byVariant,
    calibration_series: {
      attempts: calibration.length,
      passes: calibrationPasses,
      pass_rate: rate(calibrationPasses, calibration.length),
      owls_spent: calibrationOwls,
      cost_per_pass_owls:
        calibrationPasses > 0
          ? Math.round((calibrationOwls / calibrationPasses) * 1000) / 1000
          : null,
      problems,
    },
    calibration: null,
    novel_proofs: { count: novel.length, items: novel.map(houseSolve).sort(newestFirst) },
    rediscoveries: {
      count: rediscovered.length,
      items: rediscovered.map(houseSolve).sort(newestFirst),
    },
  };
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The statement: every attempt (the shaping separates live from closed),
 * with the claim's text, whether its outcome is withheld, and whether the
 * claim was settled before the attempt closed.
 */
export async function loadAttemptStatRows(
  grantId: string | null = null
): Promise<AttemptStatRow[]> {
  const rows = await rawQuery<AttemptStatRow>(
    `SELECT pa.id, pa.claim_id, c.text AS claim_text, pa.grant_id, pa.variant, pa.status,
            pa.outcome, pa.is_calibration,
            pa.spent_micro_usd::bigint AS spent_micro_usd,
            pa.finished_at, pa.published_at,
            (pa.published_at IS NULL
             AND EXISTS (SELECT 1 FROM bounties b
                          WHERE b.claim_id = pa.claim_id AND b.status = ANY($2))) AS withheld,
            (pa.finished_at IS NOT NULL
             AND (EXISTS (SELECT 1 FROM assessments a
                           WHERE a.claim_id = pa.claim_id
                             AND a.status IN ('verified', 'contradicted')
                             AND a.assessed_at < pa.finished_at)
                  OR EXISTS (SELECT 1
                               FROM arguments ar, unnest(ar.evidence_urls) u
                               JOIN lean_checks lc
                                 ON lc.id::text = substring(lower(u) from '/lean-checks/(${UUID_PATTERN})(?:/|$)')
                               JOIN claim_formalizations cf ON cf.id = lc.formalization_id
                              WHERE ar.claim_id = pa.claim_id
                                AND ar.created_at < pa.finished_at
                                AND cf.claim_id = pa.claim_id
                                AND lc.verdict = 'accepted'))) AS settled_before
       FROM proof_attempts pa
       JOIN claims c ON c.id = pa.claim_id
      WHERE ($1::uuid IS NULL OR pa.grant_id = $1::uuid)
      ORDER BY pa.finished_at DESC NULLS FIRST, pa.started_at DESC`,
    [grantId, LIVE_BOUNTY_STATUSES]
  );
  return rows.map((r) => ({
    ...r,
    spent_micro_usd: Number(r.spent_micro_usd),
    withheld: r.withheld === true,
    settled_before: r.settled_before === true,
  }));
}

/** How long a computed record is served before it is recomputed. */
export const ATTEMPT_STATS_TTL_MS = 30_000;

const cache = new Map<string, { value: AttemptStats; expiresAt: number }>();

export function resetAttemptStatsCache(): void {
  cache.clear();
}

/** `GET /attempts/stats` and `?grant_id=` (§7.10): the record, memoized briefly. */
export async function getAttemptStats(
  grantId: string | null = null,
  opts: { now?: Date } = {}
): Promise<AttemptStats> {
  const now = opts.now ?? new Date();
  const key = grantId ?? "";
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now.getTime()) return hit.value;
  const rows = await loadAttemptStatRows(grantId);
  const value = shapeAttemptStats(rows, { grantId, now });
  cache.set(key, { value, expiresAt: now.getTime() + ATTEMPT_STATS_TTL_MS });
  return value;
}
