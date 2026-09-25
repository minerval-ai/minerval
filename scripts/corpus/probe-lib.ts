/**
 * Downstream-reasoner probe (#334 S5, from #288) — the pure half.
 *
 * Does the graph's confidence survive contact with a reasoner? A reasoner
 * asked a question with the graph's record in front of it should (a) cite
 * the record, (b) hold a confidence that tracks the credences of the claims
 * it cites, and (c) not contradict a verified or contradicted claim it was
 * shown. Compared against the same reasoner answering from its own
 * knowledge, the probe shows whether the record moves the reasoner at all,
 * and in which direction.
 *
 * DIAGNOSTIC ONLY. Nothing here is a scoring rule: a reasoner's confidence
 * is not ground truth for the graph, and a gap between them can be the
 * reasoner's fault as easily as the graph's. The probe produces readings a
 * person interprets, never a gate (#288; #286's non-goals).
 *
 * Fixture loading/validation, the per-question grading and the summaries
 * live here with no DB or LLM dependency; probe.ts owns retrieval, the
 * reasoner calls and the retraction drain.
 */
import { readFileSync } from "node:fs";
import type { ContextClaim, ProbeAnswerWithGraph, ProbeAnswerWithoutGraph } from "./probe-prompts.js";
import { shortId } from "./probe-prompts.js";

export const PROBE_QUESTION_KINDS = ["factual", "comparative", "crux", "confidence"] as const;
export type ProbeQuestionKind = (typeof PROBE_QUESTION_KINDS)[number];

export interface ProbeQuestion {
  id: string;
  kind: ProbeQuestionKind;
  question: string;
  /** Why this question is in the set — what a reasoner is likely to be asked here. */
  note?: string;
}

export interface ProbeFixture {
  cluster: string;
  description: string;
  questions: ProbeQuestion[];
}

export function loadProbeFixture(path: string): ProbeFixture {
  return JSON.parse(readFileSync(path, "utf-8")) as ProbeFixture;
}

export function validateProbeFixture(fixture: ProbeFixture): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!fixture.cluster) problems.push("fixture is missing its cluster");
  for (const q of fixture.questions ?? []) {
    const where = `question "${q.id ?? "?"}"`;
    if (!q.id) problems.push("a question is missing an id");
    else if (ids.has(q.id)) problems.push(`duplicate id "${q.id}"`);
    else ids.add(q.id);
    if (!PROBE_QUESTION_KINDS.includes(q.kind)) problems.push(`${where}: unknown kind "${q.kind}"`);
    if (!q.question || q.question.trim().length < 10) problems.push(`${where}: question too short`);
  }
  const n = fixture.questions?.length ?? 0;
  if (n < 8 || n > 12) problems.push(`fixture has ${n} questions; the probe wants 8–12`);
  return problems;
}

// --- per-question grading ----------------------------------------------------

export interface CitedClaim {
  id: string;
  shortId: string;
  usedAs: "true" | "false" | "uncertain";
  status: string | null;
  credence: number | null;
  /** True when the cited id matched nothing in the record the reasoner was shown. */
  unknown: boolean;
  /** The claim was verified and used as false, or contradicted and used as true. */
  contradiction: boolean;
}

export interface ProbeQuestionResult {
  id: string;
  kind: ProbeQuestionKind;
  question: string;
  /** How many claims the record held. */
  contextSize: number;
  withGraph: { confidence: number; answer: string };
  withoutGraph: { confidence: number; answer: string };
  /** confidence with the graph − confidence without it. */
  confidenceShift: number;
  cited: CitedClaim[];
  citedAny: boolean;
  citedUnknown: number;
  /**
   * Mean credence of the cited claims, read in the direction the answer used
   * them (a claim used as false contributes 1 − credence); null when no cited
   * claim carries a credence.
   */
  meanCitedCredence: number | null;
  /** |with-graph confidence − meanCitedCredence|; null when the latter is null. */
  credenceGap: number | null;
  /** Cited claims whose status the answer contradicts. */
  contradictions: number;
}

/**
 * Resolve the reasoner's citations against the record it was shown (by
 * bracketed short id, tolerating a full id or surrounding brackets), and
 * grade the answer pair.
 */
