import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const claimTypeEnum = z.enum([
  "empirical_verifiable",
  "empirical_derived",
  "definitional",
  "evaluative",
  "causal",
  "normative",
]);

// The states the system actually writes (see claims.state in src/db/schema.ts):
// 'active' (live), 'merged' (merge loser, aliased via merged_into), 'deprecated'
// (reversed curator-created claim, soft-deleted), 'archived' (retired
// pipeline-epoch cohort). Contestation is an assessment status, not a lifecycle
// state.
export const claimStateEnum = z.enum([
  "active",
  "merged",
  "deprecated",
  "archived",
]);

export const assessmentStatusEnum = z.enum([
  "verified",
  "supported",
  "contested",
  "unsupported",
  "contradicted",
  "unknown",
]);

// The decomposition relation vocabulary — the single source of truth the tool
// schemas and validators build on, so the enum and the LLM guidance never drift
// apart. `assumes` was named `presupposes` until #205; the old token collected
// uncontested background far more than the contested frameworks §7 reserved it
// for, and "assumes" matches the dominant real usage.
export const RELATION_TYPES = [
  "requires",
  "supports",
  "contradicts",
  "specifies",
  "defines",
  "assumes",
] as const;

export const decompositionRelationEnum = z.enum(RELATION_TYPES);

// Guidance handed to the LLM at the moment it picks a relation token. The tool
// schemas previously described this enum as only "Relationship type", which
// left `requires` and `assumes` to collapse into each other (#205). The fix is
// one discriminating question — what the child's falsity does to the parent —
// which partitions the vocabulary cleanly and generalizes to cases no example
// list anticipates.
export const RELATION_GUIDANCE =
  "How the child bears on the parent. Decide by what the child being false " +
  "would do to the parent. " +
  "'requires': the parent is false without it — a load-bearing premise in the " +
  "inference. " +
  "'supports': evidence that raises confidence in the parent without being " +
  "logically required. " +
  "'contradicts': evidence or argument that weighs against the parent. " +
  "'assumes': background the parent's framing takes as given, so if it fails " +
  "the parent is ill-posed or beside the point rather than simply false — a " +
  "framework or scope premise, usually settled. When such an assumption is " +
  "itself disputed in the discourse it still enters here, and the argument's " +
  "evaluation carries the 'contested' verdict (§7). " +
  "'specifies': a narrower or more precise version of part of the parent. " +
  "'defines': fixes the meaning of a term in the parent, only when that " +
  "meaning is itself disputed and load-bearing.";

export const stanceEnum = z.enum(["for", "against", "neutral"]);

// The types a caller may submit against an EXISTING claim via
// POST /contributions.
export const contributionTypeEnum = z.enum([
  "challenge",
  "support",
  "propose_merge",
  "propose_split",
  "propose_edit",
  "add_instance",
  "propose_argument",
]);

// Intake types (#157): suggestions that would mint NEW graph content. They are
// created internally by POST /claims/propose and POST /sources (never through
// the /contributions body, which requires a target claim) and have a null
// claim_id until review accepts and materializes them.
export const intakeContributionTypeEnum = z.enum([
  "propose_claim",
  "propose_source",
]);

// Every type a contribution row can carry — for list filters and display.
export const anyContributionTypeEnum = z.enum([
  ...contributionTypeEnum.options,
  ...intakeContributionTypeEnum.options,
]);

export const reviewDecisionEnum = z.enum([
  "accept",
  "reject",
  "escalate",
]);

export const arbitrationOutcomeEnum = z.enum([
  "uphold_original",
  "overturn",
  "modify",
  "mark_contested",
  "human_review",
]);

export const informationDepthEnum = z.enum(["cursory", "standard", "deep"]);

export const sourceTypeEnum = z.enum([
  "primary_data",
  "peer_reviewed",
  "government",
  "news_original",
  "news_secondary",
  "opinion",
  "social_media",
  "unknown",
]);

// ---------------------------------------------------------------------------
// Provenance vocabulary (#286)
//
// The edges the Source Mapper records. The load-bearing ones are CLAIM-SCOPED:
// they run from one source's assertion of a claim to the document that
// assertion draws on. That scoping is the whole design. A paper cites forty
// references; at most a couple bear on any one proposition, and a
// document-level citation edge cannot say which. "A depends on B" is only ever
// true relative to something, so the something is carried on the edge.
//
// A thin second vocabulary below covers facts that genuinely are properties of
// a document PAIR rather than of a claim (shared authorship, syndication).
// ---------------------------------------------------------------------------

/**
 * How a source's assertion of a claim relates to an upstream document.
 * Discriminated by WHAT THE ASSERTION TAKES from the document it draws on,
 * which is the question the reader actually has: is this another voice, or
 * the same voice again?
 */
export const CLAIM_PROVENANCE_RELATION_TYPES = [
  "repeats",
  "derives_from",
  "reanalyzes",
  "republishes",
  "cites_as_evidence",
  "responds_to",
] as const;

export const claimProvenanceRelationEnum = z.enum(
  CLAIM_PROVENANCE_RELATION_TYPES
);

