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
 * (getMandateAllocationPolicy). No agent writes that column: the one
 * writer is scripts/seed-platform-mandates.ts, which merges the keys a
 * platform mandate's seed names over what is stored.
 *
 * Every key declared here has a reader. The keys only the retired value
 * formula and its allocator read were removed once nothing read them. Until
 * #855 a mandate's Grantmaker had a tool that set policy keys, so a stored
 * row may still hold any of them. Such a row loads as if they were not
 * there: overlayPolicy reads only the keys in POLICY_BOUNDS and ignores
 * every other (tests/unit/services/allocation-policy-service.test.ts lists
 * the removed keys and holds this).
 *
 * Every stored value is clamped to POLICY_BOUNDS on read, so a stored
 * policy cannot put a figure outside its range.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

export interface AllocationPolicy {
  /** Cost priors per Steward pass, in owls, until live averages exist. */
  est_steward_run_cost_owls: number;
  est_steward_run_cost_strong_owls: number;
  /** Re-check cadence: a claim is due for a cadence check this many days
   *  after its assessment in force, divided by its queue priority held to
   *  0.25 to 2 (workers/allocation-scheduler.ts). */
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
  /** Cost prior for one `curate` run, in owls, until the ledger holds
   *  enough completed runs for the live p80. */
  est_curate_cost_owls: number;
  /** Cost prior for one `audit` run, in owls, likewise. */
  est_audit_cost_owls: number;
  /** How much more a strong consistency sweep is expected to find than a
   *  standard one of the same partition (#756). The strong variant is
   *  bought when this × the standard's price covers the strong one's
   *  (allocation-service consistencySweepVariant). A value stored on the
   *  General mandate is an override. Without one the figure is read from
   *  evidence once each variant has enough sweeps, the ratio of the two
   *  variants' upheld flags per node read (consistencyStrongExpectedGain),
   *  and this default stands until then. No agent has a tool that stores an
   *  override; the corpus consistency eval (scripts/corpus/consistency.ts)
   *  run on both tiers gives the recall ratio one would be set from. */
  consistency_strong_expected_gain: number;
  /** Expected cost of reading one assessed node in a consistency sweep, in
   *  owls, for a reader whose model the rate table cannot price (an
   *  OpenRouter model, whose provider reports each call's cost): the prior
   *  until that variant's sweeps give an observed cost per node (#756). */
  est_consistency_node_cost_owls: number;
  /** Reconcile candidates the scan may raise per sweep (0 = off). */
  reconcile_candidates_max_per_sweep: number;
  /** The scan's similarity floor: pairs of unlinked active claims whose
   *  embeddings are at least this similar. */
  reconcile_candidate_min_similarity: number;
  // --- Requests (Part VIII): a request is a ledger row like any other work.
  // What doing it costs is the request's own (its stated budget, or the
  // quote its scoping pass returned).
  /** Cost prior for one scoping pass on a request with no budget, in owls,
   *  until the ledger holds enough completed scoping passes for the p80. */
  est_request_scope_cost_owls: number;
}

/** The range each key is held to: a stored value outside it is clamped on
 *  read (clampToBounds). */
export const POLICY_BOUNDS: Record<
  keyof AllocationPolicy,
  { min: number; max: number }
> = {
  est_steward_run_cost_owls: { min: 0.001, max: 100 },
  est_steward_run_cost_strong_owls: { min: 0.001, max: 100 },
  staleness_base_days: { min: 1, max: 3650 },
  est_formalize_cost_owls: { min: 0.1, max: 100 },
  est_attempt_standard_cost_owls: { min: 1, max: 1000 },
  est_attempt_max_cost_owls: { min: 1, max: 2000 },
  est_prize_review_cost_owls: { min: 0.1, max: 200 },
  attempt_cooldown_days: { min: 0, max: 365 },
  attempt_claim_lifetime_cap_owls: { min: 0, max: 10000 },
  est_curate_cost_owls: { min: 0.01, max: 20 },
  est_audit_cost_owls: { min: 0.01, max: 20 },
  consistency_strong_expected_gain: { min: 1, max: 50 },
  est_consistency_node_cost_owls: { min: 0.0001, max: 1 },
  reconcile_candidates_max_per_sweep: { min: 0, max: 200 },
  reconcile_candidate_min_similarity: { min: 0.5, max: 1 },
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
    est_steward_run_cost_owls: c.estStewardRunCostOwls ?? 0.25,
    est_steward_run_cost_strong_owls: c.estStewardRunCostStrongOwls ?? 1,
    staleness_base_days: c.stalenessBaseDays ?? 60,
    // The mathematics priors are the design's (§10.5), not env knobs. A
    // stored policy from before these keys existed reads back with them
    // filled in.
    est_formalize_cost_owls: 8,
    est_attempt_standard_cost_owls: 60,
    est_attempt_max_cost_owls: 150,
    est_prize_review_cost_owls: 12,
    attempt_cooldown_days: 30,
    attempt_claim_lifetime_cap_owls: 500,
    // Maintenance and audit (#363). The design's priors. The first live
    // epoch's unconditional sweeps cost about 0.11 owl each and wrote
    // nothing; a run with a real concern does more, so the curate prior
    // sits about twice that.
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
    reconcile_candidates_max_per_sweep: 0,
    reconcile_candidate_min_similarity: 0.92,
    // Requests (Part VIII). The design's prior for a scoping pass.
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
 * key since removed (the value formula's and the allocator's, which nothing
 * read after #855) loads as if the key were not there.
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
 * that grant's own allocation_policy. A mandate that stores none has
 * exactly what the platform ships.
 */
export async function getMandateAllocationPolicy(
  grantId: string
): Promise<AllocationPolicy> {
  const [row] = await rawQuery<{
    allocation_policy: Partial<AllocationPolicy> | null;
  }>(`SELECT allocation_policy FROM grants WHERE id = $1`, [grantId]);
  return overlayPolicy(defaultsFromConfig(), row?.allocation_policy);
}
