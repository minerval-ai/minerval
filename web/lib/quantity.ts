import type { QuantityEstimate, QuantityUnit, Quantile, ValueRange } from "./types";

// ---------------------------------------------------------------------------
// Quantities (constitution §2, §10): one place that knows how to put any
// value on an axis and into words, whatever its unit and however wide its
// uncertainty. Every surface that shows a quantity (the quantity page, a
// threshold claim's panel, the map's chips, a question's answers) reads
// through here, so an estimate is stated the same way wherever it appears.
// ---------------------------------------------------------------------------

const MINUS = "−";

export type ScaleKind = "linear" | "log";

export interface Tick { v: number; label: string; major: boolean }

export interface ValueScale {
  kind: ScaleKind;
  lo: number;
  hi: number;
  unit: QuantityUnit;
  /** Position of a value on the axis, 0 at the left edge and 1 at the right. */
  pos(v: number): number;
  ticks: Tick[];
}

// ---- reading an estimate ---------------------------------------------------

export function sortedQuantiles(est: QuantityEstimate): Quantile[] {
  return [...(est.quantiles ?? [])].filter((q) => Number.isFinite(q.v)).sort((a, b) => a.p - b.p);
}

/** The value at probability p, interpolated between stored quantiles. */
export function quantileAt(qs: Quantile[], p: number): number | null {
  if (!qs.length) return null;
  if (p <= qs[0].p) return qs[0].v;
  for (let i = 1; i < qs.length; i++) {
    if (p <= qs[i].p) {
      const a = qs[i - 1], b = qs[i];
      return a.v + ((p - a.p) / (b.p - a.p)) * (b.v - a.v);
    }
  }
  return qs[qs.length - 1].v;
}

/**
 * P(value > x) from the stored quantiles, interpolated, for checking a
 * threshold claim's credence against the estimate. Outside the outermost
 * quantiles it reports the tail mass as a bound (e.g. "< 0.05"), never a
 * fabricated figure.
 */
export function probAbove(est: QuantityEstimate, x: number): { p: number; tail: "below" | "above" | null } | null {
  const qs = sortedQuantiles(est);
  if (qs.length < 2) return null;
  if (x <= qs[0].v) return { p: 1 - qs[0].p, tail: "above" };
  if (x >= qs[qs.length - 1].v) return { p: 1 - qs[qs.length - 1].p, tail: "below" };
  for (let i = 1; i < qs.length; i++) {
    if (x <= qs[i].v) {
      const a = qs[i - 1], b = qs[i];
      const p = a.p + ((x - a.v) / (b.v - a.v)) * (b.p - a.p);
      return { p: 1 - p, tail: null };
    }
  }
  return null;
}

/** The central value an estimate offers, if it offers one. */
export function centralOf(est: QuantityEstimate): number | null {
  if (est.form === "distribution") return quantileAt(sortedQuantiles(est), 0.5);
  if (est.form === "point" || est.form === "interval") return est.central ?? null;
  if (est.form === "magnitude" && est.magnitude != null) return 10 ** est.magnitude;
  return null;
}

/** The outer interval an estimate spans, with its coverage when known. */
export function outerOf(est: QuantityEstimate): { lo: number; hi: number; level: number | null } | null {
  if (est.form === "distribution") {
    const qs = sortedQuantiles(est);
    if (qs.length < 2) return null;
    return { lo: qs[0].v, hi: qs[qs.length - 1].v, level: qs[qs.length - 1].p - qs[0].p };
  }
  if (est.form === "interval" && est.low != null && est.high != null) {
    return { lo: est.low, hi: est.high, level: est.level ?? null };
  }
  if (est.form === "magnitude" && est.magnitude != null) {
    return { lo: 10 ** (est.magnitude - 0.5), hi: 10 ** (est.magnitude + 0.5), level: null };
  }
  return null;
}

/** The inner (middle-half) interval of a distribution, when stored. */
export function innerOf(est: QuantityEstimate): { lo: number; hi: number } | null {
  if (est.form !== "distribution") return null;
  const qs = sortedQuantiles(est);
  if (qs.length < 4) return null;
  const lo = quantileAt(qs, 0.25), hi = quantileAt(qs, 0.75);
  return lo != null && hi != null ? { lo, hi } : null;
}

