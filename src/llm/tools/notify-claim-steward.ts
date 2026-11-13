/**
 * notify_claim_steward: how an admitted contribution, or an arbitration
 * ruling on one, reaches the Steward of the claim it concerns (#697).
 *
 * The Steward used to receive only a line the Reviewer or Arbitrator wrote
 * (`${change_type}: ${details}`), so evidence URLs, quotes and argument text
 * were lost unless copied by hand, and the Steward could not check the
 * paraphrase against the original. The tool now takes the contribution id
 * and the executor writes the record itself into the Steward's context: the
 * type, the content, the evidence, the proposed wording or merge target, and
 * the reasoning that admitted (or ruled on) it. The Steward can re-read the
 * whole record with get_contribution_details.
 *
 * One definition serves both agents, so the name means one thing (F41).
 * What differs is the trigger: an acceptance or a ruling, which may unwind.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { rawQuery } from "../../db/client.js";
import { enqueueSteward } from "../../services/queue-service.js";
import { isIntakeContributionType } from "../../services/intake-service.js";
import { STATED_VIEW_CONTRIBUTION_TYPE } from "../../schemas/common.js";

export const NOTIFY_CLAIM_STEWARD = "notify_claim_steward";

/** The share of the Steward's context window one contribution's text may take. */
export const HANDOFF_CONTENT_MAX_CHARS = 6000;

export type HandoffRole = "contribution_reviewer" | "dispute_arbitrator";

export function getNotifyClaimStewardToolDefinition(role: HandoffRole): Tool {
  const when =
    role === "contribution_reviewer"
      ? "after you accept a contribution on an existing claim (record the " +
        "accept first). Not for an intake contribution or a prize claim: " +
        "those reach their Steward on their own."
      : "after you record a ruling that bears on a claim's assessment or " +
        "structure (record the decision first). The Steward re-judges the " +
        "claim; you do not.";
  return {
    name: NOTIFY_CLAIM_STEWARD,
    description:
      `Hand a contribution to the Steward of the claim it concerns, ${when} ` +
      "The Steward receives the contribution's record as filed (type, " +
      "content, evidence, proposed wording, merge target) and your recorded " +
      "reasoning, so there is no need to restate them; note is for anything " +
      "the Steward should know beyond the record.",
    input_schema: {
      type: "object" as const,
      properties: {
        contribution_id: {
          type: "string",
          description: "The contribution to hand over",
        },
        claim_id: {
          type: "string",
          description:
            "Which claim's Steward to notify. Defaults to the contribution's " +
            "target; for a proposed merge it may be the merge target instead.",
        },
        note: {
          type: "string",
          description:
            "Optional: what the Steward should know beyond the record, such " +
            "as which part of the contribution your decision rests on.",
        },
      },
      required: ["contribution_id"],
    },
  };
}

interface HandoffRow {
  id: string;
  contribution_type: string;
  claim_id: string | null;
  merge_target_claim_id: string | null;
  argument_id: string | null;
  merge_target_argument_id: string | null;
  argument_name: string | null;
  merge_target_argument_name: string | null;
  content: string;
  evidence_urls: string[] | null;
  proposed_canonical_form: string | null;
  review_status: string;
  merge_target_text: string | null;
}

/**
 * The Steward's context for a handed-over contribution, or a refusal the
 * agent can act on. Exported for tests.
 */
