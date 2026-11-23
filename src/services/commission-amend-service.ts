/**
 * Changing or withdrawing a mandate's commission before its run starts
 * (#1045).
 *
 * A plan's standing orders are their Grantmaker's to change until their
 * pass is running (amend_plan_items, plan-amend-service.ts). A commission
 * placed directly (the `commission` tool, by the Grantmaker or one of its
 * officers, a lookout's, a granted petition's) was not: once placed, its
 * budget was held until the row ran, and if the Grantmaker learned the work
 * was no longer worth it, or worth a different amount, nothing it had could
 * say so. This is the same rule for those: until the row is running, the
 * Grantmaker may give the commission another budget or withdraw it. A budget
 * withdrawn or lowered comes back to the escrow and the pace's room at once;
 * a budget raised is placed under the same pace, reserve and escrow as any
 * commission. A row that is running or has closed is left as it is: money
 * being spent is not taken from under a run, and a closed row's money has
 * already been settled (action-settlement.ts).
 *
 * Out of reach here, with where they are changed: the plan's own orders
 * (amend_plan_items) and the mandate's self-funded upkeep, placed at each
 * row's estimate (fundGrantSelfActions). No count bounds how many
 * commissions are changed; what they hold is bounded by the pace, the
 * reserve and the escrow.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { PLAN_ORDER_COMMISSIONER } from "./standing-order-service.js";

export interface CommissionChange {
  /** The ledger row the commission pays for, as allocation_report names it. */
  action_id: string;
  /** The new budget, in owls. */
  budget_owls?: number;
  withdraw?: boolean;
}

export type CommissionAmendResult =
  | {
      ok: true;
      changes: Array<{
        action_id: string;
        label: string;
        change: string;
        budget_owls: number;
        returned_owls: number;
      }>;
    }
  | { ok: false; problem: string };

interface Held {
  allocation_id: string;
  action_id: string;
  exclusion_group: string;
  claim_id: string | null;
  label: string;
  status: string;
  commissioned_by: string | null;
  amount: number;
  spent: number;
}

/** The mandate's live placement on a row, with the row's state. */
async function heldOn(grantId: string, actionId: string): Promise<Held | null> {
  const [row] = await rawQuery<Held>(
    `SELECT al.id AS allocation_id, a.id AS action_id, a.exclusion_group, al.claim_id, a.label, a.status,
            al.commissioned_by, al.amount_micro_usd::bigint AS amount, al.spent_micro_usd::bigint AS spent
       FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1 AND al.action_id = $2 AND al.released_at IS NULL
      ORDER BY al.created_at DESC LIMIT 1`,
    [grantId, actionId]
  );
  return row ? { ...row, amount: Number(row.amount), spent: Number(row.spent) } : null;
}

/** Why this commission is not one to change here, or null when it is. */
function refusal(h: Held | null, c: CommissionChange): string | null {
  if (!h) return `${c.action_id}: this mandate holds no commission on that row (it may have run, or been settled already).`;
  if (h.commissioned_by === PLAN_ORDER_COMMISSIONER) {
    return `${c.action_id}: that is a standing order of your plan; change it with amend_plan_items.`;
  }
  if (h.commissioned_by === "mandate" || h.commissioned_by === null) {
    return `${c.action_id}: that is the mandate's own upkeep, funded at the row's estimate, not a commission to amend.`;
  }
  if (h.status === "running") return `${c.action_id}: its run has started; money being spent is not taken from under a run.`;
  if (h.status !== "open") return `${c.action_id}: the row has closed and its money has been settled.`;
  if (!c.withdraw) {
    if (c.budget_owls === undefined) return `${c.action_id}: give budget_owls, or withdraw: true.`;
    if (!Number.isFinite(c.budget_owls) || c.budget_owls <= 0) {
      return `${c.action_id}: budget_owls must be more than 0; to take the whole budget back, withdraw it.`;
    }
  }
  return null;
}

/**
 * Change or withdraw commissions of `grantId` that have not started. Every
 * change is checked first and none is made if one is refused. A raise that
 * the pace, the reserve or the escrow turns away when it is placed is
 * reported with the figures, and the changes before it stand.
 */
