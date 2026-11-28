/**
 * The pass an accepted contribution asks for.
 *
 * An admitted contribution is a reason to look at its node again, and the
 * presumption is that it is looked at soon, not whenever some other reason
 * happens to buy a pass. A challenge accepted on 2026-11-26 sat unread in
 * its node's inbox for days: the hand-over posted the message and reopened
 * the node's reassess row, and nothing put that row in front of anyone who
 * pays for passes. A consistency flag, a curation, an audit and a lookout's
 * flag were each raised to the General mandate's officers at once; an
 * accepted contribution was not.
 *
 * Two routes, chosen by whether the contributor paid:
 *
 *  - PAID. A contribution of a type that asks for a pass on its node
 *    (PASS_ON_ACCEPT_TYPES) is, by default, charged the assessment cap when
 *    it is submitted, as a proposal is charged its cap (docs/accounts.md,
 *    "Proposing a node"). On acceptance the charge funds an express order on
 *    the node: the reassessment starts at once. A rejection refunds it
 *    (reputation-service.ts, refundChargeForContribution), so a good-faith
 *    contribution that does not pass costs nothing (#71).
 *  - UNPAID (assess: false, no balance to cover it, or a contribution a
 *    service filed for nobody). The node's open reassess row is raised to
 *    the General mandate's officers with the contribution as its reason, as
 *    a consistency flag is raised (consistency-service.ts, revalue). The
 *    officers decide under their operating policy; nothing here prices or
 *    funds anything.
 *
 * Both run from the hand-over (notify_claim_steward), after the message is
 * in the node's inbox, so the pass that is bought reads it.
 */
import { rawQuery } from "../db/client.js";
import { createOrder } from "./order-service.js";
import { getGeneralMandate } from "./allocation-policy-service.js";
import { raiseToMandate } from "./mandate-inbox-service.js";
import { ensureAssessActions, ASSESS_GROUP } from "./action-service.js";
import { capOwls, type PricedOp } from "./owl.js";

/**
 * The contribution types whose acceptance is a reason for a fresh pass on
 * the node they are about: each reaches its Steward with notify_claim_steward
 * and asks it to weigh something. Merges and splits are the Curator's (§5),
 * requests have their own money (Part VIII), and proposals and stated views
 * have their own doors.
 */
export const PASS_ON_ACCEPT_TYPES: ReadonlySet<string> = new Set([
  "challenge",
  "support",
  "propose_edit",
  "add_instance",
  "propose_argument",
  "add_estimate",
  "propose_answer",
]);

/** What the pass a contribution asks for is charged as: one assessment. */
export const PASS_ON_ACCEPT_OP: PricedOp = "assessment";

export function asksForPassOnAccept(contributionType: string): boolean {
  return PASS_ON_ACCEPT_TYPES.has(contributionType);
}

/** The most a contribution's pass costs its contributor, in owls. */
export function passOnAcceptCapOwls(): number {
  return capOwls(PASS_ON_ACCEPT_OP);
}

export type PassOnAccept =
  | { kind: "ordered"; orderId: string | null }
  | { kind: "raised"; grantId: string }
  | { kind: "none"; reason: string };

/**
 * Put the pass an accepted contribution asks for in motion: its paid order,
 * or a raise to the General mandate's officers. Best-effort: a failure here
 * leaves the message in the node's inbox and the row open on the ledger,
 * where a lookout or a later sitting can find it, and never fails the
 * hand-over.
 */
export async function passOnAccept(input: { contributionId: string; claimId: string }): Promise<PassOnAccept> {
  try {
    const [c] = await rawQuery<{
      contribution_type: string;
      contributor_id: string | null;
      review_status: string;
      grant_id: string | null;
      content: string;
    }>(
      `SELECT contribution_type, contributor_id, review_status, grant_id, content
         FROM contributions WHERE id = $1`,
      [input.contributionId]
    );
    if (!c) return { kind: "none", reason: "no such contribution" };
    // A ruling that rejects is handed over too (it may unwind a change);
    // only an admitted contribution asks for a pass.
    if (c.review_status !== "accepted") return { kind: "none", reason: `contribution is ${c.review_status}` };
    if (!asksForPassOnAccept(c.contribution_type)) {
      return { kind: "none", reason: `${c.contribution_type} does not ask for a pass on its node` };
    }

    // Paid: the charge taken at submission, not yet refunded, funds the order.
    const [charge] = await rawQuery<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM owl_ledger
        WHERE contribution_id = $1 AND reason = 'charge'
        ORDER BY created_at ASC LIMIT 1`,
      [input.contributionId]
    );
    if (charge) {
      const made = await createOrder({
        userId: charge.user_id,
        claimId: input.claimId,
        contributionId: input.contributionId,
        chargeEntryId: charge.id,
      });
      if (made.ok) return { kind: "ordered", orderId: made.order.id };
      // The contributor already has an order open on the node: its pass
      // reads the inbox, this message included. The charge is not spent on
      // a second pass; it settles back with nothing metered against it.
      if (made.code === "ORDER_ALREADY_OPEN") return { kind: "ordered", orderId: made.existingOrderId ?? null };
      console.warn(`[contribution-pass] order for ${input.contributionId} refused (${made.code}); raising instead`);
    }

    // Unpaid: the officers who pay for upkeep decide.
    const general = await getGeneralMandate();
    if (!general) return { kind: "none", reason: "no General mandate at this label" };
    await ensureAssessActions(input.claimId);
    const [row] = await rawQuery<{ id: string }>(
      `SELECT id FROM actions WHERE exclusion_group = $1 AND variant = 'standard' AND status = 'open' LIMIT 1`,
      [ASSESS_GROUP(input.claimId)]
    );
    if (!row) return { kind: "none", reason: "no open assess row (a pass may be running)" };
    const raised = await raiseToMandate({
      grantId: general.grantId,
      targetNodeId: input.claimId,
      source: "the Contribution Reviewer",
      summary: raiseSummary(c.contribution_type, input.contributionId, c.content),
      detail: { action_id: row.id, contribution_id: input.contributionId, contribution_type: c.contribution_type },
    });
    return raised ? { kind: "raised", grantId: general.grantId } : { kind: "none", reason: "General mandate not found" };
  } catch (err) {
    console.warn(
      `[contribution-pass] could not put the pass for contribution ${input.contributionId} in motion:`,
      err instanceof Error ? err.message : err
    );
    return { kind: "none", reason: "error" };
  }
}

const SUMMARY_CONTENT_CHARS = 600;

/** What the officers read: what was admitted, and that the node's Steward has not yet weighed it. */
export function raiseSummary(type: string, contributionId: string, content: string): string {
  const text = content.trim().replace(/\s+/g, " ");
  const excerpt = text.length > SUMMARY_CONTENT_CHARS ? `${text.slice(0, SUMMARY_CONTENT_CHARS)}…` : text;
  return (
    `An accepted ${type} (contribution ${contributionId}) waits in this node's inbox for a pass. ` +
    `The Contribution Reviewer admitted it; whether the verdict moves is the Steward's to decide. ` +
    `Its contributor did not pay for the pass. In their words: "${excerpt}"`
  );
}
