/**
 * An account says in public that it is taking a request up
 * (docs/outward-acts.md, "Taking up a request in public").
 *
 * A request may be addressed to whoever holds the evidence (constitution,
 * Part VIII, "Requests"), and what becomes of it, a refusal included, is
 * part of its record. This is how an account that is not one of the graph's
 * own agents puts itself on that record: any account may say it is taking a
 * request up. The statement commits the account to doing the work well, not
 * to a result. It funds nothing and changes nothing about the request: the
 * request's state stays its keeper's, and the work stays open to anyone
 * else.
 *
 * The statement is fixed words, so it needs no review: it says who and
 * when, and nothing the account wrote. What followed is read from the
 * record and never asserted by the account: a page it published on a node
 * the request bears on, its own statement that it will not do the work
 * (with a reason from a fixed list, which nobody checks), or nothing yet,
 * with how long.
 *
 * A private graph uses this like any account, through
 * POST /requests/:request_id/take-up with the organization's key. Nothing
 * here knows what a private graph is.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { CLOSED_REQUEST_STATES } from "../schemas/kinds.js";

export class TakeUpError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Why an account says it will not do work it took up: a fixed list, chosen by the account and checked by nobody. */
export const DECLINE_REASONS = {
  cannot_be_shown: "what the request asks for could not be shown outside the graph that holds it",
  not_held: "it does not hold the evidence the request asks about",
  asks_for_a_result: "the request asks for a particular result",
  moot: "the request no longer bears on anything",
  intrusion: "the request could be met only by intrusion",
  no_reason: "no reason given",
} as const;
export type DeclineReason = keyof typeof DECLINE_REASONS;

export const TAKEN_UP_SUMMARY =
  "Says it is taking this request up. That commits it to doing the work well, not to a result, and funds nothing.";

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export interface TakenUp {
  by: string;
  account_id: string;
  at: string;
  /** What followed, as the record shows it. */
  followed: "a_page_shown" | "a_page_held" | "declined" | "withdrawn" | "nothing_yet";
  in_words: string;
  published_page_id: string | null;
  node_id: string | null;
}

/** Say that the account is taking the request up. One statement per account and request. */
export async function takeUpRequest(input: { requestId: string; accountId: string }): Promise<{ work_id: string; already: boolean; in_words: string }> {
  const [req] = await rawQuery<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [input.requestId]);
  if (!req) throw new TakeUpError("REQUEST_NOT_FOUND", "No request has that id.");
  if ((CLOSED_REQUEST_STATES as readonly string[]).includes(req.state)) {
    throw new TakeUpError("CLOSED", `This request is ${req.state}, so there is nothing left to take up.`);
  }
  const [account] = await rawQuery<{ display_name: string }>(`SELECT display_name FROM contributors WHERE id = $1`, [input.accountId]);
  const [existing] = await rawQuery<{ id: string; outcome: string | null }>(
    `SELECT id, outcome FROM request_work WHERE request_id = $1 AND contributor_id = $2 AND taken_up`,
    [input.requestId, input.accountId]
  );
  if (existing && existing.outcome === null) {
    return { work_id: existing.id, already: true, in_words: "This account is already on the request's record as taking it up. Nothing changed." };
  }
  if (existing) {
    throw new TakeUpError(
      "ALREADY_ANSWERED",
      "This account took this request up before and then said it would not do the work. Both are on the request's record, and it does not take the request up a second time."
    );
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO request_work (request_id, by_label, contributor_id, summary, taken_up, sensitivity_label)
     VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
    [input.requestId, account?.display_name ?? "An account", input.accountId, TAKEN_UP_SUMMARY, currentLabel()]
  );
  return {
    work_id: row!.id,
    already: false,
    in_words:
      "The request's record now says that this account is taking it up, with today's date. It commits the account to doing the work well, not to a " +
      "result, and it funds nothing. The record will show what followed: a page the account publishes on a node the request bears on, its own " +
      "statement that it will not do the work, or nothing yet, with how long.",
  };
}

