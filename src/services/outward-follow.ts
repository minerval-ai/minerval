/**
 * The scheduler's step for what passes between a private deployment and
 * the public graph besides pages (docs/outward-acts.md). Each part is
 * tried on its own: one that fails does not stop the others.
 */
import { membersOnly } from "../permissions.js";
import { deliverPublicContributions, takeInPublicContributions } from "./inbound-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { followKeepCurrent } from "./outward-acts-service.js";
import { followReports } from "./report-sending-service.js";

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
  await step("keep_current", followKeepCurrent);
  await step("reports", followReports);
  return out;
}
