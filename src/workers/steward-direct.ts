/**
 * Direct invocation of the Claim Steward for the money triggers
 * (docs/mathematics.md §6.4).
 *
 * The ordinary path enqueues the Steward into the claim's single pending slot,
 * where triggers coalesce and an existing trigger wins over a new one. A
 * fidelity judgment on a prize claim, a formalization review, or the
 * verdict on a solver attempt must not run as a reassessment on the standard
 * tier because a reassessment happened to be pending. So the six money
 * triggers never pass through the queue: the worker that owns the event
 * calls this function, which runs the Steward now, on the strong tier, under
 * the funding job's usage context, and returns what it cost.
 *
 * Production refuses to run a money trigger without STEWARD_STRONG_MODEL,
 * loudly, because the alternative is a prize decided by the cheap tier.
 *
 * The Steward's toolset on these triggers comes from the claim's recorded
 * domains (§3.4): a claim with no `mathematics` tag runs without
 * `decide_prize_claim`, `publish_formalization`, or `get_proof_attempt`, and
 * a money run that cannot reach its own tool is a wasted strong-model run
 * that decides nothing. So the invocation resolves the claim's skills first
 * and refuses, loudly, when the trigger's required tools are not among the
 * active skill tools; the callers already catch and record the refusal.
 */
import { loadConfig } from "../config.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { skillsForClaim } from "../llm/agents/skill-selection.js";
import { getActiveSkillToolDefinitions } from "../llm/tools/skill-tools.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";

export const MONEY_TRIGGERS = [
  "formalize",
  "formalization_review",
  "prize_claim",
  "prize_claim_voided",
  "prize_window_closed",
  "attempt_completed",
] as const;

export type MoneyTrigger = (typeof MONEY_TRIGGERS)[number];

export function isMoneyTrigger(trigger: string): trigger is MoneyTrigger {
  return (MONEY_TRIGGERS as readonly string[]).includes(trigger);
}

/**
 * The skill tools each money trigger cannot do without: the writing tool
 * the trigger exists to reach, and the reading tool it needs to reach it.
 */
export const REQUIRED_TOOLS_BY_TRIGGER: Record<MoneyTrigger, readonly string[]> = {
  formalize: ["publish_formalization"],
  formalization_review: ["publish_formalization"],
  prize_claim: ["get_prize_claim", "decide_prize_claim"],
  prize_claim_voided: ["get_prize_claim"],
  prize_window_closed: ["get_prize_claim"],
  attempt_completed: ["get_proof_attempt"],
};

export interface DirectStewardInput {
  trigger: MoneyTrigger;
  claimId: string;
  /** Short: the id of the record to fetch and one line; the Steward fetches the rest with its tools. */
  context: string;
  /** The funding job (the mandate's budget job or the prize-review reserve). */
  jobId?: string;
  userId?: string;
  /** Test and harness override; production ignores it unless it is the strong model. */
  model?: string;
}

export interface DirectStewardResult {
  model: string;
  billedMicroUsd: number;
}

/** The model a money trigger runs on, or a thrown error in production. */
export function moneyTriggerModel(trigger: MoneyTrigger, override?: string): string {
  const config = loadConfig();
  if (config.stewardStrongModel) return override ?? config.stewardStrongModel;
  if (config.env === "production") {
    throw new Error(
      `STEWARD_STRONG_MODEL is not set; the ${trigger} trigger is a money decision and ` +
        "does not run on the standard tier in production (docs/mathematics.md §6.4)"
    );
  }
  return override ?? config.stewardModel;
}

/**
 * The skill tools the claim's recorded domains activate for the Steward,
 * and the trigger's required tools that are missing from them.
 */
export async function missingTriggerTools(
  trigger: MoneyTrigger,
  claimId: string
): Promise<{ skills: string[]; active: string[]; missing: string[] }> {
  const skills = await skillsForClaim(claimId);
  const active = getActiveSkillToolDefinitions(skills, "claim-steward").map((t) => t.name);
  const missing = REQUIRED_TOOLS_BY_TRIGGER[trigger].filter((name) => !active.includes(name));
  return { skills: skills.map((s) => s.name), active, missing };
}

/**
 * Refuse a money trigger whose tools the claim's skills do not carry. The
 * error names the claim, the trigger, the recorded skills, and the remedy.
 */
export async function assertTriggerToolsActive(trigger: MoneyTrigger, claimId: string): Promise<void> {
  const { skills, missing } = await missingTriggerTools(trigger, claimId);
  if (missing.length === 0) return;
  const message =
    `refusing the ${trigger} trigger on claim ${claimId}: its recorded domains activate ` +
    `${skills.length > 0 ? `the skill(s) ${skills.join(", ")}` : "no skill"}, which carry none of ` +
    `${missing.join(", ")} for the Steward; the run would decide nothing. Tag the claim with the ` +
    "domain whose skill declares the tool (set_claim_domains) and the next invocation carries it " +
    "(docs/mathematics.md §3.4, §6.4)";
  console.error(`[steward-direct] ${message}`);
  throw new Error(message);
}

/**
 * Run the Steward on one claim for one money trigger, now, on the strong
 * tier, metered against the funding job. Never goes through enqueueSteward.
 */
export async function invokeStewardDirect(input: DirectStewardInput): Promise<DirectStewardResult> {
  if (!isMoneyTrigger(input.trigger)) {
    throw new Error(`${String(input.trigger)} is not a money trigger; use enqueueSteward`);
  }
  const model = moneyTriggerModel(input.trigger, input.model);
  await assertTriggerToolsActive(input.trigger, input.claimId);
  const { billedMicroUsd } = await runWithUsageContext(
    {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      claimId: input.claimId,
    },
    () =>
      withCostMeter(() =>
        runClaimSteward({
          trigger: input.trigger,
          claimId: input.claimId,
          context: input.context,
          model,
        })
      )
  );
  return { model, billedMicroUsd };
}
