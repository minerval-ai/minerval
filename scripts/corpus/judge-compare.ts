/**
 * Judge bake-off: run SEVERAL candidate judge models over the SAME deterministic
 * claim sample and compare their verdicts head-to-head.
 *
 * The scorecard (score.ts) answers "how good is the pipeline output?"; this
 * answers "how much does that answer depend on which judge you asked?" — the
 * calibration question behind picking the JUDGE_MODELS panel. Every model
 * grades the identical sample (pickSample is deterministic by claim id), so
 * differences are judge differences, not sample noise.
 *
 * Emits per-model summaries, pairwise claim-bar agreement, per-item vote
 * grids, and metered cost per model. Files land in
 * corpus/scorecards/judge-comparison/<stamp>.{json,md} and the run is
 * registered in the eval-run registry (kind "judge-compare").
 *
 * Usage:
 *   tsx scripts/corpus/judge-compare.ts [cluster] \
 *     --models=claude-fable-5,gpt-5.6-sol,... [--sample=N]
 *
 * Models default to the configured JUDGE_MODELS panel.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCorpusDb, SCORECARDS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { getSessionUsage } from "../../src/llm/budget-tracker.js";
import { withCostMeter } from "../../src/llm/usage-context.js";
import { loadConfig } from "../../src/config.js";
import type { JudgeVerdict } from "./judge.js";
import {
  loadSnapshot,
  pickSample,
  judgeSample,
  summarizeJudged,
  type JudgedSummary,
} from "./score.js";

const DEFAULT_SAMPLE = 15;

export interface ModelRun {
  model: string;
  summary: JudgedSummary;
  cost: { calls: number; usd: number };
  wallSeconds: number;
}

interface ItemRow {
  id: string;
  text: string;
  status: string | null;
  importanceStored: number;
  /** model → its verdict for this claim (absent when that judge call failed). */
  verdicts: Record<string, JudgeVerdict>;
  claimBarVotes: { yes: number; no: number };
}

