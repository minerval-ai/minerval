/**
 * Pure structural metrics for a corpus-run scorecard (#99).
 *
 * These need no LLM: they read the graph a run produced and derive the numbers
 * the RUBRIC dimensions can be tracked by (depth histograms, dedup ratio,
 * canonical-form lengths, status distribution, importance vs decomposition).
 * Kept pure and DB-free so they are unit-testable with fixtures; `score.ts`
 * pulls the snapshot out of the corpus DB and hands it here.
 */

export interface GraphSnapshot {
  claims: Array<{
    id: string;
    text: string;
    claimType: string;
    importance: number;
    createdBy: string;
  }>;
  /** decomposition/relationship edges: parent leans on child */
  edges: Array<{ parent: string; child: string; rel: string }>;
  /** current assessments only */
  assessments: Array<{
    claimId: string;
    status: string;
    confidence: number;
    reasoningTrace: string;
  }>;
  /** one row per instance (utterance); we only need the claim id to count */
  instances: Array<{ claimId: string }>;
  /** total word count across all ingested source bodies (for claims-per-1k-words) */
  sourceWords: number;
}

export interface StructuralMetrics {
  extraction: {
    topLevelClaims: number;
    instances: number;
    totalClaims: number;
    claimsPer1kWords: number | null;
    typeDistribution: Record<string, number>;
  };
  canonicalForm: {
    wordCount: { p50: number; p90: number; max: number; mean: number };
    overLongShare: number; // share of claims > 25 words (a canonical-form smell)
  };
  matching: {
    dedupRatio: number | null; // instances / top-level claims
  };
  decomposition: {
    maxDepth: number;
    depthHistogram: Record<number, number>; // top-level claim → its tree depth
    atomicShare: number; // share of claims with no children
    meanChildrenPerParent: number;
  };
  crossDoc: {
    sharedSubclaims: number; // subclaims with > 1 distinct parent
  };
  assessment: {
    statusDistribution: Record<string, number>;
    pctWithTrace: number;
    meanTraceLength: number;
  };
  importance: {
    mean: number;
    histogram: Record<string, number>; // 0.0–0.2, 0.2–0.4, …
    meanAtomic: number | null; // mean importance of atomic (leaf) claims
    meanCompound: number | null; // mean importance of claims with children
  };
  /**
   * Constitution §21's crisp coherence rules, checked mechanically (#334 S3
   * tier 2, the always-free slice): a claim cannot stand verified while a
   * premise it requires stands contradicted, and two claims joined by a
   * contradiction edge cannot both be verified. `violations` are the letter
   * of §21; `tensions` are the supported-grade near-misses worth watching.
   * These surface candidates for the Steward/Curator to judge — a violation
   * is a defect in an assessment OR in an edge, and which one is a judgment.
   */
  coherence: {
    violations: number;
    tensions: number;
    items: Array<{
      rule: "premise" | "contradiction";
      severity: "violation" | "tension";
      parent: string;
      child: string;
    }>;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function bucket(x: number): string {
  const b = Math.min(4, Math.floor(x * 5)); // 0..1 → 0..4
  const lo = (b * 0.2).toFixed(1);
  const hi = ((b + 1) * 0.2).toFixed(1);
  return `${lo}-${hi}`;
}

/**
 * Longest root-to-leaf depth of a claim's decomposition, memoized, with a
 * visited set on the current path so a cycle (A→B→A) is bounded instead of
 * looping forever. Shared subclaims (a DAG diamond) are visited once per
 * memo, not re-expanded per path — so this does NOT blow up the way the
 * tree-rendering CTE does.
 */
function computeDepths(
  claimIds: string[],
  childrenOf: Map<string, string[]>
): Map<string, number> {
  const memo = new Map<string, number>();
  const depthOf = (id: string, path: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const kids = childrenOf.get(id) ?? [];
    let best = 0;
    for (const k of kids) {
      if (path.has(k)) continue; // cycle guard
      path.add(k);
      best = Math.max(best, 1 + depthOf(k, path));
      path.delete(k);
    }
    // Only memoize acyclic results (a node on the current path may be
    // undercounted); safe because the graph is overwhelmingly a DAG.
    memo.set(id, best);
    return best;
  };
  const out = new Map<string, number>();
  for (const id of claimIds) out.set(id, depthOf(id, new Set([id])));
  return out;
}

export function computeStructuralMetrics(g: GraphSnapshot): StructuralMetrics {
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, Set<string>>();
  for (const e of g.edges) {
    (childrenOf.get(e.parent) ?? childrenOf.set(e.parent, []).get(e.parent)!).push(e.child);
    (parentsOf.get(e.child) ?? parentsOf.set(e.child, new Set()).get(e.child)!).add(e.parent);
  }

  const instancesByClaim = new Map<string, number>();
  for (const i of g.instances) {
    instancesByClaim.set(i.claimId, (instancesByClaim.get(i.claimId) ?? 0) + 1);
  }
  const topLevel = g.claims.filter((c) => (instancesByClaim.get(c.id) ?? 0) > 0);

  // extraction
  const typeDistribution: Record<string, number> = {};
  for (const c of g.claims) typeDistribution[c.claimType] = (typeDistribution[c.claimType] ?? 0) + 1;

  // canonical form lengths
  const wordCounts = g.claims.map((c) => c.text.trim().split(/\s+/).filter(Boolean).length);
  const sortedWc = [...wordCounts].sort((a, b) => a - b);
  const meanWc = wordCounts.length
    ? wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length
    : 0;
  const overLong = wordCounts.filter((w) => w > 25).length;

  // decomposition
  const depths = computeDepths(g.claims.map((c) => c.id), childrenOf);
  const depthHistogram: Record<number, number> = {};
  for (const c of topLevel) {
    const d = depths.get(c.id) ?? 0;
    depthHistogram[d] = (depthHistogram[d] ?? 0) + 1;
  }
  const maxDepth = Math.max(0, ...[...depths.values()]);
  const withKids = g.claims.filter((c) => (childrenOf.get(c.id)?.length ?? 0) > 0);
  const atomicShare = g.claims.length ? 1 - withKids.length / g.claims.length : 0;
  const totalEdges = g.edges.length;
  const meanChildrenPerParent = withKids.length ? totalEdges / withKids.length : 0;

  // cross-doc structure
  let sharedSubclaims = 0;
  for (const [, ps] of parentsOf) if (ps.size > 1) sharedSubclaims++;

  // assessment
  const statusDistribution: Record<string, number> = {};
  let traceLenSum = 0;
  let withTrace = 0;
  for (const a of g.assessments) {
    statusDistribution[a.status] = (statusDistribution[a.status] ?? 0) + 1;
    const len = (a.reasoningTrace ?? "").trim().length;
    traceLenSum += len;
    if (len > 40) withTrace++;
  }
  const nAssessed = g.assessments.length;

  // importance
  const importances = g.claims.map((c) => c.importance);
  const meanImp = importances.length
    ? importances.reduce((a, b) => a + b, 0) / importances.length
    : 0;
  const histogram: Record<string, number> = {};
  for (const x of importances) histogram[bucket(x)] = (histogram[bucket(x)] ?? 0) + 1;
  const atomicImps = g.claims
    .filter((c) => (childrenOf.get(c.id)?.length ?? 0) === 0)
    .map((c) => c.importance);
  const compoundImps = g.claims
    .filter((c) => (childrenOf.get(c.id)?.length ?? 0) > 0)
    .map((c) => c.importance);
  const mean = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;

  return {
    extraction: {
      topLevelClaims: topLevel.length,
      instances: g.instances.length,
      totalClaims: g.claims.length,
      claimsPer1kWords: g.sourceWords > 0 ? (g.claims.length / g.sourceWords) * 1000 : null,
      typeDistribution,
    },
    canonicalForm: {
      wordCount: {
        p50: percentile(sortedWc, 50),
        p90: percentile(sortedWc, 90),
        max: sortedWc.length ? sortedWc[sortedWc.length - 1]! : 0,
        mean: Math.round(meanWc * 10) / 10,
      },
      overLongShare: g.claims.length ? overLong / g.claims.length : 0,
    },
    matching: {
      dedupRatio: topLevel.length > 0 ? g.instances.length / topLevel.length : null,
    },
    decomposition: {
      maxDepth,
      depthHistogram,
      atomicShare: Math.round(atomicShare * 1000) / 1000,
      meanChildrenPerParent: Math.round(meanChildrenPerParent * 100) / 100,
    },
    crossDoc: { sharedSubclaims },
    assessment: {
      statusDistribution,
      pctWithTrace: nAssessed ? withTrace / nAssessed : 0,
      meanTraceLength: nAssessed ? Math.round(traceLenSum / nAssessed) : 0,
    },
    importance: {
      mean: Math.round(meanImp * 1000) / 1000,
      histogram,
      meanAtomic: mean(atomicImps),
      meanCompound: mean(compoundImps),
    },
    coherence: computeCoherence(g),
  };
}

/**
 * §21's two mechanical rules over current assessments and edges.
 *
 * Rule "premise": parent leaning on a `requires` child (a load-bearing
 * premise — `assumes` is deliberately excluded: a failed assumption makes the
 * parent ill-posed, not false, per the relation guidance). Parent verified
 * with the premise contradicted is a violation; parent supported with the
 * premise contradicted is a tension.
 *
 * Rule "contradiction": a `contradicts` edge with both endpoints verified is
 * a violation; both at least supported (but not both verified) is a tension.
 * Unassessed endpoints never fire either rule.
 */
function computeCoherence(g: GraphSnapshot): StructuralMetrics["coherence"] {
  const statusOf = new Map(g.assessments.map((a) => [a.claimId, a.status]));
  const items: StructuralMetrics["coherence"]["items"] = [];
  const positive = (s: string | undefined) => s === "verified" || s === "supported";

  for (const e of g.edges) {
    const parent = statusOf.get(e.parent);
    const child = statusOf.get(e.child);
    if (e.rel === "requires") {
      if (child === "contradicted" && positive(parent)) {
        items.push({
          rule: "premise",
          severity: parent === "verified" ? "violation" : "tension",
          parent: e.parent,
          child: e.child,
        });
      }
    } else if (e.rel === "contradicts") {
      if (positive(parent) && positive(child)) {
        items.push({
          rule: "contradiction",
          severity:
            parent === "verified" && child === "verified" ? "violation" : "tension",
          parent: e.parent,
          child: e.child,
        });
      }
    }
  }
  return {
    violations: items.filter((i) => i.severity === "violation").length,
    tensions: items.filter((i) => i.severity === "tension").length,
    items,
  };
}
