// Mirrors the Minerval API (src/schemas/*). Kept hand-written for now; will be
// replaced by a client generated from the Fastify OpenAPI spec.

export type AssessmentStatus =
  | "verified" | "supported" | "contested"
  | "unsupported" | "contradicted" | "unknown";

export type ClaimType =
  | "empirical_verifiable" | "empirical_derived" | "definitional"
  | "evaluative" | "causal" | "normative" | "mathematical";

// The two things a Lean checker can confirm about a published formal
// statement. "proof" establishes it; "disproof" refutes it.
export type CheckKind = "proof" | "disproof";

export type ClaimState =
  | "active" | "merged" | "deprecated" | "archived";

export type Stance = "for" | "against" | "neutral";

export type RelationType =
  | "requires" | "supports" | "contradicts"
  | "specifies" | "defines" | "assumes";

// Steward verdict on a named argument's inference (issue #173): does it go
// through granting its premises? "contested" means the framework's validity
// is itself live-disputed.
export type ArgumentVerdict =
  | "holds" | "holds_with_caveats" | "fails" | "contested";

// Mirrors the backend sourceTypeEnum (src/schemas/common.ts).
export type SourceType =
  | "primary_data" | "peer_reviewed" | "government" | "news_original"
  | "news_secondary" | "opinion" | "social_media" | "unknown";

export interface TreeNode {
  id: string;
  text: string;
  claim_type: ClaimType;
  state: ClaimState;
  depth: number;
  relation_type: RelationType | null;
  reasoning: string | null;
  confidence: number | null;
  assessment_status: AssessmentStatus | null;
  assessment_confidence: number | null;
  // Credence that this node's claim is true (#238); null where the Steward
  // stated none (the omission is information, constitution §10). Optional so
  // a frontend deploy ahead of the API degrades to no figure.
  assessment_credence?: number | null;
  // Steward-seeded prior credence (#285): the parent claim's Steward's
  // preliminary probability that this claim is true, recorded when the
  // subclaim was minted. The API serves it only while the node has NO current
  // assessment — the node still reads as unassessed; a confident seed merely
  // tints it in scan surfaces (hatched, preliminary-styled, never a verdict).
  seed_credence?: number | null;
  argument_id: string | null;
  argument_name: string | null;
  argument_stance: Stance | null;
  // The argument's written form (issue #129): brief prose with inline
  // [[claim:<uuid>]] references stating how the grouped subclaims combine to
  // bear on the claim. Optional while API deploys race the frontend.
  argument_content?: string | null;
  // The steward's evaluation of the argument (issue #173): whether the
  // inference goes through granting its premises, and (in the prose) which
  // premises bear the weight, with the same inline [[claim:<uuid>]] links as
  // the written form. Null until the steward has evaluated the argument;
  // optional while API deploys race the frontend.
  argument_verdict?: ArgumentVerdict | string | null;
  argument_evaluation?: string | null;
  // The checker record behind a machine-checked argument (mathematics): the
  // argument's evidence is a lean_checks row the checker accepted. Threaded
  // onto each of the argument's edges like the other argument_* fields.
  argument_lean_check?: LeanCheckSummary | null;
  // Mathematics, for the map and the tree (docs/mathematics.md §8.3): the
  // amount of a live bounty on this claim, whether a machine-checked proof or
  // disproof of its published statement exists, and whether a published
  // formal statement exists at all. Optional so a tree served by an API that
  // predates the fields degrades to unmarked nodes.
  bounty_micro_usd?: number | null;
  checked?: CheckKind | null;
  formal?: boolean;
  children: TreeNode[];
  // A repeated occurrence of a shared subclaim: its children are rendered at
  // the node's first occurrence in the response, not duplicated here.
  subtree_collapsed?: boolean;
  // The API's node cap dropped some of this node's children.
  children_truncated?: boolean;
}

