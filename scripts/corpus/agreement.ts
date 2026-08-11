/**
 * Graph agreement (#334 L2) — how far apart are two runs' graphs?
 *
 * The plan calls this "the single most load-bearing new build", because four
 * separate questions are the same measurement with different arguments:
 *
 *   - S3 metamorphic invariance — same input twice, or reordered, or
 *     paraphrased: how much did the graph move? (Should be ~nothing; the
 *     adversarial arm proves the invariance isn't vacuous.)
 *   - S7 fidelity vs. reference — cheap model's graph against the strong
 *     model's: where can we economize, and on which KINDS of claim can't we?
 *   - S4 displacement — attack arm against benign control arm, same snapshot.
 *   - #170 path independence — same claims ingested in a different order.
 *
 * Three axes, per the plan: claim-set agreement, structural agreement,
 * credence agreement. Plus a per-agent attribution of where the divergence
 * came from, so a regression is actionable ("the extractor drifted") rather
 * than merely visible ("the number moved").
 *
 * PURE and DB-free, like metrics.ts — the claim correspondence between the two
 * graphs is INJECTED, not computed here. That is deliberate: real matching is
 * semantic (the constitution's same-proposition test), and semantics live in
 * embeddings and the Matcher, neither of which belongs inside a unit-testable
 * function. Two pairers ship here:
 *
 *   pairByNormalizedText  — free, exact, deterministic. Right for order
 *                           permutation and idempotency runs, where the same
 *                           claim text genuinely recurs, and for fixtures.
 *   pairByEmbedding       — cosine over vectors the CALLER supplies (the
 *                           corpus DB already stores them on `claims`), greedy
 *                           mutual-best assignment above a floor. Right for
 *                           model-swap and paraphrase runs, where the same
 *                           proposition is worded differently.
 *
 * A Matcher-backed pairer (agentic, most faithful, most expensive) fits the
 * same `ClaimPairing` seam whenever a suite is willing to pay for it.
 *
 * ASYMMETRY IS DELIBERATE: `a` is the reference, `b` the comparison, so
 * precision/recall mean what they normally mean (recall = how much of the
 * reference survived; precision = how much of the comparison is grounded in
 * it). Symmetric callers can average both directions.
 */

import type { GraphSnapshot } from "./metrics.js";

/** A correspondence between claims of graph A and claims of graph B. */
export interface ClaimPairing {
  /** Each entry pairs one A-claim with one B-claim; ids appear at most once. */
  pairs: Array<{ a: string; b: string; score?: number }>;
}

export interface GraphAgreement {
  claimSet: {
    inA: number;
    inB: number;
    matched: number;
    /** matched / inB — how much of B is grounded in the reference. */
    precision: number;
    /** matched / inA — how much of the reference survived into B. */
    recall: number;
    f1: number;
    onlyInA: string[];
    onlyInB: string[];
  };
  structure: {
    /** Edges with BOTH endpoints matched — the only ones comparable at all. */
    comparableEdges: { a: number; b: number };
    shared: number;
    onlyInA: number;
    onlyInB: number;
    /** Same claim pair, different relation type (requires vs supports, …). */
    relationMismatches: number;
    /** shared / (shared + onlyInA + onlyInB); 1 when neither graph has edges. */
    jaccard: number;
  };
  credence: {
    /** Matched claims carrying a current assessment on BOTH sides. */
    comparable: number;
    statusAgreement: number;
    meanAbsConfidenceDelta: number;
    /** verified↔contradicted reversals — the disagreements that really bite. */
    polarFlips: number;
    disagreements: Array<{
      a: string;
      b: string;
      statusA: string;
      statusB: string;
      confidenceA: number;
      confidenceB: number;
    }>;
  };
  /**
   * Divergence bucketed by the `createdBy` of the claim it involves. Not a
   * causal attribution — a steward-minted subclaim can go missing because the
   * EXTRACTOR worded its parent differently — but it localizes the blast
   * radius, which is what makes a regression investigable.
   */
  attribution: Record<
    string,
    {
      unmatchedA: number;
      unmatchedB: number;
      statusDisagreements: number;
    }
  >;
  /**
   * Which axes had anything to compare. An axis with no comparable material
   * scores a vacuous 1 (no edges ⇒ jaccard 1; no shared assessments ⇒ status
   * agreement 1), which is right for the axis and wrong for any average over
   * it — an unassessed graph would otherwise bank a third of a perfect score
   * for having no opinions. Seen live: the epoch baseline vs. a
   * Steward-parked snapshot scored 100% credence agreement on 0 comparable
   * claims.
   */
  axesCompared: { claimSet: boolean; structure: boolean; credence: boolean };
  /**
   * Convenience aggregate: unweighted mean of f1, structural jaccard, and
   * status agreement, over the axes in `axesCompared` only. Useful as a single
   * line in a scorecard diff and as the quantity a noise band is drawn around.
   * Deliberately NOT load-bearing — every real judgment should read the axis
   * it cares about, because the axes fail for different reasons and averaging
   * hides which one moved. Two graphs with nothing comparable score 1.
   */
  composite: number;
}

