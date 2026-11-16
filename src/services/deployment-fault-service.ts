/**
 * Deployment faults on record: what the operator must fix, said once and
 * loudly (#967, #969, #971; the vocabulary is in deployment-fault.ts).
 *
 * A provider that refuses calls because the deployment's account is out of
 * credits, or rejects its key, fails every call until someone tops the
 * account up or rotates the key. Before this module nothing told that
 * someone: each failure was a warning line in one task's log, and the first
 * maintainers heard of thirteen hours of it was three reports raised by the
 * agents it had stalled.
 *
 *  - noteDeploymentFault records a failure of one of the two classes. Every
 *    failure of a class on a provider collapses onto one open row, so a
 *    fault is one record however many calls it fails. Opening the row logs
 *    an error line and raises ONE report on the agents' channel (#366),
 *    severity blocking; the report's dedupe key is the class and provider,
 *    so a fault that returns later is a sighting of the same report, not a
 *    new one.
 *  - clearSettledDeploymentFaults (the drain's tick) closes a row once its
 *    provider has served a call and refused none for CLEAR_QUIET_MINUTES.
 *    The quiet spell matters: an account that is nearly empty refuses large requests while
 *    small ones still pass (the 2026-11-12 fault was exactly that), and a
 *    row that closed on every small success would reopen, and be reported,
 *    on every large failure.
 *  - openDeploymentFaults is the public reading: class, provider, since
 *    when, how many failures, and how many ledger rows wait on the class.
 *    Never the provider's text.
 *
 * Nothing here throws, and nothing here gates work: recording is beside the
 * failure path, never on it.
 */
import { rawQuery } from "../db/client.js";
import { errorProvider } from "../llm/errors.js";
import {
  PLATFORM_FAULT_LABELS,
  deploymentFaultOf,
  waitingOnFaultSql,
  type DeploymentFaultReason,
  type PlatformFaultReason,
} from "./deployment-fault.js";

/** A provider's open row closes after a served call and this long without a refusal. */
export const CLEAR_QUIET_MINUTES = 10;

/** A fault nothing has called or refused since closes after this long. */
export const CLEAR_SILENT_MINUTES = 60;

/** At most one write per class and provider this often, per process. */
const NOTE_INTERVAL_MS = 15_000;

const lastNoted = new Map<string, { at: number; pending: number }>();

/** Test hook. */
export function resetDeploymentFaultState(): void {
  lastNoted.clear();
  lastTickAt = Number.NEGATIVE_INFINITY;
}

const REPORT_TITLES: Record<DeploymentFaultReason, (provider: string) => string> = {
  credits_fault: (p) => `deployment fault: the ${p} account is out of credits`,
  credentials_fault: (p) => `deployment fault: ${p} rejects the deployment's credentials`,
};

const OPERATOR_ACTION: Record<DeploymentFaultReason, string> = {
  credits_fault:
    "Add credits to the deployment's account with this provider (or raise the key's limit). A " +
    "nearly empty account refuses large requests while small ones still pass, so some calls " +
    "succeeding does not mean it is funded.",
  credentials_fault: "Check the provider key this deployment is configured with: it was rejected.",
};

/**
 * Record that a call failed on a deployment fault. A no-op for any other
 * failure. `provider` overrides the one stamped on the error (a caller that
 * does not go through the LLM client's seam, such as the embedder).
 */
