/**
 * The Costing skill's tool (skills/costing): cost_sheet, the live price list
 * an agent prices work from before anyone pays for it.
 *
 * Every figure is metered spend the platform recorded, in USD (one owl
 * each): research runs by model tier from `research_runs`, Steward passes
 * from the cost estimator the ledger itself uses, a request's scoping pass
 * from the ledger, a contribution's review, the paid tools' configured
 * charges, and every kind of work on the action ledger (what a mandate
 * funds) from the metered cost of its finished rows. Each line gives the
 * typical figure and the 80th percentile, the one a ceiling should use.
 * Where too few runs exist the line says so and falls back to a prior.
 * Read-only: it prices steps and never judges what work is worth.
 */
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import {
  estimateConsistencyNodeCostMicroUsd,
  estimateLedgerKindCostMicroUsd,
  stewardTierCostEstimates,
} from "../../services/cost-estimate-service.js";
import { CONSISTENCY_SWEEP_MIN_NODES, consistencySweepPrice } from "../../services/action-service.js";
import { getEffectiveAllocationPolicy } from "../../services/allocation-policy-service.js";
import { reviewCostEstimateMicroUsd } from "../../services/contribution-service.js";
import { capMicroUsd } from "../../services/owl.js";
import { modelForTier, RESEARCH_MODEL_TIERS } from "../../services/research-run-service.js";
import { elicitConfigured } from "./elicit-tools.js";
import type { SkillToolExecutor } from "./skill-tools.js";

/** How far back the research figures look. */
const WINDOW_DAYS = 30;
/** Fewer finished runs than this on a tier, and its line is marked thin. */
const MIN_RUNS = 5;

const usd = (micro: number | string | null | undefined): number | null =>
  micro == null ? null : Math.round(Number(micro) / 10_000) / 100;

/** What each kind of ledger work is, in a funder's words. */
const LEDGER_KINDS: Record<string, string> = {
  assess: "a Steward pass on a node with no assessment yet (assess and deepen items)",
  reassess: "a fresh Steward pass on an assessed node",
  ingest: "extracting and matching one source; the claims it brings in are assessed separately",
  formalize: "drafting and reviewing a Lean statement of a mathematical claim",
  attempt_proof: "one proof attempt on a published statement",
  curate: "a Curator run reconciling the structure around one node",
  audit: "one Audit Agent run",
  request: "a request taken up: the scope variant quotes it, the full variant costs its budget",
  lookout_run: "one run of a standing lookout",
  correspondent_run: "one run of a Correspondent: reading what changed in its scope and writing one update",
  mandate_review: "one review pass by a mandate's Grantmaker",
  grant_planning: "a Grantmaker's planning pass on a new mandate",
  prize_review: "a review of a prize claim",
  consistency_sweep:
    "a Consistency Checker sweep over one partition (a topic tag, or the residual bucket), " +
    "reading its assessments against each other and raising flags; priced by the partition's " +
    "assessed nodes, from a floor up to a ceiling (sweep plan items)",
};

/** The prior a ledger line falls back to when too few rows have finished. */
async function ledgerPriorMicroUsd(kind: string, variant: string): Promise<number | null> {
  const owl = loadConfig().owlCostMicroUsd ?? 1_000_000;
  const policy = await getEffectiveAllocationPolicy();
  switch (kind) {
    case "assess":
    case "reassess": {
      const tiers = await stewardTierCostEstimates();
      return variant === "strong" ? tiers.strongMicroUsd : tiers.standardMicroUsd;
    }
    case "ingest":
      return capMicroUsd("source_ingest");
    case "formalize":
      return Math.round(policy.est_formalize_cost_owls * owl);
    case "attempt_proof":
      return Math.round(
        (variant === "max" ? policy.est_attempt_max_cost_owls : policy.est_attempt_standard_cost_owls) * owl
      );
    case "prize_review":
      return Math.round(policy.est_prize_review_cost_owls * owl);
    case "curate":
    case "audit":
      return estimateLedgerKindCostMicroUsd(kind);
    case "request":
      return variant === "scope" ? estimateLedgerKindCostMicroUsd("request_scope") : null;
    case "consistency_sweep":
      // A sweep of the smallest partition: the floor, not a typical price.
      return (await sweepPricing(variant === "strong" ? "strong" : "standard")).floorMicroUsd;
    default:
      return null;
  }
}

/**
 * How a sweep of `variant` is priced (#756): per assessed node, counting at
 * least CONSISTENCY_SWEEP_MIN_NODES, up to the variant's ceiling. A sweep's
 * price is its partition's size, so its line carries the rule, not one
 * figure: past sweeps of other partitions say little about this one.
 */
