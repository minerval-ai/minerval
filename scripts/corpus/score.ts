/**
 * Corpus-run SCORECARD (#99) — the automated counterpart to report.md.
 *
 * Where report.md is a legibility surface a human reads against RUBRIC.md, this
 * emits scored, diffable numbers: free structural metrics for every RUBRIC
 * dimension, plus a bounded LLM-judge sample that scores the two dimensions the
 * rubric under-weights — the claim-bar pass-rate on generated subclaims
 * (over-decomposition, #98) and importance-vs-contestability alignment (#68).
 *
 * Reads the isolated corpus DB the same way report.ts does. Writes
 * runs/<run>/scorecard.json (+ scorecard.md). `corpus:compare A B` diffs two.
 *
 * Usage:
 *   tsx scripts/corpus/score.ts [cluster] [--sample=N] [--no-judge] [--out=DIR]
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCorpusDb, RUNS_ROOT, SCORECARDS_ROOT } from "./lib.js";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { getSessionUsage } from "../../src/llm/budget-tracker.js";
import { withCostMeter } from "../../src/llm/usage-context.js";
import { loadConfig } from "../../src/config.js";
import { computeStructuralMetrics, type GraphSnapshot, type StructuralMetrics } from "./metrics.js";
import { judgeClaim, type JudgeInput, type JudgeVerdict } from "./judge.js";

const DEFAULT_SAMPLE = 15;

/**
 * The run's configuration fingerprint, embedded so a scorecard in the
 * committed history (corpus/scorecards/) stays interpretable on its own: which
 * epoch and prompts produced this graph, which models ran the agents, which
 * commit of the repo. Comparisons only mean something within a fingerprint —
 * across epochs they are cross-cohort comparisons (docs/graph-epochs.md).
 */
