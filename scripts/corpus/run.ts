/**
 * "Hit run and see results" — the corpus harness entry point.
 *
 * This runs the REAL system against the isolated corpus DB: it builds the actual
 * Fastify app and submits each post through the real `POST /sources` route
 * (via in-process injection), then drains the in-memory queues with the same
 * local runner the dev server uses. Inputs and processing are exactly what
 * production does; only the database differs. A trace of every agent message is
 * recorded so inter-agent behavior and propagation are observable.
 *
 * Usage:
 *   tsx scripts/corpus/run.ts [cluster] [flags]
 *
 * Flags:
 *   --no-reset             keep the existing graph (ingest on top of it)
 *   --limit=N              only the first N posts (cheap smoke test)
 *   --posts=id1,id2        only these post IDs
 *   --profile=production   run on the production model pins (lib.ts)
 *   --score[=N]            emit a scorecard afterwards (judge sample N)
 *
 * Examples:
 *   npm run corpus:run -- lethalities --limit=2     # quick, cheap
 *   npm run corpus:run -- lethalities               # full cluster
 *   npm run corpus:run -- blackholes --profile=production --score   # a baseline
 *
 * Every run registers itself in the eval-run registry (eval_runs, kind
 * 'ingest') with its configuration fingerprint — epoch, commit, profile, the
 * models each agent was configured with, the spend caps — and, once drained,
 * the models actually observed in llm_usage. corpus:score reads that row
 * back, so a scorecard describes the run that built the graph rather than
 * whatever config happens to be loaded at score time (#334 L1).
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  argFlag,
  assertCorpusDb,
  CORPUS_PROFILE,
  gitCommit,
  hasFlag,
  loadManifest,
  positional,
  postMarkdownPath,
  postUrl,
  RUNS_ROOT,
} from "./lib.js";
import type { ManifestPost } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { getSessionUsage } from "../../src/llm/budget-tracker.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { resolveProvider } from "../../src/llm/providers/routing.js";
import { getJobById } from "../../src/services/job-service.js";
import { buildApp } from "../../src/server/app.js";
import { drainLocalQueues } from "../../src/workers/local-runner.js";
import type { DrainStats, RunnerEvent } from "../../src/workers/local-runner.js";
import { resetCorpusDb } from "./reset.js";
import { generateReport } from "./report.js";
import { scoreRun, type RunFingerprint } from "./score.js";
import { observedModels } from "./fingerprint.js";

function formatActivity(stats: DrainStats): string {
  const acts = Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`);
  const errs = Object.values(stats.errors).reduce((a, b) => a + b, 0);
  let s = acts.join(", ") || "no follow-up work";
  if (errs) s += `, ${errs} handler errors`;
  if (stats.capped) s += " (CAPPED — did not reach quiescence)";
  return s;
}

// Exact run cost, read back from llm_usage — the durable meter every provider
// adapter writes at raw, per-model rates (including refusal fallbacks and
// OpenRouter provider-reported cost). A context-carried cost meter can NOT
// see this run's drained work: the steward pipeline and engine executor wrap
// each operation in their own withCostMeter for cap-and-settle, and nested
// meters shadow outer ones by design. llm_usage has no such scoping — every
// call in the window lands there, so summing the window is the whole truth.
// The window opens at process start; llm_usage is deliberately NOT truncated
// by corpus:reset, so timestamps are the right filter.
const RUN_STARTED_AT = new Date();

/** The fingerprint as configured, recorded before the first LLM call. */
function configuredFingerprint(): RunFingerprint {
  const cfg = loadConfig();
  return {
    pipelineEpoch: cfg.pipelineEpoch,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    models: {
      extractor: cfg.extractorModel,
      matcher: cfg.matcherModel,
      steward: cfg.stewardModel,
      curator: cfg.curatorModel,
    },
    caps: {
      stewardMaxRuns: cfg.stewardMaxRuns,
      stewardMaxIterations: cfg.stewardMaxIterations,
      curatorMaxRuns: cfg.curatorMaxRuns,
      curatorSweepRate: cfg.curatorSweepRate,
      llmDailyTokenLimit: cfg.llmDailyTokenLimit,
      llmHourlyTokenLimit: cfg.llmHourlyTokenLimit,
    },
  };
}

/** Per-agent models actually seen in llm_usage since the run window opened. */
async function observedSinceStart(): Promise<Record<string, string[]>> {
  const rows = await rawQuery<{ agent: string; model: string; calls: number }>(
    `SELECT agent, model, COUNT(*)::int AS calls
       FROM llm_usage WHERE created_at >= $1
      GROUP BY agent, model`,
    [RUN_STARTED_AT]
  );
  return observedModels(rows);
}

/**
 * The API keys this run's configured models need, by provider: every agent's
 * model routes somewhere (routing.ts), and embeddings always need OpenAI. A
 * production-profile run puts the Matcher on OpenRouter, so a fixed
 * "Anthropic + OpenAI" preflight would let it start and fail on the first
 * match.
 */
