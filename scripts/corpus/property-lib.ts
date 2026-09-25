/**
 * Property runner, the pure half (#334 S3, from #295): the metamorphic and
 * single-graph invariances that need no referent, each measured as the
 * agreement between two arms of the same cluster.
 *
 * Tier 1 (metamorphic — arm B is a re-run under a transformation):
 *   idempotency        A and B are the same configuration run twice. Any
 *                      disagreement is the pipeline's own noise floor — the
 *                      band every other comparison has to clear.
 *   path-independence  B ingests the same posts in another order. Matching
 *                      is stateful (the first phrasing becomes the node), so
 *                      order can change the graph; the constitution wants it
 *                      not to matter (§2 individuation, §3 neutral forms).
 *   adversarial-order  The attack on the same property: B ingests the most
 *                      partisan source FIRST (`--order=adversarial`, or a
 *                      named manifest role) — does the first mover anchor the
 *                      graph's credences toward its stance?
 *   dup-flood          B is A's graph plus the same posts submitted again N
 *                      times under distinct URLs. Instance count is
 *                      provenance, not evidence weight: credence must not
 *                      inflate toward what the duplicated sources said.
 *
 * Tier 2 (single graph — arm B is A's graph after a perturbation):
 *   locality           B is A's graph plus ONE post from another cluster.
 *                      A's original claims should not churn.
 *   fixpoint           B is A's graph re-stewarded: every stewarded claim
 *                      re-enqueued with the staleness trigger and drained.
 *                      Stewardship should settle: verdicts and structure
 *                      unchanged.
 *
 * Plus granularity stability, a metric on every property: over matched
 * pairs, does the same claim decompose to the same number of children and
 * the same depth?
 *
 * Model convergence (#295) is the model-swap runner (swap-lib.ts). Each
 * property's B arm is flags on corpus:run; the tier-2 arms restore A's
 * snapshot first; the comparison is corpus:agreement (with its per-claim
 * block); the interpretation is here.
 */
import type { AgreementReport, PerClaimPair } from "./graph-agreement.js";
import type { ArmRecord } from "./swap-lib.js";

export const PROPERTIES = [
  "idempotency",
  "path-independence",
  "adversarial-order",
  "dup-flood",
  "locality",
  "fixpoint",
] as const;
export type Property = (typeof PROPERTIES)[number];

export function isProperty(x: string): x is Property {
  return (PROPERTIES as readonly string[]).includes(x);
}

/** Properties whose arm B starts from arm A's graph (restore the snapshot, --no-reset). */
export function restoresArmA(property: Property): boolean {
  return property === "dup-flood" || property === "locality" || property === "fixpoint";
}

/** The credence move that counts as a claim having "moved" in the readings below. */
export const MOVE_THRESHOLD = 0.1;

export interface PropertyArm {
  arm: "a" | "b";
  args: string[];
}

export function buildPropertyArms(opts: {
  property: Property;
  cluster: string;
  profile?: string | null;
  limit?: number;
  posts?: string[];
  /** Seed for the path-independence permutation; default 1. */
  seed?: number;
  /** Skip arm A: an existing snapshot is the reference. */
  baselineSnapshot?: string | null;
  /** dup-flood: how many times each post is re-submitted; default 3. */
  dups?: number;
  /** adversarial-order: a manifest role to ingest first; default the most partisan (corpus:run's ranking). */
  role?: string | null;
  /** locality: `<cluster>:<postId>` from another cluster. */
  foreign?: string | null;
}): PropertyArm[] {
  const common = [opts.cluster];
  if (opts.profile) common.push(`--profile=${opts.profile}`);
  if (opts.limit !== undefined) common.push(`--limit=${opts.limit}`);
  if (opts.posts && opts.posts.length > 0) common.push(`--posts=${opts.posts.join(",")}`);
  const arms: PropertyArm[] = [];
  if (!opts.baselineSnapshot) arms.push({ arm: "a", args: [...common] });
  let b: string[];
  switch (opts.property) {
    case "idempotency":
      b = [...common];
      break;
    case "path-independence":
      b = [...common, `--order=shuffle:${opts.seed ?? 1}`];
      break;
    case "adversarial-order":
      b = [...common, `--order=${opts.role ? `role:${opts.role}` : "adversarial"}`];
      break;
    case "dup-flood": {
      const n = opts.dups ?? 3;
      if (!Number.isInteger(n) || n < 1) throw new Error(`dup-flood needs --dups=N ≥ 1, got ${n}`);
      b = [...common, "--no-reset", `--dup-suffix=1..${n}`];
      break;
    }
    case "locality": {
      if (!opts.foreign) throw new Error("locality needs --foreign=<cluster>:<postId>");
      // No --limit/--posts: the foreign post replaces this cluster's selection.
      b = [opts.cluster, ...(opts.profile ? [`--profile=${opts.profile}`] : []), "--no-reset", `--foreign=${opts.foreign}`];
      break;
    }
    case "fixpoint":
      b = [opts.cluster, ...(opts.profile ? [`--profile=${opts.profile}`] : []), "--no-reset", "--reassess-all"];
      break;
  }
  arms.push({ arm: "b", args: b });
  return arms;
}

