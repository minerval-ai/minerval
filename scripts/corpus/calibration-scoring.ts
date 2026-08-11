/**
 * Calibration scoring (#334 S6, from #296) — the reality-judged instruments.
 *
 * Predictions are the one class of claim where reality eventually supplies
 * ground truth, so this is the only place the system can be scored for
 * CORRECTNESS rather than for coherence or agreement. Everything here is pure
 * and DB-free: it takes resolved forecasts and returns numbers. What produces
 * those forecasts (the predictions schema, the resolution watcher) is a
 * separate concern deliberately kept out of this file, so the instruments can
 * be unit-tested against hand-built cases and reused by any caller.
 *
 * Three honesty constraints are wired in rather than left to the reader:
 *
 *  - UNSCORABLE FORECASTS ARE COUNTED, NEVER DROPPED. The constitution (§7)
 *    says a credence is deliberately omitted where a single number would be
 *    false precision. Those predictions cannot be scored — but silently
 *    filtering them biases the track record toward the questions the system
 *    felt confident about, which is exactly the flattery a calibration track
 *    exists to prevent. Every result carries `excluded`.
 *  - SMALL n IS SAID OUT LOUD. Early on there will be a handful of resolved
 *    predictions. Every result carries `n`, and `sufficient` is false below a
 *    threshold where these statistics are descriptive at best.
 *  - THE DECOMPOSITION'S RESIDUAL IS REPORTED. Murphy's identity
 *    (Brier = reliability − resolution + uncertainty) is exact only when
 *    forecasts take exactly their bin's mean value; with real continuous
 *    forecasts binning leaves a discretization residual. Hiding it would make
 *    the decomposition look cleaner than it is, so it is returned.
 */

/** One resolved prediction: what we believed, and what actually happened. */
export interface ResolvedForecast {
  id: string;
  /**
   * Our probability the claim was true, frozen at assessment time. NULL is
   * legitimate (§7) and makes the forecast unscorable rather than wrong.
   */
  credence: number | null;
  /** Realized outcome: 1 = the claim turned out true, 0 = false. */
  outcome: 0 | 1;
  /** The market/community probability at the same time, when we have one. */
  baseline?: number | null;
  /** Days from assessment to resolution — the horizon slice. */
  horizonDays?: number | null;
  claimType?: string | null;
  domain?: string | null;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  n: number;
  meanCredence: number;
  realizedFrequency: number;
}

export interface CalibrationResult {
  n: number;
  /** Forecasts that could not be scored, by reason. Never silently dropped. */
  excluded: { nullCredence: number; outOfRange: number };
  /** False when n is too small for these numbers to mean much. */
  sufficient: boolean;
  baseRate: number;
  brier: number;
  logScore: number;
  /** Mean |credence − 0.5|: how far the system dares to depart from ignorance. */
  sharpness: number;
  bins: CalibrationBin[];
  /** Σ (n_b/N)·|meanCredence_b − realizedFrequency_b| */
  ece: number;
  decomposition: {
    reliability: number;
    resolution: number;
    uncertainty: number;
    /** brier − (reliability − resolution + uncertainty). Binning artifact. */
    residual: number;
  };
  /** Brier skill vs. always predicting the base rate. >0 beats climatology. */
  skillVsClimatology: number;
  /** Present only when baselines exist for at least one scored forecast. */
  vsBaseline: BaselineComparison | null;
}

export interface BaselineComparison {
  n: number;
  ourBrier: number;
  baselineBrier: number;
  /** 1 − ourBrier/baselineBrier. >0 means we beat the crowd. */
  skillScore: number;
  /** Where we departed from the baseline, was the departure right? */
  divergence: {
    /** |credence − baseline| ≥ threshold */
    n: number;
    /** Of those, how often our side of the disagreement was the correct one. */
    weWereRightShare: number;
    meanAbsDivergence: number;
  };
}

/**
 * Below this many scored forecasts, treat every number here as descriptive.
 * Ten is not a statistical threshold — it is a "stop quoting this as evidence"
 * threshold, deliberately low because the track's whole point is that signal
 * accrues slowly and we still want to look at it early.
 */
export const SUFFICIENT_N = 10;

/**
 * Log score needs a floor: a confident miss at p=0 is infinitely penalized,
 * which would let one wrong certainty swamp every other result forever. 1e-6
 * caps a single maximally-wrong forecast at ~13.8 nats — severe, which is the
 * point, but finite.
 */
const LOG_EPSILON = 1e-6;

