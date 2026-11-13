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
import { currentLabel, getUsageContext } from "../usage-context.js";
import { debitRunBudget, runBudgetLeft, runPayer } from "../run-funding.js";
import { commissionNodePass, commissionNoteText } from "../../services/commission-service.js";
import { filePetition, routePetition, takeInboxLease, releaseInboxLease } from "../../services/petition-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "../../services/owl.js";
import { loadConfig } from "../../config.js";
import { rawQuery } from "../../db/client.js";
import { registerAwait } from "../../services/session-service.js";
import { commissionResearch } from "../../services/research-commission-service.js";
import type { ResearchModelTier } from "../../services/research-run-service.js";
import { figureTiersSentence, researcherToolsSentence, sandboxTiersSentence } from "./research-tools.js";

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
        figureTiersSentence() +
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
        "stopped, with its notebook.",
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
          ask_of: {
            type: "string",
            description:
              "For research: the id of a label above this one that can be asked, where your label note lists one. " +
              "The question is recorded as a request on this node, addressed there and paid for from your budget, " +
              "and an agent that reads what that label reads takes it up. You do not wait for it: what it finds " +
              "comes back through that label's gate, redacted or held as its policy says, as work on the request " +
              "for a later pass to weigh. With ask_of, brief is the request: state it so that it stands on its own.",
          },
          examine_source_id: {
            type: "string",
            description:
              "For research from a Steward: run it as an examination of one document in your node's map, by " +
              "its source id. The Researcher records what it examined and what it found on the document's own " +
              "passages, a record that sits on the document's page for whoever reads it next. A review of a " +
              "document for its own sake, beyond what your node needs, is " +
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
        "to be funded. A routine one is usually decided within a minute or two; " +
        "the officer may hold one until related work reports, which can take " +
        "hours, and what is beyond the officer goes to the mandate's Grantmaker, " +
        "which decides when it next sits. Asking " +
        "doesn't stop you: carry on, and the decision appears in a later tool " +
        "result, a grant raising your budget then; with nothing else to do, " +
        "wait_for_answers waits for it briefly, and past that your session " +
        "pauses and resumes with it, a grant decided meanwhile funding the pass " +
        "that resumes you. Asking costs " +
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
          done_so_far: {
            type: "string",
            description:
              "What you have established so far and what is still open: the officer weighs the ask against the " +
              "work, and against other work on the same part of the graph.",
          },
          why: { type: "string", description: "Why your current budget can't cover it, and why it matters for this work." },
          if_refused: { type: "string", description: "What you will conclude or record if the answer is no." },
          wait: {
            type: "boolean",
            description:
              "true (the default for more_budget) to have the decision come back to you: it arrives in a later " +
              "tool result while you carry on, or resumes your session if you have paused. false to send it and " +
              "carry on without the answer (a granted follow-up starts its own pass).",
          },
        },
        required: ["kind", "owls", "plan", "done_so_far"],
      },
    },
  ];
}

const owls = (micro: number) => microUsdToOwls(micro);

