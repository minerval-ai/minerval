/**
 * Program officers, and the Grantmaker deciding what they escalate.
 *
 * A sitting works one mandate's inbox (petition-service.ts holds the lease):
 * a program officer on the cheap tier decides what the operating policy
 * settles and escalates the rest; then, when anything was escalated, the
 * Grantmaker decides it on the strong tier. Each run is commissioned from the
 * mandate on its own ledger row (officer:<grant>, escalation:<grant>), so it
 * counts against the mandate's rate and escrow like any of its work and
 * returns what it does not spend.
 *
 * Both runs read the same brief: the mandate (its approved terms, then its
 * operating policy), where its money stands, its recent decisions, and the
 * items in front of them, each petition with the chain of runs that led to
 * it and how similar petitions went. Tool descriptions and system prompts are
 * fixed per role; everything that varies is in the task message.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { currentLabel, runWithUsageContext, withAgent, withPassBudget, withSkills } from "../usage-context.js";
import { getProgramOfficerSystemPromptBlocks } from "../prompts/program-officer.js";
import { getGraphReadToolDefinitions, executeGraphReadTool } from "../tools/graph-read-tools.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";
import { listSkills } from "../prompts/skills.js";
import { executeSkillTool, getActiveSkillToolDefinitions } from "../tools/skill-tools.js";
import { RUN_TURN_GUARD, runBudgetSentence } from "../prompts/turn-budget.js";
import { claimAction, completeAction, releaseAction } from "../../services/action-service.js";
import { commissionAction, commissionNodePass, placeCommission } from "../../services/commission-service.js";
import { describePace, paceRoom, parsePace, validatePace } from "../../services/pace-service.js";
import { grantCommittedMicroUsd } from "../../services/regrant-service.js";
import {
  holdPetition,
  latestHold,
  decidePetition,
  inboxWaiting,
  type DecisionKind,
  PETITION_COLUMNS,
  type PetitionRow,
} from "../../services/petition-service.js";
import {
  getOperatingPolicy,
  officerLimit,
  renderOperatingPolicy,
  writeOperatingPolicy,
  describeLimit,
  type PolicySection,
} from "../../services/operating-policy-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";

type Tool = Anthropic.Tool;
type Role = "officer" | "grantmaker";

const OFFICER_GROUP = (grantId: string) => `officer:${grantId}`;

/**
 * Inbox items one sitting reads, oldest first. A cap on what fits one brief,
 * not on what is decided: the rest wait for the next sitting, which starts
 * as soon as this one ends while anything is left, and the brief says how
 * many wait.
 */
const ITEMS_PER_SITTING = 60;

// ---------------------------------------------------------------------------
// Tools (fixed per role)
// ---------------------------------------------------------------------------

const DECIDE_PETITIONS: Tool = {
  name: "decide_petitions",
  description:
    "Answer petitions in your inbox. For each: grant (all or part, in owls), " +
    "refuse, or follow_up (fund a fresh pass with the petitioner's plan as its " +
    "brief, at the budget you set). reason is shown to the petitioner and on " +
    "the mandate's public record: say what about the work made the " +
    "difference. Officers: a decision above the limit your task message " +
    "states is refused here; escalate it.",
  input_schema: {
    type: "object" as const,
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            petition: { type: "string", description: "Its label from your brief (p1, p2, …), or the petition's id." },
            decision: { type: "string", enum: ["grant", "refuse", "follow_up"] },
            owls: {
              type: "number",
              description: "For grant, how much (at most what was asked). For follow_up, the follow-up pass's budget.",
            },
            reason: { type: "string", description: "What made the difference, for the petitioner and the record." },
          },
          required: ["petition", "decision", "reason"],
        },
      },
    },
    required: ["decisions"],
  },
};

export const COMMISSION_FOR_MANDATE: Tool = {
  name: "commission",
  description:
    "Pay for runs from your mandate's money: one entry or many. Each entry is " +
    "a Steward pass on a node (target); research (kind research, Grantmaker " +
    "only: a Researcher run on a question the mission needs answered, its " +
    "brief the whole task, its report returned into your session, optionally " +
    "with contribution_budget_owls so it submits what the graph should hold " +
    "as contributions, reviewed like anyone's); or any open row on the ledger by its " +
    "action_id (an ingest, a curation, an audit, work on a request; an inbox " +
    "item names its row), with a budget from the operating policy and the " +
    "costing skill (the high end, unless the operating policy says otherwise), " +
    "a tier, a brief for the Steward, and your reason for the public record. " +
    "The brief reaches the node's Steward as a message; it may not name the " +
    "mandate or describe its mission. Runs count against the mandate's pace as they " +
    "spend and are released as they finish; an entry the pace, the reserve or the escrow " +
    "can't cover is refused and named. Work is paid for once: where a run " +
    "is already commissioned or under way, on any variant of the same work " +
    "(a node's standard and strong pass, a sweep's two readers), nothing " +
    "more is spent. A node that already has a pass paid for gets your " +
    "brief in its inbox, at no cost. A pass named by its row's action_id " +
    "is commissioned on that row's tier and queues its node, like one " +
    "named by target.",
  input_schema: {
    type: "object" as const,
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "string", description: "Optional: the inbox item this answers (i1, i2, …, or its id); it is marked handled." },
            kind: { type: "string", enum: ["pass", "research"], description: "pass (the default, with target or action_id) or research." },
            research_tier: { type: "string", enum: ["cheap", "standard", "strong"], description: "For research: the Researcher's tier." },
            contribution_budget_owls: {
              type: "number",
              description: "For research: owls of the mandate's money for reviewing the contributions it submits (default 0: it only reports).",
            },
            target: { type: "string", description: "For a Steward pass: the node's id." },
            action_id: { type: "string", description: "For any other work: the ledger row's id." },
            budget_owls: { type: "number" },
            tier: { type: "string", enum: ["standard", "strong"] },
            brief: { type: "string", description: "What the Steward should look at, and why." },
            reason: { type: "string", description: "Why this is worth the mandate's money, in a line." },
          },
          required: ["budget_owls", "brief", "reason"],
        },
      },
    },
    required: ["entries"],
  },
};

const HOLD: Tool = {
  name: "hold",
  description:
    "Hold a petition or an item for perspective rather than decide it now: until a time, or until named runs " +
    "on the ledger settle (whichever comes first), saying what you are waiting to learn. Use it when related " +
    "work is under way and its results would change the decision: deciding the third depth petition on a branch " +
    "once the first two passes there report, say. It comes back to you then, with your criteria; it is never " +
    "refused by the time passing. The asking run is told at once, without being woken, that its answer will come " +
    "later and why. Where a run waits on the petition, the hold must end before that run's session gives up " +
    "waiting; the brief states that latest time for each petition. Holding is a decision: it is recorded with " +
    "your criteria.",
  input_schema: {
    type: "object" as const,
    properties: {
      item: { type: "string", description: "The petition or item: its label from your brief (p1, i1, …) or its id." },
      in_hours: { type: "number", description: "Hold at most this many hours." },
      until: { type: "string", description: "Or: hold at most until this time (ISO 8601, UTC)." },
      until_runs: { type: "array", items: { type: "string" }, description: "Optional: action ids of runs whose results you are waiting on." },
      criteria: { type: "string", description: "What you are waiting to learn, and what would decide it." },
    },
    required: ["item", "criteria"],
  },
};

const DECLINE: Tool = {
  name: "decline",
  description:
    "Record that this mandate will not fund an item now, and why. The item is " +
    "handled; the work stays on the ledger for anyone else, and comes back to " +
    "you only if something about it changes.",
  input_schema: {
    type: "object" as const,
    properties: {
      item: { type: "string", description: "Its label from your brief (i1, i2, …), or the item's id." },
      reason: { type: "string" },
    },
    required: ["item", "reason"],
  },
};

