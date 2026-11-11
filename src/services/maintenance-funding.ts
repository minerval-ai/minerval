/**
 * A fresh maintenance, audit or request row, put in front of the mandate
 * that pays for that kind of work at once (#363), rather than waiting for a
 * sweep.
 *
 * Curations and work on requests go to the General mandate's program
 * officers, audits to the Governance mandates' (General's, for an audit of a
 * Governance mandate, so no mandate funds an audit of itself). The officers
 * decide under their mandate's operating policy whether to commission the
 * row and at what budget. Nothing here prices or funds anything.
 *
 * Best-effort: a failure leaves the row open on the ledger, where a lookout
 * or a later sitting can find it.
 */
import { rawQuery } from "../db/client.js";
import { getGeneralMandate, getGovernanceMandateIds } from "./allocation-policy-service.js";
import { raiseToMandate } from "./mandate-inbox-service.js";

interface Row {
  id: string;
  kind: string;
  claim_id: string | null;
  target_ref: string | null;
  label: string;
}

async function row(actionId: string): Promise<Row | null> {
  const [r] = await rawQuery<Row>(
    `SELECT id, kind, claim_id, target_ref, label FROM actions WHERE id = $1`,
    [actionId]
  );
  return r ?? null;
}

async function raise(grantId: string, r: Row, summary: string): Promise<void> {
  await raiseToMandate({
    grantId,
    targetNodeId: r.claim_id,
    targetRef: r.claim_id ? null : r.target_ref,
    source: "the system",
    summary,
    detail: { action_id: r.id, kind: r.kind },
  });
}

/**
 * What the officers read about a curation: the concern each live request on
 * the anchor recorded, who raised it, and the other claim it names. The
 * label alone is the anchor's text, which says nothing about what is wrong;
 * officers given only that declined every curation as naming "no concrete
 * defect" and bought a first assessment of the anchor instead.
 */
export function curationSummary(
  label: string,
  requests: Array<{ source: string; concern: string; other_claim_id: string | null; signal: number | null }>
): string {
  if (requests.length === 0) return `A curation is wanted: ${label}`;
  const lines = requests.map(
    (q) =>
      `- ${q.source}: ${q.concern.trim()}` +
      (q.other_claim_id ? ` (other claim ${q.other_claim_id})` : "") +
      (q.signal != null ? ` (similarity ${q.signal.toFixed(2)})` : "")
  );
  return `A curation is wanted on ${label}\nThe concern${requests.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

/**
 * A fresh curate row: to the General mandate's officers. Given the request
 * that opened it, only that request's concern is raised (a second request on
 * a row still waiting folds into the first item); otherwise every live one.
 */
export async function fundCurationNow(actionId: string, opts: { requestId?: string | null } = {}): Promise<void> {
  try {
    const general = await getGeneralMandate();
    const r = await row(actionId);
    if (!general || !r) return;
    const requests = r.claim_id
      ? await rawQuery<{ source: string; concern: string; other_claim_id: string | null; signal: number | null }>(
          `SELECT source, concern, other_claim_id, signal FROM curation_requests
            WHERE anchor_claim_id = $1 AND consumed_at IS NULL
              AND ($2::uuid IS NULL OR id = $2::uuid)
            ORDER BY created_at ASC LIMIT 20`,
          [r.claim_id, opts.requestId ?? null]
        )
      : [];
    await raise(general.grantId, r, curationSummary(r.label, requests));
  } catch (err) {
    console.warn(`[maintenance] raising curate ${actionId} failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * A fresh audit row: to each Governance mandate that isn't its subject, and
 * to General for an audit of a Governance mandate.
 */
export async function fundAuditNow(actionId: string, opts: { note?: string } = {}): Promise<void> {
  try {
    const r = await row(actionId);
    if (!r) return;
    const [run] = await rawQuery<{ subject_grant_id: string | null }>(
      `SELECT subject_grant_id FROM audit_runs WHERE id::text = $1`,
      [r.target_ref ?? ""]
    );
    const governance = await getGovernanceMandateIds();
    const general = await getGeneralMandate();
    const subject = run?.subject_grant_id ?? null;
    const funders = governance.filter((g) => g !== subject);
    if (funders.length === 0 && general && general.grantId !== subject) funders.push(general.grantId);
    const summary = `An audit is wanted: ${r.label}` + (opts.note ? ` ${opts.note}` : "");
    for (const grantId of funders) await raise(grantId, r, summary);
  } catch (err) {
    console.warn(`[maintenance] raising audit ${actionId} failed:`, err instanceof Error ? err.message : err);
  }
}

/** A fresh request row: to the General mandate's officers. */
export async function fundRequestNow(actionId: string): Promise<void> {
  try {
    const general = await getGeneralMandate();
    const r = await row(actionId);
    if (!general || !r) return;
    await raise(general.grantId, r, `Work on a request is wanted: ${r.label}`);
  } catch (err) {
    console.warn(`[maintenance] raising request ${actionId} failed:`, err instanceof Error ? err.message : err);
  }
}
