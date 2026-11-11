/**
 * submit_contribution for a live mandate's Grantmaker (constitution §19, Part
 * VIII: a mandate's agents write nothing to the graph directly, and like
 * anyone may contribute through the Contribution Reviewer, paying for the
 * review). Offered in the live-mandate chat and on review passes, where the
 * mandate has an escrow to pay reviews from; the granting conversation and
 * the planning pass spend nothing.
 *
 * Null-delegate convention: `execute` returns null for any other tool name.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  GRANTMAKER_CONTRIBUTION_TYPES,
  submitGrantContribution,
} from "../../services/contribution-service.js";

type Tool = Anthropic.Tool;

export const GRANT_CONTRIBUTION_TOOL_NAME = "submit_contribution";

export function getGrantContributionToolDefinition(): Tool {
  return {
    name: GRANT_CONTRIBUTION_TOOL_NAME,
    description:
      "Contribute to the graph under this mandate: evidence for or against a " +
      "node, an instance or an estimate from a source, an argument, an " +
      "answer to a question, a request, a structural proposal (two nodes " +
      "that are one, one node that is two, a better canonical wording), or " +
      "a claim, question or quantity the graph does not hold yet. It is reviewed like anyone's and shown as from " +
      "\"a funded mandate\"; the review is paid from the escrow (cost_sheet " +
      "lists what one costs), and the node's Steward decides what an " +
      "accepted contribution changes. A proposed claim, question or quantity " +
      "enters through the Matcher, which settles its kind and wording and " +
      "lands it on an existing node if one already says it; once it is a " +
      "node, plan passes on it as on any other. To plan passes on it now, " +
      "before it is reviewed, put it in the plan as a propose item instead: " +
      "that files this same contribution, once, and the items that name its " +
      "ref bind to the node it becomes.",
    input_schema: {
      type: "object" as const,
      properties: {
        contribution_type: { type: "string", enum: [...GRANTMAKER_CONTRIBUTION_TYPES] },
        claim_id: {
          type: "string",
          description:
            "The node it bears on. Omit for propose_claim, propose_question and propose_quantity, and for a " +
            "propose_request that bears on several nodes, on sources, or on something the " +
            "graph does not hold yet (say what in content).",
        },
        proposed_text: {
          type: "string",
          maxLength: 2000,
          description:
            "propose_claim, propose_question, propose_quantity and propose_edit only: the wording " +
            "you propose, neutral, presupposing no more than it must. A quantity's wording says " +
            "what is measured, in which population and under which conditions, and in what unit.",
        },
        merge_target_claim_id: {
          type: "string",
          description: "propose_merge only: the other node, which claim_id's node duplicates.",
        },
        argument_id: {
          type: "string",
          description:
            "One of the node's arguments, when the contribution is about it: add_instance (a source that makes, " +
            "attacks or mentions the argument), propose_split (it carries several lines of reasoning), or " +
            "propose_merge with merge_target_argument_id (two arguments on the node are one).",
        },
        merge_target_argument_id: {
          type: "string",
          description: "propose_merge of two arguments on the node: the other argument.",
        },
        content: {
          type: "string",
          description:
            "For the Reviewer and, once it is accepted, the node's Steward, who " +
            "receives it as filed with the evidence: what you found and what it " +
            "rests on, with locators. For propose_claim, propose_question and propose_quantity, why the " +
            "graph needs the node: that stays on the mandate's public record of " +
            "the contribution and never enters the graph or reaches the Steward " +
            "(the Reviewer judges the wording alone). An argument for the node, " +
            "once it exists, is a contribution of its own.",
        },
        evidence_urls: { type: "array", items: { type: "string" } },
      },
      required: ["contribution_type", "content"],
      additionalProperties: false,
    },
  };
}

export function createGrantContributionTools(grantId: string): {
  definitions: Tool[];
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
} {
  return {
    definitions: [getGrantContributionToolDefinition()],
    async execute(name, input) {
      if (name !== GRANT_CONTRIBUTION_TOOL_NAME) return null;
      try {
        return JSON.stringify(await submitGrantContribution({ grantId, input }));
      } catch (err) {
        return JSON.stringify({
          success: false,
          message: `The contribution was not submitted (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    },
  };
}
