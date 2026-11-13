/**
 * Taking up a request from the layer below (docs/architecture.md, "Word
 * from the layer below").
 *
 * A label reads everything at the labels it reads, the public graph's
 * requests through the mirror among it. A request filed below asks for
 * something that work above may be the one able to do, with material the
 * asker cannot read. But the request is the lower layer's row: its work
 * runs at its own label (src/labels.ts), and nothing above may write to it
 * or to its ledger rows, since whatever is written there is read by the
 * layer below as its own.
 *
 * So the work above takes the request up as a request of its own: an
 * ordinary request at the label of the work that takes it up, carrying the
 * words and the targets of the one below, linked to it by an
 * `adopted_requests` row at the same label. From there it is any request:
 * a mandate at that label funds it, the Researcher does it with what that
 * label reads, its keeper there judges whether it is met, and all of it is
 * recorded at that label. One mechanism serves both boundaries. For the
 * public graph the request below is the mirror's (`public_request_id`);
 * between two labels it is a row of `requests` (`from_request_id`).
 *
 * Nothing goes down. The request below is not written to, and its readers
 * are shown neither that it was taken up nor what was found: that is
 * information from a label they may not read, and it goes down through the
 * gate or not at all. The link is what a later answer downward starts from
 * (answerableBelow).
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { fileRequest, RequestError, type RequestFiler } from "./request-service.js";

/** The request below: the public graph's, from the mirror, or one at a label this work reads. */
export type RequestBelow = { publicRequestId: string } | { requestId: string };

export interface TakenUpAbove {
  adoption_id: string;
  /** The request at this label that the work is done on. */
  request_id: string;
  /** True when this label had already taken it up, and nothing was added. */
  already: boolean;
}

interface Words {
  ask: string;
  why: string;
  satisfied_by: string;
  who_could: string | null;
  addressed_to: string | null;
  bears_on_text: string | null;
  budget_micro_usd?: string | null;
}

/**
 * Take the request up at the label this work runs at. Idempotent: a label
 * takes a request up once, and a second call returns the first.
 *
 * A request at this work's own label is not taken up: it is already this
 * label's to work, and the caller is told so (null).
 */
export async function takeUpFromBelow(
  from: RequestBelow,
  by: { filer: RequestFiler; contributorId?: string | null }
): Promise<TakenUpAbove | null> {
  const label = currentLabel();
  const isPublic = "publicRequestId" in from;
  const id = isPublic ? from.publicRequestId : from.requestId;
  const column = isPublic ? "public_request_id" : "from_request_id";
  let words: Words | undefined;
  let claimIds: string[] = [];
  let sourceIds: string[] = [];
  if (isPublic) {
    [words] = await rawQuery<Words>(
      `SELECT ask, why, satisfied_by, who_could, addressed_to, bears_on_text FROM feed_requests WHERE id = $1 AND origin = 'mirror'`,
      [id]
    );
    if (!words) throw new RequestError("The mirror holds no public request with that id.");
    claimIds = (
      await rawQuery<{ claim_id: string }>(
        `SELECT t.claim_id FROM feed_request_targets t JOIN claims c ON c.id = t.claim_id WHERE t.request_id = $1`,
        [id]
      )
    ).map((t) => t.claim_id);
  } else {
    const [row] = await rawQuery<Words & { label: string }>(
      `SELECT ask, why, satisfied_by, who_could, addressed_to, bears_on_text, budget_micro_usd, sensitivity_label AS label
         FROM requests WHERE id = $1`,
      [id]
    );
    if (!row) throw new RequestError(`Request ${id} not found`);
    if (row.label === label) return null;
    // Up, never down or across: the request's layer lies below the one that
    // takes it up (services/layer-service.ts). The database holds a run to that already;
    // work that sees every label is held to it here, in the same words as
    // for a request that does not exist.
    const [reads] = await rawQuery<{ ok: boolean }>(`SELECT minerval_layer_below($1, 'local', $2, 'local') AS ok`, [row.label, label]);
    if (!reads?.ok) throw new RequestError(`Request ${id} not found`);
    words = row;
    const targets = await rawQuery<{ claim_id: string | null; source_id: string | null }>(
      `SELECT t.claim_id, t.source_id FROM request_targets t
         LEFT JOIN claims c ON c.id = t.claim_id
        WHERE t.request_id = $1 AND (t.claim_id IS NULL OR c.state = 'active') ORDER BY t.id`,
      [id]
    );
    claimIds = targets.flatMap((t) => (t.claim_id ? [t.claim_id] : []));
    sourceIds = targets.flatMap((t) => (t.source_id ? [t.source_id] : []));
  }
  const [existing] = await rawQuery<{ id: string; request_id: string }>(
    `SELECT id, request_id FROM adopted_requests WHERE ${column} = $1 AND sensitivity_label = $2 ORDER BY adopted_at LIMIT 1`,
    [id, label]
  );
  if (existing) return { adoption_id: existing.id, request_id: existing.request_id, already: true };
  const filed = await fileRequest({
    ask: words.ask,
    why: words.why,
    satisfiedBy: words.satisfied_by,
    whoCould: words.who_could,
    addressedTo: words.addressed_to,
    bearsOnText:
      words.bears_on_text ??
      (claimIds.length === 0 && sourceIds.length === 0
        ? isPublic
          ? "What the public request describes."
          : "What the request it was taken up from describes."
        : null),
    claimIds,
    sourceIds,
    budgetUsd: words.budget_micro_usd == null ? null : Number(words.budget_micro_usd) / 1_000_000,
    filer: by.filer,
  });
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO adopted_requests (request_id, ${column}, adopted_by, sensitivity_label) VALUES ($1, $2, $3, $4) RETURNING id`,
    [filed.id, id, by.contributorId ?? null, label]
  );
  return { adoption_id: row!.id, request_id: filed.id, already: false };
}

/** What an agent is told when a tool it called on a request below acted on this label's own request instead. */
export function takenUpAboveNote(below: { id: string; label: string }, here: { id: string; label: string }): string {
  return (
    `Request ${below.id} was filed at \`${below.label}\`, which this run reads and does not change. It is taken up ` +
    `at \`${here.label}\` as request ${here.id}, linked to it, and that is the request this acted on. Readers at ` +
    `\`${below.label}\` are not shown that it was taken up or what was found.`
  );
}

