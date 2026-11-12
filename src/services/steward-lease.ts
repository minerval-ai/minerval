/**
 * The Steward's per-claim lock (#482).
 *
 * `steward_state = 'running'` is the lock and `stewarded_at` its lease. Every
 * lane claims the row with a guarded UPDATE (steward-pipeline.ts,
 * order-pipeline.ts, budget-job-pipeline.ts, steward-direct.ts); this module holds what they share:
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
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { LlmRefusalError } from "../llm/errors.js";
import { currentLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";

/**
 * Where the Steward's slot for the work in progress on a node is kept.
 *
 * The node's own row is its slot for work at the node's own label, which
 * on the public graph is all the work there is. Work at another label that
 * reads the node (an internal pass on a public claim) has a slot of its own
 * in steward_slots, one row per node and label with the same columns, so
 * that it neither waits on the other label's pass nor writes its
 * bookkeeping into a row its label does not own (db/schema.ts,
 * steward_slots). Every lane writes its slot statements against these
 * fragments, so one statement serves both, and where the slot is the node's
 * own row the statement is word for word what it always was.
 */
export interface StewardSlot {
  /** True where the slot is the node's own row. */
  own: boolean;
  /** The table that holds it. */
  rel: "claims" | "steward_slots";
  /** The column that names the node. */
  key: "id" | "claim_id";
  /** The label the slot is for. */
  label: string;
  /** SQL: this slot's row, with the node's id as `param` (and the row's alias, where the statement uses one). */
  is(param: string, alias?: string): string;
  /** SQL: the node is active (the row's alias, where the statement uses one). */
  active(alias?: string): string;
}

const col = (alias: string | undefined, name: string) => (alias ? `${alias}.${name}` : name);

const OWN_SLOT = (label: string): StewardSlot => ({
  own: true,
  rel: "claims",
  key: "id",
  label,
  is: (param, alias) => `${col(alias, "id")} = ${param}`,
  active: (alias) => `${col(alias, "state")} = 'active'`,
});

const PLAIN_LABEL_RE = /^[a-z][a-z0-9_-]{0,62}$/;

const LABEL_SLOT = (label: string): StewardSlot => {
  // The label is written into the statement as a literal. It comes from the
  // run's context and is a row in `labels`, whose names are plain words.
  if (!PLAIN_LABEL_RE.test(label)) throw new Error(`"${label}" is not a label's name`);
  return {
    own: false,
    rel: "steward_slots",
    key: "claim_id",
    label,
    is: (param, alias) => `${col(alias, "claim_id")} = ${param} AND ${col(alias, "sensitivity_label")} = '${label}'`,
    active: (alias) =>
      `EXISTS (SELECT 1 FROM claims node WHERE node.id = ${col(alias ?? "steward_slots", "claim_id")} AND node.state = 'active')`,
  };
};

/**
 * The slot of the work in progress on `claimId`: the node's own row where
 * the work is at the node's label, else the row for the work's label in
 * steward_slots. With `ensure`, that row is made if it is not there yet (as
 * 'done': nothing waiting), which every statement that moves a slot needs;
 * a read leaves it out. Where `public` is the only label nothing is asked.
 */
