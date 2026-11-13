/**
 * A judgment left standing (constitution §29; docs/architecture.md, "A
 * judgment at each label").
 *
 * A Steward at a label, on a node at a label it reads, records its own
 * judgment or leaves the one it reads standing. Leaving it standing is an
 * outcome of the run and is recorded, so that a reader at that label can
 * tell a node that was examined there from one that never was.
 *
 * It is no new kind of thing. The Steward's decision is an entry in its
 * decision trail (audit_log) with the action 'left_standing', its reasoning,
 * its label, its time and its run. What it left standing is recorded the
 * way a judgment records what it was made beside: 'beside' rows in
 * judgment_inputs, of the kind 'left_standing', whose judgment_id is the
 * entry's id. Nothing else is stored, and everything a read says of it is
 * worked out from those rows:
 *
 *   - It stands at its label while no judgment of the node has been recorded
 *     at that label since, and no later entry of the same kind is there. A
 *     judgment recorded at the label afterwards takes its place by being
 *     there; nothing is written to say so.
 *   - It is open again when a judgment it left standing has been replaced
 *     or retired, or a label it reads has a judgment made since. The upkeep
 *     of versions then opens a reassessment at its label, once
 *     (version-upkeep.ts), which runs when it is funded.
 *
 * It changes no judgment and puts nothing in force: readers at the label go
 * on reading the judgment in force for them through the `*_in_force` views,
 * which are untouched. A read that lists a node's judgments says this beside
 * them.
 *
 * A Steward whose label already has a judgment of the node may leave the
 * other standing all the same. Its own judgment is then retired, by this
 * run at its own label, and stays in the node's history. Where that
 * judgment's page is under a standing showing the tool refuses, with the
 * reason: the readers it is shown to would go on being shown a page whose
 * judgment had been withdrawn, and ending a showing is for the people who
 * direct the graph.
 *
 * On the public graph there is one label, the tool is not offered, and
 * nothing here is asked.
 */
import { currentReadClearance, rawQuery, withTransaction } from "../db/client.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import { oneLabelOnly, type JudgmentTable } from "./judgment-version-service.js";

/** The action of the entry in the Steward's decision trail. */
export const LEFT_STANDING_ACTION = "left_standing";
/** The kind its rows in judgment_inputs carry. */
export const LEFT_STANDING_KIND = "left_standing";

const JUDGMENT_OF: Record<string, { table: JudgmentTable; tool: string; noun: string }> = {
  claim: { table: "assessments", tool: "update_claim_assessment", noun: "assessment" },
  quantity: { table: "quantity_estimates", tool: "update_quantity_estimate", noun: "estimate" },
  question: { table: "question_assessments", tool: "update_question_assessment", noun: "assessment" },
};

const tick = (label: string) => `\`${label}\``;

