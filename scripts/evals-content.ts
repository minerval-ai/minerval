/**
 * The evals index that the public evals page (#368) renders from: the facts
 * about the eval system that are true at sync time and would otherwise rot
 * into the page's copy. Pure, so it is unit-tested; scripts/sync-frontend-
 * content.ts gathers the inputs from the repo and writes the result to
 * web/content/evals/index.json next to the vendored scorecards, review
 * sheets and fixtures.
 *
 * What lives here is what an operator could get wrong by hand: which model
 * each agent runs on in production and at what list price, the judge's
 * default, the size of every cluster, the composition of every fixture, and
 * which committed run records exist. The prose of the page lives in the
 * page; the numbers on it come from here.
 */

export interface PinInput {
  envVar: string;
  model: string;
}

export interface Rates {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface ClusterInput {
  key: string;
  kind: string;
  description: string;
  source: string;
  posts: Array<{ id: string; title: string; author?: string; url?: string; role?: string }>;
  /** Word count over the committed post markdown. */
  words: number;
}

export interface GoldenFixtureInput {
  version?: string | number;
  description?: string;
  pairs: Array<{ id: string; category: string }>;
}

export interface PredictionsInput {
  authoredAt?: string;
  predictions: Array<{ id: string; domain: string; resolutionDate: string }>;
}

export interface ContributionScenarioInput {
  scenario: string;
  cluster: string;
  contributors: Array<{ key: string }>;
  contributions: Array<{ type: string; appealIfRejected?: string }>;
}

export interface ReviewSheetInput {
  file: string;
  text: string;
}

export interface EvalsIndexInput {
  syncedAt: string;
  gitCommit: string | null;
  pins: PinInput[];
  judgeModel: string;
  /** Rates per model id; null for models the pricing table does not carry (provider-priced). */
  ratesFor: (model: string) => Rates | null;
  clusters: ClusterInput[];
  golden: GoldenFixtureInput;
  predictions: PredictionsInput;
  contributions: ContributionScenarioInput[];
  reviews: ReviewSheetInput[];
  scorecardFiles: Array<{ cluster: string; file: string }>;
  goldenRunFiles: string[];
}

export interface EvalsIndex {
  syncedAt: string;
  gitCommit: string | null;
  /** Production pins from the CDK task definition, one per agent that has one. */
  pins: Array<{ agent: string; envVar: string; model: string; label: string }>;
  judge: { model: string; label: string };
  /** List rates for every model on the page; null where the provider reports its own cost. */
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
}

/** Display names for the model ids the system pins; anything else shows its id. */
const MODEL_LABELS: Array<[prefix: string, label: string]> = [
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-fable-5", "Claude Fable 5"],
  ["claude-mythos-5", "Claude Mythos 5"],
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["gpt-5", "GPT-5"],
];

export function modelLabel(model: string): string {
  let best: [string, string] | null = null;
  for (const entry of MODEL_LABELS) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : model;
}

/** STEWARD_MODEL → steward, EXTRACTOR_FALLBACK_MODEL → extractor fallback. */
export function agentOfEnvVar(envVar: string): string {
  return envVar
    .replace(/_MODEL$/, "")
    .toLowerCase()
    .replace(/_/g, " ");
}

function count<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Pull the cluster, run id and review date out of a filled review sheet. */
export function parseReviewSheet(file: string, text: string): EvalsIndex["reviews"][number] {
  const cluster = /^# Judge-review sheet — (\S+)/m.exec(text)?.[1] ?? null;
  const evalRun = /^eval_run:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const reviewedOn = /Reviewed (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  return { file, cluster, evalRun, reviewedOn };
}

export function buildEvalsIndex(input: EvalsIndexInput): EvalsIndex {
  const pins = input.pins.map((p) => ({
    agent: agentOfEnvVar(p.envVar),
    envVar: p.envVar,
    model: p.model,
    label: modelLabel(p.model),
  }));

  const rates: Record<string, Rates | null> = {};
  for (const model of [...pins.map((p) => p.model), input.judgeModel]) {
    if (!(model in rates)) rates[model] = input.ratesFor(model);
  }

  const dates = input.predictions.predictions.map((p) => p.resolutionDate).sort();

  return {
    syncedAt: input.syncedAt,
    gitCommit: input.gitCommit,
    pins,
    judge: { model: input.judgeModel, label: modelLabel(input.judgeModel) },
    rates,
    clusters: input.clusters.map((c) => ({
      key: c.key,
      kind: c.kind,
      posts: c.posts.length,
      words: c.words,
      description: c.description,
      source: c.source,
      sources: c.posts.map((p) => ({ id: p.id, title: p.title, author: p.author, url: p.url, role: p.role })),
    })),
    golden: {
      pairs: input.golden.pairs.length,
      byCategory: count(input.golden.pairs, (p) => p.category),
      version: input.golden.version == null ? null : String(input.golden.version),
      description: input.golden.description ?? null,
    },
    predictions: {
      count: input.predictions.predictions.length,
      authoredAt: input.predictions.authoredAt ?? null,
      byDomain: count(input.predictions.predictions, (p) => p.domain),
      firstResolution: dates[0] ?? null,
      lastResolution: dates[dates.length - 1] ?? null,
    },
    contributions: input.contributions.map((s) => ({
      scenario: s.scenario,
      cluster: s.cluster,
      personas: s.contributors.length,
      contributions: s.contributions.length,
      byType: count(s.contributions, (c) => c.type),
      withAppeal: s.contributions.filter((c) => Boolean(c.appealIfRejected)).length,
    })),
    reviews: input.reviews.map((r) => parseReviewSheet(r.file, r.text)),
    scorecards: [...input.scorecardFiles].sort((a, b) =>
      a.cluster === b.cluster ? a.file.localeCompare(b.file) : a.cluster.localeCompare(b.cluster)
    ),
    goldenRuns: [...input.goldenRunFiles].sort(),
  };
}
