/**
 * The action ledger and the plan surface, read together for audit (#433).
 *
 * The allocation engine's decisions — what materialized, what is backed,
 * what ran, what was retired — are judging too, and the Audit Agent checks
 * the judging (docs/architecture.md, "Audit Agent"). Until now every other
 * role read the ledger from its own side (a mandate's list_open_actions
 * shows open rows with that mandate's valuations; grant_overview shows one
 * mandate's plan), and no read-only cross-cut existed: a triage of a report
 * about a plan item could verify the claim-side facts and had to take the
 * ledger-side ones on the reporter's word.
 *
 * This service is that cross-cut, and it is strictly a read. Keyed by a
 * claim, a mandate, or a single action, it returns:
 *  - every action row in scope, in EVERY status (open, running, done,
 *    superseded, cancelled), with its live backing and every allocation
 *    ever placed on its group, released or spent ones included — the
 *    ledger keeps its history as rows, so history is what the rows say;
 *  - every plan item that targets those actions (or that claim, or that
 *    sits on that mandate), with the dashboard state (plan-state.ts), the
 *    ledger standing the materializer wrote on it, and a check of that
 *    standing against the row it names: whether the row is still on the
 *    ledger at all, and whether its current status agrees with what the
 *    item recorded.
 *
 * A ledger row is never deleted on its own; it leaves only when its claim
 * leaves the graph (ON DELETE CASCADE). So "an action that existed last
 * pass has been removed" reads here as a plan item whose recorded
 * action_id resolves to no row: `action_on_ledger: false`.
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import type { PlanItemLedger, PlanItemLedgerStatus } from "./action-service.js";
import { planItemState, type PlanItemState } from "./plan-state.js";

export interface LedgerInspectionInput {
  claimId?: string | null;
  mandateId?: string | null;
  actionId?: string | null;
  /** Cap on action rows returned (default 100, max 500); `actions_total` says how many matched. */
  limit?: number;
}

export interface LedgerAllocationRecord {
  allocation_id: string;
  funder: { kind: "mandate"; mandate_id: string } | { kind: "user"; user_id: string };
  /** The action this allocation is pinned to; null = any variant in the group. */
  pinned_action_id: string | null;
  amount_owls: number;
  spent_owls: number;
  /** Set when a losing sibling's pinned allocation was returned to its funder. */
  released_at: string | null;
  /** Unspent, unreleased: the money still counts toward the group's backing. */
  live: boolean;
  created_at: string;
}

export interface LedgerActionRecord {
  action_id: string;
  kind: string;
  variant: string;
  exclusion_group: string;
  claim_id: string | null;
  target_ref: string | null;
  label: string;
  /** open | running | done | superseded | cancelled — the row as it stands now. */
  status: string;
  cost_est_owls: number;
  /** Live coverage: unspent, unreleased allocations on the group that are unpinned or pinned to this row. */
  backing_owls: number;
  /** backing ≥ cost: the row is runnable (or was, if it is no longer open). */
  covered: boolean;
  metered_cost_owls: number | null;
  metered_job_id: string | null;
  created_at: string;
  updated_at: string;
  /** Every allocation that applies to this row (unpinned on its group, or pinned to it), history included. */
  allocations: LedgerAllocationRecord[];
}

export interface LedgerPlanItemRecord {
  mandate_id: string;
  mandate_name: string;
  mandate_status: string;
  index: number;
  action: string;
  claim_id: string | null;
  url: string | null;
  variant: string | null;
  rationale: string | null;
  /** The dashboard's word for the item (plan-state.ts). */
  state: PlanItemState;
  /** The standing the materializer last wrote on the item; null before its first sweep. */
  ledger: PlanItemLedger | null;
  /**
   * Whether the row the item's ledger standing names is still on the
   * ledger. null when the standing names no row (waiting, blocked, or not
   * yet materialized); false is the "removed" case (#433).
   */
  action_on_ledger: boolean | null;
  /** The named row's current status, when it is on the ledger. */
  action_status: string | null;
  /**
   * Whether the recorded standing agrees with the row's current status
   * (superseded reads as done, as the materializer writes it). null when
   * there is no row to compare against; false means the item is stale
   * against the ledger — the next sweep should rewrite it, and an item
   * that stays false across sweeps is the finding.
   */
  standing_matches_action: boolean | null;
}

