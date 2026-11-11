/**
 * Allocation policy: the figures the platform's machinery reads when it
 * prices and paces work, with their bounds and defaults.
 *
 * It decides nothing about what is funded. Since #855 no formula does: each
 * payer commissions work by its own judgment, a mandate through the
 * operating policy its Grantmaker writes in prose and the program officers
 * who work under it (operating-policy-service.ts; docs/allocation.md, "The
 * standard"). What is kept here is what code still needs a figure for:
 *
 *   - cost priors (the est_* keys): what a run of each kind is expected to
 *     cost until the ledger holds enough metered runs for a live estimate
 *     (cost-estimate-service.ts), and what the cost sheet shows agents
 *     (llm/tools/costing-tools.ts);
 *   - the re-check cadence (staleness_base_days), which makes candidates
 *     and spends nothing (workers/allocation-scheduler.ts);
 *   - the attempt cooldown and per-claim attempt cap on mathematical claims
 *     (action-service.ts, attempt-service.ts);
 *   - the consistency sweep's expected gain and per-node cost, and the
 *     reconcile scan's size and similarity floor.
 *
 * The values in force are the shared defaults below (env config for some,
 * the design's figures for the rest) overlaid with what a mandate stores in
 * grants.allocation_policy: the General mandate's for the platform's own
 * work (getEffectiveAllocationPolicy), a mandate's own for its own
 * (getMandateAllocationPolicy). No agent writes that column now. The
 * Grantmaker's update_allocation_policy tool went with the formulas in
 * #855; the one writer left is scripts/seed-platform-mandates.ts, which
 * merges the keys a platform mandate's seed names over what is stored. A
 * row written before then may hold any key the tool could set.
 *
 * Several keys below were read only by the retired value formula and its
 * allocator, and nothing reads them now. They are still declared, bounded
 * and defaulted. A stored policy needs none of that to load: overlayPolicy
 * reads only the keys in POLICY_BOUNDS and ignores every other.
 *
 * Every stored value is clamped to POLICY_BOUNDS on read, so a stored
 * policy cannot put a figure outside its range.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

export interface AllocationPolicy {
  /** Value formula: contested-factor floor (how fundable uncontested stays). */
  contestation_floor: number;
  /** Value boost for human-proposed claims. */
  user_provenance_boost: number;
  /** Expected gain of a strong-model pass over a standard one:
   *  value(strong) = value(standard) × this. The marginal-return rule
   *  (Δvalue/Δcost vs. the day's bar) decides whether the upgrade is
   *  actually bought. */
  strong_gain_multiplier: number;
  /** Cost priors per Steward pass, in owls, until live averages exist. */
  est_steward_run_cost_owls: number;
  est_steward_run_cost_strong_owls: number;
  /** Reassessment cadence: base days, divided by clamped expected value. */
  staleness_base_days: number;
  // --- Mathematics (docs/mathematics.md §10.5): cost priors for the three
  // new action kinds until the live p80 exists, and the attempt bounds the
  // Grantmaker plans within. Priors, not prices: the run costs what it
  // costs, and the estimator replaces these after five live runs.
  /** One `formalize` action (two Steward passes plus elaboration), in owls. */
  est_formalize_cost_owls: number;
  /** One `attempt_proof` at the standard variant (effort high), in owls. */
  est_attempt_standard_cost_owls: number;
  /** One `attempt_proof` at the max variant (effort max), in owls. */
  est_attempt_max_cost_owls: number;
  /** One `prize_review` (check, Reviewer, Steward, audit), in owls. */
  est_prize_review_cost_owls: number;
  /** Days after an attempt closes before the next one may open on the same
   *  statement, absent a stated reason (§7.2). */
  attempt_cooldown_days: number;
  /** Per-claim lifetime attempt spend, in owls; a plan item's
   *  lifetime_cap_owls may raise one claim's cap to at most twice this. */
  attempt_claim_lifetime_cap_owls: number;
  // --- Maintenance and audit (#363): curation and audit are ledger actions
  // a mandate chooses to buy, not work induced onto whoever is nearest.
  /** Read by nothing: the allocator that held a mandate's maintenance to
   *  this share of its daily rate was retired in #855. Still declared, like
   *  the other unread keys (module header); a stored policy that holds it
   *  would load the same without it. */
  maintenance_share: number;
  /** Cost prior for one `curate` run, in owls, until the ledger holds
   *  enough completed runs for the live p80. */
  est_curate_cost_owls: number;
  /** Cost prior for one `audit` run, in owls, likewise. */
  est_audit_cost_owls: number;
  /** How much more a strong consistency sweep is expected to find than a
   *  standard one of the same partition (#756): value(strong) =
   *  value(standard) × this. A sweep carries no value of its own to set
   *  against the day's bar, so the marginal-return rule compares the upgrade
   *  with the sweep itself: the strong variant is bought when this × the
   *  standard's price covers the strong one's (allocation-service
   *  consistencySweepVariant). Setting it on a mandate is an override: once
   *  each variant has enough sweeps, the General mandate otherwise reads it
   *  from evidence, the ratio of the two variants' upheld flags per node
   *  read (consistencyStrongExpectedGain), and this default stands only
   *  until then. The corpus consistency eval (scripts/corpus/consistency.ts)
   *  run on both tiers gives the recall ratio a Grantmaker would set it to. */
  consistency_strong_expected_gain: number;
  /** Expected cost of reading one assessed node in a consistency sweep, in
   *  owls, for a reader whose model the rate table cannot price (an
   *  OpenRouter model, whose provider reports each call's cost): the prior
   *  until that variant's sweeps give an observed cost per node (#756). */
  est_consistency_node_cost_owls: number;
  /** Formula weight of a reconcile-candidate request (a similarity scan's
   *  pair, times its score) relative to a Steward's escalation (1.0): a
   *  scan saw two texts; an agent read the claim. */
  curate_candidate_weight: number;
  /** A claim the Matcher admitted as novel this recently, with no agent
   *  asking since, is worth nothing to curate: the check just ran. */
  curate_matcher_quiet_days: number;
  /** Reconcile candidates the scan may raise per sweep (0 = off). */
  reconcile_candidates_max_per_sweep: number;
  /** The scan's similarity floor: pairs of unlinked active claims whose
   *  embeddings are at least this similar. */
  reconcile_candidate_min_similarity: number;
  /** Audit formula weights by trigger class (a formula mandate that funds
   *  audits: the platform's Governance mandate). An audit's value is its
   *  class weight, rising to twice that as it waits a week. */
  audit_value_prize: number;
  audit_value_bad_faith: number;
  audit_value_overturn: number;
  audit_value_anomaly: number;
  audit_value_suspension: number;
  audit_value_sweep: number;
  // --- Requests (Part VIII): a request is a ledger row like any other work.
  // What doing it costs is the request's own (its stated budget, or the
  // quote its scoping pass returned); what it is worth is each mandate's.
  /** A request's formula value relative to one assessment of the most
   *  important claim it bears on: its outcome can move several judgments,
   *  and the work behind it is usually more than a pass. */
  request_value_weight: number;
  /** Weight of a request filed through review (a contributor's or a
   *  mandate's) relative to one an agent or operator filed (1.0). */
  request_reviewed_weight: number;
  /** The importance a request is valued at when it bears on no claim (a
   *  source, or something the graph does not hold yet). */
  request_untargeted_importance: number;
  /** A request's value rises to twice its base as it waits this many days. */
  request_wait_days: number;
  /** Cost prior for one scoping pass on a request with no budget, in owls,
   *  until the ledger holds enough completed scoping passes for the p80. */
  est_request_scope_cost_owls: number;
}

