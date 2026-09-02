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
 *                               [--allow-same-model-judge]
 *
 * The scorecard's config fingerprint (epoch, commit, models, caps) is read
 * from the ingest run that built the graph (corpus:run registers one), not
 * from config at score time — see fingerprint.ts for why.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCorpusDb, CORPUS_PROFILE, gitCommit, RUNS_ROOT, SCORECARDS_ROOT } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { getSessionUsage } from "../../src/llm/budget-tracker.js";
import { withCostMeter } from "../../src/llm/usage-context.js";
import { loadConfig } from "../../src/config.js";
import { computeStructuralMetrics, type GraphSnapshot, type StructuralMetrics } from "./metrics.js";
import { judgeClaim, type JudgeInput, type JudgeVerdict } from "./judge.js";
import { judgeConflict, type ScorecardConfig } from "./fingerprint.js";
import { summarizeJudged, type JudgedSummary } from "./judged-summary.js";

export type { ScorecardConfig } from "./fingerprint.js";

const DEFAULT_SAMPLE = 15;

/**
 * The fingerprint an ingest run recorded in the registry (corpus:run writes
 * one row of kind 'ingest' per run, with the models it was configured with
 * and, once finished, the models it actually observed). The judge is chosen
 * at score time and is not part of it.
 */
export type RunFingerprint = Omit<ScorecardConfig, "models"> & {
  models: Omit<ScorecardConfig["models"], "judge">;
};

/**
 * Resolve the fingerprint for the graph being scored, most trustworthy source
 * first: the run that produced it (passed in by corpus:run --score), the
 * registry row that run left behind (a later standalone corpus:score), and
 * only then config at score time — which is right only if nothing changed in
 * between, and is how the first baseline came to record the wrong Matcher.
 */