export async function noteDeploymentFault(
  err: unknown,
  opts: { surface?: string; provider?: string } = {}
): Promise<DeploymentFaultReason | null> {
  const reason = deploymentFaultOf(err);
  if (!reason) return null;
  const provider = opts.provider ?? errorProvider(err) ?? "unknown";
  const key = `${reason} ${provider}`;
  const now = Date.now();
  const last = lastNoted.get(key);
  if (last && now - last.at < NOTE_INTERVAL_MS) {
    last.pending++;
    return reason;
  }
  const occurrences = 1 + (last?.pending ?? 0);
  lastNoted.set(key, { at: now, pending: 0 });
  const raw = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 1500);
  try {
    const [row] = await rawQuery<{ id: string; opened: boolean; reported_at: Date | null; occurrences: number }>(
      `INSERT INTO deployment_faults (reason, provider, last_error, occurrences)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reason, provider) WHERE cleared_at IS NULL
       DO UPDATE SET last_seen_at = now(),
                     occurrences = deployment_faults.occurrences + EXCLUDED.occurrences,
                     last_error = EXCLUDED.last_error
       RETURNING id, (xmax = 0) AS opened, reported_at, occurrences`,
      [reason, provider, raw, occurrences]
    );
    if (!row) return reason;
    if (row.opened) {
      console.error(
        `[deployment-fault] OPENED ${reason} on ${provider}` +
          (opts.surface ? ` (first met by ${opts.surface})` : "") +
          `: ${OPERATOR_ACTION[reason]} Work on this provider waits and retries until it clears. ` +
          `Provider said: ${raw}`
      );
    }
    if (!row.reported_at) await reportFault(row.id, reason, provider, raw, opts.surface);
  } catch (e) {
    console.error(
      `[deployment-fault] could not record ${reason} on ${provider}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return reason;
}

/** One report per open row; the claim on `reported_at` keeps two tasks from both filing. */
async function reportFault(
  id: string,
  reason: DeploymentFaultReason,
  provider: string,
  raw: string,
  surface: string | undefined
): Promise<void> {
  const claimed = await rawQuery<{ id: string }>(
    `UPDATE deployment_faults SET reported_at = now()
      WHERE id = $1 AND reported_at IS NULL RETURNING id`,
    [id]
  );
  if (claimed.length === 0) return;
  const { raiseIssue } = await import("./report-service.js");
  await raiseIssue({
    agent: "platform",
    origin: "internal",
    kind: "system_failure",
    // Paid work is waiting on it and nothing but the operator ends it.
    severity: "blocking",
    surface: `deployment fault (${provider})`,
    title: REPORT_TITLES[reason](provider),
    body:
      `${OPERATOR_ACTION[reason]}\n\n` +
      `Calls to ${provider} are being refused (${reason}). Nothing is parked or cancelled for it: ` +
      `ledger rows whose run it stops stay open and funded, say so (the ledger's waiting_on), and ` +
      `are retried by the platform, 30 seconds to 10 minutes apart, until the provider serves them. ` +
      `Work on other providers is not held up. GET /monitors (queue health, deploymentFaults) shows ` +
      `the fault while it lasts and how many rows wait on it; it closes on its own once the provider ` +
      `has served a call and refused none for ${CLEAR_QUIET_MINUTES} minutes. One report per fault: ` +
      `further failures raise nothing.` +
      (surface ? `\n\nFirst met by: ${surface}.` : "") +
      // The raw text: this report is service-scoped, which is where it
      // belongs. Public surfaces show only the class (#846).
      `\n\nProvider said: ${raw}`,
    contextRefs: { fault_id: id, reason, provider },
  });
}

/**
 * Close the faults that are over: the provider has refused nothing for
 * CLEAR_QUIET_MINUTES and has served a metered call since its last refusal
 * (llm_usage, which every provider call is metered into), or has refused
 * nothing for CLEAR_SILENT_MINUTES (a fault whose provider was not named, or
 * one nothing has called since). Rows waiting on a closed class are tried at
 * once. Returns how many closed. Never throws.
 */