// ---- per-claim readings ----------------------------------------------------

export interface GranularityStability {
  /** Matched pairs read. */
  n: number;
  meanAbsChildrenDiff: number | null;
  childrenEqualShare: number | null;
  meanAbsDepthDiff: number | null;
  depthEqualShare: number | null;
}

export interface Churn {
  /** Matched pairs with a verdict on both sides. */
  n: number;
  /** …whose status changed or whose credence moved by ≥ MOVE_THRESHOLD. */
  moved: number;
  share: number | null;
  statusChanged: number;
  credenceMoved: number;
}

export interface Inflation {
  /** Matched pairs where A's sources take a net stance and both sides state a credence. */
  n: number;
  /** Mean of (credenceB − credenceA) × sign(A's net stance): > 0 means credence drifted toward what the duplicated sources said. */
  meanSignedTowardStance: number | null;
  meanAbsDelta: number | null;
  /** Pairs that drifted toward the stance by ≥ MOVE_THRESHOLD. */
  towardStance: number;
  againstStance: number;
  /** Instances gained over matched claims (the duplicates as provenance). */
  instancesA: number;
  instancesB: number;
}

export interface FirstMover {
  firstSourceUrl: string | null;
  /** Matched pairs the first source has a stance on in B, with a credence on both sides. */
  n: number;
  /** Mean of (credenceB − credenceA) × sign(first source's stance): > 0 means B leans toward its first source. */
  meanSignedTowardFirst: number | null;
  towardFirst: number;
  againstFirst: number;
}

const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Net stance of a set of instances: +1 affirming, −1 denying, 0 mixed or none. */
export function netStance(instances: Array<{ stance?: string | null }>): -1 | 0 | 1 {
  let s = 0;
  for (const i of instances) {
    if (i.stance === "affirms") s++;
    else if (i.stance === "denies") s--;
  }
  return s > 0 ? 1 : s < 0 ? -1 : 0;
}

export function granularityStability(pairs: PerClaimPair[]): GranularityStability {
  const cd = pairs.map((p) => Math.abs(p.childrenA - p.childrenB));
  const dd = pairs.map((p) => Math.abs(p.depthA - p.depthB));
  return {
    n: pairs.length,
    meanAbsChildrenDiff: round(mean(cd)),
    childrenEqualShare: round(pairs.length ? cd.filter((d) => d === 0).length / pairs.length : null),
    meanAbsDepthDiff: round(mean(dd)),
    depthEqualShare: round(pairs.length ? dd.filter((d) => d === 0).length / pairs.length : null),
  };
}

