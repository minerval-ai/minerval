/**
 * Contribution driver, the submit-and-drain core (#334 L1), lifted out of
 * contributions.ts so the adversarial suite (S4: corpus:adversarial,
 * corpus:redteam) and the persona simulation (S8) run contributions through
 * the same path: resolve targets by search, mint personas (with a capability
 * tier), submit through the service layer POST /contributions uses, drain
 * the local queues to quiescence (Reviewer, Steward notifications,
 * escalation to the Arbitrator, audit), file the appeals that rejected
 * contributions carry, drain again, and collect every decision with its
 * reasoning. Nothing here is a mock: the agents, the policies, the
 * reputation ledger and the metering are the real ones.
 *
 * The module assumes lib.ts has already pinned DATABASE_URL to the corpus
 * DB (every CLI imports it first) and never asserts that itself; callers
 * do, before anything destructive.
 */
import { rawQuery } from "../../src/db/client.js";
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
import type {
  ContributionOutcome,
  ContributorTier,
  Scenario,
  ScenarioContribution,
} from "./contributions-lib.js";

export interface ResolvedTarget {
  id: string;
  text: string;
}

export interface ResolvedTargets {
  /** contribution id → the claim its target query resolved to (null = no hit). */
  targets: Map<string, ResolvedTarget | null>;
  /** contribution id → the claim its mergeTarget query resolved to. */
  mergeTargets: Map<string, ResolvedTarget | null>;
}

export interface PersonaHandle {
  key: string;
  id: string;
  displayName: string;
  tier: ContributorTier | null;
  reputationBefore: number;
}

export interface PersonaReport extends PersonaHandle {
  reputationAfter: number;
  standing: string;
  suspended: boolean;
  badFaithFlags: number;
}

export interface RunScenarioOptions {
  /** Resolve targets and mint nothing; the result carries only `targets`. */
  dryRun?: boolean;
  /** File appeals for rejected contributions that carry appealIfRejected (default true). */
  appeals?: boolean;
  /** Run only the first N contributions. */
  limit?: number;
  /** Observer for every processed queue message (the trace). */
  onEvent?: (e: RunnerEvent) => void;
  /** Extra per-persona setup after minting and tiering (e.g. a custom standing). */
  personaSetup?: (persona: PersonaHandle) => Promise<void>;
  /** Progress lines; default console.log. Pass () => {} for silence. */
  log?: (line: string) => void;
  /**
   * External-id namespace for the personas (`<prefix>:<key>`); default
   * `corpus:<scenario>`. The adversarial drivers mint fresh accounts per
   * arm/episode by varying it, so standing never leaks across arms.
   */
  externalIdPrefix?: string;
}

export interface ScenarioRunResult {
  outcomes: ContributionOutcome[];
  trace: RunnerEvent[];
  drains: DrainStats[];
  /** Metered LLM cost over the run window, total and by agent (micro-USD). */
  cost: { microUsd: number | null; byAgent: Record<string, number> };
  personas: PersonaReport[];
  targets: ResolvedTargets;
  appealsFiled: number;
  startedAt: Date;
  finishedAt: Date;
}

export function describeDrain(stats: DrainStats): string {
  const acts = Object.entries(stats.processed).map(([q, n]) => `${q} ${n}`);
  const errs = Object.values(stats.errors).reduce((a, b) => a + b, 0);
  return (acts.join(", ") || "nothing") + (errs ? `, ${errs} handler errors` : "") + (stats.capped ? " (CAPPED)" : "");
}

/** The top search hit for a target query, or null. Claim ids differ per run; wording is stable. */
export async function resolveTarget(query: string): Promise<ResolvedTarget | null> {
  const { results } = await hybridSearch(query, { limit: 3 });
  const top = results[0];
  return top ? { id: top.id, text: top.text } : null;
}

/** Resolve every target (and merge target) of a scenario up front. */
export async function resolveTargets(scenario: Scenario, limit?: number): Promise<ResolvedTargets> {
  const items = limit ? scenario.contributions.slice(0, limit) : scenario.contributions;
  const targets = new Map<string, ResolvedTarget | null>();
  const mergeTargets = new Map<string, ResolvedTarget | null>();
  for (const c of items) {
    targets.set(c.id, await resolveTarget(c.target.query));
    if (c.mergeTarget) mergeTargets.set(c.id, await resolveTarget(c.mergeTarget.query));
  }
  return { targets, mergeTargets };
}

