/**
 * What was once an argument's `evidence_urls` (#541): two different things
 * in one column, now kept apart.
 *
 * - A Lean check reference (`/lean-checks/<id>`) is the check that makes the
 *   argument machine-checked (docs/mathematics.md §2.3). It lives in
 *   arguments.lean_check_id.
 * - Any other URL is a source someone attached to the argument with no
 *   passage and no stance. That is not an instance: §4 asks for the passage
 *   and how it stands toward the argument, read from the source. Each such
 *   URL waits in argument_evidence_backlog, and the claim's Steward is sent
 *   the list, to read each source and record an instance where it makes,
 *   attacks or mentions the argument.
 *
 * A message opens a candidate pass and pays for nothing: whether the pass
 * runs is the ledger's decision, as for any message.
 */
import { rawQuery } from "../db/client.js";
import { enqueueSteward } from "./queue-service.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";

const LEAN_CHECK_PATH = /\/lean-checks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$|\?|#)/i;

/** The lean_checks id a URL names, or null. */
export function leanCheckIdFromUrl(url: string): string | null {
  const m = LEAN_CHECK_PATH.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Attach what a caller gave as an argument's evidence: a Lean check
 * reference sets lean_check_id (when the check exists); every other URL
 * joins the backlog for the Steward. Returns what was done with each.
 */
export async function attachArgumentEvidence(
  argumentId: string,
  urls: readonly string[]
): Promise<{ leanCheckId: string | null; queued: string[]; ignored: string[] }> {
  let leanCheckId: string | null = null;
  const queued: string[] = [];
  const ignored: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;
    const checkId = leanCheckIdFromUrl(url);
    if (checkId) {
      const [check] = await rawQuery<{ id: string }>(`SELECT id FROM lean_checks WHERE id = $1`, [checkId]);
      if (check && !leanCheckId) {
        leanCheckId = check.id;
        await rawQuery(`UPDATE arguments SET lean_check_id = $2 WHERE id = $1`, [argumentId, check.id]);
      } else {
        ignored.push(url);
      }
      continue;
    }
    await rawQuery(
      `INSERT INTO argument_evidence_backlog (argument_id, url, sensitivity_label)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [argumentId, url, currentLabel()]
    );
    queued.push(url);
  }
  return { leanCheckId, queued, ignored };
}

/** The Steward's message for one argument's unsent URLs. */
export function evidenceBacklogMessage(input: {
  argumentId: string;
  argumentName: string | null;
  urls: readonly string[];
}): string {
  const name = input.argumentName ? `"${input.argumentName}" (${input.argumentId})` : input.argumentId;
  return (
    `Argument ${name} on your node had these sources attached to it, with no passage and no stance:\n` +
    input.urls.map((u) => `- ${u}`).join("\n") +
    `\n\nA URL is not an instance (§4). Read each source. Where it makes, attacks or mentions this ` +
    `argument, record it with record_argument_instance, with the passage and how well it states the ` +
    `argument; a source that rests on a different premise makes a different argument (§7). Where it ` +
    `does none of these, record nothing. How many sources an argument has is no measure of it.`
  );
}

/**
 * Send every unsent backlog row to its claim's Steward, one message per
 * argument, and mark the rows sent. With `argumentId`, only that argument's.
 * Rows on a retired or merged argument go too: retiring keeps the record.
 *
 * A backlog row is work waiting, so it carries the label of whoever attached
 * the URL, and the pass its message asks for is opened at that label
 * (src/labels.ts), whether a request or a script does the sending. URLs
 * attached to one argument at two labels go in two messages, one at each.
 */
export async function sendArgumentEvidenceBacklog(
  opts: { argumentId?: string; dryRun?: boolean } = {}
): Promise<Array<{ claimId: string; argumentId: string; urls: string[] }>> {
  const groups = await rawQuery<{
    claim_id: string; argument_id: string; name: string | null; label: string; urls: string[]; ids: string[];
  }>(
    `SELECT a.claim_id, a.id AS argument_id, a.name, b.sensitivity_label AS label,
            array_agg(b.url ORDER BY b.created_at, b.url) AS urls,
            array_agg(b.id::text) AS ids
       FROM argument_evidence_backlog b
       JOIN arguments a ON a.id = b.argument_id
       JOIN claims c ON c.id = a.claim_id
      WHERE b.sent_at IS NULL AND c.state = 'active'
        AND ($1::uuid IS NULL OR a.id = $1::uuid)
      GROUP BY a.claim_id, a.id, a.name, b.sensitivity_label
      ORDER BY a.claim_id, a.id, b.sensitivity_label`,
    [opts.argumentId ?? null]
  );
  const sent: Array<{ claimId: string; argumentId: string; urls: string[] }> = [];
  for (const g of groups) {
    if (!opts.dryRun) {
      await runAtLabel(g.label, `evidence backlog of argument ${g.argument_id}`, () =>
        enqueueSteward({
          claimId: g.claim_id,
          trigger: "argument_evidence_backfill",
          context: evidenceBacklogMessage({ argumentId: g.argument_id, argumentName: g.name, urls: g.urls }),
        })
      );
      await rawQuery(`UPDATE argument_evidence_backlog SET sent_at = now() WHERE id = ANY($1::uuid[])`, [g.ids]);
    }
    sent.push({ claimId: g.claim_id, argumentId: g.argument_id, urls: g.urls });
  }
  return sent;
}