export function churn(pairs: PerClaimPair[], threshold = MOVE_THRESHOLD): Churn {
  let n = 0;
  let moved = 0;
  let statusChanged = 0;
  let credenceMoved = 0;
  for (const p of pairs) {
    const hasStatus = p.statusA !== null && p.statusB !== null;
    const hasCred = p.credenceA !== null && p.credenceB !== null;
    if (!hasStatus && !hasCred) continue;
    n++;
    const sc = hasStatus && p.statusA !== p.statusB;
    const cm = hasCred && Math.abs(p.credenceB! - p.credenceA!) >= threshold - 1e-12;
    if (sc) statusChanged++;
    if (cm) credenceMoved++;
    if (sc || cm) moved++;
  }
  return { n, moved, share: round(n ? moved / n : null), statusChanged, credenceMoved };
}

export function inflation(pairs: PerClaimPair[], threshold = MOVE_THRESHOLD): Inflation {
  const signed: number[] = [];
  const abs: number[] = [];
  let toward = 0;
  let against = 0;
  let instancesA = 0;
  let instancesB = 0;
  for (const p of pairs) {
    instancesA += p.instancesA.length;
    instancesB += p.instancesB.length;
    const stance = netStance(p.instancesA);
    if (stance === 0 || p.credenceA === null || p.credenceB === null) continue;
    const d = (p.credenceB - p.credenceA) * stance;
    signed.push(d);
    abs.push(Math.abs(d));
    if (d >= threshold - 1e-12) toward++;
    else if (d <= -threshold + 1e-12) against++;
  }
  return {
    n: signed.length,
    meanSignedTowardStance: round(mean(signed)),
    meanAbsDelta: round(mean(abs)),
    towardStance: toward,
    againstStance: against,
    instancesA,
    instancesB,
  };
}

export function firstMover(pairs: PerClaimPair[], firstSourceUrl: string | null, threshold = MOVE_THRESHOLD): FirstMover {
  const signed: number[] = [];
  let toward = 0;
  let against = 0;
  if (firstSourceUrl) {
    for (const p of pairs) {
      const stance = netStance(p.instancesB.filter((i) => i.sourceUrl === firstSourceUrl));
      if (stance === 0 || p.credenceA === null || p.credenceB === null) continue;
      const d = (p.credenceB - p.credenceA) * stance;
      signed.push(d);
      if (d >= threshold - 1e-12) toward++;
      else if (d <= -threshold + 1e-12) against++;
    }
  }
  return { firstSourceUrl, n: signed.length, meanSignedTowardFirst: round(mean(signed)), towardFirst: toward, againstFirst: against };
}

// ---- the summary -----------------------------------------------------------

export interface PropertySummary {
  property: Property;
  cluster: string;
  claimSetF1: number | null;
  claimSetRecall: number | null;
  credenceMeanAbsDiff: number | null;
  statusAgreement: number | null;
  edgeEditDistance: number;
  /** Which agent minted the claims that did not reproduce, on each side. */
  unmatchedByCreator: { a: Record<string, number>; b: Record<string, number> };
  cost: { a: number | null; b: number | null };
  capped: { a: boolean; b: boolean };
  /** Same claim, same decomposition — over matched pairs (null when the report has no per-claim block). */
  granularity: GranularityStability | null;
  /** Matched claims whose verdict moved (status, or credence by ≥ 0.1). */
  churn: Churn | null;
  /** dup-flood only. */
  inflation: Inflation | null;
  /** adversarial-order only. */
  firstMover: FirstMover | null;
  /** Claims and edges only one side has (fixpoint/locality: what the perturbation added or removed). */
  delta: { claimsOnlyA: number; claimsOnlyB: number; edgesOnlyA: number; edgesOnlyB: number; danglingEdgesB: number };
  /** Plain-language reading, with the caveat one pair of runs deserves. */
  reading: string;
}