export async function stewardSlot(claimId: string, opts: { ensure?: boolean } = {}): Promise<StewardSlot> {
  const label = currentLabel();
  if (oneLabelOnly()) return OWN_SLOT(label);
  const [node] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!node || node.sensitivity_label === label) return OWN_SLOT(label);
  if (opts.ensure) {
    await rawQuery(
      `INSERT INTO steward_slots (claim_id, sensitivity_label) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [claimId, label]
    );
  }
  return LABEL_SLOT(label);
}

/**
 * SQL expression: a column of the Steward slot of the node aliased `c`, for
 * work at one label. The label is the work in progress's unless `labelSql`
 * names another (a ledger row's, in a sweep over rows at every label).
 * Where the node carries that label it is the node's own column, and where
 * `public` is the only label it is nothing else, word for word. A node
 * with no row for the label has nothing waiting at it.
 */
export function slotColumnSql(
  column: "steward_state" | "steward_error_reason" | "stewarded_at" | "steward_attempts",
  c = "c",
  labelSql?: string
): string {
  if (oneLabelOnly()) return `${c}.${column}`;
  const label = labelSql ?? `'${LABEL_SLOT(currentLabel()).label}'`;
  const none = column === "steward_state" ? "'done'" : column === "steward_attempts" ? "0" : "NULL";
  return `(CASE WHEN ${c}.sensitivity_label = ${label} THEN ${c}.${column}
                ELSE COALESCE((SELECT sl.${column} FROM steward_slots sl
                                WHERE sl.claim_id = ${c}.id AND sl.sensitivity_label = ${label}), ${none}) END)`;
}

/** The state of a slot as a lane reads it, or null where there is no such row. */
export async function readStewardSlot(
  claimId: string,
  slot?: StewardSlot
): Promise<{
  steward_state: string;
  steward_error: string | null;
  steward_error_reason: string | null;
  stewarded_at: Date | null;
  steward_attempts: number;
} | null> {
  const s = slot ?? (await stewardSlot(claimId));
  const [row] = await rawQuery<{
    steward_state: string;
    steward_error: string | null;
    steward_error_reason: string | null;
    stewarded_at: Date | null;
    steward_attempts: number;
  }>(
    `SELECT steward_state, steward_error, steward_error_reason, stewarded_at, steward_attempts
       FROM ${s.rel} WHERE ${s.is("$1")}`,
    [claimId]
  );
  if (row) return row;
  // No row in steward_slots yet: nothing at this label has been asked for.
  return s.own
    ? null
    : { steward_state: "done", steward_error: null, steward_error_reason: null, stewarded_at: null, steward_attempts: 0 };
}

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

/**
 * The trigger a lane runs a claimed node under: the stored one while it
 * names a pass not yet served (the row was pending, deferred, parked or
 * mid-run when claimed), else the lane's own. steward_trigger is not cleared
 * when a pass completes, so on a row claimed from 'done' it names a pass
 * already run: reusing it told a Steward that a structured, assessed claim
 * was on its first pass (#883).
 */
export function unservedTrigger(
  priorState: string,
  stored: string | null,
  fallback: string
): string {
  return priorState !== "done" && stored ? stored : fallback;
}

/**
 * After this many genuine (non-transient) failures a claim parks as 'error',
 * so no lane keeps paying for a pass that fails the same way every time.
 * Transient failures (API budget/credit/credentials/429/5xx/network) never
 * count. A park is not retried automatically: only a commission (a payer who
 * is told what it buys, commission-service.ts) or a maintainer
 * (scripts/recover-parked-stewards.ts) returns the claim to the queue.
 */
export const MAX_STEWARD_ATTEMPTS = 3;

/**
 * Does this failure park the claim at once, whatever its attempt count?
 *
 * A model refusal does (#846). A refusal follows the claim and the model,
 * not chance: by the time LlmRefusalError is thrown the provider's fallback
 * chain has already been tried on the same request (llm/errors.ts), and all
 * eleven claims that refused in July 2026 refused on every one of their three
 * attempts. Two more passes buy the same refusal, each at whatever the pass
 * had spent before it was refused. Parking on the first leaves the retry to
 * someone who can change what is tried: a commission at another tier, or a
 * maintainer.
 */
export function parksAtOnce(err: unknown): boolean {
  return err instanceof LlmRefusalError;
}

/**
 * The SET fragment that ends a genuinely failed run: the attempt counted and
 * the error recorded (`error`, a SQL expression) with its public class
 * (`reason`, a SQL expression; steward-park-reason.ts), and the row back to
 * `state` (a SQL expression, the lane's state for a retry) until the count
 * reaches MAX_STEWARD_ATTEMPTS or the failure parks at once (`parkNow`, a SQL
 * boolean expression; parksAtOnce), then 'error'. A message that arrived
 * mid-run still turns the row 'pending', as on any release; its pass counts
 * as one more attempt if it fails too. The RHS reads the row's values before
 * the update.
 */
export function stewardFailureSet(
  state: string,
  error: string,
  reason: string,
  parkNow: string = "false"
): string {
  return `steward_state = CASE
                WHEN steward_state <> 'running' THEN steward_state
                WHEN steward_requeued THEN 'pending'
                WHEN steward_attempts + 1 >= ${MAX_STEWARD_ATTEMPTS} OR ${parkNow} THEN 'error'
                ELSE ${state}
              END,
              steward_requeued = false,
              steward_error = ${error},
              steward_error_reason = ${reason},
              steward_attempts = steward_attempts + 1`;
}

/** What a successful pass clears: the error, its class and the attempt count. */
export const STEWARD_SUCCESS_CLEAR_SET =
  "steward_error = NULL, steward_error_reason = NULL, steward_attempts = 0";

/**
 * A claim parks as 'error' inside one SQL statement whose CASE may or may
 * not have fired (stewardFailureSet), and parking takes the claim out of
 * every lane's candidate set: funded ledger rows on it are retired and the
 * money sits unspent. That is a maintainer's problem, not an agent's, so
 * the park is surfaced on the agents' own channel (#366, #834) rather than
 * left to whoever next reads `/monitors` queue health. Call it right after
 * the failure update, from whichever lane ran the pass; it reads the row to
 * see whether the park actually happened, reports at most once per claim
 * (the report's dedupe key collapses repeats onto one row with a rising
 * count), and never throws.
 */
export async function reportStewardPark(
  claimId: string,
  lane: string
): Promise<boolean> {
  try {
    const slot = await stewardSlot(claimId);
    const [row] = await rawQuery<{
      steward_state: string;
      steward_error: string | null;
      steward_error_reason: string | null;
      steward_attempts: number;
      text: string;
      retired_backing_micro_usd: string | number;
    }>(
      `SELECT s.steward_state, s.steward_error, s.steward_error_reason,
              s.steward_attempts, c.text,
              COALESCE((
                SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                  FROM minerval_whole.allocation_money al
                  JOIN actions a ON a.exclusion_group = al.exclusion_group
                 WHERE a.claim_id = c.id
                   AND a.kind IN ('assess', 'reassess')
                   AND al.released_at IS NULL
              ), 0)::bigint AS retired_backing_micro_usd
         FROM claims c JOIN ${slot.rel} s ON s.${slot.key} = c.id
        WHERE c.id = $1 AND ${slot.is("$1", "s")}`,
      [claimId]
    );
    if (!row || row.steward_state !== "error") return false;
    const backing = Number(row.retired_backing_micro_usd);
    const { raiseIssue } = await import("./report-service.js");
    await raiseIssue({
      agent: "claim_steward",
      origin: "internal",
      kind: "system_failure",
      // Funded work was retired unrun, so someone is waiting on a pass that
      // will not come until this is looked at.
      severity: backing > 0 ? "blocking" : "degraded",
      surface: `steward park (${lane})`,
      title: `claim ${claimId} parked as error by the Steward`,
      body:
        `The Steward parked this claim as 'error' after ` +
        `${row.steward_attempts} genuine failure${row.steward_attempts === 1 ? "" : "s"} ` +
        `(lane: ${lane}; class: ${row.steward_error_reason ?? "other"}), which ` +
        `takes it out of every lane's candidate set: its assess/reassess ` +
        `ledger rows are retired unrun and any funded item on it reads ` +
        `cancelled until the error is addressed. It is not retried on its ` +
        `own: a commission on the node buys another attempt, and ` +
        `scripts/recover-parked-stewards.ts resets parks by error text or id.` +
        (backing > 0
          ? ` ${(backing / 1_000_000).toFixed(2)} USD of unspent backing is ` +
            `sitting on those retired rows.`
          : "") +
        // The raw text: this report is service-scoped, which is where it
        // belongs. Public surfaces show only the class (#846).
        `\n\nClaim: ${row.text.slice(0, 300)}\n\nLast error: ${
          (row.steward_error ?? "(none recorded)").slice(0, 1500)
        }`,
      contextRefs: { claim_id: claimId },
      claimId,
    });
    return true;
  } catch (err) {
    console.error(
      `[steward-lease] could not report the park of claim ${claimId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

interface HeldLease {
  claimId: string;
  actionId?: string;
  /** The slot the run claimed; the node's own row where it is left out and the run is at the node's label. */
  slot?: StewardSlot;
}

/** A lease as this process holds it: the slot is worked out once, without delaying the lease. */
interface HeldEntry extends HeldLease {
  slotOf: Promise<StewardSlot>;
}

const held = new Set<HeldEntry>();

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
  // The lease is held from this moment, as it always was: the slot it
  // refreshes is the one the caller claimed, or is worked out alongside.
  const slotOf = lease.slot ? Promise.resolve(lease.slot) : stewardSlot(lease.claimId);
  const entry: HeldEntry = { ...lease, slotOf };
  held.add(entry);
  const timer = setInterval(() => {
    slotOf
      .then((slot) =>
        rawQuery(
          `UPDATE ${slot.rel} SET stewarded_at = now()
        WHERE ${slot.is("$1")} AND steward_state = 'running'`,
          [entry.claimId]
        )
      )
      .catch((err) =>
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
  const slots = await Promise.all(leases.map((l) => l.slotOf.catch(() => null)));
  const release = async () => {
    const own = leases.filter((_, i) => slots[i]?.own !== false);
    if (own.length > 0) {
      await rawQuery(
        `UPDATE claims
            SET stewarded_at = now() - make_interval(mins => $2 + 1)
          WHERE id = ANY($1::uuid[]) AND steward_state = 'running'`,
        [own.map((l) => l.claimId), STEWARD_LEASE_STALE_MINUTES]
      );
    }
    for (const [i, l] of leases.entries()) {
      const slot = slots[i];
      if (!slot || slot.own) continue;
      await rawQuery(
        `UPDATE steward_slots
            SET stewarded_at = now() - make_interval(mins => $2 + 1)
          WHERE ${slot.is("$1")} AND steward_state = 'running'`,
        [l.claimId, STEWARD_LEASE_STALE_MINUTES]
      );
    }
    const actionIds = leases.flatMap((l) => (l.actionId ? [l.actionId] : []));
    if (actionIds.length > 0) {
      await rawQuery(
        `UPDATE actions SET status = 'open', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status = 'running'`,
        [actionIds]
      );
    }
  };
  // The process is exiting, outside every run, and the leases it holds may
  // be at any label. Where there is one label this is the statement it
  // always was, on the same connection.
  if (oneLabelOnly()) await release();
  else await withSystemClearance(ABANDON_REASON, release);
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
  const slot = await stewardSlot(claimId, { ensure: true });
  for (;;) {
    const [row] = await rawQuery<{ prior_state: string }>(
      `UPDATE ${slot.rel} c
          SET steward_state = 'running', stewarded_at = now(),
              steward_requeued = false
         FROM (SELECT ${slot.key} AS id, steward_state AS prior_state FROM ${slot.rel}
                WHERE ${slot.is("$1")} FOR UPDATE) prior
        WHERE ${slot.is("prior.id", "c")}
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
  const slot = await stewardSlot(claimId);
  await rawQuery(
    `UPDATE ${slot.rel} SET ${stewardReleaseSet("$2")}, updated_at = now()
      WHERE ${slot.is("$1")}`,
    [claimId, restore]
  );
}

const ABANDON_REASON =
  "A process that exits mid-run hands back the leases it holds, which were taken by runs at any label.";

/** Test hook: how many leases this process holds. */
export function heldStewardLeaseCount(): number {
  return held.size;
}
