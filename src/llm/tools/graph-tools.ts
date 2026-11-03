import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { findSimilarClaims } from "../../services/search-service.js";
import { getClaimById } from "../../services/claim-service.js";
import { getCurrentAssessment } from "../../services/assessment-service.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { rawQuery } from "../../db/client.js";

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

/**
 * The similarity floor for every search_similar_claims, here and in the
 * Matcher (#773). Low on purpose: a counterpart or a rival framing can embed
 * far from the claim it matches (#25), and the Curator, which catches what
 * the Matcher missed, must see at least what the Matcher sees. The floor only
 * trims noise; the agent's judgment decides.
 */
export const SIMILAR_CLAIMS_FLOOR = 0.4;

export function getGraphToolDefinitions(): Tool[] {
  return [
    {
      name: "search_similar_claims",
      description:
        "Search the knowledge graph for claims semantically similar to a " +
        "query. Use it to see the surrounding territory: related claims, " +
        "rival explanations, how live the neighborhood is. Returns up to " +
        `limit claims scoring at least ${SIMILAR_CLAIMS_FLOOR} in similarity, ` +
        "best first; that floor only trims noise, so a true counterpart can " +
        "score low, and fewer hits than limit means nothing else cleared it. " +
        "It is retrieval, not identity: candidate lists inform judgment about " +
        "whether a claim already exists, they never decide it.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "The claim text to search for",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results (default 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_claim_details",
      description:
        "Get detailed information about a specific claim: its text, type, " +
        "lifecycle state (active/merged/deprecated), and current assessment " +
        "(status, confidence, and the reasoning behind the verdict), when " +
        "the graph has judged it.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to retrieve",
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_claim_subclaims",
      description:
        "Get all direct subclaims of a claim. Returns the subclaims " +
        "and their relationships to the parent claim.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the parent claim",
          },
        },
        required: ["claim_id"],
      },
    },
    {
      name: "get_parent_claims",
      description:
        "Get all claims that have a given claim as a subclaim. " +
        "Useful for understanding how a claim fits into the graph.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the child claim",
          },
        },
        required: ["claim_id"],
      },
    },
  ];
}

export async function executeGraphTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    const result = await executeGraphToolInner(toolName, input);
    if (!result.success) return `Error: ${result.error}`;
    return JSON.stringify(result.data, null, 2);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeGraphToolInner(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "search_similar_claims": {
      const query = input.query as string;
      const limit = (input.limit as number) ?? 10;
      const embedding = await generateEmbedding(query);
      const results = await findSimilarClaims(embedding, {
        limit,
        minSimilarity: SIMILAR_CLAIMS_FLOOR,
      });
      return {
        success: true,
        data: { query, results, count: results.length },
      };
    }

    case "get_claim_details": {
      const claimId = input.claim_id as string;
      const [claim, assessment] = await Promise.all([
        getClaimById(claimId),
        getCurrentAssessment(claimId),
      ]);
      if (!claim) {
        return { success: false, data: null, error: `Claim not found: ${claimId}` };
      }
      return {
        success: true,
        data: {
          claim_id: claim.id,
          text: claim.text,
          claim_type: claim.claimType,
          // Named to keep the active/merged/deprecated lifecycle distinct
          // from the assessment's verdict status (#181).
          lifecycle_state: claim.state,
          decomposition_status: claim.decompositionStatus,
          created_at: claim.createdAt.toISOString(),
          assessment: assessment
            ? {
                status: assessment.status,
                confidence: assessment.confidence,
                // Reader-facing summary where one exists; assessments written
                // before the summary/trace split (#122) fall back to a
                // truncated audit trace.
                reasoning:
                  assessment.summary ??
                  assessment.reasoningTrace.slice(0, 1200),
              }
            : null,
        },
      };
    }

    case "get_claim_subclaims": {
      const claimId = input.claim_id as string;
      const rows = await rawQuery<{
        child_id: string;
        child_text: string;
        child_type: string;
        relation_type: string;
        reasoning: string;
        confidence: number;
      }>(
        `SELECT cr.child_claim_id AS child_id, c.text AS child_text,
                c.claim_type AS child_type, cr.relation_type, cr.reasoning, cr.confidence
         FROM claim_relationships cr
         JOIN claims c ON c.id = cr.child_claim_id
         WHERE cr.parent_claim_id = $1`,
        [claimId]
      );
      return {
        success: true,
        data: { parent_claim_id: claimId, subclaims: rows, count: rows.length },
      };
    }

    case "get_parent_claims": {
      const claimId = input.claim_id as string;
      const rows = await rawQuery<{
        parent_id: string;
        parent_text: string;
        parent_type: string;
        relation_type: string;
        reasoning: string;
      }>(
        `SELECT cr.parent_claim_id AS parent_id, c.text AS parent_text,
                c.claim_type AS parent_type, cr.relation_type, cr.reasoning
         FROM claim_relationships cr
         JOIN claims c ON c.id = cr.parent_claim_id
         WHERE cr.child_claim_id = $1`,
        [claimId]
      );
      return {
        success: true,
        data: { child_claim_id: claimId, parents: rows, count: rows.length },
      };
    }

    default:
      return { success: false, data: null, error: `Unknown tool: ${toolName}` };
  }
}
