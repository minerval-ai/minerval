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

type Tool = Anthropic.Tool;

export const COMMISSION = "commission";
export const PETITION_MANDATE = "petition_mandate";

export function getSpendToolDefinitions(): Tool[] {
  return [
    {
      name: COMMISSION,
      description:
        "Pay for another agent's run from your own budget: a Steward pass on a " +
        "node (kind pass). You set the run's budget: read the costing skill's " +
        "cost_sheet for what such runs cost and use the high end of the range, " +
        "not the middle, since what the run doesn't spend comes back. The budget " +
        "leaves yours at once. The run's agent is told its budget and your brief, " +
        "and that a run paid for it, never which mandate; it may petition the " +
        "mandate paying for it if it needs more. The run starts on its own and " +
        "its outcome is recorded on its target. A commission buys attention, " +
        "never a conclusion: write the brief as the question you want looked at, " +
        "not the answer you want. For research you need before you conclude, use " +
        "delegate_research.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: ["pass"], description: "What work to pay for: pass, a Steward pass on a node." },
          target: { type: "string", description: "The node's id." },
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
              "readable without your transcript. It arrives as a message in the " +
              "node's inbox.",
          },
          tier: { type: "string", enum: ["standard", "strong"], description: "Optional; standard by default." },
        },
        required: ["target", "budget_owls", "brief"],
      },
    },
    {
      name: PETITION_MANDATE,
      description:
        "Ask the mandate paying for this run for more money, and get its answer " +
        "now. The petition goes to that mandate with the chain of runs that led " +
        "to this one; you are not told which mandate it is, since your work " +
        "serves the graph, not its funder. Use it when doing the work properly " +
        "needs more than you have, and say so concretely: what you would do " +
        "with the money, why your budget can't cover it, and what you will " +
        "conclude if the answer is no. A program officer reads your petition " +
        "with the mandate's policy, its recent decisions and how this run came " +
        "to be funded, and answers in seconds; what is beyond the officer goes " +
        "to the mandate's Grantmaker, which takes a minute or two. Asking costs " +
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
          wait: { type: "boolean", description: "true (the default for more_budget) to wait for the answer in this run; false to send it and carry on." },
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
          `went to its inbox instead, at no cost. Commission again after it finishes if it doesn't cover what you need.`,
      });
    }
    debitRunBudget(budget);
    const after = runBudgetLeft();
    return JSON.stringify({
      success: true,
      message:
        `Commissioned a ${res.tier} pass on ${String(input.target)} with a budget of ${owls(budget)} owls from your budget` +
        (after !== null ? `; you have ${owls(after)} left` : "") +
        `. It runs on its own; its outcome is recorded on the node.`,
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
