import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  gradeProbeQuestion,
  loadProbeFixture,
  summarizeProbe,
  summarizeRetraction,
  validateProbeFixture,
  type ProbeQuestion,
  type RetractionClaim,
} from "../../../scripts/corpus/probe-lib.js";
import {
  buildWithGraphPrompt,
  buildWithoutGraphPrompt,
  PROBE_WITH_GRAPH_SCHEMA,
  PROBE_WITHOUT_GRAPH_SCHEMA,
  renderGraphContext,
  retractionContext,
  type ContextClaim,
} from "../../../scripts/corpus/probe-prompts.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROBES = join(here, "../../../corpus/probes");

const context: ContextClaim[] = [
  { id: "aaaaaaaa-1111-4000-8000-000000000001", text: "LHC black holes could endanger the Earth.", status: "contradicted", confidence: 0.9, credence: 0.02, summary: "Astrophysical bounds exclude it.", similarity: 0.8 },
  { id: "bbbbbbbb-2222-4000-8000-000000000002", text: "Black holes emit Hawking radiation.", status: "verified", confidence: 0.85, credence: 0.9, summary: "Broad consensus.", similarity: 0.7 },
  { id: "cccccccc-3333-4000-8000-000000000003", text: "Hawking radiation has been observed directly.", status: "contested", confidence: 0.6, credence: null, summary: null, similarity: 0.6 },
];
const q: ProbeQuestion = { id: "q1", kind: "factual", question: "Could an LHC black hole endanger the Earth?" };

describe("the committed probe fixtures", () => {
  it("exist for every cluster and are well-formed", () => {
    const files = readdirSync(PROBES).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["blackholes.json", "eggs.json", "lableak.json", "lethalities.json"]);
    for (const f of files) {
      const fx = loadProbeFixture(join(PROBES, f));
      expect(validateProbeFixture(fx), f).toEqual([]);
      expect(fx.cluster).toBe(f.replace(".json", ""));
      const kinds = new Set(fx.questions.map((x) => x.kind));
      for (const k of ["factual", "comparative", "crux", "confidence"]) expect(kinds.has(k as never), `${f} has ${k}`).toBe(true);
    }
  });

  it("names the problems in a bad fixture", () => {
    const problems = validateProbeFixture({ cluster: "", description: "", questions: [{ id: "a", kind: "nope" as never, question: "short" }] });
    expect(problems.some((p) => /missing its cluster/.test(p))).toBe(true);
    expect(problems.some((p) => /unknown kind/.test(p))).toBe(true);
    expect(problems.some((p) => /too short/.test(p))).toBe(true);
    expect(problems.some((p) => /wants 8–12/.test(p))).toBe(true);
  });
});

describe("the prompts", () => {
  it("render the record with short ids, statuses, credences and summaries", () => {
    const text = renderGraphContext(context);
    expect(text).toContain("[aaaaaaaa] LHC black holes could endanger the Earth.");
    expect(text).toContain("status: contradicted · verdict confidence: 0.90 · credence (probability true): 0.02");
    expect(text).toContain("credence (probability true): not stated");
    expect(text).toContain("assessment: (none)");
    expect(renderGraphContext([])).toMatch(/holds no claims/);
  });

  it("put the question and the record into the with-graph prompt, and only the question into the other", () => {
    const withG = buildWithGraphPrompt("Q?", context);
    expect(withG).toContain("## Question\nQ?");
    expect(withG).toContain("## The record\n[aaaaaaaa]");
    expect(withG).toMatch(/ONLY the record/);
    const without = buildWithoutGraphPrompt("Q?");
    expect(without).toContain("## Question\nQ?");
    expect(without).not.toContain("record");
    expect(PROBE_WITH_GRAPH_SCHEMA.required).toEqual(["answer", "confidence", "cited_claims"]);
    expect(PROBE_WITHOUT_GRAPH_SCHEMA.required).toEqual(["answer", "confidence"]);
    expect(retractionContext({ title: "Plaga 2008", url: "https://arxiv.org/abs/0808.1415" })).toMatch(/"Plaga 2008" \(https:\/\/arxiv\.org\/abs\/0808\.1415\) has been RETRACTED/);
  });
});