function clamp01(p: number): number {
  return Math.min(1 - LOG_EPSILON, Math.max(LOG_EPSILON, p));
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Scorable = credence present and a real probability. */
export function partitionScorable(forecasts: ResolvedForecast[]): {
  scorable: Array<ResolvedForecast & { credence: number }>;
  nullCredence: number;
  outOfRange: number;
} {
  const scorable: Array<ResolvedForecast & { credence: number }> = [];
  let nullCredence = 0;
  let outOfRange = 0;
  for (const f of forecasts) {
    if (f.credence === null || f.credence === undefined || Number.isNaN(f.credence)) {
      nullCredence++;
      continue;
    }
    if (f.credence < 0 || f.credence > 1) {
      outOfRange++;
      continue;
    }
    scorable.push(f as ResolvedForecast & { credence: number });
  }
  return { scorable, nullCredence, outOfRange };
}

export function brier(forecasts: Array<{ credence: number; outcome: 0 | 1 }>): number {
  return mean(forecasts.map((f) => (f.credence - f.outcome) ** 2));
}

export function logScore(forecasts: Array<{ credence: number; outcome: 0 | 1 }>): number {
  return mean(
    forecasts.map((f) => {
      const p = clamp01(f.credence);
      return -(f.outcome === 1 ? Math.log(p) : Math.log(1 - p));
    })
  );
}

/**
 * Realized frequency by credence bucket. Bins are half-open [lower, upper)
 * except the last, which includes 1.0 — so a credence of exactly 1 lands in
 * the top bin instead of falling off the end.
 */
export function calibrationCurve(
  forecasts: Array<{ credence: number; outcome: 0 | 1 }>,
  bucketCount = 10
): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lower = i / bucketCount;
    const upper = (i + 1) / bucketCount;
    const inBin = forecasts.filter((f) =>
      i === bucketCount - 1 ? f.credence >= lower : f.credence >= lower && f.credence < upper
    );
    bins.push({
      lower,
      upper,
      n: inBin.length,
      meanCredence: mean(inBin.map((f) => f.credence)),
      realizedFrequency: mean(inBin.map((f) => f.outcome)),
    });
  }
  return bins;
}

/** Σ (n_b/N)·|meanCredence_b − realizedFrequency_b| over non-empty bins. */
export function expectedCalibrationError(bins: CalibrationBin[]): number {
  const total = bins.reduce((s, b) => s + b.n, 0);
  if (total === 0) return 0;
  return bins
    .filter((b) => b.n > 0)
    .reduce((s, b) => s + (b.n / total) * Math.abs(b.meanCredence - b.realizedFrequency), 0);
}

export function compareToBaseline(
  forecasts: Array<{ credence: number; outcome: 0 | 1; baseline?: number | null }>,
  divergenceThreshold = 0.1
): BaselineComparison | null {
  const withBaseline = forecasts.filter(
    (f) => typeof f.baseline === "number" && f.baseline >= 0 && f.baseline <= 1
  ) as Array<{ credence: number; outcome: 0 | 1; baseline: number }>;
  if (withBaseline.length === 0) return null;

  const ourBrier = brier(withBaseline);
  const baselineBrier = brier(
    withBaseline.map((f) => ({ credence: f.baseline, outcome: f.outcome }))
  );

  const diverged = withBaseline.filter(
    (f) => Math.abs(f.credence - f.baseline) >= divergenceThreshold
  );
  // "We were right" = our probability sat on the correct side of the
  // baseline's, i.e. we moved toward the outcome that actually happened.
  const weWereRight = diverged.filter((f) =>
    f.outcome === 1 ? f.credence > f.baseline : f.credence < f.baseline
  );

  return {
    n: withBaseline.length,
    ourBrier,
    baselineBrier,
    // A perfect baseline (Brier 0) makes skill undefined; report 0 rather than
    // -Infinity, since "the crowd was flawless" is not skill information.
    skillScore: baselineBrier === 0 ? 0 : 1 - ourBrier / baselineBrier,
    divergence: {
      n: diverged.length,
      weWereRightShare: diverged.length === 0 ? 0 : weWereRight.length / diverged.length,
      meanAbsDivergence: mean(diverged.map((f) => Math.abs(f.credence - f.baseline))),
    },
  };
}

