/**
 * Handing what work above did to the gate (docs/architecture.md, "Work
 * asked for from below").
 *
 * Anything that goes down a label passes that boundary's gate, and one
 * module decides the rest: the gate's own (`offerToGate`, built beside
 * this piece). Work asked for from below builds no way down of its own. It
 * records the link between what was asked and what was made above, and
 * offers the gate the row above with the row below that asked.
 *
 * A request taken up above is offered by the gate itself, from the link
 * `takeUpFromBelow` writes (request-adoption-service.ts, answerableBelow):
 * that it was taken up, each piece of finished work, and where it stands
 * when closed. This module offers the one thing that link does not carry:
 * a mandate made above for a request that paid for one, when it is made
 * and each time where it stands changes (planned, declined or closed with
 * its money returned).
 *
 * Until the gate is wired in (setGateOffer), an offer goes nowhere: the
 * link is on record at the label above and nothing is told below.
 */
import { rawQuery } from "../db/client.js";

/** The gate's one call, as its seam states it. */
export interface GateOffer {
  kind: "answer" | "taken_up" | "funding" | "mandate" | "message";
  /** The label the thing was produced at. */
  fromLabel: string;
  /** The label it goes to; null is outside the deployment. */
  toLabel: string | null;
  subject: { requestId: string } | { grantId: string } | { messageId: string } | { actionId: string };
  /** The row at `toLabel` that asked. */
  replyTo?: { requestId: string } | { grantId: string } | { messageId: string };
  /** The mandate whose budget pays the Redactor's run and Audit's check. */
  payer?: { grantId: string };
}

type Offer = (offer: GateOffer) => Promise<unknown>;

let gate: Offer | null = null;

/** Wire the gate in: `setGateOffer(offerToGate)`, once, where the gate's module loads. Null unwires it. */
export function setGateOffer(offer: Offer | null): void {
  gate = offer;
}

/** Offer something to the gate. Call it from work at `fromLabel`. */
export async function offerDown(offer: GateOffer): Promise<void> {
  if (gate) await gate(offer);
}

/**
 * Offer the gate a mandate that was made at this label for a request from
 * below that paid for one: its terms and where it stands, for the request
 * that asked. Does nothing for any other mandate. Called at the mandate's
 * label when it is made and when its standing changes. The Redactor's run
 * and the check are paid from the mandate's own budget, which is the
 * asker's money.
 */
export async function offerMandateBelow(grantId: string): Promise<void> {
  if (!gate) return;
  const [link] = await rawQuery<{ from_request_id: string; from_label: string; label: string }>(
    `SELECT a.from_request_id, f.sensitivity_label AS from_label, a.sensitivity_label AS label
       FROM adopted_requests a JOIN requests f ON f.id = a.from_request_id
      WHERE a.grant_id = $1`,
    [grantId]
  );
  if (!link) return;
  await offerDown({
    kind: "mandate",
    fromLabel: link.label,
    toLabel: link.from_label,
    subject: { grantId },
    replyTo: { requestId: link.from_request_id },
    payer: { grantId },
  });
}