export interface LedgerInspection {
  claim: { id: string; text: string; state: string } | null;
  mandate: {
    id: string;
    name: string;
    status: string;
    policy: string;
    plan_cursor: number;
    plan_items: number;
    budget_status: string;
  } | null;
  actions_total: number;
  actions: LedgerActionRecord[];
  plan_items: LedgerPlanItemRecord[];
  /** Plain-language caveats: an id that resolved to nothing, a truncated list. */
  notes: string[];
}

export type LedgerInspectionResult =
  | { ok: true; inspection: LedgerInspection }
  | { ok: false; code: "SCOPE_REQUIRED" | "BAD_ID"; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActionRow {
  id: string;
  kind: string;
  variant: string;
  exclusion_group: string;
  claim_id: string | null;
  target_ref: string | null;
  label: string;
  status: string;
  cost_est_micro_usd: string | number;
  metered_cost_micro_usd: string | number | null;
  metered_job_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  total: number;
}

interface AllocationRow {
  id: string;
  exclusion_group: string;
  action_id: string | null;
  grant_id: string | null;
  user_id: string | null;
  amount_micro_usd: string | number;
  spent_micro_usd: string | number;
  released_at: Date | string | null;
  created_at: Date | string;
}

interface PlanItemRow {
  mandate_id: string;
  mandate_name: string;
  mandate_status: string;
  plan_cursor: number;
  index: number;
  item: Record<string, unknown>;
}

/** The status a plan item's recorded standing implies for the row it names. */
function rowStatusToStanding(status: string): PlanItemLedgerStatus | null {
  switch (status) {
    case "open":
    case "running":
    case "done":
    case "cancelled":
      return status;
    case "superseded":
      return "done";
    default:
      return null;
  }
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function inspectLedger(
  input: LedgerInspectionInput
): Promise<LedgerInspectionResult> {
  const claimId = input.claimId?.trim() || null;
  const mandateId = input.mandateId?.trim() || null;
  const actionId = input.actionId?.trim() || null;
  if (!claimId && !mandateId && !actionId) {
    return {
      ok: false,
      code: "SCOPE_REQUIRED",
      message: "Give at least one of claim_id, mandate_id, or action_id.",
    };
  }
  for (const [name, value] of [
    ["claim_id", claimId],
    ["mandate_id", mandateId],
    ["action_id", actionId],
  ] as const) {
    if (value && !UUID_RE.test(value)) {
      return { ok: false, code: "BAD_ID", message: `${name} is not a UUID: ${value}` };
    }
  }
  const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
  const notes: string[] = [];

  // The anchors, named back so an id that resolves to nothing is said, not
  // silently returned as an empty list.
  const [claim] = claimId
    ? await rawQuery<{ id: string; text: string; state: string }>(
        `SELECT id, text, state FROM claims WHERE id = $1`,
        [claimId]
      )
    : [];
  if (claimId && !claim) {
    notes.push(
      `claim ${claimId} is not in the graph; any ledger rows it had left with it (actions cascade on claim delete).`
    );
  }
  const [mandate] = mandateId
    ? await rawQuery<{
        id: string;
        name: string;
        status: string;
        policy: string;
        plan_cursor: number;
        plan_items: number;
        budget_status: string;
      }>(
        `SELECT g.id, g.name, g.status, g.policy, g.plan_cursor,
                COALESCE(jsonb_array_length(g.plan->'items'), 0)::int AS plan_items,
                j.status AS budget_status
           FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
          WHERE g.id = $1`,
        [mandateId]
      )
    : [];
  if (mandateId && !mandate) notes.push(`mandate ${mandateId} does not exist.`);

  // Plan items in scope. By mandate: all of its items. By claim: every
  // item on any mandate that targets the claim. By action: every item
  // whose recorded standing names the row or its group.
  let planRows: PlanItemRow[] = [];
  const planSelect = `SELECT g.id AS mandate_id, g.name AS mandate_name, g.status AS mandate_status,
            g.plan_cursor, (t.ord - 1)::int AS index, t.item
       FROM grants g,
            jsonb_array_elements(CASE WHEN jsonb_typeof(g.plan->'items') = 'array'
                                      THEN g.plan->'items' ELSE '[]'::jsonb END)
            WITH ORDINALITY AS t(item, ord)`;
  if (mandate) {
    planRows = await rawQuery<PlanItemRow>(
      `${planSelect} WHERE g.id = $1 ORDER BY t.ord`,
      [mandateId]
    );
  }
  if (claimId) {
    const byClaim = await rawQuery<PlanItemRow>(
      `${planSelect} WHERE t.item->>'claim_id' = $1 ORDER BY g.created_at, t.ord`,
      [claimId]
    );
    planRows = mergePlanRows(planRows, byClaim);
  }
  if (actionId) {
    const byAction = await rawQuery<PlanItemRow>(
      `${planSelect}
        WHERE t.item->'ledger'->>'action_id' = $1::text
           OR t.item->'ledger'->>'exclusion_group' =
              (SELECT exclusion_group FROM actions WHERE id = $2::uuid)
        ORDER BY g.created_at, t.ord`,
      [actionId, actionId]
    );
    planRows = mergePlanRows(planRows, byAction);
  }

  // Action rows in scope, every status. By action: the row and its
  // exclusion-group siblings (the alternatives it competed with). By
  // claim: every row on the claim. By mandate: the rows its plan items
  // name (by id or group), its own self-funded rows (grant_planning,
  // mandate_review, target_ref = the grant), and every row its money has
  // ever backed.
  const planActionIds = planRows
    .map((r) => (r.item.ledger as PlanItemLedger | undefined)?.action_id)
    .filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
  const planGroups = planRows
    .map((r) => (r.item.ledger as PlanItemLedger | undefined)?.exclusion_group)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const actionRows = await rawQuery<ActionRow>(
    `SELECT a.id, a.kind, a.variant, a.exclusion_group, a.claim_id, a.target_ref,
            a.label, a.status, a.cost_est_micro_usd, a.metered_cost_micro_usd,
            a.metered_job_id, a.created_at, a.updated_at,
            COUNT(*) OVER ()::int AS total
       FROM actions a
      WHERE ($1::uuid IS NOT NULL AND (a.id = $1 OR a.exclusion_group =
               (SELECT exclusion_group FROM actions WHERE id = $1)))
         OR ($2::uuid IS NOT NULL AND a.claim_id = $2)
         OR ($3::uuid IS NOT NULL AND (
               a.id = ANY($4::uuid[])
               OR a.exclusion_group = ANY($5::text[])
               OR (a.kind IN ('grant_planning', 'mandate_review') AND a.target_ref = $7::text)
               OR EXISTS (SELECT 1 FROM action_allocations al
                           WHERE al.grant_id = $3::uuid
                             AND al.exclusion_group = a.exclusion_group
                             AND (al.action_id IS NULL OR al.action_id = a.id))))
      ORDER BY a.claim_id NULLS LAST, a.exclusion_group, a.cost_est_micro_usd, a.created_at
      LIMIT $6`,
    [actionId, claimId, mandate ? mandateId : null, planActionIds, planGroups, limit, mandate ? mandateId : null]
  );
  const actionsTotal = Number(actionRows[0]?.total ?? 0);
  if (actionsTotal > actionRows.length) {
    notes.push(
      `${actionsTotal} action rows match; showing the first ${actionRows.length} (raise limit, or narrow with a claim_id or action_id).`
    );
  }
  if (actionId && !actionRows.some((r) => r.id === actionId)) {
    notes.push(
      `action ${actionId} is not on the ledger. A row leaves the ledger only when its claim leaves the graph; a retired row stays, as cancelled or superseded.`
    );
  }

  // Every allocation on the groups in scope, history included.
  const groups = [...new Set(actionRows.map((r) => r.exclusion_group))];
  const allocationRows =
    groups.length > 0
      ? await rawQuery<AllocationRow>(
          `SELECT id, exclusion_group, action_id, grant_id, user_id,
                  amount_micro_usd, spent_micro_usd, released_at, created_at
             FROM action_allocations
            WHERE exclusion_group = ANY($1::text[])
            ORDER BY created_at`,
          [groups]
        )
      : [];

  const actions: LedgerActionRecord[] = actionRows.map((row) => {
    const applicable = allocationRows.filter(
      (al) =>
        al.exclusion_group === row.exclusion_group &&
        (al.action_id === null || al.action_id === row.id)
    );
    let backingMicro = 0;
    const allocations: LedgerAllocationRecord[] = applicable.map((al) => {
      const amount = Number(al.amount_micro_usd);
      const spent = Number(al.spent_micro_usd);
      const live = al.released_at == null && spent < amount;
      if (live) backingMicro += amount - spent;
      return {
        allocation_id: al.id,
        funder: al.grant_id
          ? { kind: "mandate", mandate_id: al.grant_id }
          : { kind: "user", user_id: String(al.user_id) },
        pinned_action_id: al.action_id,
        amount_owls: microUsdToOwls(amount),
        spent_owls: microUsdToOwls(spent),
        released_at: iso(al.released_at),
        live,
        created_at: iso(al.created_at)!,
      };
    });
    const cost = Number(row.cost_est_micro_usd);
    return {
      action_id: row.id,
      kind: row.kind,
      variant: row.variant,
      exclusion_group: row.exclusion_group,
      claim_id: row.claim_id,
      target_ref: row.target_ref,
      label: row.label,
      status: row.status,
      cost_est_owls: microUsdToOwls(cost),
      backing_owls: microUsdToOwls(backingMicro),
      covered: backingMicro >= cost,
      metered_cost_owls:
        row.metered_cost_micro_usd == null
          ? null
          : microUsdToOwls(Number(row.metered_cost_micro_usd)),
      metered_job_id: row.metered_job_id,
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
      allocations,
    };
  });

  // The plan items against the rows they name. A named row outside the
  // action page above is looked up directly, so the presence check never
  // depends on the limit.
  const statusById = new Map(actionRows.map((r) => [r.id, r.status]));
  const missingIds = planActionIds.filter((id) => !statusById.has(id));
  if (missingIds.length > 0) {
    const extra = await rawQuery<{ id: string; status: string }>(
      `SELECT id, status FROM actions WHERE id = ANY($1::uuid[])`,
      [[...new Set(missingIds)]]
    );
    for (const r of extra) statusById.set(r.id, r.status);
  }
  const planItems: LedgerPlanItemRecord[] = planRows.map((r) => {
    const item = r.item;
    const ledger = (item.ledger as PlanItemLedger | undefined) ?? null;
    const namedId = ledger?.action_id && UUID_RE.test(ledger.action_id) ? ledger.action_id : null;
    const actionStatus = namedId ? statusById.get(namedId) ?? null : null;
    const onLedger = namedId ? actionStatus !== null : null;
    const standing = actionStatus ? rowStatusToStanding(actionStatus) : null;
    return {
      mandate_id: r.mandate_id,
      mandate_name: r.mandate_name,
      mandate_status: r.mandate_status,
      index: Number(r.index),
      action: String(item.action ?? ""),
      claim_id: typeof item.claim_id === "string" ? item.claim_id : null,
      url: typeof item.url === "string" ? item.url : null,
      variant: typeof item.variant === "string" ? item.variant : null,
      rationale: typeof item.rationale === "string" ? item.rationale : null,
      state: planItemState(
        { action: String(item.action ?? ""), ledger: ledger ?? undefined },
        Number(r.index),
        Number(r.plan_cursor)
      ),
      ledger,
      action_on_ledger: onLedger,
      action_status: actionStatus,
      standing_matches_action:
        ledger && standing !== null ? ledger.status === standing : null,
    };
  });

  return {
    ok: true,
    inspection: {
      claim: claim ?? null,
      mandate: mandate
        ? { ...mandate, plan_cursor: Number(mandate.plan_cursor), plan_items: Number(mandate.plan_items) }
        : null,
      actions_total: actionsTotal,
      actions,
      plan_items: planItems,
      notes,
    },
  };
}

/** Union by (mandate, index), keeping first-seen order. */
function mergePlanRows(a: PlanItemRow[], b: PlanItemRow[]): PlanItemRow[] {
  const seen = new Set(a.map((r) => `${r.mandate_id}:${r.index}`));
  const out = [...a];
  for (const r of b) {
    const key = `${r.mandate_id}:${r.index}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
