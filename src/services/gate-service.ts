/**
 * Offering something to a gate (docs/the-gate.md, "What goes down").
 *
 * Information going from a label to readers who do not read it passes a
 * gate, whatever kind of thing it is. A node's page is offered by a flow
 * (showing-service.ts). Everything else is offered here, by the work that
 * produced it, with one call: an answer to a request taken up from the
 * other side, the fact that it was taken up, a mandate's funding of work
 * there, that a mandate exists with its terms, an answer to a message.
 *
 * An item of any kind is recorded the way a node's page is: what is always
 * shown of it, and its parts as written, each resting on the parties whose
 * material it draws on (showing-service.ts, recordVersion). From there the
 * gate is the same for all of them: the setting, the Redactor's run and
 * Audit's check of it, a person where the setting asks for one, the
 * fingerprint, and arrival on the other side (release-gate-service.ts).
 *
 * The offer names rows and passes no text: the item's parts are composed
 * here from the rows, at the label they were written at.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import { GATE_KINDS, type GateKind } from "./gate-kinds.js";
import { gateOf } from "./gate-settings-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { paragraphsOf } from "./page-parts.js";
import { ensureBoundaryPolicy } from "./redaction-policy.js";
import {
  SHOWING_COLUMNS,
  ShowingError,
  bothSides,
  ownOrganizationParty,
  recordVersion,
  type RecordedVersion,
  type ShowingRow,
} from "./showing-service.js";

export type OfferedKind = Exclude<GateKind, "page">;

export interface GateOffer {
  kind: OfferedKind;
  /** The label the thing was produced at. */
  fromLabel: string;
  /** The label it goes to; null for outside the deployment. */
  toLabel: string | null;
  /** The row at `fromLabel` the item is about. For funding: the node on the other side, with the amount. */
  subject: { requestId: string } | { grantId: string } | { messageId: string } | { nodeId: string; amountMicroUsd: number };
  /** The row at `toLabel` that asked, where one did. */
  replyTo?: { requestId: string } | { grantId: string } | { messageId: string };
  /** The mandate whose budget pays the Redactor's run and Audit's check, and, for funding, the work. */
  payer?: { grantId: string };
}

export type OfferState = "released" | "waiting" | "held";

const subjectRefOf = (s: GateOffer["subject"]): string =>
  "requestId" in s ? s.requestId : "grantId" in s ? s.grantId : "messageId" in s ? s.messageId : s.nodeId;
const replyRefOf = (r: GateOffer["replyTo"]): string | null =>
  !r ? null : "requestId" in r ? r.requestId : "grantId" in r ? r.grantId : r.messageId;

/** What the pass that answered concluded, in the words the sender's own label uses for it. */
const OUTCOME_SAID: Record<string, string> = {
  changed: "It changed its assessment.",
  no_change: "It made no change.",
  disagree: "It disagrees.",
};

interface Composed {
  at: Date;
  header: Record<string, unknown>;
  parts: Array<{ kind: string; text: string }>;
}

/**
 * The item's parts, read from the subject's rows at the label they were
 * written at. Every part is text exactly as an agent or a person wrote it
 * there, or a sentence in fixed words. Run at `fromLabel`.
 */
