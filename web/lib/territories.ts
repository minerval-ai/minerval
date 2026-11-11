import type {
  AssessmentStatus, ClaimDetail, ClaimType, QuestionStanding, SearchResultItem, TreeNode,
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
  // The kicker above the name: "Investigation" for an anchored cluster,
  // "Question" for one anchored on a question node, and "Domain" for a
  // listing-backed one. Defaults by anchorKind, else "Investigation".
  kicker?: string;
  // "question" when the anchor is a question node (constitution §7a). Stated
  // here, not only read from the live node, so the card still leads with the
  // question and its standing badge when live data is unavailable.
  anchorKind?: "question";
  // The question the investigation is chasing, shown in italics under the name.
  // A territory anchored on a question node leaves it out: the node's own
  // wording is the question, and the card leads with it.
  question?: string;
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

// Curated order is the display order. The AI-safety investigations lead, and
// the first of them is a question node rather than a claim: a question shows
// what the graph is for (what it turns on, which answers are favored, what
// would settle it) better than a single verdict does. Cardiovascular is deliberately ONE
// territory with the LDL/statins subtree folded in: it is honestly one
// investigation, and splitting it reads as padding at this scale.
export const TERRITORIES: TerritoryConfig[] = [
  {
    key: "scheming",
    name: "Scheming evaluations",
    anchorKind: "question",
    // A question node: its wording is the card's lead, so no italic line.
    anchorId: "0d9a8b6e-f091-4fe0-b2aa-bc92d1c0f2c4",
    coreText:
      "What explains the behavior of language models that evaluations record as scheming and alignment faking?",
  },
  {
    key: "misalignment",
    name: "Misalignment risk",
    question: "Could advanced AI competently pursue goals its developers never intended?",
    // A deep AI-safety cluster: the instrumental
    // power-seeking and alignment-faking subtrees hang beneath it.
    anchorId: "5477338c-4f5c-4049-a959-efbf3f23a988",
    coreText:
      "Goal misgeneralization is a plausible mechanism for catastrophic risk from powerful AI systems.",
  },
  {
    key: "oversight",
    name: "Overseeing superintelligence",
    question: "Can weaker overseers keep control of AI systems far more capable than they are?",
    // The homepage flagship (web/app/page.tsx).
    anchorId: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
    coreText: "Scalable oversight can reliably control superintelligent AI systems.",
  },
  {
    key: "takeoff",
    name: "Intelligence explosion",
    question: "Once AI can do AI research, does progress run away?",
    anchorId: "e68a817d-3271-4cb1-88c1-a7d7a2443a83",
    coreText:
      "AI automation of AI research could trigger rapid recursive growth in AI capabilities.",
  },
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
    key: "jacobian",
    name: "The Jacobian conjecture",
    question: "Did the 2026 counterexample settle the conjecture, or does the plane case still stand?",
    // Keller's 1939 conjecture over ℂⁿ, contradicted in July 2026 by Alpöge's
    // explicit ℂ³ counterexample, with the original two-variable case contested
    // and open beneath it. This replaces the "Mathematics" domain card, which
    // pointed nowhere real: its anchor was a fixture-only theorem id (404 in
    // production) and its listing front door filters on the mathematical claim
    // type, which no claim in the live graph carries yet. The mathematics the
    // graph actually holds is this investigation, so the card names it, the way
    // the other three name theirs. When formal statements land, a listing-backed
    // Mathematics card can sit beside this one: the listing branch of
    // loadTerritories and computeListingStats stay in place for it.
    anchorId: "a3029e96-2c0b-41d4-858a-ab45906c4cc8",
    coreText:
      "Every polynomial map of ℂⁿ with nonzero constant Jacobian determinant has a polynomial inverse",
  },
];

export interface TerritoryStats {
  coreText: string;
  coreStatus: AssessmentStatus | null;
  // Set when the core node is a question: it carries a standing (how well
  // answered it is) where a claim carries a status.
  coreStanding?: QuestionStanding | null;
  isQuestion?: boolean;
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

  const isQuestion = detail.claim.kind === "question";
  return {
    coreText: detail.claim.text,
    coreStatus: detail.tree?.assessment_status ?? detail.assessment?.status ?? null,
    ...(isQuestion && {
      isQuestion,
      coreStanding: detail.question?.standing ?? detail.tree?.standing ?? null,
    }),
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
