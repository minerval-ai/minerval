/**
 * A node's lifecycle on record (#962).
 *
 * `claims.state` says what a node is now: active, merged, deprecated or
 * archived. It used to be the whole story. The archive script set it with a
 * bare UPDATE, so a node it retired read as dead with nothing to say who
 * retired it, why, or where its proposition went; its history showed an
 * assessment and then silence, and a plan item addressed to it was refused
 * as "archived, not active" with no further word.
 *
 * Every change of state now writes a `claim_state_changes` row in the same
 * statement or transaction as the change: who, why, when, and the nodes that
 * carry on what it stated (`successor_ids`). Three readers use it: the node's
 * own history (claim-events-service, kind `state_change`), the changes stream
 * (graph-change-service and the `changes` view, kind `state_changed`), and
 * get_claim's `retired` section with the refusal a write to a retired node
 * meets (`retiredNodeRefusal`), which name the successors so a reference
 * lands somewhere useful.
 *
 * A retired node is not redirected to a successor the way a merged id is
 * (claim-alias-service.ts): a merge says one node now states the same
 * proposition, but a split or a retirement has several successors or none,
 * and none of them is the node. A reader is shown the node as it was, with
 * the record beside it.
 */
import { rawQuery, type TxQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { currentLabel } from "../llm/usage-context.js";
import { resolveClaimId } from "./claim-alias-service.js";

export interface StateChangeInput {
  claimId: string;
  fromState: string;
  toState: string;
  actor: string;
  reason: string;
  successorIds?: readonly string[];
  cohort?: string | null;
  reconciliationEventId?: string | null;
}

/** Record one change of a node's state, in `tx` when given. */
export async function recordStateChange(input: StateChangeInput, tx?: TxQuery): Promise<string | undefined> {
  const sql = `INSERT INTO claim_state_changes
       (claim_id, from_state, to_state, actor, reason, successor_ids, cohort, reconciliation_event_id, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9) RETURNING id`;
  const params = [
    input.claimId,
    input.fromState,
    input.toState,
    input.actor,
    input.reason,
    [...(input.successorIds ?? [])],
    input.cohort ?? null,
    input.reconciliationEventId ?? null,
    currentLabel(),
  ];
  const rows = tx ? await tx.query<{ id: string }>(sql, params) : await rawQuery<{ id: string }>(sql, params);
  return rows[0]?.id;
}

/**
 * Move every node in `ids` that is in `fromState` to `toState`, and record
 * each move, in one statement: a node changes state only with its record. A
 * node in any other state is left alone and unrecorded. `successors` maps a
 * node id to the ids that carry on what it stated. With `recordOnly` the
 * state is not touched: nodes already in `toState` get the record a change
 * made before this table existed should have left, dated `at`.
 * Returns the ids moved (or recorded).
 */
export async function changeClaimsState(input: {
  ids: readonly string[];
  fromState: string;
  toState: string;
  actor: string;
  reason: string;
  cohort?: string | null;
  successors?: Readonly<Record<string, readonly string[]>>;
  recordOnly?: boolean;
  at?: Date | null;
}): Promise<string[]> {
  const successors = JSON.stringify(input.successors ?? {});
  const params = [
    [...input.ids],
    input.fromState,
    input.toState,
    input.actor,
    input.reason,
    input.cohort ?? null,
    successors,
    currentLabel(),
    input.at ?? null,
  ];
  const record = `INSERT INTO claim_state_changes
         (claim_id, from_state, to_state, actor, reason, successor_ids, cohort, sensitivity_label, created_at)
       SELECT moved.id, $2::text, $3::text, $4::text, $5::text,
              COALESCE((SELECT array_agg(s::uuid) FROM jsonb_array_elements_text($7::jsonb -> moved.id::text) s), '{}'::uuid[]),
              $6::text, $8::text, COALESCE($9::timestamptz, now())
         FROM moved
       RETURNING claim_id`;
  const rows = input.recordOnly
    ? await rawQuery<{ claim_id: string }>(
        `WITH moved AS (
           SELECT c.id FROM claims c
            WHERE c.id = ANY($1::uuid[]) AND c.state = $3
              AND NOT EXISTS (SELECT 1 FROM claim_state_changes s
                               WHERE s.claim_id = c.id AND s.to_state = $3
                                 AND NOT EXISTS (SELECT 1 FROM claim_state_changes l
                                                  WHERE l.claim_id = c.id AND l.created_at > s.created_at))
         )
         ${record}`,
        params
      )
    : await rawQuery<{ claim_id: string }>(
        `WITH moved AS (
           UPDATE claims SET state = $3, updated_at = now()
            WHERE id = ANY($1::uuid[]) AND state = $2
           RETURNING id
         )
         ${record}`,
        params
      );
  return rows.map((r) => r.claim_id);
}

export interface StateChangeRow {
  id: string;
  claim_id: string;
  from_state: string;
  to_state: string;
  actor: string;
  reason: string;
  successor_ids: string[];
  cohort: string | null;
  reconciliation_event_id: string | null;
  created_at: Date;
}

/** Every recorded change of a node's state, oldest first. */
export async function listStateChanges(claimId: string): Promise<StateChangeRow[]> {
  return rawQuery<StateChangeRow>(
    `SELECT id, claim_id, from_state, to_state, actor, reason, successor_ids, cohort,
            reconciliation_event_id, created_at
       FROM claim_state_changes WHERE claim_id = $1 ORDER BY created_at, id`,
    [claimId]
  );
}

export interface Successor {
  id: string;
  canonical_form: string;
  state: string;
  page_url: string;
}

/** What get_claim shows beside a node that is no longer active. */
export interface Retirement {
  state: string;
  /** Whether the change that retired the node is on record; false for one made before records were kept. */
  recorded: boolean;
  at: string | null;
  by: string | null;
  reason: string | null;
  cohort: string | null;
  /** The nodes that carry on what this one stated, with their own state now. Empty when there are none. */
  successors: Successor[];
}

/** The description of `retired`, shared by every surface that serves it. */
export const RETIRED_DESCRIPTION =
  "`retired`, present only when the node is no longer active (archived, " +
  "deprecated, or merged where the merge cannot be followed): its `state`; " +
  "`at`, `by` and `reason`, from the record of the change that retired it " +
  "(`recorded` false, and those null, for a node retired before such records " +
  "were kept); the `cohort` it was retired with, if any; and `successors`, " +
  "the nodes that carry on what it stated (a split's parts, for one), each " +
  "with its own state and page_url. A retired node's verdict is the one it " +
  "had when it was retired: no Steward works it, it is out of search and " +
  "trees, and the ledger takes no work on it. Read a successor for the " +
  "graph's current judgment; where `successors` is empty the graph holds no " +
  "live page for the proposition, which is not a finding about it.";

function pageUrl(id: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/claims/${id}`;
}

async function successorRows(ids: readonly string[]): Promise<Successor[]> {
  if (ids.length === 0) return [];
  const rows = await rawQuery<{ id: string; text: string; state: string }>(
    `SELECT id, text, state FROM claims WHERE id = ANY($1::uuid[])`,
    [[...ids]]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is { id: string; text: string; state: string } => r != null)
    .map((r) => ({ id: r.id, canonical_form: r.text, state: r.state, page_url: pageUrl(r.id) }));
}

async function latestChangeTo(claimId: string, state: string): Promise<StateChangeRow | null> {
  const [row] = await rawQuery<StateChangeRow>(
    `SELECT id, claim_id, from_state, to_state, actor, reason, successor_ids, cohort,
            reconciliation_event_id, created_at
       FROM claim_state_changes WHERE claim_id = $1 AND to_state = $2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [claimId, state]
  );
  return row ?? null;
}

