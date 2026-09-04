/**
 * Contribution driver (#334 L1): submit a scenario of contributions and
 * appeals against the graph in the corpus DB, through the real Contribution
 * Reviewer, escalation and Dispute Arbitrator pipelines, and report what
 * happened. The never-exercised half of the organization, exercised.
 *
 * Usage:
 *   npm run corpus:contributions -- <scenario> [--dry-run] [--no-appeals] [--limit=N]
 *
 * <scenario> names corpus/contributions/<scenario>.json. Run it against a
 * graph a corpus run produced (targets are resolved by search). See the
 * README there for what a scenario is and what the report contains.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, CORPUS_ROOT, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb, rawQuery } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { hybridSearch } from "../../src/services/search-service.js";
import { getOrCreateContributor } from "../../src/services/contributor-service.js";
import {
  createAppeal,
  createContribution,
  getReviewForContribution,
} from "../../src/services/contribution-service.js";
import { enqueueArbitration, enqueueContribution } from "../../src/services/queue-service.js";
import { drainLocalQueues } from "../../src/workers/local-runner.js";
import type { DrainStats, RunnerEvent } from "../../src/workers/local-runner.js";
import {
  renderReport,
  summarizeOutcomes,
  validateScenario,
  type ContributionOutcome,
  type Scenario,
  type ScenarioContribution,
} from "./contributions-lib.js";

const RUN_STARTED_AT = new Date();

function describeDrain(stats: DrainStats): string {
  const acts = Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`);
  const errs = Object.values(stats.errors).reduce((a, b) => a + b, 0);
  return (acts.join(", ") || "nothing") + (errs ? `, ${errs} handler errors` : "") + (stats.capped ? " (CAPPED)" : "");
}

async function resolveTarget(query: string): Promise<{ id: string; text: string } | null> {
  const { results } = await hybridSearch(query, { limit: 3 });
  const top = results[0];
  return top ? { id: top.id, text: top.text } : null;
}

async function claimState(id: string): Promise<{ text: string; status: string | null }> {
  const [row] = await rawQuery<{ text: string; status: string | null }>(
    `SELECT c.text, a.status FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
      WHERE c.id = $1`,
    [id]
  );
  return { text: row?.text ?? "", status: row?.status ?? null };
}

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

  // Resolve every target up front so a dry run shows the plan and a real
  // run never submits against a missing claim.
  const targets = new Map<string, { id: string; text: string } | null>();
  const mergeTargets = new Map<string, { id: string; text: string } | null>();
  for (const c of items) {
    const t = await resolveTarget(c.target.query);
    targets.set(c.id, t);
    console.log(`  ${t ? "→" : "✗"} ${c.id.padEnd(32)} ${c.type.padEnd(16)} ${t ? `"${t.text.slice(0, 70)}"` : `no claim for "${c.target.query}"`}`);
    if (c.mergeTarget) {
      const m = await resolveTarget(c.mergeTarget.query);
      mergeTargets.set(c.id, m);
      console.log(`      merge into ${m ? `"${m.text.slice(0, 60)}"` : `no claim for "${c.mergeTarget.query}"`}`);
    }
  }
  if (dryRun) {
    console.log("\n  --dry-run: nothing submitted.");
    return;
  }

  // Personas: fresh contributors per scenario run, sandboxed like any new account.
  const personas = new Map<string, { id: string; displayName: string; reputationBefore: number }>();
  for (const p of scenario.contributors) {
    const c = await getOrCreateContributor({
      externalId: `corpus:${scenario.scenario}:${p.key}`,
      displayName: p.displayName,
    });
    personas.set(p.key, { id: c.id, displayName: c.displayName, reputationBefore: c.reputationScore });
  }

  const trace: RunnerEvent[] = [];
  const outcomes: ContributionOutcome[] = [];
  const before = new Map<string, { text: string; status: string | null }>();
  const submitted = new Map<string, { contributionId: string; spec: ScenarioContribution }>();

  console.log("\n--- submitting ---");
  for (const c of items) {
    const t = targets.get(c.id);
    const persona = personas.get(c.contributor)!;
    if (!t) {
      outcomes.push({ id: c.id, type: c.type, contributor: c.contributor, targetClaimId: null, targetText: null, contributionId: null, reviewStatus: null, review: null, escalationReason: null, appeal: null, arbitration: null, claimChange: null, expect: c.expect });
      continue;
    }
    if (!before.has(t.id)) before.set(t.id, await claimState(t.id));
    const contribution = await createContribution({
      claimId: t.id,
      contributorId: persona.id,
      contributionType: c.type,
      content: c.content,
      evidenceUrls: c.evidenceUrls ?? [],
      mergeTargetClaimId: mergeTargets.get(c.id)?.id,
      proposedCanonicalForm: c.proposedCanonicalForm,
    });
    await enqueueContribution({ contributionId: contribution.id });
    submitted.set(c.id, { contributionId: contribution.id, spec: c });
    console.log(`  + ${c.id} (${c.type}) → contribution ${contribution.id.slice(0, 8)}`);
  }

  console.log("\n--- draining: review, escalation, notifications ---");
  const drain1 = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
  console.log(`  ${describeDrain(drain1)}`);

  // Appeals for rejected contributions that carry a reason — the same path as POST /appeals.
  let appealsFiled = 0;
  if (!hasFlag("no-appeals")) {
    console.log("\n--- appeals ---");
    for (const [id, { contributionId, spec }] of submitted) {
      if (!spec.appealIfRejected) continue;
      const review = await getReviewForContribution(contributionId);
      if (!review || review.decision !== "reject") continue;
      const appellant = personas.get(spec.contributor)!;
      const appeal = await createAppeal({
        contributionId,
        originalReviewId: review.id,
        appellantId: appellant.id,
        appealReasoning: spec.appealIfRejected,
      });
      await enqueueArbitration({ contributionId, trigger: "appeal", appealId: appeal.id });
      appealsFiled++;
      console.log(`  ↑ ${id}: rejected, appeal ${appeal.id.slice(0, 8)} filed`);
    }
    if (appealsFiled === 0) console.log("  (no rejected contribution carried an appeal)");
    else {
      console.log("\n--- draining: arbitration ---");
      const drain2 = await drainLocalQueues({ onEvent: (e) => trace.push(e) });
      console.log(`  ${describeDrain(drain2)}`);
    }
  }

  // Collect what happened.
  for (const c of items) {
    const sub = submitted.get(c.id);
    if (!sub) continue;
    const t = targets.get(c.id)!;
    const [row] = await rawQuery<{ review_status: string; escalation_reason: string | null }>(
      `SELECT review_status, escalation_reason FROM contributions WHERE id = $1`,
      [sub.contributionId]
    );
    const [review] = await rawQuery<{
      decision: string; confidence: number; reasoning: string; policy_citations: string[];
      suspected_bad_faith: boolean; bad_faith_category: string | null;
    }>(
      `SELECT decision, confidence, reasoning, policy_citations, suspected_bad_faith, bad_faith_category
         FROM contribution_reviews WHERE contribution_id = $1 AND NOT superseded
        ORDER BY reviewed_at DESC LIMIT 1`,
      [sub.contributionId]
    );
    const [appeal] = await rawQuery<{ id: string; status: string }>(
      `SELECT id, status FROM appeals WHERE contribution_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
      [sub.contributionId]
    );
    const [arb] = await rawQuery<{
      outcome: string; decision: string; reasoning: string; suspected_bad_faith: boolean; human_review_recommended: boolean;
    }>(
      `SELECT outcome, decision, reasoning, suspected_bad_faith, human_review_recommended
         FROM arbitration_results WHERE contribution_id = $1 ORDER BY arbitrated_at DESC LIMIT 1`,
      [sub.contributionId]
    );
    const after = await claimState(t.id);
    const b = before.get(t.id)!;
    outcomes.push({
      id: c.id,
      type: c.type,
      contributor: c.contributor,
      targetClaimId: t.id,
      targetText: t.text,
      contributionId: sub.contributionId,
      reviewStatus: row?.review_status ?? null,
      review: review
        ? {
            decision: review.decision,
            confidence: review.confidence,
            reasoning: review.reasoning,
            policyCitations: review.policy_citations ?? [],
            suspectedBadFaith: review.suspected_bad_faith,
            badFaithCategory: review.bad_faith_category,
          }
        : null,
      escalationReason: row?.escalation_reason ?? null,
      appeal: appeal ? { id: appeal.id, status: appeal.status } : null,
      arbitration: arb
        ? {
            outcome: arb.outcome,
            decision: arb.decision,
            reasoning: arb.reasoning,
            suspectedBadFaith: arb.suspected_bad_faith,
            humanReviewRecommended: arb.human_review_recommended,
          }
        : null,
      claimChange: { textBefore: b.text, textAfter: after.text, statusBefore: b.status, statusAfter: after.status },
      expect: c.expect,
    });
  }
  // Keep the scenario's order for unresolved ones too.
  outcomes.sort((x, y) => items.findIndex((i) => i.id === x.id) - items.findIndex((i) => i.id === y.id));

  const reputation = await Promise.all(
    [...personas.entries()].map(async ([key, p]) => {
      const [row] = await rawQuery<{ reputation_score: number; contribution_standing: string }>(
        `SELECT reputation_score, contribution_standing FROM contributors WHERE id = $1`,
        [p.id]
      );
      return { key, displayName: p.displayName, before: p.reputationBefore, after: row?.reputation_score ?? p.reputationBefore, standing: row?.contribution_standing ?? "?" };
    })
  );
  const [cost] = await rawQuery<{ micro: string | null }>(
    `SELECT SUM(cost_micro_usd) AS micro FROM llm_usage WHERE created_at >= $1`,
    [RUN_STARTED_AT]
  );
  const costMicroUsd = cost?.micro != null ? Number(cost.micro) : null;
  const summary = summarizeOutcomes(outcomes);
  const generatedAt = new Date().toISOString();

  const stamp = generatedAt.replace(/[:.]/g, "-");
  const dir = join(RUNS_ROOT, `contrib-${scenario.scenario}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trace.jsonl"), trace.map((e) => JSON.stringify(e)).join("\n"));
  const report = { generatedAt, scenario: scenario.scenario, cluster: scenario.cluster, summary, outcomes, reputation, costMicroUsd };
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