const ESCALATE: Tool = {
  name: "escalate",
  description:
    "Send a petition or an item to the Grantmaker with what you found and why " +
    "you can't settle it: the operating policy is silent or ambiguous, the " +
    "decision is beyond your limit, or it bears on the mandate's direction. A " +
    "petition with a run waiting goes to the Grantmaker at once; other items " +
    "wait for its next sitting.",
  input_schema: {
    type: "object" as const,
    properties: {
      item: { type: "string", description: "A petition (p1, …) or an item (i1, …)." },
      note: { type: "string", description: "What you found, and why it needs the Grantmaker." },
    },
    required: ["item", "note"],
  },
};

const LOG_NOTE: Tool = {
  name: "log_note",
  description:
    "Add a line to the mandate's decision log for the Grantmaker's next " +
    "review: a pattern you noticed, a gap in the operating policy, an item " +
    "you are leaving and why.",
  input_schema: {
    type: "object" as const,
    properties: { note: { type: "string" } },
    required: ["note"],
  },
};

export const WRITE_OPERATING_POLICY: Tool = {
  name: "write_operating_policy",
  description:
    "Rewrite your mandate's operating policy, or one section of it. The " +
    "operating policy is your standing instructions to the program officers " +
    "who carry the mandate out day to day, and the public statement of how it " +
    "spends. Write it as you would brief a capable colleague: what the mission " +
    "covers and doesn't; what kinds of work it pays for and how much each is " +
    "usually worth; how to set budgets (the costing skill's figures are the " +
    "base, so say where in the range and when to go higher); how to answer " +
    "petitions; and what to send to you. Be specific where it matters. Each " +
    "version is kept with your note and shown on the mandate's page. The " +
    "mandate's terms bind the operating policy, and it may not steer " +
    "verdicts. This tool can't change the title or objective: those are what " +
    "your funder approved, and they change only with amend_objective, in your " +
    "funder's chat.",
  input_schema: {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        enum: ["current", "mission", "priorities", "budgets", "petitions", "delegation"],
        description:
          "current (your direction for now, beside the standing policy: which branches look promising, what to " +
          "grant and what to hold until which work reports; rewrite it as often as things change, and your officers " +
          "read it first, dated), mission (how you read the mandate's words), priorities, budgets, petitions, or " +
          "delegation. Leave it out to replace the whole operating policy.",
      },
      content: {
        type: "string",
        description:
          "The section's new text, or the whole operating policy. An empty string with officer_limit_owls or " +
          "review_pass_owls changes that figure alone.",
      },
      officer_limit_owls: {
        type: "number",
        description: "Delegation only: the most a program officer may commit in one decision without you. It is stated to the officers, with your note as its reason.",
      },
      review_pass_owls: {
        type: "number",
        description:
          "The budget each of your own sittings works to, in owls, from the next one. It is yours to set " +
          "because your mandate pays for it: the whole figure is held against the mandate's pace while a pass runs, and " +
          "what the pass does not spend is freed when it ends. Each pass first pays for its opening turn (your " +
          "instructions, tool list and briefing), so set it to what a pass of yours actually needs on top of that. " +
          "Your note is recorded as its reason and stated in each pass's briefing. To set it and leave the text as " +
          "it is, send content as an empty string.",
      },
      note: { type: "string", description: "What you learned that justifies the change, for the public record." },
    },
    required: ["content", "note"],
  },
};

export function getOfficerToolDefinitions(role: Role): Tool[] {
  const costing = getActiveSkillToolDefinitions(listSkills(), "program-officer");
  const base = [DECIDE_PETITIONS, COMMISSION_FOR_MANDATE, HOLD, DECLINE, LOG_NOTE, ...getGraphReadToolDefinitions(), getSqlToolDefinition(), ...costing];
  return role === "officer" ? [...base, ESCALATE] : [...base, WRITE_OPERATING_POLICY];
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  title: string | null;
  objective: string | null;
  budget_job_id: string;
  funder_user_id: string;
  escrow: number;
}

interface InboxItem {
  id: string;
  kind: string;
  target_node_id: string | null;
  target_ref: string | null;
  source: string;
  summary: string;
  detail: Record<string, unknown>;
  created_at: string;
  escalation_note: string | null;
  node_text: string | null;
  importance: number | null;
  contestation: number | null;
}

const owls = (micro: number | string | null | undefined) => microUsdToOwls(Number(micro ?? 0));

function ago(iso: string): string {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 48 ? `${Math.max(0, h)}h ago` : `${Math.round(h / 24)} days ago`;
}

async function loadGrant(grantId: string): Promise<GrantRow | null> {
  const [g] = await rawQuery<GrantRow>(
    `SELECT g.id, g.mandate->>'title' AS title, g.mandate->>'objective' AS objective,
            g.budget_job_id, g.funder_user_id,
            j.budget_micro_usd AS escrow
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1`,
    [grantId]
  );
  return g ?? null;
}

async function petitionsFor(grantId: string, role: Role): Promise<PetitionRow[]> {
  return rawQuery<PetitionRow>(
    `SELECT ${PETITION_COLUMNS} FROM petitions
      WHERE grant_id = $1 AND status = $2
      ORDER BY waiting DESC, created_at`,
    [grantId, role === "officer" ? "pending" : "escalated"]
  );
}

async function itemsFor(grantId: string, role: Role): Promise<InboxItem[]> {
  return rawQuery<InboxItem>(
    `SELECT i.id, i.kind, i.target_node_id, i.target_ref, i.source, i.summary, i.detail,
            i.created_at, i.escalation_note, c.text AS node_text, c.importance, c.contestation
       FROM mandate_inbox i LEFT JOIN claims c ON c.id = i.target_node_id
      WHERE i.grant_id = $1 AND i.handled_at IS NULL AND i.held_until IS NULL
        AND (i.escalated_at IS ${role === "officer" ? "NULL" : "NOT NULL"})
      ORDER BY i.created_at
      LIMIT ${ITEMS_PER_SITTING}`,
    [grantId]
  );
}