/** Every value an estimate or a range puts on the axis, for fitting scales. */
export function valuesOf(x: QuantityEstimate | ValueRange | null | undefined): number[] {
  if (!x) return [];
  if ("side" in x) return [x.low, x.high].filter((v): v is number => v != null && Number.isFinite(v));
  const out: number[] = [];
  const o = outerOf(x);
  if (o) out.push(o.lo, o.hi);
  const c = centralOf(x);
  if (c != null) out.push(c);
  if (x.bound) out.push(x.bound.value);
  return out.filter(Number.isFinite);
}

// ---- scales ----------------------------------------------------------------

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * p;
}

/**
 * Fit an axis to the values a view needs to show. Log when the Steward chose
 * it, or when positive values span more than a factor of 30 (deaths, stars,
 * costs, rare rates); linear otherwise, and always for years, proportions and
 * temperatures. The axis never runs past the unit's natural bounds.
 */
export function makeScale(unit: QuantityUnit, values: number[], prefer?: ScaleKind): ValueScale {
  const vals = values.filter(Number.isFinite);
  let min = vals.length ? Math.min(...vals) : unit.min ?? 0;
  let max = vals.length ? Math.max(...vals) : unit.max ?? 1;
  const linearOnly = unit.kind === "year" || unit.kind === "proportion" || unit.kind === "temperature";
  // Positive magnitudes spread by ten or more read as orders of magnitude.
  const kind: ScaleKind = unit.scale
    ?? (linearOnly ? "linear" : prefer ?? (min > 0 && max / min >= 10 ? "log" : "linear"));

  if (kind === "log") {
    min = Math.max(min, Number.MIN_VALUE);
    let a = Math.floor(Math.log10(min));
    let b = Math.ceil(Math.log10(max));
    if (b - a < 1) b = a + 1;
    const decades = b - a;
    const ticks: Tick[] = [];
    for (let k = a; k <= b; k++) {
      ticks.push({ v: 10 ** k, label: formatTick(10 ** k, unit), major: true });
      if (decades <= 2 && k < b) {
        for (const m of [2, 5]) ticks.push({ v: m * 10 ** k, label: formatTick(m * 10 ** k, unit), major: false });
      }
    }
    const lo = 10 ** a, hi = 10 ** b;
    const L = Math.log10(lo), H = Math.log10(hi);
    return {
      kind, lo, hi, unit, ticks,
      pos: (v) => Math.min(1, Math.max(0, (Math.log10(Math.max(v, lo)) - L) / (H - L))),
    };
  }

  if (max === min) {
    const d = Math.abs(max) * 0.2 || 1;
    min -= d; max += d;
  }
  // A quantity with a natural floor (a count, a share) starts its axis there
  // when the values sit close enough to it that a cropped axis would
  // exaggerate their spread.
  if (unit.min != null && min > unit.min && min - unit.min < (max - min) * 3) min = unit.min;
  const span = max - min;
  const step = unit.kind === "year" ? Math.max(1, niceStep(span / 4)) : niceStep(span / 4);
  let lo = Math.floor((min - span * 0.04) / step) * step;
  let hi = Math.ceil((max + span * 0.04) / step) * step;
  if (unit.min != null) lo = Math.max(lo, unit.min);
  if (unit.max != null) hi = Math.min(hi, unit.max);
  const ticks: Tick[] = [];
  if (unit.kind === "rate" && hi > 0 && hi < 0.01) {
    // A rare rate reads as a waiting time, so its ticks sit at round waits
    // ("1 in 500k"), not at round rates that would read as "1 in 333k".
    const waits: number[] = [];
    for (let k = Math.floor(Math.log10(1 / hi)) - 1; k <= Math.ceil(Math.log10(1 / Math.max(lo, hi / 1e3))) + 1; k++) {
      for (const m of [1, 2, 5]) waits.push(m * 10 ** k);
    }
    for (const w of waits) {
      const r = 1 / w;
      if (r >= lo && r <= hi) ticks.push({ v: r, label: formatTick(r, unit), major: true });
    }
    if (lo <= 0) ticks.push({ v: 0, label: "0", major: true });
    ticks.sort((a, b) => a.v - b.v);
  } else {
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
      const vv = Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12));
      ticks.push({ v: vv, label: formatTick(vv, unit), major: true });
    }
  }
  return {
    kind, lo, hi, unit, ticks,
    pos: (v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo))),
  };
}

// ---- words -----------------------------------------------------------------

