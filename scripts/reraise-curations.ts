/**
 * Put back before the General mandate's officers the curations they decided
 * on the anchor's text alone (#955).
 *
 * Until #926 a curation reached the officers as "A curation is wanted:
 * Curate around: <the anchor's text>", without the concern its request
 * recorded. On 2026-11-11 the officers declined such items as naming "no
 * duplicate, conflation, wrong-kind issue or other concrete defect"; the
 * requests (most from the Matcher's curator_review at ingestion) were live
 * all along, and their rows still stand open on the ledger with nothing in
 * the inbox to decide them.
 *
 * What it touches: for each curate row that is open, on an active anchor
 * with at least one live curation request, that has a handled item in the
 * General mandate's inbox carrying the old rendering and no item waiting,
 * it raises the row again (maintenance-funding.ts fundCurationNow): one new
 * mandate_inbox item, which states each live request's defect, who raised
 * it, the other node with its text, and the concern. Nothing is deleted,
 * nothing is commissioned, no request or row is changed; the officers decide
 * the new items under the operating policy, as any curation. Waiting items
 * are not this script's: a sitting rewrites them from the live requests
 * itself (refreshCurationInboxItems), and the reconcile sweep retires those
 * whose row has closed.
 *
 * Safe by default: prints what it WOULD raise and exits. Pass `--confirm` to
 * raise them. Officer sittings run as usual afterwards when enabled.
 *
 *   npx tsx scripts/reraise-curations.ts             # dry run
 *   npx tsx scripts/reraise-curations.ts --confirm
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { getGeneralMandate } from "../src/services/allocation-policy-service.js";
import { fundCurationNow } from "../src/services/maintenance-funding.js";

/** How an item read before #926: the anchor's text and nothing else. */
const BARE_RENDERING = "A curation is wanted: Curate around:%";

interface Candidate {
  action_id: string;
  claim_id: string;
  label: string;
  live_requests: number;
  last_decided: string;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const general = await getGeneralMandate();
  if (!general) {
    console.log("No active General mandate: nothing to raise to.");
    await closeDb();
    return;
  }
  const candidates = await rawQuery<Candidate>(
    `SELECT a.id AS action_id, a.claim_id, a.label,
            (SELECT COUNT(*)::int FROM curation_requests r
              WHERE r.anchor_claim_id = a.claim_id AND r.consumed_at IS NULL) AS live_requests,
            MAX(i.handled_at)::text AS last_decided
       FROM actions a
       JOIN claims c ON c.id = a.claim_id AND c.state = 'active'
       JOIN mandate_inbox i ON i.grant_id = $1 AND i.detail->>'action_id' = a.id::text
                           AND i.handled_at IS NOT NULL AND i.summary LIKE $2
      WHERE a.kind = 'curate' AND a.status = 'open'
        AND EXISTS (SELECT 1 FROM curation_requests r
                     WHERE r.anchor_claim_id = a.claim_id AND r.consumed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM mandate_inbox w
                         WHERE w.grant_id = $1 AND w.handled_at IS NULL
                           AND w.detail->>'action_id' = a.id::text)
      GROUP BY a.id, a.claim_id, a.label
      ORDER BY MAX(i.handled_at)`,
    [general.grantId, BARE_RENDERING]
  );

  console.log(
    `Open curate rows the General mandate's officers decided on the anchor's text alone, ` +
      `with live requests and nothing waiting: ${candidates.length}`
  );
  for (const c of candidates) {
    console.log(
      `  ${c.action_id}  anchor ${c.claim_id}  requests=${c.live_requests}  decided ${c.last_decided}  ` +
        `${c.label.slice(0, 70)}`
    );
  }
  if (!confirm) {
    console.log("\nDry run: re-run with --confirm to raise each again, with what opened it.");
    await closeDb();
    return;
  }
  for (const c of candidates) await fundCurationNow(c.action_id);
  console.log(`\nRaised ${candidates.length} curation(s) to the General mandate's officers.`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
