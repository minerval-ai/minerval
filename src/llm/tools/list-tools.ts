/**
 * The tools of a list's Steward (constitution §7b, #845): keep the
 * specification clear, put nodes on the list and take them off, and judge
 * the list's fidelity. Each acts on the run's own node and takes no node id
 * for the list, so a Steward cannot write to another node's list (Part
 * VIII, "Working Together").
 *
 * artifact-service.ts holds the invariants; these tools turn a model's call
 * into a service call and a refusal into a message it can act on.
 * `executeListTool` returns null for a name it does not own.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import { refusalForCaller } from "../../db/clearance.js";
import { rawQuery } from "../../db/client.js";
import {
  addListEntry,
  recordListAssessment,
  removeListEntry,
  restateListSpec,
} from "../../services/artifact-service.js";
import { mergedAliasRefusal } from "../../services/claim-alias-service.js";
import { mirroredRefusalForAgent } from "../../services/mirrored-node-service.js";
import { KindError } from "../../services/node-kind.js";
import { ARTIFACT_FIDELITIES, TEXT_NODE_KINDS, type ArtifactFidelity, type LeftOut } from "../../schemas/kinds.js";
import { getUsageContext } from "../usage-context.js";
import { MARGINAL_YIELD_DESCRIPTION } from "./judgment-fields.js";

type Tool = Anthropic.Tool;

export const LIST_ASSESSMENT_TOOL = "update_list_assessment";

const SPEC_PROPERTIES = {
  purpose: {
    type: "string",
    description: "What the list is for: the question a reader brings to it, in a sentence.",
  },
  inclusion: {
    type: "string",
    description:
      "What qualifies an entry, stated so that a node can be checked against it and the same test " +
      "applies whichever way an entry points.",
  },
  exclusion: { type: "string", description: "What is ruled out even where it would otherwise qualify. Omit when nothing is." },
  ordering: {
    type: "string",
    description: "The stated basis of the order (date, size, importance by a named measure), never which way an entry points.",
  },
  entry_kinds: {
    type: "array",
    items: { type: "string", enum: [...TEXT_NODE_KINDS] },
    description: "Which kinds of node may be entries. Omit for any.",
  },
} as const;

export function getListToolDefinitions(): Tool[] {
  return [
    {
      name: "restate_list_spec",
      description:
        "Restate this list's specification in clearer words, keeping its criteria (§7b). The " +
        "specification is the list's identity: if the criteria themselves should change, that is " +
        "another list; say so with escalate_to_curator rather than change them here.",
      input_schema: {
        type: "object",
        properties: { ...SPEC_PROPERTIES, reasoning: { type: "string", description: "Why the new words state the same criteria better." } },
        required: ["purpose", "inclusion", "reasoning"],
      },
    },
    {
      name: "add_list_entry",
      description:
        "Put a node on this list, or change the note on one already there. The node must exist: " +
        "find it with match_claim or search_claims. The note says, against the inclusion criteria, " +
        "why it qualifies, and is shown beside it. An entry carries no weight as evidence; it is " +
        "on the list because it meets the criteria, whatever its verdict.",
      input_schema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "The claim, quantity or question to put on the list." },
          note: { type: "string", description: "Why it meets the criteria, in a sentence a reader can check." },
        },
        required: ["node_id", "note"],
      },
    },
    {
      name: "remove_list_entry",
      description:
        "Take a node off this list. Say why in reason; when it was considered and does not qualify, " +
        "name it in left_out on your next update_list_assessment too, so the reader sees it.",
      input_schema: {
        type: "object",
        properties: {
          node_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["node_id", "reason"],
      },
    },
    {
      name: LIST_ASSESSMENT_TOOL,
      description:
        "Record this list's judgment: how far it can be relied on under its specification (§7b). " +
        "fidelity is one of: faithful (every entry meets the criteria and is presented accurately, " +
        "every node the graph holds that meets them is on it or accounted for in left_out, and the " +
        "order and notes present the entries fairly); incomplete (qualifying entries are known to be " +
        "missing: say which in gaps); misleading (the selection, order or framing would lead a reader " +
        "to a conclusion the entries do not support, and you cannot yet repair it); ill_specified (the " +
        "criteria cannot be checked against, or quietly assert something contested). Also records the " +
        "order the entries are shown in and the nodes considered and left out, each with why.",
      input_schema: {
        type: "object",
        properties: {
          fidelity: { type: "string", enum: [...ARTIFACT_FIDELITIES] },
          assessment: {
            type: "string",
            description:
              "Reader-facing, shown first on the list's page: how faithful the list is and what a reader " +
              "should know before relying on it. Link nodes as [[claim:<uuid>|phrase]].",
          },
          reasoning_trace: { type: "string", description: "The audit record: how you searched, what you checked each entry against, what you left out and why." },
          gaps: { type: "string", description: "What you know is missing: qualifying nodes the graph does not hold, searches you could not make. Required when incomplete." },
          entry_order: {
            type: "array",
            items: { type: "string" },
            description: "The entries' ids in the order the list shows them, by the stated ordering. Entries you leave out of this follow, in the order they joined.",
          },
          left_out: {
            type: "array",
            items: {
              type: "object",
              properties: { node_id: { type: "string" }, reason: { type: "string" } },
              required: ["node_id", "reason"],
            },
            description: "Nodes you considered and did not put on the list, each with why, against the criteria.",
          },
          confidence: { type: "number", description: "How sure you are of the fidelity, 0..1." },
          marginal_yield: { type: "number", description: MARGINAL_YIELD_DESCRIPTION },
        },
        required: ["fidelity", "assessment", "reasoning_trace"],
      },
    },
  ];
}

export const LIST_TOOL_NAMES = new Set(getListToolDefinitions().map((t) => t.name));

/** Who is calling: the list's own Steward, on its own node. */
export interface ListToolContext {
  claimId: string;
  model?: string | null;
  trigger?: string | null;
  context?: string | null;
}

