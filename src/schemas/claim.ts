import { z } from "zod";
import {
  uuidSchema,
  claimTypeEnum,
  claimStateEnum,
  assessmentStatusEnum,
  informationDepthEnum,
  stanceEnum,
} from "./common.js";

// ---- Request schemas ----

export const assessedFilterEnum = z.enum(["all", "assessed", "unassessed"]);

export const claimSearchParams = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  min_similarity: z.coerce.number().min(0).max(1).default(0.3),
  assessed: assessedFilterEnum.default("all"),
  min_importance: z.coerce.number().min(0).max(1).default(0),
});

// Browse-feed filters share the assessment/importance levers with search.
export const claimListParams = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
  state: z.string().optional(),
  assessed: assessedFilterEnum.default("all"),
  min_importance: z.coerce.number().min(0).max(1).default(0),
});

export const claimGetParams = z.object({
  information_depth: informationDepthEnum.default("standard"),
  // Optional cap on how deep the decomposition tree is fetched (default 10).
  // The claim map renders three rings per view, so it asks for less. The real
  // cost bound is the node cap (MAX_TREE_NODES), not depth: a level-at-a-time
  // walk stops as soon as a tree runs out, so a high cap only costs on trees
  // that are genuinely that deep. Real claims already exceed a depth of 5.
  depth: z.coerce.number().int().min(1).max(20).optional(),
});

// GET /claims/:id/dependents (issue #102) — reverse decomposition edges,
// paginated because hub claims can have hundreds of dependents while consumers
// typically show a handful plus a count.
export const claimDependentsParams = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  // How many edges to walk upward. 1 (the default) is the direct dependents,
  // served by the paginated SQL query. Above 1 walks transitively, which is
  // what answers "what is load-bearing here" — a claim's weight often sits two
  // edges up, in a dependent of a dependent.
  depth: z.coerce.number().int().min(1).max(8).default(1),
});

export const claimProposeBody = z.object({
  claim: z.string().min(1).max(2000),
  argument: z.string().min(1).max(5000),
});

export const claimPatchBody = z.object({
  argument: z.object({
    stance: stanceEnum,
    content: z.string().min(1).max(5000),
    evidence_urls: z.array(z.string().url()).optional(),
  }),
});

// ---- Response schemas ----

export const claimResponse = z.object({
  id: uuidSchema,
  text: z.string(),
  claim_type: claimTypeEnum,
  state: claimStateEnum,
  decomposition_status: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const assessmentResponse = z.object({
  id: uuidSchema,
  status: assessmentStatusEnum,
  // Verdict confidence — how sure the Steward is of the status, not P(true).
  confidence: z.number(),
  // Credence that the claim is true; null where one number would be false
  // precision (constitution §7). Optional so pre-deploy responses still parse.
  claim_credence: z.number().nullable().optional(),
  summary: z.string(),
  reasoning_trace: z.string(),
  subclaim_summary: z.record(z.unknown()),
  assessed_at: z.string(),
});

export const searchResultItem = z.object({
  id: uuidSchema,
  text: z.string(),
  claim_type: z.string(),
  state: z.string(),
  similarity_score: z.number(),
  assessment_status: assessmentStatusEnum.nullable(),
  assessment_confidence: z.number().nullable(),
});

export const searchResponse = z.object({
  results: z.array(searchResultItem),
  total: z.number(),
});

export const treeNodeResponse: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: uuidSchema,
    text: z.string(),
    claim_type: z.string(),
    state: z.string(),
    depth: z.number(),
    relation_type: z.string().nullable(),
    reasoning: z.string().nullable(),
    confidence: z.number().nullable(),
    assessment_status: assessmentStatusEnum.nullable(),
    assessment_confidence: z.number().nullable(),
    // Credence that the node's claim is true (#238); null where the Steward
    // stated none (constitution §10: the omission is itself information).
    // Optional so pre-deploy responses still parse.
    assessment_credence: z.number().nullable().optional(),
    // Steward-seeded prior credence (#285): the parent claim's Steward's
    // preliminary probability the claim is true, recorded when the subclaim
    // was minted. Present only while the node has NO current assessment (the
    // node still reads as unassessed); a hint for scan surfaces, not a verdict.
    seed_credence: z.number().nullable().optional(),
    argument_id: uuidSchema.nullable(),
    argument_name: z.string().nullable(),
    argument_stance: stanceEnum.nullable(),
    // The argument's written form (issue #129): brief prose with inline
    // [[claim:<uuid>]] references, stating how the grouped subclaims combine.
    argument_content: z.string().nullable(),
    // The steward's current evaluation of the argument (issue #173): whether
    // the inference goes through granting its premises (verdict: holds |
    // holds_with_caveats | fails | contested) and which premises bear the
    // weight (prose with inline [[claim:<uuid>]] references). Null until the
    // steward has evaluated the argument.
    argument_verdict: z.string().nullable(),
    argument_evaluation: z.string().nullable(),
    children: z.array(treeNodeResponse),
    // Set (true) only on a repeated occurrence of a shared subclaim: the graph
    // is a DAG, and the node's children are rendered at its first occurrence
    // in this response rather than duplicated here.
    subtree_collapsed: z.boolean().optional(),
    // Set (true) only when the response's node cap dropped some of this
    // node's children — the tree is bounded, never silently complete-looking.
    children_truncated: z.boolean().optional(),
  })
);