export async function amendCommissions(input: {
  grantId: string;
  changes: CommissionChange[];
  note: string;
}): Promise<CommissionAmendResult> {
  const note = input.note.trim();
  if (!note) return { ok: false, problem: "note is required: it is kept with each change, for the record." };
  if (input.changes.length === 0) return { ok: false, problem: "Name at least one commission to change." };
  const seen = new Set<string>();
  const held: Held[] = [];
  const problems: string[] = [];
  for (const c of input.changes) {
    if (seen.has(c.action_id)) {
      problems.push(`${c.action_id}: named twice.`);
      continue;
    }
    seen.add(c.action_id);
    const h = await heldOn(input.grantId, c.action_id);
    const why = refusal(h, c);
    if (why) problems.push(why);
    else held.push(h!);
  }
  if (problems.length > 0) return { ok: false, problem: `Nothing was changed. ${problems.join(" ")}` };

  const out: Extract<CommissionAmendResult, { ok: true }>["changes"] = [];
  for (const [i, c] of input.changes.entries()) {
    const h = held[i]!;
    const target = c.withdraw ? 0 : owlsToMicroUsd(c.budget_owls!);
    if (target >= h.amount && !c.withdraw) {
      if (target === h.amount) {
        out.push({ action_id: h.action_id, label: h.label, change: "unchanged", budget_owls: microUsdToOwls(h.amount), returned_owls: 0 });
        continue;
      }
      // A raise is placed like any commission, adding to this one.
      const { placeCommission } = await import("./commission-service.js");
      const placed = await placeCommission({
        group: h.exclusion_group,
        actionId: h.action_id,
        claimId: h.claim_id,
        payer: { kind: "grant", grantId: input.grantId },
        budget: target - h.amount,
        commissionedBy: h.commissioned_by!,
        committer: "grantmaker",
        brief: null,
        reason: `Raised by the Grantmaker: ${note}`,
      });
      if (!placed.ok) {
        return {
          ok: false,
          problem:
            `${h.action_id}: the raise to ${microUsdToOwls(target)} owls was refused: ${"message" in placed ? placed.message : "the row is already paid for"} ` +
            (out.length > 0 ? `The changes before it stand: ${JSON.stringify(out)}` : "Nothing was changed."),
        };
      }
      await recordDecision(input.grantId, h, "raised a commission", target, note);
      out.push({ action_id: h.action_id, label: h.label, change: "raised", budget_owls: microUsdToOwls(target), returned_owls: 0 });
      continue;
    }
    // A cut or a withdrawal, behind the mandate's allocator lock and the
    // row's own lock, with the row checked again: it must not have started.
    const done = await withTransaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('mandate-allocator:' || $1, 0))`, [input.grantId]);
      const [row] = await tx.query<{ status: string }>(`SELECT status FROM actions WHERE id = $1 FOR UPDATE`, [h.action_id]);
      if (row?.status !== "open") return null;
      const [al] = await tx.query<{ amount: string }>(
        c.withdraw
          ? `UPDATE minerval_whole.allocation_money SET released_at = now()
              WHERE id = $1 AND released_at IS NULL AND spent_micro_usd = 0
              RETURNING amount_micro_usd AS amount`
          : `UPDATE minerval_whole.allocation_money SET amount_micro_usd = $2
              WHERE id = $1 AND released_at IS NULL AND spent_micro_usd = 0
              RETURNING $3::bigint AS amount`,
        c.withdraw ? [h.allocation_id] : [h.allocation_id, target, h.amount]
      );
      return al ? Number(al.amount) : null;
    });
    if (done === null) {
      return {
        ok: false,
        problem:
          `${h.action_id}: its run started while this was being changed, so it is left as it is. ` +
          (out.length > 0 ? `The changes before it stand: ${JSON.stringify(out)}` : "Nothing was changed."),
      };
    }
    const returned = c.withdraw ? done : h.amount - target;
    await recordDecision(input.grantId, h, c.withdraw ? "withdrew a commission" : "lowered a commission", target, note);
    out.push({
      action_id: h.action_id,
      label: h.label,
      change: c.withdraw ? "withdrawn" : "lowered",
      budget_owls: microUsdToOwls(target),
      returned_owls: microUsdToOwls(returned),
    });
  }
  return { ok: true, changes: out };
}

async function recordDecision(grantId: string, h: Held, decision: string, budget: number, note: string): Promise<void> {
  await rawQuery(
    `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, target, owls_micro_usd, reason, sensitivity_label)
     VALUES ($1, 'grantmaker', 'commission', $2, $3, $4, $5, $6)`,
    [grantId, decision, h.action_id, budget, note, currentLabel()]
  ).catch((err) => console.warn(`[commission-amend] recording the decision failed: ${err instanceof Error ? err.message : err}`));
}
