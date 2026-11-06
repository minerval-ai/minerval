/**
 * Steward tools that correct structure the Steward already built (#741):
 * remove an edge, change its relation, take a subclaim out of an argument,
 * rename an argument or flip its stance, and retire an argument.
 *
 * The add-only tools in steward-tools.ts let a Steward build its node's
 * decomposition (Part VIII: it owns the node's structure), but a wrong edge
 * or a poor argument could never be undone, and re-adding an edge with
 * another relation made a second edge rather than retyping the first. Each
 * tool here acts only on the run's own node, and each writes an audit_log
 * row saying what it changed and why (§5: every operation is logged).
 *
 * executeStewardStructureTool returns null for a name it does not own, so
 * executeStewardTool can delegate to it.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { getDb, rawQuery, withTransaction } from "../../db/client.js";
import { auditLog } from "../../db/schema.js";
import { RELATION_TYPES, RELATION_GUIDANCE } from "../../schemas/common.js";
import {
  getArgument,
  retireArgument,
  reviseArgument,
} from "../../services/argument-service.js";
import {
  deleteEdges,
  detachEdgeFromArgument,
  getEdgesBetween,
  retypeEdge,
  setEdgeReasoning,
  type EdgeRecord,
} from "../../services/relationship-service.js";
import { notYourNode } from "./steward-ownership.js";

export const STEWARD_STRUCTURE_TOOL_NAMES = [
  "remove_subclaim_edge",
  "set_edge_relation",
  "ungroup_subclaim",
  "revise_argument",
  "retire_argument",
] as const;

/** The structure tools that act on arguments, which a question does not have (§7a). */
export const ARGUMENT_STRUCTURE_TOOL_NAMES = new Set(["ungroup_subclaim", "revise_argument", "retire_argument"]);

const NAMES = new Set<string>(STEWARD_STRUCTURE_TOOL_NAMES);

export function getStewardStructureToolDefinitions(): Tool[] {
  return [
    {
      name: "remove_subclaim_edge",
      description:
        "Remove an edge from your node's decomposition: a subclaim that turned out not to bear " +
        "on it, or an edge made by mistake. The edge leaves every argument it was grouped under; " +
        "the child node stays in the graph with its own Steward. When the dependency is real but " +
        "typed wrongly, use set_edge_relation instead, which keeps its argument groupings. To take " +
        "a node out of a question's answer set, use remove_answer. Logged with your reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "The UUID of the node you steward" },
          child_id: { type: "string", description: "The UUID of the subclaim to detach" },
          relation: {
            type: "string",
            description:
              "The relation of the edge to remove. Needed only when the child is joined to your " +
              "node by more than one edge.",
          },
          reasoning: { type: "string", description: "Why the edge does not belong" },
        },
        required: ["parent_id", "child_id", "reasoning"],
      },
    },
    {
      name: "set_edge_relation",
      description:
        "Change the relation of an edge in your node's decomposition, keeping the edge's argument " +
        "groupings. Calling add_relationship_edge with another relation would add a second edge " +
        "rather than correct the first. If an edge of the new relation already exists, the two " +
        "become one. Your reasoning becomes the edge's reasoning note, so pass the edge's current " +
        "relation to correct a note that misdescribes the subclaim while the relation stays right. " +
        "Logged with your reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "The UUID of the node you steward" },
          child_id: { type: "string", description: "The UUID of the subclaim" },
          relation: { type: "string", enum: [...RELATION_TYPES], description: RELATION_GUIDANCE },
          from_relation: {
            type: "string",
            description:
              "The edge's current relation. Needed only when the child is joined to your node by " +
              "more than one edge.",
          },
          reasoning: {
            type: "string",
            description:
              "Why the relation is the right one: how the subclaim bears on your node. It replaces " +
              "the edge's reasoning note.",
          },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "ungroup_subclaim",
      description:
        "Take a subclaim out of one of your node's arguments. The edge stays: the subclaim " +
        "remains in the claim's basis, or in any other argument it is grouped under. Rewrite the " +
        "argument's written form afterwards if it referenced the subclaim. To group a subclaim " +
        "under an argument, call add_relationship_edge with that argument_id. Logged with your " +
        "reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: { type: "string", description: "The UUID of the argument" },
          child_id: { type: "string", description: "The UUID of the subclaim to take out of it" },
          reasoning: { type: "string", description: "Why the subclaim is not part of this line of reasoning" },
        },
        required: ["argument_id", "child_id", "reasoning"],
      },
    },
    {
      name: "revise_argument",
      description:
        "Rename one of your node's arguments, or flip its stance when it was recorded on the wrong " +
        "side (an argument whose content is evidence against the claim, recorded as for). A flip " +
        "changes the argument's conclusion, so its current evaluation is retired: rewrite the " +
        "written form with write_argument if it reads the wrong way, and evaluate it again. An " +
        "argument about a quantity has no stance; revise what it shows with set_argument_shows. " +
        "Logged with your reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: { type: "string", description: "The UUID of the argument" },
          name: { type: "string", description: "A new name, by its reasoning, when the old one misdescribes it" },
          stance: {
            type: "string",
            enum: ["for", "against"],
            description: "The corrected stance: for when its conclusion is the claim, against when it is the denial",
          },
          reasoning: { type: "string", description: "Why the change is right" },
        },
        required: ["argument_id", "reasoning"],
      },
    },
    {
      name: "retire_argument",
      description:
        "Retire one of your node's arguments: a poor argument better left out (§7), one that " +
        "duplicates another, or one created by mistake. It is kept in history with your reason, " +
        "and leaves the page and the arguments get_claim lists. Its subclaims keep their edges and " +
        "return to the claim's basis, or stay in any other argument they are grouped under; remove " +
        "with remove_subclaim_edge any that no longer belong. Logged with your reasoning.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: { type: "string", description: "The UUID of the argument" },
          reasoning: { type: "string", description: "Why the argument should be left out; kept as its retirement reason" },
        },
        required: ["argument_id", "reasoning"],
      },
    },
  ];
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

