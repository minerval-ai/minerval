/**
 * What a quantity's estimate implies about a claim on one side of a figure
 * (constitution §21): the probability that the value lies above or below it.
 * Read from the estimate's quantiles, linearly interpolated, the same way
 * the web app reads them (web/lib/quantity.ts). An interval with a stated
 * coverage reads as its two tail quantiles and its central figure as the
 * median. A point, a bound, an order of magnitude, or no figure implies no
 * probability, so nothing is checked against it.
 */
import type { QuantityEstimate } from "../schemas/kinds.js";

interface Quantile {
  p: number;
  v: number;
}

function quantilesOf(est: QuantityEstimate): Quantile[] {
  if (est.form === "distribution") {
    return [...(est.quantiles ?? [])].filter((q) => Number.isFinite(q.v)).sort((a, b) => a.p - b.p);
  }
  if (est.form === "interval" && est.low != null && est.high != null && est.level != null) {
    const tail = (1 - est.level) / 2;
    const qs: Quantile[] = [{ p: tail, v: est.low }];
    if (est.central != null && est.central > est.low && est.central < est.high) qs.push({ p: 0.5, v: est.central });
    qs.push({ p: 1 - tail, v: est.high });
    return qs;
  }
  return [];
}

export interface ImpliedProbability {
  /** The probability the estimate gives the claim. */
  p: number;
  /**
   * Beyond the outermost quantile only the tail's mass is known: the claim's
   * probability is at most `p` ("at_most") or at least `p` ("at_least").
   */
  bound: "at_most" | "at_least" | null;
}

/**
 * P(value > x) for "above", P(value < x) for "below", with any share of
 * probability that lies outside every value counted against the claim.
 */
export function impliedProbability(
  est: QuantityEstimate,
  direction: "above" | "below",
  x: number
): ImpliedProbability | null {
  const qs = quantilesOf(est);
  if (qs.length < 2) return null;
  let pBelow: number;
  let edge: "low" | "high" | null = null;
  if (x <= qs[0]!.v) {
    pBelow = qs[0]!.p;
    edge = "low";
  } else if (x >= qs[qs.length - 1]!.v) {
    pBelow = qs[qs.length - 1]!.p;
    edge = "high";
  } else {
    pBelow = qs[qs.length - 1]!.p;
    for (let i = 1; i < qs.length; i++) {
      if (x <= qs[i]!.v) {
        const a = qs[i - 1]!;
        const b = qs[i]!;
        pBelow = a.p + ((x - a.v) / (b.v - a.v)) * (b.p - a.p);
        break;
      }
    }
  }
  const inside = 1 - (est.outside?.share ?? 0);
  const p = (direction === "above" ? 1 - pBelow : pBelow) * inside;
  // Below the lowest quantile, at most its mass lies under x; above the
  // highest, at most the upper tail lies over x.
  let bound: ImpliedProbability["bound"] = null;
  if (edge === "low") bound = direction === "above" ? "at_least" : "at_most";
  if (edge === "high") bound = direction === "above" ? "at_most" : "at_least";
  return { p, bound };
}

/** How far a credence sits from what the estimate implies, honouring a bound; 0 when consistent. */
export function credenceGap(credence: number, implied: ImpliedProbability): number {
  if (implied.bound === "at_most") return Math.max(0, credence - implied.p);
  if (implied.bound === "at_least") return Math.max(0, implied.p - credence);
  return Math.abs(credence - implied.p);
}
