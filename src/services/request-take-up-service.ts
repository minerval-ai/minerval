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

/** What the record says where an account declines a request addressed to a mandate it published, without having taken it up. */
export const DECLINED_UNTAKEN_SUMMARY = "Says it will not do the work this request asks for, which was addressed to a mandate it published.";

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const daysSince = (d: Date | string) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
const ago = (d: Date | string) => {
  const n = daysSince(d);
  return n === 0 ? "the same day" : n === 1 ? "1 day on" : `${n} days on`;
};

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
  if (!row) {
    // A request addressed to a mandate this account published can be declined without first being taken up: a
    // refusal is a complete answer to a request put to someone, and is part of its record (Part VIII, "Requests").
    const [addressed] = await rawQuery<{ id: string; by: string }>(
      `SELECT r.id, c.display_name AS by FROM requests r JOIN label_faces f ON f.id = r.asked_of_face_id JOIN contributors c ON c.id = f.publisher_account_id
        WHERE r.id = $1 AND f.publisher_account_id = $2
          AND NOT EXISTS (SELECT 1 FROM request_work w WHERE w.request_id = r.id AND w.contributor_id = $2 AND w.taken_up)`,
      [input.requestId, input.accountId]
    );
    if (!addressed) throw new TakeUpError("NOT_TAKEN_UP", "This account is not on the request's record as taking it up, or has already said it will not do the work.");
    await rawQuery(
      `INSERT INTO request_work (request_id, by_label, contributor_id, summary, taken_up, outcome, decline_reason, outcome_at, sensitivity_label)
       VALUES ($1, $2, $3, $4, true, 'declined', $5, now(), $6)`,
      [input.requestId, addressed.by, input.accountId, DECLINED_UNTAKEN_SUMMARY, input.reason, currentLabel()]
    );
    return {
      in_words: `The request's record now says that this account, which it was addressed to, will not do the work, and why: ${DECLINE_REASONS[input.reason as DeclineReason]}.`,
    };
  }
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
    summary: string;
  }>(
    `SELECT request_id, by_label, contributor_id, created_at, outcome, decline_reason, outcome_at, summary
       FROM request_work WHERE request_id = ANY($1::uuid[]) AND taken_up AND contributor_id IS NOT NULL ORDER BY created_at`,
    [requestIds]
  );
  for (const r of rows) {
    const [page] = await rawQuery<{ id: string; node_id: string; node: string | null; state: string; received_at: Date; held_since: string | null }>(
      `SELECT p.id, p.node_id, n.text AS node, k.state, k.received_at, k.package->'page'->'held'->>'since' AS held_since
         FROM published_pages p
         JOIN request_targets t ON t.claim_id = p.node_id AND t.request_id = $1
         JOIN published_page_packages k ON k.published_page_id = p.id
         LEFT JOIN claims n ON n.id = p.node_id
        WHERE p.account_id = $2 AND k.received_at >= $3
        ORDER BY (k.state IN ('released_whole', 'released_in_part')) DESC, k.received_at DESC LIMIT 1`,
      [r.request_id, r.contributor_id, r.created_at]
    );
    const shown = page && (page.state === "released_whole" || page.state === "released_in_part");
    const untaken = r.summary === DECLINED_UNTAKEN_SUMMARY;
    const took = untaken ? "" : `${r.by_label} said on ${day(r.created_at)} that it is taking this request up.`;
    const pageOf = page ? (page.node ? `"${page.node}"` : "a node this request bears on") : "";
    let followed: TakenUp["followed"];
    let words: string;
    if (r.outcome === "declined") {
      // Its own statement stands as it made it. A page it published afterwards is said beside it, and whether that page meets the request is not this record's to say.
      followed = "declined";
      words =
        (untaken
          ? `${r.by_label}, which this request was addressed to, said on ${day(r.outcome_at ?? r.created_at)} that it will not do the work: `
          : `${took} On ${day(r.outcome_at ?? r.created_at)} it said it will not do the work: `) +
        `${DECLINE_REASONS[(r.decline_reason ?? "no_reason") as DeclineReason] ?? DECLINE_REASONS.no_reason}. ` +
        `The reason is its own, chosen from a fixed list, and nobody checks it.` +
        (shown && r.outcome_at && page.received_at.getTime() > r.outcome_at.getTime() ? ` It has since published its graph's page of ${pageOf} (${day(page.received_at)}).` : "");
    } else if (shown) {
      followed = "a_page_shown";
      words = `${took} Since then it has published its graph's page of ${pageOf} (${day(page.received_at)}).`;
    } else if (page) {
      followed = "a_page_held";
      const since = page.held_since ?? page.received_at;
      words =
        `${took} Its graph's page of ${pageOf} is published as ${page.state === "not_yet_assessed" ? "not yet assessed" : "held"}, with nothing of it shown` +
        (page.state === "not_yet_assessed" ? ` (${day(page.received_at)}).` : `: held since ${day(since)}, ${ago(since)}.`);
    } else {
      followed = "nothing_yet";
      words = `${took} Nothing has followed on this graph yet, ${ago(r.created_at)}.`;
    }
    out.set(r.request_id, [
      ...(out.get(r.request_id) ?? []),
      { by: r.by_label, account_id: r.contributor_id, at: r.created_at.toISOString(), followed, in_words: words, published_page_id: page?.id ?? null, node_id: page?.node_id ?? null },
    ]);
  }
  return out;
}
