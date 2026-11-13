/**
 * Work asked for from below (docs/architecture.md, "Work asked for from
 * below").
 *
 * Information and funding go up freely. A person or a run at a label
 * cannot read the labels that read it, and the evidence that would settle
 * a question often sits at one of them. So there is one act, the same at
 * every boundary and in every size: from a label, ask for work at a label
 * that reads it, and pay for it. The work is done there, by an agent that
 * reads everything that label reads, under that label's posture
 * (label-posture.ts). What it finds comes down only through the gate.
 *
 * The act has four parts, and nothing else:
 *
 *  1. An address. A label cannot be named from below; its administrators
 *     may give it a face there (label_faces, label-admin-service.ts), and
 *     the ask is addressed to the face. A label with no face the asker can
 *     read cannot be asked.
 *  2. The asker's record: an ordinary request at the asker's label, in the
 *     asker's words, addressed to the face, with the budget paid and
 *     whether it asked for one piece of work or a mandate. It is a row at
 *     the asker's label, read there by the ordinary rules. Nothing that
 *     happens above is ever written to it by this module.
 *  3. The request taken up above (request-adoption-service.ts), by the act
 *     itself: the asker's words are read above like anything below.
 *  4. The money, attached above to what was taken up. For one piece of
 *     work it is a commission on the request's ledger row there, from the
 *     asker's payer (a person's owls, a mandate's escrow, a run's own
 *     budget): an allocation at the label above whose payer is below. The
 *     run that takes the request up is the ordinary one for it. For a
 *     mandate it is the whole budget of a new mandate there, whose terms
 *     are the asker's words: a regrant from a mandate, an escrow from a
 *     person. Its Grantmaker plans and works it as any mandate, and may
 *     close it as it would any scope it should not accept.
 *
 * Money already crosses labels in the one way it needs to: a payer's
 * escrow is the sum of its allocations and regrants wherever they are
 * (minerval_whole), spend is settled against them there, and what is not
 * spent stops counting against the payer or returns to a person's balance.
 * So unspent money comes back by the ordinary settlement and no row below
 * is written. The amount is the payer's own money and is not hidden from
 * its payer. Every account of the work (taken up, declined, what was
 * found, what it cost and why) is the gate's (gate-handoff.ts).
 *
 * The step above runs at the label above (runAtLabel) and hands back
 * nothing but whether it placed the work. A refusal about the payer's own
 * money is the payer's to read. Any other failure above is told below in
 * one fixed sentence, since its reason may be something only that label
 * reads.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel, runAtLabel, runWithUsageContext } from "../llm/usage-context.js";
import { ensureRequestActions } from "./action-service.js";
import { placeCommission, type CommissionPayer } from "./commission-service.js";
import { offerMandateBelow } from "./gate-handoff.js";
import { microUsdToOwls } from "./owl.js";
import { withOwlBalanceLock } from "./owl-ledger-service.js";
import { createRegrant, spawnFundedMandate } from "./regrant-service.js";
import { takeUpFromBelow } from "./request-adoption-service.js";
import { fileRequest, RequestError, type RequestFiler } from "./request-service.js";
import { REQUEST_GROUP } from "./action-service.js";

/** What a mandate made for a request from below records as where it came from (grants.mandate.origin). */
export const ASKED_FROM_BELOW = "asked_from_below";

export interface AskableFace {
  /** What an ask is addressed to. */
  id: string;
  name: string;
  can_be_asked: string;
}

/**
 * The faces work can be asked of from the label of the work in progress:
 * those shown at it or at a label it reads, of labels that read it and
 * that it does not read. Read as the caller, so the database decides which
 * faces there are. A reader who holds the label asked needs no face: they
 * work there directly.
 */
export async function askableFaces(): Promise<AskableFace[]> {
  return rawQuery<AskableFace>(
    `SELECT f.id, f.name, f.can_be_asked
       FROM label_faces f
      WHERE f.withdrawn_at IS NULL
        AND f.for_label <> $1
        AND minerval_layer_below($1, 'local', f.for_label, 'local')
      ORDER BY f.name, f.id`,
    [currentLabel()]
  );
}

export type AskAboveResult =
  | { ok: true; request_id: string; face: { id: string; name: string }; as: "work" | "mandate"; budget_micro_usd: number }
  | {
      ok: false;
      code: "NO_SUCH_FACE" | "BAD_AMOUNT" | "BAD_ASK" | "PAYER" | "NOT_PLACED";
      message: string;
    };

