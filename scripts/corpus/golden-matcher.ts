/**
 * The Matcher golden suite runner (#334 S1, from #137/#99 layer 1).
 *
 * For each pinned pair: seed the `existing` claims into the corpus DB (with
 * real embeddings), invoke the REAL agentic Matcher on the candidate, grade
 * the decision exact-match against the pinned expectation, then remove the
 * seeds. Cheap (cents per run on the default Matcher model) and near-
 * deterministic — the per-PR regression net for the one agent whose task
 * saturates (§19).
 *
 * Usage:
 *   npm run corpus:golden                       # all pairs
 *   npm run corpus:golden -- --category=negation
 *   npm run corpus:golden -- --pairs=neg-05,hard-03
 *   npm run corpus:golden -- --model=gpt-5-mini # override MATCHER_MODEL
 *   npm run corpus:golden -- --profile=production  # the production Matcher pin
 *   npm run corpus:golden -- --min-pass=0.9     # exit 1 below this rate
 *
 * Needs OPENAI_API_KEY (embeddings) and a key for the Matcher's provider.
 * Runs against the isolated corpus DB; seeds are deleted afterward, but any
 * claims already in the corpus graph WILL be in the Matcher's retrieval pool
 * (a harder, more realistic test — reset or snapshot/restore for a clean run).
 * Results are written to runs/ and registered in eval_runs (kind 'golden').
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_PROFILE, CORPUS_ROOT, gitCommit, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { claims, evalRuns } from "../../src/db/schema.js";
import { inArray } from "drizzle-orm";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { generateEmbedding } from "../../src/services/embedding-service.js";
import { matchClaim } from "../../src/llm/agents/matcher.js";
import {
  gradeDecision,
  loadGoldenFixture,
  summarize,
  validateGoldenFixture,
  type PairResult,
} from "./golden-lib.js";

const FIXTURE_PATH = join(CORPUS_ROOT, "golden", "matcher-pairs.json");

async function seedClaims(texts: string[]): Promise<string[]> {
  const config = loadConfig();
  const rows = await Promise.all(
    texts.map(async (text) => ({
      text,
      embedding: await generateEmbedding(text),
      createdBy: "golden",
      pipelineEpoch: config.pipelineEpoch,
    }))
  );
  const inserted = await getDb().insert(claims).values(rows).returning({ id: claims.id });
  return inserted.map((r) => r.id);
}

async function removeClaims(ids: string[]): Promise<void> {
  if (ids.length > 0) await getDb().delete(claims).where(inArray(claims.id, ids));
}

const runMeter = { billedMicroUsd: 0 };

async function main(): Promise<void> {
  assertCorpusDb();
  const fixture = loadGoldenFixture(FIXTURE_PATH);
  const problems = validateGoldenFixture(fixture);
  if (problems.length > 0) {
    console.error("Fixture invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }

  const onlyIds = argFlag("pairs")?.split(",").map((s) => s.trim());
  const onlyCategory = argFlag("category");
  const model = argFlag("model");
  const minPass = argFlag("min-pass") ? Number(argFlag("min-pass")) : null;

  let pairs = fixture.pairs;
  if (onlyIds?.length) pairs = pairs.filter((p) => onlyIds.includes(p.id));
  if (onlyCategory) pairs = pairs.filter((p) => p.category === onlyCategory);
  if (pairs.length === 0) {
    console.error("No pairs selected (check --pairs / --category).");
    process.exit(1);
  }

  const preexisting =
    (
      await rawQuery<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM claims WHERE state = 'active'`
      )
    )[0]?.n ?? 0;
  if (preexisting > 0) {
    console.log(
      `note: ${preexisting} claims already in the corpus graph will be in the ` +
        `retrieval pool (harder, more realistic; reset for a clean run).`
    );
  }

  const matcherModel = model ?? loadConfig().matcherModel;
  console.log(`\n=== matcher golden suite: ${pairs.length} pair(s), model ${matcherModel} ===\n`);

  const results: PairResult[] = [];
  for (const pair of pairs) {
    const seededIds = await seedClaims(pair.existing);
    try {
      const decision = await matchClaim({
        extractedText: pair.candidate.extractedText,
        proposedCanonical: pair.candidate.proposedCanonical,
        model: model ?? undefined,
      });
      const result = gradeDecision(pair, decision, seededIds);
      results.push(result);
      console.log(
        `  ${result.pass ? "✓" : "✗"} ${pair.id.padEnd(8)} [${pair.category}]` +
          (result.pass ? "" : ` — ${result.failures.join("; ")}`)
      );
    } finally {
      await removeClaims(seededIds);
    }
  }

  const summary = summarize(results);
  console.log(`\n  pass rate: ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(0)}%)`);
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    console.log(`    ${cat.padEnd(22)} ${c.passed}/${c.total}`);
  }
  console.log(`  metered cost: ${formatMicroUsd(runMeter.billedMicroUsd)}`);

  // Persist: a runs/ artifact plus an eval_runs registry row, so golden runs
  // sit in the same history as scorecards (corpus:runs shows them).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `golden-matcher-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const config = loadConfig();
  const report = {
    generatedAt: new Date().toISOString(),
    matcherModel,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    summary,
    costMicroUsd: runMeter.billedMicroUsd,
    results,
  };
  writeFileSync(join(dir, "golden-report.json"), JSON.stringify(report, null, 2));
  try {
    await getDb().insert(evalRuns).values({
      cluster: "golden-matcher",
      kind: "golden",
      config: {
        pipelineEpoch: config.pipelineEpoch,
        gitCommit: report.gitCommit,
        profile: CORPUS_PROFILE,
        models: { matcher: matcherModel },
      },
      scorecard: report,
      runDir: dir,
    });
  } catch (err) {
    console.warn(
      "[golden] eval-run registry write failed (report file is intact):",
      err instanceof Error ? err.message : err
    );
  }
  console.log(`  report: ${join(dir, "golden-report.json")}`);

  if (minPass !== null && summary.passRate < minPass) {
    console.error(`\nFAIL: pass rate ${summary.passRate} below --min-pass=${minPass}`);
    process.exit(1);
  }
}

runWithUsageContext({ meter: runMeter }, main)
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