// ---------------------------------------------------------------------------
// Pairers
// ---------------------------------------------------------------------------

/** Canonical-form comparison key: case, punctuation and spacing don't count. */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact pairing on normalized text. Ambiguity (two A-claims normalizing the
 * same) is resolved by sorted id so the result never depends on row order —
 * every function here is deterministic for the same reason scorecards are:
 * a metric that shifts under re-ordering can't measure whether a PIPELINE
 * shifted under re-ordering.
 */
export function pairByNormalizedText(
  a: GraphSnapshot,
  b: GraphSnapshot
): ClaimPairing {
  const indexB = new Map<string, string[]>();
  for (const claim of b.claims) {
    const key = normalizeClaimText(claim.text);
    (indexB.get(key) ?? indexB.set(key, []).get(key)!).push(claim.id);
  }
  for (const ids of indexB.values()) ids.sort();

  const pairs: ClaimPairing["pairs"] = [];
  const takenB = new Set<string>();
  for (const claim of [...a.claims].sort((x, y) => x.id.localeCompare(y.id))) {
    const candidates = indexB.get(normalizeClaimText(claim.text)) ?? [];
    const match = candidates.find((id) => !takenB.has(id));
    if (match) {
      takenB.add(match);
      pairs.push({ a: claim.id, b: match, score: 1 });
    }
  }
  return { pairs };
}

export function cosine(u: number[], v: number[]): number {
  const n = Math.min(u.length, v.length);
  let dot = 0;
  let nu = 0;
  let nv = 0;
  for (let i = 0; i < n; i++) {
    dot += u[i]! * v[i]!;
    nu += u[i]! * u[i]!;
    nv += v[i]! * v[i]!;
  }
  if (nu === 0 || nv === 0) return 0;
  return dot / (Math.sqrt(nu) * Math.sqrt(nv));
}

/**
 * Greedy cosine pairing above `minSimilarity`. Every candidate pair is scored,
 * sorted by similarity (ties broken by id so the order is total), and assigned
 * first-come — each claim used at most once.
 *
 * Greedy rather than optimal (Hungarian) on purpose: the assignment that
 * maximizes TOTAL similarity can pair two claims neither of which is the
 * other's best match, which reads as a match nobody would defend. Greedy
 * mutual-best is the conservative choice, and the residue lands in
 * onlyInA/onlyInB where it is visible instead of quietly inflating agreement.
 *
 * The default floor is the Matcher's own retrieval floor (0.4, per #337's
 * agentic matching) — pairs below it are not "the same proposition" by any
 * standard the pipeline itself uses. Note this pairs SEMANTIC neighbors, which
 * includes negations: "X is safe" and "X is not safe" sit close in embedding
 * space, so a run of these against an adversarial arm should read the credence
 * axis, where the flip shows up, and not stop at the claim-set axis.
 */
