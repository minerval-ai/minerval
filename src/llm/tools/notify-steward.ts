/**
 * notify_steward: one tool, shared by the Steward and the Curator, that
 * sends a node's Steward a message and enqueues it (Part VIII, "Working
 * Together"; §22). Nothing is written across the boundary: the receiving
 * Steward runs when funding covers it and decides for itself whether
 * anything should change.
 *
 * The trigger the receiver sees says who is writing and why. It is derived
 * from the graph, not chosen by the caller:
 *  - a Steward writing to a node that has the sender's node beneath it
 *    (the target depends on the sender): subclaim_change;
 *  - a Steward writing to a node beneath its own (the sender depends on
 *    the target): dependent_note;
 *  - a Steward writing to any other node: steward_note;
 *  - the Curator: curator_change.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { rawQuery } from "../../db/client.js";
import {
  enqueueSteward,
  type StewardMessage,
} from "../../services/queue-service.js";

type Tool = Anthropic.Tool;

export type NotifyStewardSender =
  | { role: "steward"; claimId: string }
  | { role: "curator" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getNotifyStewardToolDefinition(
  role: NotifyStewardSender["role"]
): Tool {
  const targetIds = {
    type: "array",
    items: { type: "string" },
    description:
      "The ids of the nodes (claims, quantities or questions) whose Stewards " +
      "to notify. Each receives the same message.",
  };
  if (role === "curator") {
    return {
      name: "notify_steward",
      description:
        "Send one or more nodes' Stewards a message: what you did and what you " +
        "ask of them (e.g. 'I merged X into you, reconcile the flipped arguments " +
        "and re-assess', or 'you were split from Y, re-derive your " +
        "decomposition'). Each Steward is enqueued and decides what to do. " +
        "Always do this after a merge or split.",
      input_schema: {
        type: "object" as const,
        properties: {
          target_ids: targetIds,
          message: {
            type: "string",
            description: "What you did and what you ask the Steward to do",
          },
        },
        required: ["target_ids", "message"],
      },
    };
  }
  return {
    name: "notify_steward",
    description:
      "Send the Steward of one or more other nodes (claims, quantities or " +
      "questions) your reasons, for instance what changed on your node and why " +
      "it may matter to theirs, or why you think their assessment is mistaken. " +
      "Each Steward is enqueued and decides for itself whether anything should " +
      "change; you cannot change another node. The Steward is told how its " +
      "node and yours are joined.",
    input_schema: {
      type: "object" as const,
      properties: {
        claim_id: {
          type: "string",
          description: "The id of the node you steward",
        },
        target_ids: targetIds,
        message: {
          type: "string",
          description:
            "Your reasons, written so the receiving Steward can weigh them",
        },
      },
      required: ["claim_id", "target_ids", "message"],
    },
  };
}

type Trigger = StewardMessage["trigger"];

interface Notified {
  id: string;
  kind: string;
  trigger: Trigger;
}

interface Refused {
  id: string;
  reason: string;
}

function readTargetIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids = list.map((v) => String(v ?? "").trim()).filter((v) => v !== "");
  return [...new Set(ids)];
}

export async function executeNotifySteward(
  sender: NotifyStewardSender,
  input: Record<string, unknown>
): Promise<string> {
  const message = String(input.message ?? "").trim();
  const requested = readTargetIds(input.target_ids);
  if (requested.length === 0) {
    return JSON.stringify({
      success: false,
      message: "Nothing sent: target_ids names no node.",
    });
  }
  if (message === "") {
    return JSON.stringify({
      success: false,
      message: "Nothing sent: the message is empty.",
    });
  }

  const refused: Refused[] = [];
  let candidates = requested;
  if (sender.role === "steward") {
    candidates = requested.filter((id) => {
      if (id === sender.claimId) {
        refused.push({
          id,
          reason: "This is your own node; you need no notice to act on it.",
        });
        return false;
      }
      return true;
    });
  }
  const wellFormed = candidates.filter((id) => {
    if (UUID_RE.test(id)) return true;
    refused.push({ id, reason: "Not a node id (expected a UUID)." });
    return false;
  });

  const found =
    wellFormed.length === 0
      ? []
      : await rawQuery<{ id: string; kind: string }>(
          `SELECT id, kind FROM claims WHERE id = ANY($1::uuid[])`,
          [wellFormed]
        );
  const kindOf = new Map(found.map((r) => [r.id, r.kind]));
  const targets = wellFormed.filter((id) => {
    if (kindOf.has(id)) return true;
    refused.push({
      id,
      reason: "No such node. Use ids from get_claim, match_claim or a listing.",
    });
    return false;
  });

  // How each target is joined to the sender's node, by a direct edge.
  const above = new Set<string>(); // the target depends on the sender
  const beneath = new Set<string>(); // the sender depends on the target
  if (sender.role === "steward" && targets.length > 0) {
    const edges = await rawQuery<{ parent_id: string; child_id: string }>(
      `SELECT parent_claim_id AS parent_id, child_claim_id AS child_id
         FROM claim_relationships
        WHERE (child_claim_id = $1 AND parent_claim_id = ANY($2::uuid[]))
           OR (parent_claim_id = $1 AND child_claim_id = ANY($2::uuid[]))`,
      [sender.claimId, targets]
    );
    for (const e of edges) {
      if (e.child_id === sender.claimId) above.add(e.parent_id);
      else beneath.add(e.child_id);
    }
  }

  const notified: Notified[] = [];
  for (const id of targets) {
    let trigger: Trigger;
    if (sender.role === "curator") {
      trigger = "curator_change";
    } else {
      trigger = above.has(id)
        ? "subclaim_change"
        : beneath.has(id)
          ? "dependent_note"
          : "steward_note";
    }
    // The message goes whole into the target's inbox, which tells its
    // Steward who wrote and how the two nodes are joined (inbox-service.ts).
    await enqueueSteward({
      claimId: id,
      trigger,
      context: message,
      sender:
        sender.role === "curator"
          ? { kind: "curator" }
          : { kind: "steward", nodeId: sender.claimId },
    });
    notified.push({ id, kind: kindOf.get(id)!, trigger });
  }

  return JSON.stringify({
    success: notified.length > 0,
    message:
      notified.length > 0
        ? `Notified the Steward of ${notified.length} node(s); each decides ` +
          `what to do.`
        : "No Steward was notified.",
    notified,
    ...(refused.length > 0 ? { refused } : {}),
  });
}