/** What an asker is told when the step above failed for a reason that may be that label's own. */
export const NOT_PLACED_MESSAGE =
  "The work could not be placed there, and nothing was asked or paid. The reason is not shown here, since it may " +
  "rest on what only that label reads. Its administrators can see it.";

const NO_SUCH_FACE = "Nothing that can be asked from here has that id. list_askable (GET /asks/askable) lists what can.";

export interface AskAboveInput {
  faceId: string;
  /** One piece of work (the request, taken up and done once) or a mandate with its own Grantmaker. */
  as: "work" | "mandate";
  ask: string;
  why: string;
  satisfiedBy: string;
  bearsOnText?: string | null;
  claimIds?: string[];
  sourceIds?: string[];
  budgetMicroUsd: number;
  /** Who pays, at the asker's label: a person, a mandate, or the running agent from its own budget. */
  payer: CommissionPayer;
  filer: RequestFiler;
  /** For a mandate: its title. The objective is the ask. */
  title?: string | null;
}

/**
 * Ask for work at a label above and pay for it. On success the caller has
 * its own request's id and what it already knew. Nothing else comes back.
 */
export async function askAbove(input: AskAboveInput): Promise<AskAboveResult> {
  const here = currentLabel();
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) return { ok: false, code: "BAD_AMOUNT", message: "Work asked for is paid for: give a budget above zero." };
  if (input.as === "mandate" && input.payer.kind === "run") {
    return {
      ok: false,
      code: "PAYER",
      message: "A run pays for one piece of work from its budget. A mandate is created by a mandate or by a person who may fund.",
    };
  }
  if (input.as === "mandate" && !input.title?.trim()) {
    return { ok: false, code: "BAD_ASK", message: "A mandate needs a title." };
  }
  // The face is read as the caller: one shown at a label the caller does
  // not read does not exist for it. The label it stands for must read the
  // caller's, so that the work reads everything the asker can say.
  const [face] = await rawQuery<{ id: string; name: string; for_label: string }>(
    `SELECT f.id, f.name, f.for_label FROM label_faces f
      WHERE f.id = $1 AND f.withdrawn_at IS NULL AND f.for_label <> $2
        AND minerval_layer_below($2, 'local', f.for_label, 'local')`,
    [input.faceId, here]
  ).catch(() => []);
  if (!face) return { ok: false, code: "NO_SUCH_FACE", message: NO_SUCH_FACE };

  // 2. The asker's record, at the asker's label.
  let asked: { id: string };
  try {
    asked = await fileRequest({
      ask: input.ask,
      why: input.why,
      satisfiedBy: input.satisfiedBy,
      addressedTo: face.name,
      bearsOnText: input.bearsOnText ?? null,
      claimIds: input.claimIds,
      sourceIds: input.sourceIds,
      // One piece of work is priced at what was paid for it. A mandate's
      // budget is the mandate's, and its Grantmaker prices the work.
      budgetUsd: input.as === "work" ? budget / 1_000_000 : null,
      filer: input.filer,
      askedOf: { faceId: face.id, as: input.as, budgetMicroUsd: budget },
    });
  } catch (err) {
    if (err instanceof RequestError) return { ok: false, code: "BAD_ASK", message: err.message };
    throw err;
  }

  // 3 and 4. Above: take the request up and attach the money. The step
  // carries none of the asking run's own state with it (its budget, its
  // session, its transcript): it is not that run working at another label.
  const above = await atLabelAbove(face.for_label, () => placeAbove(asked.id, input, budget)).catch((err: unknown) => {
    console.error(`[ask-above] placing request ${asked.id} failed:`, err instanceof Error ? err.message : err);
    return { ok: false as const, own: null };
  });
  if (!above.ok) {
    // Nothing was placed, so nothing was asked: what the step left above
    // goes first (a row there is removed by work there), then the record.
    await atLabelAbove(face.for_label, () => removeAbove(asked.id)).catch(() => undefined);
    await rawQuery(`DELETE FROM requests WHERE id = $1`, [asked.id]).catch(() => undefined);
    return above.own
      ? { ok: false, code: "PAYER", message: above.own }
      : { ok: false, code: "NOT_PLACED", message: NOT_PLACED_MESSAGE };
  }
  return { ok: true, request_id: asked.id, face: { id: face.id, name: face.name }, as: input.as, budget_micro_usd: budget };
}

