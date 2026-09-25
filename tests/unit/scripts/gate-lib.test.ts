import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATED,
  evaluateGate,
  gateVerdictFor,
  METRIC_DIRECTIONS,
  renderGate,
  resolveGated,
  selectGroups,
  type ScorecardFile,
} from "../../../scripts/corpus/gate-lib.js";
import { compareBand, HEADLINE_METRICS } from "../../../scripts/corpus/band.js";
import type { Scorecard } from "../../../scripts/corpus/score.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, "../../../corpus/scorecards/blackholes/2026-08-09T15-47-32-753Z.json");
const base = JSON.parse(readFileSync(BASELINE, "utf-8")) as Scorecard;

/** A variant of the committed baseline with a few numbers moved. */
function card(file: string, over: { at?: string; epoch?: string; profile?: string | null; bar?: number; violations?: number; dedup?: number; trace?: number }): ScorecardFile {
  const c = structuredClone(base);
  c.generatedAt = over.at ?? c.generatedAt;
  if (over.epoch) c.config.pipelineEpoch = over.epoch;
  if (over.profile !== undefined) c.config.profile = over.profile;
  if (over.bar !== undefined) c.judged!.claimBarPassRate = over.bar;
  if (over.violations !== undefined) c.structural.coherence.violations = over.violations;
  if (over.dedup !== undefined) c.structural.matching.dedupRatio = over.dedup;
  if (over.trace !== undefined) c.structural.assessment.pctWithTrace = over.trace;
  return { file, card: c };
}

const A = [
  card("a1.json", { at: "2026-08-10T00:00:00.000Z", bar: 0.7, violations: 0, dedup: 2.2, trace: 1 }),
  card("a2.json", { at: "2026-08-11T00:00:00.000Z", bar: 0.72, violations: 1, dedup: 2.3, trace: 1 }),
  card("a3.json", { at: "2026-08-12T00:00:00.000Z", bar: 0.68, violations: 0, dedup: 2.25, trace: 0.98 }),
];

describe("directions and gated metrics", () => {
  it("assign a direction to every headline metric and gate only directed ones", () => {
    for (const m of HEADLINE_METRICS) expect(m.label in METRIC_DIRECTIONS, m.label).toBe(true);
    for (const g of DEFAULT_GATED) expect(METRIC_DIRECTIONS[g]).not.toBeNull();
    expect(resolveGated(undefined)).toEqual(DEFAULT_GATED);
    expect(resolveGated("claim-bar,coherence")).toEqual(["judge · claim-bar pass-rate", "§21 · coherence violations"]);
    expect(() => resolveGated("nope")).toThrow(/matches no headline metric/);
    expect(() => resolveGated("judge")).toThrow(/ambiguous/);
    expect(() => resolveGated("max depth")).toThrow(/no direction/);
  });

  it("read a band row in its metric's direction", () => {
    const up = compareBand("m", [0.6, 0.62, 0.64], [0.8, 0.82, 0.84]);
    expect(gateVerdictFor(up, "higher")).toBe("improved");
    expect(gateVerdictFor(up, "lower")).toBe("regressed");
    expect(gateVerdictFor(up, null)).toBe("moved");
    expect(gateVerdictFor(compareBand("m", [0.5, 0.7], [0.6, 0.8]), "higher")).toBe("within band");
    expect(gateVerdictFor(compareBand("m", [0.5], [0.9]), "higher")).toBe("no verdict");
    expect(gateVerdictFor(compareBand("m", [null], [0.9]), "higher")).toBe("n/a");
  });
});

describe("selectGroups", () => {
  const B = [
    card("b1.json", { at: "2026-09-01T00:00:00.000Z" }),
    card("b2.json", { at: "2026-09-02T00:00:00.000Z" }),
    card("b3.json", { at: "2026-09-03T00:00:00.000Z" }),
    card("b4.json", { at: "2026-09-04T00:00:00.000Z" }),
  ];

  it("honours baselines.json and takes the newest non-baseline runs as the candidate", () => {
    const g = selectGroups({ files: [...A, ...B], baselines: { epoch: base.config.pipelineEpoch, files: ["a1.json", "a2.json", "a3.json"] }, minN: 2 });
    expect(g.baseline.map((f) => f.file)).toEqual(["a1.json", "a2.json", "a3.json"]);
    expect(g.candidate.map((f) => f.file)).toEqual(["b2.json", "b3.json", "b4.json"]);
    expect(g.how.baseline).toMatch(/baselines\.json/);
  });

  it("falls back to the earliest runs sharing the earliest fingerprint, and stops at another epoch", () => {
    const later = [card("c1.json", { at: "2026-10-01T00:00:00.000Z", epoch: "2026-10-next" }), card("c2.json", { at: "2026-10-02T00:00:00.000Z", epoch: "2026-10-next" })];
    const g = selectGroups({ files: [...later, ...A], baselines: null, minN: 2 });
    expect(g.baseline.map((f) => f.file)).toEqual(["a1.json", "a2.json"]);
    expect(g.candidate.map((f) => f.file)).toEqual(["c1.json", "c2.json"]);
    expect(g.how.baseline).toMatch(/earliest 2 run/);
  });

  it("takes explicit --baseline and --candidate lists and refuses unknown files or a mis-declared epoch", () => {
    const g = selectGroups({ files: [...A, ...B], baselines: null, baselineArg: "a1.json,a3", candidateArg: "b4.json", minN: 1 });
    expect(g.baseline.map((f) => f.file)).toEqual(["a1.json", "a3.json"]);
    expect(g.candidate.map((f) => f.file)).toEqual(["b4.json"]);
    expect(() => selectGroups({ files: A, baselines: null, baselineArg: "zz.json", minN: 1 })).toThrow(/no scorecard file "zz.json"/);
    expect(() => selectGroups({ files: A, baselines: { epoch: "other", files: ["a1.json"] }, minN: 1 })).toThrow(/declares epoch other/);
  });
});

