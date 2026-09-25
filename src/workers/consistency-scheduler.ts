/**
 * Consistency scheduler (#330; docs/allocation.md, "Consistency sweeps"):
 * the proactive half of the Consistency Checker, modeled on
 * monitor-scheduler.ts.
 *
 * Once per sweep period it picks the partition due next (a sweepable tag,
 * or the residual bucket of claims no such tag covers: never swept first,
 * then the most assessments written since the last sweep, then the most
 * importance), reads the coherence pre-filter's shortlist for it, and runs
 * the checker over that shortlist. An empty shortlist closes the sweep
 * without an agent run, so a coherent partition costs one SQL pass.
 *
 * Bounded like every producer on the ledger: one sweep per period, a daily
 * sweep cap, a candidate cap per sweep, a flag cap per sweep, and a value
 * ceiling per flag. The flags themselves are candidates; the allocator
 * decides what runs.
 *
 * Off by default (CONSISTENCY_SWEEP_INTERVAL_HOURS=0): the pre-filter stays
 * readable at GET /coherence either way.
 */
import { loadConfig } from "../config.js";
import { runConsistencyChecker } from "../llm/agents/consistency-checker.js";
import {
  finishSweep,
  nextSweepPartition,
  reclaimAbandonedSweeps,
  scopeForPartition,
  startSweep,
  sweepCandidates,
  sweepsStartedSince,
  sweepsStartedToday,
  type SweepPartition,
} from "../services/consistency-service.js";

export interface SweepResult {
  sweepId: string;
  partition: SweepPartition;
  candidates: number;
  suppressed: number;
  /** False when the shortlist was empty and no agent ran. */
  agentRan: boolean;
  flagsRaised: number;
  repeats: number;
  dismissed: number;
  note: string;
}

/**
 * Run one sweep over `partition` (or the partition due next). Exported for
 * the scheduler, the eval driver and an operator's one-off call. Returns
 * null when no partition is due.
 */
export async function runConsistencySweep(
  opts: {
    partition?: SweepPartition;
    model?: string;
    maxCandidates?: number;
    maxFlags?: number;
    maxValue?: number;
  } = {}
): Promise<SweepResult | null> {
  const config = loadConfig();
  const minTagClaims = config.consistencyMinTagClaims;
  const partition = opts.partition ?? (await nextSweepPartition(minTagClaims));
  if (!partition) return null;

  const scope = await scopeForPartition(partition, minTagClaims);
  const { candidates, suppressed } = await sweepCandidates(
    scope,
    opts.maxCandidates ?? config.consistencyMaxCandidatesPerSweep
  );
  const sweepId = await startSweep(partition);
  const base = { sweepId, partition, candidates: candidates.length, suppressed };

  if (candidates.length === 0) {
    const note = `Nothing on the shortlist${suppressed > 0 ? ` (${suppressed} suppressed)` : ""}.`;
    await finishSweep({ sweepId, status: "done", candidatesFound: 0, flagsRaised: 0, dismissed: 0, note });
    return { ...base, agentRan: false, flagsRaised: 0, repeats: 0, dismissed: 0, note };
  }

  try {
    const run = await runConsistencyChecker({
      sweepId,
      partitionLabel: partition.label,
      candidates,
      suppressed,
      model: opts.model,
      maxFlags: opts.maxFlags,
      maxValue: opts.maxValue,
    });
    await finishSweep({
      sweepId,
      status: "done",
      runId: run.runId,
      candidatesFound: candidates.length,
      flagsRaised: run.flagsRaised,
      dismissed: run.dismissed,
      note: run.note,
    });
    return {
      ...base,
      agentRan: true,
      flagsRaised: run.flagsRaised,
      repeats: run.repeats,
      dismissed: run.dismissed,
      note: run.note,
    };
  } catch (err) {
    await finishSweep({
      sweepId,
      status: "error",
      candidatesFound: candidates.length,
      flagsRaised: 0,
      dismissed: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export interface ConsistencySchedulerTickResult {
  /** False when off, already swept this period, at the daily cap, or nothing was due. */
  swept: boolean;
  reason?: "off" | "period" | "daily_cap" | "nothing_due";
  sweep: SweepResult | null;
}

const sweptPeriods = new Set<number>();

/** One scheduler pass; the cadence is the sweep period, ticks may be frequent. */
export async function consistencySchedulerTick(
  now: number = Date.now()
): Promise<ConsistencySchedulerTickResult> {
  const config = loadConfig();
  if (config.consistencySweepIntervalHours <= 0) return { swept: false, reason: "off", sweep: null };
  const period = Math.floor(now / (config.consistencySweepIntervalHours * 3_600_000));
  if (sweptPeriods.has(period)) return { swept: false, reason: "period", sweep: null };
  sweptPeriods.add(period);
  await reclaimAbandonedSweeps();
  // Every API task runs this scheduler; the in-process guard above only
  // saves queries. The DB says whether any task already swept this period
  // (a same-millisecond race between tasks is bounded by the daily cap).
  const periodStart = new Date(period * config.consistencySweepIntervalHours * 3_600_000);
  if ((await sweepsStartedSince(periodStart)) > 0) {
    return { swept: false, reason: "period", sweep: null };
  }
  if ((await sweepsStartedToday(new Date(now))) >= config.consistencyMaxSweepsPerDay) {
    return { swept: false, reason: "daily_cap", sweep: null };
  }
  const sweep = await runConsistencySweep();
  if (!sweep) return { swept: false, reason: "nothing_due", sweep: null };
  return { swept: true, sweep };
}

/** Test hook. */
export function resetConsistencySchedulerState(): void {
  sweptPeriods.clear();
}

export function startConsistencyScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  if (config.consistencySweepIntervalHours <= 0) {
    options.logger.info("Consistency scheduler off (CONSISTENCY_SWEEP_INTERVAL_HOURS=0)");
    return { stop: () => {} };
  }
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await consistencySchedulerTick();
      if (result.swept && result.sweep) {
        const s = result.sweep;
        options.logger.info(
          `Consistency sweep (${s.partition.label}): ${s.candidates} candidate(s), ` +
            `${s.flagsRaised} flag(s), ${s.dismissed} dismissed`
        );
      }
    } catch (err) {
      options.logger.error("Consistency scheduler error", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info("Consistency scheduler started");
  return { stop: () => clearInterval(timer) };
}
