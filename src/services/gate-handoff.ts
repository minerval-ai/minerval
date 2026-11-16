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
 * It offers two more things the link does not carry: a petition from a run
 * above to the mandate below that pays for it, and, when such a mandate
 * closes, a statement of what was put into it and what went back.
 */
import { rawQuery } from "../db/client.js";

/** The gate's one call, as its seam states it. */
export interface GateOffer {
  kind: "answer" | "taken_up" | "funding" | "mandate" | "message" | "petition" | "statement";
  /** The label the thing was produced at. */
  fromLabel: string;
  /** The label it goes to; null is outside the deployment. */
  toLabel: string | null;
  subject: { requestId: string } | { grantId: string } | { messageId: string } | { petitionId: string } | { nodeId: string; amountMicroUsd: number };
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

/**
 * Offer something to the gate. Call it from work at `fromLabel`. The gate
 * is `offerToGate` (gate-service.ts), loaded when the first offer is made;
 * a test may put a function of its own in its place with setGateOffer.
 */
export async function offerDown(offer: GateOffer): Promise<void> {
  const offerTo = gate ?? ((await import("./gate-service.js")).offerToGate as Offer);
  await offerTo(offer);
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
  // Once it has closed: what was put into it and what went back, in words. Nothing is offered while it is open.
  await offerDown({
    kind: "statement",
    fromLabel: link.label,
    toLabel: link.from_label,
    subject: { grantId },
    replyTo: { requestId: link.from_request_id },
  });
}

/**
 * Offer the gate a petition a run at this label made to a mandate that pays
 * for it from a label that does not read this one. The mandate's officers
 * are given it at their own label when it is through.
 */
export async function offerPetitionBelow(petitionId: string, payer: { grantId: string; label: string }, fromLabel: string): Promise<void> {
  await offerDown({ kind: "petition", fromLabel, toLabel: payer.label, subject: { petitionId }, replyTo: { grantId: payer.grantId } });
}
