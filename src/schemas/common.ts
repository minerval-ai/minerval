import { z } from "zod";
import type { NodeKind } from "./kinds.js";

export const uuidSchema = z.guid();

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
  // A proposition of mathematics (docs/mathematics.md §2.1): settled by
  // proof rather than observation, and the type the Mathematics skill
  // assigns; a formal statement and a prize can bind only to one of these.
  "mathematical",
]);

// The states the system actually writes (see claims.state in src/db/schema.ts):
// 'active' (live), 'merged' (merge loser, aliased via merged_into), 'deprecated'
// (reversed curator-created claim, soft-deleted), 'archived' (retired
// pipeline-epoch cohort). How disputed a claim is lives in its `contestation`
// value, not in its lifecycle state or its assessment status.
export const claimStateEnum = z.enum([
  "active",
  "merged",
  "deprecated",
  "archived",
]);

// The evidential ladder (constitution §10, #524): verified and supported on
// the side of the claim, inconclusive in the middle, doubtful and
// contradicted against it, and unknown for a claim that could not be
// assessed. How actively a claim is disputed is not a status: it is the
// per-claim `contestation` value, shown beside the verdict.
export const assessmentStatusEnum = z.enum([
  "verified",
  "supported",
  "inconclusive",
  "doubtful",
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
  "How the child bears on the parent (constitution §6). Decide by what the " +
  "child being false would do to the parent itself, not to one argument for it. " +
  "'requires': the parent is false if the child is, whatever else supports it. " +
  "A premise of one argument, where the parent has other lines of support that " +
  "do not rest on it, is not required: record it as supports, or contradicts " +
  "under an argument against. " +
  "'supports': evidence that raises confidence in the parent without being " +
  "logically required. " +
  "'contradicts': evidence or argument that weighs against the parent. " +
  "'assumes': background the parent's framing takes as given, so if it fails " +
  "the parent is ill-posed or beside the point rather than simply false — a " +
  "framework premise. Whether the framework is fit for the question is often " +
  "the deepest crux, disputed in print or not; when it is in doubt it still " +
  "enters here, as a premise whose assessment bears on whether the " +
  "argument's premises hold (§7). " +
  "'specifies': a narrower or more precise version of part of the parent. " +
  "'defines': fixes the meaning of a term in the parent, only when that " +
  "meaning is itself disputed and load-bearing.";

// Lateral links (#436): the constitution's third direction (§19), claims that
// are neither premise nor conclusion of each other yet constrain one another
// or read as halves of one position. Symmetric and non-evaluative: a link
// carries reasoning and renders as a see-also on both claim pages, and it is
// never a dependency, so coherence propagation and subclaim-based assessment
// never see it. Kept deliberately small; add a kind when a second distinct
// use appears, not before.
export const CLAIM_LINK_KINDS = [
  "related",
  "rival_explanation",
  "counterpart_position",
] as const;

export const claimLinkKindEnum = z.enum(CLAIM_LINK_KINDS);

export const CLAIM_LINK_GUIDANCE =
  "How the two claims stand to each other, neither being a premise of the " +
  "other. 'rival_explanation': competing accounts of the same event or " +
  "phenomenon, so evidence for one bears on the other (§19; their credences " +
  "must be jointly tenable, §21). 'counterpart_position': two halves of one " +
  "public position, e.g. what an author maintains and whether their own " +
  "theory delivers it, which a reader of either would want beside it. " +
  "'related': a see-also with no tighter fit, including two formulations " +
  "created together because their identity was unclear (§5). If one claim " +
  "would be false, ill-posed, or less credible were the other false, that " +
  "is a decomposition edge, not a link.";

export const stanceEnum = z.enum(["for", "against", "neutral"]);

/**
 * How a source instance stands to the canonical claim (#445). "affirms": the
 * source asserts the claim as canonically stated. "denies": it asserts the
 * negation or contrary. "poses": it states the proposition as an open
 * question without endorsing either side, as a survey states a conjecture
 * ("the Jacobian conjecture asks whether..."). "mentions": it refers to the
 * claim without asserting, denying or posing it: it cites the claim, reports
 * that others hold it, or raises it in passing in a way worth a reader
 * seeing. Posing and mentioning instances are provenance, sources that refer
 * to the proposition, and not votes on it: stance counts and citation
 * predicates keep them out of both camps, and a mention is shown as its own
 * category wherever stances are counted.
 */
export const INSTANCE_STANCES = ["affirms", "denies", "poses", "mentions"] as const;
export type InstanceStance = (typeof INSTANCE_STANCES)[number];
export const isInstanceStance = (v: unknown): v is InstanceStance =>
  (INSTANCE_STANCES as readonly unknown[]).includes(v);

/**
 * The stances ingestion assigns. The Extractor surfaces passages that state a
 * claim, and the Matcher decides which side each falls on; a source that
 * only mentions a claim is a Steward's judgment from reading it, recorded
 * with record_claim_instance, so "mentions" is not offered there.
 */
export const MATCHED_INSTANCE_STANCES = ["affirms", "denies", "poses"] as const;
export type MatchedInstanceStance = (typeof MATCHED_INSTANCE_STANCES)[number];
export const isMatchedInstanceStance = (v: unknown): v is MatchedInstanceStance =>
  (MATCHED_INSTANCE_STANCES as readonly unknown[]).includes(v);

/**
 * How a passage stands toward an argument it is an instance of (§4, §7,
 * #541). "advances": the passage makes the argument. "criticizes": it
 * attacks the argument (a paper rebutting it is also an instance of the
 * defeating claim). "mentions": it names or reports the argument without
 * making or attacking it. Like posing and mentioning instances of claims,
 * a mention is provenance and counts in neither camp. Ingestion assigns
 * only the first two (MATCHED_ARGUMENT_INSTANCE_STANCES); a mention is a
 * Steward's judgment from reading the source.
 */
export const ARGUMENT_INSTANCE_STANCES = ["advances", "criticizes", "mentions"] as const;
export type ArgumentInstanceStance = (typeof ARGUMENT_INSTANCE_STANCES)[number];
export const isArgumentInstanceStance = (v: unknown): v is ArgumentInstanceStance =>
  (ARGUMENT_INSTANCE_STANCES as readonly unknown[]).includes(v);
export const MATCHED_ARGUMENT_INSTANCE_STANCES = ["advances", "criticizes"] as const;

/**
 * How well a passage states the argument it is an instance of (§4, §7). A
 * fact about the passage: it never changes the argument's written form.
 * "full": it states the inference with what it needs. "premise_unstated":
 * it leaves a premise the inference needs unspoken. "strawman": it states
 * a weaker version than the argument (usually a passage criticizing it). A
 * passage that rests on a different premise is not a reading of this
 * argument but an instance of a different one.
 */
export const ARGUMENT_READINGS = ["full", "premise_unstated", "strawman"] as const;
export type ArgumentReading = (typeof ARGUMENT_READINGS)[number];
export const isArgumentReading = (v: unknown): v is ArgumentReading =>
  (ARGUMENT_READINGS as readonly unknown[]).includes(v);

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
  // Kinds and requests (constitution §7a, Part VIII): a source's figure for
  // a quantity, a candidate answer to a question, a request on the node,
  // and material offered to meet one of its requests.
  "add_estimate",
  "propose_answer",
  "propose_request",
  "answer_request",
]);

