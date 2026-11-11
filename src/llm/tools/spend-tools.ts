/**
 * commission and petition_mandate: the two tools every agent with a budget
 * has, whatever its role. commission pays for another agent's run from the
 * run's own budget; petition_mandate asks the mandate paying for the run for
 * more, and answers in the run.
 *
 * Descriptions are fixed: who pays, how much is left and the chain of runs
 * vary by run, so they are in the task message and the results, never here,
 * and the agents that judge the graph are never told which mandate pays.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getUsageContext } from "../usage-context.js";
import { creditRunBudget, debitRunBudget, runBudgetLeft, runPayer } from "../run-funding.js";
import { commissionNodePass } from "../../services/commission-service.js";
import { awaitDecision, filePetition, routePetition, takeInboxLease, releaseInboxLease } from "../../services/petition-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import { loadConfig } from "../../config.js";
import { rawQuery } from "../../db/client.js";
import { registerAwait } from "../../services/session-service.js";
import { commissionResearch } from "../../services/research-commission-service.js";
import type { ResearchModelTier } from "../../services/research-run-service.js";
import { researcherToolsSentence, sandboxTiersSentence } from "./research-tools.js";

type Tool = Anthropic.Tool;

export const COMMISSION = "commission";
export const PETITION_MANDATE = "petition_mandate";

export function getSpendToolDefinitions(): Tool[] {
  return [
    {
      name: COMMISSION,
      description:
        "Pay for another agent's run from your own budget. kind pass: a Steward pass on a node. " +
        "kind research: a Researcher run on a question this work needs answered, which runs on its " +
        "own while you carry on. " +
        researcherToolsSentence() +
        sandboxTiersSentence() +
        "You set the run's budget: read the costing skill's cost_sheet for " +
        "what such runs cost and use the high end of the range, not the middle, since what the run " +
        "doesn't spend comes back. The budget leaves yours at once. The run's agent is told its " +
        "budget and your brief, and that a run paid for it, never which mandate; it may petition " +
        "the mandate paying for it if it needs more. A commission buys attention, never a " +
        "conclusion: write the brief as the question you want looked at, not the answer you want.\n\n" +
        "Research comes back to you. With wait (the default), carry on with what you can do " +
        "without it; when that is done, end your turn. Your session then pauses and resumes when " +
        "the report arrives, with everything you have read and reasoned still in front of you; a " +
        "report that arrives while you are still working appears in your next tool result. A " +
        `paused session waits at most ${loadConfig().sessionWaitHours} hours; after that the ` +
        "report goes to this node's inbox for a later pass. The resumption is paid from what this " +
        "run has left, by whoever paid for this run. Without wait, the report goes to this node's " +
        "inbox for its next pass. follow_up_of continues an earlier research run from where it " +
        "stopped, with its notebook. For a quick check you need inside this turn, delegate_research " +
        "runs the Researcher inline instead.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            enum: ["pass", "research"],
            description: "pass: a Steward pass on a node. research: a Researcher run, its report returned to you.",
          },
          target: { type: "string", description: "For a pass: the node's id." },
          budget_owls: {
            type: "number",
            description:
              "The run's budget in owls. The costing skill's high-end figure for " +
              "this kind is the usual choice; go higher when you expect this run " +
              "to be larger than most, and say why in the brief.",
          },
          brief: {
            type: "string",
            description:
              "What you want looked at and why, for the agent that will do it, " +
              "readable without your transcript. For a pass it arrives as a message in the " +
              "node's inbox; for research it is the Researcher's whole task: the question, the " +
              "context, what a good answer looks like, where to start.",
          },
          tier: {
            type: "string",
            enum: ["cheap", "standard", "strong"],
            description: "Optional; standard by default. A pass runs standard or strong; research also cheap.",
          },
          wait: {
            type: "boolean",
            description: "For research: true (the default) to have the report return into this session; false to send it to this node's inbox.",
          },
          follow_up_of: { type: "string", description: "For research: the id of an earlier research run this continues." },
          examine_source_id: {
            type: "string",
            description:
              "For research from a Steward: run it as an examination of one document in your node's map, by " +
              "its source id. The Researcher records what it examined and what it found on the document's own " +
              "passages, a record that sits on the document's page for whoever reads it next, as with " +
              "delegate_research. A review of a document for its own sake, beyond what your node needs, is " +
              "asked for as a request bearing on it (file_request with its source).",
          },
          facets: {
            type: "array",
            items: { type: "string" },
            description:
              "With examine_source_id: what to check, as short labels (\"data\", \"quotation\", \"method\"). " +
              "The Researcher may add one the document turns out to call for.",
          },
        },
        required: ["budget_owls", "brief"],
      },
    },
    {
      name: PETITION_MANDATE,
      description:
        "Ask the mandate paying for this run for more money. The petition goes " +
        "to that mandate with the chain of runs that led " +
        "to this one; you are not told which mandate it is, since your work " +
        "serves the graph, not its funder. Use it when doing the work properly " +
        "needs more than you have, and say so concretely: what you would do " +
        "with the money, why your budget can't cover it, and what you will " +
        "conclude if the answer is no. A program officer reads your petition " +
        "with the mandate's policy, its recent decisions and how this run came " +
        "to be funded, and answers in seconds; what is beyond the officer goes " +
        "to the mandate's Grantmaker, which takes a minute or two. Asking " +
        "doesn't stop you: carry on, and the decision appears in a later tool " +
        "result, a grant raising your budget then; with nothing else to do, " +
        "wait_for_answers waits for it briefly, and past that your session " +
        "pauses and resumes with it. Asking costs " +
        "you nothing: the mandate pays for its own decision. Its answer is a " +
        "judgment about money, never about your conclusion, and no answer " +
        "obliges you to conclude anything.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            enum: ["more_budget", "follow_up"],
            description:
              "more_budget: add to this run's budget, to spend directly or to " +
              "commission work you can't afford now. follow_up: fund a fresh pass " +
              "after this run ends, with your plan as its brief, for work that " +
              "won't fit in this run.",
          },
          owls: { type: "number", description: "How much you are asking for: the amount to add, or the follow-up's whole budget." },
          plan: {
            type: "string",
            description:
              "What you would do with the money, concretely enough to judge whether " +
              "it is worth it: the searches, sources, analysis or commissions, and " +
              "the question it settles.",
          },
          why: { type: "string", description: "Why your current budget can't cover it, and why it matters for this work." },
          if_refused: { type: "string", description: "What you will conclude or record if the answer is no." },
          wait: {
            type: "boolean",
            description:
              "true (the default for more_budget) to have the decision come back to you: in a run that can " +
              "pause, it arrives in a later tool result while you carry on; otherwise this call waits for it. " +
              "false to send it and carry on without the answer.",
          },
        },
        required: ["kind", "owls", "plan"],
      },
    },
  ];
}

const owls = (micro: number) => microUsdToOwls(micro);

/**
 * Work the deciding mandate's inbox: the program officer, then the
 * Grantmaker on what was escalated. Loaded lazily, since the agents import
 * the tools that import this module.
 */