export interface TreeNode {
  id: string;
  text: string;
  claim_type: string;
  state: string;
  depth: number;
  relation_type: string | null;
  reasoning: string | null;
  confidence: number | null;
  assessment_status: string | null;
  assessment_confidence: number | null;
  assessment_credence?: number | null;
  seed_credence?: number | null;
  argument_id: string | null;
  argument_name: string | null;
  argument_stance: string | null;
  argument_content: string | null;
  argument_verdict: string | null;
  argument_evaluation: string | null;
  children: TreeNode[];
  subtree_collapsed?: boolean;
  children_truncated?: boolean;
}

export const claimDetailResponse = z.object({
  claim: claimResponse,
  assessment: assessmentResponse.nullable(),
  subclaim_count: z.number(),
  // Steward-seeded prior (#285): served only while the claim has no current
  // assessment. `seeded_by` names the parent claim whose Steward wrote it, so
  // the UI can label the note preliminary and attribute it mechanically.
  seed: z
    .object({
      credence: z.number().nullable(),
      note: z.string().nullable(),
      seeded_by: z
        .object({ id: uuidSchema, text: z.string() })
        .nullable(),
    })
    .nullable()
    .optional(),
  tree: treeNodeResponse.optional(),
  arguments: z
    .array(
      z.object({
        id: uuidSchema,
        stance: stanceEnum,
        content: z.string(),
        evidence_urls: z.array(z.string()),
        created_by: z.string(),
        created_at: z.string(),
        // Steward evaluation of the inference (issue #173); null until judged.
        verdict: z.string().nullable().optional(),
        evaluation: z.string().nullable().optional(),
      })
    )
    .optional(),
  instances: z
    .array(
      z.object({
        id: uuidSchema,
        source_id: uuidSchema,
        original_text: z.string(),
        context: z.string().nullable(),
        confidence: z.number(),
        source_title: z.string(),
        source_url: z.string().nullable(),
      })
    )
    .optional(),
});

// ---- Assessment history / trajectory schemas ----

export const assessmentHistoryParams = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export const assessmentHistoryItem = z.object({
  id: uuidSchema,
  claim_id: uuidSchema,
  status: assessmentStatusEnum,
  confidence: z.number(),
  claim_credence: z.number().nullable().optional(),
  summary: z.string(),
  reasoning_trace: z.string(),
  is_current: z.boolean(),
  subclaim_summary: z.record(z.unknown()),
  trigger: z.string().nullable(),
  trigger_context: z.string().nullable(),
  assessed_at: z.string(),
});

export const assessmentHistoryResponse = z.object({
  assessments: z.array(assessmentHistoryItem),
  total: z.number(),
});

export const trajectoryPoint = z.object({
  status: assessmentStatusEnum,
  confidence: z.number(),
  assessed_at: z.string(),
  is_current: z.boolean(),
  trigger: z.string().nullable(),
});

export const assessmentTrajectoryResponse = z.object({
  current: trajectoryPoint.nullable(),
  history: z.array(trajectoryPoint),
  total_assessments: z.number(),
  status_transitions: z.number(),
});

// ---- Unified claim event log (issue #175) ----

// The window is generous because the page renders the whole record at once;
// heavily contested claims are exactly the ones whose history matters most.
export const claimEventsParams = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const claimProposeResponse = z.object({
  claim: claimResponse,
  argument: z.object({
    id: uuidSchema,
    stance: stanceEnum,
    content: z.string(),
    created_by: z.string(),
    created_at: z.string(),
  }),
  job_id: uuidSchema,
});