export async function buildHandoff(
  input: { contributionId: string; claimId?: string; note?: string },
  role: HandoffRole
): Promise<{ claimId: string; context: string } | { error: string }> {
  const [c] = await rawQuery<HandoffRow>(
    `SELECT c.id, c.contribution_type, c.claim_id, c.merge_target_claim_id,
            c.argument_id, c.merge_target_argument_id,
            arg.name AS argument_name, mta.name AS merge_target_argument_name,
            c.content, c.evidence_urls, c.proposed_canonical_form, c.review_status,
            mt.text AS merge_target_text
       FROM contributions c
       LEFT JOIN claims mt ON mt.id = c.merge_target_claim_id
       LEFT JOIN arguments arg ON arg.id = c.argument_id
       LEFT JOIN arguments mta ON mta.id = c.merge_target_argument_id
      WHERE c.id::text = $1`,
    [input.contributionId]
  );
  if (!c) return { error: `Contribution ${input.contributionId} not found.` };
  if (isIntakeContributionType(c.contribution_type)) {
    return {
      error:
        "An accepted intake contribution reaches its Steward through " +
        "materialization; nothing to hand over.",
    };
  }
  if (c.contribution_type === "claim_prize") {
    return { error: "A prize claim's admission brings the Steward; nothing to hand over." };
  }
  if (c.contribution_type === STATED_VIEW_CONTRIBUTION_TYPE) {
    return {
      error:
        "A stated view's reasons reach the node's Steward when the view is admitted, and one that " +
        "gave no reasons has nothing for the Steward to answer; nothing to hand over.",
    };
  }
  const targets = [c.claim_id, c.merge_target_claim_id].filter(Boolean) as string[];
  const claimId = input.claimId?.trim() || c.claim_id;
  if (!claimId || !targets.includes(claimId)) {
    return {
      error:
        `claim_id must be the contribution's target (${c.claim_id ?? "none"})` +
        (c.merge_target_claim_id ? ` or its merge target (${c.merge_target_claim_id})` : "") +
        ". Nothing was sent.",
    };
  }

  let decisionLines: string[];
  if (role === "contribution_reviewer") {
    if (c.review_status !== "accepted") {
      return {
        error:
          `The contribution's status is '${c.review_status}', not 'accepted'. ` +
          "Record the accept with record_review_decision first; only an " +
          "admitted contribution goes to the Steward. Nothing was sent.",
      };
    }
    const [review] = await rawQuery<{ reasoning: string }>(
      `SELECT reasoning FROM contribution_reviews
        WHERE contribution_id = $1 AND superseded = false
        ORDER BY reviewed_at DESC LIMIT 1`,
      [c.id]
    );
    decisionLines = [
      "Admitted by the Contribution Reviewer. Admission is a hearing, not a " +
        "verdict (§14): change the page only where the material meets the " +
        "standard anything else on it meets.",
      `The Reviewer's reasoning: ${review?.reasoning ?? "(none recorded)"}`,
    ];
  } else {
    const [ruling] = await rawQuery<{ outcome: string; decision: string; reasoning: string }>(
      `SELECT outcome, decision, reasoning FROM arbitration_results
        WHERE contribution_id = $1 ORDER BY arbitrated_at DESC LIMIT 1`,
      [c.id]
    );
    if (!ruling) {
      return {
        error:
          "No arbitration decision is recorded for this contribution. Record " +
          "it with record_arbitration_decision first. Nothing was sent.",
      };
    }
    decisionLines = [
      `Ruled on by the Dispute Arbitrator: ${ruling.outcome} (${ruling.decision}). ` +
        "A ruling may uphold or overturn; integrating it can mean unwinding " +
        "an earlier change.",
      `The Arbitrator's reasoning: ${ruling.reasoning}`,
    ];
  }

  const content =
    c.content.length > HANDOFF_CONTENT_MAX_CHARS
      ? `${c.content.slice(0, HANDOFF_CONTENT_MAX_CHARS)}\n[the first ${HANDOFF_CONTENT_MAX_CHARS} of ${c.content.length} characters; get_contribution_details reads it whole]`
      : c.content;
  const lines = [
    `Contribution ${c.id} (${c.contribution_type}).`,
    ...decisionLines,
    ...(c.proposed_canonical_form ? [`Proposed wording: ${c.proposed_canonical_form}`] : []),
    ...(c.merge_target_claim_id
      ? [`Proposed merge with ${c.merge_target_claim_id}: "${c.merge_target_text ?? ""}"`]
      : []),
    ...argumentLines(c),
    ...((c.evidence_urls ?? []).length > 0 ? [`Evidence: ${(c.evidence_urls ?? []).join(" ")}`] : []),
    `Content as filed:\n${content}`,
    ...(input.note?.trim() ? [`Note: ${input.note.trim()}`] : []),
  ];
  return { claimId, context: lines.join("\n") };
}

/**
 * What the Steward is told when the contribution is about one of its
 * node's arguments (#541), and what an accepted propose_argument asks of
 * it beyond adding the argument. Instances are the Steward's to record;
 * merges and splits of arguments are the Curator's (§5).
 */
function argumentLines(c: HandoffRow): string[] {
  const named = (id: string, name: string | null) => `argument ${id}${name ? ` ("${name}")` : ""}`;
  if (c.argument_id) {
    const about = named(c.argument_id, c.argument_name);
    if (c.contribution_type === "add_instance") {
      return [
        `About ${about}: a source said to make, attack or mention it. If you read the source and it does, ` +
          `record it with record_argument_instance, with how well the passage states the argument. If it rests ` +
          `on a different premise it makes a different argument (§7). An instance is provenance: it does not ` +
          `change the argument's written form or rating.`,
      ];
    }
    if (c.contribution_type === "propose_merge" && c.merge_target_argument_id) {
      return [
        `Proposed merge of ${about} with ${named(c.merge_target_argument_id, c.merge_target_argument_name)}, as ` +
          `one inference to the same conclusion. Merging arguments is the Curator's (§5): if the case has ` +
          `merit, take it there with escalate_to_curator, naming both arguments.`,
      ];
    }
    if (c.contribution_type === "propose_split") {
      return [
        `Proposed split of ${about}, as several lines of reasoning. Splitting an argument is the Curator's ` +
          `(§5): if the case has merit, take it there with escalate_to_curator, naming the argument and the ` +
          `lines the contribution distinguishes.`,
      ];
    }
    return [`About ${about}.`];
  }
  if (c.contribution_type === "propose_argument") {
    return [
      "If you add this argument and a source in the evidence makes it, record that source on the argument " +
        "with record_argument_instance. Whether the argument belongs on the page is §7's test, not the " +
        "contributor's or the source's standing.",
    ];
  }
  return [];
}

export async function executeNotifyClaimSteward(
  input: Record<string, unknown>,
  role: HandoffRole
): Promise<string> {
  const contributionId = typeof input.contribution_id === "string" ? input.contribution_id.trim() : "";
  if (!contributionId) {
    return JSON.stringify({ success: false, error: "contribution_id is required." });
  }
  const handoff = await buildHandoff(
    {
      contributionId,
      claimId: typeof input.claim_id === "string" ? input.claim_id : undefined,
      note: typeof input.note === "string" ? input.note : undefined,
    },
    role
  );
  if ("error" in handoff) return JSON.stringify({ success: false, error: handoff.error });
  await enqueueSteward({
    claimId: handoff.claimId,
    // Not contribution_accepted for a ruling (#182): an arbitration can
    // overturn as well as uphold, and the Steward should know it is
    // integrating a ruling, not an acceptance.
    trigger: role === "contribution_reviewer" ? "contribution_accepted" : "arbitration_outcome",
    context: handoff.context,
    sender: { kind: role, ref: contributionId },
  });
  return JSON.stringify({
    success: true,
    message: `The Steward of claim ${handoff.claimId} has the contribution's record.`,
  });
}
