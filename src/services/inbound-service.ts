/**
 * What the public says back about a page this deployment published
 * (docs/outward-acts.md, "What the public says back").
 *
 * A reader of a published page can challenge it, and can propose to the
 * node it sits on. That is the check the public has on structure it cannot
 * see, so it has to reach the Steward that can answer it. On the public
 * graph these are ordinary contributions that name the page
 * (contributions.about_published_page_id), reviewed by the public
 * Contribution Reviewer like any other. This file is the way back in.
 *
 *  1. The deployment learns of them from the mirror's feed
 *     (feed_contributions), which it pulls whole. It never asks the public
 *     graph about one page or one node. Only those the public graph's own
 *     review admitted are taken in.
 *  2. The contribution itself is given to the node's Steward at the label
 *     the page came from: its text as written, its type and date, the
 *     addresses it cites and its id on the public graph. It is public text
 *     on the public graph, which that Steward reads through the mirror
 *     already, and an agent that has not read a challenge cannot answer it.
 *     The message says that the text was written outside the deployment. A
 *     reassessment is opened there, which runs when a mandate or a person
 *     pays for it. Under a standing showing its result goes out as the next
 *     version by the path every version takes.
 *  3. What the outside is told is in the next package of the page: that
 *     the contribution was received, and where the reassessment stands, in
 *     fixed words. The public graph shows that on the contribution's own
 *     record, beside the versions the package already lists, so "received"
 *     and "unanswered" need no object of their own.
 *
 * A contribution whose text is the same as an earlier one's on the node is
 * recorded as a repeat of it and opens nothing: repeats count once. The
 * check is exact, on the text. Whether a contribution in other words says
 * what an earlier one said is the Steward's judgment, and one that restates
 * an argument already answered may be answered by reference to the record
 * (constitution §14).
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";

const atPublic = <T>(what: string, fn: () => Promise<T>) => runAtLabel(PUBLIC_LABEL, what, fn);

const REASON_DELIVER =
  "A contribution made on the public graph about a published page is public text, read at `public`, and is delivered to the node's Steward at the label the page came from, which `public` does not read; and where that label's reassessment stands is copied back in fixed words for the outside.";

/**
 * Take in, from the mirror, the contributions made on the public graph
 * through a page this deployment published, once the public graph's own
 * review has admitted them. Each becomes a row here, to be given to the
 * node's Steward, or a repeat where an earlier one on the node has the same
 * text. Work at `public`: every row it reads and writes is there.
 */
export async function takeInPublicContributions(): Promise<number> {
  if (oneLabelOnly()) return 0;
  return atPublic("taking in what the public said about published pages", async () => {
    const arrived = await rawQuery<{
      id: string; contribution_type: string; submitted_at: Date; about_published_page_id: string; showing_id: string; node_id: string;
    }>(
      `SELECT DISTINCT f.id, f.contribution_type, f.submitted_at, f.about_published_page_id, p.showing_id, p.node_id
         FROM feed_contributions f
         JOIN outbound_sends s ON s.public_page_id = f.about_published_page_id
         JOIN outbound_packages p ON p.id = s.package_id
        WHERE f.origin = 'mirror' AND f.review_status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM inbound_contributions i WHERE i.public_contribution_id = f.id)
        ORDER BY f.submitted_at, f.id`
    );
    for (const c of arrived) {
      // The same text as one already received on this node, space around it aside: counted with it.
      const [same] = await rawQuery<{ id: string }>(
        `SELECT i.id FROM inbound_contributions i
           JOIN feed_contributions e ON e.id = i.public_contribution_id
           JOIN feed_contributions f ON f.id = $2
          WHERE i.node_id = $1 AND i.state = 'received'
            AND btrim(e.content, E' \\t\\n\\r') = btrim(f.content, E' \\t\\n\\r')
          ORDER BY i.submitted_at, i.id LIMIT 1`,
        [c.node_id, c.id]
      );
      await rawQuery(
        `INSERT INTO inbound_contributions (public_contribution_id, public_page_id, showing_id, node_id, contribution_type, submitted_at, state, repeats, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (public_contribution_id) DO NOTHING`,
        [c.id, c.about_published_page_id, c.showing_id, c.node_id, c.contribution_type, c.submitted_at, same ? "repeat" : "received", same?.id ?? null, PUBLIC_LABEL]
      );
    }
    return arrived.length;
  });
}

