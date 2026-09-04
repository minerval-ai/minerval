import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

// The eval system's record, vendored into web/content/evals/ by
// scripts/sync-frontend-content.ts (#368): committed scorecards and golden
// runs, filled judge-review sheets, the fixtures, and an index of what
// production runs on. Read at the server; nothing here touches a database.
const EVALS = resolve(process.cwd(), "content", "evals");

// ---- index ----------------------------------------------------------------

export interface Rates {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface EvalsIndex {
  syncedAt: string;
  gitCommit: string | null;
  pins: Array<{ agent: string; envVar: string; model: string; label: string }>;
  judge: { model: string; label: string };
  rates: Record<string, Rates | null>;
  clusters: Array<{
    key: string;
    kind: string;
    posts: number;
    words: number;
    description: string;
    source: string;
    sources: Array<{ id: string; title: string; author?: string; url?: string; role?: string }>;
  }>;
  golden: { pairs: number; byCategory: Record<string, number>; version: string | null; description: string | null };
  predictions: {
    count: number;
    authoredAt: string | null;
    byDomain: Record<string, number>;
    firstResolution: string | null;
    lastResolution: string | null;
  };
  contributions: Array<{
    scenario: string;
    cluster: string;
    personas: number;
    contributions: number;
    byType: Record<string, number>;
    withAppeal: number;
  }>;
  reviews: Array<{ file: string; cluster: string | null; evalRun: string | null; reviewedOn: string | null }>;
  scorecards: Array<{ cluster: string; file: string }>;
  goldenRuns: string[];
  rubric: RubricSection[];
}

export interface RubricSection {
  letter: string;
  title: string;
  slug: string;
  standard: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function getEvalsIndex(): EvalsIndex {
  return readJson<EvalsIndex>(resolve(EVALS, "index.json"));
}

// ---- scorecards (mirrors scripts/corpus/score.ts, optional where older files lack a field) ----

export interface ScorecardConfig {
  pipelineEpoch: string;
  gitCommit: string | null;
  models: Record<string, string | undefined>;
  modelsSource?: "run" | "registry" | "score-time";
  profile?: string | null;
  swap?: { agent: string; model: string } | null;
  order?: string | null;
  observed?: Record<string, string[]>;
  caps?: Record<string, number>;
}

export interface JudgeItem {
  id: string;
  text: string;
  importanceStored: number;
  status: string | null;
  readability: number;
  reasoning_fit: number;
  impartiality: number;
  claim_bar: "yes" | "no";
  decomposition_granularity: string;
  importance_judged: number;
  sycophancy?: string;
  hedging?: string;
  canonical_form?: string;
  political_bias?: string;
  flags: string[];
  note: string;
}

export interface Scorecard {
  generatedAt: string;
  cluster: string;
  database: string;
  config: ScorecardConfig;
  structural: {
    extraction: { topLevelClaims: number; instances: number; totalClaims: number; claimsPer1kWords: number | null; typeDistribution: Record<string, number> };
    canonicalForm: { wordCount: { p50: number; p90: number; max: number; mean: number }; overLongShare: number };
    matching: { dedupRatio: number | null };
    decomposition: { maxDepth: number; depthHistogram: Record<string, number>; atomicShare: number; meanChildrenPerParent: number };
    crossDoc: { sharedSubclaims: number };
    assessment: { statusDistribution: Record<string, number>; pctWithTrace: number; meanTraceLength: number };
    importance: { mean: number; histogram: Record<string, number>; meanAtomic: number | null; meanCompound: number | null };
    coherence?: { violations: number; tensions: number };
    canonicalAuthorship?: {
      authoringInstances: number;
      withProposal: number;
      rewriteRate: number | null;
      rewriteMagnitude: number | null;
      meanWordDelta: number | null;
      matched: { instances: number; withProposal: number; deniesShare: number | null; meanDistance: number | null };
    };
  };
  judged: {
    model: string;
    sampleSize: number;
    claimBarPassRate: number;
    importanceAlignment: { meanStored: number; meanJudged: number; overratedShare: number };
    assessmentQuality: { readability: number; reasoningFit: number; impartiality: number };
    granularity: Record<string, number>;
    flags: Record<string, number>;
    dimensions?: Record<string, Record<string, number>>;
    sycophancyShare?: number;
    overhedgedShare?: number;
    overconfidentShare?: number;
    canonicalFormMissShare?: number;
    politicalBiasShare?: number;
    items: JudgeItem[];
  } | null;
  cost: { calls: number; usd: number } | null;
}

export interface ScorecardRecord {
  cluster: string;
  file: string;
  card: Scorecard;
}

export function getScorecards(): ScorecardRecord[] {
  const root = resolve(EVALS, "scorecards");
  if (!existsSync(root)) return [];
  const out: ScorecardRecord[] = [];
  for (const cluster of readdirSync(root).sort()) {
    const dir = resolve(root, cluster);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      out.push({ cluster, file, card: readJson<Scorecard>(resolve(dir, file)) });
    }
  }
  return out.sort((a, b) => a.card.generatedAt.localeCompare(b.card.generatedAt));
}

export function scorecardsFor(cluster: string, all = getScorecards()): ScorecardRecord[] {
  return all.filter((s) => s.cluster === cluster);
}

// The headline metrics corpus:compare bands (scripts/corpus/band.ts), so the
// page and the tool agree on what is load-bearing.
export const HEADLINE_METRICS: Array<{ label: string; get: (s: Scorecard) => number | null | undefined; format?: "pct" | "num" | "int" }> = [
  { label: "A · claims per 1k words", get: (s) => s.structural.extraction.claimsPer1kWords, format: "num" },
  { label: "B · canonical form, p90 words", get: (s) => s.structural.canonicalForm.wordCount.p90, format: "int" },
  { label: "B · share over 25 words", get: (s) => s.structural.canonicalForm.overLongShare, format: "pct" },
  { label: "C · dedup ratio", get: (s) => s.structural.matching.dedupRatio, format: "num" },
  { label: "D · max depth", get: (s) => s.structural.decomposition.maxDepth, format: "int" },
  { label: "D · atomic share", get: (s) => s.structural.decomposition.atomicShare, format: "pct" },
  { label: "E · shared subclaims", get: (s) => s.structural.crossDoc.sharedSubclaims, format: "int" },
  { label: "F · assessments with a trace", get: (s) => s.structural.assessment.pctWithTrace, format: "pct" },
  { label: "§21 · coherence violations", get: (s) => s.structural.coherence?.violations, format: "int" },
  { label: "B · Matcher rewrite rate", get: (s) => s.structural.canonicalAuthorship?.rewriteRate, format: "pct" },
  { label: "B · rewrite magnitude", get: (s) => s.structural.canonicalAuthorship?.rewriteMagnitude, format: "num" },
  { label: "C · matched denies share", get: (s) => s.structural.canonicalAuthorship?.matched.deniesShare, format: "pct" },
  { label: "importance · mean", get: (s) => s.structural.importance.mean, format: "num" },
  { label: "judge · claim-bar pass rate", get: (s) => s.judged?.claimBarPassRate, format: "pct" },
  { label: "judge · importance overrated share", get: (s) => s.judged?.importanceAlignment.overratedShare, format: "pct" },
  { label: "judge · readability (1–5)", get: (s) => s.judged?.assessmentQuality.readability, format: "num" },
  { label: "judge · reasoning fit (1–5)", get: (s) => s.judged?.assessmentQuality.reasoningFit, format: "num" },
  { label: "judge · impartiality (1–5)", get: (s) => s.judged?.assessmentQuality.impartiality, format: "num" },
  { label: "judge · sycophancy share", get: (s) => s.judged?.sycophancyShare, format: "pct" },
  { label: "judge · overhedged share", get: (s) => s.judged?.overhedgedShare, format: "pct" },
  { label: "judge · overconfident share", get: (s) => s.judged?.overconfidentShare, format: "pct" },
  { label: "judge · canonical-form miss share", get: (s) => s.judged?.canonicalFormMissShare, format: "pct" },
  { label: "judge · political bias share", get: (s) => s.judged?.politicalBiasShare, format: "pct" },
];

/** Mean and sample spread over a group of runs (the noise band, scripts/corpus/band.ts). */
export function bandStat(values: number[]): { n: number; mean: number | null; sd: number | null } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return { n: 0, mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { n: xs.length, mean, sd: null };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return { n: xs.length, mean, sd };
}

export function formatMetric(v: number | null | undefined, format: "pct" | "num" | "int" = "num"): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  if (format === "pct") return `${Math.round(v * 100)}%`;
  if (format === "int") return String(Math.round(v));
  return (Math.round(v * 100) / 100).toString();
}

