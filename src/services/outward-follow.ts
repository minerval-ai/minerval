/**
 * The scheduler's step for what passes between a private deployment and
 * the public graph besides pages (docs/outward-acts.md). Each part is
 * tried on its own: one that fails does not stop the others.
 */
import { membersOnly } from "../permissions.js";
import { deliverAddressedRequests, deliverPublicContributions, takeInPublicContributions } from "./inbound-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { restampPublishedMandates } from "./gate-face.js";
import { sendThroughOutside } from "./gate-outside.js";
import { noticeChangedVersions } from "./keep-current.js";
import { askAfterSentReports, offerReportsToGate } from "./report-sending-service.js";

const stepper = (out: Record<string, unknown>) => async (name: string, fn: () => Promise<unknown>) => {
  try {
    out[name] = await fn();
  } catch (err) {
    console.error(`[outward] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/**
 * Word from the public graph, the layer below every label: contributions
 * made through a page this deployment published, taken in and given to the
 * node's Steward, and requests addressed to a mandate it published, put in
 * the mandate's inbox. It arrives with the mirror, so it is taken in when a
 * batch is applied (mirror-upkeep.ts) and on the scheduler as a backstop.
 */
export async function takeInFromOutside(): Promise<Record<string, unknown>> {
  if (!membersOnly() || oneLabelOnly()) return {};
  const out: Record<string, unknown> = {};
  const step = stepper(out);
  await step("taken_in", takeInPublicContributions);
  await step("given_to_stewards", deliverPublicContributions);
  await step("asked_of_published_mandates", deliverAddressedRequests);
  return out;
}

export async function followOutwardActs(): Promise<Record<string, unknown>> {
  if (!membersOnly() || oneLabelOnly()) return {};
  const out: Record<string, unknown> = await takeInFromOutside();
  const step = stepper(out);
  // What work here offers to the gate to outside without anyone asking item by item.
  await step("keep_current", noticeChangedVersions);
  await step("reports_offered", offerReportsToGate);
  await step("published_mandates", restampPublishedMandates);
  // What that gate has let through, on its way out.
  await step("sent_through_the_gate", () => sendThroughOutside());
  await step("reports_asked_after", askAfterSentReports);
  return out;
}