/** The bounds of the framework: what the Grantmaker may set each knob to. */
export const POLICY_BOUNDS: Record<
  keyof AllocationPolicy,
  { min: number; max: number }
> = {
  contestation_floor: { min: 0, max: 1 },
  user_provenance_boost: { min: 0, max: 2 },
  strong_gain_multiplier: { min: 1, max: 5 },
  est_steward_run_cost_owls: { min: 0.001, max: 100 },
  est_steward_run_cost_strong_owls: { min: 0.001, max: 100 },
  staleness_base_days: { min: 1, max: 3650 },
  est_formalize_cost_owls: { min: 0.1, max: 100 },
  est_attempt_standard_cost_owls: { min: 1, max: 1000 },
  est_attempt_max_cost_owls: { min: 1, max: 2000 },
  est_prize_review_cost_owls: { min: 0.1, max: 200 },
  attempt_cooldown_days: { min: 0, max: 365 },
  attempt_claim_lifetime_cap_owls: { min: 0, max: 10000 },
  maintenance_share: { min: 0, max: 1 },
  est_curate_cost_owls: { min: 0.01, max: 20 },
  est_audit_cost_owls: { min: 0.01, max: 20 },
  consistency_strong_expected_gain: { min: 1, max: 50 },
  est_consistency_node_cost_owls: { min: 0.0001, max: 1 },
  curate_candidate_weight: { min: 0, max: 1 },
  curate_matcher_quiet_days: { min: 0, max: 365 },
  reconcile_candidates_max_per_sweep: { min: 0, max: 200 },
  reconcile_candidate_min_similarity: { min: 0.5, max: 1 },
  audit_value_prize: { min: 0, max: 10 },
  audit_value_bad_faith: { min: 0, max: 10 },
  audit_value_overturn: { min: 0, max: 10 },
  audit_value_anomaly: { min: 0, max: 10 },
  audit_value_suspension: { min: 0, max: 10 },
  audit_value_sweep: { min: 0, max: 10 },
  request_value_weight: { min: 0, max: 100 },
  request_reviewed_weight: { min: 0, max: 1 },
  request_untargeted_importance: { min: 0, max: 1 },
  request_wait_days: { min: 1, max: 365 },
  est_request_scope_cost_owls: { min: 0.01, max: 20 },
};