async function resolveFingerprint(
  cluster: string,
  judgeModel: string,
  provided?: RunFingerprint
): Promise<ScorecardConfig> {
  if (provided) {
    return { ...provided, models: { ...provided.models, judge: judgeModel }, modelsSource: "run" };
  }
  const rows = await rawQuery<{ config: RunFingerprint }>(
    `SELECT config FROM eval_runs
      WHERE cluster = $1 AND kind = 'ingest'
      ORDER BY created_at DESC LIMIT 1`,
    [cluster]
  );
  const fromRegistry = rows[0]?.config;
  if (fromRegistry) {
    return {
      ...fromRegistry,
      models: { ...fromRegistry.models, judge: judgeModel },
      modelsSource: "registry",
    };
  }
  const cfg = loadConfig();
  console.warn(
    `  warning: no ingest run registered for "${cluster}" — recording the models ` +
      `from config at score time, which is only right if the graph was built under ` +
      `this same environment. Prefer corpus:run (it records the fingerprint at run time).`
  );
  return {
    pipelineEpoch: cfg.pipelineEpoch,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    models: {
      extractor: cfg.extractorModel,
      matcher: cfg.matcherModel,
      steward: cfg.stewardModel,
      curator: cfg.curatorModel,
      judge: judgeModel,
    },
    modelsSource: "score-time",
  };
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

  const instances = await rawQuery<{
    claimId: string;
    originalText: string;
    stance: string;
    proposedCanonicalForm: string | null;
  }>(
    `SELECT claim_id AS "claimId", original_text AS "originalText", stance,
            proposed_canonical_form AS "proposedCanonicalForm"
       FROM claim_instances ORDER BY created_at`
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
  const instancesOf = new Map<string, JudgeInput["instances"]>();
  for (const i of g.instances) {
    (instancesOf.get(i.claimId) ?? instancesOf.set(i.claimId, []).get(i.claimId)!).push({
      originalText: i.originalText ?? "",
      stance: i.stance ?? "affirms",
      proposedCanonicalForm: i.proposedCanonicalForm ?? null,
    });
  }

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
      instances: instancesOf.get(c.id) ?? [],
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

export async function scoreRun(
  cluster: string,
  opts: {
    sample?: number;
    judge?: boolean;
    outDir?: string;
    /** The fingerprint corpus:run recorded for this graph, when scoring from a run. */
    fingerprint?: RunFingerprint;
    /** Override the rule that the judge must not share the Steward's model. */
    allowSameModelJudge?: boolean;
  } = {}
): Promise<{ scorecard: Scorecard; dir: string; judgeCostMicroUsd: number }> {
  assertCorpusDb();
  const sample = opts.sample ?? DEFAULT_SAMPLE;
  const doJudge = opts.judge ?? true;
  const cfg = loadConfig();
  const config = await resolveFingerprint(cluster, cfg.judgeModel, opts.fingerprint);

  const snapshot = await loadSnapshot();
  const structural = computeStructuralMetrics(snapshot);

  let judged: JudgedSummary | null = null;
  let cost: Scorecard["cost"] = null;
  let judgeCostMicroUsd = 0;
  if (doJudge && sample > 0) {
    // The judge never grades a graph its own model built (corpus/SCORING.md);
    // the first baseline did exactly that, silently. Refuse unless overridden.
    const conflict = judgeConflict(config, cfg.judgeModel);
    if (conflict && !opts.allowSameModelJudge) throw new Error(conflict);
    if (conflict) console.warn(`  warning (overridden): ${conflict}`);
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
    config,
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
  // since runs/ is gitignored — the cross-machine record; commit the ones
  // that matter as baselines.
  const historyDir = join(SCORECARDS_ROOT, cluster);
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${stamp}.json`), JSON.stringify(scorecard, null, 2));

  // And register it in the eval-run registry (#334 L1) — the queryable local
  // history (`corpus:runs`, `corpus:compare db:<id>`), which corpus:reset
  // deliberately does not truncate. Best-effort: a registry hiccup must never
  // fail the scoring that produced the scorecard.
  let runId: string | null = null;
  try {
    const inserted = await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "score",
        config: scorecard.config,
        scorecard,
        runDir: dir,
      })
      .returning({ id: evalRuns.id });
    runId = inserted[0]?.id ?? null;
  } catch (err) {
    console.warn(
      "[score] eval-run registry write failed (scorecard files are intact):",
      err instanceof Error ? err.message : err
    );
  }
  if (runId) console.log(`  registered eval run ${runId.slice(0, 8)}`);

  return { scorecard, dir, judgeCostMicroUsd };
}

function renderMarkdown(s: Scorecard): string {
  const pct = (x: number | undefined) => (x === undefined ? "n/a" : `${(x * 100).toFixed(0)}%`);
  const o: string[] = [];
  const w = (l = "") => o.push(l);
  const st = s.structural;
  w(`# Corpus run scorecard — ${s.cluster}`);
  w();
  w(`_generated ${s.generatedAt} · database \`${s.database}\`_`);
  const observed = (agent: string, configured: string | undefined) => {
    const seen = s.config.observed?.[agent];
    if (!seen || seen.length === 0) return configured ?? "?";
    return seen.length === 1 ? seen[0] : `${seen[0]} (+ ${seen.slice(1).join(", ")})`;
  };
  w(
    `_epoch \`${s.config.pipelineEpoch}\` · commit \`${s.config.gitCommit ?? "?"}\`` +
      (s.config.profile ? ` · profile \`${s.config.profile}\`` : "") +
      ` · extractor \`${observed("extractor", s.config.models.extractor)}\`` +
      ` · matcher \`${observed("matcher", s.config.models.matcher)}\`` +
      ` · steward \`${observed("steward", s.config.models.steward)}\`` +
      ` · judge \`${s.config.models.judge}\`_`
  );
  if (s.config.modelsSource && s.config.modelsSource !== "run") {
    w();
    w(
      s.config.modelsSource === "registry"
        ? `_agent models read back from the run's registry row._`
        : `_agent models are config at SCORE time, not recorded at run time — trust them only if nothing changed in between._`
    );
  }
  if (s.config.caps && Object.keys(s.config.caps).length > 0) {
    w();
    w(
      `_caps in force: ${Object.entries(s.config.caps)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")} — a capped run is a partial baseline._`
    );
  }
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
  w(`| §21 coherence | violations / tensions | ${st.coherence.violations} / ${st.coherence.tensions} |`);
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
    const dist = (d: Record<string, number> | undefined) =>
      d ? Object.entries(d).map(([k, v]) => `${k} ${v}`).join(", ") : "n/a";
    w(`| **sycophancy** | ${pct(j.sycophancyShare)} lean on or defer to the source | ${dist(j.dimensions?.sycophancy)} (§4/§17: independence from the ingesting source) |`);
    w(`| **hedging** | ${pct(j.overhedgedShare)} overhedged · ${pct(j.overconfidentShare)} overconfident | ${dist(j.dimensions?.hedging)} (§10/§12: certainty of language) |`);
    w(`| **canonical form** | ${pct(j.canonicalFormMissShare)} miss §3 | ${dist(j.dimensions?.canonicalForm)} (overstated / understated / frame-bound) |`);
    w(`| political bias | ${pct(j.politicalBiasShare)} | ${dist(j.dimensions?.politicalBias)} (§17) |`);
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
  const allowSameModelJudge = args.includes("--allow-same-model-judge");

  scoreRun(cluster, { sample, judge, outDir: outArg?.split("=")[1], allowSameModelJudge })
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
