/**
 * Graph agreement (#334 L2): the distance between two claim graphs produced
 * by different runs, along three axes — the single most load-bearing eval
 * instrument in the plan, because every property that matters is a
 * comparison of graphs: idempotency and path independence (S3), fidelity of
 * a cheaper model to a stronger one (S7), displacement under attack (S4).
 * Build once, read four ways.
 *
 *   1. Claim-set agreement — does B contain A's claims, and only them?
 *      Precision / recall / F1 over a one-to-one matching of claims.
 *   2. Credence agreement — over matched claims, how far apart are the
 *      credences and statuses?
 *   3. Structural agreement — mapped through the matching, do the two
 *      graphs draw the same decomposition edges? Edge precision / recall
 *      and the edge edit distance between the matched subgraphs.
 *
 * Plus attribution: which agent minted the claims that failed to match, so
 * a divergence is actionable rather than a number.
 *
 * Pure and DB-free. The matching is built from embeddings the caller
 * supplies (exact text first, then greedy one-to-one cosine similarity
 * above a threshold); agreement.ts loads two graphs from databases, can
 * confirm the ambiguous band with an LLM pair judge, and hands the
 * matching here.
 */

export interface AgreementClaim {
  id: string;
  text: string;
  createdBy?: string | null;
  importance?: number | null;
  status?: string | null;
  credence?: number | null;
  embedding?: number[] | null;
}

export interface AgreementEdge {
  parent: string;
  child: string;
  rel: string;
}

export interface AgreementGraph {
  label: string;
  claims: AgreementClaim[];
  edges: AgreementEdge[];
}

export type MatchMethod = "exact" | "embedding" | "judge";

export interface MatchedPair {
  a: string;
  b: string;
  similarity: number;
  method: MatchMethod;
}

export function cosine(x: number[], y: number[]): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  if (nx === 0 || ny === 0) return 0;
  return dot / (Math.sqrt(nx) * Math.sqrt(ny));
}

export function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CandidatePair {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Build a one-to-one matching between A's and B's claims: identical
 * normalized text first (similarity 1), then the highest-similarity
 * embedding pairs greedily, each claim used at most once, down to
 * `threshold`. Pairs whose similarity falls in [threshold, sure) are also
 * returned as `ambiguous`, so a caller can confirm them with a judge before
 * trusting them — the Matcher's own doctrine: embedding similarity is
 * retrieval, not decision.
 */
export function buildMatching(
  a: AgreementGraph,
  b: AgreementGraph,
  opts: { threshold?: number; sure?: number } = {}
): { pairs: MatchedPair[]; ambiguous: MatchedPair[] } {
  const threshold = opts.threshold ?? 0.85;
  const sure = opts.sure ?? 0.95;
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const pairs: MatchedPair[] = [];

  // Exact text.
  const byText = new Map<string, AgreementClaim[]>();
  for (const c of b.claims) {
    const k = normalizeText(c.text);
    (byText.get(k) ?? byText.set(k, []).get(k)!).push(c);
  }
  for (const ca of a.claims) {
    const bucket = byText.get(normalizeText(ca.text));
    const cb = bucket?.find((x) => !usedB.has(x.id));
    if (cb) {
      usedA.add(ca.id);
      usedB.add(cb.id);
      pairs.push({ a: ca.id, b: cb.id, similarity: 1, method: "exact" });
    }
  }

  // Greedy by cosine over the rest.
  const candidates: CandidatePair[] = [];
  for (const ca of a.claims) {
    if (usedA.has(ca.id) || !ca.embedding) continue;
    for (const cb of b.claims) {
      if (usedB.has(cb.id) || !cb.embedding) continue;
      const s = cosine(ca.embedding, cb.embedding);
      if (s >= threshold) candidates.push({ a: ca.id, b: cb.id, similarity: s });
    }
  }
  candidates.sort((x, y) => y.similarity - x.similarity);
  const ambiguous: MatchedPair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    const pair: MatchedPair = { ...c, method: "embedding" };
    pairs.push(pair);
    if (c.similarity < sure) ambiguous.push(pair);
  }
  return { pairs, ambiguous };
}

export interface ClaimSetAgreement {
  sizeA: number;
  sizeB: number;
  matched: number;
  /** Share of B's claims that correspond to a claim in A. */
  precision: number | null;
  /** Share of A's claims that B reproduced. */
  recall: number | null;
  f1: number | null;
  byMethod: Record<MatchMethod, number>;
  unmatchedA: string[];
  unmatchedB: string[];
  /** Who minted the unmatched claims on each side — the attribution. */
  unmatchedByCreator: { a: Record<string, number>; b: Record<string, number> };
}

