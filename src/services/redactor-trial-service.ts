/**
 * Trying the Redactor (docs/the-gate.md, "Trying the Redactor").
 *
 * A gate starts with a person approving what the Redactor proposes, and is
 * meant to end with the Redactor deciding alone. What gets it there is the
 * boundary's policy: its categories, and its guidelines for when the
 * Redactor asks a person. A trial is how the people who write the policy
 * see what the Redactor does under it before anything real crosses: they
 * give it a sample, under the policy in force or a draft of the next
 * version, and are shown each removal with its note, each hold, each
 * referral with what the Redactor would do, and what it was least sure of.
 *
 * Nothing in a trial is released, recorded at the gate or saved as a
 * policy. The run is the Redactor's own, with its own prompt and tools, at
 * the label the boundary's pages are written at, so it reads that label's
 * policy and destination as a real run does; its tools act on a page held
 * in memory for the length of the run. The run is on the run log like any
 * other. It is paid by the person who asks, from a budget they name, which
 * the Redactor is shown.
 */
import type { ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";
import { randomUUID } from "node:crypto";
import { toolUseLoop } from "../llm/client.js";
import { loadConfig } from "../config.js";
import { getRedactorSystemPromptBlocks } from "../llm/prompts/redactor.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../llm/prompts/turn-budget.js";
import { getRedactorToolDefinitions } from "../llm/tools/redactor-tools.js";
import { getUsageContext, runAtLabel, runWithUsageContext, withAgent, withPassBudget, withSkills } from "../llm/usage-context.js";
import { withSystemClearance } from "../db/clearance.js";
import { publishedLabel } from "../labels.js";
import { HOLD_REASONS, REFER_RECOMMENDATIONS, type HoldReason, type ReferRecommendation } from "./gate-kinds.js";
import { gateOf } from "./gate-settings-service.js";
import { chargeOwls, settleMeteredCharge } from "./owl-ledger-service.js";
import { capListOwls, microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { RemovalError, applyRemovals, locate, overlaps } from "./page-parts.js";
import {
  policyAtPageSide,
  policyProblems,
  referWhenProblems,
  renderPolicy,
  type PolicyCategory,
  type PolicyProblem,
} from "./redaction-policy.js";
import { destinationHoldings } from "./release-service.js";

/**
 * The most a sample may hold. A trial is answered while the person waits,
 * and a sample is for seeing how the Redactor reads a kind of passage, not
 * for redacting a whole document: a halting bound on what is pasted.
 */
export const TRIAL_MAX_CHARS = 20_000;

export class TrialError extends Error {
  constructor(
    public code: string,
    message: string,
    public problems?: PolicyProblem[]
  ) {
    super(message);
  }
}

interface TrialRemoval {
  id: string;
  part: number;
  start: number;
  end: number;
  category: string;
  note: string;
}

/** What the Redactor did with the sample, part by part. */
export interface TrialOutcome {
  parts: Array<{
    part: number;
    as_written: string;
    as_it_would_be_released: string;
    removals: Array<{ passage: string; category: string; note: string }>;
    held?: { reason: string; note: string };
    delayed_until?: string;
    referred?: { recommends: ReferRecommendation; in_words: string; note: string };
  }>;
  /** The whole item: held, delayed or referred, where the Redactor did that to all of it. */
  whole_item: {
    held?: { reason: string; note: string };
    delayed_until?: string;
    referred?: { recommends: ReferRecommendation; in_words: string; note: string };
  };
  least_sure: Array<{ part?: number; passage?: string; why: string }>;
  /** Whether the Redactor ended with finish_redaction. A run that did not is shown as far as it got. */
  finished: boolean;
}

/** The sample as parts: one a paragraph, split on blank lines. */
export function partsOfSample(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * A page held in memory, with the Redactor's tools acting on it as they act
 * on an item under a release (redactor-tools.ts), and nothing written
 * anywhere. Kept apart from the run so that it can be driven without a
 * model.
 */
export function trialPage(input: {
  parts: string[];
  categories: readonly PolicyCategory[];
  referWhen: readonly string[];
  policyText: string;
  basedOnVersion: number | null;
  draft: boolean;
  boundary: { from: string; to: string | null };
  destination: (text?: string) => Promise<Record<string, unknown>>;
}) {
  const removals: TrialRemoval[] = [];
  const holds = new Map<number | null, { reason: string; note: string }>();
  const delays = new Map<number | null, string>();
  const referrals = new Map<number | null, { recommends: ReferRecommendation; note: string }>();
  let leastSure: Array<{ removal_id?: string; part?: number; why: string }> = [];
  let finished = false;
  const answer = (body: Record<string, unknown>) => JSON.stringify(body);
  const refuse = (code: string, message: string) => answer({ success: false, code, message });
  const reads = (part: number) =>
    applyRemovals(
      input.parts[part - 1]!,
      removals.filter((r) => r.part === part).map((r) => ({ start: r.start, end: r.end, category: r.category }))
    ).text;
  const partOf = (raw: unknown): number | null | "bad" => {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= input.parts.length ? n : "bad";
  };

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    if (finished && name !== "get_redaction_policy" && name !== "get_page_to_redact") {
      return refuse("FINISHED", "The redaction is finished.");
    }
    switch (name) {
      case "get_redaction_policy":
        return answer({
          success: true,
          version: input.draft ? `a draft of the next version after ${input.basedOnVersion ?? 0}` : input.basedOnVersion,
          policy: input.policyText,
          category_names: input.categories.map((c) => c.name),
          refer_when: input.referWhen,
        });
      case "get_page_to_redact":
        return answer({
          success: true,
          gate:
            "This is a trial. The people who write this boundary's policy gave you a sample to see what you do under it; nothing you do " +
            "here is released or recorded at the gate. Decide exactly as you would where the gate is set to your decision.",
          boundary: { written_at: input.boundary.from, released_to: input.boundary.to ?? "outside this deployment" },
          always_released: {},
          parts: input.parts.map((text, i) => ({ part: i + 1, kind: "a paragraph of a sample", text: reads(i + 1), as_written: text })),
          removals: removals.map((r) => ({ removal_id: r.id, part: r.part, passage: input.parts[r.part - 1]!.slice(r.start, r.end), category: r.category, note: r.note })),
          sources: [],
          note: "A sample has no sources behind it to open.",
        });
      case "look_at_destination":
        return answer({ success: true, ...(await input.destination(typeof args.text === "string" ? args.text : undefined)) });
      case "redact": {
        const part = partOf(args.part);
        if (part === null || part === "bad") return refuse("NO_SUCH_PART", `This sample has parts 1 to ${input.parts.length}.`);
        const category = input.categories.find((c) => c.name === String(args.category ?? "").trim());
        if (!category) {
          return refuse(
            "NO_SUCH_CATEGORY",
            `"${String(args.category ?? "")}" is not a category of this policy. Its categories are: ${input.categories.map((c) => `"${c.name}"`).join(", ")}. A passage no category covers stays.`
          );
        }
        const note = String(args.note ?? "").trim();
        if (!note) return refuse("NOTE_NEEDED", "Say in the note why the category covers this passage.");
        let span: { start: number; end: number };
        try {
          span = locate(input.parts[part - 1]!, String(args.passage ?? ""), args.occurrence === undefined || args.occurrence === null ? undefined : Number(args.occurrence));
        } catch (err) {
          if (err instanceof RemovalError) return refuse("PASSAGE_NOT_FOUND", err.message);
          throw err;
        }
        const own = removals.filter((r) => r.part === part).map((r) => ({ start: r.start, end: r.end, category: r.category }));
        if (overlaps(own, span)) return refuse("OVERLAPS", "That passage overlaps a removal already made in this part. Take that removal back with restore first if this one should replace it.");
        const removal = { id: randomUUID(), part, ...span, category: category.name, note };
        removals.push(removal);
        return answer({ success: true, removal_id: removal.id, part_now_reads: reads(part) });
      }
      case "restore": {
        const at = removals.findIndex((r) => r.id === String(args.removal_id ?? ""));
        if (at < 0) return refuse("NO_SUCH_REMOVAL", "No removal on this sample has that id, or it was already taken back.");
        const [taken] = removals.splice(at, 1);
        return answer({ success: true, part_now_reads: reads(taken!.part) });
      }
      case "hold_part":
      case "delay_part":
      case "lift_hold":
      case "refer_to_person": {
        const part = partOf(args.part);
        if (part === "bad") return refuse("NO_SUCH_PART", `This sample has parts 1 to ${input.parts.length}.`);
        const note = String(args.note ?? "").trim();
        if (name === "hold_part") {
          const reason = String(args.reason ?? "");
          if (!(reason in HOLD_REASONS)) return refuse("BAD_REASON", `A hold gives a reason from this list: ${Object.keys(HOLD_REASONS).join(", ")}.`);
          if (!note) return refuse("NOTE_NEEDED", "Say in the note why you are holding it.");
          holds.set(part, { reason, note });
          return answer({ success: true, recorded: true, message: `${part === null ? "The whole item" : `Part ${part}`} is held. Go on with the rest and end with finish_redaction.` });
        }
        if (name === "delay_part") {
          const until = new Date(String(args.until ?? ""));
          if (Number.isNaN(until.getTime()) || until <= new Date()) return refuse("BAD_TIME", "A delay gives the time it runs until, as a date and time that has not passed.");
          delays.set(part, until.toISOString());
          return answer({ success: true, recorded: true, message: `${part === null ? "The whole item" : `Part ${part}`} is kept back until then.` });
        }
        if (name === "refer_to_person") {
          const recommends = String(args.recommends ?? "");
          if (!(recommends in REFER_RECOMMENDATIONS)) return refuse("BAD_RECOMMENDATION", `A referral says what you would do: one of ${Object.keys(REFER_RECOMMENDATIONS).join(", ")}.`);
          if (!note) return refuse("NOTE_NEEDED", "Say in the note why a person should decide this and what turns on it.");
          referrals.set(part, { recommends: recommends as ReferRecommendation, note });
          return answer({ success: true, recorded: true, message: `${part === null ? "The whole item" : `Part ${part}`} is referred to a person, with your recommendation. Go on with the rest and end with finish_redaction.` });
        }
        const lifted = holds.delete(part) || delays.delete(part);
        return answer({ success: true, recorded: lifted, message: lifted ? "Lifted." : "Nothing changed: that already stands." });
      }
      case "finish_redaction": {
        const given = Array.isArray(args.least_sure) ? (args.least_sure as Array<{ removal_id?: string; part?: number; why?: string }>) : [];
        leastSure = given.filter((l) => l && typeof l.why === "string").map((l) => ({ ...l, why: l.why! }));
        finished = true;
        return answer({ success: true, message: "The trial is finished. Nothing is released; the people who asked for it are shown what you did." });
      }
      default:
        return refuse("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }
  }

  function outcome(): TrialOutcome {
    const standing = (part: number | null) => {
      const held = holds.get(part);
      const delayed = delays.get(part);
      const referred = referrals.get(part);
      return {
        ...(held ? { held: { reason: HOLD_REASONS[held.reason as HoldReason] ?? held.reason, note: held.note } } : {}),
        ...(delayed ? { delayed_until: delayed } : {}),
        ...(referred ? { referred: { recommends: referred.recommends, in_words: REFER_RECOMMENDATIONS[referred.recommends], note: referred.note } } : {}),
      };
    };
    return {
      parts: input.parts.map((text, i) => ({
        part: i + 1,
        as_written: text,
        as_it_would_be_released: reads(i + 1),
        removals: removals.filter((r) => r.part === i + 1).sort((a, b) => a.start - b.start).map((r) => ({ passage: text.slice(r.start, r.end), category: r.category, note: r.note })),
        ...standing(i + 1),
      })),
      whole_item: standing(null),
      least_sure: leastSure.map((l) => {
        const removal = l.removal_id ? removals.find((r) => r.id === l.removal_id) : undefined;
        return {
          ...(removal ? { part: removal.part, passage: input.parts[removal.part - 1]!.slice(removal.start, removal.end) } : l.part !== undefined ? { part: l.part } : {}),
          why: l.why,
        };
      }),
      finished,
    };
  }

  return { execute, outcome };
}

/** The tools a trial offers: the Redactor's own, without the report tools a real run has for raising issues about real work. */
const trialTools = (): ToolUnion[] => getRedactorToolDefinitions();

/**
 * Run the Redactor on a sample under a boundary's policy, or a draft of the
 * next version, and say what it did. The caller has checked that the
 * person may write the boundary's policy; this charges them the budget
 * they named, and settles it to what the run cost.
 */
export async function tryTheRedactor(input: {
  boundaryId: string;
  userId: string;
  text: string;
  categories?: readonly PolicyCategory[];
  referWhen?: readonly string[];
  budgetOwls: number;
}): Promise<{
  trial_id: string;
  policy: { based_on_version: number | null; draft: boolean; text: string };
  outcome: TrialOutcome;
  spent_owls: number;
  budget_owls: number;
  run_id: string | null;
}> {
  const gate = await gateOf(input.boundaryId);
  if (!gate) throw new TrialError("GATE_NOT_FOUND", "No gate has that id.");
  const sample = input.text.trim();
  if (!sample) throw new TrialError("EMPTY_SAMPLE", "Give the Redactor something to work on: paste a passage like the ones that cross this boundary.");
  if (sample.length > TRIAL_MAX_CHARS) {
    throw new TrialError("SAMPLE_TOO_LONG", `A sample is at most ${TRIAL_MAX_CHARS.toLocaleString("en-GB")} characters: enough to see how the Redactor reads a kind of passage.`);
  }
  const ceiling = capListOwls().redactor_trial;
  if (!(input.budgetOwls > 0) || input.budgetOwls > ceiling) {
    throw new TrialError("BAD_BUDGET", `Name a budget for the trial above 0 and at most ${ceiling} owls. What the run does not spend is returned.`);
  }
  const boundary = { from: gate.from_label, to: gate.to_outside ? null : gate.to_label };
  const inForce = await withSystemClearance("A trial reads the policy in force at its boundary to start a draft from.", () => policyAtPageSide(boundary));
  const draft = input.categories !== undefined || input.referWhen !== undefined;
  const categories = (input.categories ?? inForce?.categories ?? []).map((c) => ({
    name: String(c.name ?? "").trim(),
    covers: String(c.covers ?? "").trim(),
    examples: String(c.examples ?? "").trim(),
  }));
  const referWhen = (input.referWhen ?? inForce?.refer_when ?? []).map((l) => String(l).trim()).filter(Boolean);
  const problems = [...policyProblems(categories), ...referWhenProblems(referWhen)];
  if (problems.length > 0) {
    throw new TrialError("POLICY_REFUSED", "This draft could not be saved as a version, so it is not tried either. " + problems.map((p) => `"${p.category}": ${p.problem}`).join(" "), problems);
  }
  const basedOn = inForce?.version ?? null;
  const policyText = draft || !inForce ? renderPolicy(categories, (basedOn ?? 0) + 1, referWhen) : inForce.body;

  const trialId = randomUUID();
  const capMicro = owlsToMicroUsd(input.budgetOwls);
  const charged = await chargeOwls({ userId: input.userId, priceOwls: input.budgetOwls, op: "redactor_trial", idempotencyKey: `redactor_trial:${trialId}` });
  if (!charged.charged) throw new TrialError("INSUFFICIENT_OWLS", `Your balance does not cover the ${input.budgetOwls} owls named for this trial.`);

  const page = trialPage({
    parts: partsOfSample(sample),
    categories,
    referWhen,
    policyText,
    basedOnVersion: basedOn,
    draft,
    boundary,
    destination: (text) => destinationHoldings({ destination: gate.to_label ?? publishedLabel(), pageLabel: gate.from_label, toOutside: gate.to_outside, text }),
  });
  let billed = 0;
  let runId: string | null = null;
  try {
    const run = await runAtLabel(gate.from_label, "a trial of the Redactor", () =>
      runWithUsageContext({ userId: input.userId }, () =>
        withPassBudget({ microUsd: capMicro, source: "the owls the person trying the Redactor set aside for this trial", funding: { userId: input.userId } }, () =>
          withAgent("redactor", async () => {
            runId = (getUsageContext() as { runId?: string }).runId ?? null;
            const config = loadConfig();
            await withSkills([], () =>
              toolUseLoop({
                initialMessages: [{ role: "user", content: trialTaskMessage() }],
                tools: trialTools(),
                system: getRedactorSystemPromptBlocks(),
                model: config.redactorModel || config.stewardModel,
                maxTokens: 16384,
                maxIterations: RUN_TURN_GUARD,
                onFinalTool: () => (page.outcome().finished ? { note: "The trial is finished." } : null),
                executeTool: (name, args) => page.execute(name, args),
              })
            );
          })
        )
      )
    );
    billed = run.billedMicroUsd;
  } finally {
    await settleMeteredCharge({ userId: input.userId, capMicroUsd: capMicro, meteredMicroUsd: billed, settleKey: `redactor_trial:${trialId}`, op: "redactor_trial" });
  }
  return {
    trial_id: trialId,
    policy: { based_on_version: basedOn, draft, text: policyText },
    outcome: page.outcome(),
    spent_owls: microUsdToOwls(Math.min(billed, capMicro)),
    budget_owls: input.budgetOwls,
    run_id: runId,
  };
}

/** What the Redactor is told at the start of a trial. */
export function trialTaskMessage(): string {
  return (
    `This is a trial. The people who write the policy for this boundary gave you a sample of the kind of thing that crosses it, ` +
    `to see what you do under the policy, or under a draft of its next version. Nothing you do here is released. Work exactly ` +
    `as you would on a real item where the gate is set to your decision: read the policy (get_redaction_policy) and the ` +
    `sample (get_page_to_redact), look at what the readers on the other side already hold (look_at_destination), remove what ` +
    `a category covers (redact), hold or delay what a removal cannot protect (hold_part, delay_part), ask a person to decide ` +
    `what the policy's guidelines send to one or what is a close call (refer_to_person), and end with finish_redaction, ` +
    `naming what you were least sure of. Your notes are what the people trying you read, so make each one say why.\n\n` +
    turnBudgetLine(RUN_TURN_GUARD)
  );
}
