import { describe, it, expect } from "vitest";
import {
  armSnapshotNames,
  buildArmCommands,
  envVarFor,
  summarizeSwap,
} from "../../../scripts/corpus/swap-lib.js";
import { assertSnapshotName } from "../../../scripts/corpus/snapshot-core.js";
import type { AgreementReport } from "../../../scripts/corpus/graph-agreement.js";

describe("envVarFor", () => {
  it("maps the swappable agents to their model env vars and rejects others", () => {
    expect(envVarFor("matcher")).toBe("MATCHER_MODEL");
    expect(envVarFor("steward")).toBe("STEWARD_MODEL");
    expect(() => envVarFor("judge")).toThrow(/Unknown agent/);
  });
});

describe("armSnapshotNames", () => {
  it("produces names the snapshot primitive accepts", () => {
    const n = armSnapshotNames("2026-09-02T20:30:11.123Z");
    expect(n.a).toBe("swap_202609022030_a");
    expect(() => assertSnapshotName(n.a)).not.toThrow();
    expect(() => assertSnapshotName(n.b)).not.toThrow();
  });
});

describe("buildArmCommands", () => {
  it("runs a reference arm and a swapped arm with the same cluster arguments", () => {
    const arms = buildArmCommands({
      cluster: "lableak",
      agent: "matcher",
      model: "claude-haiku-4-5-20251001",
      profile: "production",
      limit: 2,
      posts: ["p1", "p2"],
    });
    expect(arms.map((a) => a.arm)).toEqual(["a", "b"]);
    expect(arms[0]!.args).toEqual(["lableak", "--profile=production", "--limit=2", "--posts=p1,p2"]);
    expect(arms[0]!.env).toEqual({});
    expect(arms[1]!.args).toEqual([
      "lableak",
      "--profile=production",
      "--limit=2",
      "--posts=p1,p2",
      "--swap=matcher:claude-haiku-4-5-20251001",
    ]);
    expect(arms[1]!.env).toEqual({ MATCHER_MODEL: "claude-haiku-4-5-20251001" });
  });

  it("skips the reference arm when a baseline snapshot is given", () => {
    const arms = buildArmCommands({ cluster: "eggs", agent: "steward", model: "claude-sonnet-5", baselineSnapshot: "base" });
    expect(arms.map((a) => a.arm)).toEqual(["b"]);
  });
});

describe("summarizeSwap", () => {
  const agreement: AgreementReport = {
    a: "snap:a",
    b: "snap:b",
    claimSet: {
      sizeA: 10, sizeB: 9, matched: 8, precision: 0.889, recall: 0.8, f1: 0.842,
      byMethod: { exact: 5, embedding: 3, judge: 0 }, unmatchedA: ["x", "y"], unmatchedB: ["z"],
      unmatchedByCreator: { a: { claim_steward: 2 }, b: { claim_steward: 1 } },
    },
    credence: { n: 6, meanAbsDiff: 0.12, rmsDiff: 0.15, within01: 0.5, statusN: 8, statusAgreement: 0.75, statusConfusion: {}, oneSided: 1 },
    structure: { edgesA: 7, edgesB: 6, sharedIgnoringRel: 5, sharedWithRel: 4, precision: 0.833, recall: 0.714, editDistance: 3, danglingA: 2, danglingB: 1 },
  };
  const arm = (models: Record<string, string>, observed: Record<string, string[]>, cost: number): Parameters<typeof summarizeSwap>[0]["armB"] => ({
    cluster: "lableak", registryId: null, startedAt: "t", finishedAt: "t", postsIngested: 5, capped: false,
    costMicroUsd: cost, models: models as never, observed,
  });

  it("names the reference model from what arm A actually ran, and carries the axes and costs", () => {
    const s = summarizeSwap({
      cluster: "lableak",
      agent: "matcher",
      swapModel: "claude-haiku-4-5-20251001",
      armA: arm({ matcher: "deepseek/deepseek-v4-flash" }, { matcher: ["deepseek/deepseek-v4-flash"] }, 1_000_000),
      armB: arm({ matcher: "claude-haiku-4-5-20251001" }, { matcher: ["claude-haiku-4-5-20251001"] }, 1_400_000),
      agreement,
    });
    expect(s.referenceModel).toBe("deepseek/deepseek-v4-flash");
    expect(s.claimSetF1).toBe(0.842);
    expect(s.credenceMeanAbsDiff).toBe(0.12);
    expect(s.edgeEditDistance).toBe(3);
    expect(s.cost).toEqual({ a: 1_000_000, b: 1_400_000 });
  });

  it("falls back to the configured model when nothing was observed, and tolerates a missing arm A", () => {
    const s = summarizeSwap({
      cluster: "lableak",
      agent: "steward",
      swapModel: "claude-sonnet-5",
      armA: null,
      armB: arm({ steward: "claude-sonnet-5" }, {}, 2_000_000),
      agreement,
    });
    expect(s.referenceModel).toBe("unknown");
    expect(s.cost).toEqual({ a: null, b: 2_000_000 });
    expect(s.capped).toEqual({ a: false, b: false });
  });
});