async function work(grantId: string): Promise<void> {
  const { workMandateInbox } = await import("../agents/program-officer.js");
  await workMandateInbox(grantId);
}

/** Run an inbox sitting in the background for a petition no one waits on. */
function workSoon(grantId: string): void {
  void (async () => {
    if (!(await takeInboxLease(grantId))) return;
    try {
      await work(grantId);
    } catch (err) {
      console.error(`[petition] inbox sitting for ${grantId} failed:`, err instanceof Error ? err.message : err);
    } finally {
      await releaseInboxLease(grantId);
    }
  })();
}

export async function executeSpendTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name === COMMISSION && input.kind === "research") return commissionResearchTool(input);
  if (name === COMMISSION) {
    const budget = owlsToMicroUsd(Number(input.budget_owls ?? 0));
    if (!(budget > 0)) return JSON.stringify({ success: false, message: "budget_owls must be above zero." });
    const payer = runPayer();
    if (!payer) {
      return JSON.stringify({
        success: false,
        message: "This run isn't paid in a way that can pay for other work. Send a note with notify_steward instead.",
      });
    }
    const left = runBudgetLeft();
    if (left !== null && budget > left) {
      return JSON.stringify({
        success: false,
        message:
          `A budget of ${owls(budget)} owls is more than this run has left (${owls(left)}). Nothing was ` +
          `commissioned. Commission with less, or petition for more and commission once it is granted.`,
      });
    }
    const ctx = getUsageContext();
    const res = await commissionNodePass({
      payer,
      claimId: String(input.target ?? "").trim(),
      budgetMicroUsd: budget,
      tier: input.tier === "strong" ? "strong" : "standard",
      brief: String(input.brief ?? ""),
      commissionedBy: ctx.agent ?? "agent",
      message: {
        trigger: "steward_note",
        sender: ctx.claimId ? { kind: "steward", nodeId: ctx.claimId } : { kind: "system" },
      },
    });
    if (!res.ok) return JSON.stringify({ success: false, message: res.message });
    if (res.status === "already_commissioned") {
      return JSON.stringify({
        success: true,
        message:
          `That node already has a pass commissioned or underway (${res.ageMinutes} minutes ago). Your brief ` +
          `went to its inbox instead, at no cost. Commission again after it finishes if it doesn't cover what you need.` +
          (res.parked ? ` ${res.parked.note}` : ""),
      });
    }
    debitRunBudget(budget);
    const after = runBudgetLeft();
    return JSON.stringify({
      success: true,
      message:
        `Commissioned a ${res.tier} pass on ${String(input.target)} with a budget of ${owls(budget)} owls from your budget` +
        (after !== null ? `; you have ${owls(after)} left` : "") +
        `. It runs on its own; its outcome is recorded on the node.` +
        (res.parked ? ` ${res.parked.note}` : ""),
    });
  }

  if (name === PETITION_MANDATE) {
    const kind = input.kind === "follow_up" ? "follow_up" : "more_budget";
    const asked = owlsToMicroUsd(Number(input.owls ?? 0));
    const plan = String(input.plan ?? "").trim();
    if (!(asked > 0)) return JSON.stringify({ success: false, message: "owls must be above zero." });
    if (!plan) return JSON.stringify({ success: false, message: "plan is required: it is what the decision rests on." });
    const ctx = getUsageContext();
    const funding = ctx.passBudget?.funding;
    const grantId = await routePetition(funding);
    if (!grantId) {
      return JSON.stringify({
        success: false,
        message:
          `This run is not paid by a mandate (${ctx.passBudget?.source ?? "it has no budget"}), so there is no one ` +
          `to petition. Work with the budget you have and record what you could and couldn't establish.`,
      });
    }
    const wait = input.wait === undefined ? kind === "more_budget" : input.wait === true;
    // In a session (a Steward's run), a petition never blocks: the decision
    // returns into the session, shown in the next tool result, or resuming it
    // if it paused (session-service.ts). Without one, the run waits here.
    const inSession = Boolean(ctx.session) && kind === "more_budget" && wait;
    const petitionId = await filePetition({
      grantId,
      kind,
      askedMicroUsd: asked,
      plan,
      why: input.why ? String(input.why) : null,
      ifRefused: input.if_refused ? String(input.if_refused) : null,
      requesterAgent: ctx.agent ?? null,
      requesterActionId: funding?.actionId ?? null,
      requesterNodeId: ctx.claimId ?? null,
      spentMicroUsd: ctx.passBudget?.meter.billedMicroUsd,
      waiting: wait,
    });
    if (inSession) {
      const sessionId = await registerAwait("petition", petitionId);
      if (sessionId) {
        await rawQuery(`UPDATE petitions SET reply_to_session = $2 WHERE id = $1`, [petitionId, sessionId]);
        workSoon(grantId);
        return JSON.stringify({
          success: true,
          petition_id: petitionId,
          message:
            "Sent to the mandate paying for this run. Carry on with what you can do: the decision appears in your " +
            "next tool result, and a grant raises your budget then. If you have nothing else to do until it comes, " +
            "call wait_for_answers. If it still hasn't come, end your turn: your session pauses and resumes with the " +
            "decision, and a grant decided while you are paused funds the pass that resumes you.",
        });
      }
    }
    if (!wait) {
      workSoon(grantId);
      return JSON.stringify({
        success: true,
        message: "Sent. The mandate will decide it; a granted follow-up starts its own pass with your plan as its brief.",
      });
    }
    const p = await awaitDecision(petitionId, work);
    const who = p?.decided_by === "grantmaker" ? "Grantmaker" : "program officer";
    if (!p || p.status === "pending" || p.status === "escalated") {
      return JSON.stringify({
        success: false,
        message:
          "The mandate has not decided within its time. The petition stays open; if it is granted after this " +
          "run ends, it funds a follow-up pass with your plan as its brief. Carry on with the budget you have.",
      });
    }
    if (p.status === "refused") {
      return JSON.stringify({
        success: false,
        message:
          `Refused by the mandate's ${who}. Reason: ${p.reason}. Work with the budget you have and record what ` +
          `you could and couldn't establish. The refusal is about money, not your conclusion.`,
      });
    }
    const granted = Number(p.granted_micro_usd ?? 0);
    if (p.status === "follow_up") {
      return JSON.stringify({
        success: true,
        message:
          `The mandate funded a follow-up pass of ${owls(granted)} owls with your plan as its brief. Record what ` +
          `you have now; the follow-up starts from it.`,
      });
    }
    creditRunBudget(granted);
    const budget = ctx.passBudget;
    return JSON.stringify({
      success: true,
      message:
        `Granted by the mandate's ${who}: ${owls(granted)} of ${owls(asked)} owls. Reason: ${p.reason}.` +
        (budget
          ? ` Your budget is now ${owls(budget.microUsd)} owls, with ${owls(Math.max(0, budget.microUsd - budget.meter.billedMicroUsd))} left.`
          : ""),
    });
  }
  return null;
}

