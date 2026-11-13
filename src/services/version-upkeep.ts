/**
 * Keeping a version of a judgment current against the versions it reads
 * (db/schema.ts, "a version at each label"; constitution §22).
 *
 * A node may carry a judgment at each label, and each version records the
 * versions it was made beside: the current version at each label its own
 * label reads, as they stood (judgment_inputs, 'beside'). When one of those
 * is replaced or retired, or a label it reads gains a version it had none
 * of, the version was made against an earlier state of what it reads. A
 * read shows that from the record alone (madeBesideOf in
 * judgment-version-service.ts) and writes nothing.
 *
 * This is the other half: for each such version, a reassessment is opened
 * on the ledger at the version's own label, and nowhere else. A message
 * saying what was replaced goes to the node's inbox at that label, the slot
 * for that label becomes pending, and the label's assess row is opened.
 * Opening it runs nothing. Work runs when a mandate funds it, and whether
 * the change matters is the Steward's judgment when it does.
 *
 * It is asked for once for each state of what the version reads: the
 * message is keyed by the version and by what stands beside it now, and a
 * key already on the node is not sent again, whether or not its pass has
 * run. A Steward that looks and records nothing new is therefore not asked
 * again until something beside its version moves again.
 *
 * It must see every label to find the versions, and it is the scheduler's
 * work, so it reads at system clearance and then does each node's piece at
 * that version's label, from rows read there (tests/unit/db/system-clearance
 * lists it). On the public graph there is one label and nothing is asked.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";

const REASON =
  "The upkeep of versions finds, at every label, the versions made beside one that has since been replaced; each node's reassessment is then opened at its own version's label.";

/** The three tables that hold a node's judgment (an argument's evaluation follows its claim's). */
const NODE_JUDGMENTS = [
  { table: "assessments", kind: "assessment" },
  { table: "quantity_estimates", kind: "quantity_estimate" },
  { table: "question_assessments", kind: "question_assessment" },
] as const;

/** How many versions one sweep opens a reassessment for. The rest are found by the next. */
const PER_SWEEP = 200;

interface Moved {
  version_id: string;
  claim_id: string;
  label: string;
  /** The label whose version was replaced, retired or first recorded. */
  beside_label: string;
  /** The version this one was made beside at that label; null where there was none. */
  made_beside: string | null;
  /** The version there now; null where there is none. */
  there_now: string | null;
}

/**
 * Open a reassessment, at its own label, for every current version made
 * beside one that has since changed. Returns how many it opened.
 *
 * With `claimIds` it looks at those nodes alone: the mirror's applier names
 * the nodes whose public judgment a batch moved (services/mirror-upkeep.ts),
 * so that their versions at other labels are asked about as soon as the
 * batch is in, and no other node is read.
 */