function missingKeys(): string[] {
  const cfg = loadConfig();
  const keyFor = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
  const needed = new Set<string>(["OPENAI_API_KEY"]);
  for (const model of [cfg.extractorModel, cfg.matcherModel, cfg.stewardModel, cfg.curatorModel]) {
    const provider = resolveProvider(model);
    if (provider) needed.add(keyFor[provider]);
  }
  return [...needed].filter((k) => !process.env[k]);
}

async function printUsage(label: string): Promise<void> {
  const u = getSessionUsage();
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const cacheTotalInput = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const hitRate =
    cacheTotalInput > 0 ? ((u.cacheReadTokens / cacheTotalInput) * 100).toFixed(0) : "0";
  console.log(
    `\n=== LLM usage (${label}) ===\n` +
      `  calls: ${u.calls}\n` +
      `  input:  ${k(u.inputTokens)} fresh + ${k(u.cacheReadTokens)} cache-read ` +
      `+ ${k(u.cacheCreationTokens)} cache-write  (cache hit rate ${hitRate}%)\n` +
      `  output: ${k(u.outputTokens)}`
  );
  try {
    const rows = await rawQuery<{ agent: string; model: string; calls: number; micro: string }>(
      `SELECT agent, model, COUNT(*)::int AS calls, SUM(cost_micro_usd) AS micro
         FROM llm_usage WHERE created_at >= $1
        GROUP BY agent, model ORDER BY SUM(cost_micro_usd) DESC`,
      [RUN_STARTED_AT]
    );
    let total = 0;
    for (const r of rows) {
      total += Number(r.micro);
      console.log(
        `    ${r.agent.padEnd(10)} ${r.model.padEnd(28)} ${String(r.calls).padStart(4)} calls  ${formatMicroUsd(Number(r.micro))}`
      );
    }
    console.log(`  metered cost (exact, raw rates): ${formatMicroUsd(total)}`);
  } catch (err) {
    console.log(
      `  metered cost unavailable (${err instanceof Error ? err.message : err})`
    );
  }
}

function selectPosts(all: ManifestPost[]): ManifestPost[] {
  const only = argFlag("posts")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const limitRaw = argFlag("limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`Invalid --limit=${limitRaw} (expected a positive integer).`);
      process.exit(1);
    }
  }
  let posts = all;
  if (only?.length) posts = posts.filter((p) => only.includes(p.id));
  if (limit !== undefined) posts = posts.slice(0, limit);
  return posts;
}