/** commission kind research: a Researcher run, its report returned to this session or node. */
async function commissionResearchTool(input: Record<string, unknown>): Promise<string> {
  const budget = owlsToMicroUsd(Number(input.budget_owls ?? 0));
  if (!(budget > 0)) return JSON.stringify({ success: false, message: "budget_owls must be above zero." });
  const brief = String(input.brief ?? "").trim();
  if (brief.length < 40) {
    return JSON.stringify({
      success: false,
      message: "brief must be a real task for the Researcher: the question, the context, what a good answer looks like, where to start.",
    });
  }
  if (!loadConfig().researcherEnabled) {
    return JSON.stringify({ success: false, message: "The Researcher is disabled in this deployment. Do the work inline." });
  }
  const payer = runPayer();
  if (!payer) {
    return JSON.stringify({ success: false, message: "This run isn't paid in a way that can pay for other work." });
  }
  const left = runBudgetLeft();
  if (left !== null && budget > left) {
    return JSON.stringify({
      success: false,
      message:
        `A budget of ${owls(budget)} owls is more than this run has left (${owls(left)}). Nothing was ` +
        `commissioned. Commission with less, or petition for more and commission once it is granted.`,
    });
  }
  const ctx = getUsageContext();
  const nodeId = ctx.session?.nodeId ?? ctx.claimId ?? null;
  // With a session the report returns into it; without one it goes to the
  // node's inbox, so a run with neither has nowhere to receive it.
  if (!nodeId && !ctx.session) {
    return JSON.stringify({
      success: false,
      message:
        "Research commissioned from here has no node to report back to. Use delegate_research, which runs the Researcher inside this run.",
    });
  }
  const tierRaw = String(input.tier ?? "standard");
  const tier: ResearchModelTier = tierRaw === "strong" || tierRaw === "cheap" ? tierRaw : "standard";
  const wantsWait = input.wait !== false;
  const examineSourceId = typeof input.examine_source_id === "string" ? input.examine_source_id.trim() : "";
  if (!examineSourceId && input.facets !== undefined) {
    return JSON.stringify({ success: false, message: "facets go with examine_source_id: name the document to examine." });
  }
  const res = await commissionResearch({
    payer,
    nodeId,
    task: brief,
    budgetMicroUsd: budget,
    tier,
    requestedBy: ctx.agent === "steward" || !ctx.agent ? "claim_steward" : ctx.agent,
    // A run with no node to report to always waits: its session is where the report goes.
    wait: wantsWait || !nodeId,
    followUpOf: typeof input.follow_up_of === "string" && input.follow_up_of.trim() ? input.follow_up_of.trim() : null,
    examine: examineSourceId ? { sourceId: examineSourceId, facets: input.facets } : null,
  });
  if (!res.ok) return JSON.stringify({ success: false, message: res.message });
  debitRunBudget(budget);
  const after = runBudgetLeft();
  const spent =
    `with a budget of ${owls(budget)} owls from your budget` +
    (after !== null ? ` (you have ${owls(after)} left)` : "") +
    (examineSourceId ? ", as an examination of the document: its findings go on the document's page and in provenance_get_map" : "");
  return JSON.stringify({
    success: true,
    research_run_id: res.runId,
    message: res.waits
      ? `Commissioned research run ${res.runId} ${spent}. It runs on its own. Carry on with what you can do ` +
        `without it, and record what you can already conclude. When that is done, end your turn: your session ` +
        `pauses and resumes when the report arrives, with this conversation intact. If it arrives while you ` +
        `are still working, it appears in your next tool result. ` +
        `The session waits at most ${loadConfig().sessionWaitHours} hours; after that the report goes to this node's inbox.`
      : `Commissioned research run ${res.runId} ${spent}. ` +
        (wantsWait
          ? `This run can't pause to wait for it, so its report goes to this node's inbox for its next pass.`
          : `Its report goes to this node's inbox for its next pass.`),
  });
}
