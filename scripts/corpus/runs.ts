/**
 * List the eval-run registry (#334 L1): recent scored runs with their config
 * fingerprint and headline metrics, newest first. History is a table, so
 * "what happened to the claim-bar rate across the last five runs" is this
 * command plus corpus:compare, not file archaeology.
 *
 * Usage:
 *   npm run corpus:runs                     # last 20, all clusters
 *   npm run corpus:runs -- lableak          # one cluster
 *   npm run corpus:runs -- --limit=50
 *
 * Compare any two listed runs:
 *   npm run corpus:compare -- db:<idA> db:<idB>
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { argFlag, assertCorpusDb, positional } from "./lib.js";
import { closeDb, rawQuery } from "../../src/db/client.js";
import type { Scorecard } from "./score.js";

interface EvalRunRow {
  id: string;
  cluster: string;
  kind: string;
  config: Scorecard["config"];
  scorecard: Scorecard | null;
  created_at: string;
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cluster = positional(0);
  const limit = Math.min(Number(argFlag("limit") ?? 20) || 20, 200);

  const rows = await rawQuery<EvalRunRow>(
    `SELECT id, cluster, kind, config, scorecard, created_at
       FROM eval_runs
      WHERE ($1::text IS NULL OR cluster = $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [cluster ?? null, limit]
  );

  if (rows.length === 0) {
    console.log("(no registered eval runs — corpus:score writes them)");
    return;
  }

  console.log(
    `  ${"id".padEnd(8)} ${"when".padEnd(16)} ${"cluster".padEnd(12)} ` +
      `${"epoch".padEnd(24)} ${"commit".padEnd(8)} ${"claims".padStart(6)} ` +
      `${"dedup".padStart(6)} ${"bar%".padStart(5)} ${"read".padStart(5)}`
  );
  for (const row of rows) {
    const s = row.scorecard;
    const st = s?.structural;
    const j = s?.judged;
    console.log(
      `  ${row.id.slice(0, 8)} ` +
        `${new Date(row.created_at).toISOString().slice(0, 16).padEnd(16)} ` +
        `${row.cluster.padEnd(12)} ` +
        `${(row.config?.pipelineEpoch ?? "?").padEnd(24)} ` +
        `${(row.config?.gitCommit ?? "?").padEnd(8)} ` +
        `${String(st?.extraction.totalClaims ?? "—").padStart(6)} ` +
        `${(st?.matching.dedupRatio?.toFixed(2) ?? "—").padStart(6)} ` +
        `${(j ? Math.round(j.claimBarPassRate * 100) + "%" : "—").padStart(5)} ` +
        `${(j ? j.assessmentQuality.readability.toFixed(1) : "—").padStart(5)}`
    );
  }
  console.log(
    `\n  compare two: npm run corpus:compare -- db:<idA> db:<idB>` +
      `\n  (one run is one sample — N≈3 before trusting a delta)`
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
