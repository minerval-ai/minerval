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
import type { MessageSender } from "../../services/inbox-service.js";
import { commissionNodePass } from "../../services/commission-service.js";
import { registerAwait } from "../../services/session-service.js";
import { loadConfig } from "../../config.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import { debitRunBudget, runBudgetLeft, runPayer } from "../run-funding.js";

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
  const budgetOwls = {
    type: "number",
    description:
      "Optional: pay for each receiving node's pass from your budget, at this " +
      "budget in owls, so it runs now. Leave it out to send a note. cost_sheet " +
      "gives what a pass on such a node costs; use the high end.",
  };
  if (role === "curator") {
    return {
      name: "notify_steward",
      description:
        "Send one or more nodes' Stewards a message: what you did and what you " +
        "ask of them (e.g. 'I merged X into you, reconcile the flipped arguments " +
        "and re-assess', or 'you were split from Y, re-derive your " +
        "decomposition'). Always do this after a merge or split, and pay for " +
        "the pass (budget_owls) when the node's page no longer describes what " +
        "the node now is. A message alone is a note, read on the node's next " +
        "funded pass.",
      input_schema: {
        type: "object" as const,
        properties: {
          target_ids: targetIds,
          message: {
            type: "string",
            description: "What you did and what you ask the Steward to do",
          },
          budget_owls: budgetOwls,
        },
        required: ["target_ids", "message"],
      },
    };
  }
  return {
    name: "notify_steward",
    description:
      "Send the Stewards of one or more other nodes (claims, quantities or " +
      "questions) your reasons: what changed on your node and why it may " +
      "matter to theirs, or why you think their assessment is mistaken. Each " +
      "message is kept whole in the receiving node's inbox until its Steward " +
      "reads it, and is shown on that node's page and to the mandates that " +
      "fund work there. The Steward is told how its node and yours are " +
      "joined, and answers you. You cannot change another node: the " +
      "receiving Steward decides whether anything should change.\n\n" +
      "A message alone is a note: free to send, and read on the node's next " +
      "pass, whenever someone pays for it. When the other node should be " +
      "looked at now, because its page is wrong in a way readers rely on, " +
      "pay for its pass with budget_owls: your message becomes that pass's " +
      "brief. If your budget can't cover it, petition_mandate asks the " +
      "mandate paying for your run for the money.\n\n" +
      "When you need the answer for your own work, set expects_reply: the " +
      "answer returns into this session. Carry on with what you can do " +
      "without it; when that is done, end your turn, and your session pauses " +
      "and resumes with the answer, this conversation intact. The other " +
      "Steward answers on its node's next pass, so pay for that pass " +
      "(budget_owls) if you need the answer soon. A paused session waits at " +
      `most ${loadConfig().sessionWaitHours} hours; after that the answer goes to your node's inbox.`,
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
            "Your reasons, written so the receiving Steward can weigh them " +
            "without your transcript: what you found, where, and what you " +
            "think it means for their node.",
        },
        budget_owls: budgetOwls,
        expects_reply: {
          type: "boolean",
          description: "true when you need the answer for your own work: it returns into this session.",
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
  /** Set when this message came with the node's pass paid for. */
  paid_owls?: number;
  /** Set when the node already had a pass paid for: the message joined it, at no cost. */
  joined_paid_pass?: boolean;
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
  const budgetOwls = Number(input.budget_owls ?? 0);
  const budgetMicro = Number.isFinite(budgetOwls) && budgetOwls > 0 ? owlsToMicroUsd(budgetOwls) : 0;
  const payer = budgetMicro > 0 ? runPayer() : null;
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
    const from: MessageSender =
      sender.role === "curator" ? { kind: "curator" } : { kind: "steward", nodeId: sender.claimId };

    // A paid message: commission the target's pass from this run's budget,
    // with the message as its brief (commission-service.ts). What this run
    // can't cover goes as a note.
    if (budgetMicro > 0 && payer) {
      const left = runBudgetLeft();
      if (left === null || left >= budgetMicro) {
        const res = await commissionNodePass({
          payer,
          claimId: id,
          budgetMicroUsd: budgetMicro,
          brief: message,
          commissionedBy: sender.role,
          message: { trigger, sender: from },
        });
        if (res.ok && res.status === "commissioned") {
          debitRunBudget(budgetMicro);
          notified.push({ id, kind: kindOf.get(id)!, trigger, paid_owls: microUsdToOwls(budgetMicro) });
          continue;
        }
        if (res.ok && res.status === "already_commissioned") {
          notified.push({ id, kind: kindOf.get(id)!, trigger, joined_paid_pass: true });
          continue;
        }
      }
    }

    // The message goes whole into the target's inbox, which tells its
    // Steward who wrote and how the two nodes are joined (inbox-service.ts).
    await enqueueSteward({ claimId: id, trigger, context: message, sender: from });
    notified.push({ id, kind: kindOf.get(id)!, trigger });
  }

  // A question this session waits on: each message carries the session's id,
  // and its answer returns into it (session-service.ts).
  let awaited = 0;
  if (sender.role === "steward" && input.expects_reply === true) {
    for (const n of notified) {
      const [m] = await rawQuery<{ id: string }>(
        `SELECT id FROM node_messages
          WHERE node_id = $1 AND sender_node_id = $2 AND body = $3 AND answered_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [n.id, sender.claimId, message]
      );
      if (!m) continue;
      const sessionId = await registerAwait("reply", m.id);
      if (!sessionId) break;
      await rawQuery(`UPDATE node_messages SET reply_to_session = $2 WHERE id = $1`, [m.id, sessionId]);
      awaited++;
    }
  }

  const paid = notified.filter((n) => n.paid_owls !== undefined);
  const joined = notified.filter((n) => n.joined_paid_pass);
  const notes = notified.length - paid.length - joined.length;
  const parts: string[] = [];
  if (budgetMicro <= 0) {
    if (notified.length > 0) {
      parts.push(
        `Sent to the Steward of ${notified.length} node(s) as a note. Each waits ` +
          `in that node's inbox, shown on its page and to its funders, until a pass reads it.`
      );
    }
  } else {
    if (paid.length > 0) {
      parts.push(
        `Paid for the pass on ${paid.map((n) => n.id).join(", ")} at ` +
          `${microUsdToOwls(budgetMicro)} owls each from your budget; ` +
          `${paid.length === 1 ? "it runs" : "they run"} on ${paid.length === 1 ? "its" : "their"} own.` +
          (runBudgetLeft() !== null ? ` You have ${microUsdToOwls(runBudgetLeft()!)} owls left.` : "")
      );
    }
    if (joined.length > 0) {
      parts.push(
        `${joined.map((n) => n.id).join(", ")} already had a pass paid for; your ` +
          `message joined it, at no cost.`
      );
    }
    if (notes > 0) {
      parts.push(
        payer
          ? `${notes} went as notes: your budget did not cover them. Petition your ` +
              `mandate (petition_mandate) if they should run now.`
          : `${notes} went as notes: this run isn't paid in a way that can pay for ` +
              `other work.`
      );
    }
  }
  if (input.expects_reply === true && sender.role === "steward") {
    parts.push(
      awaited > 0
        ? `You wait for ${awaited} answer(s): each returns into this session. When you have done what you can without them, end your turn; your session pauses and resumes with them.`
        : `This run can't pause to wait, so answers go to your node's inbox as replies.`
    );
  }
  return JSON.stringify({
    success: notified.length > 0,
    message: parts.length > 0 ? parts.join(" ") : "No Steward was notified.",
    notified,
    ...(refused.length > 0 ? { refused } : {}),
  });
}