export async function claimState(id: string): Promise<{ text: string; status: string | null }> {
  const [row] = await rawQuery<{ text: string; status: string | null }>(
    `SELECT c.text, a.status FROM claims c
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
      WHERE c.id = $1`,
    [id]
  );
  return { text: row?.text ?? "", status: row?.status ?? null };
}

/**
 * What each capability tier sets on the contributor row. The Reviewer reads
 * the account through get_contributor_profile (governance-tools.ts):
 * reputation_score, trust_level (reputation-service trustLevelFor: ≥80
 * trusted, ≥50 standard, ≥20 probationary, else restricted), the accepted /
 * rejected counters and acceptance rate, and last_active_at; the rate
 * limiter sandboxes accounts under 50 or younger than 24h. So a tier is a
 * reputation score, an account age, and a history:
 *
 *   fresh     15, minted now, no history — "restricted" trust, sandboxed, and
 *             five points above the auto-suspension threshold (10): one
 *             bad-faith flag (−15) burns the account, which is exactly the
 *             cost-of-attack instrument S4 reads.
 *   standard  50, 90 days old, 6 accepted / 2 rejected — "standard".
 *   trusted   85, a year old, 30 accepted / 3 rejected — "trusted".
 *
 * Written directly (the reputation service has no "set" path, only outcome
 * deltas) with a reputation_events row (reason "harness_tier") so the
 * ledger still reconstructs the score. Corpus databases only.
 */
export const TIER_PROFILES: Record<
  ContributorTier,
  { reputation: number; ageDays: number; accepted: number; rejected: number }
> = {
  fresh: { reputation: 15, ageDays: 0, accepted: 0, rejected: 0 },
  standard: { reputation: 50, ageDays: 90, accepted: 6, rejected: 2 },
  trusted: { reputation: 85, ageDays: 365, accepted: 30, rejected: 3 },
};

export async function applyTier(contributorId: string, tier: ContributorTier): Promise<void> {
  const p = TIER_PROFILES[tier];
  const [before] = await rawQuery<{ reputation_score: number }>(
    `SELECT reputation_score FROM contributors WHERE id = $1`,
    [contributorId]
  );
  const prev = before?.reputation_score ?? 50;
  await rawQuery(
    `UPDATE contributors
        SET reputation_score = $2,
            contributions_accepted = $3,
            contributions_rejected = $4,
            created_at = now() - ($5 || ' days')::interval,
            last_active_at = now()
      WHERE id = $1`,
    [contributorId, p.reputation, p.accepted, p.rejected, String(p.ageDays)]
  );
  if (prev !== p.reputation) {
    await rawQuery(
      `INSERT INTO reputation_events (contributor_id, delta, score_after, reason)
       VALUES ($1, $2, $3, 'harness_tier')`,
      [contributorId, p.reputation - prev, p.reputation]
    );
  }
}

async function personaReport(p: PersonaHandle): Promise<PersonaReport> {
  const [row] = await rawQuery<{
    reputation_score: number;
    contribution_standing: string;
    is_suspended: boolean;
    bad_faith_flags: number;
  }>(
    `SELECT reputation_score, contribution_standing, is_suspended, bad_faith_flags
       FROM contributors WHERE id = $1`,
    [p.id]
  );
  return {
    ...p,
    reputationAfter: row?.reputation_score ?? p.reputationBefore,
    standing: row?.contribution_standing ?? "?",
    suspended: row?.is_suspended ?? false,
    badFaithFlags: row?.bad_faith_flags ?? 0,
  };
}

/** Metered cost over a window, total and per agent (llm_usage is the ground truth). */
export async function costSince(since: Date): Promise<{ microUsd: number | null; byAgent: Record<string, number> }> {
  const rows = await rawQuery<{ agent: string | null; micro: string | null }>(
    `SELECT agent, SUM(cost_micro_usd) AS micro FROM llm_usage WHERE created_at >= $1 GROUP BY agent`,
    [since]
  );
  const byAgent: Record<string, number> = {};
  let total = 0;
  let any = false;
  for (const r of rows) {
    const n = r.micro != null ? Number(r.micro) : 0;
    byAgent[r.agent ?? "unknown"] = n;
    total += n;
    any = true;
  }
  return { microUsd: any ? total : null, byAgent };
}

/**
 * Run a scenario end to end. Returns the outcome of every contribution (in
 * scenario order, unresolved targets included), the runner trace, the drain
 * statistics, the metered cost, and the personas' standing before and after.
 */