export function gradeProbeQuestion(
  q: ProbeQuestion,
  context: ContextClaim[],
  withGraph: ProbeAnswerWithGraph,
  withoutGraph: ProbeAnswerWithoutGraph
): ProbeQuestionResult {
  const byShort = new Map(context.map((c) => [shortId(c.id), c]));
  const cited: CitedClaim[] = [];
  for (const cit of withGraph.cited_claims ?? []) {
    const raw = String(cit.id ?? "").replace(/[[\]\s]/g, "");
    const key = raw.slice(0, 8);
    const claim = byShort.get(key) ?? context.find((c) => c.id === raw) ?? null;
    const usedAs = cit.used_as === "false" || cit.used_as === "uncertain" ? cit.used_as : "true";
    const status = claim?.status ?? null;
    const contradiction =
      claim !== null &&
      ((status === "verified" && usedAs === "false") || (status === "contradicted" && usedAs === "true"));
    cited.push({
      id: claim?.id ?? raw,
      shortId: key,
      usedAs,
      status,
      credence: claim?.credence ?? null,
      unknown: claim === null,
      contradiction,
    });
  }
  const directed = cited
    .filter((c) => !c.unknown && c.credence !== null && c.usedAs !== "uncertain")
    .map((c) => (c.usedAs === "false" ? 1 - c.credence! : c.credence!));
  const meanCitedCredence = directed.length ? directed.reduce((a, b) => a + b, 0) / directed.length : null;
  const conf = clamp01(withGraph.confidence);
  const confWithout = clamp01(withoutGraph.confidence);
  return {
    id: q.id,
    kind: q.kind,
    question: q.question,
    contextSize: context.length,
    withGraph: { confidence: conf, answer: withGraph.answer },
    withoutGraph: { confidence: confWithout, answer: withoutGraph.answer },
    confidenceShift: round(conf - confWithout),
    cited,
    citedAny: cited.some((c) => !c.unknown),
    citedUnknown: cited.filter((c) => c.unknown).length,
    meanCitedCredence: meanCitedCredence === null ? null : round(meanCitedCredence),
    credenceGap: meanCitedCredence === null ? null : round(Math.abs(conf - meanCitedCredence)),
    contradictions: cited.filter((c) => c.contradiction).length,
  };
}

function clamp01(x: unknown): number {
  const n = typeof x === "number" && Number.isFinite(x) ? x : 0;
  return Math.max(0, Math.min(1, n));
}
const round = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// --- summary -----------------------------------------------------------------

export interface ProbeSummary {
  cluster: string;
  model: string;
  questions: number;
  meanConfidenceWith: number | null;
  meanConfidenceWithout: number | null;
  meanConfidenceShift: number | null;
  /** Share of questions where the with-graph answer cited at least one record claim. */
  citationRate: number;
  /** Mean |confidence − mean cited credence| over questions that cited a claim with a credence. */
  meanCredenceGap: number | null;
  /** Questions whose gap exceeded 0.25 (a threshold for the reading, not a rule). */
  looseTracking: number;
  contradictions: number;
  citedUnknown: number;
  byKind: Record<string, { n: number; meanShift: number | null; meanGap: number | null }>;
  /** Plain-language reading, with the diagnostic-only caveat. */
  reading: string;
}

export const GAP_LOOSE = 0.25;

export function summarizeProbe(cluster: string, model: string, results: ProbeQuestionResult[]): ProbeSummary {
  const n = results.length;
  const gaps = results.map((r) => r.credenceGap).filter((g): g is number => g !== null);
  const byKind: ProbeSummary["byKind"] = {};
  for (const kind of new Set(results.map((r) => r.kind))) {
    const rs = results.filter((r) => r.kind === kind);
    const kg = rs.map((r) => r.credenceGap).filter((g): g is number => g !== null);
    byKind[kind] = {
      n: rs.length,
      meanShift: rnd(mean(rs.map((r) => r.confidenceShift))),
      meanGap: rnd(mean(kg)),
    };
  }
  const citationRate = n ? round(results.filter((r) => r.citedAny).length / n) : 0;
  const meanGap = rnd(mean(gaps));
  const contradictions = results.reduce((a, r) => a + r.contradictions, 0);
  const shift = rnd(mean(results.map((r) => r.confidenceShift)));
  const looseTracking = gaps.filter((g) => g > GAP_LOOSE).length;

  const parts: string[] = [];
  if (n === 0) parts.push("no questions ran.");
  else {
    parts.push(
      `Over ${n} questions the reasoner's stated confidence was ${fmtNum(rnd(mean(results.map((r) => r.withGraph.confidence))))} with the record and ${fmtNum(rnd(mean(results.map((r) => r.withoutGraph.confidence))))} without it` +
        (shift === null ? "." : shift > 0.05 ? " — the record made it more confident." : shift < -0.05 ? " — the record made it less confident." : " — the record barely moved it.")
    );
    if (citationRate < 1) parts.push(`It cited record claims on ${Math.round(citationRate * 100)}% of questions; the rest were answered past the record.`);
    else parts.push("It cited record claims on every question.");
    if (meanGap !== null) {
      parts.push(
        `Where it cited claims with credences, its confidence sat on average ${fmtNum(meanGap)} from their credences` +
          (looseTracking > 0 ? ` (${looseTracking} question(s) more than ${GAP_LOOSE} away — its confidence was not following the record's).` : " — it was tracking the record.")
      );
    } else parts.push("No cited claim carried a credence, so tracking could not be read.");
    if (contradictions > 0) parts.push(`${contradictions} citation(s) used a verified claim as false or a contradicted claim as true.`);
    else parts.push("No cited verified or contradicted claim was used against its status.");
  }
  parts.push("Diagnostic only: a reasoner's confidence is not ground truth for the graph, and none of this is a scoring rule.");

  return {
    cluster,
    model,
    questions: n,
    meanConfidenceWith: rnd(mean(results.map((r) => r.withGraph.confidence))),
    meanConfidenceWithout: rnd(mean(results.map((r) => r.withoutGraph.confidence))),
    meanConfidenceShift: shift,
    citationRate,
    meanCredenceGap: meanGap,
    looseTracking,
    contradictions,
    citedUnknown: results.reduce((a, r) => a + r.citedUnknown, 0),
    byKind,
    reading: parts.join(" "),
  };
}

