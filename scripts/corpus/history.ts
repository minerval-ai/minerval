/**
 * Assessment-history properties (#334 S3 tier 2, from #295 (g)/(h)) — the
 * driver for history-lib.ts: evidence monotonicity and overturn-rate
 * discrimination, read off a graph's assessment history and its accepted
 * contributions. No LLM, no second arm.
 *
 * Usage:
 *   npm run corpus:history                         # the live corpus DB
 *   npm run corpus:history -- snap:<name> [--since=<iso>] [--material=0.1] [--min-bin=5] [--out=FILE]
 *
 * Run it after corpus:contributions (which supplies the accepted supports
 * and challenges) and after anything that reassesses claims (a staleness
 * sweep, corpus:property fixpoint) — a graph straight out of one ingest has
 * no reassessments to read. Writes runs/history-<stamp>/history.json and
 * registers the result (kind 'history').
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, gitCommit, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { resolveDbRef } from "./cascade.js";
import { analyzeHistory, renderHistory } from "./history-lib.js";
import { loadHistoryInput } from "./cascade-load.js";

async function main(): Promise<void> {
  assertCorpusDb();
  const target = resolveDbRef(positional(0));
  const since = argFlag("since") ?? null;
  if (since && Number.isNaN(new Date(since).getTime())) throw new Error(`--since must be an ISO timestamp, got "${since}"`);
  const material = argFlag("material") !== undefined ? Number(argFlag("material")) : 0.1;
  if (!(material > 0 && material <= 1)) throw new Error(`--material must be in (0, 1], got "${argFlag("material")}"`);
  const minBin = argFlag("min-bin") !== undefined ? Number(argFlag("min-bin")) : 5;

  const input = await loadHistoryInput(target.url, { since });
  const report = analyzeHistory(input, { materialCredenceDelta: material, minBin });
  console.log();
  console.log(renderHistory(report));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_ROOT, `history-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const record = { generatedAt: new Date().toISOString(), target: target.label, since, material, minBin, report };
  const out = argFlag("out") ?? join(outDir, "history.json");
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`  written: ${out}`);
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster: "history",
      kind: "history",
      config: { pipelineEpoch: cfg.pipelineEpoch, gitCommit: gitCommit(), target: target.label, since, material, minBin },
      scorecard: record,
      runDir: outDir,
    });
  } catch (err) {
    console.warn("[history] eval-run registry write failed (history.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log();
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
