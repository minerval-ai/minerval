/**
 * What the gate to outside has let through, on its way out
 * (docs/the-gate.md, "Outside").
 *
 * The boundary between a deployment and the public graph is the same
 * boundary as the one between two labels: the same gate, the same
 * settings, the same acts, the same payment. One thing truly differs. The
 * public graph is another deployment, so arrival there cannot be a row
 * written by this one. It is a signed package, or a call to one of the
 * public graph's ordinary routes under the organization's own account,
 * which any account could make. This file is that last step for every
 * kind of thing but a node's page, whose package outbound-service.ts
 * builds:
 *
 *   taken_up  the account's statement on the request's public record that
 *             it is taking the request up;
 *   answer    its statement there that it will not do the work, with a
 *             reason from the public graph's fixed list (what work found
 *             goes as the page of each node the request bears on);
 *   funding   asking a public mandate the organization funds for a fresh
 *             public assessment of a node, which that mandate pays for
 *             there in public owls;
 *   mandate   a signed package of the mandate's name and terms as the gate
 *             left them, with how the gate is set for its work
 *             (gate-face.ts): the organization's face on the public graph;
 *   report    an agent's report of a fault in Minerval's machinery, filed
 *             for Minerval's maintainers and marked private;
 *   proposal  the words a node is proposed in, which are then sent as any
 *             account proposes a node (outbound-service.ts).
 *
 * Nothing here decides what goes: the gate did. An item is sent as it was
 * let through, once, and each sending is a row in the log of acts on the
 * public graph (outward_acts) saying exactly what was sent. Whether it goes
 * as soon as it is through, or waits for a person to send it, is the gate's
 * `send_as_released`, as for a page's package.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { runAtLabel } from "../llm/usage-context.js";
import type { GateKind } from "./gate-kinds.js";
import { gateOf } from "./gate-settings-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { OutboundError, answerOf, call, outsideSigner, publicGraph, type PublicGraph, type Sender } from "./outbound-service.js";
import { logOutwardAct, type Actor, type OutwardActKind } from "./outward-acts-service.js";
import { PUBLISHED_MANDATE_FORMAT, mandatePackageHash, type MandateFace, type PublishedMandatePackage } from "./published-mandate-service.js";
import { itemAsShown } from "./release-gate-service.js";

const REASON =
  "What the gate to outside has let through is read where it was released, at `public`, and the row that records its sending is at the label of the work it came from.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(REASON, fn);

interface WaitingItem {
  id: string;
  kind: GateKind;
  showing_id: string;
  subject_ref: string | null;
  reply_ref: string | null;
  boundary_id: string;
  from_label: string;
  send_as_released: boolean;
}

const ACT_KIND: Partial<Record<GateKind, OutwardActKind>> = {
  taken_up: "take_up_request",
  answer: "decline_request",
  funding: "keep_current",
  mandate: "publish_mandate",
  report: "send_report",
};

export interface SentThrough {
  sent: number;
  /** Through the gate and not sent: no route out, the gate waits for a person to send, or the public graph did not take it. */
  waiting: number;
  items: Array<{ item_id: string; kind: GateKind; result: "sent" | "waiting" | "refused" | "failed"; detail: string | null }>;
}

type Outcome = { ref: string | null; said: string; sent: Record<string, unknown> };

class NotTaken extends Error {
  constructor(
    message: string,
    public sent: Record<string, unknown>,
    public result: "refused" | "failed"
  ) {
    super(message);
  }
}