export interface Assessment {
  id: string;
  status: AssessmentStatus;
  // Verdict confidence: how sure the Steward is that `status` is the right
  // reading of the evidence. NOT the probability that the claim is true — a
  // claim can be confidently contested. Render it quietly and labelled.
  confidence: number;
  // Credence: the Steward's probability that the claim, as stated, is true.
  // Null where one number would be false precision (normative/evaluative
  // claims, entangled composites) — constitution §7. Optional while API
  // deploys race the frontend.
  claim_credence?: number | null;
  // Reader-facing body shown front-and-centre. The API falls back to
  // reasoning_trace for assessments written before the summary/reasoning split,
  // so this is always populated.
  summary: string;
  reasoning_trace: string;
  // DEPRECATED (#160): nothing in the pipeline ever computes this — the column
  // defaults to {} and reassessment carries the empty value forward. Do not
  // render it; the decomposition compass derives the real breakdown from the
  // tree. Kept in the type because the API still returns the field.
  subclaim_summary: Record<string, number>;
  assessed_at: string;
  // Raw API id of the model that produced the assessment (#294), e.g.
  // "claude-fable-5-1". Null/absent for assessments written before the model
  // was recorded — render the date alone, no dangling separator. Optional
  // while API deploys race the frontend.
  model?: string | null;
  // Funding disclosure (§19): present when this assessment was paid work —
  // a user's assessment order or a named grant. Stamped mechanically by the
  // API; absent for ordinary system work.
  funding?: { type: "grant" | "user_order" | "job"; label: string } | null;
}

