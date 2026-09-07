/**
 * Clustering over the claim embedding space (#272), for seeding the tag
 * vocabulary.
 *
 * Pure functions, no I/O: the seed script (scripts/seed-tags-from-
 * clusters.ts) loads the vectors and names the clusters; this module only
 * partitions. Spherical k-means (unit vectors, cosine distance) with
 * k-means++ seeding under a fixed pseudo-random seed, so a run is
 * reproducible and the dry run shows the same clusters the write will use.
 *
 * Why k-means and not something cleverer: the goal is not the "true"
 * clusters (the tagger decides each claim's tags individually afterwards)
 * but a spread of centroids that between them cover the graph's topics, so
 * the first tags minted are the broad ones every later claim can reuse. A
 * coarse partition with sensible k does that; the naming step declines any
 * cluster that turns out incoherent.
 */

export interface ClusteringResult {
  /** Cluster index per input vector. */
  assignments: number[];
  /** Unit-length centroids, one per cluster (an empty cluster is dropped and
   *  its members reassigned, so `centroids.length` may be less than k). */
  centroids: number[][];
  iterations: number;
}

/** Deterministic PRNG (mulberry32) so seeding is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Cosine similarity of two vectors that need not be unit length. */
export function cosine(a: number[], b: number[]): number {
  return dot(normalize(a), normalize(b));
}

/**
 * A default k for n vectors: roughly sqrt(n / 2), clamped so a small graph
 * still gets a few clusters and a large one does not get hundreds of tags
 * from one pass. Callers override with --k.
 */
export function chooseK(n: number, opts: { min?: number; max?: number } = {}): number {
  const min = opts.min ?? 4;
  const max = opts.max ?? 40;
  if (n <= 0) return 0;
  const k = Math.round(Math.sqrt(n / 2));
  return Math.max(Math.min(k, max, n), Math.min(min, n));
}

function meanUnit(vectors: number[][], members: number[], dims: number): number[] {
  const sum = new Array<number>(dims).fill(0);
  for (const i of members) {
    const v = vectors[i]!;
    for (let d = 0; d < dims; d++) sum[d]! += v[d]!;
  }
  return normalize(sum.map((x) => x / members.length));
}

/**
 * Spherical k-means. Inputs are normalized once; distance is 1 - cosine.
 * k-means++ initialization spreads the seeds; Lloyd iterations run until
 * no assignment changes or `maxIterations`.
 */
export function kmeans(
  input: number[][],
  k: number,
  opts: { seed?: number; maxIterations?: number } = {}
): ClusteringResult {
  const n = input.length;
  if (n === 0 || k <= 0) return { assignments: [], centroids: [], iterations: 0 };
  const vectors = input.map(normalize);
  const dims = vectors[0]!.length;
  const kk = Math.min(k, n);
  const rand = mulberry32(opts.seed ?? 272);
  const maxIterations = opts.maxIterations ?? 50;

  // k-means++: each next seed is drawn with probability proportional to its
  // squared distance from the nearest existing seed.
  const centroids: number[][] = [vectors[Math.floor(rand() * n)]!.slice()];
  const nearestDist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  while (centroids.length < kk) {
    const last = centroids[centroids.length - 1]!;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = 1 - dot(vectors[i]!, last);
      if (d < nearestDist[i]!) nearestDist[i] = d;
      total += nearestDist[i]! ** 2;
    }
    if (total === 0) {
      // Every remaining point coincides with a seed; fill with copies.
      centroids.push(vectors[Math.floor(rand() * n)]!.slice());
      continue;
    }
    let r = rand() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      r -= nearestDist[i]! ** 2;
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(vectors[chosen]!.slice());
  }

  const assignments = new Array<number>(n).fill(-1);
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const sim = dot(vectors[i]!, centroids[c]!);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed++;
      }
    }
    if (changed === 0 && iterations > 0) break;

    const members: number[][] = centroids.map(() => []);
    for (let i = 0; i < n; i++) members[assignments[i]!]!.push(i);
    for (let c = 0; c < centroids.length; c++) {
      if (members[c]!.length > 0) centroids[c] = meanUnit(vectors, members[c]!, dims);
    }
  }

  // Drop empty clusters and renumber.
  const counts = new Array<number>(centroids.length).fill(0);
  for (const a of assignments) counts[a]!++;
  const keep = centroids.map((_, c) => c).filter((c) => counts[c]! > 0);
  const remap = new Map(keep.map((c, i) => [c, i]));
  return {
    assignments: assignments.map((a) => remap.get(a)!),
    centroids: keep.map((c) => centroids[c]!),
    iterations: iterations + 1,
  };
}

export interface ClusterSummary {
  index: number;
  size: number;
  centroid: number[];
  /** Member indices ordered by closeness to the centroid. */
  members: number[];
  /** Mean cosine similarity of members to the centroid: coherence. */
  cohesion: number;
}

/** Per-cluster membership, ordered nearest-first, with a cohesion figure. */
export function summarizeClusters(input: number[][], result: ClusteringResult): ClusterSummary[] {
  const vectors = input.map(normalize);
  const groups: number[][] = result.centroids.map(() => []);
  result.assignments.forEach((c, i) => groups[c]!.push(i));
  return groups.map((members, index) => {
    const centroid = result.centroids[index]!;
    const scored = members
      .map((i) => ({ i, sim: dot(vectors[i]!, centroid) }))
      .sort((a, b) => b.sim - a.sim);
    const cohesion =
      scored.length === 0 ? 0 : scored.reduce((acc, s) => acc + s.sim, 0) / scored.length;
    return { index, size: members.length, centroid, members: scored.map((s) => s.i), cohesion };
  });
}

/**
 * Pick exemplars for naming a cluster: the `nearest` closest to the
 * centroid plus `spread` drawn evenly from the rest, so the name covers the
 * cluster's breadth rather than its densest corner.
 */
export function pickExemplars(
  cluster: ClusterSummary,
  opts: { nearest?: number; spread?: number } = {}
): number[] {
  const nearest = opts.nearest ?? 6;
  const spread = opts.spread ?? 4;
  const head = cluster.members.slice(0, nearest);
  const rest = cluster.members.slice(nearest);
  if (rest.length === 0 || spread <= 0) return head;
  const step = rest.length / spread;
  const picked: number[] = [];
  for (let j = 0; j < spread && Math.floor(j * step) < rest.length; j++) {
    picked.push(rest[Math.floor(j * step)]!);
  }
  return [...head, ...picked];
}

/** Parse a pgvector text literal ("[0.1,0.2,…]") into numbers. */
export function parseVectorLiteral(text: string): number[] {
  return text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((x) => Number(x));
}