async function compose(offer: GateOffer): Promise<Composed | null> {
  const header = (extra: Record<string, unknown> = {}) => ({ format: "minerval-gate-item/1", kind: offer.kind, what: GATE_KINDS[offer.kind], ...extra, made: {} });
  if (offer.kind === "answer" || offer.kind === "taken_up") {
    const id = (offer.subject as { requestId: string }).requestId;
    const [request] = await rawQuery<{ state: string; state_note: string | null; created_at: Date; updated_at: Date }>(
      `SELECT state, state_note, created_at, updated_at FROM requests WHERE id = $1`,
      [id]
    );
    if (!request) return null;
    if (offer.kind === "taken_up") {
      return {
        at: request.created_at,
        header: header(),
        parts: [{ kind: "fact", text: "This request was taken up by work at a label this one does not read. What that work finds is sent here through the gate when it is ready." }],
      };
    }
    const work = await rawQuery<{ outcome: string; summary: string; by_label: string; created_at: Date }>(
      `SELECT outcome, summary, by_label, created_at FROM request_work WHERE request_id = $1 AND outcome IS NOT NULL ORDER BY created_at, id`,
      [id]
    );
    const closed = ["met", "declined", "withdrawn", "moot"].includes(request.state);
    if (work.length === 0 && !closed) return null;
    return {
      at: work[work.length - 1]?.created_at ?? request.updated_at,
      header: header(),
      parts: [
        { kind: "standing", text: `Where the request stands there: ${request.state.replace(/_/g, " ")}.${request.state_note ? ` ${request.state_note}` : ""}` },
        ...work.flatMap((w) => [
          { kind: "fact", text: `Work by ${w.by_label}, recorded ${w.created_at.toISOString().slice(0, 10)}, with the outcome: ${w.outcome.replace(/_/g, " ")}.` },
          ...paragraphsOf(w.summary).map((text) => ({ kind: "finding", text })),
        ]),
      ],
    };
  }
  if (offer.kind === "mandate") {
    const id = (offer.subject as { grantId: string }).grantId;
    const [grant] = await rawQuery<{ name: string; title: string | null; objective: string | null; status: string; budget: string | null; created_at: Date }>(
      `SELECT g.name, g.mandate->>'title' AS title, g.mandate->>'objective' AS objective, g.status, j.budget_micro_usd AS budget, g.created_at
         FROM grants g LEFT JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
      [id]
    );
    if (!grant) return null;
    return {
      at: grant.created_at,
      header: header(),
      parts: [
        { kind: "fact", text: `A mandate exists at a label this one does not read. It is ${grant.status}.` },
        { kind: "name", text: grant.title ?? grant.name },
        ...paragraphsOf(grant.objective).map((text) => ({ kind: "terms", text })),
        ...(grant.budget ? [{ kind: "amount", text: `Its budget is ${(Number(grant.budget) / 1_000_000).toFixed(2)} owls.` }] : []),
      ],
    };
  }
  if (offer.kind === "message") {
    const id = (offer.subject as { messageId: string }).messageId;
    const [read] = await rawQuery<{ outcome: string | null; outcome_note: string | null; answered_at: Date | null }>(
      `SELECT outcome, outcome_note, answered_at FROM node_message_reads WHERE message_id = $1 AND sensitivity_label = $2`,
      [id, offer.fromLabel]
    );
    if (!read?.outcome || !read.answered_at) return null;
    return {
      at: read.answered_at,
      header: header(),
      parts: [
        { kind: "fact", text: `A pass at a label this one does not read was given this message and answered it. ${OUTCOME_SAID[read.outcome] ?? ""}`.trim() },
        ...paragraphsOf(read.outcome_note).map((text) => ({ kind: "reply", text })),
      ],
    };
  }
  // funding
  const s = offer.subject as { nodeId: string; amountMicroUsd: number };
  const amount = Math.max(0, Math.round(s.amountMicroUsd));
  return {
    at: new Date(),
    // The day is part of what is offered, so that the same amount paid again on a later day is a new item.
    header: header({ amount_micro_usd: amount, offered_on: new Date().toISOString().slice(0, 10) }),
    parts: [
      {
        kind: "amount",
        text:
          amount > 0
            ? `A mandate at a label this one does not read pays ${(amount / 1_000_000).toFixed(2)} owls for a fresh assessment of this node here.`
            : "A mandate at a label this one does not read asks for a fresh assessment of this node here, and pays nothing toward it.",
      },
    ],
  };
}

/** Kinds the public graph has a place for today. The others have none yet (docs/the-gate.md, "Outside"). */
const GOES_OUTSIDE: readonly GateKind[] = ["page"];

/**
 * Offer one thing to the gate between `fromLabel` and `toLabel`. Offering
 * the same thing again while it has not changed returns the item already
 * there; offering it changed opens a new version, and one still waiting
 * for its redaction is not redacted.
 *
 * Returns null where there is nothing to offer: a graph with one label, a
 * destination that already reads `fromLabel`, a subject that is not there
 * or has nothing to say yet.
 */
export async function offerToGate(offer: GateOffer): Promise<{ item_id: string; state: OfferState } | null> {
  if (oneLabelOnly()) return null;
  if (offer.toLabel === null && !GOES_OUTSIDE.includes(offer.kind)) return null;
  return bothSides(async () => {
    const destination = offer.toLabel ?? PUBLIC_LABEL;
    const [reach] = await rawQuery<{ reads: string[] }>(`SELECT minerval_labels_readable_from(ARRAY[$1::text]) AS reads`, [destination]);
    if (offer.toLabel === offer.fromLabel || reach!.reads.includes(offer.fromLabel)) return null;
    const own = await ownOrganizationParty();
    if (!own) return null;
    const composed = await runAtLabel(offer.fromLabel, `composing ${GATE_KINDS[offer.kind]} for the gate`, () => compose(offer));
    if (!composed) return null;
    const policy = await ensureBoundaryPolicy({ from: offer.fromLabel, to: offer.toLabel });
    const gate = (await gateOf(policy.boundary_id))!;
    const subjectRef = subjectRefOf(offer.subject);
    const replyRef = replyRefOf(offer.replyTo);
    let [showing] = await rawQuery<ShowingRow>(
      `SELECT ${SHOWING_COLUMNS} FROM showings WHERE boundary_id = $1 AND kind = $2 AND subject_ref = $3 AND ended_at IS NULL AND sensitivity_label = $4
          AND payer_grant_id IS NOT DISTINCT FROM $5`,
      [policy.boundary_id, offer.kind, subjectRef, offer.fromLabel, offer.payer?.grantId ?? null]
    );
    if (!showing) {
      await withTransaction(async (tx) => {
        const [row] = await tx.query<{ id: string; asked_at: Date }>(
          `INSERT INTO showings (kind, subject_ref, reply_ref, payer_grant_id, to_label, to_outside, boundary_id, form, scope, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'standing', 'item', $8) RETURNING id, asked_at`,
          [offer.kind, subjectRef, replyRef, offer.payer?.grantId ?? null, offer.toLabel, offer.toLabel === null, policy.boundary_id, offer.fromLabel]
        );
        await tx.query(
          `INSERT INTO shown_showings (id, kind, reply_ref, to_outside, boundary_id, form, scope, asked_at, send_as_released, sensitivity_label)
           VALUES ($1, $2, $3, $4, $5, 'standing', 'item', $6, $7, $8)`,
          [row!.id, offer.kind, replyRef, offer.toLabel === null, policy.boundary_id, row!.asked_at, offer.toLabel === null && gate.send_as_released, destination]
        );
        await tx.query(`INSERT INTO showing_acts (showing_id, act, at, sensitivity_label) VALUES ($1, 'offered', $2, $3)`, [row!.id, row!.asked_at, destination]);
      });
      [showing] = await rawQuery<ShowingRow>(
        `SELECT ${SHOWING_COLUMNS} FROM showings WHERE boundary_id = $1 AND kind = $2 AND subject_ref = $3 AND ended_at IS NULL AND sensitivity_label = $4
            AND payer_grant_id IS NOT DISTINCT FROM $5`,
        [policy.boundary_id, offer.kind, subjectRef, offer.fromLabel, offer.payer?.grantId ?? null]
      );
    }
    const versionKey = createHash("sha256")
      .update(JSON.stringify([composed.header, composed.parts]), "utf8")
      .digest("hex");
    const [existing] = await rawQuery<{ id: string }>(`SELECT id FROM showing_pages WHERE showing_id = $1 AND version_key = $2`, [showing!.id, versionKey]);
    const version: RecordedVersion = {
      nodeId: null,
      judgmentKind: null,
      judgmentId: null,
      versionKey,
      at: composed.at,
      header: composed.header,
      // What an agent wrote in answer rests on what its label holds. Whose material that was is not traced
      // for these kinds, so each part is the organization's own to release.
      needs: [own.id],
      sourceIds: [],
      parts: composed.parts.map((p) => ({ kind: p.kind, descriptor: p.kind, refId: null, original: p.text, needs: [own.id] })),
    };
    const itemId = existing?.id ?? (await recordVersion(showing!, destination, version));
    return { item_id: itemId, state: await stateOf(itemId) };
  });
}

async function stateOf(itemId: string): Promise<OfferState> {
  const [row] = await rawQuery<{ shown_at: Date | null; stage: string; held: boolean }>(
    `SELECT p.shown_at, p.stage,
            EXISTS (SELECT 1 FROM showing_acts a WHERE a.page_id = p.id AND a.act = 'held'
                     AND NOT EXISTS (SELECT 1 FROM showing_acts l WHERE l.page_id = p.id AND l.part_id IS NOT DISTINCT FROM a.part_id
                                      AND l.party_id IS NOT DISTINCT FROM a.party_id AND l.act = 'hold_lifted' AND l.at > a.at)) AS held
       FROM shown_pages p WHERE p.id = $1`,
    [itemId]
  );
  if (row?.shown_at) return "released";
  return row?.held || row?.stage === "cannot_cross" ? "held" : "waiting";
}

/** Where the item for a subject stands, for work at the label it came from. Null where nothing was offered. */
export async function gateItemFor(input: { kind: OfferedKind; subjectRef: string; toLabel: string | null }): Promise<{ item_id: string; state: OfferState; offered_at: string } | null> {
  const from = currentLabel();
  return bothSides(async () => {
    const [row] = await rawQuery<{ id: string; opened_at: Date }>(
      `SELECT p.id, p.opened_at FROM showing_pages p JOIN showings s ON s.id = p.showing_id
        WHERE s.kind = $1 AND s.subject_ref = $2 AND s.to_label IS NOT DISTINCT FROM $3 AND s.sensitivity_label = $4 AND p.stage <> 'overtaken'
        ORDER BY p.opened_at DESC LIMIT 1`,
      [input.kind, input.subjectRef, input.toLabel, from]
    );
    return row ? { item_id: row.id, state: await stateOf(row.id), offered_at: row.opened_at.toISOString() } : null;
  });
}

interface BelowOpts {
  replyTo?: { requestId: string };
  toLabel?: string;
  payer?: { grantId: string };
}

async function requestOffer(kind: "answer" | "taken_up", requestIdAbove: string, opts: BelowOpts): Promise<{ item_id: string; state: OfferState } | null> {
  if (oneLabelOnly()) return null;
  return bothSides(async () => {
    const [above] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM requests WHERE id = $1`, [requestIdAbove]);
    if (!above) return null;
    let toLabel = opts.toLabel ?? null;
    let replyTo = opts.replyTo ?? null;
    if (!toLabel || !replyTo) {
      const { answerableBelow } = await import("./request-adoption-service.js");
      const asked = (await answerableBelow(requestIdAbove))?.asked;
      // A request taken up from the public graph is answered there by a published page and a public statement (docs/the-gate.md, "Outside").
      if (!asked || !("request_id" in asked)) return null;
      toLabel ??= asked.label;
      replyTo ??= { requestId: asked.request_id };
    }
    return offerToGate({ kind, fromLabel: above.label, toLabel, subject: { requestId: requestIdAbove }, replyTo, payer: opts.payer });
  });
}

