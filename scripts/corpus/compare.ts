/**
 * Compare corpus-run scorecards (#99, #334 L2) — the regression-tracking step.
 *
 * A single run is one nondeterministic sample, so a difference only matters if
 * it clears the noise. Each side of a comparison is therefore a GROUP of runs
 * of one configuration (N≈3); this prints, per headline metric, each side's
 * mean ± spread, the delta of means, and whether the delta clears the combined
 * spread (band.ts). A side with one run gets its delta printed and no
 * verdict: one sample cannot tell noise from change.
 *
 * Usage:  tsx scripts/corpus/compare.ts <groupA> <groupB>
 *
 * A group is one ref or several joined by commas. A ref is a run directory
 * (containing scorecard.json), a scorecard.json path — including files from
 * the committed history in corpus/scorecards/ — or `db:<id-prefix>` for a
 * run in the eval-run registry (see corpus:runs).
 *
 *   npm run corpus:compare -- runs/A runs/B
 *   npm run corpus:compare -- db:1a2b,db:3c4d,db:5e6f db:7a8b,db:9c0d,db:1e2f
 *   npm run corpus:compare -- corpus/scorecards/blackholes/2026-08-09*.json runs/B
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Scorecard } from "./score.js";
import { compareScorecards, formatDelta, formatSide, formatVerdict } from "./band.js";

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

function splitGroup(arg: string): string[] {
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** One line per distinct fingerprint in a group, so a mixed group is visible. */
function describeGroup(cards: Scorecard[]): string[] {
  const seen = new Map<string, number>();
  for (const s of cards) {
    const steward = s.config.observed?.steward?.[0] ?? s.config.models.steward;
    const key =
      `epoch ${s.config.pipelineEpoch} · commit ${s.config.gitCommit ?? "?"} · ` +
      `steward ${steward} · judge ${s.config.models.judge}` +
      (s.config.modelsSource === "score-time" ? " · models at score-time" : "");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k));
}

async function main() {
  const [aArg, bArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!aArg || !bArg) {
    console.error(
      "Usage: tsx scripts/corpus/compare.ts <groupA> <groupB>  " +
        "(group = ref[,ref…]; ref = dir | file.json | db:<id>)"
    );
    process.exit(1);
  }
  const aRefs = splitGroup(aArg);
  const bRefs = splitGroup(bArg);
  const a = await Promise.all(aRefs.map(load));
  const b = await Promise.all(bRefs.map(load));

  const clusters = new Set([...a, ...b].map((s) => s.cluster));
  console.log(`\nScorecard comparison — ${[...clusters].join(", ")}`);
  if (clusters.size > 1) console.log("  warning: sides span different clusters");
  console.log(`  A (n=${a.length}): ${aRefs.join(", ")}`);
  for (const line of describeGroup(a)) console.log(`      ${line}`);
  console.log(`  B (n=${b.length}): ${bRefs.join(", ")}`);
  for (const line of describeGroup(b)) console.log(`      ${line}`);
  console.log();

  const rows = compareScorecards(a, b).filter((r) => r.verdict !== "n/a");
  const wLabel = Math.max(...rows.map((r) => r.label.length));
  const wSide = 16;
  console.log(
    `  ${"metric".padEnd(wLabel)}  ${"A".padStart(wSide)}  ${"B".padStart(wSide)}  ${"delta".padStart(7)}  verdict`
  );
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(wLabel)}  ${formatSide(r.a).padStart(wSide)}  ` +
        `${formatSide(r.b).padStart(wSide)}  ${formatDelta(r).padStart(7)}  ${formatVerdict(r)}`
    );
  }

  const single = rows.some((r) => r.verdict === "single-sample");
  const oneSided = rows.some((r) => r.oneSided);
  console.log();
  console.log(
    "  A delta CLEARS the band when |Δ mean| exceeds sdA + sdB (sample sd; N≈3 per side)."
  );
  if (single) {
    console.log(
      "  One run is one sample: rows marked single-sample carry no verdict. Run each side ≥2× (3 is the norm)."
    );
  }
  if (oneSided) {
    console.log(
      "  One-sided verdicts lean on one side's spread alone — weaker evidence than a two-sided band."
    );
  }
  console.log();
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
