/**
 * Judge calibration (#334 L2, from #137/#99): the human-label loop.
 *
 * No judge's numbers feed a gate until checked against human labels (#334
 * §2.8). This tool runs that loop in two halves:
 *
 *   npm run corpus:calibrate -- sheet [db:<id> | <scorecard.json>]
 *     Generates a BLINDED labeling sheet from a scored run: the same claims
 *     the judge scored, with full context (assessment, reasoning, subclaims)
 *     and the same constitution standards the judge was pinned to — but the
 *     judge's own verdicts withheld, so the labeler isn't anchored. Defaults
 *     to the most recent scored run in the eval-run registry.
 *
 *   npm run corpus:calibrate -- compare <filled-sheet.md>
 *     Parses the filled labels and prints per-dimension agreement with the
 *     judge's verdicts from the registry: mean absolute difference on the
 *     1-5 scales and importance, exact agreement on claim_bar/granularity.
 *
 * The sheet carries its eval-run id, so the comparison always joins against
 * the exact run that was labeled. Claim context is read from the corpus DB —
 * generate the sheet before resetting the graph (or restore the snapshot).
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

const LABEL_TEMPLATE = [
  "readability:      # 1-5",
  "reasoning_fit:    # 1-5",
  "impartiality:     # 1-5",
  "claim_bar:        # yes | no",
  "granularity:      # good | too_granular | too_shallow | n_a",
  "importance:       # 0.0-1.0 on the §19 anchors",
].join("\n");

async function makeSheet(ref: string | undefined): Promise<void> {
  assertCorpusDb();
  const run = await latestScoredRun(ref);
  const items = run.scorecard.judged?.items ?? [];
  if (items.length === 0) {
    throw new Error(`Run ${run.id.slice(0, 8)} has no judged items (scored with --no-judge?).`);
  }

  const o: string[] = [];
  const w = (l = "") => o.push(l);
  w(`# Judge-calibration labeling sheet — ${run.cluster}`);
  w();
  w(`eval_run: ${run.id}`);
  w();
  w(`## Instructions`);
  w();
  w(`Label each claim below against the standards — the SAME standards the`);
  w(`LLM judge is pinned to, reproduced here. Work from the claim, its`);
  w(`assessment, and its subclaims alone; the judge's verdicts are withheld`);
  w(`so your labels stay independent. Fill every field in each \`labels\``);
  w(`block (replace the comments). Then run:`);
  w();
  w(`    npm run corpus:calibrate -- compare <this-file>`);
  w();
  w(`Disagreement is signal, not failure — where your labels and the judge`);
  w(`diverge systematically is exactly what this measures (#137).`);
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
          `since this run. Restore the snapshot, or label from a fresher run.`
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
    w("```labels");
    w(`claim_id: ${item.id}`);
    w(LABEL_TEMPLATE);
    w("```");
  }

  mkdirSync(SHEETS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const path = join(SHEETS_DIR, `${run.cluster}-${stamp}-${run.id.slice(0, 8)}.md`);
  writeFileSync(path, o.join("\n"));
  console.log(`✓ labeling sheet: ${path} (${items.length} items)`);
  console.log(`  fill every \`labels\` block, then: npm run corpus:calibrate -- compare ${path}`);
}

interface ParsedLabels {
  claimId: string;
  readability?: number;
  reasoning_fit?: number;
  impartiality?: number;
  claim_bar?: string;
  granularity?: string;
  importance?: number;
}

function parseSheet(text: string): { evalRunId: string; labels: ParsedLabels[] } {
  const evalRunId = /^eval_run: (\S+)/m.exec(text)?.[1];
  if (!evalRunId) throw new Error("Sheet is missing its `eval_run:` line.");
  const labels: ParsedLabels[] = [];
  for (const block of text.matchAll(/```labels\n([\s\S]*?)```/g)) {
    const body = block[1]!;
    const get = (k: string) =>
      new RegExp(`^${k}:\\s*([^#\\n]*)`, "m").exec(body)?.[1]?.trim() || undefined;
    const num = (k: string) => {
      const v = get(k);
      return v === undefined || v === "" ? undefined : Number(v);
    };
    const claimId = get("claim_id");
    if (!claimId) continue;
    labels.push({
      claimId,
      readability: num("readability"),
      reasoning_fit: num("reasoning_fit"),
      impartiality: num("impartiality"),
      claim_bar: get("claim_bar"),
      granularity: get("granularity"),
      importance: num("importance"),
    });
  }
  return { evalRunId, labels };
}

async function compareSheet(path: string): Promise<void> {
  assertCorpusDb();
  const { evalRunId, labels } = parseSheet(readFileSync(path, "utf-8"));
  const [run] = await rawQuery<RegistryRun>(
    `SELECT id, cluster, scorecard FROM eval_runs WHERE id::text LIKE $1 || '%'`,
    [evalRunId === "file" ? "" : evalRunId]
  );
  if (!run) throw new Error(`eval run ${evalRunId} not found in the registry`);
  const judgeBy = new Map(run.scorecard.judged!.items.map((i) => [i.id, i]));

  const scaleDims = ["readability", "reasoning_fit", "impartiality"] as const;
  const diffs: Record<string, number[]> = { importance: [] };
  for (const d of scaleDims) diffs[d] = [];
  let barAgree = 0, barTotal = 0, granAgree = 0, granTotal = 0, labeled = 0;

  for (const l of labels) {
    const j = judgeBy.get(l.claimId);
    if (!j) continue;
    const complete = scaleDims.every((d) => Number.isFinite(l[d])) &&
      l.claim_bar && l.granularity && Number.isFinite(l.importance);
    if (!complete) continue;
    labeled++;
    for (const d of scaleDims) diffs[d]!.push(Math.abs(l[d]! - j[d]));
    diffs.importance!.push(Math.abs(l.importance! - j.importance_judged));
    barTotal++;
    if (l.claim_bar === j.claim_bar) barAgree++;
    granTotal++;
    if (l.granularity === j.decomposition_granularity) granAgree++;
  }

  if (labeled === 0) {
    throw new Error("No fully-filled label blocks found — fill every field in each block.");
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`\nJudge calibration vs human labels — run ${run.id.slice(0, 8)} (${labeled} items)\n`);
  for (const d of scaleDims) {
    console.log(`  ${d.padEnd(14)} mean |Δ| ${mean(diffs[d]!).toFixed(2)}  (1-5 scale)`);
  }
  console.log(`  ${"importance".padEnd(14)} mean |Δ| ${mean(diffs.importance!).toFixed(2)}  (0-1 scale)`);
  console.log(`  ${"claim_bar".padEnd(14)} exact agreement ${barAgree}/${barTotal}`);
  console.log(`  ${"granularity".padEnd(14)} exact agreement ${granAgree}/${granTotal}`);
  console.log(
    `\n  Reading: |Δ| ≤ 1 on 1-5 scales and claim-bar agreement ≥ ~0.8 is the`
  );
  console.log(
    `  working bar (#137) before judge numbers feed gates. Systematic skew on`
  );
  console.log(`  one dimension = fix that dimension's rubric wording, not the judge.`);
}

async function main(): Promise<void> {
  const command = positional(0);
  if (command === "sheet") return makeSheet(positional(1));
  if (command === "compare") {
    const path = positional(1);
    if (!path) throw new Error("Usage: corpus:calibrate -- compare <filled-sheet.md>");
    return compareSheet(path);
  }
  console.error("Usage: corpus:calibrate -- sheet [db:<id> | scorecard.json] | compare <sheet.md>");
  process.exit(1);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