async function main(): Promise<void> {
  const cluster = positional(0) ?? "lethalities";
  const manifest = loadManifest(cluster);
  const posts = selectPosts(manifest.posts);

  // Preflight: an embeddings key plus a key for every provider the configured
  // agent models route to.
  const missing = missingKeys();
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}. Set them in .env.`);
    process.exit(1);
  }

  // Don't run a destructive reset just to ingest nothing.
  if (posts.length === 0) {
    console.error("No posts selected (check --posts / --limit / manifest). Not resetting.");
    process.exit(1);
  }

  // Backstop: confirm we resolved the isolated corpus DB, not the main graph,
  // before we reset or write anything.
  assertCorpusDb();

  const fingerprint = configuredFingerprint();
  console.log(`\n=== corpus run: ${cluster} — ${posts.length} post(s) ===`);
  console.log(
    `  epoch ${fingerprint.pipelineEpoch} · commit ${fingerprint.gitCommit ?? "?"}` +
      (fingerprint.profile ? ` · profile ${fingerprint.profile}` : "") +
      `\n  extractor ${fingerprint.models.extractor} · matcher ${fingerprint.models.matcher}` +
      ` · steward ${fingerprint.models.steward} · curator ${fingerprint.models.curator}`
  );

  if (!hasFlag("no-reset")) {
    console.log("Resetting corpus DB…");
    await resetCorpusDb();
  } else {
    console.log("--no-reset: ingesting on top of the existing graph");
  }

  const runDir = join(RUNS_ROOT, `${cluster}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(runDir, { recursive: true });
  const trace: RunnerEvent[] = [];

  // Register the run before the first LLM call, so even an aborted run leaves
  // its fingerprint behind. Best-effort: the registry must never block a run.
  let registryId: string | null = null;
  try {
    const [row] = await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "ingest",
        config: { ...fingerprint, posts: posts.map((p) => p.id), noReset: hasFlag("no-reset") },
        runDir,
      })
      .returning({ id: evalRuns.id });
    registryId = row?.id ?? null;
    if (registryId) console.log(`  registered ingest run ${registryId.slice(0, 8)}`);
  } catch (err) {
    console.warn(
      "[run] eval-run registry write failed (the run proceeds unregistered):",
      err instanceof Error ? err.message : err
    );
  }

  // The actual production app, pointed at the corpus DB.
  const app = await buildApp();
  let succeeded = 0;
  let anyCapped = false;

  try {
    for (const [i, p] of posts.entries()) {
      const tag = `[${i + 1}/${posts.length}]`;
      const mdPath = postMarkdownPath(cluster, p.id);
      if (!existsSync(mdPath)) {
        console.log(`  ${tag} ${p.id} — MISSING markdown; run \`npm run corpus:fetch\` first`);
        continue;
      }
      const content = readFileSync(mdPath, "utf8");
      const url = postUrl(p);

      process.stdout.write(`  ${tag} ${p.title.slice(0, 50).padEnd(50)} submit…`);
      const started = Date.now();
      try {
        // Submit through the real route, exactly as an API client would.
        const res = await app.inject({
          method: "POST",
          url: "/sources",
          payload: { url, title: p.title, content },
        });
        if (res.statusCode !== 202) {
          console.log(` ✗ POST /sources -> ${res.statusCode} ${res.body.slice(0, 120)}`);
          continue;
        }
        const { job_id } = res.json() as { job_id: string };

        // Drive the whole organization to a stable state, tracing every message.
        const before = trace.length;
        const stats = await drainLocalQueues({ onEvent: (e) => trace.push(e) });

        if (stats.capped) anyCapped = true;

        const finished = await getJobById(job_id);
        const r = (finished?.result ?? {}) as Record<string, number>;
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(
          ` ✓ ${r.claims_extracted ?? "?"} extracted, ` +
            `${r.claims_created ?? "?"} new / ${r.claims_matched ?? "?"} matched ` +
            `(${secs}s, ${trace.length - before} agent msgs)\n      agents: ${formatActivity(stats)}`
        );
        succeeded++;
      } catch (err) {
        const msg = (err as Error).message;
        console.log(` ✗ ${msg}`);
        // Drain whatever this post already enqueued so partial work is processed
        // and attributed here, not orphaned or leaked into the next post.
        await drainLocalQueues({ onEvent: (e) => trace.push(e) }).catch(() => {});
        if (/budget/i.test(msg)) {
          console.log("\nLLM budget exceeded — stopping early. Report covers what was ingested.");
          break;
        }
      }
    }
  } finally {
    await app.close();
  }

  // Observability artifact: the full ordered stream of agent activity.
  writeFileSync(join(runDir, "trace.jsonl"), trace.map((e) => JSON.stringify(e)).join("\n"));

  // Close the fingerprint with what actually ran: the models llm_usage saw
  // per agent (a second model under an agent means a fallback fired), and
  // whether any drain hit its cap. run.json is the file-side copy; the
  // registry row is what corpus:score reads.
  const observed = await observedSinceStart().catch(() => ({}) as Record<string, string[]>);
  const finished: RunFingerprint = { ...fingerprint, observed };
  const runRecord = {
    ...finished,
    cluster,
    registryId,
    startedAt: RUN_STARTED_AT.toISOString(),
    finishedAt: new Date().toISOString(),
    posts: posts.map((p) => p.id),
    postsIngested: succeeded,
    capped: anyCapped,
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(runRecord, null, 2));
  if (registryId) {
    try {
      await getDb()
        .update(evalRuns)
        .set({ config: runRecord })
        .where(eq(evalRuns.id, registryId));
    } catch (err) {
      console.warn(
        "[run] eval-run registry update failed (run.json is intact):",
        err instanceof Error ? err.message : err
      );
    }
  }
  for (const [agent, models] of Object.entries(observed)) {
    if (models.length > 1) {
      console.log(`  note: ${agent} ran on more than one model (${models.join(", ")}) — a fallback fired.`);
    }
  }

  console.log(`\n${succeeded}/${posts.length} posts ingested. Generating report…`);
  const reportPath = await generateReport(cluster, runDir);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Trace:  ${join(runDir, "trace.jsonl")} (${trace.length} agent messages)`);
  console.log("Read the report alongside corpus/RUBRIC.md.");

  // Optional scored scorecard (#99). --score emits structural metrics + a
  // bounded LLM-judge sample into the same run dir; --score=N sets the sample
  // size; --score=0 is structural-only (free). Off by default so a plain run
  // stays cheap. The scorecard carries THIS run's fingerprint.
  const scoreFlag = argFlag("score");
  if (scoreFlag !== undefined) {
    const sample = scoreFlag === "" ? undefined : Number(scoreFlag);
    console.log("\nScoring the run…");
    const { dir } = await scoreRun(cluster, {
      sample: Number.isFinite(sample) ? sample : undefined,
      judge: sample !== 0,
      outDir: runDir,
      fingerprint: finished,
      allowSameModelJudge: hasFlag("allow-same-model-judge"),
    });
    console.log(`Scorecard: ${join(dir, "scorecard.md")}`);
  }

  await printUsage("this run");

  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  // Still report what the run cost before it failed — a crash shouldn't hide spend.
  try {
    await printUsage("partial — run errored");
  } catch {
    /* usage reporting is best-effort */
  }
  await closeDb().catch(() => {});
  process.exit(1);
});
