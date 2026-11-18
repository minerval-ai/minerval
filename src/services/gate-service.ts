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
  subject:
    | { requestId: string }
    | { grantId: string }
    | { messageId: string }
    | { petitionId: string }
    | { reportId: string }
    | { proposalId: string }
    /** `versionAt`: the version at `fromLabel` whose change is the reason for asking, where there is one. */
    | { nodeId: string; amountMicroUsd: number; versionAt?: string };
  /** The row at `toLabel` that asked, where one did. Toward outside, the public graph's own id for it. */
  replyTo?: { requestId: string } | { grantId: string } | { messageId: string };
  /** The mandate whose budget pays the Redactor's run and Audit's check, and, for funding, the work. */
  payer?: { grantId: string };
}

export type OfferState = "released" | "waiting" | "held";

const subjectRefOf = (s: GateOffer["subject"]): string =>
  "requestId" in s
    ? s.requestId
    : "grantId" in s
      ? s.grantId
      : "messageId" in s
        ? s.messageId
        : "petitionId" in s
          ? s.petitionId
          : "reportId" in s
            ? s.reportId
            : "proposalId" in s
              ? s.proposalId
              : s.nodeId;
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
  /** `needs`: the parties besides the organization itself whose material the part rests on, where that is known. */
  parts: Array<{ kind: string; text: string; needs?: string[] }>;
}

/** What an account says when it will not do work a request asks for: the public graph's fixed list (request-take-up-service.ts). */
const DECLINED_BECAUSE: Record<string, string> = {
  cannot_be_shown: "what the request asks for could not be shown outside the graph that holds it",
  not_held: "it does not hold the evidence the request asks about",
  asks_for_a_result: "the request asks for a particular result",
  moot: "the request no longer bears on anything",
  intrusion: "the request could be met only by intrusion",
  no_reason: "no reason given",
};

/**
 * The parties, other than the organization itself, whose material a piece
 * of work on a request drew on: the party of each connection its run
 * called, of each set of files its run had mounted for a command, and of
 * each source the request bears on. A run is recorded with every set it had
 * mounted and every call it made, and the deployment cannot tell which of
 * them a sentence of its report rests on, so each paragraph of the report
 * rests on all of them. Run at the label the work was done at.
 */
