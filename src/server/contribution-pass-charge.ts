/**
 * The charge for the pass an accepted contribution asks for, taken when it
 * is submitted (services/contribution-pass-service.ts). One helper for
 * POST /contributions and MCP's submit_contribution, which run the same
 * gate.
 *
 * `assess` is the contributor's choice:
 *  - false: nothing is charged; the contribution is free, counts against the
 *    hourly limit on free contributions, and its pass is raised to the
 *    General mandate's officers on acceptance.
 *  - true: the assessment cap is charged, or the submission is refused with
 *    402 when the balance does not cover it.
 *  - left out: charged when the balance covers it, free otherwise. A person
 *    who has never bought owls can still contribute exactly as before; one
 *    who has is assessed at once, as a proposal is, unless they say not to.
 *
 * A type that asks for no pass (asksForPassOnAccept) is never charged, and
 * neither is work with no acting user (service traffic is the system's).
 */
import type { FastifyRequest } from "fastify";
import { checkAgenticQuota, chargeAgenticOp, refundAgenticOp, type QuotaDecision } from "./plugins/quota.js";
import { attachChargeContribution } from "../services/owl-ledger-service.js";
import { asksForPassOnAccept, PASS_ON_ACCEPT_OP } from "../services/contribution-pass-service.js";

type AuthLike = Pick<NonNullable<FastifyRequest["auth"]>, "apiKeyId" | "userId" | "method"> | null | undefined;

export type PassChargePlan =
  | { charge: false; why: "not_asked" | "declined" | "no_user" | "unaffordable" }
  | { charge: true }
  | { denied: QuotaDecision };

/** Before the gate: whether this submission will be charged, so the gate knows whether it is priced. */
export async function planPassCharge(auth: AuthLike, contributionType: string, assess: boolean | undefined): Promise<PassChargePlan> {
  if (!asksForPassOnAccept(contributionType)) return { charge: false, why: "not_asked" };
  if (assess === false) return { charge: false, why: "declined" };
  if (!auth?.userId) return { charge: false, why: "no_user" };
  const check = await checkAgenticQuota(auth, PASS_ON_ACCEPT_OP);
  if (check.allowed) return { charge: true };
  if (assess === true) return { denied: check };
  return { charge: false, why: "unaffordable" };
}

/**
 * After the gate, right before the contribution is written: take the cap.
 * A charge that fails here lost a race with another spend: refused when the
 * contributor asked to be charged, free otherwise.
 */
export async function takePassCharge(
  auth: AuthLike,
  plan: PassChargePlan,
  assess: boolean | undefined
): Promise<{ entryId: string | null; charged: boolean } | { denied: QuotaDecision }> {
  if (!("charge" in plan) || !plan.charge) return { entryId: null, charged: false };
  const charge = await chargeAgenticOp(auth ?? null, PASS_ON_ACCEPT_OP);
  if (charge.allowed) return { entryId: charge.entryId ?? null, charged: true };
  if (assess === true) return { denied: charge };
  return { entryId: null, charged: false };
}

/** Link the charge to the contribution it bought, so a rejection refunds exactly it. */
export async function attachPassCharge(entryId: string | null, contributionId: string): Promise<void> {
  if (entryId) await attachChargeContribution(entryId, contributionId);
}

/** The contribution was never written: the contributor does not pay for that. */
export async function refundPassCharge(auth: AuthLike, charged: boolean): Promise<void> {
  if (charged) await refundAgenticOp(auth ?? null, PASS_ON_ACCEPT_OP).catch(() => {});
}

/** The words a submission's answer carries about its pass. */
export function passChargeMessage(contributionType: string, charged: boolean, plan: PassChargePlan): string | null {
  if (!asksForPassOnAccept(contributionType)) return null;
  if (charged) {
    return "If it is accepted, the node is reassessed at once, paid by this contribution's charge; a rejection refunds it.";
  }
  const why = "why" in plan ? plan.why : null;
  return (
    (why === "unaffordable" ? "Your balance does not cover a reassessment, so nothing was charged. " : "") +
    "If it is accepted, the reassessment it asks for is put to the General mandate's officers, who decide when it runs."
  );
}
