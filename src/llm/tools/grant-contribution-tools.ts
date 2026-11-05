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
      "answer to a question, a request, or a claim or question the graph " +
      "does not hold yet. It is reviewed like anyone's and shown as from " +
      "\"a funded mandate\"; the review is paid from the escrow (cost_sheet " +
      "lists what one costs), and the node's Steward decides what an " +
      "accepted contribution changes. A proposed claim or question enters " +
      "through the Matcher, which lands it on an existing node if one " +
      "already says it; once it is a node, plan passes on it as on any other.",
    input_schema: {
      type: "object" as const,
      properties: {
        contribution_type: { type: "string", enum: [...GRANTMAKER_CONTRIBUTION_TYPES] },
        claim_id: {
          type: "string",
          description: "The node it bears on. Omit for propose_claim and propose_question.",
        },
        proposed_text: {
          type: "string",
          description:
            "propose_claim and propose_question only: the wording you propose, " +
            "neutral, presupposing no more than it must.",
        },
        content: {
          type: "string",
          description:
            "For the Reviewer and, once it is accepted, the node's Steward, who " +
            "receives it as filed with the evidence: what you found and what it " +
            "rests on, with locators. For propose_claim and propose_question, why the " +
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