export interface CredenceAgreement {
  /** Matched pairs where both sides state a credence. */
  n: number;
  meanAbsDiff: number | null;
  rmsDiff: number | null;
  /** Share within 0.1 of each other. */
  within01: number | null;
  /** Matched pairs where both sides have a status. */
  statusN: number;
  statusAgreement: number | null;
  /** status in A → status in B → count, over disagreements only. */
  statusConfusion: Record<string, Record<string, number>>;
  /** Pairs where exactly one side states a credence. */
  oneSided: number;
}

export interface StructuralAgreement {
  /** Edges among matched claims on each side (only those can be compared). */
  edgesA: number;
  edgesB: number;
  /** Edges present on both sides, ignoring relation type / requiring it. */
  sharedIgnoringRel: number;
  sharedWithRel: number;
  precision: number | null;
  recall: number | null;
  /** Edges only in A plus edges only in B (relation ignored) — the edit distance between the matched subgraphs. */
  editDistance: number;
  /** Edges that touch an unmatched claim, per side — structure the other graph does not have at all. */
  danglingA: number;
  danglingB: number;
}

export interface AgreementReport {
  a: string;
  b: string;
  claimSet: ClaimSetAgreement;
  credence: CredenceAgreement;
  structure: StructuralAgreement;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);
const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);

function countBy(claims: AgreementClaim[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of claims) {
    const k = c.createdBy ?? "unknown";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function claimSetAgreement(
  a: AgreementGraph,
  b: AgreementGraph,
  pairs: MatchedPair[]
): ClaimSetAgreement {
  const matchedA = new Set(pairs.map((p) => p.a));
  const matchedB = new Set(pairs.map((p) => p.b));
  const unmatchedA = a.claims.filter((c) => !matchedA.has(c.id));
  const unmatchedB = b.claims.filter((c) => !matchedB.has(c.id));
  const precision = ratio(pairs.length, b.claims.length);
  const recall = ratio(pairs.length, a.claims.length);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  const byMethod: Record<MatchMethod, number> = { exact: 0, embedding: 0, judge: 0 };
  for (const p of pairs) byMethod[p.method]++;
  return {
    sizeA: a.claims.length,
    sizeB: b.claims.length,
    matched: pairs.length,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    byMethod,
    unmatchedA: unmatchedA.map((c) => c.id),
    unmatchedB: unmatchedB.map((c) => c.id),
    unmatchedByCreator: { a: countBy(unmatchedA), b: countBy(unmatchedB) },
  };
}

export function credenceAgreement(
  a: AgreementGraph,
  b: AgreementGraph,
  pairs: MatchedPair[]
): CredenceAgreement {
  const ca = new Map(a.claims.map((c) => [c.id, c]));
  const cb = new Map(b.claims.map((c) => [c.id, c]));
  const diffs: number[] = [];
  let oneSided = 0;
  let statusN = 0;
  let statusSame = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const p of pairs) {
    const x = ca.get(p.a);
    const y = cb.get(p.b);
    if (!x || !y) continue;
    const hasX = typeof x.credence === "number";
    const hasY = typeof y.credence === "number";
    if (hasX && hasY) diffs.push(Math.abs(x.credence! - y.credence!));
    else if (hasX || hasY) oneSided++;
    if (x.status && y.status) {
      statusN++;
      if (x.status === y.status) statusSame++;
      else {
        const row = (confusion[x.status] ??= {});
        row[y.status] = (row[y.status] ?? 0) + 1;
      }
    }
  }
  const n = diffs.length;
  return {
    n,
    meanAbsDiff: round(n ? diffs.reduce((s, d) => s + d, 0) / n : null),
    rmsDiff: round(n ? Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / n) : null),
    within01: round(n ? diffs.filter((d) => d <= 0.1 + 1e-12).length / n : null),
    statusN,
    statusAgreement: round(ratio(statusSame, statusN)),
    statusConfusion: confusion,
    oneSided,
  };
}

export function structuralAgreement(
  a: AgreementGraph,
  b: AgreementGraph,
  pairs: MatchedPair[]
): StructuralAgreement {
  const aToB = new Map(pairs.map((p) => [p.a, p.b]));
  const matchedB = new Set(pairs.map((p) => p.b));
  const key = (parent: string, child: string) => `${parent}→${child}`;
  const keyRel = (parent: string, child: string, rel: string) => `${parent}→${child}:${rel}`;

  // A's edges among matched claims, expressed in B's id space.
  const edgesA = new Set<string>();
  const edgesARel = new Set<string>();
  let danglingA = 0;
  for (const e of a.edges) {
    const p = aToB.get(e.parent);
    const c = aToB.get(e.child);
    if (!p || !c) {
      danglingA++;
      continue;
    }
    edgesA.add(key(p, c));
    edgesARel.add(keyRel(p, c, e.rel));
  }
  const edgesB = new Set<string>();
  const edgesBRel = new Set<string>();
  let danglingB = 0;
  for (const e of b.edges) {
    if (!matchedB.has(e.parent) || !matchedB.has(e.child)) {
      danglingB++;
      continue;
    }
    edgesB.add(key(e.parent, e.child));
    edgesBRel.add(keyRel(e.parent, e.child, e.rel));
  }
  let shared = 0;
  for (const k of edgesA) if (edgesB.has(k)) shared++;
  let sharedRel = 0;
  for (const k of edgesARel) if (edgesBRel.has(k)) sharedRel++;
  return {
    edgesA: edgesA.size,
    edgesB: edgesB.size,
    sharedIgnoringRel: shared,
    sharedWithRel: sharedRel,
    precision: round(ratio(shared, edgesB.size)),
    recall: round(ratio(shared, edgesA.size)),
    editDistance: edgesA.size - shared + (edgesB.size - shared),
    danglingA,
    danglingB,
  };
}

