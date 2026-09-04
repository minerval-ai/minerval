/**
 * Calibration scoring for resolved predictions (#334 S6, from #296) — pure,
 * DB-free, unit-tested. scripts/predictions.ts loads the rows and hands them
 * here.
 *
 * What is scored is the credence the Steward actually held when the world
 * was still undecided: the last credence stated at or before the cutoff
 * (the actual resolution, or the scheduled resolution date if earlier).
 * Assessment history is immutable, so that is a read, not a snapshot.
 * Never a later revision — the backtest grades what the system believed
 * then.
 *
 * Scores: Brier (mean squared error of the probability), log score (natural
 * log, clipped so a confident miss is finite), a calibration curve (realized
 * frequency by credence bucket) and expected calibration error, sliced by
 * domain — and the same for the baseline probability where one was attached,
 * which is the Minerval-vs-crowd comparative.
 */

export interface CredenceRecord {
  credence: number | null;
  assessedAt: Date;
}

/**
 * The credence in force at `cutoff`: the latest record with a stated
 * credence assessed at or before it. Null when nothing was stated in time —
 * a prediction the system never forecast is not scored, and counts as such.
 */
export function frozenCredence(
  history: CredenceRecord[],
  cutoff: Date
): { credence: number; assessedAt: Date } | null {
  let best: { credence: number; assessedAt: Date } | null = null;
  for (const h of history) {
    if (h.credence === null || h.credence === undefined) continue;
    if (h.assessedAt.getTime() > cutoff.getTime()) continue;
    if (!best || h.assessedAt.getTime() > best.assessedAt.getTime()) {
      best = { credence: h.credence, assessedAt: h.assessedAt };
    }
  }
  return best;
}

export interface ScoredPrediction {
  id: string;
  credence: number;
  outcome: boolean;
  baseline?: number | null;
  domain?: string | null;
}

const EPS = 1e-4;
const clip = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));

export function brier(p: number, outcome: boolean): number {
  const y = outcome ? 1 : 0;
  return (p - y) ** 2;
}

/** Natural-log score of the realized outcome; higher (closer to 0) is better. */
export function logScore(p: number, outcome: boolean): number {
  const q = clip(p);
  return Math.log(outcome ? q : 1 - q);
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  meanCredence: number | null;
  realized: number | null;
}

export function calibrationCurve(
  items: Array<{ credence: number; outcome: boolean }>,
  bins = 10
): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: 0,
    meanCredence: null,
    realized: null,
  }));
  const sums = buckets.map(() => ({ credence: 0, hits: 0 }));
  for (const it of items) {
    const i = Math.min(bins - 1, Math.floor(it.credence * bins));
    buckets[i]!.n++;
    sums[i]!.credence += it.credence;
    if (it.outcome) sums[i]!.hits++;
  }
  for (const [i, b] of buckets.entries()) {
    if (b.n > 0) {
      b.meanCredence = sums[i]!.credence / b.n;
      b.realized = sums[i]!.hits / b.n;
    }
  }
  return buckets;
}

/** Expected calibration error: bucket-weighted |realized − mean credence|. */
export function expectedCalibrationError(
  items: Array<{ credence: number; outcome: boolean }>,
  bins = 10
): number | null {
  if (items.length === 0) return null;
  const curve = calibrationCurve(items, bins);
  let err = 0;
  for (const b of curve) {
    if (b.n === 0) continue;
    err += (b.n / items.length) * Math.abs(b.realized! - b.meanCredence!);
  }
  return err;
}

export interface ScoreSummary {
  n: number;
  brier: number | null;
  logScore: number | null;
  ece: number | null;
}

function summarize(items: Array<{ credence: number; outcome: boolean }>): ScoreSummary {
  if (items.length === 0) return { n: 0, brier: null, logScore: null, ece: null };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: items.length,
    brier: mean(items.map((i) => brier(i.credence, i.outcome))),
    logScore: mean(items.map((i) => logScore(i.credence, i.outcome))),
    ece: expectedCalibrationError(items),
  };
}

export interface CalibrationReport {
  minerval: ScoreSummary;
  /** Over the subset that has a baseline, for both sides — a fair comparison. */
  comparative: { minerval: ScoreSummary; baseline: ScoreSummary } | null;
  curve: CalibrationBucket[];
  byDomain: Record<string, ScoreSummary>;
  /** Share of resolved predictions the system predicted true; a sharpness hint. */
  baseRate: number | null;
}

export function scoreCalibration(items: ScoredPrediction[]): CalibrationReport {
  const withBaseline = items.filter(
    (i): i is ScoredPrediction & { baseline: number } =>
      typeof i.baseline === "number" && Number.isFinite(i.baseline)
  );
  const byDomain: Record<string, ScoreSummary> = {};
  const domains = new Map<string, ScoredPrediction[]>();
  for (const it of items) {
    const d = it.domain ?? "unspecified";
    (domains.get(d) ?? domains.set(d, []).get(d)!).push(it);
  }
  for (const [d, list] of [...domains.entries()].sort()) byDomain[d] = summarize(list);
  return {
    minerval: summarize(items),
    comparative:
      withBaseline.length > 0
        ? {
            minerval: summarize(withBaseline),
            baseline: summarize(
              withBaseline.map((i) => ({ credence: i.baseline, outcome: i.outcome }))
            ),
          }
        : null,
    curve: calibrationCurve(items),
    byDomain,
    baseRate: items.length ? items.filter((i) => i.outcome).length / items.length : null,
  };
}