export interface Comparison {
  generatedAt: string;
  cluster: string;
  sampleSize: number;
  config: { pipelineEpoch: string; gitCommit: string | null };
  models: ModelRun[];
  /** modelA → modelB → share of co-judged items with the same claim_bar vote. */
  claimBarPairwiseAgreement: Record<string, Record<string, number>>;
  /** model → share of items where its claim_bar vote matches the panel majority. */
  majorityAgreement: Record<string, number>;
  /** model → mean |importance_judged − panel median| across items. */
  importanceDeviation: Record<string, number>;
  items: ItemRow[];
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const round = (x: number) => Math.round(x * 100) / 100;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function buildComparison(cluster: string, sampleSize: number, runs: ModelRun[]): Comparison {
  const models = runs.map((r) => r.model);

  // Per-item verdict grid, keyed by claim id.
  const byId = new Map<string, ItemRow>();
  for (const run of runs) {
    for (const v of run.summary.items) {
      let row = byId.get(v.id);
      if (!row) {
        row = {
          id: v.id,
          text: v.text,
          status: v.status,
          importanceStored: v.importanceStored,
          verdicts: {},
          claimBarVotes: { yes: 0, no: 0 },
        };
        byId.set(v.id, row);
      }
      row.verdicts[run.model] = v;
      row.claimBarVotes[v.claim_bar]++;
    }
  }
  const items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Pairwise claim-bar agreement over co-judged items.
  const pairwise: Record<string, Record<string, number>> = {};
  for (const a of models) {
    pairwise[a] = {};
    for (const b of models) {
      if (a === b) continue;
      let same = 0;
      let both = 0;
      for (const row of items) {
        const va = row.verdicts[a];
        const vb = row.verdicts[b];
        if (!va || !vb) continue;
        both++;
        if (va.claim_bar === vb.claim_bar) same++;
      }
      pairwise[a][b] = both ? round(same / both) : 0;
    }
  }

  // Majority agreement: per item, the mode of claim_bar votes (ties excluded).
  const majorityAgreement: Record<string, number> = {};
  for (const m of models) {
    let match = 0;
    let counted = 0;
    for (const row of items) {
      const v = row.verdicts[m];
      if (!v) continue;
      const { yes, no } = row.claimBarVotes;
      if (yes === no) continue; // split panel: no majority to agree with
      counted++;
      const majority = yes > no ? "yes" : "no";
      if (v.claim_bar === majority) match++;
    }
    majorityAgreement[m] = counted ? round(match / counted) : 0;
  }

  // Importance deviation from the panel median, per model.
  const importanceDeviation: Record<string, number> = {};
  for (const m of models) {
    const devs: number[] = [];
    for (const row of items) {
      const v = row.verdicts[m];
      if (!v) continue;
      const all = Object.values(row.verdicts).map((x) => x.importance_judged);
      if (all.length < 2) continue;
      devs.push(Math.abs(v.importance_judged - median(all)));
    }
    importanceDeviation[m] = devs.length
      ? round(devs.reduce((a, b) => a + b, 0) / devs.length)
      : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    cluster,
    sampleSize,
    config: { pipelineEpoch: loadConfig().pipelineEpoch, gitCommit: gitCommit() },
    models: runs,
    claimBarPairwiseAgreement: pairwise,
    majorityAgreement,
    importanceDeviation,
    items,
  };
}

function shortName(model: string): string {
  // Compact column labels: strip vendor prefixes and family boilerplate.
  return model
    .replace(/^.*\//, "")
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "");
}

export function renderMarkdown(c: Comparison): string {
  const o: string[] = [];
  const w = (l = "") => o.push(l);
  const names = c.models.map((r) => r.model);

  w(`# Judge bake-off — ${c.cluster}`);
  w();
  w(`_generated ${c.generatedAt} · epoch \`${c.config.pipelineEpoch}\` · commit \`${c.config.gitCommit ?? "?"}\`_`);
  w();
  w(`${c.models.length} judge models over the same deterministic ${c.sampleSize}-claim sample.`);
  w(`Differences below are judge differences, not sample noise.`);
  w();

  w(`## Per-model summary`);
  w();
  w(`| metric | ${names.map((m) => `\`${shortName(m)}\``).join(" | ")} |`);
  w(`|---|${names.map(() => "---").join("|")}|`);
  const col = (f: (r: ModelRun) => string) => c.models.map(f).join(" | ");
  w(`| claim-bar pass-rate | ${col((r) => `${(r.summary.claimBarPassRate * 100).toFixed(0)}%`)} |`);
  w(`| majority agreement (claim bar) | ${col((r) => `${((c.majorityAgreement[r.model] ?? 0) * 100).toFixed(0)}%`)} |`);
  w(`| importance judged (mean) | ${col((r) => `${r.summary.importanceAlignment.meanJudged}`)} |`);
  w(`| importance dev from panel median | ${col((r) => `${c.importanceDeviation[r.model] ?? 0}`)} |`);
  w(`| readability | ${col((r) => `${r.summary.assessmentQuality.readability}`)} |`);
  w(`| reasoning-fit | ${col((r) => `${r.summary.assessmentQuality.reasoningFit}`)} |`);
  w(`| impartiality | ${col((r) => `${r.summary.assessmentQuality.impartiality}`)} |`);
  w(`| status_miscalibrated flags | ${col((r) => `${r.summary.flags["status_miscalibrated"] ?? 0}`)} |`);
  w(`| all flags | ${col((r) => `${Object.values(r.summary.flags).reduce((a, b) => a + b, 0)}`)} |`);
  w(`| items judged | ${col((r) => `${r.summary.sampleSize}`)} |`);
  w(`| cost (USD, metered) | ${col((r) => `$${r.cost.usd}`)} |`);
  w(`| wall time | ${col((r) => `${r.wallSeconds}s`)} |`);
  w();

  w(`## Pairwise claim-bar agreement`);
  w();
  w(`| | ${names.map((m) => `\`${shortName(m)}\``).join(" | ")} |`);
  w(`|---|${names.map(() => "---").join("|")}|`);
  for (const a of names) {
    w(
      `| \`${shortName(a)}\` | ${names
        .map((b) => (a === b ? "—" : `${((c.claimBarPairwiseAgreement[a]?.[b] ?? 0) * 100).toFixed(0)}%`))
        .join(" | ")} |`
    );
  }
  w();

  w(`## Per-item claim-bar votes`);
  w();
  w(`| claim | ${names.map((m) => `\`${shortName(m)}\``).join(" | ")} |`);
  w(`|---|${names.map(() => "---").join("|")}|`);
  for (const row of c.items) {
    const votes = names
      .map((m) => {
        const v = row.verdicts[m];
        return v ? (v.claim_bar === "yes" ? "✓" : "✗") : "·";
      })
      .join(" | ");
    w(`| ${row.text.slice(0, 70)} | ${votes} |`);
  }
  w();
  w(`_✓ passes the §2 claim bar, ✗ fails it, · judge call failed._`);
  w();

  const splits = c.items.filter((r) => r.claimBarVotes.yes > 0 && r.claimBarVotes.no > 0);
  if (splits.length > 0) {
    w(`## Split decisions (${splits.length})`);
    w();
    for (const row of splits) {
      const yes = names.filter((m) => row.verdicts[m]?.claim_bar === "yes").map(shortName);
      const no = names.filter((m) => row.verdicts[m]?.claim_bar === "no").map(shortName);
      w(`- **${row.text.slice(0, 90)}** — pass: ${yes.join(", ") || "none"}; fail: ${no.join(", ") || "none"}`);
    }
    w();
  }
  return o.join("\n");
}