describe("evaluateGate", () => {
  it("passes when no gated metric regresses beyond the band", () => {
    const B = [
      card("b1.json", { at: "2026-09-01T00:00:00.000Z", bar: 0.71, violations: 0, dedup: 2.3, trace: 1 }),
      card("b2.json", { at: "2026-09-02T00:00:00.000Z", bar: 0.69, violations: 1, dedup: 2.2, trace: 1 }),
    ];
    const r = evaluateGate({ baseline: A, candidate: B, gated: DEFAULT_GATED, minN: 2 });
    expect(r.status).toBe("gated");
    expect(r.passed).toBe(true);
    expect(r.regressions).toEqual([]);
    expect(r.reading).toMatch(/Gate passed/);
    expect(renderGate(r)).toMatch(/\[gated\]/);
  });

  it("fails on a regression of a gated metric in its bad direction, and reports improvements", () => {
    const B = [
      card("b1.json", { at: "2026-09-01T00:00:00.000Z", bar: 0.5, violations: 4, dedup: 2.9, trace: 1 }),
      card("b2.json", { at: "2026-09-02T00:00:00.000Z", bar: 0.52, violations: 5, dedup: 3.0, trace: 1 }),
    ];
    const r = evaluateGate({ baseline: A, candidate: B, gated: DEFAULT_GATED, minN: 2 });
    expect(r.status).toBe("gated");
    expect(r.passed).toBe(false);
    // In HEADLINE_METRICS order.
    expect(r.regressions).toEqual(["§21 · coherence violations", "judge · claim-bar pass-rate"]);
    expect(r.rows.find((x) => x.label === "C · dedup ratio")?.gateVerdict).toBe("improved");
    expect(r.reading).toMatch(/Gate FAILED: §21 · coherence violations; judge · claim-bar pass-rate regressed/);
    expect(r.reading).toMatch(/Improved beyond the band: C · dedup ratio/);
  });

  it("refuses to gate with too few runs on a side, exiting clean", () => {
    const r = evaluateGate({ baseline: A, candidate: [card("b1.json", { at: "2026-09-01T00:00:00.000Z", bar: 0.2 })], gated: DEFAULT_GATED, minN: 2 });
    expect(r.status).toBe("refused");
    expect(r.passed).toBe(true);
    expect(r.reason).toMatch(/each side needs ≥ 2 runs/);
    // The deltas are still there to read.
    expect(r.rows.find((x) => x.label === "judge · claim-bar pass-rate")?.delta).toBeLessThan(0);
  });

  it("refuses to gate across a profile or epoch change, and a mixed group", () => {
    const other = [card("p1.json", { at: "2026-09-01T00:00:00.000Z", profile: "production" }), card("p2.json", { at: "2026-09-02T00:00:00.000Z", profile: "production" })];
    const r = evaluateGate({ baseline: A, candidate: other, gated: DEFAULT_GATED, minN: 2 });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/differ in profile or epoch/);
    const mixed = evaluateGate({ baseline: [...A, card("x.json", { epoch: "other" })], candidate: A, gated: DEFAULT_GATED, minN: 2 });
    expect(mixed.reason).toMatch(/baseline mixes fingerprints/);
    const empty = evaluateGate({ baseline: A, candidate: [], gated: DEFAULT_GATED, minN: 2 });
    expect(empty.reason).toMatch(/a side is empty/);
  });

  it("marks one-sided verdicts as weaker evidence rather than hiding them (only reachable with --min-n=1)", () => {
    // A side with one run has no spread, so the band is the other side's alone.
    const single = [card("f1.json", { at: "2026-08-10T00:00:00.000Z", bar: 0.7 })];
    const B = [card("b1.json", { at: "2026-09-01T00:00:00.000Z", bar: 0.5 }), card("b2.json", { at: "2026-09-02T00:00:00.000Z", bar: 0.52 })];
    const r = evaluateGate({ baseline: single, candidate: B, gated: ["judge · claim-bar pass-rate"], minN: 1 });
    expect(r.passed).toBe(false);
    expect(r.oneSided).toEqual(["judge · claim-bar pass-rate"]);
    expect(r.reading).toMatch(/One-sided verdicts/);
  });
});