async function sweepPricing(variant: "standard" | "strong"): Promise<{
  perNodeMicroUsd: number;
  basis: string;
  floorMicroUsd: number;
  capMicroUsd: number;
}> {
  const perNode = await estimateConsistencyNodeCostMicroUsd(variant, CONSISTENCY_SWEEP_MIN_NODES);
  const floor = consistencySweepPrice(variant, 0, perNode);
  return {
    perNodeMicroUsd: perNode.microUsd,
    basis: perNode.basis,
    floorMicroUsd: floor.microUsd,
    capMicroUsd: floor.capMicroUsd,
  };
}

/** Every kind of work on the action ledger, priced from its finished rows. */
async function ledgerLines(): Promise<Record<string, unknown>[]> {
  const rows = await rawQuery<{ kind: string; variant: string; runs: number; p50: string | null; p80: string | null }>(
    `SELECT kind, variant, COUNT(*)::int AS runs,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY metered_cost_micro_usd)::bigint AS p50,
            percentile_cont(0.8) WITHIN GROUP (ORDER BY metered_cost_micro_usd)::bigint AS p80
       FROM actions
      WHERE status = 'done' AND metered_cost_micro_usd > 0
        AND updated_at > now() - make_interval(days => $1)
      GROUP BY kind, variant`,
    [WINDOW_DAYS]
  );
  const seen = new Map(rows.map((r) => [`${r.kind}:${r.variant}`, r]));
  // Every kind a mandate can fund appears, run or not, so a thin line says so.
  const wanted: Array<[string, string]> = [
    ["assess", "standard"], ["assess", "strong"],
    ["reassess", "standard"], ["reassess", "strong"],
    ["ingest", "standard"], ["formalize", "standard"],
    ["attempt_proof", "standard"], ["attempt_proof", "max"],
    ["curate", "standard"], ["audit", "standard"], ["request", "scope"],
    ["lookout_run", "standard"], ["correspondent_run", "standard"], ["mandate_review", "standard"], ["grant_planning", "standard"],
    ["consistency_sweep", "standard"], ["consistency_sweep", "strong"],
  ];
  for (const r of rows) {
    if (!wanted.some(([k, v]) => k === r.kind && v === r.variant)) wanted.push([r.kind, r.variant]);
  }
  const lines: Record<string, unknown>[] = [];
  for (const [kind, variant] of wanted) {
    const r = seen.get(`${kind}:${variant}`);
    if (kind === "consistency_sweep") {
      // Priced by size, so the line is the rule (#831): what one node costs,
      // the floor every partition pays, and the ceiling.
      const p = await sweepPricing(variant === "strong" ? "strong" : "standard").catch(() => null);
      lines.push({
        kind,
        variant,
        what: LEDGER_KINDS[kind],
        runs_last_30_days: r?.runs ?? 0,
        typical_usd: usd(r?.p50),
        ceiling_usd: p ? usd(p.capMicroUsd) : usd(r?.p80),
        ...(p
          ? {
              per_assessed_node_usd: Math.round(p.perNodeMicroUsd / 100) / 10_000,
              per_node_basis: p.basis,
              floor_usd: usd(p.floorMicroUsd),
              note:
                `One sweep costs per_assessed_node_usd times the partition's assessed nodes ` +
                `(at least ${CONSISTENCY_SWEEP_MIN_NODES}), up to ceiling_usd; what it does not ` +
                `spend settles back. A partition's open row carries its exact price.`,
            }
          : {}),
      });
      continue;
    }
    const thin = (r?.runs ?? 0) < MIN_RUNS;
    const prior = thin ? await ledgerPriorMicroUsd(kind, variant).catch(() => null) : null;
    lines.push({
      kind,
      variant,
      what: LEDGER_KINDS[kind] ?? kind,
      runs_last_30_days: r?.runs ?? 0,
      typical_usd: usd(r?.p50),
      ceiling_usd: thin ? (usd(prior) ?? usd(r?.p80)) : usd(r?.p80),
      ...(thin
        ? {
            note:
              prior != null
                ? "Too few runs to go on: the ceiling is the prior."
                : "Too few runs to go on, and no prior: price it from the steps.",
          }
        : {}),
    });
  }
  return lines;
}

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
  const review = await reviewCostEstimateMicroUsd().catch(() => null);
  const ledger = await ledgerLines();
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
    contribution_review_usd: usd(review),
    ledger_work: ledger,
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