const rnd = (x: number | null) => (x === null ? null : round(x));
const fmtNum = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

// --- retraction probe ----------------------------------------------------------

export interface AssessmentSnap {
  assessmentId: string;
  status: string;
  confidence: number;
  credence: number | null;
  assessedAt: string;
}

export interface RetractionClaim {
  claimId: string;
  text: string;
  /** "instance": had an instance from the retracted source; "dependent": a parent of one. */
  role: "instance" | "dependent";
  before: AssessmentSnap | null;
  after: AssessmentSnap | null;
}

export interface RetractionClaimReading extends RetractionClaim {
  /** A new current assessment row landed after the trigger. */
  revisited: boolean;
  statusChanged: boolean;
  credenceDelta: number | null;
}

export interface RetractionSummary {
  source: { id: string; title: string };
  affected: number;
  dependents: number;
  revisited: number;
  dependentsRevisited: number;
  statusChanges: number;
  meanCredenceDelta: number | null;
  claims: RetractionClaimReading[];
  reading: string;
}

export function summarizeRetraction(
  source: { id: string; title: string },
  claims: RetractionClaim[],
  drain: { capped: boolean; stewardRuns: number }
): RetractionSummary {
  const readings: RetractionClaimReading[] = claims.map((c) => {
    const revisited = c.after !== null && (c.before === null || c.after.assessmentId !== c.before.assessmentId);
    const statusChanged = revisited && c.before !== null && c.after !== null && c.before.status !== c.after.status;
    const credenceDelta =
      revisited && c.before?.credence != null && c.after?.credence != null ? round(c.after.credence - c.before.credence) : null;
    return { ...c, revisited, statusChanged, credenceDelta };
  });
  const instances = readings.filter((r) => r.role === "instance");
  const dependents = readings.filter((r) => r.role === "dependent");
  const revisited = instances.filter((r) => r.revisited).length;
  const dependentsRevisited = dependents.filter((r) => r.revisited).length;
  const statusChanges = readings.filter((r) => r.statusChanged).length;
  const deltas = readings.map((r) => r.credenceDelta).filter((d): d is number => d !== null);
  const meanDelta = rnd(mean(deltas));

  const parts: string[] = [];
  parts.push(`Retracting "${source.title}" touched ${instances.length} claim(s) with an instance from it and ${dependents.length} dependent parent claim(s).`);
  if (instances.length === 0) parts.push("Nothing to revisit.");
  else {
    parts.push(
      `${revisited} of ${instances.length} affected claims were re-assessed after the flag` +
        (dependents.length ? `; ${dependentsRevisited} of ${dependents.length} dependents were.` : ".")
    );
    if (statusChanges > 0) parts.push(`${statusChanges} status(es) changed.`);
    if (meanDelta !== null) {
      parts.push(
        `Credence moved by ${meanDelta > 0 ? "+" : ""}${meanDelta.toFixed(3)} on average over ${deltas.length} re-assessed claim(s) with a credence on both sides` +
          (Math.abs(meanDelta) < 0.02 ? " — the retraction barely moved the numbers." : ".")
      );
    } else if (revisited > 0) parts.push("No re-assessed claim carried a credence on both sides, so credence movement could not be read.");
    if (revisited < instances.length) {
      parts.push(
        drain.capped
          ? `The drain hit its Steward cap (${drain.stewardRuns} run(s)), so some claims never got their turn — raise STEWARD_MAX_RUNS before reading the unrevisited ones as ignored.`
          : "The unrevisited claims were flagged and drained without a new assessment landing — read their traces."
      );
    }
  }
  parts.push("The system has no retraction path of its own; this simulated one by flagging the affected Stewards. Diagnostic only.");
  return {
    source,
    affected: instances.length,
    dependents: dependents.length,
    revisited,
    dependentsRevisited,
    statusChanges,
    meanCredenceDelta: meanDelta,
    claims: readings,
    reading: parts.join(" "),
  };
}
