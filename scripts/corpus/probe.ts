/**
 * Downstream-reasoner probe runner (#334 S5, from #288): does the graph's
 * confidence survive contact with a reasoner?
 *
 * For each pinned question about a cluster (corpus/probes/<cluster>.json),
 * build the graph's record by hybrid search — the top claims with status,
 * verdict confidence, credence and assessment summary — and ask a reasoner
 * model twice: WITH the record ("answer using only this record; state your
 * confidence 0–1; cite the claims you rest on") and WITHOUT it ("answer from
 * your own knowledge; state your confidence"). Recorded per question: both
 * stated confidences, whether the with-record answer cited claims at all,
 * how far its confidence sat from the credences of the claims it cited, and
 * whether it used a verified claim as false or a contradicted one as true.
 *
 * --retraction: pick a source in the graph (the one with the most instances,
 * or --source=<title or id fragment>), flag every claim with an instance from
 * it as if a lookout had found the source retracted, drain the Stewards, and
 * report which affected claims and dependents were revisited and how
 * credence moved. The system has no retraction or source-watch path today,
 * so the flag is simulated: enqueueSteward with trigger "lookout_flag" and
 * the retraction context from probe-prompts.ts. This mutates the corpus
 * graph — snapshot first if you want it back.
 *
 * Usage:
 *   npm run corpus:probe -- blackholes
 *   npm run corpus:probe -- lableak --limit=4 --model=<id>
 *   npm run corpus:probe -- eggs --questions=path/to/questions.json --top=6
 *   npm run corpus:probe -- blackholes --retraction [--source=plaga]
 *
 * The reasoner is PROBE_MODEL (default: the cheap OpenRouter flash pin), or
 * --model. Runs against the corpus DB a corpus:run already drained; needs
 * OPENAI_API_KEY (query embeddings) and a key for the reasoner's provider
 * (and, for --retraction, the Steward's). Registered as kind 'probe'.
 * Diagnostic only: nothing here is a scoring rule.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_PROFILE, CORPUS_ROOT, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { completeStructured } from "../../src/llm/client.js";
import { OPENROUTER_MODELS } from "../../src/llm/models.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { resolveProvider } from "../../src/llm/providers/routing.js";
import { withAgent } from "../../src/llm/usage-context.js";
import { hybridSearch } from "../../src/services/search-service.js";
import { enqueueSteward, type StewardMessage } from "../../src/services/queue-service.js";
import { drainLocalQueues, type RunnerEvent } from "../../src/workers/local-runner.js";
import {
  buildWithGraphPrompt,
  buildWithoutGraphPrompt,
  PROBE_WITH_GRAPH_SCHEMA,
  PROBE_WITHOUT_GRAPH_SCHEMA,
  renderGraphContext,
  retractionContext,
  type ContextClaim,
  type ProbeAnswerWithGraph,
  type ProbeAnswerWithoutGraph,
} from "./probe-prompts.js";
import {
  gradeProbeQuestion,
  loadProbeFixture,
  summarizeProbe,
  summarizeRetraction,
  validateProbeFixture,
  type AssessmentSnap,
  type ProbeQuestionResult,
  type RetractionClaim,
} from "./probe-lib.js";

const RUN_STARTED_AT = new Date();
const DEFAULT_TOP = 8;

/** The reasoner: --model, else PROBE_MODEL, else the cheap OpenRouter pin. */
function probeModel(): string {
  const model = argFlag("model") ?? process.env.PROBE_MODEL ?? OPENROUTER_MODELS.flash;
  if (!resolveProvider(model)) throw new Error(`"${model}" does not resolve to a provider`);
  return model;
}

