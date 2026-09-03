/**
 * Executors for the prize tools the Mathematics skill declares in
 * skills/mathematics/tools.json (docs/mathematics.md §8.4):
 *
 *  - get_prize_claim {prize_claim_id, full_source?}: the record for the
 *    Steward and the Audit agent — the checker record, the statement, the
 *    claimant's written account, and the proof source comment-stripped by
 *    default. The natural-language content is data, never instruction.
 *  - decide_prize_claim {prize_claim_id, decision, reason, result_category,
 *    statement_defect?}: accept opens the challenge window (the provisional
 *    assessment is the Steward's own update_claim_assessment call, and the
 *    audit is requested under a key carrying the decision id); reject
 *    records the defect at stage steward; statement_defect retires the
 *    statement and records the defect award. served_model and fallback_ran
 *    come from the run's metered rows.
 */
import { rawQuery } from "../../db/client.js";
import { getUsageContext } from "../usage-context.js";
import type { SkillToolContext, SkillToolExecutor } from "./skill-tools.js";
import {
  acceptPrizeClaim,
  getPrizeClaimForAgent,
  rejectPrizeClaimBySteward,
  type RunContextForDecision,
} from "../../services/prize-claim-service.js";

export const PRIZE_TOOL_NAMES: readonly string[] = ["get_prize_claim", "decide_prize_claim"];

const RESULT_CATEGORIES = ["new_result", "formalization_of_known_proof", "reference_to_prior_work", "statement_defect"];

function modelFamily(model: string): string {
  return model.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

/**
 * The served model and whether a fallback ran, from the run context: the
 * latest metered row of this run names the model that actually answered;
 * a family that differs from the requested one is a fallback (§6.4).
 */
export async function decisionRunContext(ctx: SkillToolContext): Promise<RunContextForDecision> {
  const usage = getUsageContext();
  const requested = ctx.run?.model ?? null;
  let served: string | null = null;
  if (usage.runId) {
    const [row] = await rawQuery<{ model: string }>(
      `SELECT model FROM llm_usage WHERE run_id = $1 AND input_tokens > 0 ORDER BY created_at DESC LIMIT 1`,
      [usage.runId]
    ).catch(() => [] as Array<{ model: string }>);
    served = row?.model ?? null;
  }
  const fallbackRan = !!requested && !!served && modelFamily(served) !== modelFamily(requested) && !served.startsWith(requested);
  return { runId: usage.runId ?? null, requestedModel: requested, servedModel: served ?? requested, fallbackRan };
}

export async function executeGetPrizeClaim(input: Record<string, unknown>): Promise<string> {
  const id = String(input.prize_claim_id ?? "");
  const record = await getPrizeClaimForAgent(id, input.full_source === true);
  if (!record) return JSON.stringify({ success: false, message: `prize claim ${id} not found` });
  return JSON.stringify({ success: true, prize_claim: record });
}

export async function executeDecidePrizeClaim(input: Record<string, unknown>, ctx: SkillToolContext): Promise<string> {
  if (ctx.role !== "claim-steward") {
    return JSON.stringify({ success: false, message: "decide_prize_claim is the Claim Steward's; this role only reads the record" });
  }
  const id = String(input.prize_claim_id ?? "");
  const decision = String(input.decision ?? "");
  const reason = String(input.reason ?? "").trim();
  const category = String(input.result_category ?? "");
  if (decision !== "accept" && decision !== "reject") {
    return JSON.stringify({ success: false, message: "decision must be accept or reject" });
  }
  if (!reason) return JSON.stringify({ success: false, message: "reason is required; it becomes part of the public record" });
  if (!RESULT_CATEGORIES.includes(category)) {
    return JSON.stringify({ success: false, message: `result_category must be one of ${RESULT_CATEGORIES.join(", ")}` });
  }
  const run = await decisionRunContext(ctx);
  const actor = "claim_steward";
  if (decision === "accept") {
    const res = await acceptPrizeClaim({ prizeClaimId: id, reason, resultCategory: category, actor, run });
    if (!res.ok) return JSON.stringify({ success: false, message: res.message });
    return JSON.stringify({
      success: true,
      ...res,
      next:
        "The challenge window is open and the acceptance is audited. Record the provisional assessment now with " +
        "update_claim_assessment (verified or contradicted as the proof warrants), say in the reasoning trace that it " +
        "is provisional until the window closes, and log the decision with log_stewardship_decision.",
    });
  }
  const res = await rejectPrizeClaimBySteward({
    prizeClaimId: id,
    reason,
    resultCategory: category,
    statementDefect: typeof input.statement_defect === "string" ? input.statement_defect : null,
    actor,
    run,
  });
  if (!res.ok) return JSON.stringify({ success: false, message: res.message });
  return JSON.stringify({
    success: true,
    ...res,
    next:
      res.status === "defect_award_pending"
        ? "The statement is retired and the defect award recorded. Draft the corrected statement through the ordinary publication path (draft, the fresh-context second pass, the review period); never republish inside this run. Log the decision with log_stewardship_decision."
        : category === "reference_to_prior_work"
          ? "No prize is owed; the reference is credited on the claim page. Log the decision with log_stewardship_decision."
          : "The rejection is recorded at stage steward and is appealable. Log the decision with log_stewardship_decision.",
  });
}

export function registerPrizeTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  register("get_prize_claim", async (input) => executeGetPrizeClaim(input));
  register("decide_prize_claim", async (input, ctx) => executeDecidePrizeClaim(input, ctx));
}