function listed(labels: readonly string[]): string {
  const names = labels.map(tick);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/** The three views of a node's current judgments, as one relation. */
const CURRENT_VERSIONS = `(SELECT id, claim_id, sensitivity_label, assessed_at FROM assessments_versions
        UNION ALL SELECT id, claim_id, sensitivity_label, assessed_at FROM quantity_estimates_versions
        UNION ALL SELECT id, claim_id, sensitivity_label, assessed_at FROM question_assessments_versions)`;

/** Every judgment of a node, past and current, with when it was made. */
const EVERY_JUDGMENT = `(SELECT claim_id, sensitivity_label, assessed_at FROM assessments
        UNION ALL SELECT claim_id, sensitivity_label, assessed_at FROM quantity_estimates
        UNION ALL SELECT claim_id, sensitivity_label, assessed_at FROM question_assessments)`;

/**
 * Whether the entry `a` of audit_log is the record that stands at its label
 * for its node: it names what it left standing, nothing of its kind has
 * been recorded there since, and no judgment has been recorded at its label
 * since.
 */
export const STANDS_SQL = `a.action = '${LEFT_STANDING_ACTION}'
   AND EXISTS (SELECT 1 FROM judgment_inputs i WHERE i.judgment_kind = '${LEFT_STANDING_KIND}' AND i.judgment_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM audit_log later
                    WHERE later.claim_id = a.claim_id AND later.sensitivity_label = a.sensitivity_label
                      AND later.action = '${LEFT_STANDING_ACTION}' AND later.id <> a.id
                      AND (later.created_at, later.id) > (a.created_at, a.id)
                      AND EXISTS (SELECT 1 FROM judgment_inputs i
                                   WHERE i.judgment_kind = '${LEFT_STANDING_KIND}' AND i.judgment_id = later.id))
   AND NOT EXISTS (SELECT 1 FROM ${EVERY_JUDGMENT} j
                    WHERE j.claim_id = a.claim_id AND j.sensitivity_label = a.sensitivity_label
                      AND j.assessed_at > a.created_at)`;

/**
 * Whether what the entry `a` left standing has moved: a judgment it names
 * is no longer current, or a label its own label reads has a judgment made
 * since.
 */
export const OPEN_AGAIN_SQL = `(EXISTS (SELECT 1 FROM judgment_inputs i
              WHERE i.judgment_kind = '${LEFT_STANDING_KIND}' AND i.judgment_id = a.id
                AND NOT EXISTS (SELECT 1 FROM ${CURRENT_VERSIONS} v WHERE v.id = i.input_judgment_id))
    OR EXISTS (SELECT 1 FROM ${CURRENT_VERSIONS} v
                WHERE v.claim_id = a.claim_id AND v.sensitivity_label <> a.sensitivity_label
                  AND v.assessed_at > a.created_at
                  AND v.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[a.sensitivity_label]))))`;

/** What the tool answers. */
export interface LeaveStandingResult {
  success: boolean;
  message: string;
  /** The labels of the judgments left standing. */
  left_standing?: string[];
  /** True where this run's label had a judgment of the node, now retired. */
  retired_own?: boolean;
}

/**
 * Leave the judgment the run reads on `nodeId` standing for readers at the
 * run's label, with the Steward's reasoning. Run at the Steward's label.
 */
export async function leaveJudgmentStanding(nodeId: string, reasoning: string): Promise<LeaveStandingResult> {
  const label = currentLabel();
  const own = tick(label);
  if (oneLabelOnly()) {
    return { success: false, message: "Not recorded. This graph has one label, so a node carries one judgment and there is no other to leave standing." };
  }
  if (!reasoning.trim()) {
    return { success: false, message: "Not recorded. Say in `reasoning` what you looked at and why you leave the judgment standing: readers are shown it." };
  }
  const [node] = await rawQuery<{ kind: string | null; label: string }>(
    `SELECT kind, sensitivity_label AS label FROM claims WHERE id = $1`,
    [nodeId]
  );
  if (!node) return { success: false, message: `Not recorded. No node with the id ${nodeId} is among what this run reads.` };
  const spec = JUDGMENT_OF[node.kind ?? "claim"] ?? JUDGMENT_OF.claim!;
  if (node.label === label) {
    return {
      success: false,
      message:
        `Not recorded. This node carries this run's own label, ${own}, so its judgment at ${own} is the node's ` +
        `own and there is none at another label to leave standing. If your judgment of it has not changed, ` +
        `say so with log_stewardship_decision.`,
    };
  }
  // What would be in force for readers at this label with no judgment of
  // its own: the current judgments at the labels it reads, less any that
  // another of them was made above.
  const standing = await rawQuery<{ id: string; label: string }>(
    `SELECT v.id, v.sensitivity_label AS label
       FROM ${spec.table}_versions v
      WHERE v.claim_id = $1 AND v.sensitivity_label <> $2
        AND NOT EXISTS (SELECT 1 FROM ${spec.table}_versions o
                         WHERE o.claim_id = v.claim_id
                           AND o.sensitivity_label NOT IN ($2, v.sensitivity_label)
                           AND v.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[o.sensitivity_label])))
      ORDER BY v.sensitivity_label`,
    [nodeId, label]
  );
  if (standing.length === 0) {
    return {
      success: false,
      message:
        `Not recorded. No judgment of this node stands at a label ${own} reads, so there is none to leave ` +
        `standing. Record your own with ${spec.tool}.`,
    };
  }
  const [mine] = await rawQuery<{ id: string; assessed_at: Date }>(
    `SELECT id, assessed_at FROM ${spec.table}_versions WHERE claim_id = $1 AND sensitivity_label = $2`,
    [nodeId, label]
  );
  if (mine) {
    const [shown] = await rawQuery(
      `SELECT 1 FROM showing_pages p JOIN showings s ON s.id = p.showing_id
        WHERE p.node_id = $1 AND s.sensitivity_label = $2 AND s.form = 'standing' AND s.ended_at IS NULL LIMIT 1`,
      [nodeId, label]
    );
    if (shown) {
      return {
        success: false,
        message:
          `Not recorded. This node's page at ${own} is under a standing showing to readers who do not read ` +
          `${own}. Retiring the judgment at ${own} would leave them shown a page whose judgment had been ` +
          `withdrawn, with nothing to tell them so. Ending a showing is for the people who direct this ` +
          `graph. Until then, record your judgment as it now stands with ${spec.tool}.`,
      };
    }
  }

  const runId = getUsageContext().runId ?? null;
  await withTransaction(async (tx) => {
    if (mine) {
      // The run's own label's judgment, and its evaluations of arguments
      // recorded at other labels, which the evaluations there now stand
      // for. Its evaluations of its own arguments are left: no other label
      // has one.
      await tx.query(`UPDATE ${spec.table} SET is_current = false WHERE id = $1`, [mine.id]);
      await tx.query(
        `UPDATE argument_evaluations e SET is_current = false
          WHERE e.sensitivity_label = $2 AND e.is_current
            AND e.argument_id IN (SELECT a.id FROM arguments a WHERE a.claim_id = $1 AND a.sensitivity_label <> $2)`,
        [nodeId, label]
      );
    }
    const [entry] = await tx.query<{ id: string }>(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by, sensitivity_label, run_id)
       VALUES ($1, $2, $3, 'claim_steward', $4, $5) RETURNING id`,
      [nodeId, LEFT_STANDING_ACTION, reasoning, label, runId]
    );
    for (const s of standing) {
      await tx.query(
        `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, input_judgment_id, input_label, sensitivity_label)
         VALUES ($1, $2, 'beside', $3, $4, $5)`,
        [LEFT_STANDING_KIND, entry!.id, s.id, s.label, label]
      );
    }
  });

  const labels = standing.map((s) => s.label);
  const which = labels.length === 1 ? `The judgment at ${listed(labels)} stands` : `The judgments at ${listed(labels)} stand`;
  return {
    success: true,
    left_standing: labels,
    retired_own: Boolean(mine),
    message:
      `Recorded. ${which} for readers at ${own}, and the node's page shows them that it was examined at ${own} ` +
      `today and left standing, with your reasoning. When ${labels.length === 1 ? "that judgment is" : "one of those judgments is"} ` +
      `replaced, a reassessment at ${own} is opened, which runs when it is funded.` +
      (mine
        ? ` The ${spec.noun} at ${own} of ${new Date(mine.assessed_at).toISOString().slice(0, 10)} is retired and stays in the node's history.`
        : ""),
  };
}

/** One label's record that a node was examined there and the judgment it reads left standing. */
export interface LeftStanding extends Record<string, unknown> {
  /** The label the node was examined at. */
  label: string;
  examined_at: string;
  /** The run that examined it, where it was recorded. */
  run_id: string | null;
  /** The Steward's words: what it looked at and why it left the judgment standing. */
  reasoning: string;
  /** The judgments it left standing, by label, and whether each has since been replaced. */
  judgments: Array<{ label: string; replaced: boolean }>;
  /** True when one of them has been replaced, or a label it reads has a judgment made since: the question is open again at `label`. */
  open_again: boolean;
}

/**
 * For a node, the records that stand at the labels the asker reads, and the
 * labels the asker reads at which the node has been neither judged nor
 * examined. Empty on a deployment whose only label is `public`.
 */
export async function examinedAtLabels(
  nodeId: string,
  nodeLabel: string,
  judgedAt: readonly string[]
): Promise<{ left_standing: LeftStanding[]; not_examined_at: string[] }> {
  if (oneLabelOnly()) return { left_standing: [], not_examined_at: [] };
  const rows = await rawQuery<{
    id: string; label: string; created_at: Date; run_id: string | null; reasoning: string; open_again: boolean;
    judgments: Array<{ label: string; replaced: boolean }>;
  }>(
    `SELECT a.id, a.sensitivity_label AS label, a.created_at, a.run_id, a.reasoning,
            ${OPEN_AGAIN_SQL} AS open_again,
            (SELECT COALESCE(json_agg(json_build_object(
                      'label', i.input_label,
                      'replaced', NOT EXISTS (SELECT 1 FROM ${CURRENT_VERSIONS} v WHERE v.id = i.input_judgment_id))
                    ORDER BY i.input_label), '[]'::json)
               FROM judgment_inputs i
              WHERE i.judgment_kind = '${LEFT_STANDING_KIND}' AND i.judgment_id = a.id) AS judgments
       FROM audit_log a
      WHERE a.claim_id = $1 AND ${STANDS_SQL}
      ORDER BY a.sensitivity_label`,
    [nodeId]
  );
  const left = rows.map((r) => ({
    label: r.label,
    examined_at: new Date(r.created_at).toISOString(),
    run_id: r.run_id,
    reasoning: r.reasoning,
    judgments: r.judgments,
    open_again: r.open_again,
  }));
  // The labels the asker reads that read the node's own label and have
  // neither a judgment of it nor a record that one was left standing.
  const reads = (await currentReadClearance()) ?? [];
  const candidates = reads.filter((l) => l !== nodeLabel && !judgedAt.includes(l) && !left.some((e) => e.label === l));
  let notExamined: string[] = [];
  if (candidates.length > 0) {
    const reach = await rawQuery<{ label: string }>(
      `SELECT l AS label FROM unnest($1::text[]) AS l
        WHERE $2 = ANY (minerval_labels_readable_from(ARRAY[l])) ORDER BY 1`,
      [candidates, nodeLabel]
    );
    notExamined = reach.map((r) => r.label);
  }
  return { left_standing: left, not_examined_at: notExamined };
}

/** What a read's schema says of `left_standing` and `not_examined_at`. */
export const LEFT_STANDING_DESCRIPTION =
  "present where the node has been examined at a label the reader reads and the judgment that label reads was " +
  "left standing, with no judgment recorded at that label: one entry for each such label, with `label`, " +
  "`examined_at`, the `run_id` of the run that examined it, the Steward's `reasoning`, the `judgments` it left " +
  "standing (each with its `label`, and `replaced` true once it has been replaced), and `open_again`, true " +
  "when one of them has been replaced or a label it reads has a judgment made since. An entry is not a " +
  "judgment and puts nothing in force: readers at its label read the judgments in force for them, as listed " +
  "under `versions`";

export const NOT_EXAMINED_AT_DESCRIPTION =
  "the labels the reader reads, other than the node's own, at which the node has neither a judgment nor a " +
  "record that one was left standing: it has not been examined there, which is not a finding that nothing " +
  "there bears on it";
