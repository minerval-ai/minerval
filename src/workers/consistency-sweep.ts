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
  /** Assessed claims in the partition. */
  claimsInScope: number;
  /** False when the partition had fewer than two assessed claims to read. */
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
    maxFlags?: number;
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
  const sweepId = opts.dryRun ? null : await startSweep(partition);
  const base = { sweepId, partition, claimsInScope };
  const close = async (fields: Omit<Parameters<typeof finishSweep>[0], "sweepId" | "claimsInScope">) => {
    if (sweepId) await finishSweep({ sweepId, claimsInScope, ...fields });
  };

  // One assessed claim cannot be incoherent with anything in its partition.
  if (claimsInScope < 2) {
    const note = `Only ${claimsInScope} assessed claim(s) in scope; nothing to read against.`;
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
      maxFlags: opts.maxFlags,
      dryRun: opts.dryRun,
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