export function pairByEmbedding(
  a: GraphSnapshot,
  b: GraphSnapshot,
  embeddings: Map<string, number[]>,
  minSimilarity = 0.4
): ClaimPairing {
  const scored: Array<{ a: string; b: string; score: number }> = [];
  for (const ca of a.claims) {
    const va = embeddings.get(ca.id);
    if (!va) continue;
    for (const cb of b.claims) {
      const vb = embeddings.get(cb.id);
      if (!vb) continue;
      const score = cosine(va, vb);
      if (score >= minSimilarity) scored.push({ a: ca.id, b: cb.id, score });
    }
  }
  scored.sort(
    (x, y) =>
      y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)
  );

  const takenA = new Set<string>();
  const takenB = new Set<string>();
  const pairs: ClaimPairing["pairs"] = [];
  for (const cand of scored) {
    if (takenA.has(cand.a) || takenB.has(cand.b)) continue;
    takenA.add(cand.a);
    takenB.add(cand.b);
    pairs.push(cand);
  }
  return { pairs };
}

// ---------------------------------------------------------------------------
// The metric
// ---------------------------------------------------------------------------

/** Edge identity in B-id space. "|" never occurs in a uuid. */
function edgeKey(parent: string, child: string): string {
  return `${parent}|${child}`;
}

