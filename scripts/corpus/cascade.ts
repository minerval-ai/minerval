/**
 * Cascade stability (#334 S3, from #295 tier 1 (d)) — the driver for
 * cascade-lib.ts.
 *
 * Usage:
 *   npm run corpus:cascade                          # the live corpus DB, whole history
 *   npm run corpus:cascade -- snap:prop_202609_a    # a snapshot
 *   npm run corpus:cascade -- db --since=2026-09-18T10:00:00Z --material=0.15 --out=FILE
 *
 * Reconstructs the propagation trees from enqueue_events, agent_runs and the
 * assessment history (see the library for the rules), prints the per-
 * generation table, R, the cascade size/depth distribution, coalescing,
 * oscillations and the queue-drain shape, writes runs/cascade-<stamp>/
 * cascade.json and registers the result (kind 'cascade').
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_DATABASE_URL, gitCommit, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { dbNameOf, snapshotDbName } from "./snapshot-core.js";
import { analyzeCascade, cascadeHeadline, renderCascade } from "./cascade-lib.js";
import { loadCascadeInput } from "./cascade-load.js";

/** `db` | `snap:<name>` | postgresql://… — the same refs corpus:agreement takes. */
export function resolveDbRef(ref: string | undefined): { label: string; url: string } {
  if (!ref || ref === "db") return { label: `db:${dbNameOf(CORPUS_DATABASE_URL)}`, url: CORPUS_DATABASE_URL };
  if (ref.startsWith("snap:")) {
    const u = new URL(CORPUS_DATABASE_URL);
    u.pathname = `/${snapshotDbName(dbNameOf(CORPUS_DATABASE_URL), ref.slice(5))}`;
    return { label: ref, url: u.toString() };
  }
  if (/^postgres(ql)?:\/\//.test(ref)) return { label: `url:${dbNameOf(ref)}`, url: ref };
  throw new Error(`unknown ref "${ref}" (use db | snap:<name> | postgresql://…)`);
}

async function main(): Promise<void> {
  assertCorpusDb();
  const target = resolveDbRef(positional(0));
  const since = argFlag("since") ?? null;
  if (since && Number.isNaN(new Date(since).getTime())) throw new Error(`--since must be an ISO timestamp, got "${since}"`);
  const material = argFlag("material") !== undefined ? Number(argFlag("material")) : 0.1;
  if (!(material > 0 && material <= 1)) throw new Error(`--material must be in (0, 1], got "${argFlag("material")}"`);

  const input = await loadCascadeInput(target.url, { since });
  const report = analyzeCascade(input, { materialCredenceDelta: material });
  console.log();
  console.log(renderCascade(report));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_ROOT, `cascade-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const record = { generatedAt: new Date().toISOString(), target: target.label, since, material, headline: cascadeHeadline(report), report };
  const out = argFlag("out") ?? join(outDir, "cascade.json");
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`  written: ${out}`);
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster: "cascade",
      kind: "cascade",
      config: { pipelineEpoch: cfg.pipelineEpoch, gitCommit: gitCommit(), target: target.label, since, material },
      scorecard: record,
      runDir: outDir,
    });
  } catch (err) {
    console.warn("[cascade] eval-run registry write failed (cascade.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log();
}

if ((process.argv[1] ?? "").endsWith("cascade.ts")) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