// ---- delivery to the Steward at the page's label ----------------------------------------

/**
 * What the node's Steward at the page's label is told: the contribution as
 * it was made, with where its text came from. That what a run reads is
 * data is said to every agent already, so nothing more is said of it here.
 */
export function publicContributionMessage(input: {
  type: string;
  submittedAt: Date;
  publicId: string;
  text: string;
  addresses: readonly string[];
}): string {
  return (
    `A reader of the page this graph publishes of this node made a contribution on the public graph through it (${input.type.replace(/_/g, " ")}, ` +
    `${input.submittedAt.toISOString().slice(0, 10)}; contribution ${input.publicId} there). The public graph's Contribution Reviewer admitted ` +
    `it there. Its text follows as it was written, outside this deployment, by someone who reads the published page and not what is ` +
    `labeled here.\n\n` +
    `---\n${input.text}\n---\n\n` +
    (input.addresses.length > 0 ? `Addresses it cites: ${input.addresses.join(" ")}\n\n` : `It cites no addresses.\n\n`) +
    `It is to be heard as any challenge or proposal is: weigh what it says against what you hold, and say in your reasoning what you did with it. ` +
    `The contribution's public record says that it was received here, and will say whether a version made since is published or held.`
  );
}

/**
 * Give each contribution received to the node's Steward at the label the
 * page came from, opening the reassessment there, and bring up to date
 * what the outside is told about each reassessment. Runs after the mirror
 * brings contributions in, and on the scheduler.
 */
