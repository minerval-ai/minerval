import type { ClaimDetail, SearchResultItem, TreeNode } from "./types";

// Features: the optional parts of the product a deployment can switch off
// (the API's src/features.ts; docs/architecture.md, "Features"). The API
// says which are on at GET /setup/features, and this module is what the web
// app makes of that answer. A feature that is off has no routes on the API,
// so the web app shows nothing that leads to it: no link, no panel, no
// badge, and its own pages answer "not found".
//
// The web app does not work out which feature needs which. The API has
// already done that when it answers (prizes are reported off whenever
// mathematics is), so the list is taken as given.

export const FEATURE_NAMES = ["extension", "mathematics", "prizes"] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Whether each feature is on in this deployment. */
export type Features = Readonly<Record<FeatureName, boolean>>;

// Every feature on. This is what a deployment that sets nothing has, what
// the offline design preview shows, and what the web app assumes when it
// cannot learn otherwise.
export const ALL_FEATURES_ON: Features = { extension: true, mathematics: true, prizes: true };

export function featureOn(features: Features, name: FeatureName): boolean {
  return features[name];
}

/**
 * The body of GET /setup/features as a Features value. A feature is off
 * only where the list says so in as many words (`on: false`). Anything
 * else (a body of another shape, a feature the list does not mention)
 * leaves the feature on, because hiding part of the site on a reply we
 * could not read would be worse than showing a link that leads nowhere.
 */
export function featuresFromResponse(body: unknown): Features {
  const list = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(list)) return ALL_FEATURES_ON;
  const features: Record<FeatureName, boolean> = { ...ALL_FEATURES_ON };
  for (const entry of list as Array<{ name?: unknown; on?: unknown } | null>) {
    const name = FEATURE_NAMES.find((n) => n === entry?.name);
    if (name && entry?.on === false) features[name] = false;
  }
  return features;
}

// --- what core reads carry about a feature -----------------------------------
// A claim's own routes keep their fields about a feature when the feature is
// off, and report whatever the tables hold. The page sections that show
// those fields already render nothing when a field is empty, which is how
// they behave against an API that does not serve it. So the fields are
// emptied here, once, where the data enters the web app, and every surface
// that reads a claim (its page, the map, the cards) follows.

function treeWithout(node: TreeNode, features: Features): TreeNode {
  const next: TreeNode = { ...node, children: node.children.map((c) => treeWithout(c, features)) };
  if (!features.mathematics) {
    next.checked = null;
    next.formal = false;
    next.argument_lean_check = null;
  }
  if (!features.prizes) next.bounty_micro_usd = null;
  return next;
}

/** A claim's detail with the fields of every feature that is off emptied. */
export function claimWithoutOffFeatures(detail: ClaimDetail, features: Features): ClaimDetail {
  if (features.mathematics && features.prizes) return detail;
  const next: ClaimDetail = { ...detail };
  if (detail.tree) next.tree = treeWithout(detail.tree, features);
  if (!features.mathematics) {
    next.formalization = null;
    next.verification = null;
    next.attempts = [];
    next.arguments = detail.arguments?.map((a) => ({ ...a, lean_check: null }));
    next.dependents = detail.dependents?.map((d) => ({ ...d, checked: null, formal: false }));
  }
  if (!features.prizes) {
    next.bounty = null;
    next.prize_claims = [];
    next.dependents = next.dependents?.map((d) => ({ ...d, bounty_micro_usd: null }));
  }
  return next;
}

/** A claim listing with the marks of every feature that is off emptied. */
export function listWithoutOffFeatures(
  items: SearchResultItem[],
  features: Features,
): SearchResultItem[] {
  if (features.mathematics && features.prizes) return items;
  return items.map((c) => ({
    ...c,
    checked: features.mathematics ? c.checked : null,
    prize_micro_usd: features.prizes ? c.prize_micro_usd : null,
  }));
}