async function partiesOfWork(requestId: string, researchRunId: string | null): Promise<string[]> {
  const out = new Set<string>();
  const bearsOn = await rawQuery<{ party_id: string | null }>(
    `SELECT s.party_id FROM request_targets t JOIN sources s ON s.id = t.source_id WHERE t.request_id = $1 AND s.party_id IS NOT NULL`,
    [requestId]
  );
  for (const r of bearsOn) if (r.party_id) out.add(r.party_id);
  if (researchRunId) {
    const [run] = await rawQuery<{ run_id: string | null }>(`SELECT run_id FROM research_runs WHERE id = $1`, [researchRunId]);
    if (run?.run_id) {
      const calls = await rawQuery<{ party_id: string | null }>(`SELECT DISTINCT party_id FROM connection_calls WHERE run_id = $1 AND party_id IS NOT NULL`, [run.run_id]);
      for (const c of calls) if (c.party_id) out.add(c.party_id);
      const commands = await rawQuery<{ file_sets: Array<{ party_id?: string }> | null }>(`SELECT file_sets FROM sandbox_calls WHERE run_id = $1`, [run.run_id]);
      for (const c of commands) for (const set of c.file_sets ?? []) if (typeof set.party_id === "string") out.add(set.party_id);
    }
  }
  return [...out];
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
        parts: [
          {
            kind: "fact",
            text:
              offer.toLabel === null
                ? "This graph is taking this request up. That commits it to doing the work well, not to a result."
                : "This request was taken up by work at a label this one does not read. What that work finds is sent here through the gate when it is ready.",
          },
        ],
      };
    }
    const closed = ["met", "declined", "withdrawn", "moot"].includes(request.state);
    if (offer.toLabel === null) {
      // The public graph takes words from an account only as a contribution it reviews, which is what a published
      // page is. So what work found goes outside as the page of each node the request bears on, by the flow set for
      // it, and the answer itself says one thing in fixed words: that the work will not be done, and why, from the
      // public graph's own list of reasons. A request that was met says nothing here: its page is its answer.
      if (!closed || request.state === "met") return null;
      const [taken] = await rawQuery<{ reason: string | null }>(`SELECT decline_reason AS reason FROM adopted_requests WHERE request_id = $1`, [id]);
      const reason = taken?.reason && taken.reason in DECLINED_BECAUSE ? taken.reason : request.state === "moot" ? "moot" : "no_reason";
      return {
        at: request.updated_at,
        header: header({ declined_because: reason }),
        parts: [{ kind: "fact", text: `This graph will not do the work this request asks for: ${DECLINED_BECAUSE[reason]}.` }],
      };
    }
    const work = await rawQuery<{ outcome: string; summary: string; by_label: string; created_at: Date; research_run_id: string | null }>(
      `SELECT outcome, summary, by_label, created_at, research_run_id FROM request_work WHERE request_id = $1 AND outcome IS NOT NULL ORDER BY created_at, id`,
      [id]
    );
    if (work.length === 0 && !closed) return null;
    const rests = new Map<string, string[]>();
    for (const w of work) rests.set(w.research_run_id ?? "", await partiesOfWork(id, w.research_run_id));
    return {
      at: work[work.length - 1]?.created_at ?? request.updated_at,
      header: header(),
      parts: [
        { kind: "standing", text: `Where the request stands there: ${request.state.replace(/_/g, " ")}.${request.state_note ? ` ${request.state_note}` : ""}` },
        ...work.flatMap((w) => [
          { kind: "fact", text: `Work by ${w.by_label}, recorded ${w.created_at.toISOString().slice(0, 10)}, with the outcome: ${w.outcome.replace(/_/g, " ")}.` },
          ...paragraphsOf(w.summary).map((text) => ({ kind: "finding", text, needs: rests.get(w.research_run_id ?? "") ?? [] })),
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
    // Toward outside the mandate is the organization's face on the public graph, which a request there can be
    // addressed to. How the gate to outside is set for its work goes with it, stamped here from the gates' own
    // rows and written by nobody (gate-face.ts): it is what the organization has said it will release.
    const outside = offer.toLabel === null ? await (await import("./gate-face.js")).faceStamp(id) : null;
    return {
      at: grant.created_at,
      header: header(outside ? { face: outside } : {}),
      parts: [
        {
          kind: "fact",
          text:
            offer.toLabel === null
              ? `This mandate works in its publisher's own graph, at a label the public graph does not read. It is ${grant.status}.`
              : `A mandate exists at a label this one does not read. It is ${grant.status}.`,
        },
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
  if (offer.kind === "petition") {
    const id = (offer.subject as { petitionId: string }).petitionId;
    const [p] = await rawQuery<{ asked: string; plan: string; why: string | null; if_refused: string | null; done_so_far: string | null; created_at: Date }>(
      `SELECT asked_micro_usd AS asked, plan, why, if_refused, done_so_far, created_at FROM petitions WHERE id = $1`,
      [id]
    );
    if (!p) return null;
    const owls = (Number(p.asked) / 1_000_000).toFixed(2);
    return {
      at: p.created_at,
      header: header({ asked_micro_usd: Number(p.asked) }),
      parts: [
        { kind: "amount", text: `Work this mandate pays for, at a label it does not read, asks it for ${owls} owls more.` },
        ...paragraphsOf(p.plan).map((text) => ({ kind: "ask", text: `What it would do with it: ${text}` })),
        ...paragraphsOf(p.why).map((text) => ({ kind: "ask", text: `Why: ${text}` })),
        ...paragraphsOf(p.done_so_far).map((text) => ({ kind: "ask", text: `Done so far: ${text}` })),
        ...paragraphsOf(p.if_refused).map((text) => ({ kind: "ask", text: `If it is refused: ${text}` })),
      ],
    };
  }
  if (offer.kind === "statement") {
    const owls = (micro: number) => (micro / 1_000_000).toFixed(2);
    if ("grantId" in offer.subject) {
      // A mandate made for a request from another label, once it has closed: what was put into it and what went back.
      const [m] = await rawQuery<{ status: string; put_in: string; returned: string; closed_at: Date | null }>(
        `SELECT g.status, COALESCE(sum(r.amount_micro_usd), 0) AS put_in, COALESCE(sum(r.refunded_micro_usd), 0) AS returned, max(g.updated_at) AS closed_at
           FROM grants g LEFT JOIN regrants r ON r.to_grant_id = g.id WHERE g.id = $1 GROUP BY g.status`,
        [offer.subject.grantId]
      ).catch(() => []);
      if (!m || !["completed", "cancelled", "declined"].includes(m.status)) return null;
      return {
        at: m.closed_at ?? new Date(),
        header: header({ put_in_micro_usd: Number(m.put_in), returned_micro_usd: Number(m.returned) }),
        parts: [{ kind: "amount", text: `The mandate has closed. Of ${owls(Number(m.put_in))} owls put into it, ${owls(Number(m.put_in) - Number(m.returned))} were spent and ${owls(Number(m.returned))} went back to those who paid.` }],
      };
    }
    const id = (offer.subject as { requestId: string }).requestId;
    const [request] = await rawQuery<{ state: string; updated_at: Date }>(`SELECT state, updated_at FROM requests WHERE id = $1`, [id]);
    if (!request || !["met", "declined", "withdrawn", "moot"].includes(request.state)) return null;
    const [money] = await rawQuery<{ placed: string; spent: string }>(
      `SELECT COALESCE(sum(amount_micro_usd), 0) AS placed, COALESCE(sum(spent_micro_usd), 0) AS spent FROM action_allocations WHERE exclusion_group = $1`,
      [`request:${id}`]
    );
    const placed = Number(money?.placed ?? 0);
    const spent = Number(money?.spent ?? 0);
    return {
      at: request.updated_at,
      header: header({ placed_micro_usd: placed, spent_micro_usd: spent }),
      parts: [{ kind: "amount", text: `Work on the request has ended. Of ${owls(placed)} owls placed on it, ${owls(spent)} were spent and ${owls(Math.max(0, placed - spent))} went back to whoever paid.` }],
    };
  }
  if (offer.kind === "report") {
    const id = (offer.subject as { reportId: string }).reportId;
    const [report] = await rawQuery<{ kind: string; severity: string; surface: string | null; title: string; body: string; about: string | null; occurrence_count: number; first_seen_at: Date; last_seen_at: Date }>(
      `SELECT kind, severity, surface, title, body, about, occurrence_count, first_seen_at, last_seen_at FROM agent_reports WHERE id = $1`,
      [id]
    );
    // Only a report Audit's triage found to be about Minerval's machinery is offered (report-sending-service.ts).
    if (!report || report.about !== "minerval") return null;
    const { factsOf } = await import("./report-sending-service.js");
    const facts = await factsOf(report);
    return {
      at: report.first_seen_at,
      // The facts, in fixed vocabulary: which of Minerval's own tools, the kind and the severity from the two fixed
      // lists, and the version of Minerval the deployment runs. How often it was seen is read when it is sent.
      header: header({ facts: { tool: facts.tool, kind: facts.kind, severity: facts.severity, minerval: facts.minerval } }),
      parts: [{ kind: "title", text: report.title }, ...paragraphsOf(report.body).map((text) => ({ kind: "words", text }))],
    };
  }
  if (offer.kind === "proposal") {
    const id = (offer.subject as { proposalId: string }).proposalId;
    const [proposal] = await rawQuery<{ text: string; node_kind: string; needs: string[]; written_at: Date; state: string }>(
      `SELECT text, node_kind, needs, written_at, state FROM outbound_proposals WHERE id = $1`,
      [id]
    );
    if (!proposal || proposal.state === "replaced") return null;
    return {
      at: proposal.written_at,
      header: header({ node_kind: proposal.node_kind }),
      // The words rest on the parties the node's wording rests on, and are theirs to let through.
      parts: [{ kind: "proposed", text: proposal.text, needs: proposal.needs }],
    };
  }
  // funding
  const s = offer.subject as { nodeId: string; amountMicroUsd: number; versionAt?: string };
  const amount = Math.max(0, Math.round(s.amountMicroUsd));
  if (offer.toLabel === null) {
    return {
      at: s.versionAt ? new Date(s.versionAt) : new Date(),
      header: header({ ...(s.versionAt ? { version_of: s.versionAt } : { offered_on: new Date().toISOString().slice(0, 10) }) }),
      parts: [{ kind: "amount", text: "This graph asks a public mandate its organization funds for a fresh public assessment of this node, on public evidence. The mandate pays for it there, in public owls." }],
    };
  }
  return {
    at: s.versionAt ? new Date(s.versionAt) : new Date(),
    // The version, or else the day, is part of what is offered, so that the same amount paid again for a later version or on a later day is a new item.
    header: header({ amount_micro_usd: amount, ...(s.versionAt ? { version_of: s.versionAt } : { offered_on: new Date().toISOString().slice(0, 10) }) }),
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

/**
 * What goes to outside the deployment, and how each leaves once the gate
 * has let it through (gate-outside.ts). The gate is the same; the public
 * graph is another deployment, so arrival there is a signed package or a
 * call to one of its ordinary routes under the organization's account.
 * What work on a request found goes as a node's page, and a message, a
 * petition and a statement answer something asked from a label inside.
 */
const GOES_OUTSIDE: readonly GateKind[] = ["page", "mandate", "taken_up", "answer", "funding", "report", "proposal"];

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
      // The item itself, and each sentence in fixed words, is the organization's own to release. A part that
      // rests on another party's material is that party's to release as well (partiesOfWork, and a proposal's
      // wording), so that party's own setting of the gate applies to it.
      needs: [own.id],
      sourceIds: [],
      parts: composed.parts.map((p) => ({ kind: p.kind, descriptor: p.kind, refId: null, original: p.text, needs: [...new Set([own.id, ...(p.needs ?? [])])] })),
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
  /**
   * For a request taken up from the public graph that was not addressed to
   * a mandate this deployment published: a person who may act on the
   * public graph for the organization has said that this is to be told
   * there. Without it nothing about such a request is offered, since
   * nobody outside asked this graph for it.
   */
  saidByAPerson?: boolean;
}

/**
 * The mandate this deployment published that a public request is addressed
 * to, or null where it is addressed to none of them. A published mandate
 * is the standing offer of it at the gate to outside, and the public graph
 * knows it by that offer's id (gate-outside.ts).
 */
export async function publishedMandateAskedBy(publicRequestId: string): Promise<{ face_id: string; grant_id: string; label: string } | null> {
  return bothSides(async () => {
    const [row] = await rawQuery<{ face_id: string; grant_id: string; label: string }>(
      `SELECT s.id AS face_id, s.subject_ref AS grant_id, s.sensitivity_label AS label
         FROM feed_requests f JOIN showings s ON s.id = f.asked_of_face_id
        WHERE f.id = $1 AND f.origin = 'mirror' AND s.kind = 'mandate' AND s.to_outside AND s.ended_at IS NULL`,
      [publicRequestId]
    );
    return row ?? null;
  });
}

async function requestOffer(kind: "answer" | "taken_up" | "statement", requestIdAbove: string, opts: BelowOpts): Promise<{ item_id: string; state: OfferState } | null> {
  if (oneLabelOnly()) return null;
  return bothSides(async () => {
    const [above] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM requests WHERE id = $1`, [requestIdAbove]);
    if (!above) return null;
    let toLabel = opts.toLabel ?? null;
    let replyTo = opts.replyTo ?? null;
    if (!toLabel || !replyTo) {
      const { answerableBelow } = await import("./request-adoption-service.js");
      const asked = (await answerableBelow(requestIdAbove))?.asked;
      if (!asked) return null;
      if (!("request_id" in asked)) {
        // Taken up from the public graph: the label below is another deployment, and the gate is the one to
        // outside. What was asked of this graph there flows to it: a request addressed to a mandate this
        // deployment published. Any other public request was asked of nobody in particular, so that this graph
        // works on it is told only where a person said so. A statement of what was spent is not sent: the
        // asker paid nothing here.
        if (kind === "statement") return null;
        const mandate = await publishedMandateAskedBy(asked.public_request_id);
        if (!mandate && !opts.saidByAPerson) return null;
        return offerToGate({
          kind,
          fromLabel: above.label,
          toLabel: null,
          subject: { requestId: requestIdAbove },
          replyTo: { requestId: asked.public_request_id },
          payer: opts.payer ?? (mandate && mandate.label === above.label ? { grantId: mandate.grant_id } : undefined),
        });
      }
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
 * Tell the label that asked what was spent on its request and what went
 * back, once work on it has ended. The money itself is not the gate's: it
 * is the payer's own, and returns by the ordinary settlement as soon as it
 * is released, where the payer's own account shows it. This is the account
 * of it in words.
 */
export const offerStatementBelow = (requestIdAbove: string, opts: BelowOpts = {}) => requestOffer("statement", requestIdAbove, opts);

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