/** The judge's weakest verdicts: lowest combined 1–5 scores, most flags first on ties. */
export function lowestScoring(items: JudgeItem[], n = 5): JudgeItem[] {
  const score = (i: JudgeItem) => i.readability + i.reasoning_fit + i.impartiality;
  return [...items].sort((a, b) => score(a) - score(b) || b.flags.length - a.flags.length).slice(0, n);
}

// ---- golden runs -----------------------------------------------------------

export interface GoldenRun {
  file: string;
  generatedAt: string;
  matcherModel: string;
  note?: string;
  summary: { total: number; passed: number; passRate: number; byCategory: Record<string, { total: number; passed: number }> };
  costMicroUsd?: number;
  results: Array<{ id: string; category: string; pass: boolean; failures: string[] }>;
}

export function getGoldenRuns(): GoldenRun[] {
  const dir = resolve(EVALS, "golden-runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...readJson<Omit<GoldenRun, "file">>(resolve(dir, file)) }))
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

export interface GoldenPair {
  id: string;
  category: string;
  existing: string[];
  candidate: { extractedText: string; proposedCanonical: string };
  expect: { isMatch: boolean; matchedIndex?: number; stance?: string };
  note: string;
}

export function getGoldenPairs(): { version: string | number; description: string; pairs: GoldenPair[] } {
  return readJson(resolve(EVALS, "golden-pairs.json"));
}

// ---- review sheets ---------------------------------------------------------

export interface ReviewSheet {
  file: string;
  cluster: string | null;
  evalRun: string | null;
  reviewedOn: string | null;
  /** The `## Overall` block: the feedback on the task, which is the review's real output. */
  overall: string | null;
}

export function getReviews(index = getEvalsIndex()): ReviewSheet[] {
  return index.reviews.map((r) => {
    const text = readFileSync(resolve(EVALS, "reviews", r.file), "utf-8");
    const m = /```overall\n([\s\S]*?)```/.exec(text);
    return { ...r, overall: m ? m[1].trim() : null };
  });
}

// ---- predictions and contributions ----------------------------------------

export interface Prediction {
  id: string;
  claim: string;
  resolutionCriterion: string;
  resolutionDate: string;
  operationalization: string;
  domain: string;
  notes?: string;
}

export function getPredictions(): { authoredAt?: string; description?: string; predictions: Prediction[] } {
  return readJson(resolve(EVALS, "predictions.json"));
}

export interface ContributionScenario {
  scenario: string;
  cluster: string;
  description: string;
  contributors: Array<{ key: string; displayName: string; note: string }>;
  contributions: Array<{ id: string; type: string; contributor: string; expect?: string; appealIfRejected?: string }>;
}

export function getContributionScenarios(): ContributionScenario[] {
  const dir = resolve(EVALS, "contributions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<ContributionScenario>(resolve(dir, f)));
}

// ---- formatting helpers ----------------------------------------------------

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "n/a";
  return iso.slice(0, 10);
}

export function fmtUsd(usd: number | null | undefined, digits = 2): string {
  if (usd == null || !Number.isFinite(usd)) return "n/a";
  return `$${usd.toFixed(digits)}`;
}

export function microToUsd(micro: number | null | undefined): number | null {
  return micro == null ? null : micro / 1_000_000;
}

// ---- everything the guide renders from, loaded once per page ---------------

export interface JudgeSchemaProperty {
  type?: string;
  enum?: string[];
  description?: string;
  items?: { enum?: string[] };
}

/** The exact texts the evals run with, vendored by the sync so the guide shows them verbatim. */
export interface EvalsArtifacts {
  judgePrompt: string;
  judgeStandards: string;
  judgeSchema: { properties: Record<string, JudgeSchemaProperty>; required?: string[] };
  pairJudge: { prompt: string; schema: unknown };
  rubric: string;
  scoring: string;
  /** Filled review sheets, by file name. */
  reviewSheets: Record<string, string>;
}

export interface EvalsData {
  index: EvalsIndex;
  artifacts: EvalsArtifacts;
  scorecards: ScorecardRecord[];
  goldenRuns: GoldenRun[];
  goldenPairs: GoldenPair[];
  reviews: ReviewSheet[];
  predictions: Prediction[];
  scenarios: ContributionScenario[];
}

export function loadEvalsData(): EvalsData {
  const index = getEvalsIndex();
  const text = (f: string) => readFileSync(resolve(EVALS, f), "utf-8");
  const reviewSheets: Record<string, string> = {};
  for (const r of index.reviews) reviewSheets[r.file] = text(`reviews/${r.file}`);
  return {
    index,
    artifacts: {
      judgePrompt: text("judge-prompt.md"),
      judgeStandards: text("judge-standards.md"),
      judgeSchema: readJson(resolve(EVALS, "judge-schema.json")),
      pairJudge: readJson(resolve(EVALS, "pair-judge.json")),
      rubric: text("rubric.md"),
      scoring: text("scoring.md"),
      reviewSheets,
    },
    scorecards: getScorecards(),
    goldenRuns: getGoldenRuns(),
    goldenPairs: getGoldenPairs().pairs,
    reviews: getReviews(index),
    predictions: getPredictions().predictions,
    scenarios: getContributionScenarios(),
  };
}
