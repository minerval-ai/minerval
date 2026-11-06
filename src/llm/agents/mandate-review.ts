/**
 * The mandate review pass — a Grantmaker stewarding its live mandate,
 * autonomously and with discretion.
 *
 * A mandate's scope is defined in WORDS; which work falls under it is a
 * judgment call. On a cadence, the ledger opens a `mandate_review` action
 * for every active mandate (self-funded from its escrow, metered under a
 * cap), and the engine executor runs this agent: the same Grantmaker that
 * designed the mandate, now reviewing it the way any person entrusted with
 * a budget and a mission would —
 *
 *  - survey its territory: the graph (search, scope survey) AND the open
 *    web (web_search) — finding the right sources is the agent's job, not
 *    a human's;
 *  - value the open ledger: write the mandate's own valuations, with
 *    rationale, over exactly the actions it judges relevant (its
 *    allocator spends against these);
 *  - grow its own plan: append ingest/assess items it has discovered
 *    (each priced, escrow-bounded, executed through the same ledger);
 *  - move money: regrant to a peer mandate, or spawn a new one with its
 *    own Grantmaker, when part of the mission belongs in other hands.
 *
 * Cost discipline lives in the mechanism, never in narrowed affordances:
 * the pass itself is capped and metered, everything it queues is priced
 * against the escrow, and daily rates pace the spend. The refusal duties
 * that govern mandate design govern this pass equally.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { getGrantmakerSystemPromptBlocks } from "../prompts/grantmaker.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { listSkills } from "../prompts/skills.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { createMandateTools } from "../tools/mandate-tools.js";
import { createGrantContributionTools } from "../tools/grant-contribution-tools.js";
import { annotateOpenActions } from "../../services/open-actions-service.js";
import {
  validateMandate,
  executeManagementTool,
  type GrantMandate,
  getBountyToolDefinitions,
  getManagementReadToolDefinitions,
  getValuationToolDefinitions,
  getAllocationPolicyToolDefinition,
  writtenCount,
} from "./grantmaker.js";
import {
  PLAN_ITEM_SCHEMA,
  PLAN_KIND_RULES,
  normalizePlanItems,
  type PlanItem,
} from "../../services/grant-service.js";
import { createResearchTools } from "../tools/research-tools.js";
import { executeKindTool, getRequestToolDefinitions } from "../tools/kind-tools.js";
import {
  getMandateAllocationPolicy,
  isFormulaPolicy,
} from "../../services/allocation-policy-service.js";
import { countPlanItems, describePlanCounts } from "../../services/plan-state.js";
import { grantmakerShareLeftMicroUsd, materializePlanItems } from "../../services/action-service.js";
import { grantmakerShareNote } from "../../services/claim-mandate-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import {
  createRegrant,
  spawnFundedMandate,
  grantCommittedMicroUsd,
} from "../../services/regrant-service.js";
import { refundUnspentBudget } from "../../services/budget-job-service.js";
import { runMandateAllocator } from "../../services/allocation-service.js";
import {
  WAKE_AFTER_MINUTES,
  consumeMandateEvents,
  describeMandateEvent,
  pendingMandateEvents,
} from "../../services/mandate-event-service.js";
import {
  mandateClosureBlockers,
  closureBlockedMessage,
} from "../../services/bounty-service.js";
import { getLookoutManagementToolDefinitions } from "../tools/lookout-management-tools.js";
import { getCorrespondentManagementToolDefinitions } from "../tools/correspondent-management-tools.js";
import { listCorrespondents } from "../../services/correspondent-service.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import {
  listMandateLookoutFlags,
  summarizeLookouts,
} from "../../services/lookout-service.js";

const LIST_REQUESTS_TOOL = getRequestToolDefinitions("grantmaker").find((t) => t.name === "list_requests")!;

/**
 * The most notes to the funder a mandate keeps (#701): the newest, so a
 * mandate that writes one every pass does not grow its record without end.
 * The funder reads them in the management chat and on grant_overview.
 */
const FUNDER_NOTES_KEPT = 20;

/** The closing note's length on the public page; stated to the agent. */
const REVIEW_NOTE_MAX_CHARS = 2000;

/**
 * How long a recorded closure stays confirmable by a later pass: a request
 * older than this is stale (the mission may have moved) and starts over.
 * Stated in complete_mandate's description.
 */
const CLOSE_CONFIRM_WINDOW_DAYS = 7;

/** One valued action the closing allocation could not fund, as recorded. */
interface SkippedRow {
  group: string;
  action_id: string | null;
  needed_owls: number;
  reason: "day_room" | "daily_rate" | "maintenance_share";
}

export interface MandateReviewResult {
  note: string;
  valuationsWritten: number;
  planItemsAdded: number;
  /** The agent judged one pass wasn't enough: run another now (funded out
   * of the mandate's day like the rest of its work). */
  continueRequested: boolean;
  /** Placements the mandate's allocator made when the pass ended. */
  allocated: number;
}

