/**
 * One consistency sweep (#330; docs/allocation.md, "Consistency sweeps"):
 * the unit of work a 'consistency_sweep' ledger action buys. The engine
 * executor calls it with the partition its row names; the eval driver and
 * an operator's one-off call can name any partition, or none (the
 * partition due next).
 *
 * The sweep row is opened before the agent reads and closed after, with
 * the agent's note, which briefs the next sweep of the same partition. A
 * partition with fewer than two assessed claims closes without an agent
 * run: one claim cannot be incoherent with anything in its partition.
 */
import { loadConfig } from "../config.js";
import {
  CONSISTENCY_SWEEP_MIN_NODES,
  priceConsistencySweep,
  type ConsistencySweepPrice,
} from "../services/action-service.js";
import { runBudget } from "../llm/usage-context.js";
import { runConsistencyChecker, type ProposedFlag } from "../llm/agents/consistency-checker.js";
import {
  finishSweep,
  lastSweepOf,
  nextSweepPartition,
  partitionClaims,
  scopeForPartition,
  startSweep,
  type SweepPartition,
} from "../services/consistency-service.js";

export interface SweepResult {
  /** Null for a dry run, which records no sweep. */
  sweepId: string | null;
  partition: SweepPartition;
  /** Assessed nodes in the partition (claims with a verdict, quantities with an estimate, questions with a standing). */
  claimsInScope: number;
  /** False when the partition had fewer than two assessed nodes to read. */
  agentRan: boolean;
  flagsRaised: number;
  repeats: number;
  proposed: ProposedFlag[];
  note: string;
}

/**
 * Run one sweep over `partition` (or the partition due next). Exported for
 * the engine executor, the eval driver and an operator's one-off call. Returns
 * null when no partition is due.
 */
export async function runConsistencySweep(
  opts: {
    partition?: SweepPartition;
    model?: string;
    /**
     * The ledger variant a funded sweep runs as. Given, the checker is told
     * how its budget was priced (the partition's size, #756); an eval or
     * one-off call without a priced budget omits it.
     */
    variant?: "standard" | "strong";
    /** Judge without writing: no sweep row, no flags (the eval's coherence read). */
    dryRun?: boolean;
  } = {}
): Promise<SweepResult | null> {
  const config = loadConfig();
  const minTagClaims = config.consistencyMinTagClaims;
  const partition = opts.partition ?? (await nextSweepPartition(minTagClaims));
  if (!partition) return null;

  const scope = await scopeForPartition(partition, minTagClaims);
  // A dry run is a fresh reader: no memory of earlier sweeps, no record.
  const lastSweep = opts.dryRun ? null : await lastSweepOf(partition);
  const { total: claimsInScope } = await partitionClaims(scope, { limit: 1 });
  const sweepId = opts.dryRun ? null : await startSweep(partition, opts.variant ?? null);
  const base = { sweepId, partition, claimsInScope };
  // A funded sweep records what its run was metered at: the observed cost
  // per node its variant's next prices read (#756).
  const close = async (fields: Omit<Parameters<typeof finishSweep>[0], "sweepId" | "claimsInScope">) => {
    if (sweepId) {
      await finishSweep({
        sweepId,
        claimsInScope,
        costMicroUsd: opts.variant ? (runBudget()?.spentMicroUsd ?? null) : null,
        ...fields,
      });
    }
  };

  // One assessed node cannot be incoherent with anything in its partition.
  if (claimsInScope < 2) {
    const note = `Only ${claimsInScope} assessed node(s) in scope; nothing to read against.`;
    await close({ status: "done", flagsRaised: 0, note });
    return { ...base, agentRan: false, flagsRaised: 0, repeats: 0, proposed: [], note };
  }

  try {
    const run = await runConsistencyChecker({
      sweepId,
      partitionLabel: partition.label,
      scope,
      claimsInScope,
      lastSweep,
      model: opts.model,
      dryRun: opts.dryRun,
      budgetBasis: opts.variant
        ? consistencySweepBudgetBasis(await priceConsistencySweep(opts.variant, claimsInScope), claimsInScope)
        : undefined,
    });
    await close({ status: "done", runId: run.runId, flagsRaised: run.flagsRaised, note: run.note });
    return {
      ...base,
      agentRan: true,
      flagsRaised: run.flagsRaised,
      repeats: run.repeats,
      proposed: run.proposed,
      note: run.note,
    };
  } catch (err) {
    await close({ status: "error", flagsRaised: 0, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function usd(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(micro > 0 && micro < 10_000 ? 4 : 2)}`;
}

/**
 * What the checker is told about how its budget was set (#756): by the
 * partition's size, at its variant's rate per assessed node, with a
 * ceiling. When the ceiling binds it is told so, and how far the budget
 * reaches, so it reads the changed and important nodes first and its note
 * says where it stopped for the next sweep to resume.
 */
export function consistencySweepBudgetBasis(price: ConsistencySweepPrice, assessedNodes: number): string {
  const source =
    price.basis === "observed"
      ? "what this reader's recent sweeps actually cost per node (the 80th percentile)"
      : price.basis === "model_price"
        ? "this reader's model price for the tokens a node is expected to take, generously counted"
        : "the expected cost a node takes on this reader, set generously until its sweeps have run";
  const head =
    `How this budget was set: by the partition's size, at ${usd(price.perNodeMicroUsd)} per ` +
    `assessed node, which is ${source}, counting at least ${CONSISTENCY_SWEEP_MIN_NODES} nodes ` +
    `(the briefing and searches beyond the partition cost the same in a small one), up to a ` +
    `ceiling of ${usd(price.capMicroUsd)} for this reader. ${assessedNodes} node(s) come to ` +
    `${usd(price.microUsd)}. `;
  if (!price.capped) {
    return (
      head +
      `It is meant to cover reading every node here and comparing what needs comparing; ` +
      `what you do not spend goes back to whoever funded the sweep.`
    );
  }
  const reach = Math.floor(price.capMicroUsd / Math.max(1, price.perNodeMicroUsd));
  return (
    head +
    `The ceiling binds here: at that rate it covers about ${reach} of the ${assessedNodes} nodes. ` +
    `Read the changed and most important first (the listing's order), and say in your note ` +
    `where you stopped, so the next sweep of this partition starts there.`
  );
}
