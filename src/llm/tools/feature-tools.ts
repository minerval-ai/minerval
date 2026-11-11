/**
 * The agents' tools that belong to a feature (src/features.ts). An agent is
 * not offered the tools of a feature that is switched off: every toolset
 * that could carry one of these passes through withoutOffFeatureTools.
 *
 * Only tools that exist for the feature are listed. A general tool with a
 * field about a feature (a plan item's `formalize` kind, the prize money in
 * grant_overview) stays, as a core route with such a field does.
 *
 * tests/unit/features.test.ts fails when a name here is not a tool any
 * family or skill defines.
 */
import { featureOn, type FeatureName, type FeaturesConfig } from "../../features.js";

export const TOOL_FEATURES: Readonly<Record<string, FeatureName>> = {
  // The Mathematics skill's Lean tools (skills/mathematics/tools.json,
  // tools/lean-tools.ts) and its proof-attempt tools (tools/attempt-tools.ts).
  lean_search: "mathematics",
  lean_elaborate: "mathematics",
  lean_check: "mathematics",
  publish_formalization: "mathematics",
  get_proof_attempt: "mathematics",
  mark_problem_solved_by_platform: "mathematics",
  // The Mathematics skill's prize tools (tools/prize-tools.ts).
  get_prize_claim: "prizes",
  decide_prize_claim: "prizes",
  // The Grantmaker's bounty tools, in the management chat and on a review
  // pass (agents/grantmaker.ts).
  post_bounty: "prizes",
  withdraw_bounty: "prizes",
  confirm_bounty: "prizes",
  // The Audit Agent's prize tools (tools/audit-tools.ts).
  get_prize_claim_record: "prizes",
  record_prize_audit_outcome: "prizes",
  withdraw_bounty_after_audit: "prizes",
  // The Contribution Reviewer's (tools/reviewer-tools.ts).
  get_prize_claim_details: "prizes",
};

/** The feature a tool belongs to, or null for a tool of the core product. */
export function toolFeature(name: string): FeatureName | null {
  return Object.hasOwn(TOOL_FEATURES, name) ? TOOL_FEATURES[name]! : null;
}

/**
 * `tools` without those of a feature that is switched off here. The
 * deployment's config is read only when a tool of a feature is among them.
 */
export function withoutOffFeatureTools<T extends { name: string }>(
  tools: readonly T[],
  config?: FeaturesConfig
): T[] {
  return tools.filter((tool) => {
    const feature = toolFeature(tool.name);
    return feature === null || featureOn(feature, config);
  });
}