describe("gradeProbeQuestion", () => {
  it("resolves citations, reads credence in the direction used, and flags contradictions", () => {
    const r = gradeProbeQuestion(
      q,
      context,
      {
        answer: "No.",
        confidence: 0.95,
        cited_claims: [
          { id: "[aaaaaaaa]", used_as: "false" }, // contradicted claim used as false: consistent; 1 − 0.02
          { id: "bbbbbbbb", used_as: "true" }, // verified used as true: consistent; 0.9
          { id: "cccccccc", used_as: "uncertain" }, // no credence, excluded from the mean
          { id: "zzzzzzzz", used_as: "true" }, // not in the record
        ],
      },
      { answer: "No.", confidence: 0.7 }
    );
    expect(r.citedAny).toBe(true);
    expect(r.citedUnknown).toBe(1);
    expect(r.contradictions).toBe(0);
    expect(r.meanCitedCredence).toBeCloseTo((0.98 + 0.9) / 2, 3);
    expect(r.credenceGap).toBeCloseTo(Math.abs(0.95 - 0.94), 3);
    expect(r.confidenceShift).toBeCloseTo(0.25, 3);
    expect(r.cited.find((c) => c.shortId === "aaaaaaaa")?.id).toBe(context[0]!.id);
  });

  it("counts a verified claim used as false, and a contradicted one used as true, as contradictions", () => {
    const r = gradeProbeQuestion(
      q,
      context,
      { answer: "Yes.", confidence: 0.8, cited_claims: [{ id: "aaaaaaaa", used_as: "true" }, { id: "bbbbbbbb", used_as: "false" }] },
      { answer: "?", confidence: 0.5 }
    );
    expect(r.contradictions).toBe(2);
    expect(r.meanCitedCredence).toBeCloseTo((0.02 + 0.1) / 2, 3);
  });

  it("clamps out-of-range confidences and copes with no citations", () => {
    const r = gradeProbeQuestion(q, context, { answer: "x", confidence: 7, cited_claims: [] }, { answer: "y", confidence: -1 });
    expect(r.withGraph.confidence).toBe(1);
    expect(r.withoutGraph.confidence).toBe(0);
    expect(r.citedAny).toBe(false);
    expect(r.credenceGap).toBeNull();
  });
});

describe("summarizeProbe", () => {
  it("reads citation rate, tracking and contradictions in plain language, and says it is diagnostic", () => {
    const a = gradeProbeQuestion(q, context, { answer: "", confidence: 0.9, cited_claims: [{ id: "bbbbbbbb", used_as: "true" }] }, { answer: "", confidence: 0.5 });
    const b = gradeProbeQuestion({ ...q, id: "q2", kind: "crux" }, context, { answer: "", confidence: 0.4, cited_claims: [] }, { answer: "", confidence: 0.6 });
    const c = gradeProbeQuestion({ ...q, id: "q3", kind: "confidence" }, context, { answer: "", confidence: 0.5, cited_claims: [{ id: "aaaaaaaa", used_as: "true" }] }, { answer: "", confidence: 0.5 });
    const s = summarizeProbe("blackholes", "m", [a, b, c]);
    expect(s.questions).toBe(3);
    expect(s.citationRate).toBeCloseTo(2 / 3, 3);
    expect(s.contradictions).toBe(1);
    expect(s.looseTracking).toBe(1); // c: |0.5 − 0.02| > 0.25
    expect(s.byKind.crux?.n).toBe(1);
    expect(s.reading).toMatch(/cited record claims on 67% of questions/);
    expect(s.reading).toMatch(/1 citation\(s\) used a verified claim as false or a contradicted claim as true/);
    expect(s.reading).toMatch(/Diagnostic only/);
  });
});

describe("summarizeRetraction", () => {
  const before = { assessmentId: "a1", status: "verified", confidence: 0.9, credence: 0.9, assessedAt: "2026-01-01T00:00:00.000Z" };
  it("reads revisits, status changes and credence movement, and names the cap", () => {
    const claims: RetractionClaim[] = [
      { claimId: "c1", text: "one", role: "instance", before, after: { ...before, assessmentId: "a2", status: "unsupported", credence: 0.3 } },
      { claimId: "c2", text: "two", role: "instance", before, after: before },
      { claimId: "c3", text: "three", role: "dependent", before, after: { ...before, assessmentId: "a3", credence: 0.8 } },
    ];
    const s = summarizeRetraction({ id: "s", title: "Plaga 2008" }, claims, { capped: true, stewardRuns: 2 });
    expect(s.affected).toBe(2);
    expect(s.dependents).toBe(1);
    expect(s.revisited).toBe(1);
    expect(s.dependentsRevisited).toBe(1);
    expect(s.statusChanges).toBe(1);
    expect(s.meanCredenceDelta).toBeCloseTo((-0.6 + -0.1) / 2, 3);
    expect(s.claims.find((c) => c.claimId === "c2")?.revisited).toBe(false);
    expect(s.reading).toMatch(/1 of 2 affected claims were re-assessed/);
    expect(s.reading).toMatch(/Steward cap/);
    expect(s.reading).toMatch(/no retraction path of its own/);
  });

  it("says when there is nothing to revisit", () => {
    const s = summarizeRetraction({ id: "s", title: "t" }, [], { capped: false, stewardRuns: 0 });
    expect(s.reading).toMatch(/Nothing to revisit/);
  });
});