/** What a run paid for from a label below is told when it petitions. */
export const PETITION_BELOW_MESSAGE =
  "Recorded. This run was asked for and paid for from a label that does not read this one, so the petition reaches " +
  "its payer only through this label's gate, and no answer may come while this run lasts. Carry on with the budget " +
  "you have, and record what you could and could not establish.";

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
          commissionNoteText(res),
      });
    }
    debitRunBudget(budget);
    const after = runBudgetLeft();
    // An agent in a session hears how the pass it paid for went, on its next
    // turn, without being woken for it (subscription-service.ts).
    let told = false;
    if (ctx.session) {
      const { ensureSessionRow } = await import("../../services/session-service.js");
      const { createSubscription } = await import("../../services/subscription-service.js");
      const sessionId = await ensureSessionRow();
      if (sessionId) {
        await createSubscription({
          subscriberKind: "session",
          subscriberRef: sessionId,
          filter: { kinds: ["run_settled", "run_closed"], action_ids: [res.actionId] },
          delivery: "queue",
          once: true,
          reason: `the pass you commissioned on ${String(input.target)}`,
          createdBy: ctx.agent ?? "agent",
        });
        told = true;
      }
    }
    return JSON.stringify({
      success: true,
      message:
        `Commissioned a ${res.tier} pass on ${String(input.target)} with a budget of ${owls(budget)} owls from your budget` +
        (after !== null ? `; you have ${owls(after)} left` : "") +
        `. It runs on its own; its outcome is recorded on the node` +
        (told ? `, and you are told when it settles, in a later tool result or when your session next resumes (it does not wake you)` : "") +
        `.` +
        commissionNoteText(res),
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
    // A run asked for from below is paid by a mandate at a label that does
    // not read this one. Its officers work only what is at their own label,
    // and a petition is this label's words going down, which is the gate's
    // to pass. So it is recorded here, nothing waits on it, and the run is
    // told (as its task already said: request-service.ts paidFromBelowNote).
    const [payerAt] = await rawQuery<{ label: string }>(`SELECT sensitivity_label AS label FROM grants WHERE id = $1`, [grantId]);
    if (payerAt && payerAt.label !== currentLabel()) {
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
        waiting: false,
        doneSoFar: input.done_so_far ? String(input.done_so_far) : null,
      });
      // The petition is this label's words going down: it is offered to the gate, and reaches the payer's officers when it is through.
      await import("../../services/gate-handoff.js")
        .then((handoff) => handoff.offerPetitionBelow(petitionId, { grantId, label: payerAt.label }, currentLabel()))
        .catch((err: unknown) => console.error(`[gate] could not offer petition ${petitionId}: ${err instanceof Error ? err.message : String(err)}`));
      return JSON.stringify({ success: true, petition_id: petitionId, message: PETITION_BELOW_MESSAGE });
    }
    // A petition never blocks: the decision returns into the asking session,
    // shown in its next tool result, or resuming it if it paused
    // (session-service.ts). A run with no session cannot receive it, so it
    // sends the petition without waiting.
    const wait = Boolean(ctx.session) && (input.wait === undefined ? kind === "more_budget" : input.wait === true);
    const inSession = wait && kind === "more_budget";
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
      doneSoFar: input.done_so_far ? String(input.done_so_far) : null,
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
    workSoon(grantId);
    return JSON.stringify({
      success: true,
      petition_id: petitionId,
      message: "Sent. The mandate will decide it; a granted follow-up starts its own pass with your plan as its brief.",
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
  if (typeof input.ask_of === "string" && input.ask_of.trim()) {
    return askResearchAbove(input.ask_of.trim(), brief, budget, payer);
  }
  const ctx = getUsageContext();
  // Only a Steward's research serves its node: the Curator's session is
  // anchored on a node it is curating, but what it asks is about structure,
  // and its report is the Curator's, not that node's Steward's.
  const nodeId = ctx.agent === "curator" ? null : ctx.session?.nodeId ?? ctx.claimId ?? null;
  // With a session the report returns into it; without one it goes to the
  // node's inbox, so a run with neither has nowhere to receive it.
  if (!nodeId && !ctx.session) {
    return JSON.stringify({
      success: false,
      message:
        "Research commissioned from here has no node or session to report back to, so nothing was commissioned.",
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
        (nodeId
          ? `The session waits at most ${loadConfig().sessionWaitHours} hours; after that the report goes to this node's inbox.`
          : `The session waits at most ${loadConfig().sessionWaitHours} hours; after that the report stays on the research run, ` +
            `where a later run reads it with get_research_run.`)
      : `Commissioned research run ${res.runId} ${spent}. ` +
        (wantsWait
          ? `This run can't pause to wait for it, so its report goes to this node's inbox for its next pass.`
          : `Its report goes to this node's inbox for its next pass.`),
  });
}

/**
 * commission kind research with ask_of: the same act as any work asked for
 * from below (ask-above-service.ts), from a run and paid from its budget.
 * The run does not wait: an answer is information going down, and comes
 * back through the gate onto the request this records, or is held there.
 */
async function askResearchAbove(
  faceId: string,
  brief: string,
  budget: number,
  payer: NonNullable<ReturnType<typeof runPayer>>
): Promise<string> {
  const ctx = getUsageContext();
  const nodeId = ctx.agent === "curator" ? null : ctx.session?.nodeId ?? ctx.claimId ?? null;
  const { askAbove } = await import("../../services/ask-above-service.js");
  const res = await askAbove({
    faceId,
    as: "work",
    ask: brief,
    why: nodeId
      ? "The run assessing the node this bears on needs it and cannot read what would answer it."
      : "The run that asked needs it and cannot read what would answer it.",
    satisfiedBy: "A report of what was found, with what it rests on, whichever way it comes out.",
    claimIds: nodeId ? [nodeId] : [],
    bearsOnText: nodeId ? null : "What the request describes.",
    budgetMicroUsd: budget,
    payer,
    filer: { kind: "admin", agent: ctx.agent === "steward" || !ctx.agent ? "claim_steward" : ctx.agent, runId: ctx.runId ?? null },
  });
  if (!res.ok) return JSON.stringify({ success: false, message: res.message });
  debitRunBudget(budget);
  const after = runBudgetLeft();
  return JSON.stringify({
    success: true,
    request_id: res.request_id,
    message: askedAboveMessage(res.face.name, res.request_id, owls(budget), after === null ? null : owls(after)),
  });
}

/** What a run is told when it has asked for research at a label above. */
export function askedAboveMessage(face: string, requestId: string, budgetOwls: number, leftOwls: number | null): string {
  return (
    `Asked "${face}" for this, as request ${requestId}, with a budget of ${budgetOwls} owls from your budget` +
    (leftOwls !== null ? ` (you have ${leftOwls} left)` : "") +
    `. An agent that reads what that label reads takes it up. This run is not told whether it was taken up or what ` +
    `it found, and does not wait: conclude now on what you can read, and say in your reasoning what was asked and ` +
    `not yet answered. What comes back passes that label's gate, where it may be redacted or held, and arrives as ` +
    `work on request ${requestId}, which a later pass on this node reads as a source to weigh. What is not spent ` +
    `returns to whoever paid for this run.`
  );
}
