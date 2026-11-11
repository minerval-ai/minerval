import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { findSimilarClaims } from "../../services/search-service.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { rawQuery } from "../../db/client.js";
import { resolveClaimId } from "../../services/claim-alias-service.js";

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

/**
 * Neighborhood reads for the Steward, Curator and extension agent. A node
 * itself is read with the one get_claim (#774); this family used to carry
 * get_claim_details and get_claim_subclaims, two more readers of the same
 * node under other names, and no longer does.
 */
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

    case "get_parent_claims": {
      // A merged id reads its survivor's parents (#884): the merge moved the
      // edges there, so the absorbed row has none to show.
      const resolution = await resolveClaimId(input.claim_id as string);
      const claimId = resolution?.id ?? (input.claim_id as string);
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
        data: {
          ...(resolution?.resolvedFrom ? { resolved_from: resolution.resolvedFrom } : {}),
          child_claim_id: claimId,
          parents: rows,
          count: rows.length,
        },
      };
    }

    default:
      return { success: false, data: null, error: `Unknown tool: ${toolName}` };
  }
}
