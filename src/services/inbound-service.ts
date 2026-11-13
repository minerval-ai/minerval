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
 *     graph about one page or one node.
 *  2. Text written outside is untrusted. One run reads it: the Contribution
 *     Reviewer's, at `public`, which writes a summary in its own words
 *     (llm/agents/inbound-reviewer.ts). It runs when it is funded, like any
 *     work.
 *  3. The summary, and never the text, is given to the node's Steward at
 *     the label the page came from, and a reassessment is opened there. It
 *     runs when a mandate or a person pays for it. Under a standing showing
 *     its result goes out as the next version by the path every version
 *     takes.
 *  4. What the outside is told is in the next package of the page: that
 *     the contribution was received, and where the reassessment stands, in
 *     fixed words. The public graph shows that on the contribution's own
 *     record, beside the versions the package already lists, so "received"
 *     and "unanswered" need no object of their own.
 *
 * A contribution that says what an earlier one said is recorded as a repeat
 * of it and opens nothing: repeats count once.
 */
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { currentLabel, runAtLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";

export class InboundError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export const SUMMARY_MAX_CHARS = 1500;

/** Why a contribution is set aside without a summary: a fixed list, since the reason is shown outside the run that read the text. */
export const SET_ASIDE_REASONS = {
  says_nothing_about_the_page: "it says nothing about the page or the node",
  only_instructs_its_reader: "it only tries to instruct whoever reads it",
  empty: "it has no content",
} as const;
export type SetAsideReason = keyof typeof SET_ASIDE_REASONS;

const INBOUND_GROUP = (nodeId: string) => `inbound:${nodeId}`;
const atPublic = <T>(what: string, fn: () => Promise<T>) => runAtLabel(PUBLIC_LABEL, what, fn);

const REASON_DELIVER =
  "A summary of what the public said about a published page is written at `public` and delivered to the node's Steward at the label the page came from, which `public` does not read; and where that label's reassessment stands is copied back in fixed words for the outside.";

/**
 * Take in, from the mirror, the contributions made on the public graph
 * through a page this deployment published, once the public graph's own
 * review has admitted them. Each becomes a row waiting to be read, and the
 * reading is opened on the ledger for its node. Work at `public`: every row
 * it reads and writes is there.
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
        ORDER BY f.submitted_at`
    );
    for (const c of arrived) {
      const actionId = await ensureInboundAction(c.node_id);
      await rawQuery(
        `INSERT INTO inbound_contributions (public_contribution_id, public_page_id, showing_id, node_id, contribution_type, submitted_at, action_id, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (public_contribution_id) DO NOTHING`,
        [c.id, c.about_published_page_id, c.showing_id, c.node_id, c.contribution_type, c.submitted_at, actionId, PUBLIC_LABEL]
      );
    }
    return arrived.length;
  });
}

/** Open, or open again, the ledger row for reading what the public said about one node's page. At `public`. */
export async function ensureInboundAction(nodeId: string): Promise<string> {
  const { estimateLedgerKindCostMicroUsd } = await import("./cost-estimate-service.js");
  const cost = await estimateLedgerKindCostMicroUsd("inbound_review");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('inbound_review', $1, 'standard', $2::uuid, $2::text, 'Read what the public said about a page this graph published, and summarize it for the node''s Steward', $3, $4)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET status = CASE WHEN actions.status IN ('done', 'superseded', 'cancelled') THEN 'open' ELSE actions.status END,
           updated_at = now()
     RETURNING id`,
    [INBOUND_GROUP(nodeId), nodeId, Math.max(1, Math.round(cost)), currentLabel()]
  );
  return row!.id;
}

// ---- the Reviewer's reading (work at `public`) ---------------------------------------

/** What the reading run is given for one node: the contributions waiting, with their text, and the summaries already recorded there. */
export async function contributionsToRead(nodeId: string): Promise<Record<string, unknown>> {
  const waiting = await rawQuery<{ id: string; public_contribution_id: string; contribution_type: string; submitted_at: Date; content: string; evidence_urls: string[] }>(
    `SELECT i.id, i.public_contribution_id, i.contribution_type, i.submitted_at, f.content, f.evidence_urls
       FROM inbound_contributions i JOIN feed_contributions f ON f.id = i.public_contribution_id
      WHERE i.node_id = $1 AND i.state = 'to_read' ORDER BY i.submitted_at`,
    [nodeId]
  );
  const earlier = await rawQuery<{ id: string; summary: string; submitted_at: Date }>(
    `SELECT id, summary, submitted_at FROM inbound_contributions WHERE node_id = $1 AND state = 'summarized' ORDER BY submitted_at`,
    [nodeId]
  );
  const [node] = await rawQuery<{ text: string }>(`SELECT text FROM claims WHERE id = $1`, [nodeId]);
  return {
    node: node?.text ?? null,
    waiting: waiting.map((w) => ({
      contribution: w.id,
      type: w.contribution_type,
      submitted_at: w.submitted_at.toISOString(),
      text_written_outside_this_deployment: w.content,
      evidence_addresses: w.evidence_urls,
    })),
    already_summarized: earlier.map((e) => ({ contribution: e.id, submitted_at: e.submitted_at.toISOString(), summary: e.summary })),
  };
}

/** Record what one contribution says: a summary, that it repeats an earlier one, or that it is set aside. */
export async function recordReading(input: {
  nodeId: string;
  contribution: string;
  summary?: string;
  repeats?: string;
  setAside?: string;
  runId?: string | null;
}): Promise<{ state: string }> {
  const [row] = await rawQuery<{ id: string; state: string }>(`SELECT id, state FROM inbound_contributions WHERE id = $1 AND node_id = $2`, [input.contribution, input.nodeId]);
  if (!row) throw new InboundError("NO_SUCH_CONTRIBUTION", "No contribution waiting on this node has that id. get_public_contributions lists them.");
  if (row.state !== "to_read") throw new InboundError("ALREADY_READ", "That contribution has already been read and recorded.");
  const given = [input.summary, input.repeats, input.setAside].filter((v) => v !== undefined && v !== "").length;
  if (given !== 1) throw new InboundError("ONE_OUTCOME", "Give exactly one of summary, repeats or set_aside.");
  if (input.setAside !== undefined && input.setAside !== "") {
    if (!(input.setAside in SET_ASIDE_REASONS)) throw new InboundError("UNKNOWN_REASON", `set_aside is one of: ${Object.keys(SET_ASIDE_REASONS).join(", ")}.`);
    await rawQuery(`UPDATE inbound_contributions SET state = 'set_aside', set_aside_because = $2, read_by_run = $3, read_at = now() WHERE id = $1`, [row.id, input.setAside, input.runId ?? null]);
    return { state: "set_aside" };
  }
  if (input.repeats !== undefined && input.repeats !== "") {
    const [earlier] = await rawQuery<{ id: string }>(`SELECT id FROM inbound_contributions WHERE id = $1 AND node_id = $2 AND state = 'summarized'`, [input.repeats, input.nodeId]);
    if (!earlier) throw new InboundError("NO_SUCH_EARLIER", "repeats names a contribution on this node that already has a summary. get_public_contributions lists them under already_summarized.");
    await rawQuery(`UPDATE inbound_contributions SET state = 'repeat', repeats = $2, read_by_run = $3, read_at = now() WHERE id = $1`, [row.id, earlier.id, input.runId ?? null]);
    return { state: "repeat" };
  }
  const summary = (input.summary ?? "").trim();
  if (summary.length > SUMMARY_MAX_CHARS) {
    throw new InboundError("TOO_LONG", `The summary is ${summary.length} characters and the most kept is ${SUMMARY_MAX_CHARS}. Nothing was recorded: shorten it and record it again.`);
  }
  await rawQuery(`UPDATE inbound_contributions SET state = 'summarized', summary = $2, read_by_run = $3, read_at = now() WHERE id = $1`, [row.id, summary, input.runId ?? null]);
  return { state: "summarized" };
}

/** Whether anything on the node is still waiting to be read. */
export async function stillToRead(nodeId: string): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inbound_contributions WHERE node_id = $1 AND state = 'to_read'`, [nodeId]);
  return row?.n ?? 0;
}