export function runMandateReview(
  input: Parameters<typeof runMandateReviewImpl>[0]
): ReturnType<typeof runMandateReviewImpl> {
  return withAgent("mandate_review", () => runMandateReviewImpl(input));
}

async function runMandateReviewImpl(input: {
  grantId: string;
  model?: string;
}): Promise<MandateReviewResult> {
  const config = loadConfig();
  // Anchors the two-pass closure rule: a close request is only
  // confirmable by a pass that STARTED after it was recorded.
  const passStartedAt = new Date();
  const [grant] = await rawQuery<{
    id: string;
    name: string;
    policy: string;
    mandate: GrantMandate | null;
    plan: { strategy?: string; items?: PlanItem[] } | null;
    plan_cursor: number;
    daily_budget_micro_usd: number;
    budget_job_id: string;
    budget_micro_usd: number;
    workspace: string | null;
    funder_user_id: string;
    skills: string[] | null;
  }>(
    `SELECT g.id, g.name, g.policy, g.mandate, g.plan, g.plan_cursor,
            g.daily_budget_micro_usd, g.budget_job_id, j.budget_micro_usd,
            g.workspace, g.funder_user_id, g.skills
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [input.grantId]
  );
  if (!grant) throw new Error(`mandate ${input.grantId} not found or not active`);

  // Skills load on demand; the mandate's grants.skills points to the ones
  // its work needs (docs/mathematics.md §3.4).
  const skillLoader = createSkillLoadTools("grantmaker", { names: grant.skills ?? [] });
  const system = getGrantmakerSystemPromptBlocks();

  const committed = await grantCommittedMicroUsd({
    id: grant.id,
    budgetJobId: grant.budget_job_id,
  });
  // Today's draw on the daily rate, so a decision to chain another pass is
  // made knowing what the day has left for everything else.
  const [todayRow] = await rawQuery<{ allocated: string | number; passes: number }>(
    `SELECT COALESCE(SUM(al.amount_micro_usd), 0)::bigint AS allocated,
            COUNT(*) FILTER (WHERE a.kind = 'mandate_review')::int AS passes
       FROM action_allocations al
       LEFT JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1
        AND al.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [grant.id]
  ).catch(() => []);
  const today = {
    allocatedMicroUsd: Number(todayRow?.allocated ?? 0),
    reviewPasses: Number(todayRow?.passes ?? 0),
  };

  // Web search on every provider: the server runs it on an Anthropic model,
  // the loop executes it elsewhere (tools/web-search-tool.ts).
  const model = input.model ?? config.grantmakerModel;
  const webSearch = createWebSearch(model);
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model, mandate: true });
  const mandateTools = createMandateTools({ grantId: grant.id, surveyLimit: 25 });
  // Contributions through the Reviewer, paid from the escrow (§19).
  const contributionTools = createGrantContributionTools(grant.id);
  // The delegation channel (#298, #683): the same instrument and the same
  // request funding the management chat carries. The pass is where a
  // mandate is stewarded, so it holds the affordances its prompt describes
  // (§19); delegate_research and fund_request refuse past the uncommitted
  // budget, and the move caps below are for money leaving the mandate.
  const researchTools = createResearchTools({ requestedBy: "grantmaker", grantId: grant.id });
  // A mandate gets the valuation lever its policy actually reads (#687).
  // For a formula mandate (General, Governance) a hand-written valuation
  // would fight the bulk refresh that upserts the same rows, so its lever
  // is the formula itself; a judgment mandate values the ledger, and its
  // policy lever holds only the keys its own allocator reads.
  const isFormulaMandate = isFormulaPolicy(grant.policy);
  const policyInForce = await getMandateAllocationPolicy(grant.id).catch(() => null);
  const tools: Tool[] = [
    ...reportTools.definitions, ...findingTools.definitions,
    // Shared graph reads: semantic search plus the three structural reads
    // (get_claim, get_decomposition, get_dependents). Valuing the ledger is a
    // judgment call about what falls under this mandate's words, and that is
    // not answerable from keyword hits and scalars — it needs the claim's
    // reasoning, what it rests on, and what rests on it.
    ...getGraphReadToolDefinitions(),
    // The mandate toolbox (#333): survey_scope, read_page,
    // update_workspace — one implementation shared with the planning pass
    // and the granting conversation.
    ...mandateTools.definitions,
    ...contributionTools.definitions,
    ...(isFormulaMandate ? [] : getValuationToolDefinitions()),
    // Research and requests (#683): launch the researcher, read its runs,
    // read the open requests, and fund one directly.
    ...researchTools.definitions,
    ...(researchTools.definitions.length > 0 ? [LIST_REQUESTS_TOOL] : []),
    // What the money bought and where it is going (#683):
    // list_funded_assessments, claims_from_source, allocation_report.
    ...getManagementReadToolDefinitions(),
    {
      name: "grant_overview",
      description:
        "Your mandate's own state as the public dashboard shows it: status, " +
        "the plan and how far it has executed, escrow and what is committed " +
        "against it, spend so far. The briefing gives you the headline " +
        "numbers; read this when you need the itemised picture before " +
        "spending or repacing.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    getAllocationPolicyToolDefinition(grant.policy, policyInForce),
    {
      name: "extend_plan",
      description:
        "Append new items to your mandate's plan: sources you found that should be ingested, claims that " +
        "need passes. Each item is priced and bounded by your escrow, and " +
        "executes through the ledger like everything else. Appends only; " +
        "already-planned work stays. The items are materialized onto the " +
        "ledger in this same call and the result reports each one's " +
        "standing (open, running, done, cancelled, waiting, blocked) with " +
        "the reason, so read it: a blocked item will not become work until " +
        "you change something. " +
        PLAN_KIND_RULES,
      input_schema: {
        type: "object" as const,
        properties: {
          items: { type: "array", items: PLAN_ITEM_SCHEMA },
          note: { type: "string", description: "One sentence: why." },
        },
        required: ["items", "note"],
      },
    },
    {
      name: "regrant",
      description:
        "Put part of this mandate's uncommitted budget behind another live " +
        "mandate. Use when " +
        "part of the mission is better served by work someone else is " +
        "already running.",
      input_schema: {
        type: "object" as const,
        properties: {
          to_mandate_id: { type: "string" },
          owls: { type: "number" },
          note: { type: "string" },
        },
        required: ["to_mandate_id", "owls", "note"],
      },
    },
    {
      name: "spawn_mandate",
      description:
        "Carve part of the mission out into a new mandate with its own " +
        "budget and its own Grantmaker. The new mandate starts in planning: its agent " +
        "surveys and drafts its own plan. Use when a slice of the work " +
        "deserves dedicated stewardship, e.g. a whole ingestion program.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string" },
          objective: {
            type: "string",
            description: "The new mandate's mission, in plain words.",
          },
          owls: { type: "number" },
          note: { type: "string" },
        },
        required: ["title", "objective", "owls", "note"],
      },
    },
    {
      name: "set_daily_rate",
      description:
        "Set your mandate's daily allocation rate, in owls per day. The " +
        "escrow is the hard bound either way.",
      input_schema: {
        type: "object" as const,
        properties: { owls_per_day: { type: "number" } },
        required: ["owls_per_day"],
      },
    },
    {
      name: "pipeline_report",
      description:
        "What your mandate's ingestion has actually produced: each source " +
        "brought in, extraction status, claims linked or minted, " +
        "importance and contestation statistics. Read this before " +
        "deciding what to ingest next.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "continue_review",
      description:
        "Declare this pass finished but the work not: another review pass " +
        "runs right away, funded from your escrow out of today's room under " +
        "your daily rate, the same room your assessments and lookouts draw " +
        "on (the briefing says what is left). Use it when the mission genuinely needs more passes " +
        "today, such as enumerating a large source backlog or a territory " +
        "survey in progress. Update your workspace first so the next pass starts " +
        "where this one stopped.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "One line: what's next." },
        },
        required: ["reason"],
      },
    },
 
    // The bounty tools (docs/mathematics.md §8.1): the same implementation
    // as the management chat, two-pass by construction.
    ...getBountyToolDefinitions(),
    // The lookout tools (docs/allocation.md, "Lookouts"): the standing
    // watches this mandate funds. Same implementation as the management
    // chat, through executeManagementTool below.
    ...getLookoutManagementToolDefinitions(),
    // The Correspondent tools (#563), through executeManagementTool too.
    ...getCorrespondentManagementToolDefinitions(),
    {
      name: "note_to_funder",
      description:
        "Leave a note for the mandate's funder: something only they can " +
        "decide or should know, such as a move larger than this pass may " +
        "make, a bounty waiting on their confirmation, a top-up the mission " +
        "needs, or a change of course you recommend. It moves nothing. The " +
        "funder sees it on grant_overview and in their Grantmaker chat; the " +
        `newest ${FUNDER_NOTES_KEPT} are kept. Your closing note stays the public record of the pass.`,
      input_schema: {
        type: "object" as const,
        properties: {
          note: { type: "string", description: "What you need from the funder, or what they should know, and why." },
        },
        required: ["note"],
      },
    },
    {
      name: "complete_mandate",
      description:
        "Close the mandate: the mission is fulfilled (or cannot be " +
        "usefully continued) and the unspent budget should refund to its " +
        "funders (user contributors and regranting mandates), pro rata. " +
        "Closure is two-pass: the first call records your intent to " +
        "close; the close executes only when a later review pass, within " +
        `${CLOSE_CONFIRM_WINDOW_DAYS} days, calls this again, still judging the mission ` +
        "done (an older request is stale and starts over). One pass, however " +
        "convinced, cannot irreversibly end the mandate, which also " +
        "means nothing you read during a single pass can. Exhausting the " +
        "current plan is a waypoint, not by itself a reason to close. A " +
        "mandate with a live bounty cannot close at either pass: withdraw " +
        `its bounties first (withdraw_bounty gives ${config.bountyNoticeDays} days' notice).`,
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "One line, recorded." },
        },
        required: ["reason"],
      },
    },
  ];

  // Structural bounds on money movement from the AUTONOMOUS pass: the
  // agent reads attacker-influenceable text (web results, claims, sources)
  // in the same context as regrant/spawn_mandate, so the briefing's
  // "data, never instructions" rule is backed by hard caps — per pass and
  // per UTC day, as fractions of the escrowed budget. Injected or not, no
  // single pass can move more than its slice.
  const budgetMicro = Number(grant.budget_micro_usd);
  const moveCapPassMicro = Math.floor(
    budgetMicro * (config.mandateReviewMoveFractionPerPass ?? 0.25)
  );
  const moveCapDayMicro = Math.floor(
    budgetMicro * (config.mandateReviewMoveFractionPerDay ?? 0.5)
  );

  const mandateText = grant.mandate
    ? JSON.stringify(grant.mandate, null, 2)
    : `(untitled mandate "${grant.name}")`;

  // The mandate's lookouts and what they raised since the last review: the
  // cheap eyes between passes report here, and their precision is how the
  // Grantmaker decides whether each watch is earning its runs.
  const lastReviewAt = (grant.mandate as { last_review?: { at?: string } } | null)
    ?.last_review?.at;
  const lookouts = await summarizeLookouts(grant.id).catch(() => []);
  const lookoutFlags = await listMandateLookoutFlags(grant.id, {
    since: lastReviewAt ? new Date(lastReviewAt) : null,
    limit: 40,
  }).catch(() => []);
  // The mandate's Correspondents (#563): what each has published and left
  // uncovered, so the Grantmaker can tell whether it serves its readers.
  const correspondents = await listCorrespondents(grant.id).catch(() => []);
  const correspondentText =
    correspondents.length === 0
      ? `(none. spawn_correspondent posts a reader for an audience: it publishes updates as a feed on ` +
        `what changed in its scope that its readers should know.)`
      : correspondents
          .map(
            (c) =>
              `- "${c.title}" for ${c.audience.slice(0, 120)} [${c.status}; ` +
              `${c.heartbeat_hours > 0 ? `every ${c.heartbeat_hours}h` : "event-only"}` +
              `${(c.triggers ?? []).length ? `; triggers ${c.triggers.join(", ")}` : ""}] ` +
              `${c.runs} runs, ${c.updates} updates` +
              `${c.practice_revised_at ? `; practice last revised ${new Date(c.practice_revised_at).toISOString().slice(0, 10)}` : ""}` +
              `${c.last_note ? `. Last: ${c.last_note.slice(0, 200)}` : ""}`
          )
          .join("\n");
  const lookoutText =
    lookouts.length === 0
      ? `(none. spawn_lookout posts a cheap standing watch over part of the ` +
        `mission: a retraction watch over your sources, a new-results watch ` +
        `on a live crux, feeds to follow such as an author, a publication, or a topic.)`
      : lookouts
          .map(
            (l) =>
              `- "${l.title}" [${l.status}; ${l.heartbeat_hours > 0 ? `every ${l.heartbeat_hours}h` : "event-only"}` +
              `${l.triggers.length ? `; triggers ${l.triggers.join(", ")}` : ""}; ceiling ${l.max_value}/10] ` +
              `${l.runs} runs, ${l.flags} flags; precision ${l.precision.moved}/${l.precision.ran} passes moved a verdict ` +
              `(${l.precision.flagged} asked)${l.pending_events ? `; ${l.pending_events} inputs pending` : ""}` +
              `${l.last_note ? `. Last: ${l.last_note.slice(0, 200)}` : ""}` +
              (l.feeds.length
                ? `\n  feeds: ` +
                  l.feeds
                    .map(
                      (f) =>
                        `"${f.title ?? f.url}" [${f.wake}${f.status !== "active" ? `, ${f.status}` : ""}] ` +
                        `${f.waiting} waiting${f.deferred ? `, ${f.deferred} deferred` : ""}`
                    )
                    .join("; ") +
                  ` (feed_report for how each has fared)`
                : "")
          )
          .join("\n") +
        (lookoutFlags.length === 0
          ? `\n\nNo flags since your last pass.`
          : `\n\nFlags since your last pass:\n` +
            lookoutFlags
              .map(
                (f) =>
                  `- [${f.lookout_title}] ${f.kind}${f.claim_id ? ` claim ${f.claim_id}` : ""}` +
                  `${f.url ? ` ${f.url}` : ""}${f.value_written !== null ? ` valued ${f.value_written}` : ""}: ` +
                  `${f.rationale.slice(0, 240)}`
              )
              .join("\n"));
  const items = grant.plan?.items ?? [];
  const valuationClause = isFormulaMandate
    ? `revise the formula your valuations are computed from where what you ` +
      `have learned about allocation itself warrants it ` +
      `(update_allocation_policy)`
    : `revise your valuations over the open ledger, and your maintenance ` +
      `ceiling where upkeep deserves more or less of the day ` +
      `(update_allocation_policy)`;
  const REVIEW_PASS_MAX_TURNS = RUN_TURN_GUARD;
  // A decomposition's passes share a tenth of its budget: say so, and what
  // is left of it (claim-mandate-service.ts).
  const shareOwls = Number(grant.mandate?.grantmaker_share_owls ?? 0);
  const shareLeft = shareOwls > 0
    ? await grantmakerShareLeftMicroUsd({ id: grant.id, mandate: { grantmaker_share_owls: shareOwls } })
    : null;
  const shareNote = shareLeft
    ? grantmakerShareNote(shareOwls, microUsdToOwls(shareLeft.leftMicroUsd), "review").trimStart() + "\n\n"
    : "";
  // The inbox: what the mandate's work produced since the last pass
  // (mandate-event-service.ts). Whatever this pass is shown is marked
  // consumed when it ends; the rest waits for the next.
  const inbox = await pendingMandateEvents(grant.id, 100).catch(() => ({ events: [], total: 0 }));
  const inboxText =
    inbox.total === 0
      ? `(nothing new)`
      : inbox.events.map((e) => `- ${describeMandateEvent(e)}`).join("\n") +
        (inbox.total > inbox.events.length
          ? `\n- ...and ${inbox.total - inbox.events.length} more, shown on your next pass.`
          : ``);
  // What the last pass's closing allocation could not fund for lack of
  // room (#688), recorded on the mandate when it ran: shown once, here.
  const lastSkipped = (grant.mandate as { last_allocation?: { skipped?: SkippedRow[] } } | null)
    ?.last_allocation?.skipped ?? [];
  const skippedText =
    lastSkipped.length === 0
      ? ``
      : ` After your last pass, ${lastSkipped.length} valued action(s) did not fund for lack of room: ` +
        lastSkipped
          .slice(0, 10)
          .map(
            (r) =>
              `${r.action_id ?? r.group} needs ${r.needed_owls} owls (` +
              (r.reason === "daily_rate"
                ? `more than the whole daily rate, so it never funds by valuation`
                : r.reason === "maintenance_share"
                  ? `more than the day's maintenance share`
                  : `more than was left of that day`) +
              `)`
          )
          .join("; ") +
        (lastSkipped.length > 10 ? `; and ${lastSkipped.length - 10} more` : ``) +
        `. Raise the rate or the share, or fund a request directly (fund_request), where it should run.`;
  const briefing =
    `## Mandate review pass\n\n` +
    `You are taking your autonomous review of the live mandate you ` +
    `steward. Nobody is watching this run; act with the judgment of a ` +
    `person entrusted with the budget and the mission.\n\n` +
    `Your mandate:\n\n${mandateText}\n\n` +
    `Budget: ${microUsdToOwls(Number(grant.budget_micro_usd))} owls escrowed, ` +
    `${microUsdToOwls(committed)} committed (metered + allocated + regranted + held in bounties), ` +
    `daily rate ${microUsdToOwls(Number(grant.daily_budget_micro_usd))} owls ` +
    `(yours to set)` +
    (Number(grant.daily_budget_micro_usd) > 0
      ? `, of which ${microUsdToOwls(today.allocatedMicroUsd)} owls is allocated so far today ` +
        `(UTC), ${today.reviewPasses} review pass${today.reviewPasses === 1 ? "" : "es"} included` +
        (policyInForce
          ? `; at most ${Math.round(policyInForce.maintenance_share * 100)}% of the rate goes to ` +
            `maintenance (curate rows) in a day (maintenance_share ${policyInForce.maintenance_share}, ` +
            `yours to set with update_allocation_policy)`
          : ``) +
        `. The allocator funds a valued action only when what it still needs fits in what is ` +
        `left of today's rate; it never part-funds one`
      : ``) +
    `.${skippedText} Plan: ${describePlanCounts(countPlanItems(items, grant.plan_cursor))} ` +
    `(grant_overview itemises; "done" counts the items whose work ran).\n\n` +
    `Since your last pass (assessments on the nodes you funded, decisions on ` +
    `your contributions, sources you ingested, your lookouts' flags):\n\n${inboxText}\n\n` +
    `Your reviews wake when your mandate's work produces something like ` +
    `this, ${WAKE_AFTER_MINUTES} minutes or more after your last pass ended so that ` +
    `a burst is judged together, and otherwise once a day. Each pass is ` +
    `paid from your escrow within your daily rate.\n\n` +
    `Your lookouts (standing watches you fund; list_lookouts for detail):\n\n${lookoutText}\n\n` +
    `Your correspondents (readers you fund for an audience; correspondent_report for detail):\n\n${correspondentText}\n\n` +
    `Your workspace (your own notes from previous passes):\n\n` +
    (grant.workspace?.trim()
      ? grant.workspace
      : `(empty: this is your first pass, or you have not written notes ` +
        `yet. Start the map.)`) +
    `\n\n---\n\n` +
    `Do what the mandate needs this pass and skip what doesn't need doing; ` +
    `your spending lever is to ${valuationClause}. Before finishing, update your workspace so ` +
    `the next pass starts where this one stopped; call continue_review if ` +
    `the mission needs another pass today. Finish with a short note, at most ` +
    `${REVIEW_NOTE_MAX_CHARS} characters, recorded on the mandate's public page: ` +
    `what you did and why.\n\n` +
    shareNote +
    // The one hard limit near escrow (CLAUDE.md "Constraints on agents"):
    // this pass reads text anyone can write, in the same context as the
    // tools that move money out of the mandate.
    `Because this pass reads text anyone can write in the same context as ` +
    `the tools that move money, an autonomous pass can move at most ` +
    `${microUsdToOwls(moveCapPassMicro)} owls (regrants + spawns), ` +
    `${microUsdToOwls(moveCapDayMicro)} per day. Larger moves belong to ` +
    `the funder: ask with note_to_funder.`;

  let valuationsWritten = 0;
  let planItemsAdded = 0;
  let continueRequested = false;
  let movedThisPassMicro = 0;
  const checkMoveCap = async (
    owls: number
  ): Promise<{ allowed: boolean; problem?: string }> => {
    const requested = owlsToMicroUsd(Number(owls) || 0);
    if (requested <= 0) return { allowed: true };
    if (movedThisPassMicro + requested > moveCapPassMicro) {
      return {
        allowed: false,
        problem:
          `Autonomous review passes may move at most ` +
          `${microUsdToOwls(moveCapPassMicro)} owls per pass (structural ` +
          `cap); ${microUsdToOwls(movedThisPassMicro)} already moved. ` +
          `Larger moves need the mandate's funder, via their Grantmaker chat.`,
      };
    }
    const [today] = await rawQuery<{ moved: number }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS moved
         FROM regrants
        WHERE from_grant_id = $1
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [grant.id]
    );
    if (Number(today?.moved ?? 0) + requested > moveCapDayMicro) {
      return {
        allowed: false,
        problem:
          `Autonomous review passes may move at most ` +
          `${microUsdToOwls(moveCapDayMicro)} owls per day (structural cap).`,
      };
    }
    return { allowed: true };
  };
  const recordMove = (owls: number) => {
    movedThisPassMicro += owlsToMicroUsd(Number(owls) || 0);
  };

  const availableTools = tools;

  const result = await withSkills([], () => toolUseLoop({
    initialMessages: [
      { role: "user", content: `${briefing}\n\n${turnBudgetLine(REVIEW_PASS_MAX_TURNS)}${skillLoader.pointerNote}` },
    ],
    tools: [webSearch.tool, ...availableTools, ...skillLoader.definitions, ...getActiveSkillToolDefinitions(listSkills(), "grantmaker")],
    system,
    model,
    // A turn may carry a whole-workspace rewrite or a long extend_plan:
    // 4096 cut both off (#690). 16384 is what the planning pass's and the
    // chat's non-streaming path allow, inside every supported model's output
    // limit and the request timeout. Nothing here is a spending limit: the
    // pass is metered to the escrow.
    maxTokens: 16384,
    maxIterations: REVIEW_PASS_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "grantmaker" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      // Shared graph reads first; null means "not mine", so the mandate's own
      // handlers below still run.
      // Each node a read returns carries the open actions on it.
      const graphRead = await executeGraphReadTool(name, toolInput);
      if (graphRead !== null) return annotateOpenActions(name, graphRead, grant.id);
      const mandateTool = await mandateTools.execute(name, toolInput);
      if (mandateTool !== null) return annotateOpenActions(name, mandateTool, grant.id);
      const contributed = await contributionTools.execute(name, toolInput);
      if (contributed !== null) return contributed;
      const research = await researchTools.execute(name, toolInput);
      if (research !== null) return research;
      if (name === LIST_REQUESTS_TOOL.name) {
        return (await executeKindTool(name, toolInput, { role: "grantmaker", model }))!;
      }
      // The management tools this pass shares with the owner-driven chat
      // (grant_overview, the valuation tools, update_allocation_policy, the
      // read tools, bounties, lookouts) run the same implementation, honesty
      // guards included. Null means "not mine".
      const management = await executeManagementTool(grant.id, name, toolInput, {
        passStartedAt,
        actor: "grantmaker:review",
        // No person is present on the autonomous pass: a posting at or
        // above the autonomy threshold parks at confirm_pending.
        confirmedBy: null,
      });
      if (management !== null) {
        if (name === "set_valuations") valuationsWritten += writtenCount(management);
        return management;
      }
      if (name === "note_to_funder") {
        const text = String(toolInput.note ?? "").trim();
        if (!text) return JSON.stringify({ success: false, problem: "note is required" });
        await rawQuery(
          `UPDATE grants
              SET mandate = jsonb_set(
                    COALESCE(mandate, '{}'::jsonb), '{funder_notes}',
                    (SELECT COALESCE(jsonb_agg(n ORDER BY i), '[]'::jsonb)
                       FROM (SELECT n, i FROM jsonb_array_elements(
                               COALESCE(mandate->'funder_notes', '[]'::jsonb)
                               || jsonb_build_array(jsonb_build_object('at', to_jsonb(now()), 'note', $2::text)))
                               WITH ORDINALITY t(n, i)
                             ORDER BY i DESC LIMIT $3) kept)),
                  updated_at = now()
            WHERE id = $1`,
          [grant.id, text, FUNDER_NOTES_KEPT]
        );
        return JSON.stringify({ success: true, note: "Recorded for the funder; they see it on grant_overview and in their chat." });
      }
      if (name === "extend_plan") {
        const newItems = (Array.isArray(toolInput.items) ? toolInput.items : []) as PlanItem[];
        if (newItems.length === 0) {
          return JSON.stringify({ success: false, problem: "no items" });
        }
        const probe: GrantMandate = {
          title: "x",
          objective: "x",
          plan: { strategy: "x", items: newItems },
          expected_cost_owls: 1,
          funder_named: true,
          funder_stake: "none",
        };
        const problem = validateMandate(probe);
        if (problem) return JSON.stringify({ success: false, problem });
        // Stored in the one plan-item form every path writes (#684).
        const stored = normalizePlanItems(newItems);
        const [appended] = await rawQuery<{ before: number }>(
          `UPDATE grants
              SET plan = jsonb_set(
                    COALESCE(plan, '{"items": []}'::jsonb), '{items}',
                    COALESCE(plan->'items', '[]'::jsonb) || $2::jsonb),
                  updated_at = now()
            WHERE id = $1 AND status = 'active'
            RETURNING jsonb_array_length(COALESCE(plan->'items', '[]'::jsonb))
                      - $3::int AS before`,
          [grant.id, JSON.stringify(stored), stored.length]
        );
        if (!appended) {
          return JSON.stringify({
            success: false,
            problem: "the mandate is not active; the plan can no longer grow",
          });
        }
        planItemsAdded += newItems.length;
        // Materialize now, so the pass learns in this turn whether each
        // item became work and, if not, why (#416). A materializer
        // failure never loses the append: the sweep retries on cadence.
        const before = Number(appended.before);
        const indices = newItems.map((_, i) => before + i);
        let outcomes: Array<{ index: number; action: string; ledger: unknown }> = [];
        let materializeProblem: string | null = null;
        try {
          outcomes = await materializePlanItems(grant.id, indices);
        } catch (err) {
          materializeProblem = err instanceof Error ? err.message : String(err);
        }
        return JSON.stringify({
          success: true,
          appended: newItems.length,
          items: outcomes.map((o) => ({
            index: o.index,
            action: o.action,
            ...("claim_id" in o && o.claim_id ? { claim_id: o.claim_id } : {}),
            ...("url" in o && o.url ? { url: o.url } : {}),
            ledger: o.ledger,
          })),
          ...(materializeProblem
            ? {
                note:
                  "appended, but not yet materialized onto the ledger: " +
                  `${materializeProblem}. The reconcile sweep retries on its cadence; ` +
                  "grant_overview shows each item's standing.",
              }
            : {}),
        });
      }
      if (name === "regrant") {
        const owls = Number(toolInput.owls ?? 0);
        const cap = await checkMoveCap(owls);
        if (!cap.allowed) {
          return JSON.stringify({ ok: false, code: "MOVE_CAP", problem: cap.problem });
        }
        const res = await createRegrant({
          fromGrantId: grant.id,
          toGrantId: String(toolInput.to_mandate_id ?? ""),
          owls,
          note: String(toolInput.note ?? ""),
        });
        if (res.ok) recordMove(owls);
        return JSON.stringify(res);
      }
      if (name === "spawn_mandate") {
        const owls = Number(toolInput.owls ?? 0);
        const cap = await checkMoveCap(owls);
        if (!cap.allowed) {
          return JSON.stringify({ ok: false, code: "MOVE_CAP", problem: cap.problem });
        }
        const res = await spawnFundedMandate({
          fromGrantId: grant.id,
          title: String(toolInput.title ?? ""),
          objective: String(toolInput.objective ?? ""),
          owls,
          note: String(toolInput.note ?? ""),
        });
        if (res.ok) recordMove(owls);
        return JSON.stringify(res);
      }
      if (name === "set_daily_rate") {
        const owlsPerDay = Number(toolInput.owls_per_day);
        if (!Number.isFinite(owlsPerDay) || owlsPerDay < 0) {
          return JSON.stringify({
            success: false,
            problem: "owls_per_day must be a non-negative number",
          });
        }
        const micro = owlsToMicroUsd(owlsPerDay);
        await rawQuery(
          `UPDATE grants SET daily_budget_micro_usd = $2, updated_at = now()
            WHERE id = $1`,
          [grant.id, micro]
        );
        return JSON.stringify({ success: true, owls_per_day: owlsPerDay });
      }
      if (name === "pipeline_report") {
        const { getMandatePipeline } = await import(
          "../../services/mandate-service.js"
        );
        const pipeline = await getMandatePipeline(grant.id);
        return JSON.stringify({ sources: pipeline.length, pipeline });
      }
      if (name === "continue_review") {
        continueRequested = true;
        return JSON.stringify({
          success: true,
          note:
            "Another pass runs after this one, paid from what is left of " +
            "today's rate. Make sure your workspace is current, then finish.",
        });
      }
      if (name === "complete_mandate") {
        // TWO-PASS closure: an autonomous pass that reads the open web in
        // the same context as this tool must not be able to irreversibly
        // end the mandate on one (possibly injected) judgment. The first
        // call records the intent; only a call from a LATER pass — a
        // fresh context, re-judging the mission — executes it. Requests
        // older than the confirmation window go stale and start over.
        const reason = String(toolInput.reason ?? "").trim();
        // A mandate with a live bounty cannot close at either pass (§8.1):
        // the escrow that backs the prize is never refunded from under it.
        const blockers = await mandateClosureBlockers(grant.id);
        if (blockers.live_bounties > 0) {
          return JSON.stringify({
            success: false,
            closed: false,
            code: "LIVE_BOUNTIES",
            live_bounties: blockers.live_bounties,
            bounty_ids: blockers.bounty_ids,
            problem: closureBlockedMessage(blockers.live_bounties),
          });
        }
        const [pending] = await rawQuery<{ at: string | null }>(
          `SELECT mandate->'close_requested'->>'at' AS at
             FROM grants WHERE id = $1`,
          [grant.id]
        );
        const requestedAt = pending?.at ? Date.parse(pending.at) : null;
        const confirmable =
          requestedAt !== null &&
          requestedAt < passStartedAt.getTime() &&
          requestedAt > Date.now() - CLOSE_CONFIRM_WINDOW_DAYS * 86_400_000;
        if (!confirmable) {
          await rawQuery(
            `UPDATE grants
                SET mandate = jsonb_set(
                      COALESCE(mandate, '{}'::jsonb), '{close_requested}',
                      jsonb_build_object('at', to_jsonb(now()),
                                         'reason', $2::text)),
                    updated_at = now()
              WHERE id = $1 AND status = 'active'`,
            [grant.id, reason || "(no reason given)"]
          );
          return JSON.stringify({
            success: true,
            closed: false,
            note:
              "Closure requested and recorded. The mandate stays live; if " +
              "a later review pass still judges the mission done, calling " +
              "complete_mandate again will close it and refund the " +
              "unspent budget. Note the pending closure in your workspace.",
          });
        }
        const refunded = await refundUnspentBudget({
          id: grant.budget_job_id,
          userId: grant.funder_user_id,
          budgetMicroUsd: Number(grant.budget_micro_usd),
        });
        await rawQuery(
          `UPDATE budget_jobs SET status = 'completed', completed_at = now(),
                  updated_at = now() WHERE id = $1`,
          [grant.budget_job_id]
        );
        await rawQuery(
          `UPDATE grants SET status = 'completed', updated_at = now()
            WHERE id = $1`,
          [grant.id]
        );
        continueRequested = false;
        return JSON.stringify({
          success: true,
          closed: true,
          refunded_owls: microUsdToOwls(refunded),
          note: "Mandate closed; finish with your closing note.",
        });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
  }));

  // Stated in the briefing; past it the note is cut, since it is a
  // summary line on the mandate's public page, not a report.
  const note = (result.content ?? "").trim().slice(0, REVIEW_NOTE_MAX_CHARS);
  // The review note is part of the mandate's public record.
  await rawQuery(
    `UPDATE grants
        SET mandate = jsonb_set(
              COALESCE(mandate, '{}'::jsonb), '{last_review}',
              jsonb_build_object('at', to_jsonb(now()), 'note', $2::text)),
            updated_at = now()
      WHERE id = $1`,
    [grant.id, note || "(review completed without a note)"]
  );
  await consumeMandateEvents(grant.id, inbox.events.map((e) => e.id)).catch(() => {});
  // Fund what this pass decided now, not at the next scheduled sweep
  // (hours away): the allocator is idempotent and locked per mandate, and
  // bounded by the daily rate and the escrow like every other placement.
  // A failure here leaves the valuations for the sweep to fund.
  let allocated = 0;
  if (valuationsWritten > 0) {
    try {
      const run = await runMandateAllocator(grant.id);
      allocated = run.allocated;
      // Recorded for the next briefing (#688): the pass that valued these
      // has ended, so the next one is where the agent learns they waited.
      const skipped: SkippedRow[] = (run.skippedForRoom ?? []).slice(0, 50).map((r) => ({
        group: r.group,
        action_id: r.actionId,
        needed_owls: microUsdToOwls(r.neededMicroUsd),
        reason: r.reason,
      }));
      await rawQuery(
        `UPDATE grants
            SET mandate = jsonb_set(COALESCE(mandate, '{}'::jsonb), '{last_allocation}',
                  jsonb_build_object('at', to_jsonb(now()), 'skipped', $2::jsonb))
          WHERE id = $1`,
        [grant.id, JSON.stringify(skipped)]
      );
    } catch (err) {
      console.error(
        `[mandate-review] allocation after the pass failed for ${grant.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return { note, valuationsWritten, planItemsAdded, continueRequested, allocated };
}