async function logStructureChange(claimId: string, action: string, reasoning: string): Promise<void> {
  await getDb().insert(auditLog).values({ claimId, action, reasoning, createdBy: "claim_steward" });
}

/** "requires edge, grouped under 'the argument from X'" for an audit line. */
async function describeEdge(edge: EdgeRecord): Promise<string> {
  if (edge.argument_ids.length === 0) return `${edge.relation_type} edge, in the basis`;
  const names = await rawQuery<{ id: string; name: string | null }>(
    `SELECT id, name FROM arguments WHERE id = ANY($1::uuid[])`,
    [edge.argument_ids]
  );
  const label = names.map((n) => (n.name ? `"${n.name}"` : n.id)).join(", ");
  return `${edge.relation_type} edge, grouped under ${label}`;
}

/** The one edge a call means: by relation when given, else the only edge. */
function pickEdge(
  edges: EdgeRecord[],
  relation: string | null,
  parentId: string,
  childId: string,
  field: string
): EdgeRecord | string {
  if (edges.length === 0) {
    return refuse(`Node ${childId} is not a subclaim of ${parentId}; nothing to change.`);
  }
  if (relation) {
    const edge = edges.find((e) => e.relation_type === relation);
    return (
      edge ??
      refuse(
        `There is no ${relation} edge from ${parentId} to ${childId}. Its edges: ` +
          `${edges.map((e) => e.relation_type).join(", ")}.`
      )
    );
  }
  if (edges.length > 1) {
    return refuse(
      `${childId} is joined to ${parentId} by ${edges.length} edges ` +
        `(${edges.map((e) => e.relation_type).join(", ")}); pass ${field} to say which.`
    );
  }
  return edges[0]!;
}

async function liveArgument(
  argumentId: string
): Promise<{ id: string; claimId: string; name: string | null; stance: string } | string> {
  const argument = await getArgument(argumentId);
  if (!argument) return refuse(`Argument not found: ${argumentId}`);
  if (argument.retiredAt) {
    return refuse(`Argument ${argumentId} was retired (${argument.retiredReason ?? "no reason recorded"}).`);
  }
  const foreign = notYourNode(argument.claimId, `argument ${argumentId}`);
  if (foreign) return foreign;
  return argument;
}