async function describePetition(p: PetitionRow, label: string): Promise<string> {
  const [node] = p.requester_node_id
    ? await rawQuery<{ text: string; importance: number | null; contestation: number | null }>(
        `SELECT text, importance, contestation FROM claims WHERE id = $1`,
        [p.requester_node_id]
      )
    : [];
  // What granting asks like this one bought (information gained, never a
  // verdict): of the granted petitions of this kind from this agent to this
  // mandate, how many were followed by an assessment of the node, and in how
  // many that assessment moved the status or the confidence by a tenth or more.
  const [returns] = await rawQuery<{ n: number; refused: number; granted: number; concluded: number; moved: number; granted_owls: number }>(
    `WITH done AS (
       SELECT p.id, p.status, p.requester_node_id AS node, p.created_at, p.decided_at, p.granted_micro_usd
         FROM petitions p
        WHERE p.grant_id = $1 AND p.kind = $2 AND p.requester_agent IS NOT DISTINCT FROM $3
          AND p.status IN ('granted', 'refused', 'follow_up') AND p.id <> $4
     ), granted AS (
       SELECT d.*,
              (SELECT a.status FROM assessments a WHERE a.claim_id = d.node AND a.assessed_at < d.created_at ORDER BY a.assessed_at DESC LIMIT 1) AS s0,
              (SELECT a.confidence FROM assessments a WHERE a.claim_id = d.node AND a.assessed_at < d.created_at ORDER BY a.assessed_at DESC LIMIT 1) AS c0,
              (SELECT a.status FROM assessments a WHERE a.claim_id = d.node AND a.assessed_at > d.decided_at ORDER BY a.assessed_at LIMIT 1) AS s1,
              (SELECT a.confidence FROM assessments a WHERE a.claim_id = d.node AND a.assessed_at > d.decided_at ORDER BY a.assessed_at LIMIT 1) AS c1
         FROM done d WHERE d.status IN ('granted', 'follow_up') AND d.node IS NOT NULL
     )
     SELECT (SELECT count(*) FROM done)::int AS n,
            (SELECT count(*) FROM done WHERE status = 'refused')::int AS refused,
            (SELECT count(*) FROM done WHERE status IN ('granted', 'follow_up'))::int AS granted,
            (SELECT COALESCE(SUM(granted_micro_usd), 0) FROM done)::bigint AS granted_owls,
            (SELECT count(*) FROM granted WHERE s1 IS NOT NULL)::int AS concluded,
            (SELECT count(*) FROM granted WHERE s1 IS NOT NULL
               AND (s1 IS DISTINCT FROM s0 OR abs(COALESCE(c1, 0) - COALESCE(c0, 0)) >= 0.1))::int AS moved`,
    [p.grant_id, p.kind, p.requester_agent, p.id]
  );
  // What the run has already paid for from its own budget, and how that went.
  const bought = p.requester_action_id
    ? await rawQuery<{ kind: string; status: string; amount: number; spent: number }>(
        `SELECT a.kind, a.status, al.amount_micro_usd AS amount, al.spent_micro_usd AS spent
           FROM action_allocations al JOIN actions a ON a.id = al.action_id
          WHERE al.parent_action_id = $1 ORDER BY al.created_at`,
        [p.requester_action_id]
      )
    : [];
  // The node's neighbourhood: its parents, and its siblings' standing, with
  // what is asked or held on them, so asks on one branch are seen together.
  const siblings = p.requester_node_id
    ? await rawQuery<{ id: string; text: string; status: string | null; asks: number }>(
        `SELECT DISTINCT c.id, left(c.text, 80) AS text, f.status,
                (SELECT count(*) FROM petitions q WHERE q.requester_node_id = c.id AND q.grant_id = $2
                   AND q.status IN ('pending', 'held', 'escalated'))::int AS asks
           FROM claim_relationships up
           JOIN claim_relationships sib ON sib.parent_claim_id = up.parent_claim_id AND sib.child_claim_id <> $1
           JOIN claims c ON c.id = sib.child_claim_id AND c.state = 'active'
           LEFT JOIN assessments_in_force f ON f.claim_id = c.id
          WHERE up.child_claim_id = $1
          LIMIT 8`,
        [p.requester_node_id, p.grant_id]
      )
    : [];
  const chain = (p.chain ?? []) as Array<{ kind: string; node_id: string | null; budget_micro_usd: number; spent_micro_usd?: number }>;
  const self = chain.at(-1);
  const chainText =
    chain.length > 1
      ? chain
          .map((c, i) => `${i === chain.length - 1 ? "this run" : `${c.kind} on ${c.node_id ?? "-"}`} (${owls(c.budget_micro_usd)} owls)`)
          .join(" → ")
      : self
        ? `commissioned directly at ${owls(self.budget_micro_usd)} owls`
        : "not a ledger run";
  const latest = await latestHold(p);
  const r = returns ?? { n: 0, refused: 0, granted: 0, concluded: 0, moved: 0, granted_owls: 0 };
  return [
    `[${label}] ${p.kind} · ${owls(p.asked_micro_usd)} owls${p.waiting ? " · run waiting" : ""} · from ` +
      `${p.requester_agent ?? "an agent"}` +
      (p.requester_node_id
        ? ` on ${p.requester_node_id} ("${(node?.text ?? "").slice(0, 120)}", importance ${node?.importance ?? "?"}, contestation ${node?.contestation ?? "?"})`
        : ""),
    `  How it was funded: ${chainText}.` +
      (self?.spent_micro_usd != null ? ` Spent so far: ${owls(self.spent_micro_usd)} owls.` : ""),
    ...(p.done_so_far ? [`  What it has established so far: ${p.done_so_far}`] : []),
    ...(bought.length
      ? [
          `  What it has already commissioned: ` +
            bought.map((b) => `${b.kind} (${owls(b.spent)} of ${owls(b.amount)} owls, ${b.status})`).join("; ") +
            `.`,
        ]
      : []),
    `  Plan: ${p.plan}`,
    ...(p.why ? [`  Why: ${p.why}`] : []),
    ...(p.if_refused ? [`  If refused: ${p.if_refused}`] : []),
    ...(p.status === "escalated" && p.reason ? [`  The officer's note: ${p.reason}`] : []),
    ...(p.status === "pending" && p.reason?.startsWith("Held until") ? [`  ${p.reason}`] : []),
    ...(siblings.length
      ? [
          `  Its neighbours (other premises of the same parent): ` +
            siblings
              .map((x) => `${x.id} ("${x.text}", ${x.status ?? "unassessed"}${x.asks ? `, ${x.asks} ask(s) open here` : ""})`)
              .join("; ") +
            `.`,
        ]
      : []),
    `  Past asks like this (${p.kind} from ${p.requester_agent ?? "agents"} to this mandate): ` +
      (r.n > 0
        ? `${r.n} decided, ${r.granted} granted (${owls(r.granted_owls)} owls) and ${r.refused} refused. Of the granted, ` +
          `${r.concluded} have been assessed since, and in ${r.moved} of those the status or the confidence moved; ` +
          `a move is information gained, not a verdict the money bought.`
        : "none decided yet."),
    ...(latest
      ? [`  A run waits on this: hold it, if at all, no later than ${latest.toISOString().slice(0, 16).replace("T", " ")} UTC.`]
      : []),
  ].join("\n");
}

function describeItem(i: InboxItem, label: string): string {
  const detail = Object.entries(i.detail ?? {})
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
  return (
    `[${label}] ${i.kind} · from ${i.source} · ${ago(i.created_at)}` +
    (i.target_node_id
      ? ` · ${i.target_node_id} ("${(i.node_text ?? "").slice(0, 120)}", importance ${i.importance ?? "?"}, contestation ${i.contestation ?? "?"})`
      : i.target_ref
        ? ` · ${i.target_ref}`
        : "") +
    `\n  ${i.summary}` +
    (detail ? `\n  ${detail}` : "") +
    (i.escalation_note ? `\n  The officer's note: ${i.escalation_note}` : "")
  );
}

