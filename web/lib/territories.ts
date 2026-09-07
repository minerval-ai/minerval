import type {
  AssessmentStatus, ClaimDetail, ClaimType, SearchResultItem, TreeNode,
} from "./types";
import { STATUS_ORDER } from "./ontology";

// The pre-search /claims overview (#206). While the graph is small it is a few
// coherent investigations, not a stack of newest claims, so the landing state
// names those investigations instead of dumping the feed. What counts as a
// "territory" is an editorial judgment the graph can't make for us — the
// decomposition DAG has no clean disjoint components (contradicting sides share
// one root; a nutrition subtree hangs under another territory's anchor) — so
// the ANCHORS and labels are curated here. The COUNTS and verdict mix are
// derived from each anchor's subtree at render (see loadTerritories), so the
// numbers stay honest as the graph grows without anyone editing this file.
//
// Longer term this becomes data-driven (a stored territory id or embedding
// clusters on the API side, exposed as GET /territories); that is its own issue
// when a fourth or tenth cluster makes hand-curation the bottleneck. Until then
// a hand-picked anchor is also more robust than deriving roots: as claimspace
// fuses into one connected graph an auto-detected "root" can gain an incoming
// edge and vanish, while the editorial anchor stays put.

export interface TerritoryConfig {
  key: string;
  name: string;
  // The kicker above the name: "Investigation" for an anchored cluster, and
  // "Domain" for a listing-backed one. Defaults to "Investigation".
  kicker?: string;
  // The question the investigation is chasing, shown in italics under the name.
  question: string;
  // The claim the card is fronted by and the map opens on. For a listing-backed
  // territory this is the offline fallback; live, the listing's lead claim
  // takes its place.
  anchorId: string;
  // Curated fallback shown when live data is unavailable (offline/API down), so
  // a card still names its core claim. The live core text overrides this.
  coreText: string;
  // A listing-backed territory (docs/mathematics.md §8.3): every claim of one
  // type rather than one anchor's subtree. Its counts and mix come from the
  // list endpoint filtered by claim_type, and its front door is the filtered
  // list rather than a map. The Mathematics mandate's scope_query never
  // becomes this filter: scope is the Grantmaker's judgment.
  listing?: { claimType: ClaimType };
}

// Curated order is the display order. Cardiovascular is deliberately ONE
// territory with the LDL/statins subtree folded in: it is honestly one
// investigation, and splitting it reads as padding at this scale.
export const TERRITORIES: TerritoryConfig[] = [
  {
    key: "covid",
    name: "COVID origin",
    question: "Did the pandemic begin in a market or a lab?",
    anchorId: "3795e3d8-6487-40e2-9930-00b55a0a0a74",
    coreText:
      "SARS-CoV-2 originated through zoonotic spillover at the Huanan Seafood Market",
  },
  {
    key: "collider",
    name: "Collider safety",
    question: "Could high-energy physics experiments actually endanger the planet?",
    anchorId: "75fc05be-bffe-4c76-9a86-96209e6b5c1e",
    coreText: "Particle collisions at the LHC pose no danger to Earth.",
  },
  {
    key: "cardiovascular",
    name: "Eggs, cholesterol & the heart",
    question: "Does dietary cholesterol from eggs actually raise cardiovascular risk?",
    anchorId: "585e0bd0-5830-4104-851e-7d4130a1be05",
    coreText:
      "Regular egg consumption increases cardiovascular disease risk in healthy people",
  },
  {
    key: "mathematics",
    name: "Mathematics",
    kicker: "Domain",
    question: "Which propositions are proven, which are open, and what has each been checked against?",
    // The offline sample theorem (lib/fixtures.ts); live, the lead claim of
    // the mathematical listing fronts the card.
    anchorId: "legendre-conjecture",
    coreText: "For every positive integer n there is a prime between n² and (n+1)².",
    listing: { claimType: "mathematical" },
  },
];

export interface TerritoryStats {
  coreText: string;
  coreStatus: AssessmentStatus | null;
  // The claim the card fronts when it is not the curated anchor: a
  // listing-backed territory leads with its most important claim.
  leadId?: string;
  // Assessed-only: what has actually been weighed. The total (including the
  // unassessed long tail) rides along as a quiet secondary figure.
  assessedCount: number;
  totalCount: number;
  // Verdict mix over the assessed claims, in STATUS_ORDER, only present verdicts.
  mix: { status: AssessmentStatus; count: number }[];
}

export interface Territory extends TerritoryConfig {
  // Null when live data could not be loaded; the card degrades to name +
  // question + core claim + map link, without counts or the mix bar.
  stats: TerritoryStats | null;
}

// Walk the anchor's decomposition subtree and tally verdicts over DISTINCT
// claims. The API's tree already dedupes a shared subclaim (later occurrences
// are stubs with empty children) and terminates cycles via a visited set, so a
// diamond or a loop can't inflate the count; the Map keyed by id is a second
// guard. Assessed = a non-null verdict, matching the browse feed's default.
export function computeTerritoryStats(detail: ClaimDetail): TerritoryStats {
  const seen = new Map<string, AssessmentStatus | null>();
  const visit = (n: TreeNode | undefined) => {
    if (!n || seen.has(n.id)) return;
    seen.set(n.id, n.assessment_status);
    n.children?.forEach(visit);
  };
  visit(detail.tree);

  const counts = new Map<AssessmentStatus, number>();
  for (const status of seen.values()) {
    if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const mix = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
    status: s,
    count: counts.get(s)!,
  }));

  return {
    coreText: detail.claim.text,
    coreStatus: detail.tree?.assessment_status ?? detail.assessment?.status ?? null,
    assessedCount: [...seen.values()].filter(Boolean).length,
    totalCount: seen.size,
    mix,
  };
}

// The listing-backed counterpart of computeTerritoryStats: a page of claims of
// one type, tallied the same way. The lead claim is the most important assessed
// one, falling back to the most important of any, so the card fronts the
// theorem or conjecture the graph weighs most.
export function computeListingStats(items: SearchResultItem[]): TerritoryStats | null {
  if (items.length === 0) return null;
  const byImportance = [...items].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const lead = byImportance.find((c) => c.assessment_status) ?? byImportance[0];
  const counts = new Map<AssessmentStatus, number>();
  for (const c of items) {
    if (c.assessment_status) {
      counts.set(c.assessment_status, (counts.get(c.assessment_status) ?? 0) + 1);
    }
  }
  const mix = STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({
    status: s,
    count: counts.get(s)!,
  }));
  return {
    coreText: lead.text,
    coreStatus: lead.assessment_status,
    leadId: lead.id,
    assessedCount: items.filter((c) => c.assessment_status).length,
    totalCount: items.length,
    mix,
  };
}

// Where a territory's card leads: an anchored cluster opens its map, a
// listing-backed one opens the filtered list.
export function territoryHref(t: TerritoryConfig): string {
  return t.listing
    ? `/claims?type=${encodeURIComponent(t.listing.claimType)}&assessed=all`
    : `/claims/${t.anchorId}/map`;
}