export async function openReassessmentsForVersionsMadeBesideEarlier(
  opts: { claimIds?: readonly string[] } = {}
): Promise<number> {
  if (oneLabelOnly()) return 0;
  if (opts.claimIds && opts.claimIds.length === 0) return 0;
  const only = opts.claimIds ? ` AND v.claim_id = ANY($2::uuid[])` : "";
  const params = (kind: string) => (opts.claimIds ? [kind, [...opts.claimIds]] : [kind]);
  const moved = await withSystemClearance(REASON, async () => {
    const rows: Moved[] = [];
    for (const { table, kind } of NODE_JUDGMENTS) {
      rows.push(
        ...(await rawQuery<Moved>(
          // A version it was made beside is no longer current...
          `SELECT v.id AS version_id, v.claim_id, v.sensitivity_label AS label, i.input_label AS beside_label,
                  i.input_judgment_id AS made_beside,
                  (SELECT o.id FROM ${table}_versions o
                    WHERE o.claim_id = v.claim_id AND o.sensitivity_label = i.input_label) AS there_now
             FROM ${table}_versions v
             JOIN judgment_inputs i
               ON i.judgment_kind = $1 AND i.judgment_id = v.id AND i.input_kind = 'beside'
             JOIN claims c ON c.id = v.claim_id AND c.state = 'active'
            WHERE NOT EXISTS (SELECT 1 FROM ${table}_versions o WHERE o.id = i.input_judgment_id)
              -- A version replaced only because its Steward took in a page this
              -- version's label had shown it gives this version nothing new to
              -- weigh (minerval_only_shown_pages_between; showing-service.ts).
              AND NOT minerval_only_shown_pages_between(
                    $1, i.input_judgment_id,
                    (SELECT o.id FROM ${table}_versions o
                      WHERE o.claim_id = v.claim_id AND o.sensitivity_label = i.input_label),
                    v.sensitivity_label)${only}
           UNION ALL
           -- ...or a label it reads has a version now and had none then.
           SELECT v.id, v.claim_id, v.sensitivity_label, o.sensitivity_label, NULL, o.id
             FROM ${table}_versions v
             JOIN ${table}_versions o
               ON o.claim_id = v.claim_id AND o.sensitivity_label <> v.sensitivity_label
              AND o.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[v.sensitivity_label]))
             JOIN claims c ON c.id = v.claim_id AND c.state = 'active'
            WHERE NOT EXISTS (SELECT 1 FROM judgment_inputs i
                               WHERE i.judgment_kind = $1 AND i.judgment_id = v.id AND i.input_kind = 'beside'
                                 AND i.input_label = o.sensitivity_label)${only}
            LIMIT ${PER_SWEEP}`,
          params(kind)
        ))
      );
    }
    return rows;
  });

  // One piece of work for each version: everything beside it that moved.
  const byVersion = new Map<string, Moved[]>();
  for (const m of moved) byVersion.set(m.version_id, [...(byVersion.get(m.version_id) ?? []), m]);

  let opened = 0;
  for (const changes of byVersion.values()) {
    const { version_id, claim_id, label } = changes[0]!;
    changes.sort((a, b) => (a.beside_label < b.beside_label ? -1 : 1));
    const key = `beside:${version_id}:${changes.map((c) => `${c.beside_label}=${c.there_now ?? "none"}`).join(",")}`;
    try {
      const sent = await runAtLabel(label, `the version of node ${claim_id} at ${label}`, async () => {
        const already = await rawQuery(
          `SELECT 1 FROM node_messages
            WHERE node_id = $1 AND trigger = 'version_beside_changed' AND sender_ref = $2 AND sensitivity_label = $3
            LIMIT 1`,
          [claim_id, key, label]
        );
        if (already.length > 0) return false;
        const { enqueueSteward } = await import("./queue-service.js");
        await enqueueSteward({
          claimId: claim_id,
          trigger: "version_beside_changed",
          context: versionsMovedMessage(label, changes),
          sender: { kind: "system", ref: key },
        });
        return true;
      });
      if (sent) opened++;
    } catch (err) {
      // One node's failure must not take the rest of the sweep with it.
      console.error(
        `[version-upkeep] could not open the reassessment of node ${claim_id} at ${label}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return opened;
}

/**
 * What the Steward at `label` is told. It states what moved and nothing
 * about what that means, which is the Steward's to judge.
 */
export function versionsMovedMessage(
  label: string,
  changes: ReadonlyArray<Pick<Moved, "beside_label" | "made_beside" | "there_now">>
): string {
  const lines = changes.map((c) =>
    c.made_beside === null
      ? `- \`${c.beside_label}\`: there was no version at this label when yours was recorded, and there is one now.`
      : c.there_now === null
        ? `- \`${c.beside_label}\`: the version yours was made beside has been retired, and no version stands at this label now.`
        : `- \`${c.beside_label}\`: the version yours was made beside has been replaced by a newer one.`
  );
  return (
    `This node carries a version of its judgment at more than one label. The version at \`${label}\` ` +
    `was recorded beside the versions at the labels \`${label}\` reads, as they stood then. Since then:\n` +
    `${lines.join("\n")}\n` +
    `Until a pass at \`${label}\` looks again, readers at \`${label}\` are shown that its version was made ` +
    `against an earlier one. Read the versions as they stand now with get_claim. Whether the change ` +
    `matters to the \`${label}\` version is yours to judge. A version recorded now is recorded beside ` +
    `the versions as they now stand. If you judge that nothing in it should change, say so with ` +
    `log_stewardship_decision, and it goes on being shown as made against the earlier one.`
  );
}

const REASON_LEFT_STANDING =
  "The upkeep of versions finds, at every label, the records of a judgment left standing whose judgment has since been replaced; each node's reassessment is then opened at the record's own label.";

/**
 * Open a reassessment, at its own label, for every record that a label
 * examined a node and left the judgment it reads standing
 * (left-standing-service.ts), where that judgment has since been replaced
 * or retired, or a label it reads has a judgment made since. The question
 * is then open again at the record's label. Once for each record: a Steward
 * that looks again records a judgment or leaves the newer one standing,
 * which is a new record. Returns how many it opened. Opening one runs
 * nothing; work runs when a mandate funds it.
 *
 * With `claimIds` it looks at those nodes alone, as the sweep above does
 * for the mirror's applier. On the public graph there is one label and
 * nothing is asked.
 */
export async function openReassessmentsForJudgmentsLeftStanding(
  opts: { claimIds?: readonly string[] } = {}
): Promise<number> {
  if (oneLabelOnly()) return 0;
  if (opts.claimIds && opts.claimIds.length === 0) return 0;
  const { STANDS_SQL, OPEN_AGAIN_SQL } = await import("./left-standing-service.js");
  const found = await withSystemClearance(REASON_LEFT_STANDING, () =>
    rawQuery<{ id: string; claim_id: string; label: string; labels: string[] }>(
      `SELECT a.id, a.claim_id, a.sensitivity_label AS label,
              ARRAY(SELECT i.input_label FROM judgment_inputs i
                     WHERE i.judgment_kind = 'left_standing' AND i.judgment_id = a.id ORDER BY 1) AS labels
         FROM audit_log a
         JOIN claims c ON c.id = a.claim_id AND c.state = 'active'
        WHERE ${STANDS_SQL} AND ${OPEN_AGAIN_SQL}
          ${opts.claimIds ? "AND a.claim_id = ANY($1::uuid[])" : ""}
          AND NOT EXISTS (SELECT 1 FROM node_messages m
                           WHERE m.node_id = a.claim_id AND m.trigger = 'left_standing_changed'
                             AND m.sender_ref = 'left-standing:' || a.id::text
                             AND m.sensitivity_label = a.sensitivity_label)
        LIMIT ${PER_SWEEP}`,
      opts.claimIds ? [[...opts.claimIds]] : []
    )
  );
  let opened = 0;
  for (const { id, claim_id, label, labels } of found) {
    try {
      await runAtLabel(label, `the judgment left standing on node ${claim_id} at ${label}`, async () => {
        const { enqueueSteward } = await import("./queue-service.js");
        await enqueueSteward({
          claimId: claim_id,
          trigger: "left_standing_changed",
          context: leftStandingChangedMessage(label, labels),
          sender: { kind: "system", ref: `left-standing:${id}` },
        });
      });
      opened++;
    } catch (err) {
      console.error(
        `[version-upkeep] could not open the reassessment of node ${claim_id} at ${label}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return opened;
}

/**
 * What the Steward at `label` is told when a judgment its label left
 * standing has been replaced. It states what happened and what the two
 * outcomes are; which is right is the Steward's to judge.
 */
export function leftStandingChangedMessage(label: string, standingAt: readonly string[]): string {
  const at = standingAt.map((l) => `\`${l}\``).join(", ");
  return (
    `A run at \`${label}\` examined this node and left the judgment at ${at} standing for readers at ` +
    `\`${label}\`, recording none of its own. That judgment has been replaced since. Readers at ` +
    `\`${label}\` read the newer one, and the node's page tells them it has not been looked at from ` +
    `\`${label}\`. Read the node as it stands with get_claim. Record your own judgment, or leave the ` +
    `newer one standing with leave_judgment_standing. You are told this once.`
  );
}