async function buildContext(question: string, top: number): Promise<ContextClaim[]> {
  const { results } = await hybridSearch(question, { limit: top });
  if (results.length === 0) return [];
  const ids = results.map((r) => r.id);
  const rows = await rawQuery<{
    claim_id: string;
    status: string;
    confidence: number;
    claim_credence: number | null;
    summary: string | null;
    reasoning_trace: string;
  }>(
    `SELECT claim_id, status, confidence, claim_credence, summary, reasoning_trace
       FROM assessments WHERE is_current AND claim_id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.claim_id, r]));
  return results.map((r) => {
    const a = byId.get(r.id);
    return {
      id: r.id,
      text: r.text,
      status: a?.status ?? null,
      confidence: a?.confidence ?? null,
      credence: a?.claim_credence ?? null,
      summary: a?.summary ?? a?.reasoning_trace ?? null,
      similarity: Math.round(r.similarity_score * 1000) / 1000,
    };
  });
}

async function askWithGraph(model: string, prompt: string): Promise<ProbeAnswerWithGraph> {
  return withAgent("probe", () =>
    completeStructured<ProbeAnswerWithGraph>({
      messages: [{ role: "user", content: prompt }],
      schema: PROBE_WITH_GRAPH_SCHEMA,
      schemaName: "ProbeAnswerWithRecord",
      model,
      maxTokens: 4096,
    })
  );
}

async function askWithoutGraph(model: string, prompt: string): Promise<ProbeAnswerWithoutGraph> {
  return withAgent("probe", () =>
    completeStructured<ProbeAnswerWithoutGraph>({
      messages: [{ role: "user", content: prompt }],
      schema: PROBE_WITHOUT_GRAPH_SCHEMA,
      schemaName: "ProbeAnswer",
      model,
      maxTokens: 4096,
    })
  );
}

/** Exact metered cost of this process's window, per llm_usage (raw rates, every agent). */
async function meteredCostSinceStart(): Promise<number | null> {
  try {
    const [row] = await rawQuery<{ micro: string | null }>(
      `SELECT SUM(cost_micro_usd) AS micro FROM llm_usage WHERE created_at >= $1`,
      [RUN_STARTED_AT]
    );
    return Number(row?.micro ?? 0);
  } catch {
    return null;
  }
}

async function currentAssessments(ids: string[]): Promise<Map<string, AssessmentSnap>> {
  if (ids.length === 0) return new Map();
  const rows = await rawQuery<{ id: string; claim_id: string; status: string; confidence: number; claim_credence: number | null; assessed_at: string }>(
    `SELECT id, claim_id, status, confidence, claim_credence, assessed_at
       FROM assessments WHERE is_current AND claim_id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(
    rows.map((r) => [
      r.claim_id,
      { assessmentId: r.id, status: r.status, confidence: r.confidence, credence: r.claim_credence, assessedAt: new Date(r.assessed_at).toISOString() },
    ])
  );
}

async function runRetraction(cluster: string): Promise<{ summary: ReturnType<typeof summarizeRetraction>; trace: RunnerEvent[]; context: string }> {
  const fragment = argFlag("source");
  const sources = await rawQuery<{ id: string; title: string; url: string | null; n: number }>(
    `SELECT s.id, s.title, s.url, COUNT(ci.id)::int AS n
       FROM sources s JOIN claim_instances ci ON ci.source_id = s.id
      WHERE ($1::text IS NULL OR s.title ILIKE '%' || $1 || '%' OR s.id::text LIKE $1 || '%' OR s.url ILIKE '%' || $1 || '%')
      GROUP BY s.id ORDER BY n DESC, s.title LIMIT 1`,
    [fragment ?? null]
  );
  const source = sources[0];
  if (!source) throw new Error(fragment ? `no ingested source matches "${fragment}"` : `no ingested sources with instances in the corpus DB (run corpus:run ${cluster} first)`);

  const affected = await rawQuery<{ id: string; text: string }>(
    `SELECT DISTINCT c.id, c.text FROM claim_instances ci JOIN claims c ON c.id = ci.claim_id
      WHERE ci.source_id = $1 AND c.state = 'active' ORDER BY c.text`,
    [source.id]
  );
  const affectedIds = affected.map((c) => c.id);
  const dependents = affectedIds.length
    ? await rawQuery<{ id: string; text: string }>(
        `SELECT DISTINCT c.id, c.text FROM claim_relationships r JOIN claims c ON c.id = r.parent_claim_id
          WHERE r.child_claim_id = ANY($1::uuid[]) AND NOT (c.id = ANY($1::uuid[])) AND c.state = 'active' ORDER BY c.text`,
        [affectedIds]
      )
    : [];
  const allIds = [...affectedIds, ...dependents.map((d) => d.id)];
  const before = await currentAssessments(allIds);

  const context = retractionContext({ title: source.title, url: source.url });
  console.log(`\n--- retraction: "${source.title}" (${source.n} instance(s)) → ${affected.length} affected claim(s), ${dependents.length} dependent(s) ---`);
  for (const c of affected) {
    // There is no lookout trigger in StewardMessage's union today; the column
    // is text and the Steward receives the trigger name verbatim, so the
    // simulated flag is cast through. When a real retraction path lands,
    // replace this with it.
    await enqueueSteward({ claimId: c.id, trigger: "lookout_flag" as StewardMessage["trigger"], context });
  }
  const trace: RunnerEvent[] = [];
  const stats = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
  const stewardRuns = trace.filter((e) => e.queue === "steward").length;
  console.log(`  drained: ${stewardRuns} steward run(s)${stats.capped ? " (CAPPED)" : ""}`);

  const after = await currentAssessments(allIds);
  const claims: RetractionClaim[] = [
    ...affected.map((c) => ({ claimId: c.id, text: c.text, role: "instance" as const, before: before.get(c.id) ?? null, after: after.get(c.id) ?? null })),
    ...dependents.map((c) => ({ claimId: c.id, text: c.text, role: "dependent" as const, before: before.get(c.id) ?? null, after: after.get(c.id) ?? null })),
  ];
  const summary = summarizeRetraction({ id: source.id, title: source.title }, claims, { capped: stats.capped, stewardRuns });
  for (const r of summary.claims) {
    console.log(
      `  ${r.revisited ? "↻" : "·"} [${r.role}] ${r.text.slice(0, 70)} — ${r.before?.status ?? "none"}${r.before?.credence != null ? ` (${r.before.credence.toFixed(2)})` : ""}` +
        ` → ${r.after?.status ?? "none"}${r.after?.credence != null ? ` (${r.after.credence.toFixed(2)})` : ""}`
    );
  }
  console.log(`  ${summary.reading}`);
  return { summary, trace, context };
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cluster = positional(0);
  if (!cluster) {
    console.error("Usage: corpus:probe -- <cluster> [--questions=path] [--model=<id>] [--limit=N] [--top=N] [--retraction] [--source=<fragment>]");
    process.exit(1);
  }
  const fixturePath = argFlag("questions") ?? join(CORPUS_ROOT, "probes", `${cluster}.json`);
  if (!existsSync(fixturePath)) throw new Error(`no probe questions at ${fixturePath}`);
  const fixture = loadProbeFixture(fixturePath);
  const problems = validateProbeFixture(fixture);
  if (problems.length > 0) {
    console.error("Fixture invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  const limitRaw = argFlag("limit");
  const questions = limitRaw !== undefined ? fixture.questions.slice(0, Math.max(1, Number(limitRaw) || 1)) : fixture.questions;
  const top = Math.max(1, Number(argFlag("top") ?? DEFAULT_TOP) || DEFAULT_TOP);
  const model = probeModel();
  const cfg = loadConfig();

  const claimCount = (await rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM claims WHERE state = 'active'`))[0]?.n ?? 0;
  if (claimCount === 0) throw new Error(`the corpus graph is empty — run corpus:run ${cluster} first`);

  console.log(`\n=== reasoner probe: ${cluster} · ${questions.length} question(s) · reasoner ${model} · top ${top} claims per question · ${claimCount} active claims ===\n`);

  const results: ProbeQuestionResult[] = [];
  // The exact material handed to the reasoner per question, and its verbatim answers (#368).
  const transcripts: Array<{
    id: string;
    context: ContextClaim[];
    contextText: string;
    withGraph: { prompt: string; answer: ProbeAnswerWithGraph };
    withoutGraph: { prompt: string; answer: ProbeAnswerWithoutGraph };
  }> = [];
  for (const q of questions) {
    const context = await buildContext(q.question, top);
    const withPrompt = buildWithGraphPrompt(q.question, context);
    const withoutPrompt = buildWithoutGraphPrompt(q.question);
    const [withAnswer, withoutAnswer] = await Promise.all([askWithGraph(model, withPrompt), askWithoutGraph(model, withoutPrompt)]);
    const r = gradeProbeQuestion(q, context, withAnswer, withoutAnswer);
    results.push(r);
    transcripts.push({
      id: q.id,
      context,
      contextText: renderGraphContext(context),
      withGraph: { prompt: withPrompt, answer: withAnswer },
      withoutGraph: { prompt: withoutPrompt, answer: withoutAnswer },
    });
    console.log(
      `  ${q.id.padEnd(8)} [${q.kind.padEnd(11)}] conf with ${r.withGraph.confidence.toFixed(2)} · without ${r.withoutGraph.confidence.toFixed(2)}` +
        ` · cited ${r.cited.filter((c) => !c.unknown).length}${r.citedUnknown ? ` (+${r.citedUnknown} unknown)` : ""}` +
        ` · gap ${r.credenceGap === null ? "n/a" : r.credenceGap.toFixed(2)}` +
        (r.contradictions ? ` · ${r.contradictions} CONTRADICTION(S)` : "")
    );
  }
  const summary = summarizeProbe(cluster, model, results);
  console.log(`\n  ${summary.reading}`);

  let retraction: Awaited<ReturnType<typeof runRetraction>> | null = null;
  if (hasFlag("retraction")) retraction = await runRetraction(cluster);

  const costMicroUsd = await meteredCostSinceStart();
  console.log(`  metered cost (this process, all agents): ${costMicroUsd === null ? "n/a" : formatMicroUsd(costMicroUsd)}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `probe-${cluster}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "probe",
    cluster,
    reasonerModel: model,
    top,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    pipelineEpoch: cfg.pipelineEpoch,
    models: { extractor: cfg.extractorModel, matcher: cfg.matcherModel, steward: cfg.stewardModel, curator: cfg.curatorModel, probe: model },
    summary,
    results,
    transcripts,
    retraction: retraction ? { summary: retraction.summary, context: retraction.context } : null,
    costMicroUsd,
  };
  writeFileSync(join(dir, "probe.json"), JSON.stringify(report, null, 2));
  if (retraction) writeFileSync(join(dir, "retraction-trace.jsonl"), retraction.trace.map((e) => JSON.stringify(e)).join("\n"));
  try {
    await getDb().insert(evalRuns).values({
      cluster,
      kind: "probe",
      config: { pipelineEpoch: cfg.pipelineEpoch, gitCommit: report.gitCommit, profile: CORPUS_PROFILE, models: report.models, retraction: retraction !== null },
      scorecard: report,
      runDir: dir,
    });
  } catch (err) {
    console.warn("[probe] eval-run registry write failed (probe.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log(`  written: ${join(dir, "probe.json")}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