export async function deliverPublicContributions(): Promise<{ delivered: number; moved: number }> {
  if (oneLabelOnly()) return { delivered: 0, moved: 0 };
  return withSystemClearance(REASON_DELIVER, async () => {
    const fresh = await rawQuery<{
      id: string; node_id: string; public_contribution_id: string; contribution_type: string; submitted_at: Date;
      content: string; evidence_urls: string[]; page_label: string | null;
    }>(
      `SELECT i.id, i.node_id, i.public_contribution_id, i.contribution_type, i.submitted_at, f.content, f.evidence_urls,
              s.sensitivity_label AS page_label
         FROM inbound_contributions i
         JOIN feed_contributions f ON f.id = i.public_contribution_id
         LEFT JOIN showings s ON s.id = i.showing_id
        WHERE i.state = 'received' AND i.delivered_at IS NULL ORDER BY i.submitted_at, i.id`
    );
    let delivered = 0;
    for (const c of fresh) {
      if (!c.page_label) continue;
      // What a reader said is word from the layer below every label: public text, on the public graph. It is
      // recorded once, as a message on the node at `public`, and reaches a pass on the node at each label that
      // reads `public` by the path any message from a label below takes (inbox-service.ts, waitsForPassAt): the
      // label the page came from, and any other that holds a judgment of the node.
      await atPublic(`what the public said about the page of node ${c.node_id}`, async () => {
        const { postMessage } = await import("./inbox-service.js");
        await postMessage({
          nodeId: c.node_id,
          trigger: "public_contribution",
          body: publicContributionMessage({
            type: c.contribution_type,
            submittedAt: c.submitted_at,
            publicId: c.public_contribution_id,
            text: c.content,
            addresses: c.evidence_urls ?? [],
          }),
          sender: { kind: "system", ref: `inbound:${c.id}` },
        });
      });
      // The public record says whether the reassessment it waits on was paid for, so that pass is opened at the
      // label the page came from. It carries no second copy of the message, and runs when it is paid for.
      await runAtLabel(c.page_label, `the reassessment opened by what the public said about node ${c.node_id}`, async () => {
        const { enqueueSteward } = await import("./queue-service.js");
        await enqueueSteward({ claimId: c.node_id, trigger: "public_contribution", context: "", sender: { kind: "system", ref: `inbound:${c.id}` } });
      });
      await rawQuery(`UPDATE inbound_contributions SET delivered_at = now(), reassessment = 'not_funded', reassessment_at = now() WHERE id = $1`, [c.id]);
      delivered++;
    }
    // Where each reassessment stands, for the outside: a version in force at the page's label made since the contribution was delivered;
    // or money behind the node's next pass there; or neither.
    const open = await rawQuery<{ id: string; node_id: string; reassessment: string; reassessment_at: Date; page_label: string | null; delivered_at: Date }>(
      `SELECT i.id, i.node_id, i.reassessment, i.reassessment_at, s.sensitivity_label AS page_label, i.delivered_at
         FROM inbound_contributions i LEFT JOIN showings s ON s.id = i.showing_id
        WHERE i.reassessment IN ('not_funded', 'funded')`
    );
    let moved = 0;
    for (const c of open) {
      if (!c.page_label) continue;
      const [made] = await rawQuery<{ at: Date }>(
        `SELECT v.at FROM (
           SELECT assessed_at AS at FROM assessments_in_force WHERE claim_id = $1 AND sensitivity_label = $2
           UNION ALL SELECT assessed_at FROM quantity_estimates_in_force WHERE claim_id = $1 AND sensitivity_label = $2
           UNION ALL SELECT assessed_at FROM question_assessments_in_force WHERE claim_id = $1 AND sensitivity_label = $2
         ) v WHERE v.at > $3 ORDER BY v.at DESC LIMIT 1`,
        [c.node_id, c.page_label, c.delivered_at]
      );
      const [paid] = made
        ? []
        : await rawQuery<{ id: string }>(
            `SELECT a.id FROM actions a
              WHERE a.claim_id = $1 AND a.kind IN ('assess', 'reassess') AND a.sensitivity_label = $2
                AND (a.status = 'running' OR (a.status = 'open' AND EXISTS (
                      SELECT 1 FROM action_allocations al WHERE al.exclusion_group = a.exclusion_group AND al.released_at IS NULL)))
              LIMIT 1`,
            [c.node_id, c.page_label]
          );
      const now = made ? "made" : paid ? "funded" : "not_funded";
      if (now !== c.reassessment) {
        await rawQuery(`UPDATE inbound_contributions SET reassessment = $2, reassessment_at = $3 WHERE id = $1`, [c.id, now, made?.at ?? new Date()]);
        moved++;
      }
    }
    return { delivered, moved };
  });
}

// ---- requests on the public graph addressed to a mandate this deployment published --------------

const REASON_ADDRESSED =
  "A request on the public graph is public text, read at `public`, and one addressed to a mandate this deployment published is put in front of that mandate, at the mandate's label, which `public` does not read.";

/** What a mandate's officers and Grantmaker are told when a request on the public graph is addressed to the mandate. */
export function addressedRequestMessage(input: { id: string; filedAt: Date; ask: string; why: string; satisfiedBy: string; bearsOn: string[]; bearsOnText: string | null }): string {
  return (
    `A request on the public graph is addressed to this mandate, which this graph published there (request ${input.id}, filed ` +
    `${input.filedAt.toISOString().slice(0, 10)}). Its text follows as it was written, outside this deployment.\n\n` +
    `---\nIt asks for: ${input.ask}\nWhy: ${input.why}\nWhat would satisfy it: ${input.satisfiedBy}\n` +
    `It bears on: ${[...input.bearsOn.map((n) => `node ${n}`), ...(input.bearsOnText ? [input.bearsOnText] : [])].join("; ") || "nothing it names"}\n---\n\n` +
    `Whether to take it up is this mandate's to decide, under its terms. fund_request with this request's id takes it up at this label and ` +
    `pays for the work: that it was taken up is then said on the public graph, and the page of each node it bears on goes to the gate to ` +
    `outside as it is assessed here. decline_asked_request declines it with a reason from a fixed list, which is what the public graph is ` +
    `told. Until one or the other, the request's public record shows that it was addressed here and how long ago.`
  );
}

