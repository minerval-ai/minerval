/**
 * Action tools for the Curator — the graph-level agent that owns the connective
 * tissue between claims (constitution Part VIII; merges and splits per §5).
 *
 * Two kinds of action:
 *  - **Re-individuation surgery** (merge/split): the Curator mutates nodes, edges,
 *    and instances directly via the reconciliation service. That IS the operation.
 *    Every surgery ends by handing the affected claims to their Stewards.
 *  - **Steady-state suggestions**: a routine decomposition edge into a claim is
 *    owned by that claim's Steward, so the Curator never writes it directly — it
 *    enqueues the parent's Steward to adopt it.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  mergeClaims,
  createClaim,
  addRelationshipEdge,
  removeRelationshipEdge,
  reassignInstance,
  linkClaims,
  unlinkClaims,
} from "../../services/reconciliation-service.js";
import { isClaimLinkKind } from "../../services/claim-link-service.js";
import { enqueueSteward } from "../../services/queue-service.js";
import {
  RELATION_TYPES,
  RELATION_GUIDANCE,
  CLAIM_LINK_KINDS,
  CLAIM_LINK_GUIDANCE,
} from "../../schemas/common.js";

const RELATION_ENUM = RELATION_TYPES;

export function getCuratorToolDefinitions(): Tool[] {
  return [
    {
      name: "merge_claims",
      description:
        "Merge two claims that are the same proposition into one (a duplicate the " +
        "Matcher missed, or a counterpart). Moves the loser's instances, arguments, " +
        "and edges onto the survivor and marks the loser a merged alias. Set " +
        "stance_relation='opposed' when the loser is the survivor's negation/" +
        "counterpart; moved instance/argument stances are then flipped. After " +
        "merging, notify the survivor's Steward to reconcile wording/arguments and " +
        "re-assess.",
      input_schema: {
        type: "object" as const,
        properties: {
          survivor_id: { type: "string", description: "The claim that remains" },
          loser_id: { type: "string", description: "The claim merged into the survivor" },
          stance_relation: {
            type: "string",
            enum: ["same", "opposed"],
            description:
              "'same' if both state the proposition the same way; 'opposed' if the " +
              "loser is the survivor's negation/counterpart (flips moved stances)",
          },
          reasoning: { type: "string", description: "Why these are one claim" },
        },
        required: ["survivor_id", "loser_id", "stance_relation", "reasoning"],
      },
    },
    {
      name: "create_claim",
      description:
        "Create a new claim node (embedded immediately). Use when splitting a " +
        "conflated claim into a fresh one. Match first if you suspect it exists.",
      input_schema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Canonical text of the new claim" },
          claim_type: {
            type: "string",
            description: "Claim type (optional; defaults to empirical_derived)",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "add_relationship_edge",
      description:
        "Add an edge between two existing claims as part of a merge/split surgery. " +
        "For steady-state suggestions into a claim you are not reconciling, use " +
        "suggest_edge_to_steward instead: routine edges are the parent Steward's.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "Parent claim UUID" },
          child_id: { type: "string", description: "Child (subclaim) UUID" },
          relation: { type: "string", enum: [...RELATION_ENUM], description: RELATION_GUIDANCE },
          reasoning: { type: "string", description: "Why this edge holds" },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "remove_relationship_edge",
      description:
        "Remove an edge between two claims (one relation type, or all). Used when " +
        "redistributing edges during a split.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "Parent claim UUID" },
          child_id: { type: "string", description: "Child claim UUID" },
          relation: {
            type: "string",
            enum: [...RELATION_ENUM],
            description: "Specific relation type to remove (omit to remove all)",
          },
        },
        required: ["parent_id", "child_id"],
      },
    },
    {
      name: "reassign_instance",
      description:
        "Move a source instance from its current claim to another. Used when " +
        "redistributing instances across the two claims of a split.",
      input_schema: {
        type: "object" as const,
        properties: {
          instance_id: { type: "string", description: "The instance UUID to move" },
          to_claim_id: { type: "string", description: "The claim to move it to" },
        },
        required: ["instance_id", "to_claim_id"],
      },
    },
    {
      name: "link_claims",
      description:
        "Record a lateral link between two claims that are neither premise nor " +
        "conclusion of each other (§19): rival explanations, two halves of one " +
        "position, or two formulations kept apart because their identity was " +
        "unclear (§5). Symmetric and non-evaluative: it renders as a see-also on " +
        "both claim pages and never enters propagation or assessment. Connective " +
        "tissue between claims is yours, so this is a direct write, logged and " +
        "reversible. Do NOT use it for a dependency; that is the Steward's edge " +
        "(suggest_edge_to_steward).",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "One claim's UUID" },
          other_claim_id: { type: "string", description: "The other claim's UUID" },
          kind: {
            type: "string",
            enum: [...CLAIM_LINK_KINDS],
            description: CLAIM_LINK_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why a reader of either claim would want the other",
          },
        },
        required: ["claim_id", "other_claim_id", "kind", "reasoning"],
      },
    },
    {
      name: "unlink_claims",
      description:
        "Remove a lateral link recorded with link_claims (all kinds between the " +
        "pair unless one is given). Logged and reversible.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "One claim's UUID" },
          other_claim_id: { type: "string", description: "The other claim's UUID" },
          kind: {
            type: "string",
            enum: [...CLAIM_LINK_KINDS],
            description: "Only this kind of link; omit to remove every link between the pair",
          },
          reasoning: { type: "string", description: "Why the link does not hold" },
        },
        required: ["claim_id", "other_claim_id", "reasoning"],
      },
    },
    {
      name: "suggest_edge_to_steward",
      description:
        "Propose a structural edge into a claim you are NOT reconciling: routine " +
        "decomposition edges are owned by the parent claim's Steward. This enqueues " +
        "the parent's Steward to consider adopting the edge; it does not write it.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "The claim that would gain the subclaim" },
          child_id: { type: "string", description: "The existing claim to suggest as a subclaim" },
          relation: { type: "string", enum: [...RELATION_ENUM], description: `Suggested relationship type. ${RELATION_GUIDANCE}` },
          reasoning: { type: "string", description: "Why this dependency likely holds" },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "notify_steward",
      description:
        "Hand a claim to its Steward after surgery, with instructions (e.g. 'I " +
        "merged X into you, reconcile the flipped arguments and re-assess', or 'you " +
        "were split from Y, re-derive your decomposition'). Always do this after a " +
        "merge or split.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The claim whose Steward to notify" },
          instructions: { type: "string", description: "What the Steward should do" },
        },
        required: ["claim_id", "instructions"],
      },
    },
  ];
}

export async function executeCuratorTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "merge_claims": {
        // Strict on purpose (#182): 'opposed' flips every moved stance, so a
        // hedged or misspelled value silently coerced to 'same' would corrupt
        // all of them. Reject and make the model restate its intent exactly.
        const stanceRelation = input.stance_relation;
        if (stanceRelation !== "same" && stanceRelation !== "opposed") {
          return JSON.stringify({
            success: false,
            message:
              `Invalid stance_relation ${JSON.stringify(stanceRelation)}: must be ` +
              `exactly "same" or "opposed". Nothing was merged; re-call with a ` +
              `legal value.`,
          });
        }
        const result = await mergeClaims({
          survivorId: String(input.survivor_id),
          loserId: String(input.loser_id),
          stanceRelation,
          reasoning: String(input.reasoning ?? ""),
        });
        return JSON.stringify({
          success: true,
          message: `Merged ${result.loserId} into ${result.survivorId}. Now notify the survivor's Steward to reconcile and re-assess.`,
          survivor_id: result.survivorId,
        });
      }

      case "create_claim": {
        const { id } = await createClaim({
          text: String(input.text),
          claimType: input.claim_type ? String(input.claim_type) : undefined,
        });
        return JSON.stringify({ success: true, claim_id: id });
      }

      case "add_relationship_edge": {
        const { added } = await addRelationshipEdge({
          parentId: String(input.parent_id),
          childId: String(input.child_id),
          relationType: String(input.relation),
          reasoning: String(input.reasoning ?? ""),
        });
        return JSON.stringify({
          success: true,
          added,
          message: added ? "Edge added." : "Edge already existed or was a self-edge.",
        });
      }

      case "remove_relationship_edge": {
        const { removed } = await removeRelationshipEdge({
          parentId: String(input.parent_id),
          childId: String(input.child_id),
          relationType: input.relation ? String(input.relation) : undefined,
        });
        return JSON.stringify({ success: true, removed });
      }

      case "reassign_instance": {
        const { reassigned } = await reassignInstance({
          instanceId: String(input.instance_id),
          toClaimId: String(input.to_claim_id),
        });
        return JSON.stringify({ success: reassigned, reassigned });
      }

      case "link_claims": {
        const kind = String(input.kind ?? "").toLowerCase();
        if (!isClaimLinkKind(kind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown link kind "${kind}". Use one of: ${CLAIM_LINK_KINDS.join(", ")}.`,
          });
        }
        const claimId = String(input.claim_id);
        const otherClaimId = String(input.other_claim_id);
        if (claimId === otherClaimId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be linked to itself.",
          });
        }
        const { linked, linkId } = await linkClaims({
          claimId,
          otherClaimId,
          kind,
          reasoning: String(input.reasoning ?? ""),
          createdBy: "curator",
        });
        return JSON.stringify({
          success: true,
          linked,
          link_id: linkId,
          message: linked
            ? `Linked ${claimId} <-> ${otherClaimId} (${kind}).`
            : `A ${kind} link between these claims already existed; nothing was written.`,
        });
      }

      case "unlink_claims": {
        const kind =
          input.kind === undefined ? undefined : String(input.kind).toLowerCase();
        if (kind !== undefined && !isClaimLinkKind(kind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown link kind "${kind}". Use one of: ${CLAIM_LINK_KINDS.join(", ")}.`,
          });
        }
        const { removed } = await unlinkClaims({
          claimId: String(input.claim_id),
          otherClaimId: String(input.other_claim_id),
          kind,
          reasoning: String(input.reasoning ?? ""),
        });
        return JSON.stringify({ success: true, removed });
      }

      case "suggest_edge_to_steward": {
        const parentId = String(input.parent_id);
        await enqueueSteward({
          claimId: parentId,
          trigger: "curator_change",
          context:
            `The Curator suggests adding claim ${String(input.child_id)} as a ` +
            `subclaim (${String(input.relation)}): ${String(input.reasoning ?? "")}. ` +
            `If apt, attach it with add_relationship_edge.`,
        });
        return JSON.stringify({
          success: true,
          message: `Suggested edge to the Steward of ${parentId}.`,
        });
      }

      case "notify_steward": {
        const claimId = String(input.claim_id);
        await enqueueSteward({
          claimId,
          trigger: "curator_change",
          context: String(input.instructions ?? ""),
        });
        return JSON.stringify({
          success: true,
          message: `Notified the Steward of ${claimId}.`,
        });
      }

      default:
        return `Error: Unknown curator tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