export async function executeStewardStructureTool(
  name: string,
  input: Record<string, unknown>
): Promise<string | null> {
  if (!NAMES.has(name)) return null;
  const reasoning = String(input.reasoning ?? "").trim();
  if (!reasoning) return refuse("reasoning is required: say why, for the audit log.");

  switch (name) {
    case "remove_subclaim_edge": {
      const parentId = String(input.parent_id ?? "");
      const childId = String(input.child_id ?? "");
      const relation = input.relation ? String(input.relation).toLowerCase() : null;
      const foreign = notYourNode(parentId, "that edge");
      if (foreign) return foreign;
      if (relation === "answers") {
        return refuse("An answer leaves a question's answer set through remove_answer, which keeps the set's bookkeeping.");
      }
      const edges = await getEdgesBetween(parentId, childId);
      const edge = pickEdge(edges, relation, parentId, childId, "relation");
      if (typeof edge === "string") return edge;
      if (edge.relation_type === "answers") {
        return refuse("That edge makes the node a candidate answer; remove it with remove_answer.");
      }
      const described = await describeEdge(edge);
      await deleteEdges([edge.id]);
      await logStructureChange(
        parentId,
        "remove_subclaim_edge",
        `Removed the ${described}, to ${childId} (edge reasoning: "${edge.reasoning}"): ${reasoning}`
      );
      const [{ n } = { n: 0 }] = await rawQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM claim_relationships WHERE child_claim_id = $1`,
        [childId]
      );
      return JSON.stringify({
        success: true,
        message:
          `Removed the ${described}, from ${parentId} to ${childId}.` +
          (edge.argument_ids.length > 0
            ? ` Rewrite the written form of any argument that referenced it (write_argument).`
            : "") +
          (n === 0 ? ` ${childId} now has no parent; it stays in the graph as a node of its own.` : ""),
        removed_relationship_id: edge.id,
      });
    }

    case "set_edge_relation": {
      const parentId = String(input.parent_id ?? "");
      const childId = String(input.child_id ?? "");
      const relation = String(input.relation ?? "").toLowerCase();
      const fromRelation = input.from_relation ? String(input.from_relation).toLowerCase() : null;
      const foreign = notYourNode(parentId, "that edge");
      if (foreign) return foreign;
      if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
        return refuse(`Unknown relation "${relation}". Use one of: ${RELATION_TYPES.join(", ")}.`);
      }
      const edges = await getEdgesBetween(parentId, childId);
      const edge = pickEdge(edges, fromRelation, parentId, childId, "from_relation");
      if (typeof edge === "string") return edge;
      if (edge.relation_type === "answers" || edge.relation_type === "part_of") {
        return refuse(
          `A ${edge.relation_type} edge is part of a question's structure (§7a); it changes through ` +
            `the question tools, not by retyping.`
        );
      }
      if (edge.relation_type === relation) {
        // Same relation: the call corrects the edge's reasoning note (#833).
        if ((edge.reasoning ?? "").trim() === reasoning) {
          return JSON.stringify({
            success: true,
            message: `The edge is already ${relation} with that reasoning; nothing changed.`,
          });
        }
        await setEdgeReasoning(edge.id, reasoning);
        await logStructureChange(
          parentId,
          "set_edge_relation",
          `Rewrote the reasoning of the ${relation} edge to ${childId} (old edge reasoning: ` +
            `"${edge.reasoning}"): ${reasoning}`
        );
        return JSON.stringify({
          success: true,
          message:
            `The edge from ${parentId} to ${childId} stays ${relation}; its reasoning now reads your ` +
            `new note, with its argument groupings kept.`,
          relationship_id: edge.id,
        });
      }
      const result = await withTransaction((tx) => retypeEdge(edge.id, relation, reasoning, tx));
      await logStructureChange(
        parentId,
        "set_edge_relation",
        `Changed the edge to ${childId} from ${edge.relation_type} to ${relation}` +
          (result.merged ? ` (merged into the existing ${relation} edge)` : "") +
          ` (old edge reasoning: "${edge.reasoning}"): ${reasoning}`
      );
      return JSON.stringify({
        success: true,
        message:
          `The edge from ${parentId} to ${childId} is now ${relation}` +
          (result.merged
            ? `; it was merged into the ${relation} edge that already existed, with the argument groupings of both.`
            : `, with its argument groupings kept.`),
        relationship_id: result.id,
      });
    }

    case "ungroup_subclaim": {
      const argument = await liveArgument(String(input.argument_id ?? ""));
      if (typeof argument === "string") return argument;
      const childId = String(input.child_id ?? "");
      const edges = (await getEdgesBetween(argument.claimId, childId)).filter((e) =>
        e.argument_ids.includes(argument.id)
      );
      if (edges.length === 0) {
        return refuse(`${childId} is not grouped under argument "${argument.name ?? argument.id}".`);
      }
      await withTransaction(async (tx) => {
        for (const e of edges) await detachEdgeFromArgument(argument.id, e.id, tx);
      });
      await logStructureChange(
        argument.claimId,
        "ungroup_subclaim",
        `Took ${childId} out of argument "${argument.name ?? argument.id}": ${reasoning}`
      );
      return JSON.stringify({
        success: true,
        message:
          `Took ${childId} out of argument "${argument.name ?? argument.id}"; its edge stays. ` +
          `Rewrite the argument's written form if it referenced it (write_argument).`,
      });
    }

    case "revise_argument": {
      const argument = await liveArgument(String(input.argument_id ?? ""));
      if (typeof argument === "string") return argument;
      const newName = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;
      const rawStance = input.stance === undefined ? undefined : String(input.stance).toLowerCase();
      if (rawStance !== undefined && rawStance !== "for" && rawStance !== "against") {
        return refuse(`stance must be "for" or "against".`);
      }
      if (rawStance !== undefined && argument.stance === "neutral") {
        return refuse("An argument about a quantity has no stance; record what it shows with set_argument_shows.");
      }
      const stance = rawStance === argument.stance ? undefined : (rawStance as "for" | "against" | undefined);
      if (newName === undefined && stance === undefined) {
        return refuse("Nothing to change: pass a new name, or a stance different from the current one.");
      }
      const { evaluationRetired } = await reviseArgument({ argumentId: argument.id, name: newName, stance });
      const changes = [
        ...(newName !== undefined ? [`renamed from "${argument.name ?? ""}" to "${newName}"`] : []),
        ...(stance !== undefined ? [`stance flipped from ${argument.stance} to ${stance}`] : []),
      ].join(" and ");
      await logStructureChange(argument.claimId, "revise_argument", `Argument ${argument.id} ${changes}: ${reasoning}`);
      return JSON.stringify({
        success: true,
        message:
          `Argument ${argument.id} ${changes}.` +
          (stance !== undefined
            ? ` Its conclusion is now the claim${stance === "against" ? "'s denial" : ""}: rewrite the ` +
              `written form with write_argument if it reads the other way, and evaluate it again` +
              (evaluationRetired ? " (its previous evaluation was retired)." : ".")
            : ""),
      });
    }

    case "retire_argument": {
      const argument = await liveArgument(String(input.argument_id ?? ""));
      if (typeof argument === "string") return argument;
      const { released } = await retireArgument({ argumentId: argument.id, reason: reasoning });
      await logStructureChange(
        argument.claimId,
        "retire_argument",
        `Retired argument "${argument.name ?? argument.id}" (${argument.id})` +
          (released.length > 0 ? `, releasing ${released.map((r) => r.id).join(", ")}` : "") +
          `: ${reasoning}`
      );
      return JSON.stringify({
        success: true,
        message:
          `Retired argument "${argument.name ?? argument.id}"; it is kept in history with your reason.` +
          (released.length > 0
            ? ` Its ${released.length} subclaim(s) keep their edges and are back in the basis or ` +
              `their other arguments: ${released.map((r) => `${r.id} ("${r.text.slice(0, 60)}")`).join("; ")}. ` +
              `Remove any that no longer belong with remove_subclaim_edge.`
            : ""),
      });
    }
  }
  return null;
}