/** Why a request addressed to a published mandate goes straight to its Grantmaker. */
export const ADDRESSED_TO_GRANTMAKER =
  "It is addressed to this mandate, and whether to take it up is the Grantmaker's decision, so it comes to you directly.";

/**
 * Put each request on the public graph that is addressed to a mandate this
 * deployment published in front of that mandate, once: an item in its
 * inbox, at its label, with the request as it was written. The mandate's
 * Grantmaker decides whether to take it up, under the mandate's terms, as
 * it decides anything put in front of it, and no person acts for each one.
 * The item goes to the Grantmaker directly, not to officer sittings.
 * Runs after the mirror brings requests in, and on the scheduler.
 */
export async function deliverAddressedRequests(): Promise<number> {
  if (oneLabelOnly()) return 0;
  return withSystemClearance(REASON_ADDRESSED, async () => {
    const fresh = await rawQuery<{
      id: string; ask: string; why: string; satisfied_by: string; bears_on_text: string | null; filed_at: Date; grant_id: string; label: string;
    }>(
      `SELECT f.id, f.ask, f.why, f.satisfied_by, f.bears_on_text, f.filed_at, s.subject_ref AS grant_id, s.sensitivity_label AS label
         FROM feed_requests f JOIN showings s ON s.id = f.asked_of_face_id
        WHERE f.origin = 'mirror' AND s.kind = 'mandate' AND s.to_outside AND s.ended_at IS NULL
          AND f.state IN ('open', 'addressed', 'in_progress')
          AND NOT EXISTS (SELECT 1 FROM mandate_inbox i WHERE i.grant_id = s.subject_ref AND i.target_ref = 'public-request:' || f.id::text)
          AND NOT EXISTS (SELECT 1 FROM adopted_requests a WHERE a.public_request_id = f.id AND a.sensitivity_label = s.sensitivity_label)
        ORDER BY f.filed_at, f.id`
    );
    let delivered = 0;
    for (const r of fresh) {
      const targets = await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM feed_request_targets WHERE request_id = $1 ORDER BY claim_id`, [r.id]);
      const raised = await runAtLabel(r.label, `a request on the public graph addressed to mandate ${r.grant_id}`, async () => {
        const { raiseToMandate } = await import("./mandate-inbox-service.js");
        const item = await raiseToMandate({
          grantId: r.grant_id,
          targetNodeId: null,
          targetRef: `public-request:${r.id}`,
          source: "the public graph",
          summary: addressedRequestMessage({
            id: r.id,
            filedAt: r.filed_at,
            ask: r.ask,
            why: r.why,
            satisfiedBy: r.satisfied_by,
            bearsOn: targets.map((t) => t.claim_id),
            bearsOnText: r.bears_on_text,
          }),
          detail: { public_request_id: r.id },
        });
        // Taking it up or declining it is the Grantmaker's decision, so it goes to the Grantmaker as an
        // officer's escalation does: a live session is woken, and a mandate with none is given a review pass
        // (openReviewsForEscalations). Officer sittings are off unless a deployment turns them on, and an item
        // left for them would wait unread.
        if (item && !item.folded) {
          await rawQuery(`UPDATE mandate_inbox SET escalated_at = now(), escalation_note = $2 WHERE id = $1 AND escalated_at IS NULL`, [
            item.id,
            ADDRESSED_TO_GRANTMAKER,
          ]);
          const { recordEvent } = await import("./event-service.js");
          await recordEvent({
            kind: "escalated",
            grantId: r.grant_id,
            nodeId: null,
            refs: { petition: null, item: item.id },
            summary: `A request on the public graph: ${ADDRESSED_TO_GRANTMAKER}`,
            payload: { waiting: false },
          });
        }
        return item;
      }).catch((err: unknown) => {
        console.error(`[inbound] could not put public request ${r.id} in front of its mandate: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (raised) delivered++;
    }
    return delivered;
  });
}

// ---- what the outside is told (read at `public`, by the package builder) ----------------------