/**
 * A request may bear on several nodes, on sources, or on something the
 * graph does not hold yet (Part VIII), so a propose_request needs no target
 * claim (#724); the Reviewer settles what it bears on. Every other type is
 * about one existing node.
 */
export function contributionMayOmitClaim(type: string): boolean {
  return type === "propose_request";
}

export const CLAIM_ID_REQUIRED_MESSAGE =
  "claim_id is required: every contribution type but propose_request is about an existing node";

// Intake types (#157): suggestions that would mint NEW graph content. They are
// created internally by POST /claims/propose and POST /sources (never through
// the /contributions body, which requires a target claim) and have a null
// claim_id until review accepts and materializes them.
export const intakeContributionTypeEnum = z.enum([
  "propose_claim",
  // A question proposed directly (constitution §7a): materialized like a
  // claim, through the Matcher, as a question node or as the claim or
  // quantity it turns out to ask about.
  "propose_question",
  // A quantity proposed directly (#816): its wording says what is measured,
  // in what population and unit, as an extracted quantity's does; the
  // Steward records the structured definition on its first pass.
  "propose_quantity",
  "propose_source",
]);

/** The intake type that proposes a node of each kind (§2, §7a). */
export const PROPOSAL_TYPE_FOR_KIND = {
  claim: "propose_claim",
  question: "propose_question",
  quantity: "propose_quantity",
} as const satisfies Record<NodeKind, string>;