interface ScorecardConfig {
  pipelineEpoch: string;
  gitCommit: string | null;
  models: { steward: string; curator: string; matcher: string; judge: string };
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

interface JudgedSummary {
  model: string;
  sampleSize: number;
  claimBarPassRate: number;
  importanceAlignment: { meanStored: number; meanJudged: number; overratedShare: number };
  assessmentQuality: { readability: number; reasoningFit: number; impartiality: number };
  granularity: Record<string, number>;
  flags: Record<string, number>;
  items: JudgeVerdict[];
}

export interface Scorecard {
  generatedAt: string;
  cluster: string;
  database: string;
  config: ScorecardConfig;
  structural: StructuralMetrics;
  judged: JudgedSummary | null;
  cost: { calls: number; usd: number } | null;
}

async function loadSnapshot(): Promise<GraphSnapshot> {
  const claims = await rawQuery<{
    id: string;
    text: string;
    claim_type: string;
    importance: number;
    created_by: string;
  }>(`SELECT id, text, claim_type, importance, created_by FROM claims`);

  const edges = await rawQuery<{ parent: string; child: string; rel: string }>(
    `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel FROM claim_relationships`
  );

  const assessments = await rawQuery<{
    claimId: string;
    status: string;
    confidence: number;
    reasoningTrace: string;
  }>(
    `SELECT claim_id AS "claimId", status, confidence, reasoning_trace AS "reasoningTrace"
     FROM assessments WHERE is_current`
  );

  const instances = await rawQuery<{ claimId: string }>(
    `SELECT claim_id AS "claimId" FROM claim_instances`
  );

  const [words] = await rawQuery<{ n: number }>(
    // rough word count across ingested source bodies
    `SELECT COALESCE(SUM(array_length(regexp_split_to_array(trim(raw_content), '\\s+'), 1)), 0)::int AS n
     FROM sources WHERE raw_content IS NOT NULL`
  );

  return {
    claims: claims.map((c) => ({
      id: c.id,
      text: c.text,
      claimType: c.claim_type,
      importance: c.importance,
      createdBy: c.created_by,
    })),
    edges,
    assessments,
    instances,
    sourceWords: words?.n ?? 0,
  };
}

/**
 * Pick which claims to judge. Prioritize assessed claims (so readability /
 * reasoning-fit apply), and deliberately mix atomic and compound claims so the
 * claim-bar and granularity signals cover both. Deterministic ordering (by id)
 * so a re-score of the same graph judges the same sample.
 */
function pickSample(g: GraphSnapshot, n: number): JudgeInput[] {
  const childrenOf = new Map<string, Array<{ child: string; rel: string }>>();
  for (const e of g.edges) {
    (childrenOf.get(e.parent) ?? childrenOf.set(e.parent, []).get(e.parent)!).push({
      child: e.child,
      rel: e.rel,
    });
  }
  const textOf = new Map(g.claims.map((c) => [c.id, c.text]));
  const currentAssessment = new Map(g.assessments.map((a) => [a.claimId, a]));
  const statusOf = new Map(g.assessments.map((a) => [a.claimId, a.status]));

  const toInput = (c: GraphSnapshot["claims"][number]): JudgeInput => {
    const a = currentAssessment.get(c.id);
    const kids = childrenOf.get(c.id) ?? [];
    return {
      id: c.id,
      text: c.text,
      claimType: c.claimType,
      importance: c.importance,
      status: a?.status ?? null,
      confidence: a?.confidence ?? null,
      reasoningTrace: a?.reasoningTrace ?? null,
      subclaims: kids.map((k) => ({
        relation: k.rel,
        text: textOf.get(k.child) ?? "(unknown)",
        status: statusOf.get(k.child) ?? null,
      })),
    };
  };

  const sorted = [...g.claims].sort((a, b) => a.id.localeCompare(b.id));
  const assessed = sorted.filter((c) => currentAssessment.has(c.id));
  const compound = assessed.filter((c) => (childrenOf.get(c.id)?.length ?? 0) > 0);
  const atomic = assessed.filter((c) => (childrenOf.get(c.id)?.length ?? 0) === 0);

  // interleave compound/atomic so the sample isn't all one kind
  const picked: GraphSnapshot["claims"] = [];
  let i = 0;
  while (picked.length < n && (i < compound.length || i < atomic.length)) {
    if (i < compound.length) picked.push(compound[i]!);
    if (picked.length < n && i < atomic.length) picked.push(atomic[i]!);
    i++;
  }
  // top up from any assessed if still short, then from unassessed as a last resort
  for (const c of assessed) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.slice(0, n).map(toInput);
}

async function judgeSample(inputs: JudgeInput[], concurrency = 3): Promise<JudgeVerdict[]> {
  const out: JudgeVerdict[] = [];
  let idx = 0;
  async function worker() {
    while (idx < inputs.length) {
      const mine = inputs[idx++]!;
      try {
        out.push(await judgeClaim(mine));
      } catch (err) {
        // A judge failure shouldn't sink the whole scorecard; skip the item.
        console.error(`  judge failed for ${mine.id.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return out;
}

function summarizeJudged(model: string, verdicts: JudgeVerdict[]): JudgedSummary {
  const n = verdicts.length || 1;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round = (x: number) => Math.round(x * 100) / 100;

  const passed = verdicts.filter((v) => v.claim_bar === "yes").length;
  const stored = verdicts.map((v) => v.importanceStored);
  const judged = verdicts.map((v) => v.importance_judged);
  const overrated = verdicts.filter((v) => v.importanceStored - v.importance_judged > 0.2).length;

  const granularity: Record<string, number> = {};
  const flags: Record<string, number> = {};
  for (const v of verdicts) {
    granularity[v.decomposition_granularity] = (granularity[v.decomposition_granularity] ?? 0) + 1;
    for (const f of v.flags) flags[f] = (flags[f] ?? 0) + 1;
  }

  return {
    model,
    sampleSize: verdicts.length,
    claimBarPassRate: round(passed / n),
    importanceAlignment: {
      meanStored: round(mean(stored)),
      meanJudged: round(mean(judged)),
      overratedShare: round(overrated / n),
    },
    assessmentQuality: {
      readability: round(mean(verdicts.map((v) => v.readability))),
      reasoningFit: round(mean(verdicts.map((v) => v.reasoning_fit))),
      impartiality: round(mean(verdicts.map((v) => v.impartiality))),
    },
    granularity,
    flags,
    items: verdicts,
  };
}

export async function scoreRun(
  cluster: string,
  opts: { sample?: number; judge?: boolean; outDir?: string } = {}
): Promise<{ scorecard: Scorecard; dir: string; judgeCostMicroUsd: number }> {
  assertCorpusDb();
  const sample = opts.sample ?? DEFAULT_SAMPLE;
  const doJudge = opts.judge ?? true;
  const cfg = loadConfig();

  const snapshot = await loadSnapshot();
  const structural = computeStructuralMetrics(snapshot);

  let judged: JudgedSummary | null = null;
  let cost: Scorecard["cost"] = null;
  let judgeCostMicroUsd = 0;
  if (doJudge && sample > 0) {
    const before = getSessionUsage();
    const inputs = pickSample(snapshot, sample);
    console.log(`  judging ${inputs.length} claims with ${cfg.judgeModel}…`);
    // The cost meter is fed synchronously per call at the metering chokepoint,
    // so this is the judge's exact metered cost (raw rates, whatever model
    // actually served each call) — not a session-total diff priced by hand.
    const { value: verdicts, billedMicroUsd } = await withCostMeter(() => judgeSample(inputs));
    judged = summarizeJudged(cfg.judgeModel, verdicts);
    judgeCostMicroUsd = billedMicroUsd;
    cost = {
      calls: getSessionUsage().calls - before.calls,
      usd: Math.round(billedMicroUsd / 10_000) / 100, // micro-USD → USD, 2 dp
    };
  }

  const scorecard: Scorecard = {
    generatedAt: new Date().toISOString(),
    cluster,
    database: new URL(process.env.DATABASE_URL!).pathname.slice(1),
    config: {
      pipelineEpoch: cfg.pipelineEpoch,
      gitCommit: gitCommit(),
      models: {
        steward: cfg.stewardModel,
        curator: cfg.curatorModel,
        matcher: cfg.matcherModel,
        judge: cfg.judgeModel,
      },
    },
    structural,
    judged,
    cost,
  };

  const stamp = scorecard.generatedAt.replace(/[:.]/g, "-");
  const dir = opts.outDir ?? join(RUNS_ROOT, `${cluster}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
  writeFileSync(join(dir, "scorecard.md"), renderMarkdown(scorecard));

  // Also file the scorecard into the committed history (corpus/scorecards/),
  // since runs/ is gitignored — this is where baselines and regression history
  // live until the eval-run registry (#334 L1) replaces files with a table.
  const historyDir = join(SCORECARDS_ROOT, cluster);
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${stamp}.json`), JSON.stringify(scorecard, null, 2));

  return { scorecard, dir, judgeCostMicroUsd };
}

function renderMarkdown(s: Scorecard): string {
  const o: string[] = [];
  const w = (l = "") => o.push(l);
  const st = s.structural;
  w(`# Corpus run scorecard — ${s.cluster}`);
  w();
  w(`_generated ${s.generatedAt} · database \`${s.database}\`_`);
  w(
    `_epoch \`${s.config.pipelineEpoch}\` · commit \`${s.config.gitCommit ?? "?"}\` · ` +
      `steward \`${s.config.models.steward}\` · matcher \`${s.config.models.matcher}\` · ` +
      `judge \`${s.config.models.judge}\`_`
  );
  w();
  w(`Scored, diffable counterpart to \`report.md\`. Structural metrics are free;`);
  w(`the judged block is a bounded LLM-judge sample (#99). Compare two runs with`);
  w(`\`npm run corpus:compare -- <dirA> <dirB>\`.`);
  w();
  w(`## Structural (RUBRIC A–F, free)`);
  w();
  w(`| dimension | metric | value |`);
  w(`|---|---|---|`);
  w(`| A extraction | top-level claims / instances / total | ${st.extraction.topLevelClaims} / ${st.extraction.instances} / ${st.extraction.totalClaims} |`);
  w(`| A extraction | claims per 1k source words | ${st.extraction.claimsPer1kWords?.toFixed(2) ?? "n/a"} |`);
  w(`| B canonical form | word count p50 / p90 / max | ${st.canonicalForm.wordCount.p50} / ${st.canonicalForm.wordCount.p90} / ${st.canonicalForm.wordCount.max} |`);
  w(`| B canonical form | share > 25 words | ${(st.canonicalForm.overLongShare * 100).toFixed(0)}% |`);
  w(`| C matching | dedup ratio (instances ÷ top-level) | ${st.matching.dedupRatio?.toFixed(2) ?? "n/a"} |`);
  w(`| D decomposition | max depth | ${st.decomposition.maxDepth} |`);
  w(`| D decomposition | depth histogram (top-level) | ${Object.entries(st.decomposition.depthHistogram).map(([d, n]) => `${d}:${n}`).join(" ") || "—"} |`);
  w(`| D decomposition | atomic share / mean children | ${(st.decomposition.atomicShare * 100).toFixed(0)}% / ${st.decomposition.meanChildrenPerParent} |`);
  w(`| E cross-doc | shared subclaims (>1 parent) | ${st.crossDoc.sharedSubclaims} |`);
  w(`| F assessment | status distribution | ${Object.entries(st.assessment.statusDistribution).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} |`);
  w(`| F assessment | % with trace / mean trace len | ${(st.assessment.pctWithTrace * 100).toFixed(0)}% / ${st.assessment.meanTraceLength} |`);
  w(`| importance | mean / atomic / compound | ${st.importance.mean} / ${st.importance.meanAtomic ?? "n/a"} / ${st.importance.meanCompound ?? "n/a"} |`);
  w(`| importance | histogram | ${Object.entries(st.importance.histogram).sort().map(([k, v]) => `${k}:${v}`).join(" ")} |`);
  w();

  if (s.judged) {
    const j = s.judged;
    w(`## Judged (LLM-as-judge, sample = ${j.sampleSize}, model \`${j.model}\`)`);
    w();
    w(`| metric | value | reads as |`);
    w(`|---|---|---|`);
    w(`| **claim-bar pass-rate** | ${(j.claimBarPassRate * 100).toFixed(0)}% | share of sampled claims that are genuinely contestable (low ⇒ over-decomposition #98) |`);
    w(`| **importance alignment** | stored ${j.importanceAlignment.meanStored} vs judged ${j.importanceAlignment.meanJudged} | overrated by >0.2: ${(j.importanceAlignment.overratedShare * 100).toFixed(0)}% (#68) |`);
    w(`| assessment readability | ${j.assessmentQuality.readability}/5 | can a reader follow the verdict |`);
    w(`| assessment reasoning-fit | ${j.assessmentQuality.reasoningFit}/5 | does the trace justify the status |`);
    w(`| assessment impartiality | ${j.assessmentQuality.impartiality}/5 | even-handedness |`);
    w(`| granularity | ${Object.entries(j.granularity).map(([k, v]) => `${k} ${v}`).join(", ")} | |`);
    w(`| flags | ${Object.entries(j.flags).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} | |`);
    w();
    if (s.cost) w(`_judge cost: ${s.cost.calls} calls, $${s.cost.usd} (metered)._`);
    w();
    w(`### Lowest-scoring sampled claims`);
    w();
    const worst = [...j.items]
      .sort((a, b) => a.readability + a.reasoning_fit - (b.readability + b.reasoning_fit))
      .slice(0, 5);
    for (const v of worst) {
      w(`- **${v.claim_bar === "no" ? "[fails claim bar] " : ""}${v.text.slice(0, 90)}** — ${v.note}`);
    }
    w();
  } else {
    w(`## Judged`);
    w();
    w(`_skipped (\`--no-judge\`)._`);
    w();
  }
  return o.join("\n");
}

// Run directly.
if ((process.argv[1] ?? "").endsWith("score.ts")) {
  const args = process.argv.slice(2);
  const cluster = args.filter((a) => !a.startsWith("--"))[0] ?? "lethalities";
  const sampleArg = args.find((a) => a.startsWith("--sample="));
  const outArg = args.find((a) => a.startsWith("--out="));
  const sample = sampleArg ? Number(sampleArg.split("=")[1]) : DEFAULT_SAMPLE;
  const judge = !args.includes("--no-judge");

  scoreRun(cluster, { sample, judge, outDir: outArg?.split("=")[1] })
    .then(async ({ dir }) => {
      console.log(`Scorecard: ${join(dir, "scorecard.md")}`);
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
