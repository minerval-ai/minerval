/**
 * The mandate review pass — a Grantmaker stewarding its live mandate,
 * autonomously and with discretion.
 *
 * A mandate's scope is defined in WORDS; which work falls under it is a
 * judgment call. When its Grantmaker has no live session, the ledger opens a `mandate_review` action
 * for every active mandate (self-funded from its escrow, metered under a
 * cap), and the engine executor runs this agent: the same Grantmaker that
 * designed the mandate, now reviewing it the way any person entrusted with
 * a budget and a mission would —
 *
 *  - survey its territory: the graph (search, query_sql) AND the open
 *    web (web_search) — finding the right sources is the agent's job, not
 *    a human's;
 *  - read back what its money did (mandate-reflection-service.ts) and
 *    revise the operating policy its program officers carry out, or
 *    commission directly;
 *  - grow its own plan: append ingest/assess items it has discovered
 *    (each priced, escrow-bounded, executed through the same ledger);
 *  - move money: regrant to a peer mandate, or spawn a new one with its
 *    own Grantmaker, when part of the mission belongs in other hands.
 *
 * Cost discipline lives in the mechanism, never in narrowed affordances:
 * the pass itself is capped and metered, everything it queues is priced
 * against the escrow, and a pace bounds the spend. The refusal duties
 * that govern mandate design govern this pass equally.
 */
