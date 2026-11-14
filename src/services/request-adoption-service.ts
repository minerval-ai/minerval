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
import { PUBLIC_LABEL } from "../labels.js";
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
  by: {
    filer: RequestFiler;
    contributorId?: string | null;
    /** Taken up only so that it can be declined on the record (declineFromBelow): the asker is not told it was taken up. */
    toDecline?: boolean;
  }
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
  if (by.toDecline) return { adoption_id: row!.id, request_id: filed.id, already: false };
  // That it was taken up is told to whoever asked, through the gate between the two (gate-service.ts): the
  // label below, or, for a request on the public graph that was addressed to a mandate this deployment
  // published, the public graph. Any other public request was asked of nobody here, so nothing is said of it
  // unless a person says so.
  await offerDown("taken_up", filed.id);
  // What the public asked for flows to the gate to outside when it is ready: the page of each node the request bears on.
  await flowWhereThePublicAsked(filed.id, claimIds).catch((err: unknown) =>
    console.error(`[gate] could not set the flow of pages for request ${filed.id}: ${err instanceof Error ? err.message : String(err)}`)
  );
  return { adoption_id: row!.id, request_id: filed.id, already: false };
}

/** What an agent is told when a tool it called on a request below acted on this label's own request instead. */
export function takenUpAboveNote(below: { id: string; label: string }, here: { id: string; label: string }): string {
  return (
    `Request ${below.id} was filed at \`${below.label}\`, which this run reads and does not change. It is taken up ` +
    `at \`${here.label}\` as request ${here.id}, linked to it, and that is the request this acted on. That it was taken up, and what the ` +
    `work finds, go to readers at \`${below.label}\` through the gate between the two labels, which may remove from it or hold it.`
  );
}

/** What an agent is told when a tool it called on a request of the public graph acted on this label's own request instead. */
export function takenUpFromPublicNote(publicRequestId: string, here: { id: string; label: string }): string {
  return (
    `Request ${publicRequestId} is the public graph's, which this run reads through the mirror and does not change. It is taken up ` +
    `at \`${here.label}\` as request ${here.id}, linked to it, and that is the request this acted on. Where it was addressed to a mandate this ` +
    `graph published, that it was taken up is said on the public graph, and the page of each node it bears on goes to the gate to outside ` +
    `as it is assessed here, where it may have passages removed or be held.`
  );
}

/**
 * The reasons a request from below is declined for, as its asker is told:
 * the public graph's fixed list (request-take-up-service.ts,
 * DECLINE_REASONS), used at every boundary so that a decline says the same
 * thing wherever it is read.
 */
export const DECLINE_FROM_BELOW_REASONS = ["cannot_be_shown", "not_held", "asks_for_a_result", "moot", "intrusion", "no_reason"] as const;

/**
 * Decline, at this label, a request filed below it: the public graph's, or
 * one at a label this work reads. The decision is this label's own record:
 * the request is taken up here only to be closed as declined, with the
 * reason from the fixed list and a note that stays at this label. The asker
 * is told through the gate that the work will not be done and why, in the
 * reason's fixed words, and is not told that it was taken up.
 */
export async function declineFromBelow(
  from: RequestBelow,
  input: { reason: string; note: string; filer: RequestFiler }
): Promise<{ request_id: string; already: boolean }> {
  if (!(DECLINE_FROM_BELOW_REASONS as readonly string[]).includes(input.reason)) {
    throw new RequestError(`A reason is one of: ${DECLINE_FROM_BELOW_REASONS.join(", ")}.`);
  }
  if (!input.note.trim()) throw new RequestError("A request declined says why.");
  const taken = await takeUpFromBelow(from, { filer: input.filer, toDecline: true });
  if (!taken) throw new RequestError("That request is at this label already: its keeper closes it.");
  const [state] = await rawQuery<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [taken.request_id]);
  if (state && ["met", "declined", "withdrawn", "moot"].includes(state.state)) return { request_id: taken.request_id, already: true };
  // The reason is on the record before the request closes, since closing is what offers the answer to the gate.
  await rawQuery(`UPDATE adopted_requests SET decline_reason = $2 WHERE id = $1`, [taken.adoption_id, input.reason]);
  const { setRequestState } = await import("./request-service.js");
  await setRequestState({ requestId: taken.request_id, state: input.reason === "moot" ? "moot" : "declined", note: input.note });
  return { request_id: taken.request_id, already: false };
}

/**
 * Where a request taken up here goes back, by the links below it, to a
 * request on the public graph that was addressed to a mandate this
 * deployment published: set a standing flow, to the gate to outside, of
 * the page of each node it bears on, from this label. It is what the
 * public asked for, so it flows without anyone setting it, and each page
 * then goes through the gate under its setting.
 */
async function flowWhereThePublicAsked(requestIdHere: string, claimIds: readonly string[]): Promise<void> {
  if (claimIds.length === 0) return;
  // A halting bound on the walk down the links; no chain of labels is this long.
  let id = requestIdHere;
  let publicRequestId: string | null = null;
  for (let depth = 0; depth < 20 && !publicRequestId; depth++) {
    const [link] = await rawQuery<{ public_request_id: string | null; from_request_id: string | null }>(
      `SELECT public_request_id, from_request_id FROM adopted_requests WHERE request_id = $1`,
      [id]
    );
    if (!link) return;
    publicRequestId = link.public_request_id;
    if (!link.from_request_id) break;
    id = link.from_request_id;
  }
  if (!publicRequestId) return;
  const gate = await import("./gate-service.js");
  const mandate = await gate.publishedMandateAskedBy(publicRequestId);
  if (!mandate) return;
  const { flowForWhatWasAsked } = await import("./showing-service.js");
  for (const nodeId of claimIds) await flowForWhatWasAsked({ nodeId, pageLabel: currentLabel(), toLabel: null, askedBy: publicRequestId });
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
  if (!req) {
    // A request on the public graph, as the mirror brought it, is the layer below every label of a deployment.
    // It is taken up at this label like any other, unless this label is `public`: work at `public` on what the
    // public graph holds is the public graph's own.
    const [mirrored] = label === PUBLIC_LABEL ? [] : await rawQuery<{ id: string }>(`SELECT id FROM feed_requests WHERE id = $1 AND origin = 'mirror'`, [requestId]).catch(() => []);
    if (!mirrored) return { id: requestId, note: null };
    const taken = await takeUpFromBelow({ publicRequestId: requestId }, { filer });
    if (!taken) return { id: requestId, note: null };
    return { id: taken.request_id, note: takenUpFromPublicNote(requestId, { id: taken.request_id, label }) };
  }
  if (req.label === label) return { id: requestId, note: null };
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

/**
 * Offer to the gate what a request taken up here has to say to the label
 * that asked: that it was taken up, or what work on it found. A failure
 * here must not undo the work it reports, so it is logged and the next
 * offer (the next work recorded, or the request's closing) sends it.
 */
export async function offerDown(kind: "taken_up" | "answer" | "statement", requestIdAbove: string): Promise<void> {
  try {
    const gate = await import("./gate-service.js");
    await (kind === "taken_up" ? gate.offerTakenUpBelow(requestIdAbove) : kind === "answer" ? gate.offerAnswerBelow(requestIdAbove) : gate.offerStatementBelow(requestIdAbove));
  } catch (err) {
    console.error(`[gate] could not offer ${kind} for request ${requestIdAbove}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