function trimNum(v: number, digits: number): string {
  const s = Number(v.toPrecision(digits)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return s.replace(/^-/, MINUS);
}

const SCALE_WORDS: [number, string, string][] = [
  [1e12, "trillion", "T"],
  [1e9, "billion", "B"],
  [1e6, "million", "M"],
];

function compact(v: number, digits: number, short = false): string {
  const a = Math.abs(v);
  for (const [n, word, abbr] of SCALE_WORDS) {
    if (a >= n) return `${trimNum(v / n, digits)}${short ? abbr : ` ${word}`}`;
  }
  if (short && a >= 1e3) return `${trimNum(v / 1e3, 3)}k`;
  return trimNum(v, digits);
}

function decimalsFor(v: number, digits: number): number {
  if (v === 0) return Math.max(0, digits - 1);
  return Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(v))));
}

function perNoun(unit: QuantityUnit): string {
  return (unit.per ?? "").replace(/^per\s+/, "");
}

function plural(noun: string): string {
  return noun.endsWith("s") ? noun : `${noun}s`;
}

/**
 * How many significant figures an estimate earns: enough to tell its
 * central value from the ends of its interval, and no more (§10).
 */
export function digitsFor(est: QuantityEstimate | null): number {
  if (!est) return 2;
  const c = centralOf(est);
  const o = outerOf(est);
  if (c == null || !o || o.hi === o.lo) return 2;
  const rel = Math.abs(c) / Math.abs(o.hi - o.lo);
  return Math.min(4, Math.max(2, Math.ceil(Math.log10(Math.max(rel, 1e-9))) + 2));
}

/** A value in words, at `digits` significant figures, with its unit. */
export function formatValue(v: number, unit: QuantityUnit, digits = 2): string {
  switch (unit.kind) {
    case "proportion": {
      const pct = v * 100;
      return `${trimNum(pct, pct >= 10 ? Math.max(digits, 2) : digits)}%`;
    }
    case "year":
      return String(Math.round(v));
    case "count":
      return compact(v, digits);
    case "currency": {
      const sym = unit.currency === "USD" || !unit.currency ? "$" : `${unit.currency} `;
      return `${v < 0 ? MINUS : ""}${sym}${compact(Math.abs(v), digits)}`;
    }
    case "temperature":
      return `${(v < 0 ? MINUS : "")}${Math.abs(v).toFixed(decimalsFor(v, digits))} ${unit.symbol ?? "°C"}`;
    case "rate": {
      const per = perNoun(unit);
      if (v > 0 && v < 0.1 && per) return `once every ${compact(1 / v, digits)} ${plural(per)}`;
      return `${trimNum(v, digits)} ${unit.noun ? `${plural(unit.noun)} ` : ""}${unit.per ?? ""}`.trim();
    }
    case "duration":
      return `${trimNum(v, digits)} ${unit.symbol ?? ""}`.trim();
    case "measure":
    default: {
      const s = Math.abs(v) >= 1e6 ? compact(v, digits) : `${v < 0 ? MINUS : ""}${Math.abs(v).toFixed(decimalsFor(v, digits))}`;
      return unit.symbol ? `${s} ${unit.symbol}` : s;
    }
  }
}

/** A short tick label: "10M", "$5B", "50%", "2080", "3 °C", "1 in 1M". */
export function formatTick(v: number, unit: QuantityUnit): string {
  switch (unit.kind) {
    case "proportion":
      return `${trimNum(v * 100, 3)}%`;
    case "year":
      return String(Math.round(v));
    case "count":
      return compact(v, 3, true);
    case "currency":
      return `${v < 0 ? MINUS : ""}$${compact(Math.abs(v), 3, true)}`;
    case "temperature":
      return `${trimNum(v, 3)}${unit.symbol === "K" ? " K" : "°"}`;
    case "rate":
      return v > 0 && v < 0.1 ? `1 in ${compact(1 / v, 2, true)}` : trimNum(v, 3);
    default:
      return Math.abs(v) >= 1e6 ? compact(v, 3, true) : trimNum(v, 3);
  }
}

/**
 * Two values as a range, with a shared unit said once: "20 to 70 million",
 * "2.0 to 5.0 °C", "$1.2 to $3.4 billion" (currency keeps its sign on both).
 */
export function formatRange(lo: number, hi: number, unit: QuantityUnit, digits = 2): string {
  const a = formatValue(lo, unit, digits);
  const b = formatValue(hi, unit, digits);
  // Rare events read as waiting times, shortest first: a higher rate is a
  // shorter wait, so the range's ends swap.
  if (unit.kind === "rate" && a.startsWith("once every") && b.startsWith("once every")) {
    return `once every ${b.replace("once every ", "").replace(/ \S+$/, "")} to ${a.replace("once every ", "")}`;
  }
  const suffix = /( (?:trillion|billion|million)| °C| °F| K|%| [a-z/ ]+)$/.exec(b)?.[1];
  if (suffix && a.endsWith(suffix) && !/^[0-9]/.test(suffix.trim()) && unit.kind !== "year") {
    return `${a.slice(0, -suffix.length)} to ${b}`;
  }
  return `${a} to ${b}`;
}

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻",
};
export function powerOfTen(k: number): string {
  return `10${String(k).split("").map((c) => SUPERSCRIPT[c] ?? c).join("")}`;
}

