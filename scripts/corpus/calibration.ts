/**
 * Judge review (#334 L2, from #137/#99; §2.8 as amended 2026-08-25): the
 * human vetting loop for the LLM judge.
 *
 * The judge is presumed good-faith and competent at its assigned task, so its
 * judgment is as good as its prompt. The check is therefore to READ its
 * verdicts and reasoning, not to re-derive them blind and measure agreement —
 * and the reviewer's real contribution is not grading the judge's homework
 * but catching where the assigned task itself misses: a standard that does
 * not get at the right thing, a dimension that should exist and does not, a
 * better task. Rubric-wording fixes go to judge.ts and get re-judged;
 * what-is-measured fixes go to the plan (#334). No agreement statistic is
 * computed.
 *
 *   npm run corpus:calibrate -- review [db:<id> | <scorecard.json>]
 *     Generates a review sheet from a scored run: each judged claim with its
 *     full context (assessment, reasoning, subclaims), the pinned standards
 *     the judge graded against, and the judge's complete verdict — every
 *     dimension, its flags, and its note. Defaults to the most recent scored
 *     run in the eval-run registry.
 *
 * The reviewer fills a `review` block only where a verdict misses, and the
 * closing `overall` block with the feedback that actually matters. The filled
 * sheet is committed as the record of the review; there is nothing to run
 * afterward.
 *
 * Claim context is read from the corpus DB — generate the sheet before
 * resetting the graph (or restore the snapshot).
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCorpusDb, CORPUS_ROOT, positional } from "./lib.js";
import { closeDb, rawQuery } from "../../src/db/client.js";
import { CONSTITUTION_STANDARDS } from "./judge.js";
import type { Scorecard } from "./score.js";

const SHEETS_DIR = join(CORPUS_ROOT, "calibration");

interface RegistryRun {
  id: string;
  cluster: string;
  scorecard: Scorecard;
}

async function latestScoredRun(ref: string | undefined): Promise<RegistryRun> {
  if (ref?.endsWith(".json")) {
    const scorecard = JSON.parse(readFileSync(ref, "utf-8")) as Scorecard;
    return { id: "file", cluster: scorecard.cluster, scorecard };
  }
  const idPrefix = ref?.startsWith("db:") ? ref.slice(3) : null;
  const rows = await rawQuery<RegistryRun>(
    `SELECT id, cluster, scorecard FROM eval_runs
      WHERE kind = 'score' AND scorecard IS NOT NULL
        AND ($1::text IS NULL OR id::text LIKE $1 || '%')
      ORDER BY created_at DESC LIMIT 1`,
    [idPrefix]
  );
  if (rows.length === 0) {
    throw new Error(
      "No scored run found in the eval-run registry — run corpus:score first" +
        (idPrefix ? ` (no run matches db:${idPrefix})` : "")
    );
  }
  return rows[0]!;
}

const REVIEW_TEMPLATE =
  "notes:            # only where the verdict misses — what it got wrong; leave as-is to endorse";

async function makeReviewSheet(ref: string | undefined): Promise<void> {
  assertCorpusDb();
  const run = await latestScoredRun(ref);
  const items = run.scorecard.judged?.items ?? [];
  if (items.length === 0) {
    throw new Error(`Run ${run.id.slice(0, 8)} has no judged items (scored with --no-judge?).`);
  }

  const o: string[] = [];
  const w = (l = "") => o.push(l);
  w(`# Judge-review sheet — ${run.cluster}`);
  w();
  w(`eval_run: ${run.id}`);
  w();
  w(`## Instructions`);
  w();
  w(`Read each claim below, then the judge's verdict on it, against the`);
  w(`standards — the SAME standards the judge is pinned to, reproduced here.`);
  w(`Fill a \`review\` block only where a verdict misses. The real output is`);
  w(`the \`## Overall\` section at the end: not a grade of the judge's`);
  w(`homework, but feedback on the task itself — where the standards or`);
  w(`dimensions miss the right thing, what is measured that shouldn't be,`);
  w(`what isn't measured that should be. Rubric-wording fixes go to`);
  w(`scripts/corpus/judge.ts (then re-score and review again); what-is-`);
  w(`measured fixes go to the plan (#334). Commit the filled sheet as the`);
  w(`record; no agreement statistic is computed (#334 §2.8 as amended).`);
  w();
  w(`## Standards`);
  w();
  w("```");
  w(CONSTITUTION_STANDARDS);
  w("```");

  for (const [i, item] of items.entries()) {
    // Full context from the graph; the scorecard item alone under-describes.
    const [claim] = await rawQuery<{ text: string; claim_type: string }>(
      `SELECT text, claim_type FROM claims WHERE id = $1`,
      [item.id]
    );
    const [assessment] = await rawQuery<{
      status: string;
      confidence: number;
      reasoning_trace: string;
    }>(
      `SELECT status, confidence, reasoning_trace FROM assessments
        WHERE claim_id = $1 AND is_current`,
      [item.id]
    );
    const subclaims = await rawQuery<{ rel: string; text: string; status: string | null }>(
      `SELECT r.relation_type AS rel, c.text,
              (SELECT status FROM assessments a WHERE a.claim_id = c.id AND a.is_current) AS status
         FROM claim_relationships r JOIN claims c ON c.id = r.child_claim_id
        WHERE r.parent_claim_id = $1`,
      [item.id]
    );
    if (!claim) {
      throw new Error(
        `Claim ${item.id} is no longer in the corpus DB — the graph was reset ` +
          `since this run. Restore the snapshot, or review a fresher run.`
      );
    }

    w();
    w(`---`);
    w();
    w(`## Item ${i + 1} of ${items.length}`);
    w();
    w(`claim_id: ${item.id}`);
    w();
    w(`**Claim:** ${claim.text}`);
    w(`**Type:** ${claim.claim_type} · **Stored importance:** ${item.importanceStored}`);
    w(`**Assessment:** ${assessment?.status ?? "(none)"} (confidence ${assessment?.confidence ?? "n/a"})`);
    w();
    w(`**Reasoning:**`);
    w();
    w(`> ${(assessment?.reasoning_trace || "(none)").split("\n").join("\n> ")}`);
    w();
    w(`**Direct subclaims (${subclaims.length}):**`);
    for (const s of subclaims) {
      w(`- [${s.rel}] ${s.text} (status: ${s.status ?? "none"})`);
    }
    if (subclaims.length === 0) w(`- (atomic: no decomposition)`);
    w();
    w(`**Judge's verdict:**`);
    w();
    w(`| dimension | verdict |`);
    w(`|---|---|`);
    w(`| readability | ${item.readability} |`);
    w(`| reasoning_fit | ${item.reasoning_fit} |`);
    w(`| impartiality | ${item.impartiality} |`);
    w(`| claim_bar | ${item.claim_bar} |`);
    w(`| granularity | ${item.decomposition_granularity} |`);
    w(`| importance (judged, vs ${item.importanceStored} stored) | ${item.importance_judged} |`);
    w();
    w(`Flags: ${item.flags.length > 0 ? item.flags.join(", ") : "none"}`);
    w();
    w(`> ${item.note}`);
    w();
    w("```review");
    w(`claim_id: ${item.id}`);
    w(REVIEW_TEMPLATE);
    w("```");
  }

  w();
  w(`---`);
  w();
  w(`## Overall`);
  w();
  w(`The output that matters: feedback on the task, not scores on the judge.`);
  w();
  w("```overall");
  w(`# Free-form: misunderstandings in the task ("slight misunderstanding about X"),`);
  w(`# things not measured ("we forgot Y"), or redesigns ("what if we did Z instead").`);
  w("```");

  mkdirSync(SHEETS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const path = join(SHEETS_DIR, `${run.cluster}-${stamp}-${run.id.slice(0, 8)}-review.md`);
  writeFileSync(path, o.join("\n"));
  console.log(`✓ review sheet: ${path} (${items.length} items)`);
  console.log(`  read each verdict, fill every \`review\` block, commit the filled sheet.`);
}

async function main(): Promise<void> {
  const command = positional(0);
  if (command === "review") return makeReviewSheet(positional(1));
  if (command === "sheet" || command === "compare") {
    console.error(
      `'${command}' was the blinded-calibration workflow, replaced by unblinded ` +
        `review (#334 §2.8 as amended). Use: corpus:calibrate -- review [db:<id> | scorecard.json]`
    );
    process.exit(1);
  }
  console.error("Usage: corpus:calibrate -- review [db:<id> | scorecard.json]");
  process.exit(1);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
