/**
 * The Costing skill's tool (skills/costing): cost_sheet, the live price list
 * an agent prices work from before anyone pays for it.
 *
 * Every figure is metered spend the platform recorded, in USD (one owl
 * each): research runs by model tier from `research_runs`, Steward passes
 * from the cost estimator the ledger itself uses, a request's scoping pass
 * from the ledger, and the paid tools' configured charges. Each line gives
 * the typical figure and the 80th percentile, the one a ceiling should use.
 * Where too few runs exist the line says so and falls back to a prior.
 * Read-only: it prices steps and never judges what work is worth.
 */
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import {
  estimateLedgerKindCostMicroUsd,
  stewardTierCostEstimates,
} from "../../services/cost-estimate-service.js";
import { modelForTier, RESEARCH_MODEL_TIERS } from "../../services/research-run-service.js";
import { elicitConfigured } from "./elicit-tools.js";
import type { SkillToolExecutor } from "./skill-tools.js";

/** How far back the research figures look. */
const WINDOW_DAYS = 30;
/** Fewer finished runs than this on a tier, and its line is marked thin. */
const MIN_RUNS = 5;

const usd = (micro: number | string | null | undefined): number | null =>
  micro == null ? null : Math.round(Number(micro) / 10_000) / 100;

const executeCostSheet: SkillToolExecutor = async () => {
  const config = loadConfig();
  const runs = await rawQuery<{ model_tier: string; runs: number; p50: string | null; p80: string | null; max: string | null }>(
    `SELECT model_tier, COUNT(*)::int AS runs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY spent_micro_usd)::bigint AS p50,
            percentile_cont(0.8) WITHIN GROUP (ORDER BY spent_micro_usd)::bigint AS p80,
            MAX(spent_micro_usd)::bigint AS max
       FROM research_runs
      WHERE finished_at > now() - make_interval(days => $1)
        AND spent_micro_usd > 0
      GROUP BY model_tier`,
    [WINDOW_DAYS]
  );
  const byTier = new Map(runs.map((r) => [r.model_tier, r]));
  const research = RESEARCH_MODEL_TIERS.map((tier) => {
    const r = byTier.get(tier);
    return {
      tier,
      model: modelForTier(tier),
      runs_last_30_days: r?.runs ?? 0,
      typical_usd: usd(r?.p50),
      ceiling_usd: usd(r?.p80),
      largest_usd: usd(r?.max),
      ...((r?.runs ?? 0) < MIN_RUNS
        ? { note: "Too few runs to go on: price this tier from the steps and allow more room." }
        : {}),
    };
  });
  const steward = await stewardTierCostEstimates();
  const scope = await estimateLedgerKindCostMicroUsd("request_scope");
  const paidTools: Record<string, string> = {};
  if (elicitConfigured(config)) paidTools.elicit = `about $${config.elicitUsdPerCall} per call`;
  if (config.pangramApiKey) {
    paidTools.pangram =
      `about $${config.pangramAiUsdPerWord} per word for an AI-writing check, ` +
      `$${config.pangramPlagiarismUsdPerWord} per word for a similarity check`;
  }
  return JSON.stringify({
    success: true,
    research_runs: research,
    steward_pass: {
      standard_usd: usd(steward.standardMicroUsd),
      strong_usd: usd(steward.strongMicroUsd),
    },
    request_scoping_pass_usd: usd(scope),
    paid_tools: paidTools,
    note:
      "USD of metered spend, one owl each. A research run's cost is mostly its model's calls; " +
      "paid tools are charged on top, per call or per word. Price a budget from the steps at the " +
      "ceiling figures, and add room for what you cannot foresee.",
  });
};

export function registerCostingTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  register("cost_sheet", executeCostSheet);
}