/**
 * Send what work on a request found to the label that asked. Called each
 * time work with an outcome is recorded on a request taken up from another
 * label, and when its keeper closes it.
 */
export const offerAnswerBelow = (requestIdAbove: string, opts: BelowOpts = {}) => requestOffer("answer", requestIdAbove, opts);

/** Tell the label that asked that its request was taken up. Called once, when it is. */
export const offerTakenUpBelow = (requestIdAbove: string, opts: BelowOpts = {}) => requestOffer("taken_up", requestIdAbove, opts);

/**
 * A mandate pays for, or asks for, a fresh assessment of a node at a label
 * that does not read the mandate's own. The asking is itself information
 * going down, so it goes to the gate, and the pass is placed on the other
 * side when it comes through. Run at the mandate's label.
 */
export async function fundBelow(input: { grantId: string; nodeId: string; toLabel: string; amountMicroUsd: number }): Promise<{ item_id: string; state: OfferState } | null> {
  const [grant] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM grants WHERE id = $1`, [input.grantId]);
  if (!grant) throw new ShowingError("MANDATE_NOT_FOUND", "No mandate with that id is read here.");
  return offerToGate({
    kind: "funding",
    fromLabel: grant.label,
    toLabel: input.toLabel,
    subject: { nodeId: input.nodeId, amountMicroUsd: input.amountMicroUsd },
    payer: { grantId: input.grantId },
  });
}

/**
 * Where a gate's flow is set to everything: offer each mandate at the
 * label, with its terms, once and again when its terms change. The
 * scheduler's work, with followShowings.
 */
export async function offerMandatesWhereEverythingFlows(): Promise<number> {
  if (oneLabelOnly()) return 0;
  return bothSides(async () => {
    const gates = await rawQuery<{ boundary_id: string; from_label: string; to_label: string | null }>(
      `SELECT DISTINCT g.boundary_id, p.from_label, p.to_label
         FROM gates g JOIN redaction_policies p ON p.boundary_id = g.boundary_id AND p.side = 'page'
        WHERE g.flow = 'everything' AND NOT p.to_outside`
    );
    let offered = 0;
    for (const g of gates) {
      const grants = await rawQuery<{ id: string }>(`SELECT id FROM grants WHERE sensitivity_label = $1 AND status = 'active' AND NOT is_platform`, [g.from_label]);
      for (const grant of grants) {
        if (await offerToGate({ kind: "mandate", fromLabel: g.from_label, toLabel: g.to_label, subject: { grantId: grant.id } }).catch(() => null)) offered++;
      }
    }
    return offered;
  });
}
