/**
 * Monitor scheduler (#334 S9): the bridge from the two candidate detectors
 * to the Audit Agent, modeled on audit-scheduler.ts.
 *
 * Once per sweep period it reads performed-settling and empty-chairs hits
 * from monitor-service.ts and hands the top few to requestAudit as
 * anomaly_investigation runs. The context names the signal and the claim
 * and says plainly that the hit is a candidate; the Audit Agent reads the
 * claim (get_claim) and judges on the merits — the monitor
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
 *
 * Where a deployment has more than one label the sweep works label by
 * label (everyLabel in services/label-service.ts). A candidate's context
 * states a verdict, its confidence and how many instances affirm and deny
 * it, so it is found with the clearance of the label it is written at: the
 * detectors run inside each label, and a label asks for an audit only of
 * the judgments recorded at that label, as its readers see their record.
 * A node's public judgment is looked at on what `public` reads, and its
 * version at another label on what that label reads, each once. The sweep
 * never sees every label at once, so it is not system work. On a
 * deployment that mirrors the public graph, a mirrored node's judgment at
 * the node's own label is the public graph's, and no audit of it is opened
 * here (services/mirrored-node-service.ts).
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "../services/judgment-version-service.js";
import { everyLabel, keyAtLabel } from "../services/label-service.js";
import { holdsMirror } from "../services/mirrored-node-service.js";
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
  if (c.reasons.includes("inconclusive_requires_child")) {
    why.push(`${c.inconclusiveRequiresChildren} claim(s) it requires are currently assessed inconclusive`);
  }
  return (
    `Monitor signal performed_settling (a candidate, not a verdict): claim ${c.claimId} ` +
    `("${c.text.slice(0, 200)}") is assessed ${c.status} at confidence ${c.confidence.toFixed(2)}` +
    (c.credence != null ? ` (credence ${c.credence.toFixed(2)})` : "") +
    `, while its record shows live disagreement: ${why.join("; ")}. ` +
    `Read the claim and its assessment (get_claim) and the instances that carry the ` +
    `disagreement (get_claim_instances), and judge whether the confidence is earned by the ` +
    `record: the dissent may be weak and the assessment may ` +
    `already answer it, in which case there is nothing to flag. If the verdict outruns its ` +
    `inconclusive dependencies or ignores an accepted challenge, record a finding and ` +
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
    `("${c.text.slice(0, 200)}") is assessed inconclusive, but only one side is on record: ${why.join("; ")}. ` +
    `Read the claim (get_claim) and its instances (get_claim_instances), and judge whether ` +
    `the other side of the disagreement is represented anywhere in its record: the ` +
    `assessment's reasoning, its ` +
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
  type Item = { signal: MonitorFlag["signal"]; importance: number; claimId: string; context: string; label: string };
  const queue: Item[] = [];
  for (const label of await everyLabel()) {
    // The detectors read, and the context is worded, inside the label the
    // audit will be asked for at: what it says of the claim's record is
    // what that label's readers see of it.
    await runAtLabel(label, `the monitor's sweep at ${label}`, async () => {
      const [ps, ec] = await Promise.all([performedSettling(t), emptyChairs(t)]);
      const found: Item[] = [
        ...ps.candidates.map((c) => ({ signal: "performed_settling" as const, importance: c.importance, claimId: c.claimId, context: performedSettlingContext(c), label })),
        ...ec.candidates.map((c) => ({ signal: "empty_chairs" as const, importance: c.importance, claimId: c.claimId, context: emptyChairsContext(c), label })),
      ];
      const own = await judgedHereAtThisLabel(found.map((f) => f.claimId), label);
      queue.push(...found.filter((f) => own === null || own.has(f.claimId)));
    });
  }
  result.candidates = queue.length;
  // Interleave by importance across the two signals and the labels, capped per sweep.
  queue.sort((a, b) => b.importance - a.importance);

  for (const item of queue) {
    if (result.requested >= maxFlags) break;
    // Each audit is about one judgment of one claim, so it is asked for at
    // that judgment's label: the audit's record, which quotes the claim and
    // states its verdict, and the ledger row that runs it.
    const runId = await runAtLabel(item.label, `claim ${item.claimId}`, () =>
      requestAudit({
        auditType: "anomaly_investigation",
        context: item.context,
        triggeredBy: "monitor_signal",
        dedupeKey: keyAtLabel(`monitor:${item.signal}:${item.claimId}:${bucket}`, item.label),
      })
    );
    result.flags.push({ signal: item.signal, claimId: item.claimId, runId });
    if (runId !== null) result.requested++;
  }
  return result;
}

/**
 * Which of these claims have, as the judgment in force for the work in
 * progress, one recorded at `label` by this deployment. A label that reads
 * another sees that label's judgments too, and a mirror brings the public
 * graph's: neither is this label's to ask an audit of. Null where there is
 * nothing to tell apart (one label, no mirror), and nothing is asked.
 */
async function judgedHereAtThisLabel(claimIds: string[], label: string): Promise<Set<string> | null> {
  if (oneLabelOnly() && !holdsMirror()) return null;
  if (claimIds.length === 0) return new Set();
  const rows = await rawQuery<{ id: string }>(
    `SELECT a.claim_id AS id FROM assessments_in_force a
      WHERE a.claim_id = ANY($1::uuid[]) AND a.sensitivity_label = $2 AND a.origin = 'local'`,
    [claimIds, label ?? PUBLIC_LABEL]
  );
  return new Set(rows.map((r) => r.id));
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
      // Not system work: the sweep looks inside each label in turn (see the
      // header), so nothing it writes at a label was read outside it.
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