async function buildBrief(
  grant: GrantRow,
  role: Role,
  petitions: PetitionRow[],
  items: InboxItem[],
  labels: Map<string, { petition?: PetitionRow; item?: InboxItem }>
): Promise<string> {
  const policy = await getOperatingPolicy(grant.id);
  const limit = officerLimit(policy);
  // Officers commit from outside the reserve; the Grantmaker may draw on it.
  const pace = await paceRoom(grant.id, role === "officer" ? "delegated" : "grantmaker");
  const [deciding] = await rawQuery<{ deciding: number; spent: number }>(
    `SELECT COALESCE(SUM(al.spent_micro_usd) FILTER (WHERE al.exclusion_group LIKE 'officer:%' OR al.exclusion_group LIKE 'escalation:%'), 0)::bigint AS deciding,
            COALESCE(SUM(al.spent_micro_usd), 0)::bigint AS spent
       FROM action_allocations al
      WHERE al.grant_id = $1 AND al.created_at > now() - interval '7 days'`,
    [grant.id]
  );
  const decidingShare =
    Number(deciding?.spent ?? 0) > 0 ? Math.round((100 * Number(deciding!.deciding)) / Number(deciding!.spent)) : 0;
  // The mandate's recent decisions, and every decision ever made on the
  // nodes in front of the officer now, so a branch is judged as a branch.
  const targets = [
    ...petitions.map((p) => p.requester_node_id),
    ...items.map((i) => i.target_node_id),
  ].filter((x): x is string => Boolean(x));
  const decisions = await rawQuery<{ created_at: string; decided_by: string; item_kind: string; decision: string; target: string | null; owls_micro_usd: number | null; reason: string | null }>(
    `(SELECT created_at, decided_by, item_kind, decision, target, owls_micro_usd, reason
        FROM mandate_decisions WHERE grant_id = $1 AND created_at > now() - interval '14 days'
       ORDER BY created_at DESC LIMIT 40)
     UNION
     (SELECT created_at, decided_by, item_kind, decision, target, owls_micro_usd, reason
        FROM mandate_decisions WHERE grant_id = $1 AND target = ANY($2::text[])
       ORDER BY created_at DESC LIMIT 20)
     ORDER BY created_at DESC`,
    [grant.id, targets]
  );
  // What else the money could buy now: work waiting in front of the mandate
  // beyond this brief, and open work on the nodes it has paid for before.
  const [elsewhere] = await rawQuery<{ held: number; more_items: number; orders: number }>(
    `SELECT (SELECT count(*) FROM petitions WHERE grant_id = $1 AND status = 'held')::int AS held,
            GREATEST(0, (SELECT count(*) FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL
                          AND escalated_at IS NULL AND held_until IS NULL) - $2)::int AS more_items,
            (SELECT count(*) FROM jsonb_array_elements(COALESCE((SELECT plan->'items' FROM grants WHERE id = $1), '[]'::jsonb)) it
              WHERE it->'ledger'->>'status' = 'waiting')::int AS orders`,
    [grant.id, items.length]
  );
  const openWork = await rawQuery<{ id: string; kind: string; claim_id: string; text: string; importance: number | null; est: number }>(
    `SELECT DISTINCT ON (a.claim_id) a.id, a.kind, a.claim_id, left(c.text, 80) AS text, c.importance,
            a.cost_est_micro_usd AS est
       FROM actions a JOIN claims c ON c.id = a.claim_id
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND c.id IN (SELECT al.claim_id FROM action_allocations al WHERE al.grant_id = $1 AND al.claim_id IS NOT NULL
                     UNION SELECT cr.child_claim_id FROM claim_relationships cr
                            WHERE cr.parent_claim_id IN (SELECT al.claim_id FROM action_allocations al
                                                          WHERE al.grant_id = $1 AND al.claim_id IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM action_allocations x WHERE x.exclusion_group = a.exclusion_group
                         AND x.released_at IS NULL AND x.commissioned_by IS NOT NULL)
      ORDER BY a.claim_id, c.importance DESC NULLS LAST
      LIMIT 30`,
    [grant.id]
  ).then((rows) => rows.sort((x, y) => Number(y.importance ?? 0) - Number(x.importance ?? 0)).slice(0, 8));

  const petitionText: string[] = [];
  for (const [i, p] of petitions.entries()) {
    const label = `p${i + 1}`;
    labels.set(label, { petition: p });
    petitionText.push(await describePetition(p, label));
  }
  const itemText = items.map((it, i) => {
    const label = `i${i + 1}`;
    labels.set(label, { item: it });
    return describeItem(it, label);
  });
  const waiting = petitions.filter((p) => p.waiting).length;

  const head =
    `## Inbox for ${grant.title ?? "this mandate"}\n\n` +
    `${petitions.length + items.length} item(s)` +
    (waiting > 0 ? `; ${waiting} have a run waiting on your answer: decide those first` : "") +
    `. ${describeLimit(limit)}`;

  return [
    head,
    `## Position\n\n` +
      (pace ? `${pace.sentence} ` : "") +
      `Deciding has cost ${decidingShare}% of the mandate's spend over the last seven days. ` +
      (runBudgetSentence() || ""),
    `## What else the money could buy\n\n` +
      `Beyond this brief: ${elsewhere?.more_items ?? 0} more inbox item(s) waiting for the next sitting, ` +
      `${elsewhere?.held ?? 0} petition(s) held, ${elsewhere?.orders ?? 0} plan order(s) waiting for room. ` +
      (openWork.length
        ? `Open, unpaid work on nodes this mandate has paid for before or their premises, most important first ` +
          `(an estimate beside each): ` +
          openWork.map((w) => `${w.kind} on ${w.claim_id} ("${w.text}", importance ${w.importance ?? "?"}, about ${owls(w.est)} owls)`).join("; ") +
          `. Weigh each ask against these as well as on its own.`
        : `No open, unpaid work on the nodes this mandate has paid for before.`),
    `## The mandate\n\nTerms, as its funder approved them: ${grant.title ?? "(untitled)"}. ${grant.objective ?? ""}\n\n` +
      `Operating policy:\n\n${renderOperatingPolicy(policy)}`,
    `## Decisions (${decisions.length}: the last fourteen days', and every one on the nodes in front of you; newest first)\n\n` +
      (decisions.length
        ? decisions
            .map(
              (d) =>
                `- ${d.created_at.toString().slice(0, 10)} · ${d.decided_by} · ${d.item_kind} · ${d.decision}` +
                (d.target ? ` · ${d.target}` : "") +
                (d.owls_micro_usd ? ` · ${owls(d.owls_micro_usd)} owls` : "") +
                (d.reason ? ` · ${d.reason}` : "")
            )
            .join("\n")
        : "(none yet)"),
    ...(petitionText.length ? [`## Petitions\n\n${petitionText.join("\n\n")}`] : []),
    ...(itemText.length ? [`## Items\n\n${itemText.join("\n\n")}`] : []),
    role === "officer"
      ? "Act on every item: commission, decide, hold, decline, escalate, or log why you are leaving it. " +
        "Record petition decisions with decide_petitions first, because runs are waiting on them. A petition " +
        "with a run waiting that you neither decide nor hold goes to the Grantmaker when this sitting ends, so " +
        "the run is not left without an answer. " +
        `A sitting reads at most ${ITEMS_PER_SITTING} items; more wait for the next sitting, which follows this one.`
      : "Decide each on its merits and against what else today's money could do. Where an escalation " +
        "shows the operating policy is silent or wrong, fix the operating policy now with " +
        "write_operating_policy, so the officers settle the next one themselves.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Open (or reopen) a sitting's ledger row and commission it from the mandate.
 *
 * The sitting runs here, in the caller's context, as soon as the row is
 * claimed: no executor picks this row up later. So the row records the label
 * the sitting runs at (src/labels.ts), the caller's, and a row left open by
 * a sitting that could not be funded takes this one's.
 */
async function commissionSitting(grant: GrantRow, role: Role): Promise<string | null> {
  const config = loadConfig();
  void role;
  const group = OFFICER_GROUP(grant.id);
  const kind = "officer_run";
  const budget = owlsToMicroUsd(config.officerRunBudgetOwls);
  const [row] = await rawQuery<{ id: string; status: string }>(
    `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ($1, $2, 'standard', $3, $4, $5, $6)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET status = CASE WHEN actions.status = 'running' THEN actions.status ELSE 'open' END,
           sensitivity_label = CASE WHEN actions.status = 'running'
                                    THEN actions.sensitivity_label ELSE EXCLUDED.sensitivity_label END,
           updated_at = now()
     RETURNING id, status`,
    [kind, group, grant.id, "Program officer sitting", budget, currentLabel()]
  );
  if (!row || row.status === "running") return null;
  const placed = await placeCommission({
    group,
    actionId: row.id,
    claimId: null,
    payer: { kind: "grant", grantId: grant.id },
    budget,
    commissionedBy: "system",
    brief: null,
    reason: "Working the mandate's inbox",
  });
  if (!placed.ok) return null;
  if (!(await claimAction(row.id))) return null;
  return row.id;
}

async function runRole(grant: GrantRow, role: Role): Promise<{ ran: boolean }> {
  const config = loadConfig();
  const petitions = await petitionsFor(grant.id, role);
  const items = await itemsFor(grant.id, role);
  if (petitions.length + items.length === 0) return { ran: false };
  const actionId = await commissionSitting(grant, role);
  if (!actionId) return { ran: false };

  const policy = await getOperatingPolicy(grant.id);
  const limit = officerLimit(policy);
  const labels = new Map<string, { petition?: PetitionRow; item?: InboxItem }>();
  const decidedBy = "officer" as const;
  const model = config.programOfficerModel;
  const system = getProgramOfficerSystemPromptBlocks();
  const budget = owlsToMicroUsd(config.officerRunBudgetOwls);

  let billed = 0;
  try {
    const metered = await runWithUsageContext({ userId: grant.funder_user_id, jobId: grant.budget_job_id, claimId: null }, () =>
      withPassBudget({ microUsd: budget, source: "your mandate's money", funding: { actionId, grantId: grant.id } }, () =>
        withAgent("program_officer", async () => {
          const brief = await buildBrief(grant, role, petitions, items, labels);
          await withSkills([], () =>
            toolUseLoop({
              initialMessages: [{ role: "user", content: brief }],
              tools: getOfficerToolDefinitions(role),
              system,
              model,
              maxIterations: RUN_TURN_GUARD,
              executeTool: (name, input) =>
                executeOfficerTool(name, input, { grant, role, labels, limitMicroUsd: limit.microUsd, decidedBy }),
            })
          );
        })
      )
    );
    billed = metered.billedMicroUsd;
  } catch (err) {
    await releaseAction(actionId).catch(() => {});
    throw err;
  }
  await completeAction(actionId, billed, { meteredJobId: grant.budget_job_id });

  // A waiting run is owed an answer: what the officer left undecided goes to
  // the Grantmaker now, into its session (the officer's brief says so).
  if (role === "officer") {
    const left = await rawQuery<{ id: string; kind: string; requester_node_id: string | null }>(
      `UPDATE petitions SET status = 'escalated',
              reason = COALESCE(reason, 'The officer did not decide it; a run is waiting.')
        WHERE grant_id = $1 AND status = 'pending' AND waiting
        RETURNING id, kind, requester_node_id`,
      [grant.id]
    );
    const { recordEvent } = await import("../../services/event-service.js");
    for (const p of left) {
      await recordEvent({
        kind: "escalated",
        grantId: grant.id,
        nodeId: p.requester_node_id,
        refs: { petition: p.id },
        summary: `A ${p.kind} petition with a run waiting was left undecided by your officer, so it comes to you.`,
        payload: { waiting: true },
      });
    }
  }
  return { ran: true };
}

/**
 * One sitting on a mandate's inbox, by its program officer. What the officer
 * escalates reaches the Grantmaker in its own session, as an event it is
 * subscribed to (mandate-review.ts), not in a sitting of its own.
 */
export async function workMandateInbox(grantId: string): Promise<void> {
  const config = loadConfig();
  if (config.officerBatchMs > 0) await new Promise((r) => setTimeout(r, config.officerBatchMs));
  const grant = await loadGrant(grantId);
  if (!grant) return;
  const waiting = await inboxWaiting(grantId);
  if (waiting.officer > 0) await runRole(grant, "officer");
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolCtx {
  grant: GrantRow;
  role: Role;
  labels: Map<string, { petition?: PetitionRow; item?: InboxItem }>;
  limitMicroUsd: number;
  decidedBy: "officer" | "grantmaker";
}

async function logDecision(ctx: ToolCtx, input: { itemKind: string; decision: string; target?: string | null; owls?: number | null; reason?: string | null; actionId?: string | null }) {
  await rawQuery(
    `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, target, owls_micro_usd, reason, action_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.grant.id, ctx.decidedBy, input.itemKind, input.decision, input.target ?? null, input.owls ?? null, input.reason ?? null, input.actionId ?? null]
  );
}

async function markHandled(ctx: ToolCtx, item: InboxItem | undefined) {
  if (!item) return;
  await rawQuery(`UPDATE mandate_inbox SET handled_at = now(), handled_by = $2 WHERE id = $1`, [item.id, ctx.decidedBy]);
}

export async function executeOfficerTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const graph = await executeGraphReadTool(name, input);
  if (graph !== null) return graph;
  const sqlOut = await executeSqlTool(name, input);
  if (sqlOut !== null) return sqlOut;
  if (name === "cost_sheet") return executeSkillTool(name, input, { role: "program-officer" });

  if (name === "decide_petitions") {
    const results: Array<{ petition: string; ok: boolean; message: string }> = [];
    for (const d of Array.isArray(input.decisions) ? (input.decisions as Array<Record<string, unknown>>) : []) {
      const label = String(d.petition ?? "");
      const p = ctx.labels.get(label)?.petition;
      if (!p) {
        results.push({ petition: label, ok: false, message: "Not a petition in your brief." });
        continue;
      }
      const decision = String(d.decision ?? "") as DecisionKind;
      if (!["grant", "refuse", "follow_up"].includes(decision)) {
        results.push({ petition: label, ok: false, message: "decision must be grant, refuse or follow_up." });
        continue;
      }
      const amount = d.owls != null ? owlsToMicroUsd(Number(d.owls)) : undefined;
      const effective = decision === "refuse" ? 0 : amount ?? Number(p.asked_micro_usd);
      if (ctx.role === "officer" && effective > ctx.limitMicroUsd) {
        results.push({
          petition: label,
          ok: false,
          message: `That is more than your limit of ${owls(ctx.limitMicroUsd)} owls in one decision. Escalate it.`,
        });
        continue;
      }
      const r = await decidePetition({
        petitionId: p.id,
        decision,
        owlsMicroUsd: amount,
        reason: String(d.reason ?? ""),
        decidedBy: ctx.decidedBy,
      });
      results.push({ petition: label, ok: r.ok, message: r.message });
    }
    return JSON.stringify({ success: results.some((r) => r.ok), results });
  }

  if (name === "commission") {
    const results: Array<{ target: string; ok: boolean; message: string }> = [];
    for (const e of Array.isArray(input.entries) ? (input.entries as Array<Record<string, unknown>>) : []) {
      const target = String(e.target ?? "").trim();
      const budget = owlsToMicroUsd(Number(e.budget_owls ?? 0));
      if (ctx.role === "officer" && budget > ctx.limitMicroUsd) {
        results.push({ target, ok: false, message: `More than your limit of ${owls(ctx.limitMicroUsd)} owls in one decision. Escalate it.` });
        continue;
      }
      if (e.kind === "research") {
        // Research is the Grantmaker's: its report returns into its
        // session, which an officer's sitting does not have.
        if (ctx.role !== "grantmaker") {
          results.push({ target: "research", ok: false, message: "Research is commissioned by the Grantmaker; escalate the item if it needs research." });
          continue;
        }
        const brief = String(e.brief ?? "").trim();
        if (brief.length < 80) {
          results.push({ target: "research", ok: false, message: "A research brief is the Researcher's whole task: the question, the context, what a good answer looks like, where to start (at least 80 characters)." });
          continue;
        }
        const { commissionResearch } = await import("../../services/research-commission-service.js");
        const tierRaw = String(e.research_tier ?? "standard");
        const r = await commissionResearch({
          payer: { kind: "grant", grantId: ctx.grant.id },
          nodeId: null,
          task: brief,
          budgetMicroUsd: budget,
          tier: tierRaw === "strong" || tierRaw === "cheap" ? tierRaw : "standard",
          requestedBy: "grantmaker",
          wait: true,
          grantId: ctx.grant.id,
          contributionBudgetMicroUsd: owlsToMicroUsd(Number(e.contribution_budget_owls ?? 0)),
        });
        if (r.ok) {
          await logDecision(ctx, { itemKind: "commission", decision: "commissioned research", target: r.runId, owls: budget, reason: String(e.reason ?? ""), actionId: r.actionId });
          results.push({
            target: `research ${r.runId}`,
            ok: true,
            message: r.waits
              ? `Commissioned research run ${r.runId} at ${owls(budget)} owls. It runs on its own; its report arrives in your session (in a tool result, or waking you if you have paused).`
              : `Commissioned research run ${r.runId} at ${owls(budget)} owls; this run has no session to receive the report, so read it later with get_research_run.`,
          });
        } else {
          results.push({ target: "research", ok: false, message: r.message });
        }
        continue;
      }
      const actionId = typeof e.action_id === "string" && e.action_id.trim() ? e.action_id.trim() : null;
      if (actionId) {
        const r = await commissionAction({
          payer: { kind: "grant", grantId: ctx.grant.id },
          actionId,
          budgetMicroUsd: budget,
          brief: String(e.brief ?? ""),
          reason: String(e.reason ?? ""),
          commissionedBy: ctx.decidedBy === "officer" ? "program_officer" : "grantmaker",
          // A Steward pass named by its row reaches the node as one named by target does.
          message: { trigger: "mandate_plan", sender: { kind: "mandate" } },
        });
        const item = e.item ? ctx.labels.get(String(e.item))?.item : undefined;
        if (r.ok) {
          await markHandled(ctx, item);
          await logDecision(ctx, {
            itemKind: "commission",
            decision: r.status === "commissioned" ? "commissioned" : "already paid for",
            target: actionId,
            owls: r.status === "commissioned" ? budget : null,
            reason: String(e.reason ?? ""),
            actionId,
          });
          results.push({
            target: actionId,
            ok: true,
            message:
              r.status === "commissioned"
                ? `Commissioned the ${r.kind} at ${owls(budget)} owls.` + (r.quote ? ` ${r.quote.note}` : "")
                : "That work already has a run paid for or underway; nothing more was spent.",
          });
        } else {
          results.push({ target: actionId, ok: false, message: r.message });
        }
        continue;
      }
      const res = await commissionNodePass({
        payer: { kind: "grant", grantId: ctx.grant.id },
        claimId: target,
        budgetMicroUsd: budget,
        tier: e.tier === "strong" ? "strong" : "standard",
        brief: String(e.brief ?? ""),
        reason: String(e.reason ?? ""),
        commissionedBy: ctx.decidedBy === "officer" ? "program_officer" : "grantmaker",
        message: { trigger: "mandate_plan", sender: { kind: "mandate" } },
      }).catch((err) => ({ ok: false as const, code: "NOT_FOUND" as const, message: err instanceof Error ? err.message : String(err) }));
      const item = e.item ? ctx.labels.get(String(e.item))?.item : undefined;
      if (res.ok) {
        await markHandled(ctx, item);
        await logDecision(ctx, {
          itemKind: "commission",
          decision: res.status === "commissioned" ? "commissioned" : "joined a paid pass",
          target,
          owls: res.status === "commissioned" ? budget : null,
          reason: String(e.reason ?? ""),
          actionId: res.actionId,
        });
        results.push({
          target,
          ok: true,
          message:
            (res.status === "commissioned"
              ? `Commissioned a ${res.tier} pass at ${owls(budget)} owls.`
              : "That node already had a pass paid for; your brief joined its inbox, at no cost.") +
            (res.parked ? ` ${res.parked.note}` : ""),
        });
      } else {
        results.push({ target, ok: false, message: res.message });
      }
    }
    return JSON.stringify({ success: results.some((r) => r.ok), results });
  }

  if (name === "decline") {
    const item = ctx.labels.get(String(input.item ?? ""))?.item;
    if (!item) return JSON.stringify({ success: false, message: "Not an item in your brief." });
    await markHandled(ctx, item);
    await logDecision(ctx, { itemKind: "decline", decision: "declined", target: item.target_node_id ?? item.target_ref, reason: String(input.reason ?? "") });
    return JSON.stringify({ success: true, message: "Declined and recorded." });
  }

  if (name === "hold") {
    const entry = ctx.labels.get(String(input.item ?? ""));
    if (!entry) return JSON.stringify({ success: false, message: "Not a petition or item in your brief." });
    const until =
      input.until !== undefined
        ? new Date(String(input.until))
        : new Date(Date.now() + Number(input.in_hours ?? 0) * 3_600_000);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      return JSON.stringify({ success: false, message: "Give a time in the future to hold it to: in_hours above zero, or until." });
    }
    const refs = Array.isArray(input.until_runs) ? (input.until_runs as unknown[]).map(String) : [];
    const criteria = String(input.criteria ?? "");
    if (entry.petition) {
      const r = await holdPetition({ petitionId: entry.petition.id, until, refs, criteria, decidedBy: ctx.decidedBy });
      return JSON.stringify({ success: r.ok, message: r.message });
    }
    if (!criteria.trim()) return JSON.stringify({ success: false, message: "criteria is required." });
    await rawQuery(
      `UPDATE mandate_inbox SET held_until = $2, hold_refs = $3::jsonb, hold_reason = $4 WHERE id = $1`,
      [entry.item!.id, until.toISOString(), JSON.stringify(refs), criteria.trim()]
    );
    await logDecision(ctx, { itemKind: "hold", decision: "held", target: entry.item!.target_node_id ?? entry.item!.target_ref, reason: criteria });
    return JSON.stringify({ success: true, message: `Held until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC${refs.length ? " or until the named runs settle" : ""}.` });
  }

  if (name === "escalate" && ctx.role === "officer") {
    const entry = ctx.labels.get(String(input.item ?? ""));
    const note = String(input.note ?? "").trim();
    if (!entry) return JSON.stringify({ success: false, message: "Not a petition or item in your brief." });
    if (!note) return JSON.stringify({ success: false, message: "note is required." });
    if (entry.petition) {
      await rawQuery(`UPDATE petitions SET status = 'escalated', reason = $2 WHERE id = $1 AND status = 'pending'`, [entry.petition.id, note]);
    } else if (entry.item) {
      await rawQuery(`UPDATE mandate_inbox SET escalated_at = now(), escalation_note = $2 WHERE id = $1`, [entry.item.id, note]);
    }
    await logDecision(ctx, { itemKind: "escalation", decision: "escalated", target: entry.petition?.requester_node_id ?? entry.item?.target_node_id ?? null, reason: note });
    const { recordEvent } = await import("../../services/event-service.js");
    await recordEvent({
      kind: "escalated",
      grantId: ctx.grant.id,
      nodeId: entry.petition?.requester_node_id ?? entry.item?.target_node_id ?? null,
      refs: { petition: entry.petition?.id ?? null, item: entry.item?.id ?? null },
      summary: `Your officer sent you ${entry.petition ? `a ${entry.petition.kind} petition${entry.petition.waiting ? " with a run waiting" : ""}` : "an inbox item"}: ${note}`,
      payload: { waiting: Boolean(entry.petition?.waiting) },
    });
    return JSON.stringify({ success: true, message: "Sent to the Grantmaker." });
  }

  if (name === "log_note") {
    const note = String(input.note ?? "").trim();
    if (!note) return JSON.stringify({ success: false, message: "note is required." });
    await logDecision(ctx, { itemKind: "note", decision: "noted", reason: note });
    return JSON.stringify({ success: true, message: "Logged; the Grantmaker reads it." });
  }

  if (name === "write_operating_policy" && ctx.role === "grantmaker") {
    const res = await writeOperatingPolicy({
      grantId: ctx.grant.id,
      section: (input.section as PolicySection | undefined) ?? null,
      content: String(input.content ?? ""),
      note: String(input.note ?? ""),
      author: "grantmaker",
      officerLimitOwls: input.officer_limit_owls != null ? Number(input.officer_limit_owls) : null,
      reviewPassOwls: input.review_pass_owls != null ? Number(input.review_pass_owls) : null,
    });
    if (!res.ok) return JSON.stringify({ success: false, message: res.message });
    const figuresOnly = !String(input.content ?? "").trim();
    await logDecision(ctx, {
      itemKind: "policy",
      decision: figuresOnly ? "set the policy's figures" : input.section ? `rewrote ${String(input.section)}` : "rewrote the policy",
      reason: String(input.note ?? ""),
    });
    return JSON.stringify({
      success: true,
      message:
        "The operating policy is updated; the officers read it from their next sitting." +
        (input.review_pass_owls != null ? await reviewPassSetNote(ctx.grant.id, Number(input.review_pass_owls)) : ""),
    });
  }

  return JSON.stringify({ success: false, message: `Unknown tool: ${name}` });
}

/**
 * What the Grantmaker is told on setting its review-pass budget: when it
 * applies, and, with figures, when the pace or the escrow cannot fund
 * a pass that size, so the shortfall is known when the figure is chosen.
 */
async function reviewPassSetNote(grantId: string, owls: number): Promise<string> {
  const [g] = await rawQuery<{ pace: unknown; escrow: string; budget_job_id: string }>(
    `SELECT g.pace, j.budget_micro_usd AS escrow, g.budget_job_id
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
    [grantId]
  ).catch(() => []);
  let note = ` Review passes opened from now on work to ${owls} owls; a pass already running keeps the budget it has.`;
  if (!g) return note;
  const micro = owlsToMicroUsd(owls);
  const floor = loadConfig().reviewPassFloorOwls ?? 1;
  const pace = parsePace(g.pace);
  const window = pace.kind === "steady" ? owlsToMicroUsd(pace.owls) : 0;
  const short = (bound: string) =>
    ` That is more than ${bound}, so a pass will start with what can be found, when that is at least ${floor} owls, ` +
    `and its briefing will say so.`;
  if (window > 0 && micro > window) note += short(`the mandate's whole pace window (${microUsdToOwls(window)} owls)`);
  else {
    const committed = await grantCommittedMicroUsd({ id: grantId, budgetJobId: g.budget_job_id }).catch(() => null);
    const free = committed == null ? null : Math.max(0, Number(g.escrow) - committed);
    if (free != null && micro > free) note += short(`the escrow holds uncommitted (${microUsdToOwls(free)} owls)`);
  }
  return note;
}

/**
 * Hold a sitting for every mandate with something in its inbox that no run
 * is waiting on (what lookouts raised, outcomes, funder notes): the
 * scheduler's sweep. A petition with a run waiting never waits for this; its
 * petitioner holds the sitting itself.
 */
export async function workWaitingInboxes(limit = 20): Promise<number> {
  const { takeInboxLease, releaseInboxLease } = await import("../../services/petition-service.js");
  const grants = await rawQuery<{ id: string }>(
    `SELECT DISTINCT g.id FROM grants g
      WHERE g.status = 'active'
        AND (g.officer_lease_until IS NULL OR g.officer_lease_until < now())
        AND (EXISTS (SELECT 1 FROM mandate_inbox i WHERE i.grant_id = g.id AND i.handled_at IS NULL)
             OR EXISTS (SELECT 1 FROM petitions p WHERE p.grant_id = g.id AND p.status IN ('pending', 'escalated')))
      LIMIT $1`,
    [limit]
  );
  let n = 0;
  for (const g of grants) {
    if (!(await takeInboxLease(g.id))) continue;
    try {
      await workMandateInbox(g.id);
      n++;
    } catch (err) {
      console.error(`[officer] sitting for ${g.id} failed:`, err instanceof Error ? err.message : err);
    } finally {
      await releaseInboxLease(g.id);
    }
  }
  return n;
}

export const AMEND_OBJECTIVE: Tool = {
  name: "amend_objective",
  description:
    "Change the mandate's title or objective: what its funder approved by funding it. Use it only in " +
    "conversation with the funder, when they ask for the change or agree to one you proposed, and only " +
    "once they have seen the new text. Apply the same duties you had when the mandate was drafted: " +
    "decline a change that tries to steer the graph's conclusions, exactly as you would decline such a " +
    "mandate. The change takes effect at once. Every other funder (users who contributed, and mandates " +
    "that regranted to this one) is told immediately, with the old and new text and your note, and may " +
    "withdraw their unspent share. Afterwards, revise the operating policy so it serves the new " +
    "objective. A platform mandate's terms are re-approved the way it was funded: this records the " +
    "amended draft for that approval instead of applying it. Outside your funder's chat, propose a change to your " +
    "funder with note_to_funder.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Optional: the new title. Leave it out to keep the current one." },
      objective: { type: "string", description: "Optional: the new objective, in full. Leave it out to keep the current one." },
      note: { type: "string", description: "Why the mission is changing, in words the other funders and the public will read." },
    },
    required: ["note"],
  },
};