/** The record behind a node that is not active, or null for an active node or no node. */
export async function getRetirement(claimId: string): Promise<Retirement | null> {
  const [claim] = await rawQuery<{ state: string; merged_into: string | null }>(
    `SELECT state, merged_into FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!claim || claim.state === "active") return null;
  const change = await latestChangeTo(claimId, claim.state);
  const ids = [...(change?.successor_ids ?? [])];
  if (claim.merged_into && !ids.includes(claim.merged_into)) ids.unshift(claim.merged_into);
  return {
    state: claim.state,
    recorded: change != null,
    at: change ? new Date(change.created_at).toISOString() : null,
    by: change?.actor ?? null,
    reason: change?.reason ?? null,
    cohort: change?.cohort ?? null,
    successors: await successorRows(ids),
  };
}

/**
 * The active nodes a message addressed to `claimId` should reach instead,
 * when `claimId` is not active: a merged node's survivor, else the recorded
 * successors that are active. Empty for an active node, or a retired one
 * with no live successor.
 */
export async function activeSuccessors(claimId: string): Promise<string[]> {
  const [claim] = await rawQuery<{ state: string; merged_into: string | null }>(
    `SELECT state, merged_into FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!claim || claim.state === "active") return [];
  if (claim.merged_into) {
    const resolution = await resolveClaimId(claimId);
    return resolution && resolution.id !== claimId ? [resolution.id] : [];
  }
  const change = await latestChangeTo(claimId, claim.state);
  const live = await successorRows(change?.successor_ids ?? []);
  return live.filter((s) => s.state === "active").map((s) => s.id);
}

/**
 * What a write addressed to a node that is not active is told: its state,
 * the recorded reason, and its successors to address instead. Null for an
 * active node or no node. A merged node's own refusal (mergedAliasRefusal)
 * says more about stance and is preferred where the caller has it.
 */
export async function retiredNodeRefusal(claimId: string): Promise<string | null> {
  const retirement = await getRetirement(claimId);
  if (!retirement) return null;
  const why = retirement.recorded
    ? `It was ${retirement.state} on ${retirement.at!.slice(0, 10)} by ${retirement.by}: ${retirement.reason}`
    : `Its retirement predates the record of such changes, so no reason is on file`;
  const live = retirement.successors.filter((s) => s.state === "active");
  const next =
    live.length > 0
      ? ` Its successor${live.length === 1 ? "" : "s"}: ${live.map((s) => `${s.id} ("${s.canonical_form.slice(0, 120)}")`).join(", ")}; address ${live.length === 1 ? "that node" : "one of those"} instead.`
      : " It has no active successor: no live node carries what it stated.";
  return `${why.replace(/\.?$/, ".")}${next}`;
}