/**
 * The request a tool at this label acts on when it is handed `requestId`:
 * the request itself where it is at this label, and this label's take-up
 * of it where it was filed at a label below, taken up now if it had not
 * been. `note` is what the caller is told in the second case. A request
 * that does not exist (or that this work does not read) comes back as it
 * was given, for the caller's own "not found".
 */
export async function requestToActOn(
  requestId: string,
  filer: RequestFiler
): Promise<{ id: string; note: string | null }> {
  const label = currentLabel();
  const [req] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM requests WHERE id = $1`, [requestId]);
  if (!req || req.label === label) return { id: requestId, note: null };
  // A request at a label this one does not read is not taken up, and the
  // caller goes on with the id it was given, as before there was a take-up.
  const taken = await takeUpFromBelow({ requestId }, { filer }).catch((err: unknown) => {
    if (err instanceof RequestError) return null;
    throw err;
  });
  if (!taken) return { id: requestId, note: null };
  return { id: taken.request_id, note: takenUpAboveNote({ id: requestId, label: req.label }, { id: taken.request_id, label }) };
}

export interface AnswerableBelow {
  adoption_id: string;
  /** The request below that asked, and the label its asker reads at: where an answer would go. */
  asked: { request_id: string; label: string } | { public_request_id: string };
  /** The request above that the work was done on, its label and where it stands. */
  answered_by: { request_id: string; label: string; state: string };
}

/**
 * The seam for answers going down. For a request taken up above, what a
 * later piece needs to send its answer back to the asker through the gate:
 * the request that asked and its label, and the request above whose work
 * log and keeper's note are the answer. Nothing calls this yet: no answer
 * is sent down, and the request below shows nothing new. It reads as the
 * caller, so it returns only take-ups the caller reads.
 */
export async function answerableBelow(requestIdAbove: string): Promise<AnswerableBelow | null> {
  const [row] = await rawQuery<{
    id: string; public_request_id: string | null; from_request_id: string | null; from_label: string | null;
    request_id: string; label: string; state: string;
  }>(
    `SELECT a.id, a.public_request_id, a.from_request_id, f.sensitivity_label AS from_label,
            a.request_id, a.sensitivity_label AS label, r.state
       FROM adopted_requests a JOIN requests r ON r.id = a.request_id
       LEFT JOIN requests f ON f.id = a.from_request_id
      WHERE a.request_id = $1`,
    [requestIdAbove]
  );
  if (!row) return null;
  return {
    adoption_id: row.id,
    asked: row.from_request_id
      ? { request_id: row.from_request_id, label: row.from_label! }
      : { public_request_id: row.public_request_id! },
    answered_by: { request_id: row.request_id, label: row.label, state: row.state },
  };
}