export const WITHDRAW_REGRANT: Tool = {
  name: "withdraw_regrant",
  description:
    "Take back your mandate's unspent share of a mandate you regranted to, into your escrow. Use it when " +
    "that mandate's objective has changed and no longer serves your mission, or when you judge the money " +
    "would do more here. Money already spent or committed to running work stays where it is. The " +
    "withdrawal and your reason are shown on both mandates' pages.",
  input_schema: {
    type: "object" as const,
    properties: {
      grant_id: { type: "string", description: "The mandate you regranted to." },
      owls: { type: "number", description: "Optional: how much to take back, up to your unspent share. Leave it out to take it all." },
      reason: { type: "string", description: "Why, for both mandates' public records." },
    },
    required: ["grant_id", "reason"],
  },
};

export const SET_RESERVE: Tool = {
  name: "set_reserve",
  description:
    "Hold part of your mandate's uncommitted money in reserve: owls your program officers, lookouts, plan " +
    "orders and the mandate's routine runs cannot commit, and only you can. Use it to spend freely on the " +
    "first wave of work while keeping money back for the directions that turn out to be worth pursuing once " +
    "results come in, and lower it (to 0 to release it all) when you have decided where it goes. It says who " +
    "may commit the money, never when: you may commission from it at any time. The reserve and your reason " +
    "are stated to your officers and lookouts in every brief, and shown on the mandate's page. It can be at " +
    "most what the escrow holds uncommitted.",
  input_schema: {
    type: "object" as const,
    properties: {
      owls: { type: "number", description: "The reserve, in owls: 0 releases it." },
      reason: { type: "string", description: "What it is held for, in words your officers and the public read." },
    },
    required: ["owls", "reason"],
  },
};

