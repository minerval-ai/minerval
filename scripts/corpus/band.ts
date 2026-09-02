/**
 * Noise-band comparison (#334 L2, from #99's "N≈3, mean ± spread"): the
 * arithmetic that turns "these two scorecards differ" into "this delta is
 * real" — or, more often, into "you have one sample; run it again".
 *
 * LLM output is nondeterministic, so one run is one draw. A metric's value
 * for a configuration is the mean over its runs, its noise is their spread,
 * and a change between configurations counts only when the difference of
 * means exceeds the combined spread. With a single run on a side there is no
 * spread to speak of, so the row is marked single-sample and no verdict is
 * given — corpus:compare prints the delta, but refuses to call it real.
 *
 * Pure and DB-free: takes the numbers, returns the rows. compare.ts loads
 * the scorecards; a future CI gate reads the verdicts.
 */
import type { Scorecard } from "./score.js";

export interface BandStat {
  n: number;
  mean: number | null;
  /** Sample standard deviation; null below n=2. */
  sd: number | null;
  min: number | null;
  max: number | null;
}

/** Mean/spread of the non-null values; n counts only those. */
export function bandStat(values: Array<number | null | undefined>): BandStat {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, sd: null, min: null, max: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd =
    n >= 2
      ? Math.sqrt(xs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1))
      : null;
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

export type BandVerdict =
  /** Both sides have ≥2 runs and |Δ mean| exceeds sdA + sdB. */
  | "clears-band"
  /** Both sides have ≥2 runs and the delta sits inside the spread. */
  | "within-band"
  /** A side has exactly one run: no spread, no verdict. */
  | "single-sample"
  /** A side has no value for this metric (e.g. unjudged). */
  | "n/a";

export interface BandRow {
  label: string;
  a: BandStat;
  b: BandStat;
  /** meanB − meanA, when both exist. */
  delta: number | null;
  /** The noise the delta has to clear: sdA + sdB over the sides that have one. */
  band: number | null;
  verdict: BandVerdict;
  /** True when exactly one side has spread; the verdict then leans on it alone. */
  oneSided: boolean;
}

/**
 * Compare one metric across two groups of runs. The band is the sum of the
 * sides' sample standard deviations; a side with one run contributes none
 * and, if the other side has spread, the verdict is computed one-sided
 * against that spread alone — weaker evidence, and flagged as such. Both
 * sides single: no verdict at all.
 */
export function compareBand(
  label: string,
  aValues: Array<number | null | undefined>,
  bValues: Array<number | null | undefined>
): BandRow {
  const a = bandStat(aValues);
  const b = bandStat(bValues);
  const base = { label, a, b };
  if (a.mean === null || b.mean === null) {
    return { ...base, delta: null, band: null, verdict: "n/a", oneSided: false };
  }
  const delta = b.mean - a.mean;
  const spreads = [a.sd, b.sd].filter((s): s is number => s !== null);
  if (spreads.length === 0) {
    return { ...base, delta, band: null, verdict: "single-sample", oneSided: false };
  }
  const band = spreads.reduce((x, y) => x + y, 0);
  const oneSided = spreads.length === 1;
  const verdict: BandVerdict = Math.abs(delta) > band ? "clears-band" : "within-band";
  return { ...base, delta, band, verdict, oneSided };
}

/**
 * The headline metrics every comparison reports, one getter per row. Shared
 * so compare.ts and any gate read the same numbers off a scorecard.
 */
export const HEADLINE_METRICS: Array<{
  label: string;
  get: (s: Scorecard) => number | null | undefined;
}> = [
  { label: "A · claims per 1k words", get: (s) => s.structural.extraction.claimsPer1kWords },
  { label: "B · canonical p90 words", get: (s) => s.structural.canonicalForm.wordCount.p90 },
  { label: "B · share > 25 words", get: (s) => s.structural.canonicalForm.overLongShare },
  { label: "C · dedup ratio", get: (s) => s.structural.matching.dedupRatio },
  { label: "D · max depth", get: (s) => s.structural.decomposition.maxDepth },
  { label: "D · atomic share", get: (s) => s.structural.decomposition.atomicShare },
  { label: "E · shared subclaims", get: (s) => s.structural.crossDoc.sharedSubclaims },
  { label: "F · % with trace", get: (s) => s.structural.assessment.pctWithTrace },
  { label: "§21 · coherence violations", get: (s) => s.structural.coherence?.violations },
  { label: "imp · mean", get: (s) => s.structural.importance.mean },
  {
    label: "imp · atomic vs compound gap",
    get: (s) => {
      const at = s.structural.importance.meanAtomic;
      const co = s.structural.importance.meanCompound;
      return at == null || co == null ? null : at - co;
    },
  },
  { label: "judge · claim-bar pass-rate", get: (s) => s.judged?.claimBarPassRate },
  {
    label: "judge · importance overrated share",
    get: (s) => s.judged?.importanceAlignment.overratedShare,
  },
  { label: "judge · readability", get: (s) => s.judged?.assessmentQuality.readability },
  { label: "judge · reasoning-fit", get: (s) => s.judged?.assessmentQuality.reasoningFit },
  { label: "judge · impartiality", get: (s) => s.judged?.assessmentQuality.impartiality },
];

/** Every headline metric compared across two groups of scorecards. */
export function compareScorecards(a: Scorecard[], b: Scorecard[]): BandRow[] {
  return HEADLINE_METRICS.map((m) =>
    compareBand(
      m.label,
      a.map((s) => m.get(s)),
      b.map((s) => m.get(s))
    )
  );
}

const fmt = (x: number | null): string => (x === null ? "n/a" : String(Math.round(x * 100) / 100));

/** `mean ± sd` for a side, or the lone value, or n/a. */
export function formatSide(s: BandStat): string {
  if (s.mean === null) return "n/a";
  if (s.sd === null) return fmt(s.mean);
  return `${fmt(s.mean)} ± ${fmt(s.sd)}`;
}

export function formatDelta(row: BandRow): string {
  if (row.delta === null) return "";
  const sign = row.delta > 0 ? "+" : "";
  return `${sign}${fmt(row.delta)}`;
}

export function formatVerdict(row: BandRow): string {
  switch (row.verdict) {
    case "clears-band":
      return row.oneSided ? "CLEARS band (one-sided)" : "CLEARS band";
    case "within-band":
      return row.oneSided ? "within band (one-sided)" : "within band";
    case "single-sample":
      return "single sample — no verdict";
    case "n/a":
      return "";
  }
}
