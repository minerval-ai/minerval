/**
 * Diff two corpus-run scorecards (#99) — the regression-tracking step.
 *
 * A single run is one nondeterministic sample, so a difference only matters if
 * it clears the noise. This prints the headline metric deltas between two
 * `scorecard.json` files so a prompt change can be judged as better/worse/noise
 * rather than eyeballed.
 *
 * Usage:  tsx scripts/corpus/compare.ts <refA> <refB>
 *
 * A ref is a run directory (containing scorecard.json), a scorecard.json path
 * — including files from the committed history in corpus/scorecards/ — or
 * `db:<id-prefix>` for a run in the eval-run registry (see corpus:runs).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Scorecard } from "./score.js";

async function load(ref: string): Promise<Scorecard> {
  if (ref.startsWith("db:")) return loadFromRegistry(ref.slice(3));
  const file = ref.endsWith(".json") ? ref : join(ref, "scorecard.json");
  if (!existsSync(file)) throw new Error(`no scorecard at ${file}`);
  return JSON.parse(readFileSync(file, "utf-8")) as Scorecard;
}

/**
 * Resolve a registry ref by id prefix. The DB modules load lazily so the
 * file-only path stays dependency-free (and lib.js pins the corpus DB before
 * any config caches).
 */
async function loadFromRegistry(idPrefix: string): Promise<Scorecard> {
  await import("./lib.js");
  const { rawQuery } = await import("../../src/db/client.js");
  if (!/^[0-9a-f-]{4,36}$/.test(idPrefix)) {
    throw new Error(`db: ref needs a hex id prefix (≥4 chars), got "${idPrefix}"`);
  }
  const rows = await rawQuery<{ id: string; scorecard: Scorecard | null }>(
    `SELECT id, scorecard FROM eval_runs WHERE id::text LIKE $1 || '%'
      ORDER BY created_at DESC LIMIT 2`,
    [idPrefix]
  );
  if (rows.length === 0) throw new Error(`no eval run matching db:${idPrefix}`);
  if (rows.length > 1) {
    throw new Error(`db:${idPrefix} is ambiguous — use more id characters`);
  }
  if (!rows[0]!.scorecard) throw new Error(`eval run ${rows[0]!.id} has no scorecard`);
  return rows[0]!.scorecard;
}

function delta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return `${fmt(a)} → ${fmt(b)}`;
  const d = b - a;
  const sign = d > 0 ? "+" : "";
  return `${fmt(a)} → ${fmt(b)}  (${sign}${Math.round(d * 100) / 100})`;
}
function fmt(x: number | null | undefined): string {
  return x == null ? "n/a" : String(Math.round(x * 100) / 100);
}

async function main() {
  const [aPath, bPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!aPath || !bPath) {
    console.error("Usage: tsx scripts/corpus/compare.ts <refA> <refB>  (ref = dir | file.json | db:<id>)");
    process.exit(1);
  }
  const a = await load(aPath);
  const b = await load(bPath);

  const rows: Array<[string, string]> = [
    ["A · claims per 1k words", delta(a.structural.extraction.claimsPer1kWords, b.structural.extraction.claimsPer1kWords)],
    ["B · canonical p90 words", delta(a.structural.canonicalForm.wordCount.p90, b.structural.canonicalForm.wordCount.p90)],
    ["B · share > 25 words", delta(a.structural.canonicalForm.overLongShare, b.structural.canonicalForm.overLongShare)],
    ["C · dedup ratio", delta(a.structural.matching.dedupRatio, b.structural.matching.dedupRatio)],
    ["D · max depth", delta(a.structural.decomposition.maxDepth, b.structural.decomposition.maxDepth)],
    ["D · atomic share", delta(a.structural.decomposition.atomicShare, b.structural.decomposition.atomicShare)],
    ["E · shared subclaims", delta(a.structural.crossDoc.sharedSubclaims, b.structural.crossDoc.sharedSubclaims)],
    ["F · % with trace", delta(a.structural.assessment.pctWithTrace, b.structural.assessment.pctWithTrace)],
    ["§21 · coherence violations", delta(a.structural.coherence?.violations, b.structural.coherence?.violations)],
    ["imp · mean", delta(a.structural.importance.mean, b.structural.importance.mean)],
    ["imp · atomic vs compound gap", delta(gap(a), gap(b))],
  ];
  if (a.judged && b.judged) {
    rows.push(
      ["judge · claim-bar pass-rate", delta(a.judged.claimBarPassRate, b.judged.claimBarPassRate)],
      ["judge · importance overrated share", delta(a.judged.importanceAlignment.overratedShare, b.judged.importanceAlignment.overratedShare)],
      ["judge · readability", delta(a.judged.assessmentQuality.readability, b.judged.assessmentQuality.readability)],
      ["judge · reasoning-fit", delta(a.judged.assessmentQuality.reasoningFit, b.judged.assessmentQuality.reasoningFit)],
      ["judge · impartiality", delta(a.judged.assessmentQuality.impartiality, b.judged.assessmentQuality.impartiality)]
    );
  }

  console.log(`\nScorecard diff — ${a.cluster}`);
  console.log(`  A: ${aPath}  (${a.generatedAt})`);
  console.log(`  B: ${bPath}  (${b.generatedAt})\n`);
  const wLabel = Math.max(...rows.map((r) => r[0].length));
  for (const [label, val] of rows) console.log(`  ${label.padEnd(wLabel)}  ${val}`);
  console.log(
    `\n  Note: one run is one sample. Treat a delta as real only if it repeats across N≈3 runs / exceeds run-to-run noise.\n`
  );
}

function gap(s: Scorecard): number | null {
  const at = s.structural.importance.meanAtomic;
  const co = s.structural.importance.meanCompound;
  return at == null || co == null ? null : at - co;
}

main()
  .then(async () => {
    // Close the pool iff a db: ref opened it (lazy import above).
    const { closeDb } = await import("../../src/db/client.js");
    await closeDb().catch(() => {});
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    const { closeDb } = await import("../../src/db/client.js");
    await closeDb().catch(() => {});
    process.exit(1);
  });
