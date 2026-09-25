/**
 * Contribution driver CLI (#334 L1): submit a scenario of contributions and
 * appeals against the graph in the corpus DB, through the real Contribution
 * Reviewer, escalation and Dispute Arbitrator pipelines, and report what
 * happened. The never-exercised half of the organization, exercised.
 *
 * Usage:
 *   npm run corpus:contributions -- <scenario> [--dry-run] [--no-appeals] [--limit=N]
 *
 * <scenario> names corpus/contributions/<scenario>.json. Run it against a
 * graph a corpus run produced (targets are resolved by search). See the
 * README there for what a scenario is and what the report contains. The
 * submit-and-drain core is contribution-driver.ts, shared with the
 * adversarial suite (S4).
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_ROOT, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { renderReport, summarizeOutcomes, validateScenario, type Scenario } from "./contributions-lib.js";
import { runScenario } from "./contribution-driver.js";

async function main(): Promise<void> {
  assertCorpusDb();
  const name = positional(0);
  if (!name) {
    console.error("Usage: corpus:contributions -- <scenario> [--dry-run] [--no-appeals] [--limit=N]");
    process.exit(1);
  }
  const path = join(CORPUS_ROOT, "contributions", `${name}.json`);
  const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
  const problems = validateScenario(scenario);
  if (problems.length) {
    console.error("Scenario invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  const limit = argFlag("limit") ? Number(argFlag("limit")) : undefined;
  const items = limit ? scenario.contributions.slice(0, limit) : scenario.contributions;
  const dryRun = hasFlag("dry-run");

  const claimCount =
    (await rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM claims WHERE state = 'active'`))[0]?.n ?? 0;
  if (claimCount === 0) throw new Error("the corpus DB has no claims — run a corpus run for this cluster first");

  console.log(`\n=== contribution scenario: ${scenario.scenario} — ${items.length} contribution(s) against ${claimCount} claims ===`);

  const result = await runScenario(scenario, { dryRun, appeals: !hasFlag("no-appeals"), limit });
  if (dryRun) {
    console.log("\n  --dry-run: nothing submitted.");
    return;
  }

  const { outcomes, trace } = result;
  const reputation = result.personas.map((p) => ({
    key: p.key,
    displayName: p.displayName,
    tier: p.tier,
    before: p.reputationBefore,
    after: p.reputationAfter,
    standing: p.standing,
  }));
  const costMicroUsd = result.cost.microUsd;
  const summary = summarizeOutcomes(outcomes);
  const generatedAt = new Date().toISOString();

  const stamp = generatedAt.replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `contrib-${scenario.scenario}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trace.jsonl"), trace.map((e) => JSON.stringify(e)).join("\n"));
  const report = { generatedAt, scenario: scenario.scenario, cluster: scenario.cluster, summary, outcomes, reputation, costMicroUsd, costByAgent: result.cost.byAgent };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), renderReport({ scenario, outcomes, summary, costMicroUsd, reputation, generatedAt }));

  console.log(`\n=== outcome ===`);
  console.log(`  reviewed ${summary.reviewed}/${summary.submitted} · decisions ${Object.entries(summary.decisions).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  escalated ${summary.escalated} · bad-faith ${summary.badFaithFlags} · appeals ${summary.appealsFiled} · arbitrated ${summary.arbitrated} (${Object.entries(summary.arbitrationOutcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
  console.log(`  targeted claims changed ${summary.claimsChanged} · metered cost ${costMicroUsd != null ? formatMicroUsd(costMicroUsd) : "n/a"}`);
  if (summary.unreviewed.length) console.log(`  still pending: ${summary.unreviewed.join(", ")}`);
  console.log(`  report: ${join(dir, "report.md")}`);

  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster: scenario.cluster,
      kind: "contributions",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: gitCommit(),
        scenario: scenario.scenario,
        models: { governance: cfg.governanceModel, arbitration: cfg.arbitrationModel, steward: cfg.stewardModel, judge: cfg.judgeModel },
      },
      scorecard: report,
      runDir: dir,
    });
  } catch (err) {
    console.warn("[contributions] eval-run registry write failed (report files are intact):", err instanceof Error ? err.message : err);
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
