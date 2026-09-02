/**
 * Predictions — the calibration track (#334 S6, from #296).
 *
 * Predictions are the one class of claim where reality eventually supplies
 * ground truth. This script runs their lifecycle: SEED them from the pinned
 * fixture (corpus/predictions/manifest.json) as ordinary claims the Steward
 * will assess, RESOLVE them when the world settles the question, attach
 * market BASELINES for the Minerval-vs-crowd comparative, and SCORE the
 * credences the Steward held before resolution (Brier, log score,
 * calibration curve, ECE — scripts/corpus/prediction-score.ts).
 *
 *   npm run predictions -- list
 *   npm run predictions -- seed [--dry-run] [--drain]
 *   npm run predictions -- resolve <fixture-id|claim-id> yes|no [--note="…"] [--by=<name>]
 *   npm run predictions -- import-baselines <file.json>
 *   npm run predictions -- score [--out=FILE]
 *
 * Every subcommand takes --corpus to run against the isolated corpus DB
 * (scripts/corpus/lib.ts pins it; --profile=production works there too).
 * Without it the script uses DATABASE_URL like the other operational
 * scripts, which is how the fixture is seeded into PRODUCTION — the point
 * of S6 is that production's own Steward forecasts these under its own
 * economics, and the signal accrues from the day they are seeded:
 *
 *   aws ecs run-task … --overrides '{"containerOverrides":[{"name":"api",
 *     "command":["npm","run","predictions","--","seed"]}]}'
 *
 * A seeded prediction enters the graph the way an API-proposed claim does:
 * a claim row, a claim_pipeline job, and the onboarding message that hands
 * it to its Steward. In production it then sits in the queue until a
 * mandate's allocator funds its assessment (§19 as amended: a checkable
 * statement submitted for assessment enters as a stub the same economics
 * govern). With --corpus, --drain runs the local queues to quiescence so the
 * corpus Steward assesses them now (LLM spend).
 *
 * Seeding is idempotent on fixture id. Resolution is manual by design for
 * now — a resolution watcher that polls the platforms is the follow-up; the
 * criterion and operationalization on each row are written so that a human
 * (or that watcher) can settle it without judgment.
 *
 * Baseline import file: {"<fixture-id>": {"probability": 0.42, "source":
 * "metaculus:12345", "at": "2026-09-02T00:00:00Z"}, …}.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, "..", "corpus", "predictions", "manifest.json");

interface FixturePrediction {
  id: string;
  claim: string;
  resolutionCriterion: string;
  resolutionDate: string;
  operationalization: string;
  domain?: string;
  notes?: string;
}
interface Manifest {
  cluster: string;
  authoredAt: string;
  predictions: FixturePrediction[];
}

function argFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
function positionals(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"));
}

function loadManifest(): Manifest {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const ids = new Set<string>();
  for (const p of m.predictions) {
    if (ids.has(p.id)) throw new Error(`duplicate fixture id ${p.id}`);
    ids.add(p.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.resolutionDate)) {
      throw new Error(`${p.id}: resolutionDate must be YYYY-MM-DD`);
    }
    if (!p.claim || !p.resolutionCriterion || !p.operationalization) {
      throw new Error(`${p.id}: claim, resolutionCriterion and operationalization are required`);
    }
  }
  return m;
}

interface Row {
  claim_id: string;
  fixture_id: string | null;
  text: string;
  domain: string | null;
  resolution_date: string;
  baseline_probability: number | null;
  resolved_at: string | null;
  outcome: boolean | null;
  history: Array<{ credence: number | null; assessedAt: string }> | null;
}

async function loadRows(): Promise<Row[]> {
  const { rawQuery } = await import("../src/db/client.js");
  return rawQuery<Row>(
    `SELECT p.claim_id, p.fixture_id, c.text, p.domain,
            p.resolution_date::text AS resolution_date,
            p.baseline_probability, p.resolved_at, p.outcome,
            (SELECT json_agg(json_build_object('credence', a.claim_credence, 'assessedAt', a.assessed_at)
                             ORDER BY a.assessed_at)
               FROM assessments a WHERE a.claim_id = p.claim_id) AS history
       FROM claim_predictions p JOIN claims c ON c.id = p.claim_id
      ORDER BY p.resolution_date, p.fixture_id`
  );
}

/** End of the scheduled resolution day, UTC — the latest a graded credence may be. */
function scheduledCutoff(resolutionDate: string): Date {
  return new Date(`${resolutionDate}T23:59:59.999Z`);
}

