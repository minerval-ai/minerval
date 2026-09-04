import { describe, it, expect } from "vitest";
import { buildPropertyArms, isProperty, summarizeProperty } from "../../../scripts/corpus/property-lib.js";
import { orderPosts } from "../../../scripts/corpus/run.js";
import type { AgreementReport } from "../../../scripts/corpus/graph-agreement.js";

describe("orderPosts", () => {
  const posts = ["a", "b", "c", "d", "e"];
  it("leaves order alone without a flag, reverses on request", () => {
    expect(orderPosts(posts, undefined)).toEqual(posts);
    expect(orderPosts(posts, "reverse")).toEqual(["e", "d", "c", "b", "a"]);
  });
  it("shuffles reproducibly by seed, as a permutation", () => {
    const s1 = orderPosts(posts, "shuffle:1");
    expect(orderPosts(posts, "shuffle:1")).toEqual(s1);
    expect([...s1].sort()).toEqual(posts);
    expect(orderPosts(posts, "shuffle:2")).not.toEqual(s1);
    expect(s1).not.toEqual(posts);
  });
  it("rejects anything else", () => {
    expect(() => orderPosts(posts, "random")).toThrow(/--order/);
  });
});

describe("buildPropertyArms", () => {
  it("idempotency: two identical arms", () => {
    const arms = buildPropertyArms({ property: "idempotency", cluster: "eggs", profile: "production", limit: 2 });
    expect(arms.map((a) => a.arm)).toEqual(["a", "b"]);
    expect(arms[0]!.args).toEqual(arms[1]!.args);
    expect(arms[0]!.args).toEqual(["eggs", "--profile=production", "--limit=2"]);
  });
  it("path-independence: arm B carries the seeded order", () => {
    const arms = buildPropertyArms({ property: "path-independence", cluster: "lableak", seed: 7, posts: ["p1", "p2"] });
    expect(arms[0]!.args).toEqual(["lableak", "--posts=p1,p2"]);
    expect(arms[1]!.args).toEqual(["lableak", "--posts=p1,p2", "--order=shuffle:7"]);
  });
  it("skips arm A with a baseline snapshot", () => {
    expect(buildPropertyArms({ property: "idempotency", cluster: "eggs", baselineSnapshot: "base" }).map((a) => a.arm)).toEqual(["b"]);
  });
  it("knows its properties", () => {
    expect(isProperty("idempotency")).toBe(true);
    expect(isProperty("model-convergence")).toBe(false);
  });
});

describe("summarizeProperty", () => {
  const agreement = (f1: number, edit: number, edges = 10): AgreementReport => ({
    a: "a", b: "b",
    claimSet: { sizeA: 10, sizeB: 10, matched: Math.round(f1 * 10), precision: f1, recall: f1, f1, byMethod: { exact: 5, embedding: 3, judge: 0 }, unmatchedA: [], unmatchedB: [], unmatchedByCreator: { a: { claim_steward: 1 }, b: {} } },
    credence: { n: 5, meanAbsDiff: 0.08, rmsDiff: 0.1, within01: 0.8, statusN: 6, statusAgreement: 0.83, statusConfusion: {}, oneSided: 0 },
    structure: { edgesA: edges, edgesB: edges, sharedIgnoringRel: edges - edit / 2, sharedWithRel: edges - edit, precision: 0.9, recall: 0.9, editDistance: edit, danglingA: 0, danglingB: 0 },
  });
  const arm = { cluster: "eggs", registryId: null, startedAt: "t", finishedAt: "t", postsIngested: 3, capped: false, costMicroUsd: 500_000, models: {} as never };

  it("reads a close reproduction as such, and carries the numbers", () => {
    const s = summarizeProperty({ property: "idempotency", cluster: "eggs", armA: arm, armB: arm, agreement: agreement(0.95, 1) });
    expect(s.reading).toMatch(/reproduced the graph closely/);
    expect(s.reading).toMatch(/One pair of arms is one sample/);
    expect(s.claimSetF1).toBe(0.95);
    expect(s.edgeEditDistance).toBe(1);
    expect(s.unmatchedByCreator.a).toEqual({ claim_steward: 1 });
    expect(s.cost).toEqual({ a: 500_000, b: 500_000 });
  });

  it("reads a low F1 as a failed property", () => {
    const s = summarizeProperty({ property: "path-independence", cluster: "eggs", armA: null, armB: arm, agreement: agreement(0.5, 8) });
    expect(s.reading).toMatch(/not yet path independent/);
    expect(s.cost.a).toBeNull();
  });
});