export interface EstimateWords {
  /** The figure a reader takes away, set large: "≈ 40 million", "≥ 17 million", "~10¹¹". */
  lead: string;
  /** The estimate in a sentence: "most likely about 40 million; 90% interval 20 to 70 million". */
  words: string;
  /** How the estimate is stated, for the label beside it. */
  formLabel: string;
}

const FORM_LABEL: Record<QuantityEstimate["form"], string> = {
  distribution: "a distribution",
  interval: "an interval",
  bound: "a bound",
  magnitude: "an order of magnitude",
  point: "a single figure",
  none: "no figure",
};

/** An estimate, stated at the precision it carries (§10), with any share that lies outside every value. */
export function describeEstimate(est: QuantityEstimate, unit: QuantityUnit, digits?: number): EstimateWords {
  const w = describeValues(est, unit, digits);
  const out = est.outside;
  if (!out || !(out.share > 0) || est.form === "none") return w;
  const pct = out.share < 0.01 ? "under 1%" : `${Math.round(out.share * 100)}%`;
  return { ...w, words: `${w.words}, with a ${pct} chance that ${out.meaning}` };
}

// `exact` keeps a source's own precision: a figure a source states is
// reported as it was stated, not rounded to the interval's width.
function describeValues(est: QuantityEstimate, unit: QuantityUnit, exact?: number): EstimateWords {
  const digits = exact ?? digitsFor(est);
  const formLabel = FORM_LABEL[est.form];
  switch (est.form) {
    case "distribution": {
      const c = centralOf(est);
      const o = outerOf(est);
      const mid = c != null ? formatValue(c, unit, digits) : "";
      const lvl = o?.level != null ? `${Math.round(o.level * 100)}% interval ` : "";
      return {
        lead: `≈ ${mid}`,
        words: `most likely about ${mid}${o ? `; ${lvl}${formatRange(o.lo, o.hi, unit, digits)}` : ""}`,
        formLabel,
      };
    }
    case "interval": {
      const r = formatRange(est.low!, est.high!, unit, digits);
      const lvl = est.level != null ? ` (${Math.round(est.level * 100)}% interval)` : "";
      const cv = est.central != null ? formatValue(est.central, unit, digits) : null;
      const c = cv ? `, most likely ${cv.startsWith("once") ? "" : "about "}${cv}` : "";
      const span = r.startsWith("once every") ? r : `between ${r.replace(" to ", " and ")}`;
      return { lead: r, words: `${span}${lvl}${c}`, formLabel };
    }
    case "bound": {
      const v = formatValue(est.bound!.value, unit, digits);
      return {
        lead: `${est.bound!.side === "above" ? "≥" : "≤"} ${v}`,
        words: `${est.bound!.side === "above" ? "at least" : "at most"} ${v}`,
        formLabel,
      };
    }
    case "magnitude": {
      const k = est.magnitude!;
      return {
        lead: `~${powerOfTen(k)}`,
        words: `on the order of ${formatValue(10 ** k, unit, 1)}`,
        formLabel,
      };
    }
    case "point": {
      const v = formatValue(est.central!, unit, 3);
      return { lead: `≈ ${v}`, words: `about ${v}`, formLabel };
    }
    case "none":
    default:
      return { lead: "no figure", words: est.reason ?? "The evidence does not support a figure.", formLabel };
  }
}

/** A place on the value's axis in words: "above 50 million", "2 to 4.5 °C". */
export function describeRange(r: ValueRange, unit: QuantityUnit): string {
  if (r.side === "above" && r.low != null) return `above ${formatValue(r.low, unit, 3)}`;
  if (r.side === "below" && r.high != null) return `below ${formatValue(r.high, unit, 3)}`;
  if (r.low != null && r.high != null) return formatRange(r.low, r.high, unit, 3);
  return "";
}

/** A threshold claim's cut in words: "above 50 million". */
export function describeCut(direction: "above" | "below", value: number, unit: QuantityUnit): string {
  return `${direction} ${formatValue(value, unit, 3)}`;
}
