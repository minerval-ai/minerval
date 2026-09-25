/**
 * Property runner (#334 S3 tier 1, from #295): metamorphic invariances that
 * need no referent, each measured as the agreement between two arms of the
 * same cluster.
 *
 *   npm run corpus:property -- idempotency <cluster> [--profile=production] [--limit=N] [--posts=…]
 *   npm run corpus:property -- path-independence <cluster> [--seed=N] [--baseline=<snapshot>] [--confirm] [--dry-run]
 *   npm run corpus:property -- adversarial-order <cluster> [--role=<manifest role>]
 *   npm run corpus:property -- dup-flood <cluster> [--dups=3]
 *   npm run corpus:property -- locality <cluster> --foreign=<otherCluster>:<postId>
 *   npm run corpus:property -- fixpoint <cluster>
 *
 * idempotency: the same configuration twice — the pipeline's own noise
 * floor, which every other comparison has to clear. path-independence: arm B
 * ingests the same posts in a seeded shuffled order (corpus:run --order),
 * since matching is stateful and the constitution wants order not to matter.
 * adversarial-order: the same, with the most partisan source first, read for
 * a first-mover effect. dup-flood / locality / fixpoint (#295 tier 1 (a),
 * tier 2 (e), (f)): arm B starts from arm A's snapshot and perturbs it —
 * the same posts N more times under new URLs, one foreign post, or a full
 * re-stewarding pass. Model convergence is corpus:swap.
 *
 * Each arm is a child corpus:run, snapshotted (prop_<stamp>_a / _b, kept as
 * the evidence); the two snapshots go through corpus:agreement; the summary
 * and both arms' fingerprints land in runs/property-<stamp>/property.json and
 * the eval-run registry (kind 'property'). Two full drains (one plus a
 * perturbation for the tier-2 properties): budget accordingly.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_DATABASE_URL, CORPUS_PROFILE, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { restoreSnapshot, saveSnapshot } from "./snapshot-core.js";
import { emitTwoArmReplay, latestRunRecord, runChild } from "./arms.js";
import { buildPropertyArms, isProperty, PROPERTIES, restoresArmA, summarizeProperty } from "./property-lib.js";
import { replayName } from "./replay.js";
import { loadManifest, postUrl } from "./lib.js";
import type { ArmRecord } from "./swap-lib.js";
import type { AgreementReport, MatchedPair } from "./graph-agreement.js";

async function main(): Promise<void> {
  assertCorpusDb();
  const property = positional(0);
  const cluster = positional(1);
  if (!property || !cluster || !isProperty(property)) {
    console.error(
      `Usage: corpus:property -- <${PROPERTIES.join("|")}> <cluster> [--profile=production] [--limit=N] [--posts=…] [--seed=N] [--baseline=<snapshot>] [--confirm] [--dry-run]\n` +
        "       [--dups=N] (dup-flood) [--role=<manifest role>] (adversarial-order) --foreign=<cluster>:<postId> (locality)"
    );
    process.exit(1);
  }
  const limitRaw = argFlag("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  const posts = argFlag("posts")?.split(",").map((s) => s.trim()).filter(Boolean);
  const seed = argFlag("seed") !== undefined ? Number(argFlag("seed")) : 1;
  const baseline = argFlag("baseline") ?? null;
  // --- #295 S3 property flags -------------------------------------------
  const dups = argFlag("dups") !== undefined ? Number(argFlag("dups")) : 3;
  const role = argFlag("role") ?? null;
  const foreign = argFlag("foreign") ?? null;
  // -----------------------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 12);
  const names = { a: `prop_${stamp}_a`, b: `prop_${stamp}_b` };
  const arms = buildPropertyArms({ property, cluster, profile: CORPUS_PROFILE, limit, posts, seed, baselineSnapshot: baseline, dups, role, foreign });

  console.log(`\n=== property: ${property} on ${cluster}` + (CORPUS_PROFILE ? ` · profile ${CORPUS_PROFILE}` : "") + " ===");
  for (const arm of arms) console.log(`  arm ${arm.arm}: corpus:run ${arm.args.join(" ")}`);
  console.log(`  snapshots: ${baseline ?? names.a} (reference) · ${names.b}` + (restoresArmA(property) ? " (arm B starts from the reference snapshot)" : ""));
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
    // Tier-2 arms perturb A's graph rather than rebuilding it.
    if (arm.arm === "b" && restoresArmA(property)) {
      if (!snapA) throw new Error("arm B needs arm A's snapshot to restore");
      console.log(`  restoring snapshot ${snapA} before arm B`);
      await restoreSnapshot(CORPUS_DATABASE_URL, snapA);
    }
    runChild("scripts/corpus/run.ts", arm.args, {});
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
  if (!armB || !snapA) throw new Error("arm B did not produce a run record");

  const outDir = join(RUNS_ROOT, `property-${property}-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const agreementPath = join(outDir, "agreement.json");
  console.log(`\n--- agreement: snap:${snapA} vs snap:${names.b} ---`);
  runChild(
    "scripts/corpus/agreement.ts",
    [`snap:${snapA}`, `snap:${names.b}`, `--out=${agreementPath}`, ...(hasFlag("confirm") ? ["--confirm"] : [])],
    {}
  );
  const agreement = JSON.parse(readFileSync(agreementPath, "utf8")) as { report: AgreementReport; pairs?: MatchedPair[] };
  // adversarial-order: which source arm B ingested first (run.json keeps the ingest order).
  let firstSourceUrl: string | null = null;
  if (property === "adversarial-order") {
    const firstId = (armB as { posts?: string[] }).posts?.[0];
    const p = firstId ? loadManifest(cluster).posts.find((x) => x.id === firstId) : undefined;
    firstSourceUrl = p ? postUrl(p) : null;
  }
  const summary = summarizeProperty({ property, cluster, armA, armB, agreement: agreement.report, firstSourceUrl, dups });

  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  console.log(`\n=== ${property} on ${cluster} ===`);
  console.log(`  claim-set F1 ${f(summary.claimSetF1)} (recall ${f(summary.claimSetRecall)}) · credence mean |Δ| ${f(summary.credenceMeanAbsDiff)} · status agreement ${f(summary.statusAgreement)} · edge edit distance ${summary.edgeEditDistance}`);
  const creators = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  console.log(`  unmatched by creator: A ${creators(summary.unmatchedByCreator.a)} · B ${creators(summary.unmatchedByCreator.b)}`);
  console.log(`  cost: A ${summary.cost.a != null ? formatMicroUsd(summary.cost.a) : "n/a"} · B ${summary.cost.b != null ? formatMicroUsd(summary.cost.b) : "n/a"}`);
  if (summary.granularity) console.log(`  granularity: children equal ${f(summary.granularity.childrenEqualShare)} · mean |Δchildren| ${f(summary.granularity.meanAbsChildrenDiff)} · depth equal ${f(summary.granularity.depthEqualShare)} (n ${summary.granularity.n})`);
  if (summary.churn) console.log(`  churn: ${summary.churn.moved} of ${summary.churn.n} matched verdicts moved (${summary.churn.statusChanged} status, ${summary.churn.credenceMoved} credence) · claims only A ${summary.delta.claimsOnlyA} / only B ${summary.delta.claimsOnlyB}`);
  if (summary.inflation) console.log(`  inflation: signed drift toward stance ${f(summary.inflation.meanSignedTowardStance)} (n ${summary.inflation.n}, toward ${summary.inflation.towardStance} / against ${summary.inflation.againstStance}) · instances ${summary.inflation.instancesA} → ${summary.inflation.instancesB}`);
  if (summary.firstMover) console.log(`  first mover: ${summary.firstMover.firstSourceUrl ?? "?"} · signed drift ${f(summary.firstMover.meanSignedTowardFirst)} (n ${summary.firstMover.n}, toward ${summary.firstMover.towardFirst} / against ${summary.firstMover.againstFirst})`);
  console.log(`  ${summary.reading}`);

  const record = { generatedAt: new Date().toISOString(), summary, arms: { a: armA, b: armB }, snapshots: { a: snapA, b: names.b }, agreement };
  writeFileSync(join(outDir, "property.json"), JSON.stringify(record, null, 2));

  // The recording of both arms, side by side (best-effort; never fails the run).
  await emitTwoArmReplay({
    kind: "property",
    name: replayName(`${property}-${cluster}`, stamp),
    title: `${cluster}: ${property}`,
    cluster,
    about:
      property === "idempotency"
        ? "The same configuration run twice on the same posts: two graphs built side by side from identical inputs, with the claims the agreement metric paired linked across them. The differences are the pipeline's own noise floor."
        : `The same posts ingested in two orders (arm B shuffled with seed ${seed}): two graphs built side by side, with the claims the agreement metric paired linked across them. Matching is stateful, so where the graphs differ is where order mattered.`,
    outDir,
    arms: { a: armA, b: armB },
    snapshots: { a: snapA, b: names.b },
    variation: { a: baseline ? `baseline snapshot ${baseline}` : null, b: property === "path-independence" ? `sources in shuffled order, seed ${seed}` : "same configuration, second run" },
    agreement,
    summary: summary as unknown as Record<string, unknown>,
  });
  try {
    const cfg = loadConfig();
    await getDb().insert(evalRuns).values({
      cluster,
      kind: "property",
      config: {
        pipelineEpoch: cfg.pipelineEpoch,
        gitCommit: gitCommit(),
        profile: CORPUS_PROFILE,
        property,
        seed: property === "path-independence" ? seed : null,
        dups: property === "dup-flood" ? dups : null,
        role: property === "adversarial-order" ? role : null,
        foreign: property === "locality" ? foreign : null,
        firstSourceUrl,
        models: { ...(armA?.models ?? armB.models), judge: cfg.judgeModel },
        snapshots: { a: snapA, b: names.b },
      },
      scorecard: record,
      runDir: outDir,
    });
  } catch (err) {
    console.warn("[property] eval-run registry write failed (property.json is intact):", err instanceof Error ? err.message : err);
  }
  console.log(`  written: ${join(outDir, "property.json")}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