export interface GeneralMandate {
  grantId: string;
  budgetJobId: string;
  dailyBudgetMicroUsd: number;
  budgetMicroUsd: number;
  jobStatus: string;
  allocationPolicy: Partial<AllocationPolicy> | null;
}

interface Cache<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
let mandateCache: Cache<GeneralMandate | null> | null = null;

/** Test hook. */
export function resetAllocationPolicyCache(): void {
  mandateCache = null;
}

/**
 * The platform's General mandate, if seeded (dev and tests run
 * without one and fall back to config alone). Cached for a minute — policy
 * changes land on the next drain pass, not the same tick.
 */
export async function getGeneralMandate(): Promise<GeneralMandate | null> {
  if (mandateCache && mandateCache.expiresAt > Date.now()) {
    return mandateCache.value;
  }
  let value: GeneralMandate | null = null;
  try {
    const [row] = await rawQuery<{
      id: string;
      budget_job_id: string;
      daily_budget_micro_usd: number;
      allocation_policy: Partial<AllocationPolicy> | null;
      budget_micro_usd: number;
      job_status: string;
    }>(
      `SELECT g.id, g.budget_job_id, g.daily_budget_micro_usd,
              g.allocation_policy, j.budget_micro_usd, j.status AS job_status
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.is_platform = true AND g.policy = 'general'
          AND g.status = 'active'
        ORDER BY g.created_at ASC
        LIMIT 1`
    );
    if (row) {
      value = {
        grantId: row.id,
        budgetJobId: row.budget_job_id,
        dailyBudgetMicroUsd: Number(row.daily_budget_micro_usd),
        budgetMicroUsd: Number(row.budget_micro_usd),
        jobStatus: row.job_status,
        allocationPolicy: row.allocation_policy,
      };
    }
  } catch {
    // Pre-migration databases (tests, fresh dev) have no mandate; config
    // defaults govern.
  }
  mandateCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/**
 * The platform's Governance mandates (#363, policy 'governance'): the ones
 * a fresh audit is raised to (maintenance-funding.ts), never one whose
 * subject is itself. Uncached: read per audit, never per row.
 */
export async function getGovernanceMandateIds(): Promise<string[]> {
  try {
    const rows = await rawQuery<{ id: string }>(
      `SELECT id FROM grants
        WHERE policy = 'governance' AND status = 'active'
        ORDER BY created_at ASC`
    );
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

function defaultsFromConfig(): AllocationPolicy {
  const c = loadConfig();
  return {
    contestation_floor: c.valueContestationFloor ?? 0.25,
    user_provenance_boost: c.priorityUserProvenanceBoost ?? 0.15,
    strong_gain_multiplier: c.strongGainMultiplier ?? 1.3,
    est_steward_run_cost_owls: c.estStewardRunCostOwls ?? 0.25,
    est_steward_run_cost_strong_owls: c.estStewardRunCostStrongOwls ?? 1,
    staleness_base_days: c.stalenessBaseDays ?? 60,
    // The mathematics priors are the design's (§10.5), not env knobs: a
    // mandate that learns better figures amends them through its
    // Grantmaker, and a stored policy from before these keys existed reads
    // back with them filled in.
    est_formalize_cost_owls: 8,
    est_attempt_standard_cost_owls: 60,
    est_attempt_max_cost_owls: 150,
    est_prize_review_cost_owls: 12,
    attempt_cooldown_days: 30,
    attempt_claim_lifetime_cap_owls: 500,
    // Maintenance and audit (#363). The design's priors, amendable by each
    // mandate's Grantmaker. The first live epoch's unconditional sweeps
    // cost about 0.11 owl each and wrote nothing; a run with a real concern
    // does more, so the curate prior sits about twice that.
    maintenance_share: 0.1,
    est_curate_cost_owls: 0.25,
    est_audit_cost_owls: 0.5,
    // Until both variants have enough sweeps for the evidence (#756). At
    // the default price-based estimates a strong sweep costs about 8 times
    // a standard one below the caps and 5 times where both caps bind (400
    // nodes and up), so 5 buys the strong read for the largest partitions
    // and the standard for the rest: both variants run, which is what lets
    // their upheld flags be compared. 3, the earlier guess, meant never.
    consistency_strong_expected_gain: 5,
    // The standard reader is an OpenRouter model (no rate-table entry).
    // Its same-family direct listing (gpt-5.6-luna, $0.20/$1.20 a million
    // tokens) at the sweep's per-node token assumption comes to about
    // 0.004 owl a node; the first live sweeps metered about 0.0007. Set a
    // little above the listing so the first sweeps can read everything.
    est_consistency_node_cost_owls: 0.005,
    curate_candidate_weight: 0.5,
    curate_matcher_quiet_days: 7,
    reconcile_candidates_max_per_sweep: 0,
    reconcile_candidate_min_similarity: 0.92,
    audit_value_prize: 1,
    audit_value_bad_faith: 0.9,
    audit_value_overturn: 0.8,
    audit_value_anomaly: 0.6,
    audit_value_suspension: 0.5,
    audit_value_sweep: 0.3,
    // Requests (Part VIII). The design's priors: a formula values a request
    // at a few assessments of what it bears on, so it funds the modest ones
    // by itself; a large budget needs a mandate whose Grantmaker judges it
    // worth that, or funders who chip in.
    request_value_weight: 3,
    request_reviewed_weight: 0.8,
    request_untargeted_importance: 0.3,
    request_wait_days: 14,
    est_request_scope_cost_owls: 2,
  };
}

function clampToBounds(
  key: keyof AllocationPolicy,
  value: unknown
): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const b = POLICY_BOUNDS[key];
  return Math.min(b.max, Math.max(b.min, n));
}

/**
 * Overlay a stored partial policy onto a base, ignoring invalid keys. Only
 * the keys in POLICY_BOUNDS are read, so a stored policy that still holds a
 * key since removed (staleness_saturation_days, which nothing read after
 * the value formula was retired) loads as if the key were not there.
 */
export function overlayPolicy(
  base: AllocationPolicy,
  partial: Partial<AllocationPolicy> | null | undefined
): AllocationPolicy {
  if (!partial) return base;
  const out = { ...base };
  for (const key of Object.keys(POLICY_BOUNDS) as (keyof AllocationPolicy)[]) {
    if (partial[key] !== undefined) {
      const v = clampToBounds(key, partial[key]);
      if (v != null) out[key] = v;
    }
  }
  return out;
}

/**
 * The policy in force for the platform lane: config defaults overlaid with
 * the General mandate's own policy.
 */
export async function getEffectiveAllocationPolicy(): Promise<AllocationPolicy> {
  const mandate = await getGeneralMandate();
  return overlayPolicy(defaultsFromConfig(), mandate?.allocationPolicy);
}

/**
 * The policy in force for ONE mandate: the shared defaults overlaid with
 * that grant's own allocation_policy. This is what makes the machinery
 * replicable — any mandate can carry its own formulas, and absent one it
 * inherits exactly what the platform ships.
 */
export async function getMandateAllocationPolicy(
  grantId: string
): Promise<AllocationPolicy> {
  const [row] = await rawQuery<{
    allocation_policy: Partial<AllocationPolicy> | null;
  }>(`SELECT allocation_policy FROM grants WHERE id = $1`, [grantId]);
  return overlayPolicy(defaultsFromConfig(), row?.allocation_policy);
}