async function main() {
  assertCorpusDb();
  const args = process.argv.slice(2);
  const cluster = args.filter((a) => !a.startsWith("--"))[0] ?? "blackholes";
  const sampleArg = args.find((a) => a.startsWith("--sample="));
  const sample = sampleArg ? Number(sampleArg.split("=")[1]) : DEFAULT_SAMPLE;
  const modelsArg = args.find((a) => a.startsWith("--models="));
  const cfg = loadConfig();
  const models = modelsArg
    ? modelsArg.split("=")[1]!.split(",").map((m) => m.trim()).filter(Boolean)
    : cfg.judgeModels.length > 0
      ? cfg.judgeModels
      : [cfg.judgeModel];

  const snapshot = await loadSnapshot();
  const inputs = pickSample(snapshot, sample);
  console.log(`Judge bake-off: ${models.length} models × ${inputs.length} claims (${cluster})`);

  const runs: ModelRun[] = [];
  for (const model of models) {
    const before = getSessionUsage();
    const started = Date.now();
    console.log(`  judging with ${model}…`);
    const { value: verdicts, billedMicroUsd } = await withCostMeter(() =>
      judgeSample(inputs, model)
    );
    const wallSeconds = Math.round((Date.now() - started) / 1000);
    const calls = getSessionUsage().calls - before.calls;
    const usd = Math.round(billedMicroUsd / 10_000) / 100;
    console.log(`    ${verdicts.length}/${inputs.length} judged · $${usd} · ${wallSeconds}s`);
    runs.push({
      model,
      summary: summarizeJudged(model, verdicts),
      cost: { calls, usd },
      wallSeconds,
    });
  }

  const comparison = buildComparison(cluster, inputs.length, runs);

  const stamp = comparison.generatedAt.replace(/[:.]/g, "-");
  const dir = join(SCORECARDS_ROOT, "judge-comparison");
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(comparison, null, 2));
  writeFileSync(join(dir, `${stamp}.md`), renderMarkdown(comparison));
  console.log(`Comparison: ${jsonPath}`);

  // Register in the eval-run registry (#334 L1), best-effort like score.ts.
  try {
    await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "judge-compare",
        config: { pipelineEpoch: comparison.config.pipelineEpoch, gitCommit: comparison.config.gitCommit, models },
        scorecard: comparison,
        runDir: dir,
      });
  } catch (err) {
    console.warn(
      "[judge-compare] eval-run registry write failed (files are intact):",
      err instanceof Error ? err.message : err
    );
  }
}

// Run directly (guarded so the exported pieces are importable, e.g. by a
// merge script that re-runs one failed judge and rebuilds the comparison).
if ((process.argv[1] ?? "").endsWith("judge-compare.ts")) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
