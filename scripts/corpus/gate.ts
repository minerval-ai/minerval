/**
 * Epoch-bump gate (#334 L4, from #137.3): compare a cluster's candidate
 * scorecards against its committed baseline group with the noise-band rule
 * and fail on a regression of a gated headline metric.
 *
 *   npm run corpus:gate -- blackholes
 *   npm run corpus:gate -- blackholes --baseline=<A1>.json,<A2>.json --candidate=<B1>.json,<B2>.json
 *   npm run corpus:gate -- blackholes --candidate=latest --min-n=2
 *   npm run corpus:gate -- blackholes --gated=claim-bar,coherence,dedup,trace
 *   npm run corpus:gate -- blackholes --json
 *
 * Reads only the committed history in corpus/scorecards/<cluster>/ (no DB,
 * no LLM). Baseline: --baseline, else corpus/scorecards/<cluster>/baselines.json
 * ({"epoch": "…", "files": [...]}), else the earliest runs sharing the
 * earliest run's epoch and profile. Candidate: --candidate, else the newest
 * runs outside the baseline sharing the newest run's fingerprint.
 *
 * Exit 1 only on a regression of a gated metric with both sides ≥ --min-n
 * (default 2) and the same profile and epoch. Too few runs, or sides that
 * differ in profile or epoch, are a refusal to gate: the deltas print, the
 * message says why there is no verdict, and the exit is 0.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scorecard } from "./score.js";
import {
  BASELINES_FILE,
  evaluateGate,
  renderGate,
  resolveGated,
  selectGroups,
  type BaselinesSpec,
  type ScorecardFile,
} from "./gate-lib.js";

// No lib.js import: the gate never touches a database, and lib.js pins one.
const here = dirname(fileURLToPath(import.meta.url));
const SCORECARDS_ROOT = resolve(here, "..", "..", "corpus", "scorecards");

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function loadCluster(cluster: string): { files: ScorecardFile[]; baselines: BaselinesSpec | null } {
  const dir = join(SCORECARDS_ROOT, cluster);
  if (!existsSync(dir)) throw new Error(`no committed scorecards for "${cluster}" under ${SCORECARDS_ROOT}`);
  const files: ScorecardFile[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== BASELINES_FILE).sort()) {
    const card = JSON.parse(readFileSync(join(dir, file), "utf8")) as Scorecard;
    if (!card?.config?.pipelineEpoch || !card.structural) {
      console.warn(`  skipping ${file}: not a scorecard`);
      continue;
    }
    files.push({ file, card });
  }
  const baselinesPath = join(dir, BASELINES_FILE);
  const baselines = existsSync(baselinesPath) ? (JSON.parse(readFileSync(baselinesPath, "utf8")) as BaselinesSpec) : null;
  return { files, baselines };
}

function main(): void {
  const cluster = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!cluster) {
    console.error("Usage: corpus:gate -- <cluster> [--baseline=<files>] [--candidate=<files|latest>] [--min-n=2] [--gated=<metrics>] [--json]");
    process.exit(1);
  }
  const minN = Math.max(1, Number(flag("min-n") ?? 2) || 2);
  const gated = resolveGated(flag("gated"));
  const { files, baselines } = loadCluster(cluster);
  const groups = selectGroups({ files, baselines, baselineArg: flag("baseline"), candidateArg: flag("candidate"), minN });
  const result = evaluateGate({ baseline: groups.baseline, candidate: groups.candidate, gated, minN });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ cluster, how: groups.how, ...result }, null, 2));
  } else {
    console.log(`\nEpoch-bump gate — ${cluster}`);
    console.log(`  baseline chosen by: ${groups.how.baseline}`);
    console.log(`  candidate chosen by: ${groups.how.candidate}`);
    console.log(`  gated: ${gated.join("; ")} · min-n ${minN}\n`);
    console.log(renderGate(result));
    console.log();
  }
  if (result.status === "gated" && !result.passed) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
