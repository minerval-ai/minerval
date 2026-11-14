/**
 * The scheduler's step for what passes between a private deployment and
 * the public graph besides pages (docs/outward-acts.md). Each part is
 * tried on its own: one that fails does not stop the others.
 */
import { membersOnly } from "../permissions.js";
import { deliverPublicContributions, takeInPublicContributions } from "./inbound-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { restampPublishedMandates } from "./gate-face.js";
import { sendThroughOutside } from "./gate-outside.js";
import { noticeChangedVersions } from "./keep-current.js";
import { askAfterSentReports, offerReportsToGate } from "./report-sending-service.js";

export async function followOutwardActs(): Promise<Record<string, unknown>> {
  if (!membersOnly() || oneLabelOnly()) return {};
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = await fn();
    } catch (err) {
      console.error(`[outward] ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await step("taken_in", takeInPublicContributions);
  await step("given_to_stewards", deliverPublicContributions);
  // Word from the public graph, the layer below every label: requests there addressed to a mandate this deployment published.
  await step("asked_of_published_mandates", (await import("./inbound-service.js")).deliverAddressedRequests);
  // What work here offers to the gate to outside without anyone asking item by item.
  await step("keep_current", noticeChangedVersions);
  await step("reports_offered", offerReportsToGate);
  await step("published_mandates", restampPublishedMandates);
  // What that gate has let through, on its way out.
  await step("sent_through_the_gate", () => sendThroughOutside());
  await step("reports_asked_after", askAfterSentReports);
  return out;
}
