/**
 * Model adoption runner (#334 S7 / #324 "adopt"): a candidate model runs
 * one agent's eval suite with the judge pinned, and its quality per dollar
 * is set against the incumbent's, in one line: adopt / hold / reject —
 * human decides.
 *
 *   npm run corpus:adopt -- --agent=matcher --model=<id>                  # golden pairs, candidate vs incumbent
 *   npm run corpus:adopt -- --agent=matcher --model=<id> --cluster=lableak # + a model swap on the cluster
 *   npm run corpus:adopt -- --agent=steward --model=<id> --cluster=eggs --baseline=<snapshot> --profile=production
 *   npm run corpus:adopt -- … --dry-run                                    # print the plan
 *
 * The incumbent is the agent's configured model after the profile
 * (--profile=production: the pin in infra/lib/api-stack.ts). Each suite is
 * a child process (arms.ts runChild), because config caches on first read;
 * the golden runs write golden-report.json under runs/golden-matcher-<stamp>
 * and the swap writes swap.json under runs/swap-<stamp>, which this reads
 * back. JUDGE_MODEL is
 * not touched: whatever judge the suites use, both sides get the same one.
 * Registered as kind 'adopt'; the record lands in runs/adopt-<stamp>/adopt.json.
 *
 * A swap is two full drains of the cluster (or one with --baseline); the
 * golden pairs are cents. Budget accordingly.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_PROFILE, gitCommit, hasFlag, RUNS_ROOT } from "./lib.js";
import { runChild } from "./arms.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { resolveProvider } from "../../src/llm/providers/routing.js";
import { buildAdoptPlan, summarizeAdoption, type AdoptAgent, type GoldenArm } from "./adopt-lib.js";
import { envVarFor, type SwapSummary } from "./swap-lib.js";

interface GoldenReport {
  matcherModel: string;
  summary: { total: number; passed: number; passRate: number };
  costMicroUsd: number;
}

/** The newest report file of a given run-dir prefix written since `since`. */
function latestReport<T>(prefix: string, file: string, since: Date): T {
  if (!existsSync(RUNS_ROOT)) throw new Error(`no runs directory at ${RUNS_ROOT}`);
  const dirs = readdirSync(RUNS_ROOT)
    .filter((d) => d.startsWith(prefix) && existsSync(join(RUNS_ROOT, d, file)))
    .map((d) => ({ d, mtime: statSync(join(RUNS_ROOT, d, file)).mtimeMs }))
    .filter((x) => x.mtime >= since.getTime() - 5_000)
    .sort((x, y) => y.mtime - x.mtime);
  const hit = dirs[0];
  if (!hit) throw new Error(`no ${prefix}*/${file} written since ${since.toISOString()} under ${RUNS_ROOT}`);
  return JSON.parse(readFileSync(join(RUNS_ROOT, hit.d, file), "utf8")) as T;
}

function incumbentFor(agent: AdoptAgent): string {
  const cfg = loadConfig();
  switch (agent) {
    case "extractor":
      return cfg.extractorModel;
    case "matcher":
      return cfg.matcherModel;
    case "steward":
      return cfg.stewardModel;
    case "curator":
      return cfg.curatorModel;
  }
}

async function main(): Promise<void> {
  assertCorpusDb();
  const agent = argFlag("agent") as AdoptAgent | undefined;
  const model = argFlag("model");
  if (!agent || !model) {
    console.error(
      "Usage: corpus:adopt -- --agent=<matcher|steward|extractor|curator> --model=<id> [--cluster=<cluster>] [--baseline=<snapshot>] [--profile=production] [--limit=N] [--dry-run]"
    );
    process.exit(1);
  }
  envVarFor(agent); // validates
  if (!resolveProvider(model)) throw new Error(`"${model}" does not resolve to a provider`);
  const incumbent = incumbentFor(agent);
  const cluster = argFlag("cluster") ?? null;
  const baseline = argFlag("baseline") ?? null;
  const limitRaw = argFlag("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  const plan = buildAdoptPlan({ agent, model, incumbent, cluster, profile: CORPUS_PROFILE, baselineSnapshot: baseline, limit });

  console.log(`\n=== adopt: ${agent} ${incumbent} → ${model}` + (cluster ? ` · cluster ${cluster}` : "") + (CORPUS_PROFILE ? ` · profile ${CORPUS_PROFILE}` : "") + " ===");
  if (model === incumbent) console.log("  note: the candidate IS the incumbent; this measures the suite's own noise.");
  for (const child of plan) console.log(`  ${child.role.padEnd(17)} ${child.script} ${child.args.join(" ")}`);
  if (hasFlag("dry-run")) {
    console.log("  --dry-run: nothing run.");
    return;
  }

  let golden: { candidate: GoldenArm; incumbent: GoldenArm } | null = null;
  let swap: SwapSummary | null = null;
  const arms: Partial<Record<"golden-candidate" | "golden-incumbent", GoldenArm>> = {};
  for (const child of plan) {
    const started = new Date();
    console.log(`\n--- ${child.role} ---`);
    runChild(child.script, child.args, child.env);
    if (child.role === "swap") {
      const rec = latestReport<{ summary: SwapSummary }>("swap-", "swap.json", started);
      swap = rec.summary;
    } else {
      const rep = latestReport<GoldenReport>("golden-matcher-", "golden-report.json", started);
      arms[child.role] = {
        model: rep.matcherModel,
        passRate: rep.summary.passRate,
        passed: rep.summary.passed,
        total: rep.summary.total,
        costMicroUsd: rep.costMicroUsd,
      };
    }
  }
  if (arms["golden-candidate"] && arms["golden-incumbent"]) {
    golden = { candidate: arms["golden-candidate"], incumbent: arms["golden-incumbent"] };
  }

  const summary = summarizeAdoption({ agent, candidate: model, incumbent, golden, swap });
  console.log(`\n=== adoption summary: ${agent} ${incumbent} → ${model} ===`);
  console.log(`  ${summary.reading}`);
  console.log(`  RECOMMENDATION: ${summary.recommendation.toUpperCase()} — human decides.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_ROOT, `adopt-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const record = { generatedAt: new Date().toISOString(), kind: "adopt", summary, plan, cluster, profile: CORPUS_PROFILE, gitCommit: gitCommit() };
  writeFileSync(join(outDir, "adopt.json"), JSON.stringify(record, null, 2));
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster: cluster ?? "golden-matcher",
      kind: "adopt",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: record.gitCommit,
        profile: CORPUS_PROFILE,
        adopt: { agent, candidate: model, incumbent },
        models: { [agent]: incumbent, judge: cfg.judgeModel },
      },
      scorecard: record,
      runDir: outDir,
    });
  } catch (err) {
    console.warn("[adopt] eval-run registry write failed (adopt.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log(`  written: ${join(outDir, "adopt.json")}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
