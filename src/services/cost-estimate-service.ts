/**
 * Expected marginal cost — the EC in the allocation core's value/cost
 * standard.
 *
 * Every candidate action needs a cost estimate before it runs, because the
 * lane takes the highest expected-value / expected-cost actions first and a
 * denominator has to exist before the meter does. Estimates come in two
 * grades:
 *
 *   1. Config priors (EST_* knobs) — starting guesses, deliberately cheap
 *      to revise as the eval engine grows.
 *   2. Live percentiles of the metered billed cost of recent runs of
 *      the same agent + model, which replace the prior once enough runs
 *      exist. Estimating a cost should never rival the cost of doing the
 *      thing, so this is one aggregate query, cached for a few minutes.
 *
 * All figures are BILLED (cost-plus) micro-USD — the same denomination the
 * meter writes and the owl ledger charges, so value/cost ratios and grant
 * quotes line up with what users actually pay.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  getEffectiveAllocationPolicy,
  getMandateAllocationPolicy,
} from "./allocation-policy-service.js";

interface CacheEntry {
  value: number;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

/** Test hook. */
export function resetCostEstimateCache(): void {
  cache.clear();
}

/**
 * Billed cost of recent runs for one agent + model, or null when there are not
 * yet enough runs to trust. A "run" is approximated by per-claim grouping (one
 * steward pass = one claim's calls in the window).
 *
 * A PERCENTILE of that distribution, not the mean.
 *
 * This number is used as a cap: the allocator covers an action for it, the run
 * then costs what it costs, and any excess is consumed off the escrow WITHOUT
 * passing through an allocation — so it escapes the mandate's daily rate and is
 * bounded only by the escrow. An estimate set at the mean is therefore wrong
 * about half the time, and always in the expensive direction.
 *
 * Measured on the first live epoch (58 steward runs on Fable 5): mean 2.31
 * owls, p50 2.10, p80 3.30, p90 4.36, max 7.01. Right-skewed, so the mean
 * under-funded roughly half of runs by up to 3x and produced 11+ owls of
 * unpaced overage on the General mandate alone.
 *
 * p80 is the default: it funds the large majority of runs completely while
 * still reflecting typical cost, and the tail that remains is small. Raising it
 * further trades throughput for tightness — a bigger per-action estimate means
 * fewer actions clear the same daily rate.
 */
/**
 * The solver's series is keyed by `run_id`, not `claim_id`: several attempts
 * may share a claim (docs/mathematics.md §7.2), and one attempt is one
 * agent run. Every other agent keeps the per-claim approximation.
 */
export const SOLVER_AGENT = "math_solver";

async function recentRunCostEstimateMicroUsd(
  agent: string,
  model: string,
  opts: { variant?: string } = {}
): Promise<number | null> {
  const config = loadConfig();
  const windowDays = config.costEstimateWindowDays ?? 14;
  const minRuns = config.costEstimateMinRuns ?? 5;
  if (windowDays <= 0 || minRuns <= 0) return null;
  const percentile = Math.min(1, Math.max(0, config.costEstimatePercentile ?? 0.8));

  const key = `${agent}:${model}:${opts.variant ?? ""}:${percentile}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value || null;

  const [row] =
    agent === SOLVER_AGENT
      ? await rawQuery<{ runs: number; est_cost: number | null }>(
          // One attempt is one run, and the run's row on proof_attempts
          // carries the variant, so the two variants are two live series
          // (§7.2) even though they share a model. Lean and container rows
          // carry the same run_id and are summed in.
          `SELECT COUNT(*)::int AS runs,
                  percentile_cont($4) WITHIN GROUP (ORDER BY run_cost)::bigint AS est_cost
             FROM (SELECT u.run_id, SUM(u.cost_micro_usd) AS run_cost
                     FROM llm_usage u
                    WHERE u.agent = $1 AND u.run_id IS NOT NULL
                      AND u.created_at > now() - make_interval(days => $3)
                      AND EXISTS (SELECT 1 FROM proof_attempts p
                                   WHERE p.run_id = u.run_id AND p.model = $2
                                     AND ($5::text IS NULL OR p.variant = $5::text))
                    GROUP BY u.run_id) runs`,
          [agent, model, windowDays, percentile, opts.variant ?? null]
        )
      : await rawQuery<{ runs: number; est_cost: number | null }>(
          `SELECT COUNT(*)::int AS runs,
                  percentile_cont($4) WITHIN GROUP (ORDER BY run_cost)::bigint AS est_cost
             FROM (SELECT claim_id, SUM(cost_micro_usd) AS run_cost
                     FROM llm_usage
                    WHERE agent = $1 AND model = $2 AND claim_id IS NOT NULL
                      AND created_at > now() - make_interval(days => $3)
                    GROUP BY claim_id) runs`,
          [agent, model, windowDays, percentile]
        );
  const enough = (row?.runs ?? 0) >= minRuns && row?.est_cost != null;
  const value = enough ? Number(row!.est_cost) : 0;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return enough ? value : null;
}

/**
 * Expected cost of one solver attempt at a variant (§7.2): the live p80 of
 * recent attempts at that variant once five exist, else the funding
 * mandate's prior (`est_attempt_standard_cost_owls` or
 * `est_attempt_max_cost_owls`), in micro-USD.
 */
export async function estimateSolverAttemptCostMicroUsd(input: {
  model: string;
  variant: "standard" | "max";
  grantId?: string | null;
}): Promise<number> {
  const config = loadConfig();
  const live = await recentRunCostEstimateMicroUsd(SOLVER_AGENT, input.model, {
    variant: input.variant,
  }).catch(() => null);
  if (live != null && live > 0) return live;
  const policy = input.grantId
    ? await getMandateAllocationPolicy(input.grantId)
    : await getEffectiveAllocationPolicy();
  const priorOwls =
    input.variant === "max"
      ? policy.est_attempt_max_cost_owls
      : policy.est_attempt_standard_cost_owls;
  return Math.round(priorOwls * (config.owlCostMicroUsd ?? 1_000_000));
}

/**
 * Expected cost of one Steward pass on the given model, in billed
 * micro-USD: the live percentile when there is one, the config prior
 * otherwise.
 */
export async function estimateStewardRunCostMicroUsd(
  model: string
): Promise<number> {
  const config = loadConfig();
  const live = await recentRunCostEstimateMicroUsd("steward", model).catch(
    () => null
  );
  if (live != null && live > 0) return live;
  // Priors come from the governing mandate's allocation policy (config is
  // the fallback default inside it).
  const policy = await getEffectiveAllocationPolicy();
  const strong =
    !!config.stewardStrongModel && model === config.stewardStrongModel;
  const priorOwls = strong
    ? policy.est_steward_run_cost_strong_owls
    : policy.est_steward_run_cost_owls;
  return Math.round(priorOwls * (config.owlCostMicroUsd ?? 1_000_000));
}

/**
 * The two tier estimates the drain's value/cost ordering needs, computed
 * once per drain pass (not per row).
 */
export async function stewardTierCostEstimates(): Promise<{
  standardMicroUsd: number;
  strongMicroUsd: number;
}> {
  const config = loadConfig();
  const standardMicroUsd = await estimateStewardRunCostMicroUsd(
    config.stewardModel
  );
  const strongMicroUsd = config.stewardStrongModel
    ? await estimateStewardRunCostMicroUsd(config.stewardStrongModel)
    : standardMicroUsd;
  return { standardMicroUsd, strongMicroUsd };
}