export const AMEND_PACE: Tool = {
  name: "amend_pace",
  description:
    "Change how fast the mandate's money may be committed, its pace, which its funder agreed when funding it. " +
    "Use it only in conversation with the funder, when they ask for the change or agree to one you proposed. " +
    "as_needed: the escrow is the only bound, for a mandate whose work should run as it arrives (explore a " +
    "question, ingest a source, map a literature). steady: at most owls committed in any rolling period_hours " +
    "(24 for a day's worth, 168 for a week's), for upkeep that should spread its money evenly. The change takes " +
    "effect at once and is recorded on the mandate's public record with your note. Outside your funder's chat, propose " +
    "a change to your funder with note_to_funder.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["as_needed", "steady"] },
      owls: { type: "number", description: "steady: owls committed per period at most." },
      period_hours: { type: "number", description: "steady: the rolling window, in hours (24 a day, 168 a week)." },
      note: { type: "string", description: "Why, in words the public record reads." },
    },
    required: ["kind", "note"],
  },
};

/**
 * What the officers have sent the Grantmaker and it has not decided:
 * escalated petitions and inbox items, each described as the officers saw
 * it, labelled by its id so the Grantmaker's decide_petitions, decline and
 * commission name it that way.
 */
export async function escalationDigest(grantId: string): Promise<{ text: string | null; labels: Map<string, { petition?: PetitionRow; item?: InboxItem }>; waiting: number }> {
  const petitions = await petitionsFor(grantId, "grantmaker");
  const items = await itemsFor(grantId, "grantmaker");
  const labels = new Map<string, { petition?: PetitionRow; item?: InboxItem }>();
  const parts: string[] = [];
  for (const p of petitions) {
    labels.set(p.id, { petition: p });
    parts.push(await describePetition(p, p.id));
  }
  for (const i of items) {
    labels.set(i.id, { item: i });
    parts.push(describeItem(i, i.id));
  }
  const waiting = petitions.filter((p) => p.waiting).length;
  return {
    text: parts.length
      ? `## Escalated to you (${parts.length}${waiting ? `; ${waiting} with a run waiting on the answer, so decide those first` : ""})\n\n` +
        `Your officers sent you these. Decide petitions with decide_petitions, and items with commission or ` +
        `decline, naming each by its id. Where one shows the operating policy is silent or wrong, fix the policy ` +
        `too, so the officers settle the next one themselves.\n\n${parts.join("\n\n")}`
      : null,
    labels,
    waiting,
  };
}