export async function clearSettledDeploymentFaults(): Promise<number> {
  try {
    const cleared = await rawQuery<{ reason: string; provider: string; first_seen_at: Date; occurrences: number }>(
      `UPDATE deployment_faults f SET cleared_at = now()
        WHERE f.cleared_at IS NULL
          AND f.last_seen_at < now() - make_interval(mins => $1)
          AND (f.last_seen_at < now() - make_interval(mins => $2)
               OR EXISTS (SELECT 1 FROM llm_usage u
                           WHERE u.provider = f.provider AND u.created_at > f.last_seen_at))
        RETURNING f.reason, f.provider, f.first_seen_at, f.occurrences`,
      [CLEAR_QUIET_MINUTES, CLEAR_SILENT_MINUTES]
    );
    for (const c of cleared) {
      console.error(
        `[deployment-fault] CLEARED ${c.reason} on ${c.provider}: open since ` +
          `${new Date(c.first_seen_at).toISOString()}, ${c.occurrences} failed calls. Waiting rows are being retried.`
      );
      // Rows waiting on the class are tried now. While the class is still
      // open on another provider they keep reading as waiting, and one whose
      // provider that is fails once more and waits again.
      await rawQuery(
        `UPDATE actions
            SET retry_after = CASE WHEN still.open THEN now() END,
                fault_reason = CASE WHEN still.open THEN fault_reason END,
                fault_since = CASE WHEN still.open THEN fault_since END,
                fault_attempts = CASE WHEN still.open THEN fault_attempts ELSE 0 END
           FROM (SELECT EXISTS (SELECT 1 FROM deployment_faults
                                 WHERE reason = $1 AND cleared_at IS NULL) AS open) still
          WHERE status = 'open' AND fault_reason = $1`,
        [c.reason]
      );
    }
    return cleared.length;
  } catch (e) {
    console.error(`[deployment-fault] could not clear faults: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

let lastTickAt = Number.NEGATIVE_INFINITY;

/** The drain's tick: close settled faults, at most once a minute. Never throws. */
export async function deploymentFaultsTick(now: number = Date.now()): Promise<number> {
  if (now - lastTickAt < 60_000) return 0;
  lastTickAt = now;
  return clearSettledDeploymentFaults();
}

/** A deployment fault as public surfaces show it: never the provider's text. */
export interface DeploymentFaultView {
  reason: DeploymentFaultReason;
  reasonLabel: string;
  provider: string;
  since: string;
  lastSeen: string;
  failedCalls: number;
  /** Open ledger rows this class of fault stopped that are waiting for their next attempt. */
  waitingRows: number;
}

/** The faults open now, oldest first. */
export async function openDeploymentFaults(): Promise<DeploymentFaultView[]> {
  const rows = await rawQuery<{
    reason: DeploymentFaultReason;
    provider: string;
    first_seen_at: Date;
    last_seen_at: Date;
    occurrences: number;
    waiting_rows: number;
  }>(
    `SELECT f.reason, f.provider, f.first_seen_at, f.last_seen_at, f.occurrences,
            (SELECT COUNT(*)::int FROM actions a
              WHERE a.status = 'open' AND a.fault_reason = f.reason
                AND ${waitingOnFaultSql("a")}) AS waiting_rows
       FROM deployment_faults f
      WHERE f.cleared_at IS NULL
      ORDER BY f.first_seen_at`
  );
  return rows.map((r) => ({
    reason: r.reason,
    reasonLabel: PLATFORM_FAULT_LABELS[r.reason] ?? r.reason,
    provider: r.provider,
    since: new Date(r.first_seen_at).toISOString(),
    lastSeen: new Date(r.last_seen_at).toISOString(),
    failedCalls: Number(r.occurrences),
    waitingRows: Number(r.waiting_rows),
  }));
}

const minute = (d: Date | string): string => `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * The platform-faults section of a mandate's review briefing (#971), or ""
 * when there is nothing to say: the deployment faults open now, those that
 * came and went since `since` (the mandate's last pass), and the mandate's
 * own funded rows that are waiting on a platform fault, with what is held.
 *
 * This is where a mandate learns of a fault. A fault wakes no review: a
 * pass costs the mandate money, and there is nothing in a fault for it to
 * decide (mandate-event-service.ts leaves out the ingest a fault stopped).
 */
export async function platformFaultBriefing(grantId: string, since: string | null): Promise<string> {
  const [faults, waiting] = await Promise.all([
    rawQuery<{ reason: DeploymentFaultReason; first_seen_at: Date; cleared_at: Date | null }>(
      `SELECT reason, MIN(first_seen_at) AS first_seen_at,
              CASE WHEN bool_or(cleared_at IS NULL) THEN NULL ELSE MAX(cleared_at) END AS cleared_at
         FROM deployment_faults
        WHERE cleared_at IS NULL OR cleared_at > COALESCE($1::timestamptz, now() - interval '1 day')
        GROUP BY reason ORDER BY MIN(first_seen_at)`,
      [since]
    ),
    rawQuery<{
      fault_reason: PlatformFaultReason;
      kind: string;
      n: number;
      held_micro_usd: string | number;
      since: Date;
      next_attempt: Date | null;
    }>(
      `SELECT a.fault_reason, a.kind, COUNT(DISTINCT a.id)::int AS n,
              COALESCE(SUM(al.amount_micro_usd - al.spent_micro_usd), 0)::bigint AS held_micro_usd,
              MIN(a.fault_since) AS since, MIN(a.retry_after) AS next_attempt
         FROM actions a
         JOIN minerval_whole.allocation_money al ON al.exclusion_group = a.exclusion_group
                                   AND al.grant_id = $1 AND al.released_at IS NULL
                                   AND (al.action_id IS NULL OR al.action_id = a.id)
        WHERE a.status = 'open' AND ${waitingOnFaultSql("a")}
        GROUP BY a.fault_reason, a.kind
        ORDER BY MIN(a.fault_since)`,
      [grantId]
    ),
  ]);
  if (faults.length === 0 && waiting.length === 0) return "";
  const lines: string[] = [];
  for (const f of faults) {
    lines.push(
      f.cleared_at
        ? `- Over: ${PLATFORM_FAULT_LABELS[f.reason]}. It lasted from ${minute(f.first_seen_at)} to ` +
            `${minute(f.cleared_at)}; work it held up has been retried or is being retried now.`
        : `- Open since ${minute(f.first_seen_at)}: ${PLATFORM_FAULT_LABELS[f.reason]}. The operator has been told.`
    );
  }
  for (const w of waiting) {
    const label = PLATFORM_FAULT_LABELS[w.fault_reason] ?? w.fault_reason;
    lines.push(
      `- ${w.n} of your funded ${w.kind} row${w.n === 1 ? "" : "s"} ` +
        `(${(Number(w.held_micro_usd) / 1_000_000).toFixed(2)} owls held) ${w.n === 1 ? "is" : "are"} waiting on ${label}, ` +
        `since ${minute(w.since)}` +
        (w.next_attempt ? `; the platform tries next about ${minute(w.next_attempt)}` : "") +
        `.`
    );
  }
  return (
    `Platform faults (none of this is your work's doing, and none of it needs a decision from you):\n\n` +
    lines.join("\n") +
    `\n\nWork a platform fault stops is not failed, parked or cancelled, and no attempt it stops is charged: ` +
    `its ledger row stays open and funded, reads as waiting (the ledger view's waiting_on, waiting_since and ` +
    `next_attempt_at; a plan item's reason), and is retried by the platform until it runs, an ingest included. ` +
    `Do not commission such work again or re-add its plan item: that buys nothing. Its budget stays held ` +
    `for it and counts against your pace from when it was placed, as any held budget does. While a fault ` +
    `lasts, an agent whose tool it stops is told so and works without the tool: a Steward that cannot reach ` +
    `the Matcher keeps a premise in prose, named as unmatched, rather than mint a node nothing checked, so ` +
    `a pass that ran during a fault may be worth a second look once it is over. A fault does not wake your ` +
    `review; you read of it here.`
  );
}