export function graphAgreement(
  a: AgreementGraph,
  b: AgreementGraph,
  pairs: MatchedPair[]
): AgreementReport {
  return {
    a: a.label,
    b: b.label,
    claimSet: claimSetAgreement(a, b, pairs),
    credence: credenceAgreement(a, b, pairs),
    structure: structuralAgreement(a, b, pairs),
  };
}

export function renderAgreement(r: AgreementReport): string {
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  const o: string[] = [];
  o.push(`Graph agreement — A: ${r.a} · B: ${r.b}`);
  o.push(
    `  claims    A ${r.claimSet.sizeA} · B ${r.claimSet.sizeB} · matched ${r.claimSet.matched}` +
      ` (exact ${r.claimSet.byMethod.exact}, embedding ${r.claimSet.byMethod.embedding}, judge ${r.claimSet.byMethod.judge})`
  );
  o.push(
    `            precision ${f(r.claimSet.precision)} · recall ${f(r.claimSet.recall)} · F1 ${f(r.claimSet.f1)}`
  );
  const creators = (m: Record<string, number>) =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "none";
  o.push(`            unmatched in A by creator: ${creators(r.claimSet.unmatchedByCreator.a)}`);
  o.push(`            unmatched in B by creator: ${creators(r.claimSet.unmatchedByCreator.b)}`);
  o.push(
    `  credence  n ${r.credence.n} · mean |Δ| ${f(r.credence.meanAbsDiff)} · rms ${f(r.credence.rmsDiff)}` +
      ` · within 0.1: ${f(r.credence.within01)} · one-sided ${r.credence.oneSided}`
  );
  o.push(
    `  status    n ${r.credence.statusN} · agreement ${f(r.credence.statusAgreement)}` +
      (Object.keys(r.credence.statusConfusion).length
        ? ` · disagreements: ${Object.entries(r.credence.statusConfusion)
            .flatMap(([x, row]) => Object.entries(row).map(([y, n]) => `${x}→${y} ${n}`))
            .join(", ")}`
        : "")
  );
  o.push(
    `  structure edges among matched: A ${r.structure.edgesA} · B ${r.structure.edgesB}` +
      ` · shared ${r.structure.sharedIgnoringRel} (${r.structure.sharedWithRel} with same relation)`
  );
  o.push(
    `            precision ${f(r.structure.precision)} · recall ${f(r.structure.recall)}` +
      ` · edit distance ${r.structure.editDistance} · dangling A ${r.structure.danglingA} / B ${r.structure.danglingB}`
  );
  return o.join("\n");
}

// ---- the pair judge -------------------------------------------------------
// The ambiguous band of the matching can be confirmed by a judge model. The
// prompt and schema live here, DB-free, so the evals guide can show the exact
// text a pair is judged with (#368).

export const PAIR_JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    same_proposition: {
      type: "boolean",
      description:
        "true if the two texts state the same proposition under §2's test: nothing could count as evidence or argument bearing on one without bearing equally on the other. A claim and its negation count as the same node. A specification, a generalization, or a claim that turns on different considerations is NOT the same.",
    },
    reasoning: { type: "string", description: "One or two sentences." },
  },
  required: ["same_proposition", "reasoning"],
  additionalProperties: false,
};

export function pairJudgePrompt(textA: string, textB: string): string {
  return (
    `Two claim graphs, built independently, each contain a claim. Decide whether they are the SAME proposition — a claim ` +
    `is individuated by what bears on it (constitution §2): two formulations are the same claim when nothing could count ` +
    `as evidence or argument bearing on one without bearing equally on the other. Identical decomposition is a diagnostic, ` +
    `not the definition. A claim and its denial are one node. A specification, a generalization, or a claim that turns on ` +
    `different considerations is a different claim.\n\nClaim 1: ${textA}\nClaim 2: ${textB}`
  );
}
