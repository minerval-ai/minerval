/**
 * Research commissioned as its own run (commission kind research).
 *
 * The Researcher runs on the ledger like any commissioned work: a `research`
 * row, paid whole at the budget the commissioning agent chose, from that
 * agent's own budget (the money keeps its payer, commission-service.ts), run
 * by the engine executor (runResearchAction) and settled with whatever it
 * did not spend going back. The agent that commissioned it is not blocked: it
 * carries on, and the report comes back to it as an answer in its session
 * (session-service.ts), or, when the agent did not wait for it or its
 * session has gone, as a message in its node's inbox.
 *
 * A follow-up continues an earlier run: it opens with that run's notebook and
 * report, so the Researcher picks up where it stopped.
 *
 * A Steward may commission the run as an examination of a document in its
 * node's map (#865), as an inline launch once did: the examination is
 * opened here, before any money moves, so a malformed one is refused at
 * once, and the engine launches the Researcher on it.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel, getUsageContext } from "../llm/usage-context.js";
import {
  carriedNotebook,
  closeResearchRun,
  getResearchRun,
  modelForTier,
  openResearchRun,
  type ResearchModelTier,
  type ResearchRunRow,
} from "./research-run-service.js";
import { placeCommission, type CommissionPayer } from "./commission-service.js";
import { registerAwait } from "./session-service.js";
import { ExaminationError, linkResearchRun, openExamination } from "./examination-service.js";

export const RESEARCH_GROUP = (runId: string) => `research:${runId}`;

export type ResearchCommissionResult =
  | { ok: true; runId: string; actionId: string; waits: boolean }
  | { ok: false; message: string };

export async function commissionResearch(input: {
  payer: CommissionPayer;
  /** The node the research serves; its inbox gets the report if no session waits. */
  nodeId: string | null;
  task: string;
  budgetMicroUsd: number;
  tier: ResearchModelTier;
  /** The role commissioning, as research_runs.requested_by records it. */
  requestedBy: string;
  /** Wait for the report in this session (it pauses when the run ends its turn). */
  wait: boolean;
  /** An earlier run this one continues. */
  followUpOf?: string | null;
  /** Run it as an examination of this document in the node's map, checking these facets. */
  examine?: { sourceId: string; facets: unknown } | null;
  /** The mandate the research serves, when a Grantmaker commissions it. */
  grantId?: string | null;
  /**
   * A Grantmaker's research may submit what it finds as contributions,
   * reviewed like anyone's and paid from this budget (beside the run's own).
   */
  contributionBudgetMicroUsd?: number;
}): Promise<ResearchCommissionResult> {
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) return { ok: false, message: "A research commission needs a budget above zero." };
  let prior: ResearchRunRow | null = null;
  if (input.followUpOf) {
    prior = await getResearchRun(input.followUpOf);
    if (!prior) return { ok: false, message: `No research run ${input.followUpOf} exists to follow up.` };
    if (input.nodeId && prior.claim_id && prior.claim_id !== input.nodeId) {
      return { ok: false, message: `Research run ${input.followUpOf} served another node; follow up only runs commissioned from this one.` };
    }
  }
  const task = prior
    ? `This continues research run ${prior.id}. Its brief was:\n\n${prior.task}\n\n` +
      `It ended ${prior.status}${prior.report ? `, reporting:\n\n${JSON.stringify(prior.report).slice(0, 12000)}` : ""}.\n\n` +
      `Its notebook is open below. The follow-up asks:\n\n${input.task}`
    : input.task;
  // Validated before anything is recorded: the document must be in the
  // node's map, and the facets well formed.
  if (input.examine) {
    if (!input.nodeId) return { ok: false, message: "An examination commissioned here serves a node: there is none in scope." };
    if (input.requestedBy !== "claim_steward") {
      return {
        ok: false,
        message:
          "Only a Steward's research examines a document, for its node. To have a document reviewed for its own sake, file a request bearing on it.",
      };
    }
  }
  let examination: Awaited<ReturnType<typeof openExamination>> | null = null;
  if (input.examine) {
    try {
      examination = await openExamination({
        scope: "claim",
        trigger: "claim",
        claimId: input.nodeId,
        grantId: null,
        sourceId: input.examine.sourceId,
        brief: input.task,
        facets: input.examine.facets,
        requestedBy: input.requestedBy,
      });
    } catch (err) {
      if (err instanceof ExaminationError) return { ok: false, message: err.message };
      throw err;
    }
  }
  const ctx = getUsageContext();
  const run = await openResearchRun({
    claimId: input.nodeId,
    grantId: input.grantId ?? null,
    contributionBudgetMicroUsd: input.contributionBudgetMicroUsd ?? 0,
    requestedBy: input.requestedBy,
    requesterRunId: ctx.runId ?? null,
    jobId: ctx.jobId ?? null,
    task,
    model: modelForTier(input.tier),
    modelTier: input.tier,
    effort: input.tier === "strong" ? "high" : null,
    includeConstitution: true,
    ceilingMicroUsd: budget,
    notebook: prior ? carriedNotebook(prior) : null,
  });
  if (examination) await linkResearchRun(examination.id, run.id);
  const [action] = await rawQuery<{ id: string }>(
    `INSERT INTO actions (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('research', $1, 'standard', $2, $3, $4, $5, $6)
     RETURNING id`,
    [RESEARCH_GROUP(run.id), input.nodeId, run.id, `Research: ${input.task.slice(0, 100)}`, budget, currentLabel()]
  );
  const placed = await placeCommission({
    group: RESEARCH_GROUP(run.id),
    actionId: action!.id,
    claimId: input.nodeId,
    payer: input.payer,
    budget,
    commissionedBy: input.requestedBy,
    brief: input.task,
    reason: prior ? `A follow-up to research run ${prior.id}.` : null,
  });
  if (!placed.ok) {
    await rawQuery(`UPDATE actions SET status = 'cancelled', updated_at = now() WHERE id = $1`, [action!.id]);
    // Nothing was examined: the examination opened for it goes with it.
    if (examination) await rawQuery(`DELETE FROM examinations WHERE id = $1`, [examination.id]).catch(() => null);
    await closeResearchRun(run.id, { status: "refused", report: null, spentMicroUsd: 0, error: placed.message }).catch(() => null);
    return { ok: false, message: placed.message };
  }
  const sessionId = input.wait ? await registerAwait("research", run.id) : null;
  await rawQuery(
    `UPDATE research_runs SET reply_to_session = $2, deliver_to_node = $3 WHERE id = $1`,
    [run.id, sessionId, input.nodeId]
  );
  return { ok: true, runId: run.id, actionId: action!.id, waits: sessionId !== null };
}