export interface ClaimCore {
  id: string;
  text: string;
  claim_type: ClaimType;
  state: ClaimState;
  decomposition_status: string;
  // How load-bearing the claim is (0..1), set by the Steward. Orders the work
  // queue: important claims are assessed and decomposed first under a budget.
  importance: number;
  // Steward work-queue lifecycle: pending → running → done | error. A claim that
  // has never reached "done" (and has no assessment) is an unprocessed stub, not
  // an irreducible atom.
  steward_state?: string;
  // The domain tags that select skills and tools (docs/mathematics.md §2.1):
  // a theorem is `mathematical` in type and carries "mathematics" here. Empty
  // when the API omits the column.
  domains?: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ArgumentItem {
  id: string;
  name?: string | null;
  stance: Stance;
  content: string;
  evidence_urls: string[];
  created_by: string;
  created_at: string;
  // Steward evaluation of the inference (issue #173); null until judged.
  verdict?: ArgumentVerdict | string | null;
  evaluation?: string | null;
  // The checker record when this argument is a machine-checked proof or
  // disproof (docs/mathematics.md §2.3); null or absent otherwise.
  lean_check?: LeanCheckSummary | null;
}

export interface Instance {
  id: string;
  source_id: string;
  original_text: string;
  context: string | null;
  // The Extractor's confidence that the passage states a genuine, well-formed
  // claim (see src/workers/url-extraction.ts). NOT the Matcher's match
  // confidence, which is currently not persisted on the instance.
  confidence: number;
  source_title: string;
  source_url: string | null;
  source_type?: SourceType;
}

export interface TrajectoryPoint {
  status: AssessmentStatus;
  confidence: number;
  assessed_at: string;
  is_current: boolean;
  trigger: string | null;
}

// A claim that depends on THIS claim — a reverse decomposition edge. `relation_type`
// describes how the dependent uses this claim (e.g. it `requires` it as a premise).
// This is the data that fills the right margin on a claim page.
export interface DependentClaim {
  id: string;
  text: string;
  claim_type: ClaimType;
  relation_type: RelationType;
  // Why the dependent leans on this claim: the edge's reasoning text (#199).
  // Optional so a frontend deploy ahead of the API degrades to no note.
  reasoning?: string | null;
  assessment_status: AssessmentStatus | null;
  assessment_confidence: number | null;
  // Credence for the dependent claim (#238); same optionality as above.
  assessment_credence?: number | null;
  // Mathematics marks for the map's dependents band; see TreeNode.
  bounty_micro_usd?: number | null;
  checked?: CheckKind | null;
  formal?: boolean;
}

// --- contribution record (#171) ---------------------------------------------

// One exchange in a claim's public contribution record: what a contributor
// submitted, the reviewer's decision and reasoning, and any appeal and
// arbitration that followed. The constitution's Burden of Engagement makes
// the exchange part of the claim's public record; it renders as history,
// separate from the assessment prose (which never absorbs contributor
// dialogue).
export interface ContributionExchange {
  contribution: {
    id: string;
    contributor: { id: string; display_name: string };
    contribution_type: string;
    content: string;
    evidence_urls: string[];
    submitted_at: string;
    review_status: string;
  };
  review: {
    id: string;
    decision: string; // accept | reject | escalate
    reasoning: string;
    confidence: number | null;
    policy_citations: string[];
    reviewed_at: string;
    reviewed_by: string;
  } | null;
  appeal: {
    id: string;
    appellant: { id: string; display_name: string };
    appeal_reasoning: string;
    submitted_at: string;
    status: string; // pending | resolved | pending_human
  } | null;
  arbitration: {
    id: string;
    outcome: string; // uphold_original | overturn | modify | mark_contested | human_review
    decision: string;
    reasoning: string;
    consensus_achieved: boolean | null;
    human_review_recommended: boolean;
    arbitrated_at: string;
    arbitrated_by: string;
  } | null;
}

// The Steward-seeded prior on an unassessed claim (#285): the prior credence
// and brief preliminary note the PARENT claim's Steward recorded when it
// minted this claim as a subclaim. Served by the API only while the claim has
// no current assessment; `seeded_by` names the authoring claim so the UI can
// apply the "preliminary, pending this claim's own assessment" label
// mechanically. Never a substitute for an Assessment.
export interface ClaimSeed {
  credence: number | null;
  note: string | null;
  seeded_by: { id: string; text: string } | null;
}

export interface ClaimDetail {
  claim: ClaimCore;
  assessment: Assessment | null;
  subclaim_count: number;
  // Steward-seeded prior (#285); absent when the claim is assessed, unseeded,
  // or the API predates the field.
  seed?: ClaimSeed | null;
  tree?: TreeNode;
  arguments?: ArgumentItem[];
  instances?: Instance[];
  dependents?: DependentClaim[];
  trajectory?: {
    current: TrajectoryPoint | null;
    history: TrajectoryPoint[];
    total_assessments: number;
    status_transitions: number;
  };
  // The public contribution record (#171); absent when the API predates the
  // /claims/:id/record endpoint or the fetch fails.
  record?: ContributionExchange[];
  // --- mathematics (docs/mathematics.md §11.1) ------------------------------
  // The published formal statement, the derived machine-checked badge, the
  // bounty pinned to the statement, the house solver's attempts, and the
  // prize claims filed. The API loader defaults each to null or empty when
  // the route omits it, so every section renders nothing before the API
  // serves the field.
  formalization: FormalizationSummary | null;
  verification: VerificationSummary | null;
  bounty: BountySummary | null;
  attempts: AttemptSummary[];
  prize_claims: PrizeClaimSummary[];
}

export interface SearchResultItem {
  id: string;
  text: string;
  claim_type: ClaimType;
  state: ClaimState;
  similarity_score?: number; // search results only; absent in the browse feed
  importance?: number;
  assessment_status: AssessmentStatus | null;
  assessment_confidence: number | null;
  // Mathematics (docs/mathematics.md §8.3): the amount of a live bounty on the
  // claim, and whether a machine-checked proof or disproof exists. Null when
  // there is none or the API omits the fields.
  prize_micro_usd: number | null;
  checked: CheckKind | null;
}

export type AssessedFilter = "all" | "assessed" | "unassessed";

// The browse/search filter levers, threaded from the URL through to the API.
export interface ClaimFilters {
  assessed?: AssessedFilter;
  minImportance?: number;
  // Only claims with a live prize (API: with_prizes).
  withPrizes?: boolean;
  // Restrict to one claim type (API: claim_type); the listing-backed
  // Mathematics territory reads through this.
  claimType?: ClaimType;
}

// --- claim event history (#175) ----------------------------------------------

// One entry in a claim's unified history: assessments, contributions, the
// decisions made about them, and steward notes, merged newest-first by the
// API's GET /claims/:id/events. A flat discriminated union — decisions come in
// several forms from several parties, and new kinds should be renderable
// without restructuring.
export type ClaimEvent =
  | { kind: "created"; id: string; at: string; actor: string }
  | {
      kind: "assessment";
      id: string;
      at: string;
      actor: string;
      assessment_id: string;
      status: AssessmentStatus;
      confidence: number;
      claim_credence: number | null;
      summary: string;
      trigger: string | null;
      trigger_context: string | null;
      is_current: boolean;
      prev_status: AssessmentStatus | null;
      prev_confidence: number | null;
    }
  | {
      kind: "contribution";
      id: string;
      at: string;
      actor: string;
      contribution_id: string;
      contribution_type: string;
      content: string;
      evidence_urls: string[];
      review_status: string;
    }
  | {
      kind: "review";
      id: string;
      at: string;
      actor: string;
      review_id: string;
      contribution_id: string;
      contribution_type: string | null;
      decision: string;
      reasoning: string;
      confidence: number;
      policy_citations: string[];
      suspected_bad_faith: boolean;
    }
  | {
      kind: "appeal";
      id: string;
      at: string;
      actor: string;
      appeal_id: string;
      contribution_id: string;
      reasoning: string;
      status: string;
    }
  | {
      kind: "arbitration";
      id: string;
      at: string;
      actor: string;
      arbitration_id: string;
      contribution_id: string;
      appeal_id: string | null;
      outcome: string;
      reasoning: string;
      consensus_achieved: boolean | null;
      human_review_recommended: boolean;
    }
  | {
      kind: "steward_note";
      id: string;
      at: string;
      actor: string;
      audit_id: string;
      action: string;
      reasoning: string;
    };

export interface ClaimEventsPage {
  events: ClaimEvent[];
  total: number;
}

// --- contributors (#71) ------------------------------------------------------

export interface LeaderboardContributor {
  id: string;
  display_name: string;
  avatar_url: string | null;
  owls_earned: number;
  reputation_score: number;
  trust_level: string;
  contributions_accepted: number;
  member_since: string;
}

export interface ContributorProfile {
  contributor: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    member_since: string;
    reputation_score: number;
    trust_level: string;
    owls_earned: number;
    contribution_standing: string;
    is_verified: boolean;
    is_suspended: boolean;
    contributions_accepted: number;
    contributions_rejected: number;
    contributions_escalated: number;
    total_contributions: number;
    acceptance_rate: number | null;
  };
  recent_contributions: Array<{
    id: string;
    // Null for intake proposals (propose_claim / propose_source) still
    // awaiting review (#157).
    claim_id: string | null;
    contribution_type: string;
    review_status: string;
    submitted_at: string;
  }>;
  recent_awards: Array<{
    id: string;
    contribution_id: string | null;
    owls: number;
    created_at: string;
  }>;
}

