/**
 * Property runner, the pure half (#334 S3 tier 1, from #295): the
 * metamorphic invariances that need no referent, measured as the agreement
 * between two arms of the same cluster.
 *
 *   idempotency        A and B are the same configuration run twice. Any
 *                      disagreement is the pipeline's own noise floor — the
 *                      band every other comparison has to clear.
 *   path-independence  B ingests the same posts in another order. Matching
 *                      is stateful (the first phrasing becomes the node), so
 *                      order can change the graph; the constitution wants it
 *                      not to matter (§2 individuation, §3 neutral forms).
 *
 * Model convergence (#295) is the model-swap runner (swap-lib.ts). Each
 * property's B arm is one flag on corpus:run; the comparison is
 * corpus:agreement; the interpretation is here.
 */
import type { AgreementReport } from "./graph-agreement.js";
import type { ArmRecord } from "./swap-lib.js";

export const PROPERTIES = ["idempotency", "path-independence"] as const;
export type Property = (typeof PROPERTIES)[number];

export function isProperty(x: string): x is Property {
  return (PROPERTIES as readonly string[]).includes(x);
}

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
}): PropertyArm[] {
  const common = [opts.cluster];
  if (opts.profile) common.push(`--profile=${opts.profile}`);
  if (opts.limit !== undefined) common.push(`--limit=${opts.limit}`);
  if (opts.posts && opts.posts.length > 0) common.push(`--posts=${opts.posts.join(",")}`);
  const arms: PropertyArm[] = [];
  if (!opts.baselineSnapshot) arms.push({ arm: "a", args: [...common] });
  const b = [...common];
  if (opts.property === "path-independence") b.push(`--order=shuffle:${opts.seed ?? 1}`);
  arms.push({ arm: "b", args: b });
  return arms;
}

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
  /** Plain-language reading, with the caveat one pair of runs deserves. */
  reading: string;
}

export function summarizeProperty(input: {
  property: Property;
  cluster: string;
  armA: ArmRecord | null;
  armB: ArmRecord;
  agreement: AgreementReport;
}): PropertySummary {
  const { agreement: r } = input;
  const f1 = r.claimSet.f1;
  const noun = input.property === "idempotency" ? "re-running the same configuration" : "changing the ingest order";
  let reading: string;
  if (f1 === null) reading = "no claims on one side; nothing to compare.";
  else if (f1 >= 0.9 && r.structure.editDistance <= Math.max(2, Math.round(0.1 * Math.max(r.structure.edgesA, r.structure.edgesB)))) {
    reading = `${noun} reproduced the graph closely (claim-set F1 ${f1.toFixed(3)}, edge edit distance ${r.structure.editDistance}).`;
  } else if (f1 >= 0.7) {
    reading = `${noun} reproduced most claims (F1 ${f1.toFixed(3)}) but structure or wording moved (edit distance ${r.structure.editDistance}); read the unmatched claims by creator.`;
  } else {
    reading = `${noun} produced a substantially different graph (F1 ${f1.toFixed(3)}) — the pipeline is not yet ${input.property === "idempotency" ? "stable" : "path independent"} on this cluster.`;
  }
  reading += " One pair of arms is one sample of the property; repeat before reading a number as the pipeline's.";
  return {
    property: input.property,
    cluster: input.cluster,
    claimSetF1: f1,
    claimSetRecall: r.claimSet.recall,
    credenceMeanAbsDiff: r.credence.meanAbsDiff,
    statusAgreement: r.credence.statusAgreement,
    edgeEditDistance: r.structure.editDistance,
    unmatchedByCreator: r.claimSet.unmatchedByCreator,
    cost: { a: input.armA?.costMicroUsd ?? null, b: input.armB.costMicroUsd ?? null },
    capped: { a: input.armA?.capped ?? false, b: input.armB.capped },
    reading,
  };
}