/** Remove, at the label of the work in progress, the take-up of a request below that was never paid for. */
async function removeAbove(askedRequestId: string): Promise<void> {
  const taken = await rawQuery<{ request_id: string }>(
    `SELECT request_id FROM adopted_requests WHERE from_request_id = $1 AND sensitivity_label = $2`,
    [askedRequestId, currentLabel()]
  );
  for (const t of taken) {
    await rawQuery(
      `UPDATE actions SET status = 'cancelled', updated_at = now() WHERE exclusion_group = $1 AND status = 'open'`,
      [REQUEST_GROUP(t.request_id)]
    );
    await rawQuery(`DELETE FROM requests WHERE id = $1`, [t.request_id]);
  }
}

/** Run `fn` at a label above the work in progress, as work of that label and not of the asking run. */
function atLabelAbove<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runAtLabel(label, "work asked for from below", () =>
    runWithUsageContext(
      { agent: undefined, runId: null, trace: undefined, session: undefined, passBudget: undefined, meter: undefined, claimId: null, requestId: null, jobId: null },
      fn
    )
  );
}

/**
 * The step above. `own` on a failure is a refusal about the payer's own
 * money (its balance, its escrow, its pace), which is the payer's to read;
 * every other failure is null.
 */
async function placeAbove(
  askedRequestId: string,
  input: AskAboveInput,
  budget: number
): Promise<{ ok: true } | { ok: false; own: string | null }> {
  const taken = await takeUpFromBelow({ requestId: askedRequestId }, { filer: input.filer });
  if (!taken) return { ok: false, own: null };
  if (input.as === "work") {
    const actionId = await ensureRequestActions(taken.request_id);
    if (!actionId) return { ok: false, own: null };
    // Not exclusive: the asker's money goes on the row whether or not this
    // label's own upkeep had already put some there, so nothing about that
    // is told below. What the run does not spend returns.
    const placed = await placeCommission({
      group: REQUEST_GROUP(taken.request_id),
      actionId,
      claimId: null,
      payer: input.payer,
      budget,
      commissionedBy: input.filer.kind === "admin" ? input.filer.agent : input.filer.kind === "mandate" ? "grantmaker" : "person",
      brief: null,
      reason: "Asked for and paid for from a label this one reads.",
    });
    if (!placed.ok) return { ok: false, own: placed.message };
    return { ok: true };
  }
  const made = await makeMandateAbove(input, budget);
  if (!made.ok) return { ok: false, own: made.own };
  await rawQuery(`UPDATE adopted_requests SET grant_id = $2 WHERE id = $1`, [taken.adoption_id, made.grantId]);
  await offerMandateBelow(made.grantId);
  return { ok: true };
}

/** A mandate at the label of the work in progress, with the asker's words as its terms and the asker's money as its budget. */
async function makeMandateAbove(
  input: AskAboveInput,
  budget: number
): Promise<{ ok: true; grantId: string } | { ok: false; own: string | null }> {
  const title = input.title!.trim();
  const owls = microUsdToOwls(budget);
  if (input.payer.kind === "grant") {
    const res = await spawnFundedMandate({
      fromGrantId: input.payer.grantId,
      title,
      objective: input.ask.trim(),
      owls,
      note: input.why.trim(),
      origin: ASKED_FROM_BELOW,
    });
    return res.ok ? { ok: true, grantId: res.grantId } : { ok: false, own: res.message };
  }
  if (input.payer.kind !== "user") return { ok: false, own: null };
  const userId = input.payer.userId;
  const here = currentLabel();
  const [job] = await rawQuery<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label)
     VALUES ($1, 'grant', 0, 'running', $2) RETURNING id`,
    [userId, here]
  );
  // Escrow behind the balance guard, under the owl-balance lock, as every
  // mandate a person funds is (grant-service.ts createGrant).
  const held = await withOwlBalanceLock(userId, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       SELECT $1, $2, 'escrow_hold', $3
        WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM owl_ledger WHERE user_id = $1) >= $4
       RETURNING id`,
      [userId, -budget, job!.id, budget]
    )
  );
  if (held.length === 0) {
    await rawQuery(`DELETE FROM budget_jobs WHERE id = $1`, [job!.id]);
    return { ok: false, own: `A budget of ${owls} owls is more than your balance.` };
  }
  await rawQuery(`UPDATE budget_jobs SET budget_micro_usd = $2 WHERE id = $1`, [job!.id, budget]);
  const mandate = {
    title,
    objective: input.ask.trim(),
    scope_claim_id: null,
    scope_query: null,
    plan: null,
    expected_cost_owls: owls,
    notes: input.why.trim(),
    origin: ASKED_FROM_BELOW,
  };
  const [grant] = await rawQuery<{ id: string }>(
    `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, mandate, sensitivity_label)
     VALUES ($1, $2, $3, 'agent', 'planning', $4::jsonb, $5) RETURNING id`,
    [userId, job!.id, title, JSON.stringify(mandate), here]
  );
  return { ok: true, grantId: grant!.id };
}