async function post(graph: PublicGraph, path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  let res: { status: number; json: Record<string, any> };
  try {
    res = await call(graph, "POST", path, body);
  } catch (err) {
    throw new NotTaken(err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.", body, "failed");
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 202) throw new NotTaken(`${res.status}: ${answerOf(res.json)}`, body, "refused");
  return res.json;
}

/** The last package of a published mandate that the public graph took: its place in the chain. */
async function lastMandatePackage(showingId: string): Promise<{ sequence: number; hash: string } | null> {
  const [row] = await rawQuery<{ sent: { sequence?: number; hash?: string } }>(
    `SELECT sent FROM outward_acts WHERE kind = 'publish_mandate' AND public_ref = $1 AND result = 'done' ORDER BY at DESC, id DESC LIMIT 1`,
    [showingId]
  );
  return row && typeof row.sent.sequence === "number" && typeof row.sent.hash === "string" ? { sequence: row.sent.sequence, hash: row.sent.hash } : null;
}

/** The signed package of a mandate as the gate let it through, or as withdrawn. */
async function mandatePackage(item: NonNullable<Awaited<ReturnType<typeof itemAsShown>>>, showing: { id: string; asked_at: Date }, withdrawn: Date | null): Promise<PublishedMandatePackage> {
  const signer = outsideSigner();
  const last = await lastMandatePackage(showing.id);
  const name = item.parts.find((p) => p.kind === "name");
  const body = {
    format: PUBLISHED_MANDATE_FORMAT,
    publisher: { key_id: signer.key_id, public_key: signer.public_key },
    deployment: { hosting: signer.hosting },
    mandate: {
      ref: showing.id,
      offered_at: showing.asked_at.toISOString(),
      withdrawn: withdrawn ? { at: withdrawn.toISOString() } : null,
      version_of: item.version_of.toISOString(),
      name: name && "text" in name ? name.text : null,
      parts: item.parts,
      removals: (item.header.removals as Record<string, number> | undefined) ?? {},
      policy: item.policy,
      released_under: item.released_under,
    },
    face: (item.header.face as MandateFace | undefined) ?? null,
    sequence: (last?.sequence ?? 0) + 1,
    previous_hash: last?.hash ?? null,
    built_at: new Date().toISOString(),
  };
  const hash = mandatePackageHash(body);
  return { ...body, hash, signature: signer.sign(hash) };
}

async function sendOne(graph: PublicGraph, w: WaitingItem): Promise<Outcome> {
  const item = await itemAsShown(w.id);
  if (!item) throw new NotTaken("The item is not through the gate.", {}, "failed");
  switch (w.kind) {
    case "taken_up": {
      const answer = await post(graph, `/requests/${w.reply_ref}/take-up`, {});
      await runAtLabel(w.from_label, `recording that request ${w.subject_ref} was said to be taken up`, () =>
        rawQuery(`UPDATE adopted_requests SET taken_up_at = COALESCE(taken_up_at, now()) WHERE request_id = $1`, [w.subject_ref])
      );
      return { ref: w.reply_ref, said: String(answer.in_words ?? ""), sent: { request: w.reply_ref } };
    }
    case "answer": {
      const reason = String(item.header.declined_because ?? "no_reason");
      const answer = await post(graph, `/requests/${w.reply_ref}/take-up/decline`, { reason });
      await runAtLabel(w.from_label, `recording that request ${w.subject_ref} was declined in public`, () =>
        rawQuery(`UPDATE adopted_requests SET declined_at = COALESCE(declined_at, now()), decline_reason = $2 WHERE request_id = $1`, [w.subject_ref, reason])
      );
      return { ref: w.reply_ref, said: String(answer.in_words ?? ""), sent: { request: w.reply_ref, reason } };
    }
    case "funding": {
      const gate = await gateOf(w.boundary_id);
      if (!gate?.keep_current_mandate) {
        throw new NotTaken("This gate names no public mandate to ask, so nothing was sent. An administrator names one on the gate.", { node_id: w.subject_ref }, "failed");
      }
      const answer = await post(graph, `/mandates/${gate.keep_current_mandate}/raise`, { node_id: w.subject_ref });
      // One request for a node, however many versions and labels were waiting on it.
      await rawQuery(
        `UPDATE shown_pages p SET sent_outside_at = now(), outside_ref = $2
           FROM shown_showings s, showings o
          WHERE s.id = p.showing_id AND o.id = s.id AND s.to_outside AND p.kind = 'funding' AND o.subject_ref = $1
            AND p.shown_at IS NOT NULL AND p.sent_outside_at IS NULL AND p.id <> $3`,
        [w.subject_ref, w.subject_ref, w.id]
      );
      return { ref: w.subject_ref, said: String(answer.in_words ?? ""), sent: { node_id: w.subject_ref, mandate_id: gate.keep_current_mandate } };
    }
    case "mandate": {
      const [showing] = await rawQuery<{ id: string; asked_at: Date }>(`SELECT id, asked_at FROM shown_showings WHERE id = $1`, [w.showing_id]);
      const pkg = await mandatePackage(item, showing!, null);
      try {
        const answer = await post(graph, "/published-mandates", { package: pkg });
        return { ref: pkg.hash, said: String(answer.in_words ?? ""), sent: { sequence: pkg.sequence, hash: pkg.hash, package: pkg } };
      } catch (err) {
        if (err instanceof NotTaken) err.sent = { sequence: pkg.sequence, hash: pkg.hash };
        throw err;
      }
    }
    case "report": {
      const [report] = await rawQuery<{ occurrence_count: number; first_seen_at: Date; last_seen_at: Date }>(
        `SELECT occurrence_count, first_seen_at, last_seen_at FROM agent_reports WHERE id = $1`,
        [w.subject_ref]
      );
      const facts = (item.header.facts ?? {}) as { tool?: string | null; kind?: string; severity?: string; minerval?: { migration?: number; prompt_set?: string } };
      const title = item.parts.find((p) => p.kind === "title");
      const words = item.parts.filter((p) => p.kind === "words" && "text" in p).map((p) => (p as { text: string }).text);
      const seen = Number(report?.occurrence_count ?? 1);
      const payload = {
        kind: facts.kind ?? "system_failure",
        severity: facts.severity ?? "degraded",
        // Where the title is held, fixed words and a tool's name from the code stand in for it: nothing an agent wrote.
        title: title && "text" in title ? title.text : `${facts.tool ?? "A tool"}: ${(facts.kind ?? "system_failure").replace(/_/g, " ")} reported in a private deployment`,
        body: words.join("\n\n"),
        ...(facts.tool ? { surface: facts.tool } : {}),
        context_refs: {
          minerval_migration: facts.minerval?.migration ?? 0,
          minerval_prompt_set: facts.minerval?.prompt_set ?? "",
          seen,
          ...(report ? { first_seen: report.first_seen_at.toISOString().slice(0, 10), last_seen: report.last_seen_at.toISOString().slice(0, 10) } : {}),
          parts_held: item.parts.filter((p) => "held" in p).length,
        },
        private: true,
      };
      const answer = await post(graph, "/reports", payload);
      const publicId = typeof answer.report?.id === "string" ? (answer.report.id as string) : null;
      await runAtLabel(w.from_label, `recording that report ${w.subject_ref} was sent`, () =>
        rawQuery(
          `INSERT INTO report_sendings (report_id, sent_at, public_report_id, seen, sensitivity_label) VALUES ($1, now(), $2, $3, $4)
           ON CONFLICT (report_id) DO UPDATE SET sent_at = now(), public_report_id = EXCLUDED.public_report_id, seen = EXCLUDED.seen`,
          [w.subject_ref, publicId, seen, w.from_label]
        )
      );
      return { ref: publicId, said: `Recorded as ${answer.report?.status ?? "new"}.`, sent: payload };
    }
    default:
      throw new NotTaken(`Nothing of the kind ${w.kind} leaves the deployment.`, {}, "failed");
  }
}

/**
 * Send what the gate to outside has let through and has not been sent:
 * one item, the items of one offer, or all of them. With no person sending
 * (the scheduler, or the gate itself as an item comes through), only what
 * the gate's `send_as_released` covers goes.
 */
export async function sendThroughOutside(opts: { itemId?: string; showingId?: string; sender?: Sender } = {}): Promise<SentThrough> {
  const out: SentThrough = { sent: 0, waiting: 0, items: [] };
  if (oneLabelOnly()) return out;
  const sender: Sender = opts.sender ?? { standing: true };
  return asOwner(async () => {
    const waiting = await rawQuery<WaitingItem>(
      `SELECT p.id, p.kind, p.showing_id, o.subject_ref, s.reply_ref, s.boundary_id, o.sensitivity_label AS from_label, s.send_as_released
         FROM shown_pages p JOIN shown_showings s ON s.id = p.showing_id JOIN showings o ON o.id = s.id
        WHERE s.to_outside AND p.kind <> 'page' AND p.shown_at IS NOT NULL AND p.sent_outside_at IS NULL AND p.stage <> 'overtaken'
          AND ($1::uuid IS NULL OR p.id = $1) AND ($2::uuid IS NULL OR s.id = $2)
        ORDER BY p.shown_at, p.id`,
      [opts.itemId ?? null, opts.showingId ?? null]
    );
    let graph: PublicGraph | null = null;
    try {
      graph = publicGraph();
    } catch (err) {
      if (!(err instanceof OutboundError)) throw err;
    }
    for (const w of waiting) {
      // A proposal's words, once through the gate, are ready to be sent as any account proposes a node; the
      // sending and the public graph's review of it are followed with the showing's packages (outbound-service.ts).
      if (w.kind === "proposal") {
        const item = await itemAsShown(w.id);
        if (item?.parts.some((p) => p.kind === "proposed" && "text" in p)) {
          await rawQuery(`UPDATE outbound_proposals SET state = 'ready' WHERE id = $1 AND state = 'waiting_for_release'`, [w.subject_ref]);
          await rawQuery(`UPDATE shown_pages SET sent_outside_at = now() WHERE id = $1`, [w.id]);
          out.sent++;
          out.items.push({ item_id: w.id, kind: w.kind, result: "sent", detail: "The words are released and ready to be proposed." });
        }
        continue;
      }
      // An earlier version of a mandate that a later one has since come through after is not sent: the later one says what stands.
      if (w.kind === "mandate") {
        const [later] = await rawQuery(
          `SELECT 1 FROM shown_pages l WHERE l.showing_id = $1 AND l.id <> $2 AND l.shown_at IS NOT NULL AND l.judged_at >= (SELECT judged_at FROM shown_pages WHERE id = $2) AND l.opened_at > (SELECT opened_at FROM shown_pages WHERE id = $2) LIMIT 1`,
          [w.showing_id, w.id]
        );
        if (later) {
          await rawQuery(`UPDATE shown_pages SET sent_outside_at = now(), outside_ref = 'replaced by a later version before it was sent' WHERE id = $1`, [w.id]);
          continue;
        }
      }
      if (!graph || ("standing" in sender && !w.send_as_released)) {
        out.waiting++;
        out.items.push({
          item_id: w.id,
          kind: w.kind,
          result: "waiting",
          detail: graph ? "The gate to outside is set for a person to send what is released." : "This deployment has no address or key for the public graph.",
        });
        continue;
      }
      const by: Actor = "actor" in sender ? { actor: sender.actor } : { gate: true };
      const kind = ACT_KIND[w.kind]!;
      try {
        const done = await sendOne(graph, w);
        await rawQuery(`UPDATE shown_pages SET sent_outside_at = now(), outside_ref = $2 WHERE id = $1`, [w.id, done.ref]);
        await logOutwardAct({ kind, by, publicRef: w.kind === "mandate" ? w.showing_id : done.ref, sent: done.sent, result: "done", said: done.said });
        out.sent++;
        out.items.push({ item_id: w.id, kind: w.kind, result: "sent", detail: done.said || null });
      } catch (err) {
        if (!(err instanceof NotTaken)) throw err;
        await logOutwardAct({ kind, by, publicRef: w.kind === "mandate" ? w.showing_id : (w.reply_ref ?? w.subject_ref), sent: err.sent, result: err.result, said: err.message });
        out.waiting++;
        out.items.push({ item_id: w.id, kind: w.kind, result: err.result, detail: err.message });
      }
    }
    return out;
  });
}

/**
 * A published mandate's offer has ended: tell the public graph, in the
 * next package of its chain, that nothing new can be asked of it. What was
 * asked keeps saying what it was addressed to. Called when the offer ends.
 */
export async function mandateWithdrawnOutside(showingId: string, by: Actor): Promise<boolean> {
  if (oneLabelOnly()) return false;
  return asOwner(async () => {
    const [showing] = await rawQuery<{ id: string; asked_at: Date; ended_at: Date | null }>(
      `SELECT id, asked_at, ended_at FROM shown_showings WHERE id = $1 AND to_outside AND kind = 'mandate'`,
      [showingId]
    );
    if (!showing?.ended_at || !(await lastMandatePackage(showingId))) return false;
    const [latest] = await rawQuery<{ id: string }>(
      `SELECT id FROM shown_pages WHERE showing_id = $1 AND shown_at IS NOT NULL AND sent_outside_at IS NOT NULL AND outside_ref ~ '^[0-9a-f]{64}$' ORDER BY sent_outside_at DESC LIMIT 1`,
      [showingId]
    );
    const item = latest ? await itemAsShown(latest.id) : null;
    if (!item) return false;
    let graph: PublicGraph;
    try {
      graph = publicGraph();
    } catch {
      return false;
    }
    const pkg = await mandatePackage(item, showing, showing.ended_at);
    try {
      const answer = await post(graph, "/published-mandates", { package: pkg });
      await logOutwardAct({ kind: "publish_mandate", by, publicRef: showingId, sent: { sequence: pkg.sequence, hash: pkg.hash, withdrawn: true, package: pkg }, result: "done", said: String(answer.in_words ?? "") });
      return true;
    } catch (err) {
      if (!(err instanceof NotTaken)) throw err;
      await logOutwardAct({ kind: "publish_mandate", by, publicRef: showingId, sent: { sequence: pkg.sequence, hash: pkg.hash, withdrawn: true }, result: err.result, said: err.message });
      return false;
    }
  });
}
