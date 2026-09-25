/**
 * The Steward's per-claim lock (#482).
 *
 * `steward_state = 'running'` is the lock and `stewarded_at` its lease. Every
 * lane claims the row with a guarded UPDATE (steward-pipeline.ts,
 * order-pipeline.ts, budget-job-pipeline.ts, grant-pipeline.ts,
 * steward-direct.ts); this module holds what they share:
 *
 *  - the release: a message that arrived mid-run (`steward_requeued`) turns
 *    the row back into 'pending' instead of the lane's own end state, so the
 *    message gets its pass after this run, never alongside it;
 *  - the heartbeat: a live run refreshes `stewarded_at` so only a dead run
 *    ever looks stale, and a long first pass is not taken over at 15 minutes;
 *  - shutdown: a process that exits mid-run hands its claims back at once
 *    (lease backdated past the stale window, action row reopened) rather than
 *    leaving them locked until the lease runs out.
 */
import { rawQuery } from "../db/client.js";

/** A 'running' claim whose lease is older than this is a dead run's. */
export const STEWARD_LEASE_STALE_MINUTES = 15;

/** How often a live run refreshes its lease; well inside the stale window. */
const HEARTBEAT_MS = 60_000;

/**
 * The SET fragment that ends a run: `state` (a SQL expression, usually a
 * parameter) unless a message arrived mid-run, in which case 'pending'. A row
 * that is no longer 'running' is left as found.
 */
export function stewardReleaseSet(state: string): string {
  return `steward_state = CASE
                WHEN steward_state <> 'running' THEN steward_state
                WHEN steward_requeued THEN 'pending'
                ELSE ${state}
              END,
              steward_requeued = false`;
}

interface HeldLease {
  claimId: string;
  actionId?: string;
}

const held = new Set<HeldLease>();

/**
 * Run `fn` while holding the claim's lease: the lease is refreshed every
 * minute until `fn` settles, and the claim (with its ledger action, if any)
 * is known to `abandonStewardLeases` in the meantime. The caller must
 * already have claimed the row ('running').
 */
export async function withStewardLease<T>(
  lease: HeldLease,
  fn: () => Promise<T>
): Promise<T> {
  const entry = { ...lease };
  held.add(entry);
  const timer = setInterval(() => {
    rawQuery(
      `UPDATE claims SET stewarded_at = now()
        WHERE id = $1 AND steward_state = 'running'`,
      [entry.claimId]
    ).catch((err) =>
      console.warn(
        `[steward-lease] heartbeat failed for ${entry.claimId}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
  }, HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    held.delete(entry);
  }
}

/**
 * Shutdown: release every lease this process holds. The claim stays
 * 'running' with its lease backdated past the stale window, so the lanes'
 * existing crash recovery takes it on its next tick, and the ledger action is
 * reopened so coverage can send it again. Call it as the last thing before
 * the process exits: the abandoned runs must not write after this.
 */
export async function abandonStewardLeases(): Promise<number> {
  const leases = [...held];
  held.clear();
  if (leases.length === 0) return 0;
  await rawQuery(
    `UPDATE claims
        SET stewarded_at = now() - make_interval(mins => $2 + 1)
      WHERE id = ANY($1::uuid[]) AND steward_state = 'running'`,
    [leases.map((l) => l.claimId), STEWARD_LEASE_STALE_MINUTES]
  );
  const actionIds = leases.flatMap((l) => (l.actionId ? [l.actionId] : []));
  if (actionIds.length > 0) {
    await rawQuery(
      `UPDATE actions SET status = 'open', updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'running'`,
      [actionIds]
    );
  }
  return leases.length;
}

/**
 * The claim is mid-run elsewhere and did not come free in time. Carries 409
 * so `isTransientApiError` classifies it as retryable: the event's owner
 * releases its action rather than counting a failure.
 */
export class StewardBusyError extends Error {
  readonly status = 409;
  constructor(claimId: string, waitedMs: number) {
    super(
      `claim ${claimId} is mid-run on another Steward; it did not come free ` +
        `within ${Math.round(waitedMs / 1000)}s (#482)`
    );
    this.name = "StewardBusyError";
  }
}

/**
 * Claim the row for a run that does not come from the queue (the money
 * triggers, steward-direct.ts): whatever its state, unless a live run holds
 * it, in which case poll until it comes free or `waitMs` passes. Returns the
 * state to restore on release: the prior state, or 'pending' when the prior
 * holder was a dead run (its pass is still owed).
 */
export async function acquireStewardLock(
  claimId: string,
  opts: { waitMs?: number; pollMs?: number } = {}
): Promise<string> {
  const waitMs = opts.waitMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 10_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [row] = await rawQuery<{ prior_state: string }>(
      `UPDATE claims c
          SET steward_state = 'running', stewarded_at = now(),
              steward_requeued = false
         FROM (SELECT id, steward_state AS prior_state FROM claims
                WHERE id = $1 FOR UPDATE) prior
        WHERE c.id = prior.id
          AND (c.steward_state <> 'running'
               OR c.stewarded_at IS NULL
               OR c.stewarded_at < now() - make_interval(mins => $2))
        RETURNING prior.prior_state`,
      [claimId, STEWARD_LEASE_STALE_MINUTES]
    );
    if (row) return row.prior_state === "running" ? "pending" : row.prior_state;
    const [exists] = await rawQuery<{ id: string }>(
      `SELECT id FROM claims WHERE id = $1`,
      [claimId]
    );
    if (!exists) throw new Error(`Claim not found: ${claimId}`);
    if (Date.now() + pollMs > deadline) throw new StewardBusyError(claimId, waitMs);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** End a run taken with `acquireStewardLock`. */
export async function releaseStewardLock(
  claimId: string,
  restore: string
): Promise<void> {
  await rawQuery(
    `UPDATE claims SET ${stewardReleaseSet("$2")}, updated_at = now()
      WHERE id = $1`,
    [claimId, restore]
  );
}

/** Test hook: how many leases this process holds. */
export function heldStewardLeaseCount(): number {
  return held.size;
}
