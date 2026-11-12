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
import {
  describeCurationRequest,
  LIVE_CURATION_REQUEST_SELECT,
  type LiveCurationRequest,
} from "./curation-service.js";

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

/** How much of one concern an inbox item carries; the Curator reads it whole. */
const INBOX_CONCERN_CHARS = 800;

/**
 * What the officers read about a curation (#955): for each live request on
 * the anchor, the defect it suspects, who raised it, the other node with its
 * text, and the concern in the requester's words. The label alone is the
 * anchor's text, which says nothing about what is wrong; officers given only
 * that declined every curation as naming "no concrete defect" and bought a
 * first assessment of the anchor instead (2026-11-11).
 *
 * A request-keeper row (claim_id null, #722) has no requests of this kind:
 * its label is the request's ask, which is what it is about.
 */
export function curationSummary(
  r: Pick<Row, "claim_id" | "label">,
  requests: LiveCurationRequest[]
): string {
  if (!r.claim_id) return `A curation is wanted: ${r.label}`;
  const lines = requests.map(
    (q) => `- ${describeCurationRequest(q, r.claim_id, { maxConcernChars: INBOX_CONCERN_CHARS })}`
  );
  return (
    `A curation is wanted around node ${r.claim_id}. What opened it ` +
    `(${requests.length} live request${requests.length === 1 ? "" : "s"}):\n${lines.join("\n")}`
  );
}

/** What the inbox item's detail records of the requests, for a reader that wants fields. */
function curationDetail(r: Row, requests: LiveCurationRequest[]): Record<string, unknown> {
  return {
    action_id: r.id,
    kind: r.kind,
    ...(r.claim_id
      ? {
          defects: [...new Set(requests.map((q) => q.defect ?? "unclassified"))],
          raised_by: [...new Set(requests.map((q) => q.source))],
        }
      : {}),
  };
}

async function liveRequestsFor(anchorClaimId: string, requestId: string | null): Promise<LiveCurationRequest[]> {
  return rawQuery<LiveCurationRequest>(
    `${LIVE_CURATION_REQUEST_SELECT}
      WHERE r.anchor_claim_id = $1 AND r.consumed_at IS NULL
        AND ($2::uuid IS NULL OR r.id = $2::uuid)
      ORDER BY r.created_at ASC LIMIT 20`,
    [anchorClaimId, requestId]
  );
}

/**
 * A fresh curate row: to the General mandate's officers. Given the request
 * that opened it, only that request is raised (a second request on a row
 * still waiting folds into the first item); otherwise every live one. A row
 * on a claim with no live request names no defect and is not raised (#955).
 */
export async function fundCurationNow(actionId: string, opts: { requestId?: string | null } = {}): Promise<void> {
  try {
    const general = await getGeneralMandate();
    const r = await row(actionId);
    if (!general || !r) return;
    const requests = r.claim_id ? await liveRequestsFor(r.claim_id, opts.requestId ?? null) : [];
    if (r.claim_id && requests.length === 0) return;
    await raiseToMandate({
      grantId: general.grantId,
      targetNodeId: r.claim_id,
      targetRef: r.claim_id ? null : r.target_ref,
      source: "the system",
      summary: curationSummary(r, requests),
      detail: curationDetail(r, requests),
    });
  } catch (err) {
    console.warn(`[maintenance] raising curate ${actionId} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Why a waiting curation item was retired, in the words its detail keeps. */
export const CURATION_ITEM_RETIRED_REASON =
  "The ledger closed this curation before an officer decided it: the curate row is no " +
  "longer open (its anchor was merged or archived, its requests were read by a run, " +
  "or no live request on it names a defect), so there is nothing here to commission.";

/**
 * Keep the waiting curation items in the officers' inboxes true to the ledger
 * (#955). Each item is a snapshot taken when its row was raised, and those
 * raised before requests were rendered carry only the anchor's text. So:
 *
 *  - an item whose curate row is no longer open, or whose claim-anchored row
 *    has no live request, is retired: marked handled by `ledger`, with
 *    CURATION_ITEM_RETIRED_REASON in its detail;
 *  - every other waiting curation item is rewritten from the live requests on
 *    its row, so an officer reads what opened it whatever the item's age.
 *
 * Deletes nothing. Scoped to one mandate when given (a sitting), else every
 * mandate (the reconcile sweep). Returns what it changed.
 */
export async function refreshCurationInboxItems(
  grantId: string | null = null
): Promise<{ retired: number; rewritten: number }> {
  const retired = await rawQuery<{ id: string }>(
    `UPDATE mandate_inbox i
        SET handled_at = now(), handled_by = 'ledger',
            detail = i.detail || jsonb_build_object('retired', $2::text)
       FROM actions a
      WHERE i.handled_at IS NULL
        AND ($1::uuid IS NULL OR i.grant_id = $1::uuid)
        AND a.id::text = i.detail->>'action_id' AND a.kind = 'curate'
        AND (a.status NOT IN ('open', 'running')
             OR (a.claim_id IS NOT NULL AND a.status = 'open'
                 AND NOT EXISTS (SELECT 1 FROM curation_requests r
                                  WHERE r.anchor_claim_id = a.claim_id AND r.consumed_at IS NULL)))
      RETURNING i.id`,
    [grantId, CURATION_ITEM_RETIRED_REASON]
  );
  const waiting = await rawQuery<Row & { item_id: string; summary: string }>(
    `SELECT i.id AS item_id, i.summary, a.id, a.kind, a.claim_id, a.target_ref, a.label
       FROM mandate_inbox i JOIN actions a ON a.id::text = i.detail->>'action_id'
      WHERE i.handled_at IS NULL AND a.kind = 'curate' AND a.claim_id IS NOT NULL
        AND ($1::uuid IS NULL OR i.grant_id = $1::uuid)`,
    [grantId]
  );
  let rewritten = 0;
  for (const w of waiting) {
    const requests = await liveRequestsFor(w.claim_id!, null);
    if (requests.length === 0) continue;
    const summary = curationSummary(w, requests).slice(0, 4000);
    if (summary === w.summary) continue;
    await rawQuery(
      `UPDATE mandate_inbox SET summary = $2, detail = detail || $3::jsonb WHERE id = $1`,
      [w.item_id, summary, JSON.stringify(curationDetail(w, requests))]
    );
    rewritten++;
  }
  return { retired: retired.length, rewritten };
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
