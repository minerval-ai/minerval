/**
 * Keeping the other side's version of a node current (docs/the-gate.md,
 * "Keeping the other side current").
 *
 * A label's judgment of a node is made on more than the labels it reads
 * can see. When it changes, the judgment below was made beside an earlier
 * one, and the readers below, the public among them, are better served by
 * a fresh assessment there, on what they can read. So a gate can name a
 * mandate that is asked to pay for one each time: between two labels, a
 * mandate at the label above, which pays for a pass on the node below; at
 * the gate to outside, a public mandate the organization funds, which is
 * asked on the public graph and pays there in public owls.
 *
 * The asking says which nodes the label works on, and when. That is
 * information going down, so each asking is an item at the gate, of the
 * kind `funding`, and goes through it like anything else: open, left to
 * the Redactor, or waiting for a person, for the whole boundary, one
 * mandate's work or a node and what sits under it, with a standing delay
 * or batches where the gate's authorities set one. There is no other
 * queue.
 *
 * A gate that names no mandate asks nothing. Naming one starts it from
 * then: a version made earlier is not asked about afterwards.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { offerToGate } from "./gate-service.js";
import { gateOf } from "./gate-settings-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";

const REASON =
  "Keeping the other side current looks, at each label a gate's things come from, for versions that have been replaced, and offers each to that gate at its own label.";
const atEveryLabel = <T>(fn: () => Promise<T>) => withSystemClearance(REASON, fn);

/**
 * Offer to each gate that names a mandate the versions made at its label
 * since it did, of nodes the other side holds. Offering one already
 * offered changes nothing. The scheduler's work.
 */
export async function noticeChangedVersions(): Promise<number> {
  if (oneLabelOnly()) return 0;
  return atEveryLabel(async () => {
    const gates = await rawQuery<{ boundary_id: string; from_label: string; to_label: string | null; mandate: string; pays: string; since: Date }>(
      `SELECT DISTINCT g.boundary_id, p.from_label, p.to_label, g.keep_current_mandate AS mandate, g.keep_current_micro_usd AS pays, g.keep_current_since AS since
         FROM gates g JOIN redaction_policies p ON p.boundary_id = g.boundary_id AND p.side = 'page'
        WHERE g.keep_current_mandate IS NOT NULL AND g.keep_current_since IS NOT NULL`
    );
    let offered = 0;
    for (const gate of gates) {
      // The version's time is carried as the database wrote it: a JavaScript date would drop its microseconds, and the same version would be offered again.
      const versions = await rawQuery<{ node_id: string; at_exact: string; job: string | null }>(
        `SELECT v.node_id, to_char(v.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_exact, v.job FROM (
           SELECT a.claim_id AS node_id, a.sensitivity_label AS label, a.assessed_at AS at, a.funded_by_job_id AS job FROM assessments_in_force a
           UNION ALL
           SELECT q.claim_id, q.sensitivity_label, q.assessed_at, q.funded_by_job_id FROM quantity_estimates_in_force q
           UNION ALL
           SELECT s.claim_id, s.sensitivity_label, s.assessed_at, s.funded_by_job_id FROM question_assessments_in_force s
         ) v JOIN claims c ON c.id = v.node_id
         WHERE v.label = $1 AND v.at > $2::timestamptz AND c.state = 'active' AND c.sensitivity_label <> v.label
           AND CASE WHEN $3::text IS NULL THEN c.origin = 'mirror'
                    ELSE c.sensitivity_label = ANY (minerval_labels_readable_from(ARRAY[$3::text])) END
           AND NOT EXISTS (
             SELECT 1 FROM showing_pages sp JOIN showings s ON s.id = sp.showing_id
              WHERE s.kind = 'funding' AND s.boundary_id = $4 AND s.subject_ref = v.node_id
                AND sp.header::jsonb ->> 'version_of' = to_char(v.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
         ORDER BY v.at`,
        [gate.from_label, gate.since, gate.to_label, gate.boundary_id]
      );
      for (const v of versions) {
        // Between two labels the mandate named pays for the pass below, and for the Redactor's look at the asking.
        // Toward outside the public mandate pays on the public graph; here the item is the work of the mandate
        // that paid for the version, so a setting for that mandate's work covers it and its budget pays for the
        // Redactor's look.
        const [paidBy] = gate.to_label === null && v.job ? await rawQuery<{ id: string }>(`SELECT id FROM grants WHERE budget_job_id = $1`, [v.job]) : [];
        const item = await offerToGate({
          kind: "funding",
          fromLabel: gate.from_label,
          toLabel: gate.to_label,
          subject: { nodeId: v.node_id, amountMicroUsd: gate.to_label === null ? 0 : Number(gate.pays), versionAt: v.at_exact },
          payer: gate.to_label === null ? (paidBy ? { grantId: paidBy.id } : undefined) : { grantId: gate.mandate },
        }).catch((err: unknown) => {
          console.error(`[gate] could not offer the asking for a fresh assessment of ${v.node_id}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (item) offered++;
      }
    }
    return offered;
  });
}

/**
 * What a page shown outside says of this, stamped by the system
 * (published-page/verify.ts): whether the gate the page left by asks the
 * public graph for a fresh public assessment when a version here changes,
 * and whether a public mandate is named to pay for it. Since a gate asks
 * only where a mandate is named, the two are the same fact; both are kept
 * so that a package reads as earlier ones did.
 */
export async function keepCurrentStamp(boundaryId: string): Promise<{ setting: "on" | "off"; a_public_mandate_pays_for_it: boolean }> {
  const gate = await gateOf(boundaryId);
  const on = !!gate?.keep_current_mandate;
  return { setting: on ? "on" : "off", a_public_mandate_pays_for_it: on };
}

/** Whether any gate to outside asks: for the setup checklist and the preflight. */
export async function keepsPublicCurrent(): Promise<{ asks: boolean; in_words: string }> {
  const [row] = await atEveryLabel(() =>
    rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM gates g JOIN redaction_policies p ON p.boundary_id = g.boundary_id AND p.side = 'page'
        WHERE p.to_outside AND g.keep_current_mandate IS NOT NULL AND g.sensitivity_label = $1`,
      [PUBLIC_LABEL]
    )
  );
  const asks = Number(row?.n ?? 0) > 0;
  return {
    asks,
    in_words: asks
      ? "A gate to outside names a public mandate: when a version of a public node changes at that gate's label, the mandate is asked for a fresh public assessment of the node, through the gate."
      : "No gate to outside names a public mandate, so nothing is asked of the public graph when a version of a public node changes here. An administrator names one on the gate (Gates).",
  };
}