import { openSession, executeSessionTool, getSessionToolDefinitions, type SessionResume } from "../tools/session-tools.js";
import { executeSubscriptionTool, getSubscriptionToolDefinitions } from "../tools/subscription-tools.js";
import { escalationDigest } from "./program-officer.js";
import { paceRoom } from "../../services/pace-service.js";
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { getUsageContext, runBudget, withAgent, withSkills } from "../usage-context.js";
import { reviewPassBudgetBasis } from "../prompts/pass-budget.js";
import { reviewPassBudget, type OperatingPolicy } from "../../services/operating-policy-service.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { getGrantmakerSystemPromptBlocks } from "../prompts/grantmaker.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { withoutOffFeatureTools } from "../tools/feature-tools.js";
import { listSkills } from "../prompts/skills.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { createMandateTools } from "../tools/mandate-tools.js";
import { createGrantContributionTools } from "../tools/grant-contribution-tools.js";
import { annotateOpenActions } from "../../services/open-actions-service.js";
import {
  planProposalRefs,
  validateMandate,
  executeManagementTool,
  type GrantMandate,
  getBountyToolDefinitions,
  getManagementReadToolDefinitions,
} from "./grantmaker.js";
import {
  PLAN_ITEM_SCHEMA,
  PLAN_KIND_RULES,
  normalizePlanItems,
  type PlanItem,
} from "../../services/grant-service.js";
import { createResearchTools } from "../tools/research-tools.js";
import { executeKindTool, getRequestToolDefinitions } from "../tools/kind-tools.js";
import { countPlanItems, describePlanCounts } from "../../services/plan-state.js";
import {
  REVIEW_GROUP,
  grantmakerShareLeftMicroUsd,
  materializeLivePlan,
  materializePlanItems,
} from "../../services/action-service.js";
import { getMandateOperationsToolDefinitions } from "./program-officer.js";
import { reflectionSections } from "../../services/mandate-reflection-service.js";
import { grantmakerShareNote } from "../../services/claim-mandate-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import {
  createRegrant,
  spawnFundedMandate,
  grantCommittedMicroUsd,
} from "../../services/regrant-service.js";
import { refundUnspentBudget } from "../../services/budget-job-service.js";
import {
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


export interface MandateReviewResult {
  note: string;
  planItemsAdded: number;
  /**
   * The agent asked for a fresh start (fresh_start): its session ends and a
   * new review pass opens now from its workspace, rather than this
   * conversation continuing.
   */
  freshStart: boolean;
}

/** The check-in a Grantmaker gets when it sets none, stated in its briefing. */
export const DEFAULT_CHECK_IN_HOURS = 24;

/**
 * add_to_pass_budget: more of the mandate's own escrow onto the review row
 * this pass is running on, through placeCommission, the path a granted
 * petition takes (petition-service.ts), so the pace and the escrow
 * are checked under the mandate's lock and a refusal carries the figures.
 * The run's ceiling rises by what was placed, and the row settles as it
 * always does: what the pass metered is spent, the rest is freed.
 */
export async function addToPassBudget(
  grantId: string,
  input: Record<string, unknown>,
  fromShare: boolean
): Promise<string> {
  if (fromShare) {
    return JSON.stringify({
      success: false,
      problem: "This mandate's passes are paid from its Grantmaker share, which is their bound; there is no adding to it.",
    });
  }
  const askedOwls = Number(input.owls);
  const reason = String(input.reason ?? "").trim();
  if (!Number.isFinite(askedOwls) || !(askedOwls > 0)) {
    return JSON.stringify({ success: false, problem: "owls must be a number above zero." });
  }
  if (!reason) return JSON.stringify({ success: false, problem: "reason is required: it is recorded with the money." });
  const budget = getUsageContext().passBudget;
  const actionId = budget?.funding?.actionId;
  if (!budget || !actionId) {
    return JSON.stringify({
      success: false,
      problem: "This pass is not running on a ledger row with a budget, so there is nothing to add to.",
    });
  }
  const micro = owlsToMicroUsd(askedOwls);
  const { placeCommission } = await import("../../services/commission-service.js");
  const { creditRunBudget } = await import("../run-funding.js");
  const placed = await placeCommission({
    // The row this sitting runs on: the review row, or a resumption's own
    // row when the session resumed (resume:<session>:<n>).
    group: (await rawQuery<{ g: string }>(`SELECT exclusion_group AS g FROM actions WHERE id = $1`, [actionId]))[0]?.g ?? REVIEW_GROUP(grantId),
    actionId,
    claimId: null,
    payer: { kind: "grant", grantId },
    budget: micro,
    commissionedBy: "review_pass",
    brief: null,
    reason,
  });
  if (!placed.ok) {
    return JSON.stringify({
      success: false,
      code: placed.code,
      problem:
        placed.message +
        (placed.code === "OVER_PACE"
          ? " Ask for what is left; the pace is the funder's to change (note_to_funder)."
          : placed.code === "OVER_ESCROW"
            ? " Ask for what is left; more escrow is the funder's to add (note_to_funder)."
            : ""),
    });
  }
  creditRunBudget(micro);
  const left = Math.max(0, budget.microUsd - budget.meter.billedMicroUsd);
  return JSON.stringify({
    success: true,
    added_owls: microUsdToOwls(micro),
    budget_owls: microUsdToOwls(budget.microUsd),
    left_owls: microUsdToOwls(left),
    note:
      `Added. This pass's budget is now ${microUsdToOwls(budget.microUsd)} owls, with ` +
      `${microUsdToOwls(left)} left; the addition is held against the mandate's pace like the rest, and what you ` +
      `do not spend is freed when the pass ends.`,
  });
}

export function runMandateReview(
  input: Parameters<typeof runMandateReviewImpl>[0],
  resume?: SessionResume
): ReturnType<typeof runMandateReviewImpl> {
  return withAgent("mandate_review", () => runMandateReviewImpl(input, resume));
}

async function runMandateReviewImpl(input: {
  grantId: string;
  model?: string;
}, resume?: SessionResume): Promise<MandateReviewResult> {
  const config = loadConfig();
  // Anchors the two-pass closure rule: a close request is only
  // confirmable by a pass that STARTED after it was recorded.
  const passStartedAt = new Date();
  // The plan is brought up to date before it is read: a decided proposal
  // (#656) may be what woke this pass, and a standing order that was
  // waiting for room (#849) is asked for again.
  await materializeLivePlan(input.grantId);
  const [grant] = await rawQuery<{
    id: string;
    name: string;
    policy: string;
    mandate: GrantMandate | null;
    plan: { strategy?: string; items?: PlanItem[] } | null;
    plan_cursor: number;
    budget_job_id: string;
    budget_micro_usd: number;
    workspace: string | null;
    funder_user_id: string;
    skills: string[] | null;
  }>(
    `SELECT g.id, g.name, g.policy, g.mandate, g.plan, g.plan_cursor,
            g.budget_job_id, j.budget_micro_usd,
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
  // Where the pace stands, so a decision to chain another pass, or to
  // hold money back, is made knowing what the mandate has left.
  const pace = await paceRoom(grant.id, "grantmaker");
  // What the officers sent and the Grantmaker has not decided, by id.
  const escalations = await escalationDigest(grant.id);

  // Web search on every provider: the server runs it on an Anthropic model,
  // the loop executes it elsewhere (tools/web-search-tool.ts).
  const model = input.model ?? config.grantmakerModel;
  const webSearch = createWebSearch(model);
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model, mandate: true });
  const mandateTools = createMandateTools({ grantId: grant.id });
  // Contributions through the Reviewer, paid from the escrow (§19).
  const contributionTools = createGrantContributionTools(grant.id);
  // The delegation channel (#298, #683): the same instrument and the same
  // request funding the management chat carries. The pass is where a
  // mandate is stewarded, so it holds the affordances its prompt describes
  // (§19); research commissions and fund_request refuse past the uncommitted
  // budget, and the move caps below are for money leaving the mandate.
  const researchTools = createResearchTools({ requestedBy: "grantmaker", grantId: grant.id });
  // A decomposition's Grantmaker share, in owls (0 for every other mandate).
  const shareOwls = Number(grant.mandate?.grantmaker_share_owls ?? 0);
  const tools: Tool[] = [
    ...reportTools.definitions, ...findingTools.definitions,
    // Shared graph reads: semantic search plus the three structural reads
    // (get_claim, get_decomposition, get_dependents). Valuing the ledger is a
    // judgment call about what falls under this mandate's words, and that is
    // not answerable from keyword hits and scalars — it needs the claim's
    // reasoning, what it rests on, and what rests on it.
    ...getGraphReadToolDefinitions(),
    // The mandate toolbox (#333): read_page,
    // update_workspace — one implementation shared with the planning pass
    // and the granting conversation.
    ...mandateTools.definitions,
    ...contributionTools.definitions,
    // The spending lever: the operating policy its program officers carry
    // out, direct commissions, and SQL over the public views.
    ...getMandateOperationsToolDefinitions({ chat: false }),
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
    {
      name: "extend_plan",
      description:
        "Append new items to your mandate's plan: sources you found that should be ingested, claims that " +
        "need passes, a claim, quantity or question the graph does not hold yet with the passes you want on it. Each item is priced and bounded by your escrow, and " +
        "executes through the ledger like everything else: a pass you plan " +
        "is commissioned from this mandate, within its pace and outside your reserve, as soon " +
        "as there is room. Appends only; " +
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
      name: "pipeline_report",
      description:
        "What your mandate's ingestion has actually produced: each source " +
        "brought in (a plan item whose URL someone else had already " +
        "ingested is listed too, with that extraction's status), extraction " +
        "status, claims linked or minted, " +
        "importance and contestation statistics. Read this before " +
        "deciding what to ingest next.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    // Not offered to a decomposition: its passes are bounded by the
    // Grantmaker share, and its briefing says so.
    ...(shareOwls > 0
      ? []
      : [
          {
            name: "add_to_pass_budget",
            description:
              "Add to this pass's budget from your mandate's escrow, so the pass can finish what it is doing. " +
              "The amount is placed on this pass the way a granted petition is placed on a run: it is held " +
              "against the mandate's pace and escrow at once (your reserve included), and what the pass does not " +
              "spend is freed when it ends. It is refused, with the figures, when the pace or the uncommitted escrow " +
              "has less than you ask for; ask for what is left. This is the cheap way to carry on: fresh_start begins a new session, which pays " +
              "for the opening turn again. If you keep adding, your policy's review_pass_owls is set too low.",
            input_schema: {
              type: "object" as const,
              properties: {
                owls: { type: "number", description: "How much to add, in owls." },
                reason: { type: "string", description: "One line, recorded: what the money is for." },
              },
              required: ["owls", "reason"],
            },
          },
        ]),
    {
      name: "fresh_start",
      description:
        "End this session and start a fresh one now, from your workspace, with today's full briefing and " +
        "none of this conversation. Every time your session resumes it re-reads this whole conversation, " +
        "so a long one makes every later sitting dearer; the resume message states its size. Use this when " +
        "that cost has grown larger than what the conversation is still worth to you, or when the work " +
        "divides into stages that each read cleanly from the workspace. Your subscriptions and check-ins end " +
        "with this session: the fresh one sets its own. Update your workspace first, so the fresh session " +
        "starts where this one stopped.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "One line: what's next." },
        },
        required: ["reason"],
      },
    },
 
    // The bounty tools (docs/mathematics.md §8.1): the same implementation
    // as the management chat, two-pass by construction. Not offered while
    // the prizes feature is off (src/features.ts).
    ...withoutOffFeatureTools(getBountyToolDefinitions()),
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
              `${l.triggers.length ? `; triggers ${l.triggers.join(", ")}` : ""}; commissions up to ${l.commission_limit_owls} owls alone] ` +
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
  // What the money did since the last review, read back so this pass fixes
  // causes, not cases (mandate-reflection-service.ts).
  const reflection = await reflectionSections(
    grant.id,
    lastReviewAt ?? new Date(Date.now() - 7 * 86_400_000).toISOString()
  ).catch(() => "");
  const REVIEW_PASS_MAX_TURNS = RUN_TURN_GUARD;
  // A decomposition's passes share a tenth of its budget: say so, and what
  // is left of it (claim-mandate-service.ts).
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
  const briefing =
    `## Mandate review pass\n\n` +
    `You are taking your autonomous review of the live mandate you ` +
    `steward. Nobody is watching this run; act with the judgment of a ` +
    `person entrusted with the budget and the mission.\n\n` +
    `Your mandate:\n\n${mandateText}\n\n` +
    `Budget: ${microUsdToOwls(Number(grant.budget_micro_usd))} owls escrowed, ` +
    `${microUsdToOwls(committed)} committed (spent + held by running work + regranted + held in bounties). ` +
    (pace ? `${pace.sentence} ` : ``) +
    `The pace is the funder's, agreed at funding (propose a change with note_to_funder); the reserve is yours ` +
    `(set_reserve): money your officers, lookouts and plan orders cannot commit and you can, for the ` +
    `directions worth pursuing once results are in. A commission past the pace is refused, by your officers' ` +
    `tools and yours alike; running work frees what it leaves as it finishes` +
    `. Plan: ${describePlanCounts(countPlanItems(items, grant.plan_cursor))} ` +
    `(grant_overview itemises; "done" counts the items whose work ran).\n\n` +
    (reflection ? `${reflection}\n\n` : ``) +
    `Start from what happened, not from scratch. The sections above are what your money did and ` +
    `where the agents doing the work told you it fell short. Where a shortfall recurs, fix its cause ` +
    `in the operating policy: the budgets for that kind, what officers may grant, a lookout that ` +
    `surfaces too much or misses what matters. Read your officers' decisions as you would a ` +
    `colleague's; where one went wrong, say in the operating policy what you would have done. Record ` +
    `what you learned in your workspace, so the next decision starts from it. Then do whatever else ` +
    `the mission needs this pass.\n\n` +
    `Since your last pass (assessments on the nodes you funded, decisions on ` +
    `your contributions, sources you ingested, your lookouts' flags):\n\n${inboxText}\n\n` +
    `You work in one long session on this mandate, as a person running a large project would: commission ` +
    `work, carry on with what does not depend on it, and when there is nothing more to do now, end your ` +
    `turn. Your session then pauses, with this conversation intact, until something you asked to be told ` +
    `of arrives. You decide what that is. You are always told when your officers escalate something to ` +
    `you and when your funder writes. Beyond that, subscribe to what matters to your mission: the runs you ` +
    `commissioned settling, nodes or subtrees moving, money committed past a figure, and a time to look ` +
    `again (subscribe; list_subscriptions shows what you hold). Waiting for several results before you ` +
    `decide is often better than answering each one as it lands; queue what can wait for your next turn. ` +
    `If you end a turn holding no check-in, you get one ${DEFAULT_CHECK_IN_HOURS} hours out. Each time your ` +
    `session resumes it is a sitting paid from your escrow within the mandate's pace, at your review-pass ` +
    `budget, and it re-reads this conversation; when that has grown dear, fresh_start begins again from ` +
    `your workspace.\n\n` +
    `Your lookouts (standing watches you fund; list_lookouts for detail):\n\n${lookoutText}\n\n` +
    `Your correspondents (readers you fund for an audience; correspondent_report for detail):\n\n${correspondentText}\n\n` +
    `Your workspace (your own notes from previous passes):\n\n` +
    (grant.workspace?.trim()
      ? grant.workspace
      : `(empty: this is your first pass, or you have not written notes ` +
        `yet. Start the map.)`) +
    `\n\n---\n\n` +
    `Do what the mandate needs this pass and skip what doesn't need doing; ` +
    `your spending lever is the operating policy your program officers carry out ` +
    `(write_operating_policy) and direct commissions (commission). Before finishing, update your workspace so ` +
    `a fresh session would start where this one stopped. If this sitting runs low with work in hand, ` +
    (shareOwls > 0 ? `` : `add to its budget (add_to_pass_budget); `) +
    `call fresh_start when beginning again from your workspace is the better way on. End each sitting with a short note, at most ` +
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

  // What this pass's budget is and who set it (#820), for the budget line.
  const budgetBasis = reviewPassBudgetBasis({
    ceilingMicroUsd: runBudget()?.ceilingMicroUsd ?? null,
    figure: reviewPassBudget(
      (grant.mandate as { operating_policy?: OperatingPolicy | null } | null)?.operating_policy
    ),
    fromShare: shareOwls > 0,
    floorOwls: config.reviewPassFloorOwls ?? 1,
    windowMicroUsd: pace?.windowMicroUsd ?? null,
    windowUsedMicroUsd: pace?.windowUsedMicroUsd ?? null,
    escrowFreeMicroUsd: Number(grant.budget_micro_usd) - committed,
  });

  let planItemsAdded = 0;
  let freshStart = false;
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

  // The Grantmaker's one session on this mandate (session-tools.ts): a
  // fresh one opens with today's briefing; a resumed one continues its
  // conversation with what woke it.
  const sess = openSession("grantmaker", null, { grantId: grant.id }, resume);
  await rawQuery(`UPDATE grants SET grantmaker_session_id = $2 WHERE id = $1`, [grant.id, sess.session.id]);
  const result = await sess.run(async () => {
    if (!resume) await standingSubscriptions(grant.id);
    const out = await withSkills([], () => toolUseLoop({
    initialMessages: sess.initialMessages([
      { role: "user", content: `${briefing}\n\n${escalations.text ? `${escalations.text}\n\n` : ""}${turnBudgetLine(REVIEW_PASS_MAX_TURNS, { basis: budgetBasis })}${skillLoader.pointerNote}` },
    ]),
    ...sess.loop,
    tools: [webSearch.tool, ...availableTools, ...getSubscriptionToolDefinitions(), ...getSessionToolDefinitions(), ...skillLoader.definitions, ...getActiveSkillToolDefinitions(listSkills(), "grantmaker")],
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
      const subscribed = await executeSubscriptionTool(name, toolInput, { role: "grantmaker", grantId: grant.id });
      if (subscribed !== null) return subscribed;
      const waited = await executeSessionTool(name, toolInput);
      if (waited !== null) return waited;
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
      // (grant_overview, the operating policy and commissions, the read
      // tools, bounties, lookouts) run the same implementation, honesty
      // guards included. Null means "not mine".
      const management = await executeManagementTool(grant.id, name, toolInput, {
        passStartedAt,
        actor: "grantmaker:review",
        // No person is present on the autonomous pass: a posting at or
        // above the autonomy threshold parks at confirm_pending.
        confirmedBy: null,
      });
      if (management !== null) {
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
        const problem = validateMandate(probe, await planProposalRefs(grant.id));
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
      if (name === "pipeline_report") {
        const { getMandatePipeline } = await import(
          "../../services/mandate-service.js"
        );
        const pipeline = await getMandatePipeline(grant.id);
        return JSON.stringify({ sources: pipeline.length, pipeline });
      }
      if (name === "add_to_pass_budget") {
        return addToPassBudget(grant.id, toolInput, shareOwls > 0);
      }
      if (name === "fresh_start") {
        freshStart = true;
        return JSON.stringify({
          success: true,
          note:
            "When you finish this turn, this session ends and a fresh review pass opens at your review-pass " +
            "budget, within the mandate's pace, from your workspace. Make sure your workspace is current, then finish.",
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
        freshStart = false;
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
    if (freshStart) {
      // A fresh start ends this session and what it held.
      await rawQuery(
        `UPDATE subscriptions SET active = false, ended_at = now()
          WHERE subscriber_kind = 'session' AND subscriber_ref = $1 AND active`,
        [sess.session.id]
      );
    } else {
      await ensureCheckIn(sess.session.id);
    }
    await sess.close(model);
    if (freshStart) {
      await rawQuery(`UPDATE agent_sessions SET status = 'closed', updated_at = now() WHERE id = $1 AND status IN ('waiting', 'ready')`, [sess.session.id]);
    }
    return out;
  });

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
  if (!resume) await consumeMandateEvents(grant.id, inbox.events.map((e) => e.id)).catch(() => {});
  return { note, planItemsAdded, freshStart };
}

/**
 * What every Grantmaker's session is told of, whatever else it subscribes
 * to: what its officers escalate, and what its funder writes. Both wake it.
 */
async function standingSubscriptions(grantId: string): Promise<void> {
  const { ensureSessionRow } = await import("../../services/session-service.js");
  const { createSubscription } = await import("../../services/subscription-service.js");
  const sessionId = await ensureSessionRow();
  if (!sessionId) return;
  await createSubscription({
    subscriberKind: "session",
    subscriberRef: sessionId,
    filter: { kinds: ["escalated"], grant_ids: [grantId] },
    reason: "what your officers send you",
    createdBy: "system",
  });
  await createSubscription({
    subscriberKind: "session",
    subscriberRef: sessionId,
    filter: { kinds: ["inbox_item"], grant_ids: [grantId], refs: { item_kind: ["funder_note"] } },
    reason: "what your funder writes",
    createdBy: "system",
  });
}

/** A Grantmaker that ends a turn holding no check-in gets the default one, as its briefing says. */
async function ensureCheckIn(sessionId: string): Promise<void> {
  const { createSubscription, nextDueAt } = await import("../../services/subscription-service.js");
  if (await nextDueAt({ kind: "session", ref: sessionId })) return;
  await createSubscription({
    subscriberKind: "session",
    subscriberRef: sessionId,
    dueAt: new Date(Date.now() + DEFAULT_CHECK_IN_HOURS * 3_600_000),
    once: true,
    reason: `the default check-in: you ended a turn holding none, so you look again in ${DEFAULT_CHECK_IN_HOURS} hours`,
    createdBy: "system",
  });
}

/**
 * What a Grantmaker reads when its session resumes, beside what woke it:
 * what its officers have escalated and it has not decided, where its pace
 * stands, and what this sitting costs to open, so it can judge when a fresh
 * start is cheaper than carrying the conversation on.
 */
export async function grantmakerWakeDigest(session: { context: { input?: unknown } | null; transcript: unknown[] | null }): Promise<string> {
  const grantId = (session.context?.input as { grantId?: string } | undefined)?.grantId;
  if (!grantId) return "";
  const [pace, escalations] = await Promise.all([paceRoom(grantId, "grantmaker"), escalationDigest(grantId)]);
  const chars = JSON.stringify(session.transcript ?? []).length;
  const pendingEvents = await pendingMandateEvents(grantId, 1).then((r) => r.total).catch(() => 0);
  return [
    escalations.text,
    pace ? `## Where your money stands\n\n${pace.sentence}` : null,
    pendingEvents > 0
      ? `${pendingEvents} event(s) on your mandate's work have arrived since your last fresh briefing (assessments on nodes you funded, decisions on your contributions, your lookouts' flags); grant_overview and allocation_report read them, and a fresh session lists them.`
      : null,
    `This conversation is about ${Math.round(chars / 1000)} thousand characters; each sitting re-reads it before ` +
      `anything else. When that has grown dearer than the context is worth, fresh_start begins again from your workspace.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