function ok(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, message, ...extra });
}
function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optStr = (v: unknown): string | undefined => str(v) || undefined;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function executeListTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ListToolContext
): Promise<string | null> {
  if (!LIST_TOOL_NAMES.has(name)) return null;
  try {
    return await executeListToolImpl(name, input, ctx);
  } catch (err) {
    if (err instanceof ZodError) return refuse(`Not recorded: ${err.issues.map((i) => i.message).join("; ")}.`);
    if (err instanceof KindError) return refuse(err.message);
    const refusal = mirroredRefusalForAgent(err) ?? refusalForCaller(err);
    if (refusal) return refuse(refusal);
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeListToolImpl(name: string, input: Record<string, unknown>, ctx: ListToolContext): Promise<string> {
  const listId = ctx.claimId;
  switch (name) {
    case "restate_list_spec": {
      if (!str(input.reasoning)) return refuse("Say why the new words state the same criteria.");
      await restateListSpec({
        claimId: listId,
        spec: {
          purpose: str(input.purpose),
          inclusion: str(input.inclusion),
          exclusion: optStr(input.exclusion) ?? null,
          ordering: optStr(input.ordering) ?? null,
          ...(Array.isArray(input.entry_kinds) ? { entry_kinds: input.entry_kinds as never } : {}),
        },
        createdBy: "artifact_steward",
      });
      return ok("Restated the list's specification. Log the change with log_stewardship_decision.");
    }
    case "add_list_entry": {
      const nodeId = str(input.node_id);
      const [node] = await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id::text = $1`, [nodeId]);
      if (!node || node.state !== "active") {
        return refuse((await mergedAliasRefusal(nodeId))?.message ?? `No active node ${nodeId}.`);
      }
      await addListEntry({ artifactId: listId, nodeId, note: str(input.note), createdBy: "artifact_steward" });
      return ok(`Node ${nodeId} is on the list.`);
    }
    case "remove_list_entry": {
      const nodeId = str(input.node_id);
      if (!str(input.reason)) return refuse("Say why the node comes off the list.");
      const removed = await removeListEntry({ artifactId: listId, nodeId });
      return removed
        ? ok(`Took node ${nodeId} off the list. Name it in left_out on your next ${LIST_ASSESSMENT_TOOL} if a reader should see why.`)
        : refuse(`Node ${nodeId} is not an entry of this list at this run's label.`);
    }
    case LIST_ASSESSMENT_TOOL: {
      const fidelity = str(input.fidelity) as ArtifactFidelity;
      const usage = getUsageContext();
      const { id } = await recordListAssessment({
        claimId: listId,
        fidelity,
        summary: optStr(input.assessment) ?? null,
        reasoningTrace: str(input.reasoning_trace),
        gaps: optStr(input.gaps) ?? null,
        entryOrder: Array.isArray(input.entry_order) ? input.entry_order.map(String) : [],
        leftOut: (Array.isArray(input.left_out) ? input.left_out : []) as LeftOut,
        confidence: num(input.confidence),
        marginalYield: num(input.marginal_yield),
        model: ctx.model ?? null,
        fundedByJobId: usage.jobId ?? null,
        trigger: ctx.trigger ?? null,
        triggerContext: ctx.context ?? null,
      });
      return ok(`Recorded the list's assessment: ${fidelity}.`, { assessment_id: id });
    }
    default:
      return refuse(`Unknown list tool ${name}.`);
  }
}