// The public record of one contribution and its review (#174): what was
// submitted, and — once the reviewer has decided — the decision with the
// reasoning that justifies it.
export interface ContributionDetail {
  contribution: {
    id: string;
    claim_id: string | null;
    contributor_id: string;
    contribution_type: string;
    content: string;
    evidence_urls: string[];
    submitted_at: string;
    review_status: string;
    merge_target_claim_id: string | null;
    proposed_canonical_form: string | null;
  };
  review: {
    id: string;
    decision: string;
    reasoning: string;
    confidence: number;
    policy_citations: string[];
    reviewed_at: string;
    reviewed_by: string;
  } | null;
}

// "Cite this claim" (#290): the conventional citation served by
// GET /claims/:id/citation (format=json), fetched through the BFF. The
// endpoint's envelope also carries the full evidence record, which the web
// panel offers as a JSON download rather than re-rendering.
export interface ClaimCitation {
  author: string;
  title: string;
  claim_id: string;
  assessment_id: string | null;
  assessment_version: number | null;
  status: string | null;
  assessed_at: string | null;
  retrieved_at: string;
  url: string;
  text: string;
  bibtex: string;
  csl: Record<string, unknown>;
}

export interface ClaimCitationPayload {
  citation: ClaimCitation;
  evidence_record: Record<string, unknown>;
}

// --- mathematics: formal statements, checks, prizes, attempts ----------------
// Read models served beside the claim (docs/mathematics.md §11.1). Amounts are
// micro-USD integers like every money column; they render through formatUsd
// and never with owl marks.

