/**
 * Allocation policy — the rules of the platform's own spending, owned by
 * an agent, not by code.
 *
 * Minerval's background lane is itself a mandate ("General assessment",
 * platform-run, policy 'general'): its escrow is however many dollars the
 * platform allocates to expanding and maintaining the graph, its daily
 * spend rate paces the lane, and — the point of this module — its
 * ALLOCATION POLICY holds the formulas the lane runs on: the value
 * heuristic's knobs, the cost priors, the model-tier threshold, the
 * reassessment cadence. The policy is amended by the mandate's Grantmaker
 * in conversation (update_allocation_policy), never edited directly: when
 * we learn something about allocation, we ask the agent to change its
 * formula. Env config supplies the shared DEFAULTS — the same defaults any
 * other mandate inherits, so the machinery stays replicable — and the
 * governing mandate's policy overlays them.
 *
 * Every knob is bounded here, mechanically: the agent has near-total
 * control of the process within the framework, and the framework is these
 * ranges.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

export interface AllocationPolicy {
  /** Value formula: contested-factor floor (how fundable uncontested stays). */
  contestation_floor: number;
  /** Days until staleness alone fully revives a claim's expected gain. */
  staleness_saturation_days: number;
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
  /** Max reassessments enqueued per sweep (bounded producer, #295). */
  staleness_max_per_sweep: number;
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
  /** The most of the daily rate the mandate's allocator places on
   *  maintenance (`curate` rows) in a day. Maintenance increments are funded
   *  first, best value per owl first, up to this share; whatever they leave
   *  unused flows back to the rest of the day's work in the same pass. */
  maintenance_share: number;
  /** Cost prior for one `curate` run, in owls, until the ledger holds
   *  enough completed runs for the live p80. */
  est_curate_cost_owls: number;
  /** Cost prior for one `audit` run, in owls, likewise. */
  est_audit_cost_owls: number;
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
}

/** The bounds of the framework: what the Grantmaker may set each knob to. */
export const POLICY_BOUNDS: Record<
  keyof AllocationPolicy,
  { min: number; max: number }
> = {
  contestation_floor: { min: 0, max: 1 },
  staleness_saturation_days: { min: 1, max: 3650 },
  user_provenance_boost: { min: 0, max: 2 },
  strong_gain_multiplier: { min: 1, max: 5 },
  est_steward_run_cost_owls: { min: 0.001, max: 100 },
  est_steward_run_cost_strong_owls: { min: 0.001, max: 100 },
  staleness_base_days: { min: 1, max: 3650 },
  staleness_max_per_sweep: { min: 0, max: 1000 },
  est_formalize_cost_owls: { min: 0.1, max: 100 },
  est_attempt_standard_cost_owls: { min: 1, max: 1000 },
  est_attempt_max_cost_owls: { min: 1, max: 2000 },
  est_prize_review_cost_owls: { min: 0.1, max: 200 },
  attempt_cooldown_days: { min: 0, max: 365 },
  attempt_claim_lifetime_cap_owls: { min: 0, max: 10000 },
  maintenance_share: { min: 0, max: 1 },
  est_curate_cost_owls: { min: 0.01, max: 20 },
  est_audit_cost_owls: { min: 0.01, max: 20 },
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
 * The platform's General assessment mandate, if seeded (dev and tests run
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
 * The platform's Governance mandates (#363): formula mandates (policy
 * 'governance') whose valuations span the open `audit` rows. Every active
 * one values audits by its own policy's weights; none values an audit of
 * itself. Uncached: read by the valuer and the executor, never per row.
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
    staleness_saturation_days: c.priorityStalenessSaturationDays ?? 90,
    user_provenance_boost: c.priorityUserProvenanceBoost ?? 0.15,
    strong_gain_multiplier: c.strongGainMultiplier ?? 1.3,
    est_steward_run_cost_owls: c.estStewardRunCostOwls ?? 0.25,
    est_steward_run_cost_strong_owls: c.estStewardRunCostStrongOwls ?? 1,
    staleness_base_days: c.stalenessBaseDays ?? 60,
    staleness_max_per_sweep: c.stalenessMaxPerSweep ?? 5,
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

/** Overlay a stored partial policy onto a base, ignoring invalid keys. */
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

export type PolicyUpdateResult =
  | { ok: true; policy: AllocationPolicy; changed: string[] }
  | { ok: false; problem: string };

/**
 * Amend one mandate's allocation policy — the Grantmaker's write, bounded
 * by POLICY_BOUNDS. Unknown keys are rejected loudly (the agent should
 * know its own framework), in-bounds values are stored, and the change
 * takes effect on the next drain pass.
 */
export async function updateAllocationPolicy(
  grantId: string,
  updates: Record<string, unknown>
): Promise<PolicyUpdateResult> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: false, problem: "no keys to update" };
  const valid: Partial<AllocationPolicy> = {};
  for (const key of keys) {
    if (!(key in POLICY_BOUNDS)) {
      return {
        ok: false,
        problem: `unknown policy key "${key}"; known keys: ${Object.keys(POLICY_BOUNDS).join(", ")}`,
      };
    }
    const v = clampToBounds(key as keyof AllocationPolicy, updates[key]);
    if (v == null) {
      return { ok: false, problem: `policy key "${key}" needs a number` };
    }
    valid[key as keyof AllocationPolicy] = v;
  }
  const rows = await rawQuery<{ allocation_policy: Partial<AllocationPolicy> }>(
    `UPDATE grants
        SET allocation_policy = COALESCE(allocation_policy, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING allocation_policy`,
    [grantId, JSON.stringify(valid)]
  );
  if (rows.length === 0) {
    return { ok: false, problem: "grant not found or not active" };
  }
  resetAllocationPolicyCache();
  return {
    ok: true,
    policy: overlayPolicy(defaultsFromConfig(), rows[0]!.allocation_policy),
    changed: keys,
  };
}