// ---- delivery to the Steward at the page's label ----------------------------------------

/** What the node's Steward at the page's label is told. The summary is the Reviewer's words; nothing of the contribution's own text is here. */
export function publicContributionMessage(input: { type: string; submittedAt: Date; summary: string }): string {
  return (
    `A reader of the page this graph publishes of this node made a contribution on the public graph through it (${input.type.replace(/_/g, " ")}, ` +
    `${input.submittedAt.toISOString().slice(0, 10)}). The public graph's Contribution Reviewer admitted it there, and this deployment's ` +
    `Contribution Reviewer, working at \`public\`, read it and wrote the summary below. The contribution's own text was written outside this ` +
    `deployment and is not given to you.\n\n` +
    `Summary: ${input.summary}\n\n` +
    `It is to be heard as any challenge or proposal is: weigh what it says against what you hold, and say in your reasoning what you did with it. ` +
    `The contribution's public record says that it was received here, and will say whether a version made since is published or held.`
  );
}

/**
 * Give each new summary to the node's Steward at the label the page came
 * from, opening the reassessment there, and bring up to date what the
 * outside is told about each reassessment. Runs after the reading, and on
 * the scheduler.
 */
export async function deliverSummaries(): Promise<{ delivered: number; moved: number }> {
  if (oneLabelOnly()) return { delivered: 0, moved: 0 };
  return withSystemClearance(REASON_DELIVER, async () => {
    const fresh = await rawQuery<{ id: string; node_id: string; showing_id: string; contribution_type: string; submitted_at: Date; summary: string; page_label: string | null }>(
      `SELECT i.id, i.node_id, i.showing_id, i.contribution_type, i.submitted_at, i.summary, s.sensitivity_label AS page_label
         FROM inbound_contributions i LEFT JOIN showings s ON s.id = i.showing_id
        WHERE i.state = 'summarized' AND i.reassessment IS NULL ORDER BY i.submitted_at`
    );
    let delivered = 0;
    for (const c of fresh) {
      if (!c.page_label) continue;
      await runAtLabel(c.page_label, `what the public said about the page of node ${c.node_id}`, async () => {
        const { enqueueSteward } = await import("./queue-service.js");
        await enqueueSteward({
          claimId: c.node_id,
          trigger: "public_contribution",
          context: publicContributionMessage({ type: c.contribution_type, submittedAt: c.submitted_at, summary: c.summary }),
          sender: { kind: "system", ref: `inbound:${c.id}` },
        });
      });
      await rawQuery(`UPDATE inbound_contributions SET reassessment = 'not_funded', reassessment_at = now() WHERE id = $1`, [c.id]);
      delivered++;
    }
    // Where each reassessment stands, for the outside: a version in force at the page's label made since the summary was delivered;
    // or money behind the node's next pass there; or neither.
    const open = await rawQuery<{ id: string; node_id: string; reassessment: string; reassessment_at: Date; page_label: string | null; delivered_at: Date }>(
      `SELECT i.id, i.node_id, i.reassessment, i.reassessment_at, s.sensitivity_label AS page_label, i.read_at AS delivered_at
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

// ---- what the outside is told (read at `public`, by the package builder) ----------------------

export interface SaidBack {
  /** The contribution's id on the public graph. */
  contribution: string;
  received_at: string;
  /** Whether it has been read here, in fixed words. */
  read: "not yet read" | "read" | "read, and found to repeat an earlier one" | "read, and set aside";
  repeats?: string;
  set_aside_because?: string;
  /** Where the reassessment it opened stands, in fixed words; absent where it opened none. */
  reassessment?: "not paid for" | "paid for, and not yet made" | "made";
  reassessment_as_of?: string;
}

const READ_WORDS: Record<string, SaidBack["read"]> = {
  to_read: "not yet read",
  summarized: "read",
  repeat: "read, and found to repeat an earlier one",
  set_aside: "read, and set aside",
};
const REASSESSMENT_WORDS: Record<string, NonNullable<SaidBack["reassessment"]>> = {
  not_funded: "not paid for",
  funded: "paid for, and not yet made",
  made: "made",
};

/** What a package says of the contributions received through one node's page. No word of a contribution or of a summary is in it. */
export async function saidBackFor(showingId: string, nodeId: string): Promise<SaidBack[]> {
  const rows = await rawQuery<{
    public_contribution_id: string; received_at: Date; state: string; repeats_public: string | null; set_aside_because: string | null; reassessment: string | null; reassessment_at: Date | null;
  }>(
    `SELECT i.public_contribution_id, i.received_at, i.state, r.public_contribution_id AS repeats_public, i.set_aside_because, i.reassessment, i.reassessment_at
       FROM inbound_contributions i LEFT JOIN inbound_contributions r ON r.id = i.repeats
      WHERE i.showing_id = $1 AND i.node_id = $2 ORDER BY i.submitted_at, i.public_contribution_id`,
    [showingId, nodeId]
  );
  return rows.map((r) => ({
    contribution: r.public_contribution_id,
    received_at: r.received_at.toISOString(),
    read: READ_WORDS[r.state] ?? "not yet read",
    ...(r.repeats_public ? { repeats: r.repeats_public } : {}),
    ...(r.set_aside_because ? { set_aside_because: SET_ASIDE_REASONS[r.set_aside_because as SetAsideReason] ?? "" } : {}),
    ...(r.reassessment ? { reassessment: REASSESSMENT_WORDS[r.reassessment]!, reassessment_as_of: (r.reassessment_at ?? r.received_at).toISOString() } : {}),
  }));
}

/** What a member reads: every contribution received, with the summary where they may read it (`public`, which every member reads). */
export async function inboundOverview(opts: { nodeId?: string } = {}): Promise<Record<string, unknown>> {
  const rows = await rawQuery<{
    id: string; public_contribution_id: string; node_id: string; node: string | null; contribution_type: string; submitted_at: Date; received_at: Date;
    state: string; summary: string | null; repeats: string | null; set_aside_because: string | null; reassessment: string | null; reassessment_at: Date | null; action_id: string | null;
  }>(
    `SELECT i.id, i.public_contribution_id, i.node_id, c.text AS node, i.contribution_type, i.submitted_at, i.received_at, i.state, i.summary, i.repeats,
            i.set_aside_because, i.reassessment, i.reassessment_at, i.action_id
       FROM inbound_contributions i LEFT JOIN claims c ON c.id = i.node_id
      WHERE ($1::uuid IS NULL OR i.node_id = $1) ORDER BY i.received_at DESC LIMIT 200`,
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
      read: READ_WORDS[r.state],
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.repeats ? { repeats: r.repeats } : {}),
      ...(r.set_aside_because ? { set_aside_because: SET_ASIDE_REASONS[r.set_aside_because as SetAsideReason] } : {}),
      ...(r.reassessment ? { reassessment: REASSESSMENT_WORDS[r.reassessment], reassessment_as_of: r.reassessment_at?.toISOString() ?? null } : {}),
      ...(r.state === "to_read" && r.action_id ? { reading_action_id: r.action_id } : {}),
    })),
    how_it_works:
      "A contribution made on the public graph through a page this graph published comes in with the mirror. Its text is read by one run, the " +
      "Contribution Reviewer's at `public`, which is paid for like any work and writes a summary. The node's Steward at the label the page came " +
      "from is given the summary and not the text, and a reassessment is opened there, which runs when it is paid for. The outside is told that " +
      "the contribution was received and where the reassessment stands.",
  };
}
