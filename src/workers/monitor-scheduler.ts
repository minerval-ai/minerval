/**
 * Monitor scheduler (#334 S9): the bridge from the two candidate detectors
 * to the Audit Agent, modeled on audit-scheduler.ts.
 *
 * Once per sweep period it reads performed-settling and empty-chairs hits
 * from monitor-service.ts and hands the top few to requestAudit as
 * anomaly_investigation runs. The context names the signal and the claim
 * and says plainly that the hit is a candidate; the Audit Agent reads the
 * claim (get_claim_with_context) and judges on the merits — the monitor
 * picks WHAT to look at, and every conclusion belongs to the audit run.
 *
 * Rate limit without a migration: requestAudit's dedupe key carries the
 * reflag period bucket (`monitor:<signal>:<claim>:<bucket>`), so a claim
 * flagged once is not re-flagged until the bucket rolls over
 * (MONITOR_REFLAG_DAYS). The partial unique index on audit_runs.dedupe_key
 * makes that at-most-once across concurrent processes, same as the sweeps.
 *
 * Off by default (MONITOR_SWEEP_INTERVAL_HOURS=0): the signals are always
 * readable; feeding them to the Audit Agent is an operator's decision.
 */
import { loadConfig } from "../config.js";
import { requestAudit } from "../services/queue-service.js";
import {
  defaultThresholds,
  emptyChairs,
  performedSettling,
  type EmptyChairCandidate,
  type PerformedSettlingCandidate,
} from "../services/monitor-service.js";

export interface MonitorFlag {
  signal: "performed_settling" | "empty_chairs";
  claimId: string;
  /** audit_runs.id, or null when the reflag window still covers this claim. */
  runId: string | null;
}

export interface MonitorFlagResult {
  /** Candidates the detectors returned, before the cap. */
  candidates: number;
  flags: MonitorFlag[];
  /** How many of `flags` actually opened a run (the rest were deduped). */
  requested: number;
}

/** The period bucket a flag's dedupe key carries: floor(now / reflag window). */
export function reflagBucket(now: number, reflagDays: number): number {
  const windowMs = Math.max(1, reflagDays) * 86_400_000;
  return Math.floor(now / windowMs);
}

export function performedSettlingContext(c: PerformedSettlingCandidate): string {
  const why: string[] = [];
  if (c.reasons.includes("opposed_instances")) {
    why.push(`its instances affirm it ${c.affirms} time(s) and deny it ${c.denies} time(s) across ${c.sources} sources`);
  }
  if (c.reasons.includes("recent_accepted_challenge")) {
    why.push(`a challenge against it was accepted on ${c.lastAcceptedChallengeAt}`);
  }
  if (c.reasons.includes("contested_requires_child")) {
    why.push(`${c.contestedRequiresChildren} claim(s) it requires are currently contested`);
  }
  return (
    `Monitor signal performed_settling (a candidate, not a verdict): claim ${c.claimId} ` +
    `("${c.text.slice(0, 200)}") is assessed ${c.status} at confidence ${c.confidence.toFixed(2)}` +
    (c.credence != null ? ` (credence ${c.credence.toFixed(2)})` : "") +
    `, while its record shows live disagreement: ${why.join("; ")}. ` +
    `Read the claim and its assessment (get_claim_with_context) and judge whether the ` +
    `confidence is earned by the record — the dissent may be weak and the assessment may ` +
    `already answer it, in which case there is nothing to flag. If the verdict outruns its ` +
    `contested dependencies or ignores an accepted challenge, record a finding and ` +
    `recommend a re-review; do not change the claim yourself.`
  );
}

export function emptyChairsContext(c: EmptyChairCandidate): string {
  const why: string[] = [];
  if (c.reasons.includes("instances_one_stance")) {
    why.push(`all ${c.instances} of its instances ${c.instanceStance === "denies" ? "deny" : "affirm"} it`);
  }
  if (c.reasons.includes("arguments_one_stance")) {
    why.push(`all ${c.arguments} of its named arguments are ${c.argumentStance}`);
  }
  return (
    `Monitor signal empty_chairs (a coverage candidate, not a verdict): claim ${c.claimId} ` +
    `("${c.text.slice(0, 200)}") is assessed contested, but only one side is on record: ${why.join("; ")}. ` +
    `Read the claim (get_claim_with_context) and judge whether the other side of the ` +
    `disagreement is represented anywhere in its record — the assessment's reasoning, its ` +
    `subclaims, or its instances. If the missing side is real and absent, record a finding ` +
    `naming what is missing so the Steward can seek it; if the record already carries it, ` +
    `there is nothing to flag.`
  );
}