export function scoreCalibration(
  forecasts: ResolvedForecast[],
  bucketCount = 10
): CalibrationResult {
  const { scorable, nullCredence, outOfRange } = partitionScorable(forecasts);
  const n = scorable.length;
  const excluded = { nullCredence, outOfRange };

  if (n === 0) {
    return {
      n: 0,
      excluded,
      sufficient: false,
      baseRate: 0,
      brier: 0,
      logScore: 0,
      sharpness: 0,
      bins: calibrationCurve([], bucketCount),
      ece: 0,
      decomposition: { reliability: 0, resolution: 0, uncertainty: 0, residual: 0 },
      skillVsClimatology: 0,
      vsBaseline: null,
    };
  }

  const baseRate = mean(scorable.map((f) => f.outcome));
  const bs = brier(scorable);
  const bins = calibrationCurve(scorable, bucketCount);

  // Murphy: reliability (calibration error, lower better), resolution (how far
  // bins depart from the base rate — discrimination, higher better),
  // uncertainty (the irreducible difficulty of the question set).
  const reliability =
    bins.filter((b) => b.n > 0).reduce((s, b) => s + b.n * (b.meanCredence - b.realizedFrequency) ** 2, 0) / n;
  const resolution =
    bins.filter((b) => b.n > 0).reduce((s, b) => s + b.n * (b.realizedFrequency - baseRate) ** 2, 0) / n;
  const uncertainty = baseRate * (1 - baseRate);

  const climatologyBrier = brier(scorable.map((f) => ({ credence: baseRate, outcome: f.outcome })));

  return {
    n,
    excluded,
    sufficient: n >= SUFFICIENT_N,
    baseRate,
    brier: bs,
    logScore: logScore(scorable),
    sharpness: mean(scorable.map((f) => Math.abs(f.credence - 0.5))),
    bins,
    ece: expectedCalibrationError(bins),
    decomposition: {
      reliability,
      resolution,
      uncertainty,
      residual: bs - (reliability - resolution + uncertainty),
    },
    // Climatology Brier is 0 only when every outcome is identical, in which
    // case there is no skill to measure against it.
    skillVsClimatology: climatologyBrier === 0 ? 0 : 1 - bs / climatologyBrier,
    vsBaseline: compareToBaseline(scorable),
  };
}

export interface SliceResult {
  slice: string;
  result: CalibrationResult;
  /** ECE of every forecast NOT in this slice, and how many there are. */
  complementEce: number;
  complementN: number;
  /**
   * slice ECE − complement ECE. POSITIVE means this slice is worse calibrated
   * than everything else — the singularity signal #296 is hunting for.
   *
   * Signed, and against the COMPLEMENT rather than the pooled set, for a
   * reason worth stating: |slice − pooled| is mathematically identical for
   * both halves of a two-slice split (each sits equidistant from a mean that
   * includes it), so it can report that slices differ but never which one is
   * anomalous — useless for the thing this metric exists to find. Comparing
   * against the complement and keeping the sign says "long-horizon is 0.95
   * worse calibrated than everything else", which is the actual finding.
   *
   * Only meaningful once both the slice and its complement are `sufficient`;
   * that flag travels with every result for exactly this reason.
   */
  eceVsComplement: number;
}

/**
 * Calibration by sub-domain — short vs. long horizon, by claim type, by
 * domain. #296's holomorphy argument stands or falls here: uniform calibration
 * across slices licenses extending trust to the unmeasurable core; a slice
 * that breaks from the rest is the singularity worth finding.
 */
export function scoreBySlice(
  forecasts: ResolvedForecast[],
  sliceOf: (f: ResolvedForecast) => string | null,
  bucketCount = 10
): { pooled: CalibrationResult; slices: SliceResult[] } {
  const pooled = scoreCalibration(forecasts, bucketCount);
  const groups = new Map<string, ResolvedForecast[]>();
  for (const f of forecasts) {
    const key = sliceOf(f);
    if (key === null) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  const slices = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slice, fs]) => {
      const result = scoreCalibration(fs, bucketCount);
      const inSlice = new Set(fs.map((x) => x.id));
      const complement = scoreCalibration(
        forecasts.filter((x) => !inSlice.has(x.id) && sliceOf(x) !== null),
        bucketCount
      );
      return {
        slice,
        result,
        complementEce: complement.ece,
        complementN: complement.n,
        eceVsComplement: result.ece - complement.ece,
      };
    });
  return { pooled, slices };
}

/** Conventional horizon buckets for the short-vs-long calibration slice. */
export function horizonSlice(f: ResolvedForecast): string | null {
  if (f.horizonDays === null || f.horizonDays === undefined) return null;
  if (f.horizonDays <= 30) return "<=30d";
  if (f.horizonDays <= 180) return "31-180d";
  if (f.horizonDays <= 365) return "181-365d";
  return ">365d";
}

export function formatCalibration(r: CalibrationResult): string {
  if (r.n === 0) {
    return `no scorable forecasts (excluded: ${r.excluded.nullCredence} null-credence, ${r.excluded.outOfRange} out-of-range)`;
  }
  const caveat = r.sufficient ? "" : ` [n<${SUFFICIENT_N}: descriptive only]`;
  const vs = r.vsBaseline
    ? ` · vs baseline ${r.vsBaseline.skillScore >= 0 ? "+" : ""}${r.vsBaseline.skillScore.toFixed(3)} skill` +
      ` (${r.vsBaseline.divergence.n} divergences, ${(r.vsBaseline.divergence.weWereRightShare * 100).toFixed(0)}% ours right)`
    : "";
  return (
    `n=${r.n} · Brier ${r.brier.toFixed(4)} · log ${r.logScore.toFixed(4)} · ` +
    `ECE ${r.ece.toFixed(4)} · sharpness ${r.sharpness.toFixed(3)} · ` +
    `skill vs climatology ${r.skillVsClimatology >= 0 ? "+" : ""}${r.skillVsClimatology.toFixed(3)}${vs}${caveat}`
  );
}