// One check the Lean checker ran, summarised for a reading surface.
export interface LeanCheckSummary {
  id: string;
  kind: CheckKind;
  verdict: "accepted" | "rejected" | "error";
  checked_at: string;
  pin_id: string;
  submission_sha256: string | null;
  submitted_by: string | null;
}

export interface FormalizationSummary {
  id: string;
  version: number;
  status: "published" | "reviewed" | "draft" | "retired";
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  namespace: string;
  statement_source: string;
  pp_type: string;
  source_hash: string;
  expr_hash: string;
  correspondence: string | null;
  published_at: string | null;
  review_period_ends_at: string | null;
}

// The derived machine-checked badge (§2.3, §2.4): not a status, a fact about
// the artifacts on the page. Null when no accepted check exists.
export interface VerificationSummary {
  kind: CheckKind;
  lean_check_id: string;
  checked_at: string;
  formalization_id: string;
  pin_id: string;
}

export type BountyStatus =
  | "requested" | "confirm_pending" | "open" | "claim_pending"
  | "house_result_pending" | "rebinding" | "paid" | "resolved_internally"
  | "resolved_unpaid" | "expired" | "withdrawn";

export interface BountySummary {
  id: string;
  amount_micro_usd: number;
  status: BountyStatus;
  resolution: "proof" | "disproof" | "either";
  formalization_id: string;
  source_hash: string;
  expr_hash: string;
  pin_id: string;
  opened_at: string | null;
  expires_at: string | null;
  withdraw_effective_at: string | null;
  rules_version: string;
  submissions: number;
  attempts: Array<{
    id: string;
    finished_at: string;
    variant: "standard" | "max";
    cost_micro_usd: number;
    outcome: "proof" | "disproof" | "partial" | "reduction" | "negative" | "none";
  }>;
  awarded: { credit_name: string; paid_at: string; amount_micro_usd: number } | null;
  // The state sentence, rendered by the server in the graph's voice.
  state_sentence: string;
  terms_url: string;
}

export type PrizeClaimStatus =
  | "queued" | "checking" | "check_error" | "checked" | "in_review"
  | "in_challenge_window" | "payable" | "defect_award_pending" | "paid"
  | "rejected" | "voided" | "withdrawn" | "superseded" | "forfeited";

export interface PrizeClaimSummary {
  id: string;
  credit_name: string;
  direction: CheckKind;
  submitted_at: string;
  status: PrizeClaimStatus;
  rejected_stage: "check" | "review" | "steward" | null;
  contribution_id: string;
}

export type AttemptOutcome = "proof" | "disproof" | "partial" | "reduction" | "negative" | "none";

export interface AttemptSummary {
  id: string;
  claim_id: string;
  variant: "standard" | "max";
  effort: string;
  status: string;
  outcome: AttemptOutcome | null;
  is_calibration: boolean;
  spent_micro_usd: number;
  turns: number;
  started_at: string;
  finished_at: string | null;
  published_at: string | null;
  report: {
    informal_argument: string;
    approaches_tried: string[];
    obstruction: string;
    what_would_help: string;
    confidence: number;
  } | null;
  notebook: Record<string, string> | null;
}

// One row of GET /prizes: an open bounty with the claim it is pinned to.
export interface PrizeListItem {
  claim_id: string;
  text: string;
  claim_type: ClaimType;
  assessment_status: AssessmentStatus | null;
  importance?: number;
  checked: CheckKind | null;
  bounty: BountySummary;
}

// A signed-in claimant's own prize claim, as /users/me lists it (§8.7): the
// public summary plus the claim it is on, the amount, and where the winner's
// steps stand. Payee details, provider ids, and tax data never serialize.
export interface OpenPrizeClaim extends PrizeClaimSummary {
  claim_id: string;
  claim_text: string;
  amount_micro_usd: number;
  window_ends_at: string | null;
  payee_deadline_at: string | null;
  payee_status: "pending" | "submitted" | "verified" | null;
  tax_form_status: "pending" | "received" | null;
  screening_status: "pending" | "cleared" | "blocked" | null;
  paid_at: string | null;
}
