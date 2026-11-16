/**
 * Only a node's own Steward writes to it (Part VIII, "Working Together"):
 * writes across a boundary are proposals. The Steward's write tools take
 * the target node from the model's input, so this module checks that
 * target against the node the run stewards and refuses the rest with the
 * route that does reach the other node (#757).
 *
 * The run's node is read from the usage context runClaimSteward sets, so a
 * researcher a Steward launches is held to the same node. With no node in
 * the context (a caller outside a Steward run) there is nothing to check.
 */
import { rawQuery } from "../../db/client.js";
import { getUsageContext } from "../usage-context.js";

/** Where each Steward write tool names its target node. */
const TARGET: Record<string, { field: string; via?: "argument" | "instance" | "passage" }> = {
  update_claim_assessment: { field: "claim_id" },
  record_claim_instance: { field: "claim_id" },
  update_claim_instance: { field: "instance_id", via: "instance" },
  detach_claim_instance: { field: "instance_id", via: "instance" },
  reattach_claim_instance: { field: "instance_id", via: "instance" },
  set_instance_order: { field: "claim_id" },
  update_canonical_form: { field: "claim_id" },
  add_argument: { field: "claim_id" },
  write_argument: { field: "argument_id", via: "argument" },
  record_argument_instance: { field: "argument_id", via: "argument" },
  place_argument_passage: { field: "instance_id", via: "passage" },
  evaluate_argument: { field: "argument_id", via: "argument" },
  add_relationship_edge: { field: "parent_id" },
  add_related_claim: { field: "claim_id" },
  add_decomposition_edge: { field: "parent_id" },
  add_parent_claim: { field: "claim_id" },
  propose_parent_edge: { field: "claim_id" },
  set_claim_importance: { field: "claim_id" },
  set_claim_domains: { field: "claim_id" },
  log_stewardship_decision: { field: "claim_id" },
  leave_judgment_standing: { field: "claim_id" },
  notify_dependent_stewards: { field: "claim_id" },
  // Kind tools (kind-tools.ts). record_estimate and record_quantity_reading
  // are absent on purpose: a figure or a reading met in a source belongs on
  // the quantity it bears on, whoever meets it.
  set_quantity_definition: { field: "claim_id" },
  update_quantity_estimate: { field: "claim_id" },
  set_argument_shows: { field: "argument_id", via: "argument" },
  record_cut: { field: "claim_id" },
  add_presupposition: { field: "question_id" },
  add_subquestion: { field: "question_id" },
  add_answer: { field: "question_id" },
  remove_answer: { field: "question_id" },
  set_answer_relation: { field: "question_id" },
  update_question_assessment: { field: "claim_id" },
  record_question_instance: { field: "question_id" },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's own node, when a Steward run set one. */
export function runNodeId(): string | null {
  return getUsageContext().claimId ?? null;
}

/**
 * The refusal for a write to `nodeId` from a run that stewards another
 * node, or null when the write is the run's own (or no run node is known).
 * `what` names the thing written ("that edge", "argument <id>").
 */
export function notYourNode(nodeId: string, what: string): string | null {
  const own = runNodeId();
  if (!own || own === nodeId) return null;
  return JSON.stringify({
    success: false,
    message:
      `Not written: ${what} is on node ${nodeId}, not on ${own}, the node you steward. Only a node's own ` +
      `Steward writes to it (Part VIII). If you think its judgment or structure is wrong, say so ` +
      `in your reasoning and route it there: propose an edge into it with propose_parent_edge, ` +
      `file a request on it (file_request), or raise a structural concern with ` +
      `escalate_to_curator. A figure or a reading you met in a source goes on any quantity with ` +
      `record_estimate or record_quantity_reading.`,
  });
}

/**
 * The refusal for `toolName` writing to a node other than the run's own, or
 * null. Tools not in the table (reads, escalate_to_curator, the request
 * tools, record_estimate, record_quantity_reading) are never refused here.
 */
export async function ownershipRefusal(toolName: string, input: Record<string, unknown>): Promise<string | null> {
  const target = TARGET[toolName];
  const own = runNodeId();
  if (!target || !own) return null;
  const raw = input[target.field];
  if (typeof raw !== "string" || raw.trim() === "") return null; // the tool reports the missing id itself
  const id = raw.trim();
  if (!target.via) return notYourNode(id, `this ${toolName} call`);
  if (!UUID_RE.test(id)) return null; // malformed: the tool's own lookup refuses it
  const [row] =
    target.via === "argument"
      ? await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM arguments WHERE id = $1`, [id])
      : target.via === "passage"
        ? await rawQuery<{ claim_id: string }>(
            `SELECT claim_id FROM argument_instances WHERE id = $1 AND claim_id IS NOT NULL`,
            [id]
          )
        : await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM claim_instances WHERE id = $1`, [id]);
  if (!row) return null; // not found: the tool's own refusal says so
  return notYourNode(
    row.claim_id,
    target.via === "argument" ? `Argument ${id}` : target.via === "passage" ? `Passage ${id}` : `Instance ${id}`
  );
}
