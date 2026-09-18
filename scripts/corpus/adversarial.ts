/**
 * Adversarial robustness suite, static cells (#334 S4, from #302): a pinned
 * scenario of attacks against a drained graph, each arm run from the same
 * snapshot, with a benign control per target and a blind judge on the
 * before/after assessments.
 *
 * Usage:
 *   npm run corpus:adversarial -- <scenario> --baseline=<snapshot>
 *       [--targets=k1,k2] [--arms=pro,con,benign] [--campaign-only | --no-campaign]
 *       [--dry-run] [--no-judge] [--sample=N] [--seed=N]
 *
 * <scenario> names corpus/adversarial/<scenario>.json (README there).
 * <snapshot> is a corpus:snapshot of the cluster's drained graph, the state
 * every arm starts from. For each target × arm: restore the snapshot,
 * record the target's before-state, submit the arm's contributions through
 * the contribution driver (review, steward notifications, appeals,
 * arbitration, all real), record the after-state, compute whole-graph
 * agreement against the snapshot, attribute the movement to the Reviewer or
 * the Steward, price the attack, snapshot the end state (adv_<stamp>_<target>_<arm>)
 * and collect the arm's replay. Then per target: displacement per arm, the
 * symmetry verdict, the legitimacy gap, and the blind judge (JUDGE_MODEL,
 * order randomised by --seed, provenance withheld). Campaign mode does the
 * same at graph level with the holistic judge. Output:
 * runs/adversarial-<scenario>-<stamp>/report.md + report.json (+ replay),
 * registered in the eval-run registry as kind 'adversarial'.
 *
 * Isolated corpus deployments only. The main database is refused by name.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_ROOT, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { resolveTarget, runScenario } from "./contribution-driver.js";
import { loadAgreementGraph, snapshotUrl } from "./graph-load.js";
import type { AgreementGraph } from "./graph-agreement.js";
import {
  CAMPAIGN_ARMS,
  TARGET_ARMS,
  armCost,
  armRole,
  armScenario,
  attribute,
  blindOrder,
  displacement,
  importanceDisplacement,
  legitimacyGap,
  renderAdversarialReport,
  summarizeAdversarial,
  symmetry,
  toJudged,
  unblind,
  validateAdversarialScenario,
  type AdversarialArm,
  type AdversarialReport,
  type AdversarialScenario,
  type ArmResult,
  type CampaignArmResult,
  type CampaignResult,
  type SubmittedRecord,
  type TargetResult,
} from "./adversarial-lib.js";
import {
  agreementAgainstBaseline,
  armSnapshotName,
  judgeBlindPair,
  judgeHolisticPair,
  loadHolisticView,
  readClaimState,
  reassessmentCountSince,
  reassessmentsSince,
  restoreBaseline,
  runFingerprint,
  snapshotArm,
} from "./adversarial-harness.js";
import { annotateContributionDeltas, tryCollectArm, tryWriteReplay, type ReplayArm } from "./replay-emit.js";

function submittedRecords(s: AdversarialScenario, arm: AdversarialArm): SubmittedRecord[] {
  const tiers = new Map(s.personas.map((p) => [p.key, p.tier]));
  return arm.contributions.map((c) => ({
    id: c.id,
    persona: c.persona,
    tier: tiers.get(c.persona) ?? null,
    type: c.type,
    gambit: c.gambit,
    fabricated: !!c.fabricated,
    content: c.content,
    evidenceUrls: c.evidenceUrls ?? [],
    proposedCanonicalForm: c.proposedCanonicalForm ?? null,
    appeal: c.appeal ?? null,
  }));
}

function sameAssessment(a: ReturnType<typeof toJudged>, b: ReturnType<typeof toJudged>): boolean {
  return a.status === b.status && a.credence === b.credence && a.confidence === b.confidence && a.summary === b.summary && a.reasoning === b.reasoning;
}

async function main(): Promise<void> {
  assertCorpusDb();
  const name = positional(0);
  if (!name) {
    console.error(
      "Usage: corpus:adversarial -- <scenario> --baseline=<snapshot> [--targets=k1,k2] [--arms=pro,con,benign]\n" +
        "         [--campaign-only | --no-campaign | --campaign] [--dry-run] [--no-judge] [--sample=N] [--seed=N]\n" +
        "  --targets= selects targets and skips the campaign unless --campaign is also given."
    );
    process.exit(1);
  }
  const scenario = JSON.parse(readFileSync(join(CORPUS_ROOT, "adversarial", `${name}.json`), "utf8")) as AdversarialScenario;
  const problems = validateAdversarialScenario(scenario);
  if (problems.length) {
    console.error("Scenario invalid:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  const dryRun = hasFlag("dry-run");
  const baseline = argFlag("baseline") ?? scenario.baseline?.snapshot ?? null;
  if (!baseline && !dryRun) throw new Error("--baseline=<snapshot> is required (or scenario.baseline.snapshot): every arm restores it");
  const targetFilter = argFlag("targets")?.split(",").map((s) => s.trim()).filter(Boolean);
  const armFilter = argFlag("arms")?.split(",").map((s) => s.trim()).filter(Boolean);
  const targets = hasFlag("campaign-only") ? [] : scenario.targets.filter((t) => !targetFilter || targetFilter.includes(t.key));
  const campaign = hasFlag("no-campaign") || (targetFilter && !hasFlag("campaign")) ? null : (scenario.campaign ?? null);
  const targetArms = TARGET_ARMS.filter((a) => !armFilter || armFilter.includes(a));
  const campaignArms = CAMPAIGN_ARMS.filter((a) => !armFilter || armFilter.includes(a));
  const judge = !hasFlag("no-judge");
  const sample = argFlag("sample") !== undefined ? Number(argFlag("sample")) : Number.POSITIVE_INFINITY;
  const generated = new Date();
  const stamp = generated.toISOString().replace(/[:.]/g, "-");
  const seed = argFlag("seed") !== undefined ? Number(argFlag("seed")) : Number(generated.toISOString().replace(/[^0-9]/g, "").slice(6, 14));
  const runDir = join(RUNS_ROOT, `adversarial-${scenario.scenario}-${stamp}`);
  const cfg = loadConfig();
  const models = { steward: cfg.stewardModel, governance: cfg.governanceModel, arbitration: cfg.arbitrationModel, judge: cfg.judgeModel };

  console.log(`\n=== adversarial: ${scenario.scenario} · baseline ${baseline ?? "(none: dry run)"} · ${targets.length} target(s) × ${targetArms.join("/")}${campaign ? ` + campaign (${campaignArms.join("/")})` : ""} · seed ${seed} ===`);

  if (dryRun) {
    console.log("\n--- plan (targets resolved against the CURRENT corpus DB; a real run restores the baseline first) ---");
    for (const t of targets) {
      const hit = await resolveTarget(t.query);
      console.log(`\n  target ${t.key} (${t.kind}): ${hit ? `"${hit.text}" (${hit.id.slice(0, 8)})` : `no claim for "${t.query}"`}`);
      for (const arm of targetArms) {
        const a = t.arms[arm];
        console.log(`    arm ${arm} (${a.direction}): ${a.contributions.map((c) => `${c.id}[${c.gambit}${c.fabricated ? ",fabricated" : ""}]`).join(", ")}`);
        for (const c of a.contributions) {
          if (c.target) {
            const h = await resolveTarget(c.target.query);
            console.log(`      ${c.id} → ${h ? `"${h.text.slice(0, 60)}"` : `no claim for "${c.target.query}"`}`);
          }
        }
      }
    }
    if (campaign) {
      console.log(`\n  campaign: ${campaign.goal}`);
      for (const arm of campaignArms) {
        for (const c of campaign.arms[arm].contributions) {
          const h = await resolveTarget(c.target!.query);
          console.log(`    ${arm} ${c.id}[${c.gambit}] → ${h ? `"${h.text.slice(0, 60)}"` : `no claim for "${c.target!.query}"`}`);
        }
      }
    }
    console.log("\n  --dry-run: nothing restored, nothing submitted.");
    return;
  }

  mkdirSync(runDir, { recursive: true });
  const fingerprint = runFingerprint();
  const baselineGraph: AgreementGraph = await loadAgreementGraph(`snap:${baseline}`, snapshotUrl(baseline!));
  const replayArms: ReplayArm[] = [];
  const replayTargets: Array<{ key: string; claimId: string | null; text: string | null; direction?: "up" | "down" | null }> = [];
  const traceLines: string[] = [];

  // ---- claim-level cells -------------------------------------------------
  const targetResults: TargetResult[] = [];
  for (const t of targets) {
    const arms: Record<string, ArmResult> = {};
    let claimId: string | null = null;
    let claimText: string | null = null;
    let stored: { credence: number | null; status: string | null } = { credence: null, status: null };
    for (const arm of targetArms) {
      const spec = t.arms[arm];
      console.log(`\n--- ${t.key} / ${arm} (${spec.direction}) — restoring ${baseline} ---`);
      await restoreBaseline(baseline!);
      const startedAt = new Date();
      const hit = await resolveTarget(t.query);
      if (!hit) {
        console.warn(`  no claim for "${t.query}"; arm skipped`);
        continue;
      }
      claimId = hit.id;
      claimText = hit.text;
      const before = await readClaimState(hit.id);
      stored = { credence: before?.credence ?? null, status: before?.status ?? null };
      console.log(`  target "${hit.text}" · ${before?.status ?? "unassessed"} credence ${before?.credence ?? "n/s"}`);
      const sub = armScenario(scenario, spec, { name: `${scenario.scenario}-${t.key}-${arm}`, defaultQuery: t.query });
      const result = await runScenario(sub, {
        appeals: true,
        externalIdPrefix: `corpus:adv:${stamp}:${t.key}:${arm}`,
        onEvent: (e) => traceLines.push(JSON.stringify({ target: t.key, arm, ...e })),
      });
      const after = await readClaimState(hit.id);
      const reassessments = await reassessmentsSince(hit.id, startedAt);
      const disp = displacement(before, after, spec.direction);
      const agreement = await agreementAgainstBaseline(baseline!, baselineGraph, `${t.key}/${arm}`);
      const capped = result.drains.some((d) => d.capped);
      const cost = armCost({ cost: result.cost, outcomes: result.outcomes, personas: result.personas });
      const snapshot = armSnapshotName("adv", stamp, t.key, arm);
      const collected = await tryCollectArm({
        since: startedAt,
        until: new Date(),
        key: `${t.key}/${arm}`,
        label: `${t.key} · ${arm} (${spec.direction})`,
        variation: `${armRole(arm)} arm pushing ${spec.direction}: ${spec.contributions.map((c) => c.gambit).join(", ")}`,
        fingerprint,
        database: snapshot,
        capped,
      });
      if (collected) {
        const gambits = new Map(result.outcomes.filter((o) => o.contributionId).map((o) => [o.contributionId!, spec.contributions.find((c) => c.id === o.id)?.gambit ?? null]));
        annotateContributionDeltas(collected, `${t.key}/${arm}`, gambits);
        replayArms.push(collected);
      }
      try {
        await snapshotArm(snapshot);
        console.log(`  snapshot ${snapshot}`);
      } catch (err) {
        console.warn(`  snapshot failed: ${err instanceof Error ? err.message : err}`);
      }
      arms[arm] = {
        arm,
        role: armRole(arm),
        direction: spec.direction,
        note: spec.note ?? null,
        before,
        after,
        displacement: disp,
        submitted: submittedRecords(scenario, spec),
        outcomes: result.outcomes,
        reassessments,
        attribution: attribute(result.outcomes, reassessments, disp),
        agreement: agreement.report,
        cost,
        personas: result.personas,
        snapshot,
        capped,
        judge: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      };
      console.log(`  ${disp.statusBefore ?? "-"} ${disp.before ?? "-"} → ${disp.statusAfter ?? "-"} ${disp.after ?? "-"} (toward ${disp.toward ?? "n/a"}) · ${arms[arm].attribution.stage} · ${formatMicroUsd(cost.microUsd ?? 0)}`);
    }
    const pro = arms.pro?.displacement.toward ?? null;
    const con = arms.con?.displacement.toward ?? null;
    const benign = arms.benign?.displacement.toward ?? null;
    targetResults.push({
      key: t.key,
      query: t.query,
      kind: t.kind,
      note: t.note ?? null,
      expect: t.expect ?? null,
      claimId,
      text: claimText,
      storedCredence: stored.credence,
      storedStatus: stored.status,
      arms,
      symmetry: symmetry({ proToward: pro, conToward: con, benignToward: benign, storedCredence: stored.credence }),
      legitimacyGap: { pro: legitimacyGap(pro, benign), con: legitimacyGap(con, benign) },
    });
    replayTargets.push({ key: t.key, claimId, text: claimText, direction: null });
  }

  // ---- graph-level cells -------------------------------------------------
  let campaignResult: CampaignResult | null = null;
  if (campaign) {
    const arms: Record<string, CampaignArmResult> = {};
    for (const arm of campaignArms) {
      const spec = campaign.arms[arm];
      console.log(`\n--- campaign / ${arm} — restoring ${baseline} ---`);
      await restoreBaseline(baseline!);
      const startedAt = new Date();
      const before = await loadHolisticView();
      const sub = armScenario(scenario, spec, { name: `${scenario.scenario}-campaign-${arm}`, defaultQuery: null });
      const result = await runScenario(sub, {
        appeals: true,
        externalIdPrefix: `corpus:adv:${stamp}:campaign:${arm}`,
        onEvent: (e) => traceLines.push(JSON.stringify({ target: "campaign", arm, ...e })),
      });
      const after = await loadHolisticView();
      const agreement = await agreementAgainstBaseline(baseline!, baselineGraph, `campaign/${arm}`);
      const importance = importanceDisplacement(agreement.before.claims.map((c) => ({ id: c.id, text: c.text, importance: c.importance ?? 0.5, credence: c.credence ?? null })), agreement.after.claims.map((c) => ({ id: c.id, text: c.text, importance: c.importance ?? 0.5, credence: c.credence ?? null })), agreement.pairs);
      const capped = result.drains.some((d) => d.capped);
      const cost = armCost({ cost: result.cost, outcomes: result.outcomes, personas: result.personas });
      const snapshot = armSnapshotName("adv", stamp, "campaign", arm);
      let admitted = 0;
      let rejected = 0;
      let badFaith = 0;
      for (const o of result.outcomes) {
        if (o.review?.decision === "accept" || o.arbitration?.outcome === "overturn") admitted++;
        else if (o.review?.decision === "reject") rejected++;
        if (o.review?.suspectedBadFaith || o.arbitration?.suspectedBadFaith) badFaith++;
      }
      const collected = await tryCollectArm({
        since: startedAt,
        until: new Date(),
        key: `campaign/${arm}`,
        label: `campaign · ${arm}`,
        variation: `${armRole(arm)} campaign: ${spec.contributions.map((c) => c.gambit).join(", ")}`,
        fingerprint,
        database: snapshot,
        capped,
      });
      if (collected) {
        const gambits = new Map(result.outcomes.filter((o) => o.contributionId).map((o) => [o.contributionId!, spec.contributions.find((c) => c.id === o.id)?.gambit ?? null]));
        annotateContributionDeltas(collected, `campaign/${arm}`, gambits);
        replayArms.push(collected);
      }
      try {
        await snapshotArm(snapshot);
        console.log(`  snapshot ${snapshot}`);
      } catch (err) {
        console.warn(`  snapshot failed: ${err instanceof Error ? err.message : err}`);
      }
      arms[arm] = {
        arm,
        role: armRole(arm),
        note: spec.note ?? null,
        before,
        after,
        importance,
        agreement: agreement.report,
        submitted: submittedRecords(scenario, spec),
        outcomes: result.outcomes,
        attribution: { admitted, rejected, badFaith, reassessments: await reassessmentCountSince(startedAt) },
        cost,
        personas: result.personas,
        snapshot,
        capped,
        judge: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      };
      console.log(`  importance Spearman ${importance.spearman ?? "n/a"} · claim-set F1 ${agreement.report.claimSet.f1 ?? "n/a"} · admitted ${admitted}/${result.outcomes.length} · ${formatMicroUsd(cost.microUsd ?? 0)}`);
    }
    const gapOf = (pick: (a: CampaignArmResult) => number | null) => {
      const x = arms.attack ? pick(arms.attack) : null;
      const y = arms.benign ? pick(arms.benign) : null;
      return x === null || y === null ? null : Math.round((x - y) * 1000) / 1000;
    };
    campaignResult = {
      goal: campaign.goal,
      note: campaign.note ?? null,
      expect: campaign.expect ?? null,
      arms,
      legitimacyGap: { spearman: gapOf((a) => a.importance.spearman), claimSetF1: gapOf((a) => a.agreement?.claimSet.f1 ?? null) },
    };
  }

  // ---- the blind judges --------------------------------------------------
  let judgeCost = 0;
  if (judge) {
    const keys: string[] = [];
    for (const t of targetResults) for (const a of Object.keys(t.arms)) keys.push(`${t.key}/${a}`);
    if (campaignResult) for (const a of Object.keys(campaignResult.arms)) keys.push(`campaign/${a}`);
    const order = blindOrder(keys, seed);
    let judged = 0;
    console.log(`\n--- blind judge on ${cfg.judgeModel} (seed ${seed}) ---`);
    for (const t of targetResults) {
      for (const a of Object.values(t.arms)) {
        if (judged >= sample) break;
        const key = `${t.key}/${a.arm}`;
        const beforeJ = toJudged(a.before);
        const afterJ = toJudged(a.after);
        const ord = order[key]!;
        const shown = ord.first === "before" ? { first: beforeJ, second: afterJ } : { first: afterJ, second: beforeJ };
        if (sameAssessment(beforeJ, afterJ)) {
          a.judge = { order: ord, shown, verdict: null, better: "same", warranted: "n_a", costMicroUsd: 0, error: "assessment unchanged: not sent to the judge" };
          continue;
        }
        try {
          const { verdict, costMicroUsd } = await judgeBlindPair({ claimText: a.after?.text ?? a.before?.text ?? t.text ?? "", ...shown });
          judgeCost += costMicroUsd;
          a.judge = { order: ord, shown, verdict, better: unblind(verdict, ord), warranted: verdict.warranted, costMicroUsd, error: null };
          judged++;
          console.log(`  ${key}: better ${a.judge.better} · ${verdict.movement} · warranted ${verdict.warranted}`);
        } catch (err) {
          a.judge = { order: ord, shown, verdict: null, better: null, warranted: null, costMicroUsd: null, error: err instanceof Error ? err.message : String(err) };
          console.warn(`  ${key}: judge failed: ${a.judge.error}`);
        }
      }
    }
    if (campaignResult) {
      for (const a of Object.values(campaignResult.arms)) {
        if (judged >= sample) break;
        const key = `campaign/${a.arm}`;
        const ord = order[key]!;
        const shown = ord.first === "before" ? { first: a.before, second: a.after } : { first: a.after, second: a.before };
        try {
          const { verdict, costMicroUsd } = await judgeHolisticPair({ cluster: scenario.cluster, description: scenario.description ?? null, ...shown });
          judgeCost += costMicroUsd;
          a.judge = { order: ord, shown, verdict, betterView: unblind({ better: verdict.better_view }, ord), costMicroUsd, error: null };
          judged++;
          console.log(`  ${key}: framing ${verdict.framing_shifted} (${verdict.in_favour_of}) · warranted ${verdict.warranted} · better ${a.judge.betterView}`);
        } catch (err) {
          a.judge = { order: ord, shown, verdict: null, betterView: null, costMicroUsd: null, error: err instanceof Error ? err.message : String(err) };
          console.warn(`  ${key}: judge failed: ${a.judge.error}`);
        }
      }
    }
  }

  // ---- report, registry, replay -----------------------------------------
  const summary = summarizeAdversarial(targetResults, campaignResult);
  const report: AdversarialReport = {
    generatedAt: generated.toISOString(),
    scenario: scenario.scenario,
    cluster: scenario.cluster,
    description: scenario.description ?? null,
    baseline: baseline!,
    seed,
    models,
    targets: targetResults,
    campaign: campaignResult,
    summary,
    judgeCostMicroUsd: judge ? judgeCost : null,
    runDir,
  };
  writeFileSync(join(runDir, "trace.jsonl"), traceLines.join("\n"));
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, "report.md"), renderAdversarialReport(report));

  let evalRunId: string | null = null;
  try {
    const [row] = await getDb()
      .insert(evalRuns)
      .values({
        cluster: scenario.cluster,
        kind: "adversarial",
        config: { pipelineEpoch: cfg.pipelineEpoch, gitCommit: gitCommit(), scenario: scenario.scenario, baseline, seed, models },
        scorecard: report as unknown as Record<string, unknown>,
        runDir,
      })
      .returning({ id: evalRuns.id });
    evalRunId = row?.id ?? null;
  } catch (err) {
    console.warn("[adversarial] eval-run registry write failed (report files are intact):", err instanceof Error ? err.message : err);
  }

  const usedInAttack = new Set<string>();
  const usedInBenign = new Set<string>();
  for (const t of scenario.targets) for (const arm of TARGET_ARMS) for (const c of t.arms[arm].contributions) (armRole(arm) === "attack" ? usedInAttack : usedInBenign).add(c.persona);
  for (const arm of CAMPAIGN_ARMS) for (const c of scenario.campaign?.arms[arm]?.contributions ?? []) (armRole(arm) === "attack" ? usedInAttack : usedInBenign).add(c.persona);
  const replayPath = await tryWriteReplay(runDir, {
    kind: "adversarial",
    name: `adversarial-${scenario.scenario}-${stamp}`,
    title: `Adversarial: ${scenario.scenario}`,
    cluster: scenario.cluster,
    about: `Each arm restores snapshot ${baseline} and submits ${scenario.targets[0]?.arms.pro.contributions.length ?? "its"} contribution(s) against the same claim: pro pushes toward TRUE, con toward FALSE, benign is a sincere case. The legitimacy gap is attacker displacement minus benign displacement; the blind judge compares before/after assessments with provenance withheld.`,
    arms: replayArms,
    scenario: {
      name: scenario.scenario,
      description: scenario.description ?? null,
      actors: scenario.personas.map((p) => ({ key: p.key, displayName: p.displayName, note: p.note ?? null, tier: p.tier, role: usedInAttack.has(p.key) ? "attacker" : usedInBenign.has(p.key) ? "benign" : "persona" })),
      targets: replayTargets,
    },
    summary: summary as unknown as Record<string, unknown>,
    evalRunId,
  });

  console.log(`\n=== outcome ===`);
  for (const t of targetResults) {
    console.log(`  ${t.key}: ${t.symmetry.verdict} · gap pro ${t.legitimacyGap.pro ?? "n/a"} con ${t.legitimacyGap.con ?? "n/a"} · ${Object.values(t.arms).map((a) => `${a.arm} ${a.displacement.before ?? "-"}→${a.displacement.after ?? "-"} ${a.attribution.stage}`).join(" · ")}`);
  }
  if (campaignResult) console.log(`  campaign: gap Spearman ${campaignResult.legitimacyGap.spearman ?? "n/a"} · F1 ${campaignResult.legitimacyGap.claimSetF1 ?? "n/a"} · framing ${summary.campaignFramingShifted ?? "not judged"}`);
  console.log(`  judged ${summary.judged} · after better ${summary.judgeAfterBetter} · unwarranted ${summary.judgeUnwarranted} · cost ${formatMicroUsd(summary.costMicroUsd ?? 0)} + judge ${formatMicroUsd(judgeCost)} · accounts burned ${summary.accountsBurned}`);
  console.log(`  report: ${join(runDir, "report.md")}${replayPath ? `\n  replay: ${replayPath}` : ""}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