export type AddToAskResult = { ok: true } | { ok: false; code: "NOT_FOUND" | "BAD_AMOUNT" | "PAYER" | "NOT_PLACED"; message: string };

/**
 * Put more money behind something this label asked for above: a regrant to
 * the mandate made for it, or more on the ledger row of the one piece of
 * work. The request is the asker's own record, read as the caller. Whether
 * the work above is still open is that label's to say, so a failure there
 * is the fixed sentence.
 */
export async function addToAsk(input: {
  requestId: string;
  budgetMicroUsd: number;
  payer: CommissionPayer;
  note?: string | null;
}): Promise<AddToAskResult> {
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) return { ok: false, code: "BAD_AMOUNT", message: "Give an amount above zero." };
  const here = currentLabel();
  const [asked] = await rawQuery<{ as: "work" | "mandate"; for_label: string }>(
    `SELECT r.asked_as AS as, f.for_label FROM requests r JOIN label_faces f ON f.id = r.asked_of_face_id
      WHERE r.id = $1 AND r.sensitivity_label = $2`,
    [input.requestId, here]
  );
  if (!asked) return { ok: false, code: "NOT_FOUND", message: "No request at this label that asked for work above has that id." };
  if (asked.as === "mandate" && input.payer.kind !== "grant") {
    return { ok: false, code: "PAYER", message: "More money for a mandate comes from a mandate, as a regrant." };
  }
  const placed = await atLabelAbove(asked.for_label, async (): Promise<{ ok: true } | { ok: false; own: string | null }> => {
    const [link] = await rawQuery<{ request_id: string; grant_id: string | null }>(
      `SELECT request_id, grant_id FROM adopted_requests WHERE from_request_id = $1 AND sensitivity_label = $2`,
      [input.requestId, currentLabel()]
    );
    if (!link) return { ok: false, own: null };
    if (asked.as === "mandate") {
      if (!link.grant_id || input.payer.kind !== "grant") return { ok: false, own: null };
      const res = await createRegrant({
        fromGrantId: input.payer.grantId,
        toGrantId: link.grant_id,
        owls: microUsdToOwls(budget),
        note: input.note ?? undefined,
      });
      if (res.ok) return { ok: true };
      // Whether the mandate above is still live is not the asker's to be told here.
      return { ok: false, own: res.code === "TARGET_NOT_FOUND" ? null : res.message };
    }
    const actionId = await ensureRequestActions(link.request_id);
    if (!actionId) return { ok: false, own: null };
    const res = await placeCommission({
      group: REQUEST_GROUP(link.request_id),
      actionId,
      claimId: null,
      payer: input.payer,
      budget,
      commissionedBy: "person",
      brief: null,
      reason: "More from the label that asked for it.",
    });
    return res.ok ? { ok: true } : { ok: false, own: res.message };
  }).catch((err: unknown) => {
    console.error(`[ask-above] adding to request ${input.requestId} failed:`, err instanceof Error ? err.message : err);
    return { ok: false as const, own: null };
  });
  if (placed.ok) return { ok: true };
  return placed.own
    ? { ok: false, code: "PAYER", message: placed.own }
    : { ok: false, code: "NOT_PLACED", message: NOT_PLACED_MESSAGE };
}

/** What a run is told, once, of what it can ask of labels above it (llm/label-note.ts). */
export function askableNote(faces: readonly AskableFace[]): string {
  if (faces.length === 0) return "";
  return (
    `Work can be asked of ${faces.length === 1 ? "a label" : "labels"} above this one, which this run does not read: ` +
    faces.map((f) => `"${f.name}" (${f.id}): ${f.can_be_asked}`).join("; ") +
    `. What is asked there is done by an agent that reads what that label reads, is paid for from here, and comes ` +
    `back only through that label's gate, where it may be redacted or held.`
  );
}
