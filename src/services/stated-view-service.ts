/**
 * Views stated to the graph directly (constitution §4).
 *
 * An organization or a person may say what it holds about a claim, a
 * quantity or a question, on the record, beside the assessment. Nobody edits
 * an assessment: the graph's voice is its agents' alone, and a stated view
 * is the speaker's, kept in its own words.
 *
 * A stated view is nothing new in the graph. The statement is a source,
 * attributed, dated and hashed, and it becomes an instance of the node: one
 * voice among the node's instances, with the speaker's declared stake
 * recorded as that source's interest (§9). It enters the way any outside
 * material does, as a contribution the Contribution Reviewer admits or
 * rejects on form and good faith, never on whether the view is right. Where
 * it gives reasons, they go to the node's Steward when it is admitted and
 * are heard as a challenge (§14); the Steward's answer is kept with the
 * message it answers.
 *
 * The account that files a statement is its speaker. On the public graph an
 * account speaks for itself, under the name it gives, and an organization
 * speaks through an account that is its own. Nobody checks who is behind an
 * account unless an operator has marked it verified, and every read says
 * which is the case.
 *
 * A later statement by the same account on the same node does not replace
 * the earlier one. Both stay, dated, and the newer is the one shown as
 * current.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import {
  instanceStanceForStatedView,
  STATED_VIEW_CONTRIBUTION_TYPE,
  STATED_VIEW_STANCES,
  type StatedViewStance,
} from "../schemas/common.js";
import { quantityEstimateSchema, type NodeKind, type QuantityEstimate } from "../schemas/kinds.js";
import { sourceContentHash } from "./source-content.js";
import { enqueueContribution, enqueueSteward } from "./queue-service.js";
import { INTEREST_PARTY_MAX_CHARS, INTEREST_STAKE_MAX_CHARS } from "./source-interest-service.js";
import {
  compareStatedView,
  VIEW_DIRECTIONS,
  VIEW_RELATIONS,
  type ViewComparison,
  type ViewDirection,
  type ViewRelation,
} from "./stated-view-compare.js";

/** The view itself is a few sentences; the reasons are where length belongs. */
export const STATEMENT_MAX_CHARS = 2000;
export const REASONS_MAX_CHARS = 8000;

/** The forms a stated figure may take: one figure, a range, or a side of a figure. */
export const STATED_FIGURE_FORMS = ["point", "interval", "bound"] as const;

export interface StatedViewInput {
  stance: StatedViewStance;
  probability: number | null;
  figure: QuantityEstimate | null;
  statement: string;
  reasons: string | null;
  /** Null when the speaker declared that it has no stake in the answer. */
  stake: string | null;
  evidenceUrls: string[];
}

export type ParsedStatedView =
  | { ok: true; view: StatedViewInput }
  | { ok: false; code: string; message: string };

const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Check a statement as submitted against the node's kind. The messages are
 * written for whoever is filing it, a person at a form or an agent at a tool.
 */