/** How a research run's outcome reads where it is delivered. */
export function renderResearchReport(run: {
  id: string;
  status: string;
  spent_micro_usd: number;
  ceiling_micro_usd: number;
  report: Record<string, unknown> | null;
  notebook: Record<string, string>;
  error: string | null;
}): string {
  const owls = (m: number) => Math.round(Number(m) / 10_000) / 100;
  const head =
    `Research run ${run.id} ended ${run.status}, having spent ${owls(run.spent_micro_usd)} of its ` +
    `${owls(run.ceiling_micro_usd)} owls.`;
  const answer = typeof run.report?.answer === "string" ? run.report.answer.trim() : "";
  const rest = run.report ? JSON.stringify(run.report, null, 1) : "";
  const body = run.report
    ? `${answer ? `${answer}\n\n` : ""}The full report:\n${rest.length > 30000 ? `${rest.slice(0, 30000)}…` : rest}`
    : run.error
      ? `It did not report: ${run.error}`
      : "It did not report; its notebook is what there is.";
  const notebook = Object.keys(run.notebook ?? {});
  return (
    `${head}\n\n${body}` +
    (notebook.length ? `\n\nIts notebook has sections: ${notebook.join(", ")} (get_research_run reads them).` : "") +
    `\n\nThe report is the Researcher's account and is evidence to weigh, not a verified result: read it ` +
    `against the sources it names before relying on it. To continue this research, commission a follow-up ` +
    `(follow_up_of: ${run.id}).`
  );
}