/**
 * Hand the current candidate-detector hits to the Audit Agent as INPUT.
 * Exported separately so tests and an operator's one-off call can drive it.
 */
export async function flagMonitorCandidates(
  opts: { now?: number; maxFlags?: number; reflagDays?: number } = {}
): Promise<MonitorFlagResult> {
  const config = loadConfig();
  const now = opts.now ?? Date.now();
  const maxFlags = opts.maxFlags ?? config.monitorSweepMaxFlags;
  const reflagDays = opts.reflagDays ?? config.monitorReflagDays;
  const bucket = reflagBucket(now, reflagDays);
  const result: MonitorFlagResult = { candidates: 0, flags: [], requested: 0 };
  if (maxFlags <= 0) return result;

  const t = defaultThresholds({ limit: maxFlags });
  const [ps, ec] = await Promise.all([performedSettling(t), emptyChairs(t)]);
  result.candidates = ps.candidates.length + ec.candidates.length;

  // Interleave by importance across the two signals, capped per sweep.
  const queue: Array<{ signal: MonitorFlag["signal"]; importance: number; claimId: string; context: string }> = [
    ...ps.candidates.map((c) => ({ signal: "performed_settling" as const, importance: c.importance, claimId: c.claimId, context: performedSettlingContext(c) })),
    ...ec.candidates.map((c) => ({ signal: "empty_chairs" as const, importance: c.importance, claimId: c.claimId, context: emptyChairsContext(c) })),
  ].sort((a, b) => b.importance - a.importance);

  for (const item of queue) {
    if (result.requested >= maxFlags) break;
    const runId = await requestAudit({
      auditType: "anomaly_investigation",
      context: item.context,
      triggeredBy: "monitor_signal",
      dedupeKey: `monitor:${item.signal}:${item.claimId}:${bucket}`,
    });
    result.flags.push({ signal: item.signal, claimId: item.claimId, runId });
    if (runId !== null) result.requested++;
  }
  return result;
}

export interface MonitorSchedulerTickResult {
  /** False when the sweep interval is 0 (off) or this period already swept. */
  swept: boolean;
  flags: MonitorFlagResult | null;
}

const sweptPeriods = new Set<number>();

/** One scheduler pass; the cadence is the sweep period, ticks may be frequent. */
export async function monitorSchedulerTick(now: number = Date.now()): Promise<MonitorSchedulerTickResult> {
  const config = loadConfig();
  if (config.monitorSweepIntervalHours <= 0) return { swept: false, flags: null };
  const period = Math.floor(now / (config.monitorSweepIntervalHours * 3_600_000));
  // The dedupe keys make a repeat sweep harmless (nothing re-requested), so
  // this in-process guard only saves the read queries between periods.
  if (sweptPeriods.has(period)) return { swept: false, flags: null };
  sweptPeriods.add(period);
  const flags = await flagMonitorCandidates({ now });
  return { swept: true, flags };
}

/** Test hook. */
export function resetMonitorSchedulerState(): void {
  sweptPeriods.clear();
}

export function startMonitorScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const config = loadConfig();
  if (config.monitorSweepIntervalHours <= 0) {
    options.logger.info("Monitor scheduler off (MONITOR_SWEEP_INTERVAL_HOURS=0)");
    return { stop: () => {} };
  }
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await monitorSchedulerTick();
      if (result.swept && result.flags) {
        options.logger.info(
          `Monitor scheduler: ${result.flags.candidates} candidate(s), ` +
            `${result.flags.requested} audit run(s) requested`
        );
      }
    } catch (err) {
      options.logger.error("Monitor scheduler error", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info("Monitor scheduler started");
  return { stop: () => clearInterval(timer) };
}