export function parseStatedView(kind: NodeKind, body: Record<string, unknown>): ParsedStatedView {
  const refuse = (code: string, message: string): ParsedStatedView => ({ ok: false, code, message });

  const statement = trimmed(body.statement);
  if (!statement) return refuse("STATEMENT_REQUIRED", "statement is required: the view, in the speaker's own words.");
  if (statement.length > STATEMENT_MAX_CHARS) {
    return refuse(
      "STATEMENT_TOO_LONG",
      `statement is ${statement.length} characters; at most ${STATEMENT_MAX_CHARS}. It states the view; the case for it goes in reasons.`
    );
  }
  const reasons = trimmed(body.reasons) || null;
  if (reasons && reasons.length > REASONS_MAX_CHARS) {
    return refuse("REASONS_TOO_LONG", `reasons is ${reasons.length} characters; at most ${REASONS_MAX_CHARS}.`);
  }

  const allowed: readonly string[] = STATED_VIEW_STANCES[kind];
  const stance = trimmed(body.stance);
  if (!allowed.includes(stance)) {
    return refuse("STANCE", `stance must be one of ${allowed.join(", ")} for a ${kind} (got "${stance}").`);
  }

  // The stake is asked of every speaker, and "none" is an answer it gives,
  // not a field it leaves out.
  const stakeText = trimmed(body.stake);
  const noStake = body.no_stake === true;
  if (stakeText && noStake) {
    return refuse("STAKE", "Give stake, or set no_stake to true, not both.");
  }
  if (!stakeText && !noStake) {
    return refuse(
      "STAKE",
      "Say what the speaker stands to gain or lose by how this is answered (stake, a sentence), or set no_stake " +
        "to true if it has none. The stake is recorded as a fact about the statement, not as a finding against it."
    );
  }
  if (stakeText.length > INTEREST_STAKE_MAX_CHARS) {
    return refuse("STAKE", `stake is ${stakeText.length} characters; at most ${INTEREST_STAKE_MAX_CHARS}.`);
  }

  let probability: number | null = null;
  if (body.probability !== undefined && body.probability !== null && body.probability !== "") {
    if (kind !== "claim") {
      return refuse("PROBABILITY", `probability goes with a claim. A ${kind} is not affirmed or denied.`);
    }
    probability = Number(body.probability);
    if (!(probability >= 0 && probability <= 1)) {
      return refuse("PROBABILITY", "probability is a number from 0 to 1: the chance the claim as worded is true.");
    }
  }
  if (stance === "gives_probability" && probability === null) {
    return refuse("PROBABILITY", "stance gives_probability needs probability, a number from 0 to 1.");
  }

  let figure: QuantityEstimate | null = null;
  if (body.figure !== undefined && body.figure !== null) {
    if (kind !== "quantity" || stance !== "states") {
      return refuse("FIGURE", "figure goes with stance states on a quantity.");
    }
    const parsed = quantityEstimateSchema.safeParse(body.figure);
    if (!parsed.success) {
      return refuse("FIGURE", `figure is not a figure this can record: ${parsed.error.issues.map((i) => i.message).join("; ")}.`);
    }
    if (!(STATED_FIGURE_FORMS as readonly string[]).includes(parsed.data.form)) {
      return refuse(
        "FIGURE",
        `figure.form must be one of ${STATED_FIGURE_FORMS.join(", ")}: one figure (central), a range (low, high), or a side of a figure (bound).`
      );
    }
    figure = parsed.data;
  }
  if (kind === "quantity" && stance === "states" && !figure) {
    return refuse(
      "FIGURE",
      'stance states needs figure, in the quantity\'s own unit: {"form":"point","central":N}, ' +
        '{"form":"interval","low":N,"high":N}, or {"form":"bound","bound":{"side":"above"|"below","value":N}}.'
    );
  }

  const evidenceUrls = Array.isArray(body.evidence_urls)
    ? body.evidence_urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20)
    : [];

  return {
    ok: true,
    view: {
      stance: stance as StatedViewStance,
      probability,
      figure,
      statement,
      reasons,
      stake: noStake ? null : stakeText,
      evidenceUrls,
    },
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "12 November 2026", in UTC, the day the source row is dated. */
function longDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The speaker's name as a source's party: a name, cut to the length the interest record allows. */
function speakerNameOf(displayName: string): string {
  const name = displayName.replace(/\s+/g, " ").trim() || "An account with no name";
  return name.length > INTEREST_PARTY_MAX_CHARS ? name.slice(0, INTEREST_PARTY_MAX_CHARS) : name;
}

/**
 * File a stated view. Nothing reaches the node yet: the statement is stored
 * as a source, which no read path reaches except through an instance, and
 * filed as a contribution for the Contribution Reviewer.
 */
export async function createStatedView(input: {
  claimId: string;
  contributorId: string;
  speakerDisplayName: string;
  view: StatedViewInput;
}): Promise<{ statedViewId: string; contributionId: string; sourceId: string }> {
  const { view } = input;
  const speaker = speakerNameOf(input.speakerDisplayName);
  const now = new Date();
  // The source is the statement itself, in the speaker's words and nothing
  // else: the view, then the reasons where it gave any.
  const document = view.reasons ? `${view.statement}\n\n${view.reasons}` : view.statement;
  const label = currentLabel();

  const created = await withTransaction(async (tx) => {
    const [source] = await tx.query<{ id: string }>(
      `INSERT INTO sources
         (url, title, raw_content, content_hash, source_type, authors, published_date,
          page_url_hash, facts_checked_at, sensitivity_label)
       VALUES (NULL, $1, $2, $3, 'unknown', $4, $5, '', now(), $6)
       RETURNING id`,
      [
        `Statement to the graph by ${speaker}, ${longDate(now)}`,
        document,
        sourceContentHash(document),
        [speaker],
        now.toISOString().slice(0, 10),
        label,
      ]
    );
    const [contribution] = await tx.query<{ id: string }>(
      `INSERT INTO contributions
         (claim_id, contributor_id, contribution_type, content, evidence_urls, source_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.claimId,
        input.contributorId,
        STATED_VIEW_CONTRIBUTION_TYPE,
        document,
        view.evidenceUrls,
        source!.id,
        label,
      ]
    );
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO stated_views
         (contribution_id, stance, stated_probability, stated_estimate, statement, reasons, stake)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        contribution!.id,
        view.stance,
        view.probability,
        view.figure ? JSON.stringify(view.figure) : null,
        view.statement,
        view.reasons,
        view.stake,
      ]
    );
    return { statedViewId: row!.id, contributionId: contribution!.id, sourceId: source!.id };
  });

  await enqueueContribution({ contributionId: created.contributionId });
  return created;
}

interface PendingRow {
  id: string;
  instance_id: string | null;
  stance: string;
  stated_probability: number | null;
  stated_estimate: QuantityEstimate | null;
  statement: string;
  reasons: string | null;
  stake: string | null;
  created_at: Date;
  claim_id: string | null;
  source_id: string | null;
  evidence_urls: string[] | null;
  node_state: string | null;
  node_kind: string | null;
  merged_into: string | null;
  speaker: string | null;
  is_verified: boolean;
}

async function loadForAdmission(
  contributionId: string,
  run: { query: <T>(q: string, p?: unknown[]) => Promise<T[]> },
  lock: boolean
): Promise<PendingRow | null> {
  const [row] = await run.query<PendingRow>(
    `SELECT sv.id, sv.instance_id, sv.stance, sv.stated_probability, sv.stated_estimate,
            sv.statement, sv.reasons, sv.stake, sv.created_at,
            c.claim_id, c.source_id, c.evidence_urls,
            n.state AS node_state, n.kind AS node_kind, n.merged_into,
            s.authors[1] AS speaker, p.is_verified
       FROM stated_views sv
       JOIN contributions c ON c.id = sv.contribution_id
       JOIN contributors p ON p.id = c.contributor_id
       LEFT JOIN claims n ON n.id = c.claim_id
       LEFT JOIN sources s ON s.id = c.source_id
      WHERE sv.contribution_id = $1${lock ? " FOR UPDATE OF sv" : ""}`,
    [contributionId]
  );
  return row ?? null;
}

/**
 * Why a stated view cannot be admitted as it stands, or null. Checked before
 * anything is written, so the reviewing agent is told while it can still
 * decide otherwise.
 */
export async function statedViewAdmissionRefusal(contributionId: string): Promise<string | null> {
  const row = await loadForAdmission(contributionId, { query: rawQuery }, false);
  if (!row) return `Contribution ${contributionId} carries no stated view. Nothing was recorded.`;
  if (row.instance_id) return null;
  if (!row.claim_id || !row.source_id || !row.node_kind) {
    return `Stated view ${row.id} has lost its node or its source and cannot be admitted. Nothing was recorded.`;
  }
  if (row.node_state !== "active") {
    // A stance is stated against a node as it was worded. A node merged
    // since may run the other way, so the view is not carried across.
    return (
      `The node this view was stated on is no longer active` +
      (row.merged_into ? ` (it was merged into ${row.merged_into})` : "") +
      `. A stance is stated against a node as worded, so it is not carried to another node. Reject the ` +
      `contribution and say so: the speaker can state its view on the node that now holds the proposition. ` +
      `Nothing was recorded.`
    );
  }
  return null;
}

const STANCE_WORDS: Record<string, string> = {
  affirms: "affirms it",
  denies: "denies it",
  qualifies: "holds it with a qualification",
  gives_probability: "gives it a probability and takes no side",
  states: "states a figure for it",
  answers: "answers it",
  open: "treats it as open",
};

function figureWords(e: QuantityEstimate | null): string | null {
  if (!e) return null;
  if (e.form === "point" && e.central != null) return String(e.central);
  if (e.form === "interval" && e.low != null && e.high != null) return `${e.low} to ${e.high}`;
  if (e.form === "bound" && e.bound) return `${e.bound.side} ${e.bound.value}`;
  return null;
}

/**
 * Make an admitted stated view an instance of its node, with the speaker's
 * declared stake recorded as its source's interest, and put its reasons,
 * where it gave any, in front of the node's Steward. Idempotent: a view
 * already admitted is left as it is and nothing is sent twice.
 */
export async function admitStatedView(
  contributionId: string,
  by: "contribution_reviewer" | "dispute_arbitrator" = "contribution_reviewer"
): Promise<{ instanceId: string; alreadyAdmitted: boolean; reasonsSent: boolean }> {
  const refusal = await statedViewAdmissionRefusal(contributionId);
  if (refusal) throw new Error(refusal);

  const admitted = await withTransaction(async (tx) => {
    const row = (await loadForAdmission(contributionId, tx, true))!;
    if (row.instance_id) return { row, instanceId: row.instance_id, alreadyAdmitted: true };
    const kind = row.node_kind as NodeKind;
    const speaker = row.speaker ?? "An account with no name";
    const [instance] = await tx.query<{ id: string }>(
      `INSERT INTO claim_instances
         (claim_id, source_id, verbatim_text, context, stance, stated_probability, stated_estimate,
          confidence, speaker, source_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1.0, $8, $9, 'speaker')
       RETURNING id`,
      [
        row.claim_id,
        row.source_id,
        row.statement,
        "Stated to the graph directly by the speaker, not taken from a published source.",
        instanceStanceForStatedView(kind, row.stance as StatedViewStance),
        row.stated_probability,
        row.stated_estimate ? JSON.stringify(row.stated_estimate) : null,
        speaker,
        new Date(row.created_at).toISOString().slice(0, 10),
      ]
    );
    await tx.query(`UPDATE stated_views SET instance_id = $2 WHERE id = $1`, [row.id, instance!.id]);
    if (row.stake) {
      // The speaker's own declaration (§9), scoped to this node. A Steward
      // that finds a stake the speaker did not declare records it the usual
      // way, and the newer record is the one readers are shown.
      await tx.query(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, run_id)
         VALUES ($1, $2, $3, $4, 'speaker', $5)`,
        [row.source_id, row.claim_id, speaker, row.stake, getUsageContext().runId ?? null]
      );
    }
    return { row, instanceId: instance!.id, alreadyAdmitted: false };
  });

  let reasonsSent = false;
  const { row } = admitted;
  if (!admitted.alreadyAdmitted && row.reasons && row.claim_id) {
    const figure = figureWords(row.stated_estimate);
    const lines = [
      `Contribution ${contributionId} (${STATED_VIEW_CONTRIBUTION_TYPE}): a view stated to the graph directly (§4), ` +
        (by === "contribution_reviewer"
          ? "admitted by the Contribution Reviewer."
          : "admitted on a ruling of the Dispute Arbitrator.") +
        " Admission is a hearing, not a verdict (§14).",
      `The speaker is the account named "${row.speaker ?? ""}". ` +
        (row.is_verified
          ? "Minerval has verified who is behind the account."
          : "The name is the account's own, and nobody has checked who is behind it."),
      `It is recorded as instance ${admitted.instanceId} of this node, where the speaker ` +
        `${STANCE_WORDS[row.stance] ?? row.stance}` +
        (row.stated_probability != null ? `, with a probability of ${row.stated_probability}` : "") +
        (figure ? `: ${figure}` : "") +
        ".",
      row.stake
        ? `Its stake in the answer, as it declared it: ${row.stake}`
        : "It declared that it has no stake in the answer.",
      `The view, in the speaker's words:\n${row.statement}`,
      `The reasons it gave:\n${row.reasons}`,
      ...((row.evidence_urls ?? []).length > 0 ? [`Links it gave: ${(row.evidence_urls ?? []).join(" ")}`] : []),
      "Where these reasons go against your assessment they are a challenge, and §14 applies: answer them on " +
        "the substance, and change the page only where they meet the standard anything else on it meets. The " +
        "instance is one voice among the node's instances (§4), weighed as any source is, with its interest (§9). " +
        "get_contribution_details reads the whole record, with the reasoning that admitted it.",
    ];
    await enqueueSteward({
      claimId: row.claim_id,
      trigger: by === "contribution_reviewer" ? "contribution_accepted" : "arbitration_outcome",
      context: lines.join("\n"),
      sender: { kind: by, ref: contributionId },
    });
    reasonsSent = true;
  }
  return { instanceId: admitted.instanceId, alreadyAdmitted: admitted.alreadyAdmitted, reasonsSent };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface StatedViewView {
  id: string;
  contribution_id: string;
  instance_id: string;
  source_id: string | null;
  node: { id: string; kind: NodeKind; text: string; page_url: string };
  speaker: {
    /** The account that stated it; its page is /contributors/:id. */
    id: string;
    /** The account's name when it made the statement. */
    name: string;
    /** Whether an operator has verified who is behind the account. False means the name is the account's own word. */
    verified: boolean;
  };
  stated_at: string;
  /** True for the newest admitted statement by this speaker on this node; an earlier one is kept and marked false. */
  current: boolean;
  /** How the speaker stands toward the node as now worded, in the stated view's own vocabulary. */
  stance: string;
  /** Present only when it differs from `stance`: what the speaker chose when it made the statement. */
  stance_as_stated?: string;
  /** The probability the speaker gave for a claim, or null. */
  probability: number | null;
  /** The figure the speaker gave for a quantity, in the estimate shape, or null. */
  figure: QuantityEstimate | null;
  /** The view, in the speaker's words. */
  statement: string;
  /** What the speaker says it stands to gain or lose by the answer; null when it declared that it has none. */
  stake: string | null;
  /** Whether the speaker gave reasons. They are read on the contribution's record (record_url). */
  gave_reasons: boolean;
  /**
   * What became of the reasons: null when none were given; "waiting" until a
   * pass on the node has read them; then the Steward's answer.
   */
  challenge: {
    state: "waiting" | "answered";
    sent_at: string;
    answered_at: string | null;
    /** changed: the page changed. no_change: weighed, nothing changed. disagree: the Steward disagreed. */
    outcome: string | null;
    note: string | null;
  } | null;
  /** The contribution's public record: the statement, its reasons, and the review that admitted it. */
  record_url: string;
  /** Set when the node's Steward detached the instance: it read the statement as not about this node. */
  detached?: { reason: string | null };
  /** The judgment in force on the node, or null when it has not been assessed. */
  judgment: {
    status: string | null;
    credence: number | null;
    estimate: QuantityEstimate | null;
    standing: string | null;
    assessed_at: string;
  } | null;
  comparison: ViewComparison;
  /** Whether the statement was made before or after the judgment in force; null when there is none. */
  stated: "before_current_assessment" | "after_current_assessment" | null;
}

interface ViewRow {
  id: string;
  contribution_id: string;
  instance_id: string;
  source_id: string | null;
  stated_stance: string;
  statement: string;
  reasons: string | null;
  stake: string | null;
  created_at: Date;
  contributor_id: string;
  is_verified: boolean;
  speaker: string | null;
  node_id: string;
  node_kind: string;
  node_text: string;
  instance_stance: string;
  stated_probability: number | null;
  stated_estimate: QuantityEstimate | null;
  detached_at: Date | null;
  detached_reason: string | null;
  is_newest: boolean;
  status: string | null;
  credence: number | null;
  claim_assessed_at: Date | null;
  estimate: QuantityEstimate | null;
  estimate_assessed_at: Date | null;
  standing: string | null;
  question_assessed_at: Date | null;
  message_sent_at: Date | null;
  message_read_at: Date | null;
  message_outcome: string | null;
  message_note: string | null;
  message_answered_at: Date | null;
}

const base = () => loadConfig().publicWebBaseUrl.replace(/\/$/, "");

/** The instance stance back in the stated view's own vocabulary. */
function statedStanceOf(instanceStance: string): string {
  return instanceStance === "poses" || instanceStance === "asks" ? "open" : instanceStance;
}

function toView(r: ViewRow): StatedViewView {
  const kind = (r.node_kind ?? "claim") as NodeKind;
  const assessedAt =
    kind === "quantity" ? r.estimate_assessed_at : kind === "question" ? r.question_assessed_at : r.claim_assessed_at;
  const judged =
    kind === "quantity" ? r.estimate != null : kind === "question" ? r.standing != null : r.status != null;
  const stance = statedStanceOf(r.instance_stance);
  const comparison = compareStatedView(
    { kind, stance: r.instance_stance, probability: r.stated_probability, estimate: r.stated_estimate },
    { status: r.status, credence: r.credence, estimate: r.estimate, standing: r.standing }
  );
  return {
    id: r.id,
    contribution_id: r.contribution_id,
    instance_id: r.instance_id,
    source_id: r.source_id,
    node: { id: r.node_id, kind, text: r.node_text, page_url: `${base()}/claims/${r.node_id}` },
    speaker: { id: r.contributor_id, name: r.speaker ?? "An account with no name", verified: r.is_verified },
    stated_at: new Date(r.created_at).toISOString(),
    current: r.is_newest,
    stance,
    ...(stance !== r.stated_stance ? { stance_as_stated: r.stated_stance } : {}),
    probability: r.stated_probability,
    figure: r.stated_estimate,
    statement: r.statement,
    stake: r.stake,
    gave_reasons: !!r.reasons,
    challenge: r.message_sent_at
      ? {
          state: r.message_answered_at ? "answered" : "waiting",
          sent_at: new Date(r.message_sent_at).toISOString(),
          answered_at: r.message_answered_at ? new Date(r.message_answered_at).toISOString() : null,
          outcome: r.message_outcome,
          note: r.message_note,
        }
      : null,
    record_url: `${base()}/contributions/${r.contribution_id}`,
    ...(r.detached_at ? { detached: { reason: r.detached_reason } } : {}),
    judgment:
      judged && assessedAt
        ? {
            status: r.status,
            credence: r.credence,
            estimate: r.estimate,
            standing: r.standing,
            assessed_at: new Date(assessedAt).toISOString(),
          }
        : null,
    comparison,
    stated:
      judged && assessedAt
        ? new Date(r.created_at).getTime() < new Date(assessedAt).getTime()
          ? "before_current_assessment"
          : "after_current_assessment"
        : null,
  };
}

/**
 * Admitted stated views with the judgment in force on each one's node. The
 * node and the stance are the instance's, so a view follows its instance
 * through a merge. `is_newest` marks the latest admitted statement of each
 * speaker on each node.
 */
async function loadViews(filter: { speakerId?: string; claimId?: string }): Promise<ViewRow[]> {
  return rawQuery<ViewRow>(
    `SELECT sv.id, sv.contribution_id, sv.instance_id, c.source_id,
            sv.stance AS stated_stance, sv.statement, sv.reasons, sv.stake, sv.created_at,
            c.contributor_id, p.is_verified, ci.speaker,
            n.id AS node_id, n.kind AS node_kind, n.text AS node_text,
            ci.stance AS instance_stance, ci.stated_probability, ci.stated_estimate,
            ci.detached_at, ci.detached_reason,
            (ROW_NUMBER() OVER (PARTITION BY c.contributor_id, ci.claim_id
                                ORDER BY sv.created_at DESC, sv.id DESC) = 1) AS is_newest,
            a.status, a.claim_credence AS credence, a.assessed_at AS claim_assessed_at,
            qe.estimate, qe.assessed_at AS estimate_assessed_at,
            qa.standing, qa.assessed_at AS question_assessed_at,
            m.created_at AS message_sent_at, m.read_at AS message_read_at,
            m.outcome AS message_outcome, m.outcome_note AS message_note,
            m.answered_at AS message_answered_at
       FROM stated_views sv
       JOIN contributions c ON c.id = sv.contribution_id
       JOIN contributors p ON p.id = c.contributor_id
       JOIN claim_instances ci ON ci.id = sv.instance_id
       JOIN claims n ON n.id = ci.claim_id
       LEFT JOIN assessments_in_force a ON a.claim_id = n.id AND n.kind = 'claim'
       LEFT JOIN quantity_estimates_in_force qe ON qe.claim_id = n.id AND n.kind = 'quantity'
       LEFT JOIN question_assessments_in_force qa ON qa.claim_id = n.id AND n.kind = 'question'
       LEFT JOIN LATERAL (
              SELECT nm.created_at, nm.read_at, nm.outcome, nm.outcome_note, nm.answered_at
                FROM node_messages nm
               WHERE nm.sender_ref = sv.contribution_id::text
                 AND nm.sender_kind IN ('contribution_reviewer', 'dispute_arbitrator')
               ORDER BY nm.created_at DESC
               LIMIT 1) m ON true
      WHERE n.state = 'active'
        AND ($1::uuid IS NULL OR c.contributor_id = $1::uuid)
        AND ($2::uuid IS NULL OR ci.claim_id = $2::uuid)
      ORDER BY sv.created_at DESC, sv.id DESC`,
    [filter.speakerId ?? null, filter.claimId ?? null]
  );
}

/**
 * Every admitted stated view on one node, newest first, earlier statements
 * by a speaker included and marked as not current: what a node's page shows.
 */
export async function statedViewsForClaim(claimId: string): Promise<StatedViewView[]> {
  return (await loadViews({ claimId })).map(toView);
}

export interface StatedViewSummary {
  /** Current stated views counted, one per speaker and node. */
  total: number;
  by_relation: Record<ViewRelation, number>;
  /** Among those that differ, how many lie each way. */
  by_direction: Partial<Record<ViewDirection, number>>;
}

export interface StatedViewList {
  /** Counts over every current stated view the filters select, not only this page. */
  summary: StatedViewSummary;
  stated_views: StatedViewView[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Where stated views and the judgments in force differ, and which way: the
 * current statement of each speaker on each node, for one speaker or all,
 * set beside the judgment on its node. A view whose instance the node's
 * Steward detached is left out: it was read as not about that node.
 */
export async function listStatedViews(filter: {
  speakerId?: string;
  claimId?: string;
  relation?: ViewRelation;
  limit: number;
  offset: number;
}): Promise<StatedViewList> {
  const rows = await loadViews({ speakerId: filter.speakerId, claimId: filter.claimId });
  const current = rows.filter((r) => r.is_newest && !r.detached_at).map(toView);
  const summary: StatedViewSummary = {
    total: current.length,
    by_relation: Object.fromEntries(VIEW_RELATIONS.map((r) => [r, 0])) as Record<ViewRelation, number>,
    by_direction: {},
  };
  for (const v of current) {
    summary.by_relation[v.comparison.relation] += 1;
    const d = v.comparison.direction;
    if (d) summary.by_direction[d] = (summary.by_direction[d] ?? 0) + 1;
  }
  // Keep the directions in their declared order, so two reads list them alike.
  summary.by_direction = Object.fromEntries(
    VIEW_DIRECTIONS.filter((d) => summary.by_direction[d]).map((d) => [d, summary.by_direction[d]!])
  );
  const selected = filter.relation ? current.filter((v) => v.comparison.relation === filter.relation) : current;
  return {
    summary,
    stated_views: selected.slice(filter.offset, filter.offset + filter.limit),
    total: selected.length,
    limit: filter.limit,
    offset: filter.offset,
  };
}

/**
 * The stated view a contribution carries, for the contribution's own
 * record: what was said, how the speaker stands, its stake and its reasons,
 * whether it has been admitted, and what became of the reasons. Null for a
 * contribution of any other type.
 */
export async function statedViewForContribution(contributionId: string): Promise<Record<string, unknown> | null> {
  const [row] = await rawQuery<{
    id: string;
    instance_id: string | null;
    stance: string;
    stated_probability: number | null;
    stated_estimate: QuantityEstimate | null;
    statement: string;
    reasons: string | null;
    stake: string | null;
    created_at: Date;
    speaker: string | null;
    contributor_id: string;
    is_verified: boolean;
    source_id: string | null;
    message_sent_at: Date | null;
    message_outcome: string | null;
    message_note: string | null;
    message_answered_at: Date | null;
  }>(
    `SELECT sv.id, sv.instance_id, sv.stance, sv.stated_probability, sv.stated_estimate,
            sv.statement, sv.reasons, sv.stake, sv.created_at,
            s.authors[1] AS speaker, c.contributor_id, p.is_verified, c.source_id,
            m.created_at AS message_sent_at, m.outcome AS message_outcome,
            m.outcome_note AS message_note, m.answered_at AS message_answered_at
       FROM stated_views sv
       JOIN contributions c ON c.id = sv.contribution_id
       JOIN contributors p ON p.id = c.contributor_id
       LEFT JOIN sources s ON s.id = c.source_id
       LEFT JOIN LATERAL (
              SELECT nm.created_at, nm.outcome, nm.outcome_note, nm.answered_at
                FROM node_messages nm
               WHERE nm.sender_ref = sv.contribution_id::text
                 AND nm.sender_kind IN ('contribution_reviewer', 'dispute_arbitrator')
               ORDER BY nm.created_at DESC
               LIMIT 1) m ON true
      WHERE sv.contribution_id::text = $1`,
    [contributionId]
  );
  if (!row) return null;
  return {
    id: row.id,
    speaker: {
      id: row.contributor_id,
      name: row.speaker ?? "An account with no name",
      verified: row.is_verified,
    },
    stated_at: new Date(row.created_at).toISOString(),
    stance: row.stance,
    probability: row.stated_probability,
    figure: row.stated_estimate,
    statement: row.statement,
    reasons: row.reasons,
    stake: row.stake,
    source_id: row.source_id,
    // Null until the Contribution Reviewer admits it; then the instance it became.
    instance_id: row.instance_id,
    challenge: row.message_sent_at
      ? {
          state: row.message_answered_at ? "answered" : "waiting",
          sent_at: new Date(row.message_sent_at).toISOString(),
          answered_at: row.message_answered_at ? new Date(row.message_answered_at).toISOString() : null,
          outcome: row.message_outcome,
          note: row.message_note,
        }
      : null,
  };
}

/** The ids of the instances on a node that are stated views, for reads that set them apart. */
export async function statedViewInstanceIds(claimId: string): Promise<Set<string>> {
  const rows = await rawQuery<{ instance_id: string }>(
    `SELECT sv.instance_id FROM stated_views sv
       JOIN claim_instances ci ON ci.id = sv.instance_id
      WHERE ci.claim_id = $1`,
    [claimId]
  );
  return new Set(rows.map((r) => r.instance_id));
}