/** Mean of the live axes; nothing comparable at all reads as agreement. */
function mean(xs: number[]): number {
  return xs.length === 0 ? 1 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function computeGraphAgreement(
  a: GraphSnapshot,
  b: GraphSnapshot,
  pairing: ClaimPairing
): GraphAgreement {
  const aToB = new Map(pairing.pairs.map((p) => [p.a, p.b]));
  const matchedA = new Set(pairing.pairs.map((p) => p.a));
  const matchedB = new Set(pairing.pairs.map((p) => p.b));

  // --- axis 1: claim sets ---------------------------------------------------
  const onlyInA = a.claims.filter((c) => !matchedA.has(c.id)).map((c) => c.id).sort();
  const onlyInB = b.claims.filter((c) => !matchedB.has(c.id)).map((c) => c.id).sort();
  const matched = pairing.pairs.length;
  const precision = b.claims.length === 0 ? (matched === 0 ? 1 : 0) : matched / b.claims.length;
  const recall = a.claims.length === 0 ? (matched === 0 ? 1 : 0) : matched / a.claims.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // --- axis 2: structure ----------------------------------------------------
  // Only edges whose BOTH endpoints matched can be compared: an edge touching
  // an unmatched claim is already counted as a claim-set difference, and
  // charging it twice would double-penalize one divergence.
  const aComparable = new Map<string, string>();
  for (const e of a.edges) {
    if (aToB.has(e.parent) && aToB.has(e.child)) {
      aComparable.set(edgeKey(aToB.get(e.parent)!, aToB.get(e.child)!), e.rel);
    }
  }
  const bComparable = new Map<string, string>();
  const bMatchedIds = new Set(pairing.pairs.map((p) => p.b));
  for (const e of b.edges) {
    if (bMatchedIds.has(e.parent) && bMatchedIds.has(e.child)) {
      bComparable.set(edgeKey(e.parent, e.child), e.rel);
    }
  }
  let shared = 0;
  let relationMismatches = 0;
  for (const [key, relA] of aComparable) {
    const relB = bComparable.get(key);
    if (relB === undefined) continue;
    shared++;
    if (relB !== relA) relationMismatches++;
  }
  const structOnlyInA = aComparable.size - shared;
  const structOnlyInB = bComparable.size - shared;
  const union = shared + structOnlyInA + structOnlyInB;
  const jaccard = union === 0 ? 1 : shared / union;

  // --- axis 3: credence -----------------------------------------------------
  const assessA = new Map(a.assessments.map((x) => [x.claimId, x]));
  const assessB = new Map(b.assessments.map((x) => [x.claimId, x]));
  const POLAR: Record<string, number> = { verified: 1, supported: 1, contradicted: -1 };
  const disagreements: GraphAgreement["credence"]["disagreements"] = [];
  let comparable = 0;
  let agreed = 0;
  let confidenceDeltaSum = 0;
  let polarFlips = 0;
  for (const pair of pairing.pairs) {
    const xa = assessA.get(pair.a);
    const xb = assessB.get(aToB.get(pair.a)!);
    if (!xa || !xb) continue;
    comparable++;
    confidenceDeltaSum += Math.abs(xa.confidence - xb.confidence);
    if (xa.status === xb.status) {
      agreed++;
      continue;
    }
    const pa = POLAR[xa.status];
    const pb = POLAR[xb.status];
    if (pa !== undefined && pb !== undefined && pa !== pb) polarFlips++;
    disagreements.push({
      a: pair.a,
      b: pair.b,
      statusA: xa.status,
      statusB: xb.status,
      confidenceA: xa.confidence,
      confidenceB: xb.confidence,
    });
  }
  const statusAgreement = comparable === 0 ? 1 : agreed / comparable;
  const meanAbsConfidenceDelta = comparable === 0 ? 0 : confidenceDeltaSum / comparable;

  // --- attribution ----------------------------------------------------------
  const attribution: GraphAgreement["attribution"] = {};
  const bucket = (agent: string) =>
    (attribution[agent] ??= { unmatchedA: 0, unmatchedB: 0, statusDisagreements: 0 });
  const creatorA = new Map(a.claims.map((c) => [c.id, c.createdBy]));
  const creatorB = new Map(b.claims.map((c) => [c.id, c.createdBy]));
  for (const id of onlyInA) bucket(creatorA.get(id) ?? "unknown").unmatchedA++;
  for (const id of onlyInB) bucket(creatorB.get(id) ?? "unknown").unmatchedB++;
  for (const d of disagreements) bucket(creatorA.get(d.a) ?? "unknown").statusDisagreements++;

  return {
    claimSet: {
      inA: a.claims.length,
      inB: b.claims.length,
      matched,
      precision,
      recall,
      f1,
      onlyInA,
      onlyInB,
    },
    structure: {
      comparableEdges: { a: aComparable.size, b: bComparable.size },
      shared,
      onlyInA: structOnlyInA,
      onlyInB: structOnlyInB,
      relationMismatches,
      jaccard,
    },
    credence: {
      comparable,
      statusAgreement,
      meanAbsConfidenceDelta,
      polarFlips,
      disagreements,
    },
    attribution,
    axesCompared: {
      claimSet: a.claims.length + b.claims.length > 0,
      structure: union > 0,
      credence: comparable > 0,
    },
    composite: mean([
      ...(a.claims.length + b.claims.length > 0 ? [f1] : []),
      ...(union > 0 ? [jaccard] : []),
      ...(comparable > 0 ? [statusAgreement] : []),
    ]),
  };
}

/**
 * One-line summary for logs and scorecard diffs. An axis with nothing to
 * compare prints `n/a` rather than its vacuous 1 — a reader should never see
 * "status 100%" and take it for agreement that was actually tested.
 */
export function formatAgreement(x: GraphAgreement): string {
  const structure = x.axesCompared.structure
    ? `edges J=${x.structure.jaccard.toFixed(3)}` +
      (x.structure.relationMismatches
        ? ` (${x.structure.relationMismatches} rel-mismatch)`
        : "")
    : "edges n/a";
  const credence = x.axesCompared.credence
    ? `status ${(x.credence.statusAgreement * 100).toFixed(0)}%` +
      (x.credence.polarFlips ? ` (${x.credence.polarFlips} polar flips)` : "") +
      ` · Δconf ${x.credence.meanAbsConfidenceDelta.toFixed(3)}`
    : "status n/a";
  return (
    `claims ${x.claimSet.matched}/${x.claimSet.inA}→${x.claimSet.inB} ` +
    `(F1 ${x.claimSet.f1.toFixed(3)}) · ${structure} · ${credence} · ` +
    `composite ${x.composite.toFixed(3)}`
  );
}