async function cmdSeed(): Promise<void> {
  const manifest = loadManifest();
  const dryRun = hasFlag("dry-run");
  const { rawQuery, getDb } = await import("../src/db/client.js");
  const { claims, claimPredictions } = await import("../src/db/schema.js");
  const { generateEmbedding } = await import("../src/services/embedding-service.js");
  const { createJob } = await import("../src/services/job-service.js");
  const { enqueueClaimPipeline } = await import("../src/services/queue-service.js");
  const { loadConfig } = await import("../src/config.js");

  const existing = new Set(
    (
      await rawQuery<{ fixture_id: string }>(
        `SELECT fixture_id FROM claim_predictions WHERE fixture_id IS NOT NULL`
      )
    ).map((r) => r.fixture_id)
  );

  let seeded = 0;
  for (const p of manifest.predictions) {
    if (existing.has(p.id)) {
      console.log(`  = ${p.id} (already seeded)`);
      continue;
    }
    if (dryRun) {
      console.log(`  + ${p.id} — would seed: ${p.claim}`);
      seeded++;
      continue;
    }
    let embedding: number[] | undefined;
    try {
      embedding = await generateEmbedding(p.claim);
    } catch (err) {
      console.warn(`  ${p.id}: embedding failed (${(err as Error).message}); seeding without one`);
    }
    const db = getDb();
    const [claim] = await db
      .insert(claims)
      .values({
        text: p.claim,
        claimType: "empirical_verifiable",
        embedding,
        pipelineEpoch: loadConfig().pipelineEpoch,
        createdBy: "prediction_seed",
      })
      .returning({ id: claims.id });
    await db.insert(claimPredictions).values({
      claimId: claim!.id,
      fixtureId: p.id,
      resolutionCriterion: p.resolutionCriterion,
      resolutionDate: p.resolutionDate,
      operationalization: p.operationalization,
      domain: p.domain ?? null,
    });
    // The same onboarding an API-proposed claim gets (claim-service
    // proposeClaim): a job to attribute the work, and the pipeline message
    // that hands the claim to its Steward.
    const job = await createJob("claim_pipeline", { claimId: claim!.id, prediction: p.id });
    await enqueueClaimPipeline({ claimId: claim!.id, jobId: job.id });
    console.log(`  + ${p.id} → claim ${claim!.id.slice(0, 8)} (resolves ${p.resolutionDate})`);
    seeded++;
  }
  console.log(`\n${dryRun ? "would seed" : "seeded"} ${seeded} of ${manifest.predictions.length} predictions`);

  if (!dryRun && hasFlag("drain")) {
    if (!hasFlag("corpus")) throw new Error("--drain is only for --corpus runs (the local queues)");
    const { drainLocalQueues } = await import("../src/workers/local-runner.js");
    console.log("\nDraining local queues (the corpus Steward assesses the seeds now)…");
    const stats = await drainLocalQueues({});
    console.log(
      `  processed: ${Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`).join(", ") || "nothing"}` +
        (stats.capped ? " (CAPPED)" : "")
    );
  }
}

async function cmdList(): Promise<void> {
  const { frozenCredence } = await import("./corpus/prediction-score.js");
  const manifest = loadManifest();
  const rows = await loadRows();
  const byFixture = new Map(rows.map((r) => [r.fixture_id, r]));
  const now = new Date();
  const line = (id: string, status: string, detail: string) =>
    console.log(`  ${id.padEnd(40)} ${status.padEnd(10)} ${detail}`);

  console.log(`  ${"prediction".padEnd(40)} ${"status".padEnd(10)} detail`);
  for (const p of manifest.predictions) {
    const r = byFixture.get(p.id);
    if (!r) {
      line(p.id, "unseeded", `resolves ${p.resolutionDate}`);
      continue;
    }
    const history = (r.history ?? []).map((h) => ({
      credence: h.credence,
      assessedAt: new Date(h.assessedAt),
    }));
    if (r.resolved_at) {
      const cutoff = new Date(Math.min(new Date(r.resolved_at).getTime(), scheduledCutoff(r.resolution_date).getTime()));
      const c = frozenCredence(history, cutoff);
      line(
        p.id,
        "resolved",
        `${r.outcome ? "YES" : "NO"} · credence ${c ? c.credence.toFixed(2) : "none stated"}` +
          (r.baseline_probability != null ? ` · baseline ${r.baseline_probability.toFixed(2)}` : "")
      );
      continue;
    }
    const latest = frozenCredence(history, now);
    const due = scheduledCutoff(r.resolution_date).getTime() < now.getTime();
    line(
      p.id,
      due ? "due" : latest ? "forecast" : "pending",
      (latest ? `credence ${latest.credence.toFixed(2)} (${latest.assessedAt.toISOString().slice(0, 10)})` : "no credence yet") +
        ` · resolves ${r.resolution_date}` +
        (r.baseline_probability != null ? ` · baseline ${r.baseline_probability.toFixed(2)}` : "")
    );
  }
  const extra = rows.filter((r) => !r.fixture_id);
  for (const r of extra) line(r.claim_id.slice(0, 8), "no-fixture", r.text.slice(0, 60));
}

async function cmdResolve(): Promise<void> {
  const [, ref, answer] = positionals();
  if (!ref || !answer || !/^(yes|no)$/i.test(answer)) {
    throw new Error("usage: predictions resolve <fixture-id|claim-id> yes|no [--note=…] [--by=…]");
  }
  const { rawQuery } = await import("../src/db/client.js");
  const outcome = /^yes$/i.test(answer);
  const rows = await rawQuery<{ claim_id: string; fixture_id: string | null; resolved_at: string | null }>(
    `SELECT claim_id, fixture_id, resolved_at FROM claim_predictions
      WHERE fixture_id = $1 OR claim_id::text = $1`,
    [ref]
  );
  if (rows.length !== 1) throw new Error(`no unique prediction matches "${ref}"`);
  const row = rows[0]!;
  if (row.resolved_at && !hasFlag("force")) {
    throw new Error(`${ref} already resolved at ${row.resolved_at}; pass --force to overwrite`);
  }
  await rawQuery(
    `UPDATE claim_predictions
        SET outcome = $2, resolved_at = now(), resolution_note = $3, resolved_by = $4
      WHERE claim_id = $1`,
    [row.claim_id, outcome, argFlag("note") ?? null, argFlag("by") ?? "manual"]
  );
  console.log(`✓ ${row.fixture_id ?? row.claim_id} resolved ${outcome ? "YES" : "NO"}`);
}

async function cmdImportBaselines(): Promise<void> {
  const [, file] = positionals();
  if (!file || !existsSync(file)) throw new Error("usage: predictions import-baselines <file.json>");
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    { probability: number; source?: string; at?: string }
  >;
  const { rawQuery } = await import("../src/db/client.js");
  let n = 0;
  for (const [id, b] of Object.entries(data)) {
    if (typeof b.probability !== "number" || b.probability < 0 || b.probability > 1) {
      throw new Error(`${id}: probability must be in [0, 1]`);
    }
    const updated = await rawQuery<{ claim_id: string }>(
      `UPDATE claim_predictions
          SET baseline_probability = $2, baseline_source = $3, baseline_at = $4
        WHERE fixture_id = $1 RETURNING claim_id`,
      [id, b.probability, b.source ?? null, b.at ? new Date(b.at) : new Date()]
    );
    if (updated.length === 0) console.warn(`  ${id}: not seeded here, skipped`);
    else n++;
  }
  console.log(`✓ baselines attached to ${n} prediction(s)`);
}

async function cmdScore(): Promise<void> {
  const { frozenCredence, scoreCalibration } = await import("./corpus/prediction-score.js");
  const rows = await loadRows();
  const resolved = rows.filter((r) => r.resolved_at && r.outcome !== null);
  const scored: Array<{ id: string; credence: number; outcome: boolean; baseline: number | null; domain: string | null }> = [];
  const unforecast: string[] = [];
  for (const r of resolved) {
    const history = (r.history ?? []).map((h) => ({ credence: h.credence, assessedAt: new Date(h.assessedAt) }));
    const cutoff = new Date(Math.min(new Date(r.resolved_at!).getTime(), scheduledCutoff(r.resolution_date).getTime()));
    const c = frozenCredence(history, cutoff);
    if (!c) {
      unforecast.push(r.fixture_id ?? r.claim_id);
      continue;
    }
    scored.push({
      id: r.fixture_id ?? r.claim_id,
      credence: c.credence,
      outcome: r.outcome!,
      baseline: r.baseline_probability,
      domain: r.domain,
    });
  }
  const report = scoreCalibration(scored);
  const open = rows.length - resolved.length;
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));

  console.log(`\nPrediction calibration — ${rows.length} seeded, ${resolved.length} resolved, ${open} open`);
  console.log(`  scored: ${report.minerval.n}` + (unforecast.length ? ` (${unforecast.length} resolved without a stated credence: ${unforecast.join(", ")})` : ""));
  console.log(`  Brier ${f(report.minerval.brier)} · log score ${f(report.minerval.logScore)} · ECE ${f(report.minerval.ece)} · base rate ${f(report.baseRate)}`);
  if (report.comparative) {
    const c = report.comparative;
    console.log(
      `  vs baseline (n=${c.baseline.n}): Minerval Brier ${f(c.minerval.brier)} · baseline Brier ${f(c.baseline.brier)}` +
        ` · Minerval log ${f(c.minerval.logScore)} · baseline log ${f(c.baseline.logScore)}`
    );
  } else {
    console.log("  no baselines attached — the Minerval-vs-crowd comparative needs `import-baselines`");
  }
  if (report.minerval.n > 0) {
    console.log("  calibration curve (credence bucket → realized):");
    for (const b of report.curve) {
      if (b.n === 0) continue;
      console.log(`    ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  n=${b.n}  mean ${b.meanCredence!.toFixed(2)} → realized ${b.realized!.toFixed(2)}`);
    }
    console.log("  by domain:");
    for (const [d, s] of Object.entries(report.byDomain)) {
      console.log(`    ${d.padEnd(12)} n=${s.n}  Brier ${f(s.brier)}`);
    }
  }
  const out = argFlag("out");
  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), seeded: rows.length, resolved: resolved.length, unforecast, items: scored, report }, null, 2));
    console.log(`  written: ${out}`);
  }
  console.log();
}

async function main(): Promise<void> {
  if (hasFlag("corpus")) {
    // Pin DATABASE_URL to the isolated corpus DB before any src module loads
    // config; lib.ts also honours --profile.
    await import("./corpus/lib.js");
  } else {
    (await import("dotenv")).config();
  }
  const [command] = positionals();
  switch (command) {
    case "seed":
      return cmdSeed();
    case "list":
      return cmdList();
    case "resolve":
      return cmdResolve();
    case "import-baselines":
      return cmdImportBaselines();
    case "score":
      return cmdScore();
    default:
      console.error(
        "usage: predictions <seed|list|resolve|import-baselines|score> [--corpus] [--dry-run] [--drain] [--out=FILE]"
      );
      process.exit(1);
  }
}

main()
  .then(async () => {
    const { closeDb } = await import("../src/db/client.js");
    await closeDb().catch(() => {});
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    const { closeDb } = await import("../src/db/client.js");
    await closeDb().catch(() => {});
    process.exit(1);
  });
