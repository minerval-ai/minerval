import type { SearchResultItem, TagSummary } from "./types";

// The front of a members-only deployment's home page (#1092). The public
// home page names public Minerval's investigations (lib/territories.ts) and
// opens its map on a claim picked by hand. None of that exists in a private
// deployment, so there the page says what this deployment holds, read from
// its own graph under the reader's clearance, and shows nothing it does not.
//
// What it holds is named by its topics: the graph's own vocabulary (GET
// /tags, src/services/tag-service.ts), the most-used first, each counted over
// the claims the reader may read. A tag is how the graph itself says what a
// claim is about; the curated territories are an editorial layer public
// Minerval adds on top, which a private deployment does not have.

// How many topics the hero names: as many as the public caption has
// territories, so the line reads the same.
export const FRONT_TOPICS = 8;

// How many of the most recently updated nodes with a verdict the flagship is
// chosen from: one page of GET /claims at its largest.
export const FLAGSHIP_POOL = 100;

export interface DeploymentFront {
  topics: TagSummary[];
  flagship: SearchResultItem | null;
}

export const EMPTY_FRONT: DeploymentFront = { topics: [], flagship: null };

// Whether a node carries a current verdict of its kind: a claim's status, a
// question's standing, a list's fidelity, a quantity's estimate (the
// backend's ASSESSED_SQL).
export function hasVerdict(c: SearchResultItem): boolean {
  if (c.kind === "question") return !!c.standing;
  if (c.kind === "artifact") return !!c.fidelity;
  if (c.kind === "quantity") return !!c.estimate;
  return !!c.assessment_status;
}

// The node the home page's map opens on in a private deployment. The rule:
// of the nodes the reader may read that carry a verdict, taken from the
// FLAGSHIP_POOL most recently updated (GET /claims?assessed=assessed, which
// lists most recently updated first), the one of highest importance; a tie
// goes to the more recently updated. Importance is the graph's own measure
// of how much hangs on a node, so the highest is the one with most beneath
// and around it, which is what a map shows best; a verdict means there is a
// judgment to see. A node with no verdict is never chosen: until something
// has been assessed there is no flagship, and the map says so.
export function chooseFlagship(items: SearchResultItem[]): SearchResultItem | null {
  let best: SearchResultItem | null = null;
  for (const c of items) {
    if (!hasVerdict(c)) continue;
    if (!best || (c.importance ?? 0) > (best.importance ?? 0)) best = c;
  }
  return best;
}
