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
 *   2. Live rolling averages of the metered billed cost of recent runs of
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
import { getEffectiveAllocationPolicy } from "./allocation-policy-service.js";

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
 * Rolling average billed cost of recent runs for one agent + model, or null
 * when there are not yet enough runs to trust. A "run" is approximated by
 * per-claim grouping (one steward pass = one claim's calls in the window).
 */
async function recentAverageRunCostMicroUsd(
  agent: string,
  model: string
): Promise<number | null> {
  const config = loadConfig();
  const windowDays = config.costEstimateWindowDays ?? 14;
  const minRuns = config.costEstimateMinRuns ?? 5;
  if (windowDays <= 0 || minRuns <= 0) return null;

  const key = `${agent}:${model}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value || null;

  const [row] = await rawQuery<{ runs: number; avg_cost: number | null }>(
    `SELECT COUNT(*)::int AS runs, AVG(run_cost)::bigint AS avg_cost
       FROM (SELECT claim_id, SUM(cost_micro_usd) AS run_cost
               FROM llm_usage
              WHERE agent = $1 AND model = $2 AND claim_id IS NOT NULL
                AND created_at > now() - make_interval(days => $3)
              GROUP BY claim_id) runs`,
    [agent, model, windowDays]
  );
  const enough = (row?.runs ?? 0) >= minRuns && row?.avg_cost != null;
  const value = enough ? Number(row!.avg_cost) : 0;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return enough ? value : null;
}

/**
 * Expected cost of one Steward pass on the given model, in billed
 * micro-USD: the live rolling average when there is one, the config prior
 * otherwise.
 */
export async function estimateStewardRunCostMicroUsd(
  model: string
): Promise<number> {
  const config = loadConfig();
  const live = await recentAverageRunCostMicroUsd("steward", model).catch(
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
