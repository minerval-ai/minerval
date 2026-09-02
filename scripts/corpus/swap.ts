/**
 * Model-swap runner (#334 L1; the substrate for S7's fidelity-vs-reference
 * and #295's model-convergence). Two arms of one cluster: A on the current
 * configuration (the reference — with --profile=production, what production
 * runs), B identical except ONE agent on another model. Each arm is a child
 * corpus:run in its own process (config caches on first read, so the
 * override must be in place before it), each arm is snapshotted, and the
 * two snapshots are compared with corpus:agreement. The answer is fidelity:
 * how close the swapped model's graph is to the reference on claim set,
 * credence and structure — per-agent tiering data for allocation (§6).
 *
 * Usage:
 *   npm run corpus:swap -- <cluster> --agent=<extractor|matcher|steward|curator> --model=<id>
 *       [--profile=production] [--limit=N] [--posts=id1,id2]
 *       [--baseline=<snapshot>]   # reuse an existing snapshot as arm A
 *       [--confirm]               # judge the ambiguous pairs in the comparison
 *       [--dry-run]               # print the arm commands and exit
 *
 * Example — is DeepSeek's Matcher faithful to a Haiku Matcher on lableak?
 *   npm run corpus:swap -- lableak --agent=matcher --model=claude-haiku-4-5-20251001 --profile=production
 *
 * Both arms are real runs: budget accordingly (two full drains of the
 * cluster). Snapshots swap_<stamp>_a / _b are kept — they are the evidence.
 * The result is registered in the eval-run registry (kind 'swap') with both
 * arms' fingerprints and the agreement report, and written to
 * runs/swap-<stamp>/swap.json.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_DATABASE_URL, CORPUS_PROFILE, gitCommit, hasFlag, positional, REPO_ROOT, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { resolveProvider } from "../../src/llm/providers/routing.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { saveSnapshot } from "./snapshot-core.js";
import {
  armSnapshotNames,
  buildArmCommands,
  envVarFor,
  summarizeSwap,
  type ArmRecord,
  type SwappableAgent,
} from "./swap-lib.js";
import type { AgreementReport } from "./graph-agreement.js";

function runChild(script: string, args: string[], env: Record<string, string>): void {
  const result = spawnSync("npx", ["tsx", script, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env, CORPUS_DATABASE_URL },
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

/** The run.json of the newest run dir for `cluster` started at or after `since`. */
function latestRunRecord(cluster: string, since: Date): ArmRecord {
  const dirs = readdirSync(RUNS_ROOT)
    .filter((d) => d.startsWith(`${cluster}-`) && existsSync(join(RUNS_ROOT, d, "run.json")))
    .map((d) => ({ d, mtime: statSync(join(RUNS_ROOT, d, "run.json")).mtimeMs }))
    .sort((x, y) => y.mtime - x.mtime);
  for (const { d } of dirs) {
    const rec = JSON.parse(readFileSync(join(RUNS_ROOT, d, "run.json"), "utf8")) as ArmRecord;
    if (new Date(rec.startedAt).getTime() >= since.getTime() - 5_000) return rec;
  }
  throw new Error(`no run.json for ${cluster} written since ${since.toISOString()} under ${RUNS_ROOT}`);
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cluster = positional(0);
  const agent = argFlag("agent") as SwappableAgent | undefined;
  const model = argFlag("model");
  if (!cluster || !agent || !model) {
    console.error(
      "Usage: corpus:swap -- <cluster> --agent=<extractor|matcher|steward|curator> --model=<id> " +
        "[--profile=production] [--limit=N] [--posts=…] [--baseline=<snapshot>] [--confirm] [--dry-run]"
    );
    process.exit(1);
  }
  envVarFor(agent); // validates
  if (!resolveProvider(model)) throw new Error(`"${model}" does not resolve to a provider`);

  const limitRaw = argFlag("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  const posts = argFlag("posts")?.split(",").map((s) => s.trim()).filter(Boolean);
  const baseline = argFlag("baseline") ?? null;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 12);
  const names = armSnapshotNames(stamp);
  const arms = buildArmCommands({ cluster, agent, model, profile: CORPUS_PROFILE, limit, posts, baselineSnapshot: baseline });

  console.log(`\n=== model swap: ${cluster} · ${agent} → ${model}` + (CORPUS_PROFILE ? ` · profile ${CORPUS_PROFILE}` : "") + " ===");
  for (const arm of arms) {
    console.log(`  arm ${arm.arm}: corpus:run ${arm.args.join(" ")}` + (Object.keys(arm.env).length ? `  (env ${Object.entries(arm.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""));
  }
  console.log(`  snapshots: ${baseline ?? names.a} (reference) · ${names.b} (swap)`);
  if (hasFlag("dry-run")) {
    console.log("  --dry-run: nothing run.");
    return;
  }

  let armA: ArmRecord | null = null;
  let armB: ArmRecord | null = null;
  let snapA = baseline;
  for (const arm of arms) {
    const started = new Date();
    console.log(`\n--- arm ${arm.arm} ---`);
    runChild("scripts/corpus/run.ts", arm.args, arm.env);
    const rec = latestRunRecord(cluster, started);
    const snap = arm.arm === "a" ? names.a : names.b;
    await saveSnapshot(CORPUS_DATABASE_URL, snap);
    console.log(`  arm ${arm.arm}: ${rec.postsIngested} post(s), ${rec.costMicroUsd != null ? formatMicroUsd(rec.costMicroUsd) : "cost n/a"}${rec.capped ? ", CAPPED" : ""} → snapshot ${snap}`);
    if (arm.arm === "a") {
      armA = rec;
      snapA = names.a;
    } else {
      armB = rec;
    }
  }
  if (!armB || !snapA) throw new Error("the swap arm did not produce a run record");

  const outDir = join(RUNS_ROOT, `swap-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const agreementPath = join(outDir, "agreement.json");
  console.log(`\n--- agreement: snap:${snapA} vs snap:${names.b} ---`);
  runChild(
    "scripts/corpus/agreement.ts",
    [`snap:${snapA}`, `snap:${names.b}`, `--out=${agreementPath}`, ...(hasFlag("confirm") ? ["--confirm"] : [])],
    {}
  );
  const agreement = JSON.parse(readFileSync(agreementPath, "utf8")) as { report: AgreementReport };
  const summary = summarizeSwap({ cluster, agent, swapModel: model, armA, armB, agreement: agreement.report });

  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  console.log(`\n=== swap summary: ${agent} ${summary.referenceModel} → ${summary.swapModel} on ${cluster} ===`);
  console.log(`  claim-set F1 ${f(summary.claimSetF1)} · credence mean |Δ| ${f(summary.credenceMeanAbsDiff)} · status agreement ${f(summary.statusAgreement)} · edge edit distance ${summary.edgeEditDistance}`);
  console.log(`  cost: reference ${summary.cost.a != null ? formatMicroUsd(summary.cost.a) : "n/a"} · swap ${summary.cost.b != null ? formatMicroUsd(summary.cost.b) : "n/a"}`);
  console.log(`  observed ${agent}: reference ${summary.observed.a.join(", ") || "?"} · swap ${summary.observed.b.join(", ") || "?"}`);
  console.log("  one swap is one sample of each arm: repeat before reading a difference as the model's (corpus/SCORING.md).");

  const record = { generatedAt: new Date().toISOString(), summary, arms: { a: armA, b: armB }, snapshots: { a: snapA, b: names.b }, agreement };
  writeFileSync(join(outDir, "swap.json"), JSON.stringify(record, null, 2));
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster,
      kind: "swap",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: gitCommit(),
        profile: CORPUS_PROFILE,
        swap: { agent, model },
        models: { ...(armA?.models ?? armB.models), judge: cfg.judgeModel },
        snapshots: { a: snapA, b: names.b },
      },
      scorecard: record,
      runDir: outDir,
    });
  } catch (err) {
    console.warn("[swap] eval-run registry write failed (swap.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log(`  written: ${join(outDir, "swap.json")}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
