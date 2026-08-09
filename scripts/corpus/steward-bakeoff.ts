/**
 * Steward model bake-off: run DIFFERENT models as the Claim Steward over the
 * SAME extracted claim queue, capped at the same run quota, and score each
 * with the same judge panel — "which model does the assessment task best?",
 * held apart from "which judge grades it?" (judge-compare.ts).
 *
 * Two subcommands, driven as separate processes so each phase's STEWARD_MODEL
 * is a clean env-level fact (config is cached per process):
 *
 *   prepare <cluster>
 *     Reset the corpus DB, ingest every post through the real /sources route,
 *     drain extraction + matching with the Steward PARKED (maxStewardTasks 0),
 *     then snapshot the DB as "bakeoff-<cluster>". Every phase starts from
 *     this identical claim queue, so steward differences are model
 *     differences, not extraction noise.
 *
 *   phase <cluster> --model=<id> [--runs=N] [--sample=N]
 *     Restore the snapshot, drain the DB-backed steward lane for N runs
 *     (highest-priority-first — every model gets the same top-of-queue work),
 *     then score the graph with the configured judge panel. The scorecard's
 *     config fingerprint records the steward model; phase artifacts land in
 *     corpus/scorecards/<cluster>/ like any scored run.
 *
 * OpenRouter steward models run SEARCH-BLIND (no hosted web search exists
 * there — see claim-steward.ts); their scorecards are comparable only with
 * that handicap in mind.
 *
 * Usage:
 *   npx tsx scripts/corpus/steward-bakeoff.ts prepare blackholes
 *   MATCHER_MODEL=... npx tsx scripts/corpus/steward-bakeoff.ts phase blackholes --model=claude-opus-5 --runs=4
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, readFileSync } from "node:fs";
import {
  argFlag,
  assertCorpusDb,
  CORPUS_DATABASE_URL,
  loadManifest,
  positional,
  postMarkdownPath,
  postUrl,
} from "./lib.js";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { isSupportedModelId, unresolvableModelIdMessage } from "../../src/llm/providers/routing.js";
import { buildApp } from "../../src/server/app.js";
import { drainLocalQueues } from "../../src/workers/local-runner.js";
import { restoreSnapshot, saveSnapshot } from "./snapshot-core.js";
import { resetCorpusDb } from "./reset.js";
import { scoreRun } from "./score.js";

const PHASE_STARTED_AT = new Date();

function snapshotName(cluster: string): string {
  return `bakeoff-${cluster}`;
}

async function printWindowUsage(): Promise<void> {
  const rows = await rawQuery<{ agent: string; model: string; calls: number; micro: string }>(
    `SELECT agent, model, COUNT(*)::int AS calls, SUM(cost_micro_usd) AS micro
       FROM llm_usage WHERE created_at >= $1
      GROUP BY agent, model ORDER BY SUM(cost_micro_usd) DESC`,
    [PHASE_STARTED_AT]
  );
  let total = 0;
  for (const r of rows) {
    total += Number(r.micro);
    console.log(
      `    ${r.agent.padEnd(10)} ${r.model.padEnd(30)} ${String(r.calls).padStart(4)} calls  ${formatMicroUsd(Number(r.micro))}`
    );
  }
  console.log(`  metered cost this phase: ${formatMicroUsd(total)}`);
}

async function prepare(cluster: string): Promise<void> {
  const manifest = loadManifest(cluster);
  console.log(`\n=== bakeoff prepare: ${cluster} — ${manifest.posts.length} post(s) ===`);
  console.log("Resetting corpus DB…");
  await resetCorpusDb();

  const app = await buildApp();
  try {
    for (const [i, p] of manifest.posts.entries()) {
      const mdPath = postMarkdownPath(cluster, p.id);
      if (!existsSync(mdPath)) {
        console.log(`  [${i + 1}] ${p.id} — MISSING markdown; run corpus:fetch first`);
        continue;
      }
      process.stdout.write(`  [${i + 1}/${manifest.posts.length}] ${p.title.slice(0, 50)}…`);
      const res = await app.inject({
        method: "POST",
        url: "/sources",
        payload: { url: postUrl(p), title: p.title, content: readFileSync(mdPath, "utf8") },
      });
      if (res.statusCode !== 202) {
        console.log(` ✗ POST /sources -> ${res.statusCode}`);
        continue;
      }
      // Extraction + matching drain; the Steward stays parked (quota 0).
      const stats = await drainLocalQueues({ maxStewardTasks: 0 });
      console.log(` ✓ (steward parked: ${stats.capped ? "pending work queued" : "no pending work"})`);
    }
  } finally {
    await app.close();
  }

  const [pending] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM claims WHERE steward_state = 'pending'`
  );
  console.log(`\nParked steward queue: ${pending?.n ?? 0} claims pending.`);
  await printWindowUsage();

  await saveSnapshot(CORPUS_DATABASE_URL, snapshotName(cluster));
  console.log(`✓ snapshot "${snapshotName(cluster)}" saved — run phases against it.`);
}

async function phase(cluster: string): Promise<void> {
  const model = argFlag("model");
  if (!model) throw new Error("phase requires --model=<id>");
  if (!isSupportedModelId(model)) throw new Error(unresolvableModelIdMessage(model));
  const runs = Number(argFlag("runs") ?? "4");
  const sample = Number(argFlag("sample") ?? "15");

  // The phase's model must be the process-level steward config: score.ts and
  // the pipeline both read loadConfig(), which caches, so set it before any
  // config consumer runs. (Callers may also set STEWARD_MODEL in the shell —
  // the flag wins.)
  process.env.STEWARD_MODEL = model;

  console.log(`\n=== bakeoff phase: ${cluster} · steward=${model} · runs=${runs} ===`);
  console.log(`Restoring snapshot "${snapshotName(cluster)}"…`);
  await restoreSnapshot(CORPUS_DATABASE_URL, snapshotName(cluster));

  const started = Date.now();
  const stats = await drainLocalQueues({ maxStewardTasks: runs });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `Drained: ${Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`).join(", ") || "nothing"} ` +
      `in ${secs}s${stats.capped ? " (quota reached, queue still pending — by design)" : ""}`
  );

  const [assessed] = await rawQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM assessments WHERE is_current`
  );
  console.log(`Assessed claims: ${assessed?.n ?? 0}. Scoring with the judge panel…`);

  const { scorecard, dir } = await scoreRun(cluster, { sample });
  console.log(`Scorecard: ${dir} (steward=${scorecard.config.models.steward})`);
  await printWindowUsage();
}

async function main(): Promise<void> {
  assertCorpusDb();
  const command = positional(0);
  const cluster = positional(1) ?? "blackholes";
  if (command === "prepare") return prepare(cluster);
  if (command === "phase") return phase(cluster);
  throw new Error("Usage: steward-bakeoff.ts <prepare|phase> <cluster> [--model= --runs= --sample=]");
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    try {
      await printWindowUsage();
    } catch {
      /* best-effort */
    }
    await closeDb().catch(() => {});
    process.exit(1);
  });