/** The Grantmaker's spending tools, in review passes and the management chat. */
export function getMandateOperationsToolDefinitions(opts: { chat: boolean }): Tool[] {
  return [
    WRITE_OPERATING_POLICY,
    COMMISSION_FOR_MANDATE,
    DECIDE_PETITIONS,
    HOLD,
    DECLINE,
    SET_RESERVE,
    getSqlToolDefinition(),
    WITHDRAW_REGRANT,
    ...(opts.chat ? [AMEND_OBJECTIVE, AMEND_PACE] : []),
  ];
}

/**
 * Run one of the Grantmaker's operations tools for a mandate, or null when
 * `name` is not one. In a review pass amend_objective is refused: the terms
 * change only with the funder present.
 */
export async function executeMandateOperationsTool(
  grantId: string,
  name: string,
  input: Record<string, unknown>,
  opts: { chat: boolean }
): Promise<string | null> {
  if (name === "query_sql") return executeSqlTool(name, input);
  if (name === "set_reserve") {
    const reason = String(input.reason ?? "").trim();
    const want = Number(input.owls);
    if (!Number.isFinite(want) || want < 0) return JSON.stringify({ success: false, message: "owls must be 0 or more." });
    if (!reason) return JSON.stringify({ success: false, message: "reason is required: your officers and the public read it." });
    const room = await paceRoom(grantId, "grantmaker");
    if (!room) return JSON.stringify({ success: false, message: "No such mandate." });
    const uncommitted = Math.max(0, room.escrowMicroUsd - room.committedMicroUsd);
    const micro = owlsToMicroUsd(want);
    if (micro > uncommitted) {
      return JSON.stringify({
        success: false,
        message: `A reserve of ${want} owls is more than the escrow holds uncommitted (${microUsdToOwls(uncommitted)} owls).`,
      });
    }
    await rawQuery(
      `UPDATE grants SET reserve_micro_usd = $2, reserve_reason = $3, updated_at = now() WHERE id = $1`,
      [grantId, micro, micro > 0 ? reason : null]
    );
    await rawQuery(
      `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, owls_micro_usd, reason)
       VALUES ($1, 'grantmaker', 'reserve', $2, $3, $4)`,
      [grantId, micro > 0 ? "held in reserve" : "released the reserve", micro, reason]
    );
    const after = await paceRoom(grantId, "delegated");
    const { recordEvent } = await import("../../services/event-service.js");
    await recordEvent({
      kind: "mandate_changed",
      grantId,
      refs: { part: "reserve" },
      summary: micro > 0 ? `The Grantmaker holds ${want} owls in reserve: ${reason}` : `The Grantmaker released its reserve: ${reason}`,
    });
    return JSON.stringify({ success: true, message: after?.sentence ?? `Reserve set to ${want} owls.` });
  }
  if (name === "amend_pace") {
    if (!opts.chat) {
      return JSON.stringify({
        success: false,
        message: "Only in your funder's chat: the pace is the funder's. Propose a change with note_to_funder, and amend it in their chat once they agree.",
      });
    }
    const note = String(input.note ?? "").trim();
    if (!note) return JSON.stringify({ success: false, message: "note is required: the public record reads it." });
    const v = validatePace({ kind: input.kind, owls: input.owls, period_hours: input.period_hours, reason: note });
    if (!v.ok) return JSON.stringify({ success: false, message: v.problem });
    await rawQuery(`UPDATE grants SET pace = $2::jsonb, updated_at = now() WHERE id = $1`, [grantId, JSON.stringify(v.pace)]);
    await rawQuery(
      `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, reason)
       VALUES ($1, 'grantmaker', 'pace', $2, $3)`,
      [grantId, describePace(v.pace), note]
    );
    const after = await paceRoom(grantId, "grantmaker");
    const { recordEvent } = await import("../../services/event-service.js");
    await recordEvent({ kind: "mandate_changed", grantId, refs: { part: "pace" }, summary: `The pace is now ${describePace(v.pace)}: ${note}` });
    return JSON.stringify({ success: true, message: after?.sentence ?? describePace(v.pace) });
  }
  if (name === "amend_objective") {
    if (!opts.chat) {
      return JSON.stringify({
        success: false,
        message: "Only in your funder's chat: propose the change to your funder with note_to_funder, and amend it in their chat once they agree.",
      });
    }
    const { amendObjective } = await import("../../services/mandate-terms-service.js");
    const r = await amendObjective({
      grantId,
      title: typeof input.title === "string" ? input.title : null,
      objective: typeof input.objective === "string" ? input.objective : null,
      note: String(input.note ?? ""),
      author: "grantmaker:chat",
    });
    if (!r.ok) return JSON.stringify({ success: false, message: r.message });
    return JSON.stringify({
      success: true,
      message:
        r.status === "awaiting_approval"
          ? "Recorded the amended draft for approval. The terms in force are unchanged until the approval lands."
          : `The mandate's terms are amended; the earlier version is kept on its page. ${r.notified} other funder(s) were told and may withdraw their unspent share. Revise the operating policy next, so it serves the new objective.`,
    });
  }
  if (name === "withdraw_regrant") {
    const { withdrawFromMandate } = await import("../../services/mandate-terms-service.js");
    const target = String(input.grant_id ?? "").trim();
    const r = await withdrawFromMandate({
      grantId: target,
      funder: { grantId },
      owls: input.owls != null ? Number(input.owls) : null,
    });
    if (!r.ok) return JSON.stringify({ success: false, message: r.message });
    await rawQuery(
      `INSERT INTO mandate_decisions (grant_id, decided_by, item_kind, decision, target, owls_micro_usd, reason)
       VALUES ($1, 'grantmaker', 'withdrawal', 'withdrew a regrant', $2, $3, $4)`,
      [grantId, target, owlsToMicroUsd(r.withdrawnOwls), String(input.reason ?? "")]
    );
    return JSON.stringify({ success: true, message: `Withdrew ${r.withdrawnOwls} owls into your escrow.` });
  }
  if (!["write_operating_policy", "commission", "decide_petitions", "decline", "hold"].includes(name)) return null;
  const grant = await loadGrant(grantId);
  if (!grant) return JSON.stringify({ success: false, message: "No such mandate." });
  // What the officers escalated, by id, for decide_petitions, decline and a
  // commission that answers an item.
  const { labels } = await escalationDigest(grantId);
  return executeOfficerTool(name, input, {
    grant,
    role: "grantmaker",
    labels,
    limitMicroUsd: Number.MAX_SAFE_INTEGER,
    decidedBy: "grantmaker",
  });
}
