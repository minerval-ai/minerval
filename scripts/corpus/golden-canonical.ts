/**
 * Canonical-form golden suite runner (#334 S1, addendum of 2026-08-11).
 *
 * For each pinned case: run the REAL Extractor's single shot on the excerpt
 * (the same extractClaims call url-extraction.ts makes, capped at 1–3
 * claims), take the proposed canonical form closest to the pinned expected
 * form by embedding, and ask a pair judge on JUDGE_MODEL three narrow
 * questions — same proposition? same direction? neutral and no invented
 * specificity? — pass = all three yes. Cents per run; the regression net
 * for a prompt or model change that starts rewriting good wording.
 *
 * Usage:
 *   npm run corpus:golden-canonical                      # all cases
 *   npm run corpus:golden-canonical -- --category=direction
 *   npm run corpus:golden-canonical -- --cases=dir-01,sur-02
 *   npm run corpus:golden-canonical -- --model=<id>       # override EXTRACTOR_MODEL
 *   npm run corpus:golden-canonical -- --profile=production
 *   npm run corpus:golden-canonical -- --min-pass=0.9    # exit 1 below this rate
 *   npm run corpus:golden-canonical -- --max-claims=2    # extraction cap (default 3)
 *
 * Needs OPENAI_API_KEY (embeddings), a key for the Extractor's provider and
 * one for the judge's. Touches no claims: nothing is seeded into the graph.
 * The registry row (kind 'golden-canonical') is best-effort and the only DB
 * write. Results land in runs/golden-canonical-<stamp>/ and, like the
 * Matcher golden runs, as a scorecard under corpus/scorecards/golden-canonical/.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_PROFILE, CORPUS_ROOT, gitCommit, RUNS_ROOT, SCORECARDS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { completeStructured } from "../../src/llm/client.js";
import { runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { generateEmbeddings } from "../../src/services/embedding-service.js";
import { extractClaims } from "../../src/llm/agents/extractor.js";
import {
  buildCanonicalJudgePrompt,
  CANONICAL_JUDGE_SCHEMA,
  gradeCanonicalCase,
  loadCanonicalFixture,
  pickClosest,
  summarizeCanonical,
  validateCanonicalFixture,
  type CanonicalCaseResult,
  type CanonicalJudgeVerdict,
} from "./golden-canonical-lib.js";

const FIXTURE_PATH = join(CORPUS_ROOT, "golden", "canonical-forms.json");

const runMeter = { billedMicroUsd: 0 };

async function judgePair(input: { excerpt: string; expected: string; proposed: string }): Promise<CanonicalJudgeVerdict> {
  const model = loadConfig().judgeModel;
  // Tagged "judge" so its llm_usage rows and trace are attributable and
  // separable from the Extractor under test.
  return withAgent("judge", () =>
    completeStructured<CanonicalJudgeVerdict>({
      messages: [{ role: "user", content: buildCanonicalJudgePrompt(input) }],
      schema: CANONICAL_JUDGE_SCHEMA,
      schemaName: "CanonicalFormPairVerdict",
      model,
      // Thinking judge models spend max_tokens thinking; headroom for a tiny verdict.
      maxTokens: 8192,
    })
  );
}

async function main(): Promise<void> {
  assertCorpusDb();
  const fixture = loadCanonicalFixture(FIXTURE_PATH);
  const problems = validateCanonicalFixture(fixture);
  if (problems.length > 0) {
    console.error("Fixture invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }

  const onlyIds = argFlag("cases")?.split(",").map((s) => s.trim());
  const onlyCategory = argFlag("category");
  const model = argFlag("model");
  const minPass = argFlag("min-pass") ? Number(argFlag("min-pass")) : null;
  const maxClaims = Math.min(3, Math.max(1, Number(argFlag("max-claims") ?? 3) || 3));

  let cases = fixture.cases;
  if (onlyIds?.length) cases = cases.filter((c) => onlyIds.includes(c.id));
  if (onlyCategory) cases = cases.filter((c) => c.category === onlyCategory);
  if (cases.length === 0) {
    console.error("No cases selected (check --cases / --category).");
    process.exit(1);
  }

  const cfg = loadConfig();
  const extractorModel = model ?? cfg.extractorModel;
  const judgeModel = cfg.judgeModel;
  if (judgeModel === extractorModel) {
    console.warn(
      `  warning: the judge (${judgeModel}) is the Extractor model under test — set JUDGE_MODEL to another model so the agent does not grade its own wording.`
    );
  }
  console.log(
    `\n=== canonical-form golden suite: ${cases.length} case(s), extractor ${extractorModel}, judge ${judgeModel}, max ${maxClaims} claim(s)/excerpt ===\n`
  );

  const results: CanonicalCaseResult[] = [];
  for (const c of cases) {
    let proposals: string[] = [];
    let extractionError: string | null = null;
    try {
      const extracted = await extractClaims({
        content: c.excerpt,
        sourceType: "excerpt",
        maxClaims,
        model: model ?? undefined,
      });
      proposals = extracted.map((e) => e.proposed_canonical_form).filter((s) => typeof s === "string" && s.trim().length > 0);
    } catch (err) {
      extractionError = err instanceof Error ? err.message : String(err);
    }

    let proposed: { text: string; similarity: number } | null = null;
    let verdict: CanonicalJudgeVerdict | null = null;
    if (proposals.length > 0) {
      const embeddings = await generateEmbeddings([c.expected, ...proposals]);
      const best = pickClosest(
        embeddings[0]!,
        proposals.map((text, i) => ({ text, embedding: embeddings[i + 1]! }))
      );
      if (best) {
        proposed = { text: best.text, similarity: Math.round(best.similarity * 1000) / 1000 };
        try {
          verdict = await judgePair({ excerpt: c.excerpt, expected: c.expected, proposed: best.text });
        } catch (err) {
          console.error(`  judge failed for ${c.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const result = gradeCanonicalCase(c, proposals, proposed, verdict);
    if (extractionError) result.failures.push(`extraction error: ${extractionError}`);
    results.push(result);
    console.log(
      `  ${result.pass ? "✓" : "✗"} ${c.id.padEnd(8)} [${c.category.padEnd(11)}]` +
        (result.pass ? "" : ` — ${result.failures.join("; ")}`) +
        (proposed ? `\n      proposed: ${proposed.text}` : "")
    );
  }

  const summary = summarizeCanonical(results);
  console.log(`\n  pass rate: ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(0)}%)`);
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    console.log(`    ${cat.padEnd(12)} ${c.passed}/${c.total}`);
  }
  console.log(`  ${summary.reading}`);
  console.log(`  metered cost: ${formatMicroUsd(runMeter.billedMicroUsd)}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `golden-canonical-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    kind: "golden-canonical",
    extractorModel,
    judgeModel,
    maxClaims,
    gitCommit: gitCommit(),
    profile: CORPUS_PROFILE,
    pipelineEpoch: cfg.pipelineEpoch,
    summary,
    costMicroUsd: runMeter.billedMicroUsd,
    results,
  };
  writeFileSync(join(dir, "golden-canonical-report.json"), JSON.stringify(report, null, 2));
  // The committed history, like golden-matcher's: commit the runs that matter.
  const historyDir = join(SCORECARDS_ROOT, "golden-canonical");
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, `${stamp}.json`), JSON.stringify(report, null, 2));
  try {
    await getDb().insert(evalRuns).values({
      cluster: "golden-canonical",
      kind: "golden-canonical",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: report.gitCommit,
        profile: CORPUS_PROFILE,
        models: { extractor: extractorModel, judge: judgeModel },
      },
      scorecard: report,
      runDir: dir,
    });
  } catch (err) {
    console.warn(
      "[golden-canonical] eval-run registry write failed (report file is intact):",
      err instanceof Error ? err.message : err
    );
  }
  console.log(`  report: ${join(dir, "golden-canonical-report.json")}`);
  console.log(`  history: ${join(historyDir, `${stamp}.json`)}`);

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