/** Say that the account will not do the work it took up, with a reason from the fixed list. */
export async function declineTakenUpRequest(input: { requestId: string; accountId: string; reason: string }): Promise<{ in_words: string }> {
  if (!(input.reason in DECLINE_REASONS)) {
    throw new TakeUpError("UNKNOWN_REASON", `A reason is one of: ${Object.keys(DECLINE_REASONS).join(", ")}.`);
  }
  const [row] = await rawQuery<{ id: string }>(
    `UPDATE request_work SET outcome = 'declined', decline_reason = $3, outcome_at = now()
      WHERE request_id = $1 AND contributor_id = $2 AND taken_up AND outcome IS NULL RETURNING id`,
    [input.requestId, input.accountId, input.reason]
  );
  if (!row) throw new TakeUpError("NOT_TAKEN_UP", "This account is not on the request's record as taking it up, or has already said it will not do the work.");
  return {
    in_words: `The request's record now says that this account will not do the work, and why: ${DECLINE_REASONS[input.reason as DeclineReason]}. That it took the request up, and when, stays on the record.`,
  };
}

/**
 * Who has taken each request up, and what followed, read from the record.
 * A page counts as following when the same account published it, on a node
 * the request bears on, and a package of it arrived after the statement.
 */
export async function takenUpOn(requestIds: string[]): Promise<Map<string, TakenUp[]>> {
  const out = new Map<string, TakenUp[]>();
  if (requestIds.length === 0) return out;
  const rows = await rawQuery<{
    request_id: string;
    by_label: string;
    contributor_id: string;
    created_at: Date;
    outcome: string | null;
    decline_reason: string | null;
    outcome_at: Date | null;
  }>(
    `SELECT request_id, by_label, contributor_id, created_at, outcome, decline_reason, outcome_at
       FROM request_work WHERE request_id = ANY($1::uuid[]) AND taken_up AND contributor_id IS NOT NULL ORDER BY created_at`,
    [requestIds]
  );
  for (const r of rows) {
    const [page] = await rawQuery<{ id: string; node_id: string; node: string | null; state: string; received_at: Date }>(
      `SELECT p.id, p.node_id, n.text AS node, k.state, k.received_at
         FROM published_pages p
         JOIN request_targets t ON t.claim_id = p.node_id AND t.request_id = $1
         JOIN published_page_packages k ON k.published_page_id = p.id
         LEFT JOIN claims n ON n.id = p.node_id
        WHERE p.account_id = $2 AND k.received_at >= $3
        ORDER BY (k.state IN ('released_whole', 'released_in_part')) DESC, k.received_at DESC LIMIT 1`,
      [r.request_id, r.contributor_id, r.created_at]
    );
    const shown = page && (page.state === "released_whole" || page.state === "released_in_part");
    const took = `${r.by_label} said on ${day(r.created_at)} that it is taking this request up.`;
    let followed: TakenUp["followed"];
    let words: string;
    if (shown) {
      followed = "a_page_shown";
      words = `${took} Since then it has published its graph's page of ${page.node ? `"${page.node}"` : "a node this request bears on"} (${day(page.received_at)}).`;
    } else if (r.outcome === "declined") {
      followed = "declined";
      words = `${took} On ${day(r.outcome_at ?? r.created_at)} it said it will not do the work: ${DECLINE_REASONS[(r.decline_reason ?? "no_reason") as DeclineReason] ?? DECLINE_REASONS.no_reason}. The reason is its own, chosen from a fixed list, and nobody checks it.`;
    } else if (page) {
      followed = "a_page_held";
      words = `${took} Its graph's page of ${page.node ? `"${page.node}"` : "a node this request bears on"} is published as ${page.state === "not_yet_assessed" ? "not yet assessed" : "held"} (${day(page.received_at)}), with nothing of it shown.`;
    } else {
      followed = "nothing_yet";
      const days = Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000));
      words = `${took} Nothing has followed on this graph yet, ${days === 0 ? "the same day" : days === 1 ? "1 day on" : `${days} days on`}.`;
    }
    out.set(r.request_id, [
      ...(out.get(r.request_id) ?? []),
      { by: r.by_label, account_id: r.contributor_id, at: r.created_at.toISOString(), followed, in_words: words, published_page_id: page?.id ?? null, node_id: page?.node_id ?? null },
    ]);
  }
  return out;
}
