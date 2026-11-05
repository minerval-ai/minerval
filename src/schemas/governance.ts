import { z } from "zod";
import {
  uuidSchema,
  paginationSchema,
  contributionTypeEnum,
  anyContributionTypeEnum,
} from "./common.js";

// ---- Request schemas ----

// The acting contributor is derived from the authenticated API key (issue #10),
// never from the request body. The optional display name is only used when the
// contributor record is first created.
export const createContributionBody = z.object({
  claim_id: uuidSchema,
  contributor_display_name: z.string().min(1).optional(),
  contribution_type: contributionTypeEnum,
  content: z.string().min(1).max(10000),
  evidence_urls: z.array(z.string().url()).optional(),
  merge_target_claim_id: uuidSchema.optional(),
  proposed_canonical_form: z.string().max(2000).optional(),
  // answer_request only: the request the material is offered for (#723).
  request_id: uuidSchema.optional(),
});

/**
 * Where a contribution's review stands. `human_review` is an arbitration
 * held for a person; `checking` is a prize filing under the Lean checker.
 */
export const CONTRIBUTION_REVIEW_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "escalated",
  "human_review",
  "checking",
] as const;

export const listContributionsParams = paginationSchema.extend({
  claim_id: uuidSchema.optional(),
  status: z.enum(CONTRIBUTION_REVIEW_STATUSES).optional(),
  type: anyContributionTypeEnum.optional(),
  // Only the caller's own contributions (#723); needs credentials.
  mine: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(),
});

export const createAppealBody = z.object({
  contribution_id: uuidSchema,
  contributor_display_name: z.string().min(1).optional(),
  appeal_reasoning: z.string().min(1).max(10000),
});

// ---- Response helpers ----

export const contributionResponse = z.object({
  id: uuidSchema,
  // Null while an intake contribution (propose_claim / propose_source) is
  // pending; set to the materialized or matched claim on acceptance (#157).
  claim_id: uuidSchema.nullable(),
  contributor_id: uuidSchema,
  contribution_type: z.string(),
  content: z.string(),
  evidence_urls: z.array(z.string()),
  submitted_at: z.string(),
  review_status: z.string(),
  merge_target_claim_id: uuidSchema.nullable(),
  proposed_canonical_form: z.string().nullable(),
});

export const reviewResponse = z.object({
  id: uuidSchema,
  decision: z.string(),
  reasoning: z.string(),
  confidence: z.number(),
  policy_citations: z.array(z.string()),
  reviewed_at: z.string(),
  reviewed_by: z.string(),
});

export const appealResponse = z.object({
  id: uuidSchema,
  contribution_id: uuidSchema,
  original_review_id: uuidSchema,
  appellant_id: uuidSchema,
  appeal_reasoning: z.string(),
  submitted_at: z.string(),
  status: z.string(),
});

export const arbitrationResponse = z.object({
  id: uuidSchema,
  contribution_id: uuidSchema,
  appeal_id: uuidSchema.nullable(),
  outcome: z.string(),
  decision: z.string(),
  reasoning: z.string(),
  consensus_achieved: z.boolean().nullable(),
  human_review_recommended: z.boolean(),
  arbitrated_at: z.string(),
  arbitrated_by: z.string(),
});
