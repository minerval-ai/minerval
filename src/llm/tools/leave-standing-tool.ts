/**
 * leave_judgment_standing: the Steward's other outcome on a node at a label
 * it reads (services/left-standing-service.ts; label-note.ts, "A judgment
 * at each label").
 *
 * A Steward at a label records its own judgment of such a node or leaves
 * the one it reads standing. This is how it does the second. It is offered
 * only on a deployment with more than one label: on the public graph a node
 * carries one judgment and the tool does not exist.
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";
import { leaveJudgmentStanding } from "../../services/left-standing-service.js";
import { ownershipRefusal } from "./steward-ownership.js";

export const LEAVE_STANDING_TOOL_NAME = "leave_judgment_standing";

export function getLeaveStandingToolDefinition(): Tool {
  return {
    name: LEAVE_STANDING_TOOL_NAME,
    description:
      "On a node that carries another label than this run's: leave the judgment you read there standing for " +
      "readers at this run's label, and record no judgment of your own. The node's page then shows readers at " +
      "this run's label that it was examined at their label on this date and left standing, with your " +
      "reasoning. If this run's label has a judgment of the node, that judgment is retired and stays in the " +
      "node's history. A judgment recorded at this run's label later takes this record's place. When the " +
      "judgment left standing is replaced, a reassessment at this run's label is opened, which runs when it " +
      "is funded. It is refused where this run's label has a judgment of the node and the node's page at " +
      "this label is under a standing showing, because the readers that page is shown to would be left " +
      "with a page whose judgment had been withdrawn and nothing to tell them so; there, record your " +
      "judgment as it now stands.",
    input_schema: {
      type: "object",
      properties: {
        claim_id: { type: "string", description: "The UUID of the node" },
        reasoning: {
          type: "string",
          description: "What you looked at and why you leave the judgment standing. Readers at this run's label are shown it.",
        },
      },
      required: ["claim_id", "reasoning"],
    },
  };
}

/** Returns null for any other tool. */
export async function executeLeaveStandingTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name !== LEAVE_STANDING_TOOL_NAME) return null;
  const claimId = typeof input.claim_id === "string" ? input.claim_id.trim() : "";
  if (!claimId) return JSON.stringify({ success: false, message: "claim_id is required." });
  const notOwn = await ownershipRefusal(name, input);
  if (notOwn) return notOwn;
  try {
    return JSON.stringify(await leaveJudgmentStanding(claimId, typeof input.reasoning === "string" ? input.reasoning : ""));
  } catch (err) {
    return JSON.stringify({ success: false, message: `Not recorded: ${err instanceof Error ? err.message : String(err)}` });
  }
}
