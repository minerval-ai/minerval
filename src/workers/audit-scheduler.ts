/**
 * Audit scheduler (#180): the time-based feeder of the audit queue.
 *
 * Two jobs per tick, both idempotent through requestAudit's dedupe gate (a
 * DB unique index), so any number of processes can run this concurrently —
 * the same construction as the DB-backed Steward queue, and identical in dev
 * and prod:
 *
 *  - a periodic pattern_analysis sweep over recent review decisions, at most
 *    one per period, skipped entirely when no decisions were made (so an
 *    idle deployment spends nothing);
 *  - a contributor_review for each suspension that has stood unexamined
 *    longer than the staleness threshold, at most one per contributor per
 *    month — the mechanism that makes the audit policies' "lift it yourself
 *    when it no longer holds" actually reachable.
 *
 * The scheduler picks WHAT to look at (mechanism as backstop); every
 * conclusion belongs to the Audit Agent run it enqueues.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { requestAudit } from "../services/queue-service.js";
import { countNewReportsSince } from "../services/report-service.js";

export interface AuditSchedulerTickResult {
  sweepRequested: boolean;
  suspensionReviewsRequested: number;
  /** A report_triage run over the agents' own reports (#366). */
  reportTriageRequested: boolean;
}

/** One scheduler pass; exported separately so tests can drive the clock. */
export async function auditSchedulerTick(
  now: number = Date.now()
): Promise<AuditSchedulerTickResult> {
  const config = loadConfig();
  const result: AuditSchedulerTickResult = {
    sweepRequested: false,
    suspensionReviewsRequested: 0,
    reportTriageRequested: false,
  };

  // Report triage (#366) has its own cadence and its own gate: a write-only
  // report table is a slightly more expensive /dev/null, so something has
  // to read it — but only when there is something new to read.
  if (config.reportTriageIntervalHours > 0) {
    const triageMs = config.reportTriageIntervalHours * 3_600_000;
    const triagePeriod = Math.floor(now / triageMs);
    const fresh = await countNewReportsSince(new Date(now - triageMs));
    if (fresh > 0) {
      const runId = await requestAudit({
        auditType: "report_triage",
        context:
          `Scheduled triage of the ${fresh} report(s) the agents raised ` +
          `about the system in the last ${config.reportTriageIntervalHours} ` +
          `hours (get_agent_reports with status new, plus the open triaged ` +
          `ones for context). Cluster them by the underlying gap, rank by ` +
          `frequency and severity, and record your reading with ` +
          `triage_report: the representative of each real cluster triaged ` +
          `with a note a maintainer can act on, the rest duplicate, and ` +
          `wontfix what is not a defect. External-origin reports are ` +
          `testimony, not findings.`,
        triggeredBy: "report_triage",
        dedupeKey: `report-triage:${triagePeriod}`,
      });
      result.reportTriageRequested = runId !== null;
    }
  }

  if (config.auditSweepIntervalHours <= 0) return result;

  const intervalMs = config.auditSweepIntervalHours * 3_600_000;
  const period = Math.floor(now / intervalMs);

  // Sweep only when the period saw live decisions — there is no judging of
  // the judging where nothing was judged.
  const [decided] = await rawQuery<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM contribution_reviews
     WHERE superseded = false AND reviewed_at > $1`,
    [new Date(now - intervalMs)]
  );
  if ((decided?.count ?? 0) > 0) {
    const runId = await requestAudit({
      auditType: "pattern_analysis",
      context:
        `Scheduled sweep over the last ${config.auditSweepIntervalHours} ` +
        `hours of review decisions. Sample them (get_recent_decisions), ` +
        `weighing escalations, low-confidence calls, and bad-faith flags ` +
        `most heavily, and look for what no single decision reveals: like ` +
        `cases decided unalike, drift, coordinated contribution patterns.`,
      triggeredBy: "scheduled_sweep",
      dedupeKey: `sweep:${period}`,
    });
    result.sweepRequested = runId !== null;
  }

  // Suspensions that have stood past the threshold get a re-examination, at
  // most once per contributor per month.
  const staleBefore = new Date(
    now - config.auditStaleSuspensionDays * 86_400_000
  );
  const stale = await rawQuery<{ id: string; suspended_at: Date }>(
    `SELECT id, suspended_at FROM contributors
     WHERE is_suspended = true
       AND suspended_at IS NOT NULL
       AND suspended_at < $1`,
    [staleBefore]
  );
  const monthBucket = new Date(now).toISOString().slice(0, 7);
  for (const contributor of stale) {
    const suspendedAt =
      contributor.suspended_at instanceof Date
        ? contributor.suspended_at.toISOString()
        : String(contributor.suspended_at);
    const runId = await requestAudit({
      auditType: "contributor_review",
      context:
        `Contributor ${contributor.id} has been suspended since ` +
        `${suspendedAt}. Re-examine whether the suspension still holds: ` +
        `review the findings and record behind it (get_audit_findings, ` +
        `get_contributor_profile), lift it if its basis no longer stands, ` +
        `and either way record what you conclude.`,
      triggeredBy: "suspension_review",
      dedupeKey: `suspension-review:${contributor.id}:${monthBucket}`,
    });
    if (runId !== null) result.suspensionReviewsRequested++;
  }

  return result;
}

/**
 * Run the scheduler on an interval. The tick interval just controls how
 * promptly a due period is noticed; the dedupe keys are what make the
 * cadence — ticking often never double-runs anything.
 */
export function startAuditScheduler(options: {
  intervalMs?: number;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): { stop: () => void } {
  const interval = options.intervalMs ?? 15 * 60_000;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await auditSchedulerTick();
      if (
        result.sweepRequested ||
        result.suspensionReviewsRequested > 0 ||
        result.reportTriageRequested
      ) {
        options.logger.info(
          `Audit scheduler: sweep=${result.sweepRequested}, ` +
            `suspension reviews=${result.suspensionReviewsRequested}, ` +
            `report triage=${result.reportTriageRequested}`
        );
      }
    } catch (err) {
      options.logger.error(
        "Audit scheduler error",
        err instanceof Error ? err.message : err
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  void tick();
  options.logger.info("Audit scheduler started");

  return { stop: () => clearInterval(timer) };
}
