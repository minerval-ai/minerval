/**
 * Price and fund a fresh maintenance or audit row at once (#363).
 *
 * The scheduler's allocation sweep revalues and funds the whole ledger every
 * few hours; a curation request or an audit that waited for it would sit
 * idle that long, where the queue it replaced ran at once. So a new request
 * prices its own row with the same formulas and lets the mandates that fund
 * that kind take an allocation pass straight away, the way a consistency
 * flag revalues the General mandate the moment it is raised. Nothing here
 * decides differently from the sweep: the same valuations, the same
 * allocator, the same day room. It only decides sooner.
 *
 * Best-effort: a failure leaves the row for the next sweep.
 */
import {
  getGeneralMandate,
  getGovernanceMandateIds,
} from "./allocation-policy-service.js";
import {
  refreshAuditValuations,
  refreshCurateValuations,
} from "./mandate-valuer-service.js";
import { runMandateAllocator } from "./allocation-service.js";

/** A fresh curate row: the General formula prices it, General's allocator passes. */
export async function fundCurationNow(actionId: string): Promise<void> {
  try {
    const general = await getGeneralMandate();
    if (!general) return;
    await refreshCurateValuations(
      general.grantId,
      { scopeClaimId: null, scopeQuery: null },
      actionId
    );
    await runMandateAllocator(general.grantId);
  } catch (err) {
    console.warn(
      `[maintenance] prompt funding of curate ${actionId} failed:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * A fresh audit row: the Governance formula prices it (General's, for an
 * audit of a Governance mandate), and each of those mandates takes a pass.
 * A mandate never funds an audit of itself; the allocator skips such rows.
 */
export async function fundAuditNow(actionId: string): Promise<void> {
  try {
    const valued = await refreshAuditValuations(actionId);
    if (valued === 0) return;
    const governance = await getGovernanceMandateIds();
    const general = await getGeneralMandate();
    const funders = [...governance, ...(general ? [general.grantId] : [])];
    for (const grantId of funders) await runMandateAllocator(grantId);
  } catch (err) {
    console.warn(
      `[maintenance] prompt funding of audit ${actionId} failed:`,
      err instanceof Error ? err.message : err
    );
  }
}