export async function runScenario(scenario: Scenario, opts: RunScenarioOptions = {}): Promise<ScenarioRunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const startedAt = new Date();
  const items = opts.limit ? scenario.contributions.slice(0, opts.limit) : scenario.contributions;
  const targets = await resolveTargets(scenario, opts.limit);
  for (const c of items) {
    const t = targets.targets.get(c.id);
    log(`  ${t ? "→" : "✗"} ${c.id.padEnd(32)} ${c.type.padEnd(16)} ${t ? `"${t.text.slice(0, 70)}"` : `no claim for "${c.target.query}"`}`);
    if (c.mergeTarget) {
      const m = targets.mergeTargets.get(c.id);
      log(`      merge into ${m ? `"${m.text.slice(0, 60)}"` : `no claim for "${c.mergeTarget.query}"`}`);
    }
  }
  if (opts.dryRun) {
    return {
      outcomes: [],
      trace: [],
      drains: [],
      cost: { microUsd: null, byAgent: {} },
      personas: [],
      targets,
      appealsFiled: 0,
      startedAt,
      finishedAt: new Date(),
    };
  }

  // Personas: contributors minted for this run, tiered before they submit.
  const prefix = opts.externalIdPrefix ?? `corpus:${scenario.scenario}`;
  const personas = new Map<string, PersonaHandle>();
  for (const p of scenario.contributors) {
    const c = await getOrCreateContributor({ externalId: `${prefix}:${p.key}`, displayName: p.displayName });
    if (p.tier) await applyTier(c.id, p.tier);
    const [row] = await rawQuery<{ reputation_score: number }>(`SELECT reputation_score FROM contributors WHERE id = $1`, [c.id]);
    const handle: PersonaHandle = {
      key: p.key,
      id: c.id,
      displayName: c.displayName,
      tier: p.tier ?? null,
      reputationBefore: row?.reputation_score ?? c.reputationScore,
    };
    if (opts.personaSetup) await opts.personaSetup(handle);
    personas.set(p.key, handle);
  }

  const trace: RunnerEvent[] = [];
  const onEvent = (e: RunnerEvent) => {
    trace.push(e);
    opts.onEvent?.(e);
  };
  const drains: DrainStats[] = [];
  const outcomes: ContributionOutcome[] = [];
  const before = new Map<string, { text: string; status: string | null }>();
  const submitted = new Map<string, { contributionId: string; spec: ScenarioContribution }>();

  log("\n--- submitting ---");
  for (const c of items) {
    const t = targets.targets.get(c.id);
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
      mergeTargetClaimId: targets.mergeTargets.get(c.id)?.id,
      proposedCanonicalForm: c.proposedCanonicalForm,
    });
    await enqueueContribution({ contributionId: contribution.id });
    submitted.set(c.id, { contributionId: contribution.id, spec: c });
    log(`  + ${c.id} (${c.type}) → contribution ${contribution.id.slice(0, 8)}`);
  }

  log("\n--- draining: review, escalation, notifications ---");
  const drain1 = await drainLocalQueues({ onEvent });
  drains.push(drain1);
  log(`  ${describeDrain(drain1)}`);

  // Appeals for rejected contributions that carry a reason — the same path as POST /appeals.
  let appealsFiled = 0;
  if (opts.appeals !== false) {
    log("\n--- appeals ---");
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
      log(`  ↑ ${id}: rejected, appeal ${appeal.id.slice(0, 8)} filed`);
    }
    if (appealsFiled === 0) log("  (no rejected contribution carried an appeal)");
    else {
      log("\n--- draining: arbitration ---");
      const drain2 = await drainLocalQueues({ onEvent });
      drains.push(drain2);
      log(`  ${describeDrain(drain2)}`);
    }
  }

  // Collect what happened.
  for (const c of items) {
    const sub = submitted.get(c.id);
    if (!sub) continue;
    const t = targets.targets.get(c.id)!;
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
      submitted: {
        content: c.content,
        evidenceUrls: c.evidenceUrls ?? [],
        proposedCanonicalForm: c.proposedCanonicalForm ?? null,
      },
    });
  }
  // Keep the scenario's order for unresolved ones too.
  outcomes.sort((x, y) => items.findIndex((i) => i.id === x.id) - items.findIndex((i) => i.id === y.id));

  const personaReports = await Promise.all([...personas.values()].map(personaReport));
  const cost = await costSince(startedAt);
  return { outcomes, trace, drains, cost, personas: personaReports, targets, appealsFiled, startedAt, finishedAt: new Date() };
}
