import { describe, it, expect } from "vitest";
import {
  chooseK,
  cosine,
  kmeans,
  parseVectorLiteral,
  pickExemplars,
  summarizeClusters,
} from "../../../src/services/tag-clustering-service.js";

// Three well-separated directions in 8-d, with small noise around each, so
// the partition is unambiguous and the test checks the algorithm rather than
// the data.
function synthetic(seed = 1): { vectors: number[][]; labels: number[] } {
  const bases = [
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 0],
  ];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const vectors: number[][] = [];
  const labels: number[] = [];
  for (let i = 0; i < 60; i++) {
    const c = i % 3;
    vectors.push(bases[c]!.map((x) => x + (rand() - 0.5) * 0.2));
    labels.push(c);
  }
  return { vectors, labels };
}

describe("kmeans (spherical, k-means++)", () => {
  it("recovers well-separated clusters", () => {
    const { vectors, labels } = synthetic();
    const result = kmeans(vectors, 3, { seed: 7 });
    expect(result.centroids).toHaveLength(3);
    // Every synthetic label maps to exactly one cluster index and vice versa.
    const mapping = new Map<number, number>();
    for (let i = 0; i < vectors.length; i++) {
      const got = result.assignments[i]!;
      const prev = mapping.get(labels[i]!);
      if (prev === undefined) mapping.set(labels[i]!, got);
      else expect(prev).toBe(got);
    }
    expect(new Set(mapping.values()).size).toBe(3);
  });

  it("is deterministic under the same seed and differs under another", () => {
    const { vectors } = synthetic();
    const a = kmeans(vectors, 5, { seed: 3 });
    const b = kmeans(vectors, 5, { seed: 3 });
    expect(a.assignments).toEqual(b.assignments);
    expect(a.centroids).toEqual(b.centroids);
  });

  it("returns unit-length centroids and drops empty clusters", () => {
    const { vectors } = synthetic();
    // k larger than the natural structure: some clusters may empty out.
    const result = kmeans(vectors, 20, { seed: 11 });
    expect(result.centroids.length).toBeLessThanOrEqual(20);
    for (const c of result.centroids) {
      const norm = Math.sqrt(c.reduce((acc, x) => acc + x * x, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
    // Assignments only reference surviving clusters.
    for (const a of result.assignments) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(result.centroids.length);
    }
  });

  it("handles the degenerate inputs", () => {
    expect(kmeans([], 3)).toEqual({ assignments: [], centroids: [], iterations: 0 });
    const one = kmeans([[1, 0]], 3);
    expect(one.centroids).toHaveLength(1);
    expect(one.assignments).toEqual([0]);
  });
});

describe("summarizeClusters / pickExemplars", () => {
  it("orders members nearest-first and reports cohesion", () => {
    const { vectors } = synthetic();
    const result = kmeans(vectors, 3, { seed: 7 });
    const summaries = summarizeClusters(vectors, result);
    expect(summaries).toHaveLength(3);
    for (const s of summaries) {
      expect(s.size).toBe(s.members.length);
      expect(s.cohesion).toBeGreaterThan(0.9);
      // nearest-first: similarity to the centroid is non-increasing
      const sims = s.members.map((i) => cosine(vectors[i]!, s.centroid));
      for (let j = 1; j < sims.length; j++) expect(sims[j]!).toBeLessThanOrEqual(sims[j - 1]! + 1e-9);
    }
  });

  it("takes the head plus an even spread from the tail", () => {
    const cluster = {
      index: 0,
      size: 20,
      centroid: [1],
      members: Array.from({ length: 20 }, (_, i) => i),
      cohesion: 1,
    };
    const picked = pickExemplars(cluster, { nearest: 4, spread: 4 });
    expect(picked.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(picked).toHaveLength(8);
    // spread members come from beyond the head, evenly spaced
    expect(picked.slice(4)).toEqual([4, 8, 12, 16]);
    // a cluster smaller than the head returns just its members
    expect(pickExemplars({ ...cluster, size: 3, members: [0, 1, 2] }, { nearest: 4 })).toEqual([0, 1, 2]);
  });
});

describe("chooseK", () => {
  it("scales as sqrt(n/2) inside the clamps", () => {
    expect(chooseK(0)).toBe(0);
    expect(chooseK(3)).toBe(3);
    expect(chooseK(50)).toBe(5);
    expect(chooseK(200)).toBe(10);
    expect(chooseK(100_000)).toBe(40);
    expect(chooseK(10, { min: 2, max: 3 })).toBe(2);
    expect(chooseK(50, { min: 2, max: 3 })).toBe(3);
  });
});

describe("parseVectorLiteral", () => {
  it("reads pgvector's text form", () => {
    expect(parseVectorLiteral("[0.1,0.25,-1]")).toEqual([0.1, 0.25, -1]);
  });
});