export interface SaidBack {
  /** The contribution's id on the public graph. */
  contribution: string;
  received_at: string;
  /** The public id of an earlier contribution with the same text, where this one is counted with it. */
  repeats?: string;
  /** Where the reassessment it opened stands, in fixed words; absent where it opened none, or has not yet been given to the Steward. */
  reassessment?: "not paid for" | "paid for, and not yet made" | "made";
  reassessment_as_of?: string;
}

const REASSESSMENT_WORDS: Record<string, NonNullable<SaidBack["reassessment"]>> = {
  not_funded: "not paid for",
  funded: "paid for, and not yet made",
  made: "made",
};

/** What a package says of the contributions received through one node's page. No word of a contribution is in it. */
export async function saidBackFor(showingId: string, nodeId: string): Promise<SaidBack[]> {
  const rows = await rawQuery<{
    public_contribution_id: string; received_at: Date; repeats_public: string | null; reassessment: string | null; reassessment_at: Date | null;
  }>(
    `SELECT i.public_contribution_id, i.received_at, r.public_contribution_id AS repeats_public, i.reassessment, i.reassessment_at
       FROM inbound_contributions i LEFT JOIN inbound_contributions r ON r.id = i.repeats
      WHERE i.showing_id = $1 AND i.node_id = $2 ORDER BY i.submitted_at, i.public_contribution_id`,
    [showingId, nodeId]
  );
  return rows.map((r) => ({
    contribution: r.public_contribution_id,
    received_at: r.received_at.toISOString(),
    ...(r.repeats_public ? { repeats: r.repeats_public } : {}),
    ...(r.reassessment ? { reassessment: REASSESSMENT_WORDS[r.reassessment]!, reassessment_as_of: (r.reassessment_at ?? r.received_at).toISOString() } : {}),
  }));
}

/**
 * What a member reads: every contribution received, as it was made. The
 * text is the public graph's own record of it, at `public`, which every
 * member reads.
 */
export async function inboundOverview(opts: { nodeId?: string } = {}): Promise<Record<string, unknown>> {
  const rows = await rawQuery<{
    id: string; public_contribution_id: string; node_id: string; node: string | null; contribution_type: string; submitted_at: Date; received_at: Date;
    state: string; content: string | null; evidence_urls: string[] | null; repeats: string | null; delivered_at: Date | null;
    reassessment: string | null; reassessment_at: Date | null;
  }>(
    `SELECT i.id, i.public_contribution_id, i.node_id, c.text AS node, i.contribution_type, i.submitted_at, i.received_at, i.state,
            f.content, f.evidence_urls, i.repeats, i.delivered_at, i.reassessment, i.reassessment_at
       FROM inbound_contributions i
       LEFT JOIN claims c ON c.id = i.node_id
       LEFT JOIN feed_contributions f ON f.id = i.public_contribution_id
      WHERE ($1::uuid IS NULL OR i.node_id = $1) ORDER BY i.received_at DESC, i.id LIMIT 200`,
    [opts.nodeId ?? null]
  );
  return {
    contributions: rows.map((r) => ({
      id: r.id,
      on_the_public_graph: r.public_contribution_id,
      node_id: r.node_id,
      node: r.node,
      type: r.contribution_type,
      submitted_at: r.submitted_at.toISOString(),
      received_at: r.received_at.toISOString(),
      ...(r.content !== null ? { text_written_outside_this_deployment: r.content, addresses_it_cites: r.evidence_urls ?? [] } : {}),
      ...(r.repeats ? { repeats: r.repeats } : {}),
      ...(r.delivered_at ? { given_to_the_steward_at: r.delivered_at.toISOString() } : {}),
      ...(r.reassessment ? { reassessment: REASSESSMENT_WORDS[r.reassessment], reassessment_as_of: r.reassessment_at?.toISOString() ?? null } : {}),
    })),
    how_it_works:
      "A contribution made on the public graph through a page this graph published comes in with the mirror, once the public graph's own " +
      "review has admitted it. It is given as it was written to the node's Steward at the label the page came from, and a reassessment is " +
      "opened there, which runs when it is paid for. One whose text is the same as an earlier one's on the node is counted with that one " +
      "and opens nothing. The outside is told that the contribution was received and where the reassessment stands.",
  };
}