/** The kind a node proposal proposes; null for any other contribution type. */
export function proposedNodeKind(type: string): NodeKind | null {
  const hit = (Object.entries(PROPOSAL_TYPE_FOR_KIND) as Array<[NodeKind, string]>).find(([, t]) => t === type);
  return hit ? hit[0] : null;
}

// The prize claim (docs/mathematics.md §8.4): an ordinary contribution so it
// inherits the identity gate, the review pipeline, appeals, arbitration, and
// audit — but created only by its own route (POST /claims/:id/prize-claims),
// because it carries files and a different gate. Deliberately NOT in
// contributionTypeEnum, which POST /contributions validates against and
// must keep refusing it.
export const prizeContributionTypeEnum = z.enum(["claim_prize"]);

// Every type a contribution row can carry — for list filters and display.
export const anyContributionTypeEnum = z.enum([
  ...contributionTypeEnum.options,
  ...intakeContributionTypeEnum.options,
  ...prizeContributionTypeEnum.options,
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

/**
 * What kind of document a source is: the one list `sources.source_type`
 * holds (a CHECK constraint keeps it so, migration 0119), the registry
 * lookup maps onto, the agents choose from, and the page shows. Each kind
 * with what counts as one, in the words an agent choosing reads.
 *
 * The kind says what a document is, never how far to trust it: a journal
 * article can be wrong and a blog post right. The one thing derived from it
 * is where a claim's provenance story may begin (PRIMARY_SOURCE_KINDS).
 *
 * Adding a kind: add it here, to the CHECK in src/db/schema.ts with a
 * migration, and to SourceKind in web/lib/types.ts.
 */
export const SOURCE_KIND_DESCRIPTIONS = {
  dataset: "data published as data: a data file, a database, a registry record",
  official_statistics: "a statistical release from the body that compiles the figures",
  transcript:
    "the verbatim record of what was said: a hearing, a speech, an interview or debate in full, or the recording itself",
  treaty: "the text of a treaty or international agreement",
  court_record: "a judgment, order, or filing in a case",
  legislation: "a statute, regulation or bill, in its own text",
  journal_article: "an article in a scholarly journal",
  preprint: "a scholarly paper posted before or without journal publication",
  conference_paper: "a paper in a conference's proceedings",
  book: "a book",
  book_chapter: "a chapter of a book",
  thesis: "a dissertation or thesis",
  report:
    "a report, working paper or white paper issued by an organization: an agency, a company, a think tank, a working group",
  standard: "a published technical standard or specification",
  news_article: "a news outlet's report of events",
  opinion: "an editorial, column, essay or commentary that argues a position",
  press_release: "an organization's own announcement or statement",
  blog_post: "a post on a personal or organizational blog, forum or newsletter",
  social_media_post: "a post or thread on a social platform",
  reference_work: "an encyclopedia entry, textbook, handbook or fact sheet",
  broadcast: "a podcast, programme or video that is not a verbatim record of one remark or event",
  webpage: "a web page of none of the kinds above: an organization's page, documentation, a product page",
  unknown: "not yet identified",
} as const;

export type SourceKind = keyof typeof SOURCE_KIND_DESCRIPTIONS;

export const SOURCE_KINDS = Object.keys(SOURCE_KIND_DESCRIPTIONS) as [SourceKind, ...SourceKind[]];

export const sourceKindEnum = z.enum(SOURCE_KINDS);

/**
 * Kinds that say nothing specific about the document. A more specific kind
 * may replace one of these from any supplier; a specific kind, once
 * recorded, is replaced only by a Steward's correction.
 */
export const GENERIC_SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>(["unknown", "webpage"]);

/** The kinds an agent may state for a source it read: every kind but "unknown", which is the absence of one. */
export const STATABLE_SOURCE_KINDS = SOURCE_KINDS.filter((k) => k !== "unknown");

/** `value` as a kind an agent may state, or null when it is not one. */
export function statedSourceKind(value: unknown): SourceKind | null {
  const v = typeof value === "string" ? value.trim() : "";
  return (STATABLE_SOURCE_KINDS as string[]).includes(v) ? (v as SourceKind) : null;
}

/** The list as a tool description gives it: each kind with what counts as one. */
export const SOURCE_KIND_GUIDANCE =
  "What kind of document the source is, when you have seen enough of it to say. " +
  STATABLE_SOURCE_KINDS.map((k) => `'${k}': ${SOURCE_KIND_DESCRIPTIONS[k]}`).join("; ") +
  ". Say what the document itself is, not what it reports on: a news report of a court ruling is a " +
  "news_article, and the ruling is the court_record. Omit it rather than guess.";

// Agent reports (#366): the agents' own channel for system failures, tool
// gaps, and improvement ideas. Keep in sync with the agent_reports column
// comments in src/db/schema.ts.
export const reportKindEnum = z.enum([
  "system_failure",
  "tool_gap",
  "improvement",
]);

export const reportSeverityEnum = z.enum([
  "blocking",
  "degraded",
  "annoyance",
  "idea",
]);

export const reportOriginEnum = z.enum(["internal", "external"]);

// Agent findings (#394): published as written; withdrawn is the operator's
// reversal, kept on the row so the id still resolves.
export const findingStatusEnum = z.enum(["published", "withdrawn"]);

// withdrawn is the reporter's own reversal (update_issue): the agent that
// raised it found it was its mistake, so nobody triages a non-issue.
export const reportStatusEnum = z.enum([
  "new",
  "triaged",
  "duplicate",
  "actioned",
  "wontfix",
  "withdrawn",
]);
// ---------------------------------------------------------------------------
// Provenance vocabulary (#286)
//
// The edges the provenance tools record. The load-bearing ones are CLAIM-SCOPED:
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
  "evidence_not_shown",
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
  "'evidence_not_shown': the source reports a result from evidence it holds " +
  "and has not published (its own evaluation, an internal log, a dataset it " +
  "does not release). This is not 'asserts_without_evidence': the evidence " +
  "exists, and what is missing is your sight of it (§9). Say in the note " +
  "what the evidence is said to be and whether anyone other than the source " +
  "has examined it. Where an assessment made on that evidence has been " +
  "published, name it: it is evidence the Steward can weigh. " +
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

/**
 * A Steward's judgment about a source at the top of a claim's provenance
 * (#507): where the claim's story begins, or a top node nobody has followed
 * upstream yet. Overrides what the source's kind alone would suggest.
 */
export const PROVENANCE_ROOT_STATUSES = ["origin", "untraced"] as const;

export const provenanceRootStatusEnum = z.enum(PROVENANCE_ROOT_STATUSES);

export const PROVENANCE_ROOT_GUIDANCE =
  "'origin': the claim's story begins here, as far as it can be followed: " +
  "the first record of a remark, the release that published a figure, the " +
  "treaty text. Say what you looked for upstream and why there is nothing " +
  "further. 'untraced': this source looks like a beginning but is not known " +
  "to be one, as when a document filed as a transcript is a summary of an " +
  "unseen original.";

/**
 * Source kinds that are, by their nature, first records rather than reports
 * of one (#507). A source of one of these kinds with no upstream edge reads
 * as an origin without a Steward's say-so; any other source with none reads
 * as untraced. A derivation, never a verdict: the Steward's root row
 * overrides it either way.
 */
export const PRIMARY_SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  "dataset",
  "official_statistics",
  "transcript",
  "treaty",
  "court_record",
  "legislation",
]);

/**
 * What can happen to a document after publication (#507). Recorded by the
 * watchers as dated facts, never as a judgment; Crossref's
 * expression-of-concern notices keep their own kind because a concern is
 * neither a correction nor a retraction and a reader should see which.
 */
export const SOURCE_EVENT_KINDS = [
  "correction",
  "retraction",
  "expression_of_concern",
  "update",
  "removal",
] as const;

export type SourceEventKind = (typeof SOURCE_EVENT_KINDS)[number];

/**
 * The parts a document is divided into on its source page (#507): sections
 * (by heading) holding passages, tables, notes, and references.
 */
export const SOURCE_SEGMENT_KINDS = ["section", "passage", "table", "note", "reference"] as const;

export type SourceSegmentKind = (typeof SOURCE_SEGMENT_KINDS)[number];

/** What an examination is for (#507): a claim's assessment, or the document itself. */
export const EXAMINATION_SCOPES = ["claim", "document"] as const;
/**
 * Who decided to spend on an examination: a Steward on its claim, whoever
 * funded a request bearing on the document (#865), or, before #602, a
 * mandate. `mechanical` has never been written.
 */
export const EXAMINATION_TRIGGERS = ["claim", "request", "mechanical", "mandate"] as const;

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