/** Guidance handed to the model at the moment it picks a relation token. */
export const CLAIM_PROVENANCE_RELATION_GUIDANCE =
  "What this source's assertion of the claim takes from the upstream " +
  "document. Decide by asking what would be lost if the upstream document " +
  "did not exist. " +
  "'repeats': it takes the assertion itself and restates it, adding no " +
  "evidence of its own — the reader learns nothing new by reading both. " +
  "'derives_from': it takes a finding or result and states the claim on that " +
  "basis, as a news write-up states what a study found. " +
  "'reanalyzes': it takes the underlying data or results and does new work " +
  "on them, reaching the claim by its own analysis. " +
  "'republishes': the whole document is the upstream one, syndicated or " +
  "mirrored, so the two are one voice appearing twice. " +
  "'cites_as_evidence': it offers the upstream document in support without " +
  "depending on it for the assertion's content — the claim would still stand " +
  "as stated if the citation were struck. " +
  "'responds_to': it engages with, qualifies, or rebuts the upstream " +
  "document's assertion of this claim.";

/**
 * What survives the crossing. The single most useful thing this map records
 * and the thing no citation graph anywhere holds: a citation index says an
 * edge exists, never what happened to the claim while travelling along it.
 */
export const PROVENANCE_FIDELITY = [
  "faithful",
  "strengthened",
  "weakened",
  "distorted",
  "misattributed",
  "unclear",
] as const;

export const provenanceFidelityEnum = z.enum(PROVENANCE_FIDELITY);

export const PROVENANCE_FIDELITY_GUIDANCE =
  "How the claim fared crossing this edge. " +
  "'faithful': the assertion says what the upstream document supports. " +
  "'strengthened': stated more confidently, more generally, or with " +
  "qualifications dropped — the commonest failure and the one worth catching. " +
  "'weakened': hedged beyond what the upstream document warrants. " +
  "'distorted': the assertion is not what the upstream document supports, " +
  "through misreading rather than invention. " +
  "'misattributed': the upstream document is credited with something it does " +
  "not say, or the wrong party is credited. " +
  "'unclear': you could not establish this from what you read. Prefer it to " +
  "a guess.";

/**
 * Whether a source's own evidence bears the assertion it makes. Recorded per
 * instance while reading, and the main input the Steward reads: an instance
 * whose source overstates its own evidence is worth knowing about before the
 * stance count is taken at face value.
 */
export const INSTANCE_SUPPORT_READINGS = [
  "supports",
  "overstates",
  "understates",
  "asserts_without_evidence",
  "contradicts_own_evidence",
  "unclear",
] as const;

export const instanceSupportEnum = z.enum(INSTANCE_SUPPORT_READINGS);

export const INSTANCE_SUPPORT_GUIDANCE =
  "Whether the source's OWN evidence and argument bear the claim as this " +
  "source states it. This is not whether the claim is true: that is the " +
  "Steward's judgment, not yours. " +
  "'supports': the source shows what it asserts. " +
  "'overstates': the assertion outruns the source's evidence. " +
  "'understates': the source's evidence would bear a stronger statement. " +
  "'asserts_without_evidence': stated as given, with no supporting evidence " +
  "offered — ordinary and not itself a fault, but worth recording. " +
  "'contradicts_own_evidence': the source's own material cuts against its " +
  "assertion. " +
  "'unclear': you could not tell from what you read.";

/**
 * Mechanical check that an instance's recorded quote is actually in the
 * source (#286's quote-fidelity payoff). Computed by normalized matching in
 * src/services/source-map-service.ts, never by a model — a substring test is
 * exact, free, and auditable where a model is none of the three.
 */
export const QUOTE_CHECK_RESULTS = [
  "verbatim",
  "normalized_match",
  "not_found",
  "no_stored_content",
] as const;

export const quoteCheckEnum = z.enum(QUOTE_CHECK_RESULTS);

/**
 * Relations between two DOCUMENTS, independent of any claim. Deliberately
 * short: these are the facts that stay true whatever proposition you are
 * tracing, and they are what let the map say that five sources are three
 * voices.
 */
export const SOURCE_RELATION_TYPES = [
  "shares_authorship",
  "republishes",
  "version_of",
] as const;

export const sourceRelationEnum = z.enum(SOURCE_RELATION_TYPES);

export const SOURCE_RELATION_GUIDANCE =
  "A relation between two documents that holds regardless of which claim is " +
  "being traced. " +
  "'shares_authorship': an author in common. Symmetric. " +
  "'republishes': the child document is the parent's text, syndicated or " +
  "mirrored. " +
  "'version_of': the same work at a different stage (preprint and published " +
  "article, draft and final). Record the LATER document as the parent.";

/** Symmetric source relations, stored with the lexicographically smaller id as parent. */
export const SYMMETRIC_SOURCE_RELATIONS = new Set<string>(["shares_authorship"]);

/**
 * Mapping onto published provenance vocabularies, carried so the graph can be
 * exported and federated later without re-deciding what our tokens meant
 * (CiTO for citation typing, W3C PROV-O for derivation). The house tokens stay
 * primary: they read plainly in the constitution's voice (§12), where an IRI
 * does not. Where our vocabulary is richer than both — fidelity, which encodes
 * what survived the crossing — there is deliberately no mapping, because no
 * standard has the concept.
 */
export const PROVENANCE_VOCABULARY_MAPPING: Record<
  string,
  { cito?: string; prov?: string }
> = {
  repeats: { cito: "cito:repeatsAssertionFrom", prov: "prov:wasQuotedFrom" },
  derives_from: { cito: "cito:obtainsBackgroundFrom", prov: "prov:wasDerivedFrom" },
  reanalyzes: { cito: "cito:usesDataFrom", prov: "prov:wasDerivedFrom" },
  republishes: { prov: "prov:wasRevisionOf" },
  cites_as_evidence: { cito: "cito:citesAsEvidence" },
  responds_to: { cito: "cito:repliesTo" },
  shares_authorship: {},
  version_of: { prov: "prov:wasRevisionOf" },
};