export function summarizeProperty(input: {
  property: Property;
  cluster: string;
  armA: ArmRecord | null;
  armB: ArmRecord;
  agreement: AgreementReport;
  /** adversarial-order: the url of the source arm B ingested first. */
  firstSourceUrl?: string | null;
  /** dup-flood: how many times each post was re-submitted. */
  dups?: number;
}): PropertySummary {
  const { agreement: r, property } = input;
  const f1 = r.claimSet.f1;
  const pairs = r.perClaim ?? null;
  const gran = pairs ? granularityStability(pairs) : null;
  const ch = pairs ? churn(pairs) : null;
  const inf = property === "dup-flood" && pairs ? inflation(pairs) : null;
  const fm = property === "adversarial-order" && pairs ? firstMover(pairs, input.firstSourceUrl ?? null) : null;
  const delta = {
    claimsOnlyA: r.claimSet.unmatchedA.length,
    claimsOnlyB: r.claimSet.unmatchedB.length,
    edgesOnlyA: r.structure.edgesA - r.structure.sharedIgnoringRel,
    edgesOnlyB: r.structure.edgesB - r.structure.sharedIgnoringRel,
    danglingEdgesB: r.structure.danglingB,
  };

  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  const sgn = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(3)}`;
  let reading: string;
  const closeStructure = r.structure.editDistance <= Math.max(2, Math.round(0.1 * Math.max(r.structure.edgesA, r.structure.edgesB)));

  if (f1 === null) {
    reading = "no claims on one side; nothing to compare.";
  } else if (property === "idempotency" || property === "path-independence") {
    const noun = property === "idempotency" ? "re-running the same configuration" : "changing the ingest order";
    if (f1 >= 0.9 && closeStructure) {
      reading = `${noun} reproduced the graph closely (claim-set F1 ${f1.toFixed(3)}, edge edit distance ${r.structure.editDistance}).`;
    } else if (f1 >= 0.7) {
      reading = `${noun} reproduced most claims (F1 ${f1.toFixed(3)}) but structure or wording moved (edit distance ${r.structure.editDistance}); read the unmatched claims by creator.`;
    } else {
      reading = `${noun} produced a substantially different graph (F1 ${f1.toFixed(3)}) — the pipeline is not yet ${property === "idempotency" ? "stable" : "path independent"} on this cluster.`;
    }
  } else if (property === "adversarial-order") {
    const base =
      f1 >= 0.9 && closeStructure
        ? `Ingesting the most partisan source first reproduced the graph closely (F1 ${f1.toFixed(3)}, edit distance ${r.structure.editDistance}).`
        : f1 >= 0.7
          ? `Ingesting the most partisan source first reproduced most claims (F1 ${f1.toFixed(3)}) but structure or wording moved (edit distance ${r.structure.editDistance}).`
          : `Ingesting the most partisan source first produced a substantially different graph (F1 ${f1.toFixed(3)}).`;
    let effect: string;
    if (!fm || fm.n === 0) effect = "First-mover effect: not measurable (no matched claim carries the first source's stance with a credence on both sides).";
    else if (fm.meanSignedTowardFirst !== null && fm.meanSignedTowardFirst >= 0.05) {
      effect = `First-mover effect: credence leaned toward the first source by ${sgn(fm.meanSignedTowardFirst)} on average over ${fm.n} claim(s) it took a stance on (${fm.towardFirst} toward, ${fm.againstFirst} against) — the order bought that source an advantage.`;
    } else {
      effect = `No first-mover advantage: mean signed drift toward the first source ${sgn(fm.meanSignedTowardFirst ?? 0)} over ${fm.n} claim(s) (${fm.towardFirst} toward, ${fm.againstFirst} against).`;
    }
    reading = `${base} ${effect}`;
  } else if (property === "dup-flood") {
    const n = input.dups ?? 3;
    if (!inf || inf.n === 0) {
      reading = `After ${n}× duplicate submissions, matched ${r.claimSet.matched} of A's ${r.claimSet.sizeA} claims; no matched claim has both a net source stance and a credence on both sides, so inflation is not measurable. ${delta.claimsOnlyB} claim(s) exist only in B — duplicates the Matcher failed to absorb (each is a node the same text minted twice).`;
    } else if (inf.meanSignedTowardStance !== null && inf.meanSignedTowardStance >= 0.05) {
      reading = `Duplicate submissions inflated credence: after ${n}× copies, credence drifted toward the sources' stance by ${sgn(inf.meanSignedTowardStance)} on average over ${inf.n} claim(s) (${inf.towardStance} toward, ${inf.againstStance} against) while instances grew ${inf.instancesA} → ${inf.instancesB}. Instance count is being read as evidence weight.`;
    } else {
      reading = `No inflation: after ${n}× copies, mean signed drift toward the sources' stance ${sgn(inf.meanSignedTowardStance ?? 0)} over ${inf.n} claim(s) (${inf.towardStance} toward, ${inf.againstStance} against); instances grew ${inf.instancesA} → ${inf.instancesB} as provenance only.`;
    }
    if (inf && delta.claimsOnlyB > 0) reading += ` ${delta.claimsOnlyB} claim(s) exist only in B — duplicates the Matcher failed to absorb.`;
    reading += " Note: a matched instance does not re-trigger the Steward, so credence on A's claims can only move where the duplicates minted new nodes or edges.";
  } else if (property === "locality") {
    if (!ch || ch.n === 0) reading = `Ingesting one foreign post: A's ${r.claimSet.sizeA} claims matched ${r.claimSet.matched}, but none carried a verdict on both sides — churn not measurable.`;
    else if (ch.moved === 0) reading = `Ingesting one unrelated post left A's claims alone: 0 of ${ch.n} matched verdicts moved; ${delta.claimsOnlyB} new claim(s) and ${delta.danglingEdgesB} edge(s) came in with the foreign post.`;
    else reading = `Ingesting one unrelated post churned ${ch.moved} of ${ch.n} matched claims (${pct(ch.share)}: ${ch.statusChanged} status change(s), ${ch.credenceMoved} credence move(s) ≥ ${MOVE_THRESHOLD}); ${delta.claimsOnlyB} new claim(s) came in with it. Unrelated evidence should not move existing verdicts — read which claims moved and whether the foreign post really was unrelated to them.`;
    if (r.claimSet.recall !== null && r.claimSet.recall < 0.95) reading += ` ${delta.claimsOnlyA} of A's claims were not found in B (merged, reworded or archived by the ingest).`;
  } else {
    // fixpoint
    if (!ch || ch.n === 0) reading = `Re-stewarding the graph: no matched claim carries a verdict on both sides — nothing to read (was anything stewarded?).`;
    else if (ch.moved === 0 && delta.claimsOnlyA + delta.claimsOnlyB === 0 && r.structure.editDistance === 0) {
      reading = `Stewardship settles: re-stewarding every claim with the staleness trigger changed nothing — 0 of ${ch.n} verdicts moved, no claims or edges added or removed. The graph is a fixpoint.`;
    } else {
      reading = `Stewardship does not settle yet: re-stewarding moved ${ch.moved} of ${ch.n} verdicts (${pct(ch.share)}: ${ch.statusChanged} status, ${ch.credenceMoved} credence ≥ ${MOVE_THRESHOLD}), added ${delta.claimsOnlyB} claim(s) and ${delta.edgesOnlyB + delta.danglingEdgesB} edge(s), removed ${delta.claimsOnlyA} claim(s) and ${delta.edgesOnlyA} edge(s). Read the idempotency noise floor before calling the moves drift.`;
    }
  }
  if (gran && gran.n > 0) {
    reading += ` Granularity: ${pct(gran.childrenEqualShare)} of ${gran.n} matched claims have the same child count (mean |Δchildren| ${gran.meanAbsChildrenDiff}), ${pct(gran.depthEqualShare)} the same depth.`;
  }
  reading += " One pair of arms is one sample of the property; repeat before reading a number as the pipeline's.";

  return {
    property,
    cluster: input.cluster,
    claimSetF1: f1,
    claimSetRecall: r.claimSet.recall,
    credenceMeanAbsDiff: r.credence.meanAbsDiff,
    statusAgreement: r.credence.statusAgreement,
    edgeEditDistance: r.structure.editDistance,
    unmatchedByCreator: r.claimSet.unmatchedByCreator,
    cost: { a: input.armA?.costMicroUsd ?? null, b: input.armB.costMicroUsd ?? null },
    capped: { a: input.armA?.capped ?? false, b: input.armB.capped },
    granularity: gran,
    churn: ch,
    inflation: inf,
    firstMover: fm,
    delta,
    reading,
  };
}
