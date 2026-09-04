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
  // A proposition of mathematics (docs/mathematics.md §2.1): settled by
  // proof rather than observation, and the type the Mathematics skill
  // assigns; a formal statement and a prize can bind only to one of these.
  "mathematical",
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

export const reportStatusEnum = z.enum([
  "new",
  "triaged",
  "duplicate",
  "actioned",
  "wontfix",
]);
