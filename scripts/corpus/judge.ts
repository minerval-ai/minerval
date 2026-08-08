/**
 * LLM-as-judge for the corpus-run scorecard (#99).
 *
 * Grades one assessed claim against the constitution: readability of the
 * reasoning, whether it justifies the status, impartiality, the claim bar,
 * decomposition granularity, and an independent importance estimate. Runs
 * through the real LLM client so calls are metered by the budget tracker and
 * priced like any other agent call. The judge model is a separate knob
 * (`JUDGE_MODEL`, default Sonnet) so it is never the same model or context as
 * the agent under test.
 */
import { completeStructured } from "../../src/llm/client.js";
import { withAgent } from "../../src/llm/usage-context.js";
import { loadConfig } from "../../src/config.js";

// Exported for the calibration sheet (calibration.ts): the human labeler
// grades against the SAME pinned standard as the judge.
export const CONSTITUTION_STANDARDS = `Standards, from the Minerval constitution (cited by section):
- Claim bar (§2): a claim is a single reusable proposition that informed people could dispute with evidence or reasons, the kind that could anchor a long-running debate. Arguments ("X therefore Y"), one author's framing, uncontested definitions, and settled textbook or bedrock facts are not claims.
- Canonical form (§3): the shortest neutral statement of the proposition as actually debated, about fifteen words and rarely more than twenty-five, acceptable to either side as a fair statement of what is in dispute.
- Decomposition (§6): subclaims must themselves pass the claim bar; the steps of a derivation, undisputed definitions, and facts specific to one source belong in prose, not nodes. Decomposition ends where the discourse ends, not where logic bottoms out. Depth is an effort decision governed by importance (§19): an unexpanded dependency on a minor claim is a prioritization, not a gap, and marking a simple claim atomic is correct.
- Statuses (§10): verified / supported / contested / unsupported / contradicted / unknown. Contested requires credible evidence or argument on multiple sides of the live discourse, not merely that someone could quibble. Never round a contested claim up to verified or down to contradicted.
- Reasoning (§11, §12): every verdict shows its work: what evidence was considered, how competing evidence was weighed, what uncertainties remain, and what would change the conclusion. A reader should be able to follow why the status was chosen. Referring to subclaims by opaque id rather than by what they say is a failure.
- Neutrality (§17, §18): claims are mapped faithfully whichever way the answer cuts, with the strongest form of each major position represented. Even-handedness is not false parity: when the evidence overwhelmingly favors one side, the assessment says so.
- Importance (§19): consequence-if-wrong × contestability, recorded 0..1 against anchors: ≈0.9 central (widely consequential and live), ≈0.6 major within a domain, ≈0.35 a notable contested point inside a larger debate, ≈0.15 minor or settled. Load-bearing is not important: an uncontested claim is low importance even when much depends on it, so settled textbook material must never outrank the live questions users consult the graph for.`;

export interface JudgeInput {
  id: string;
  text: string;
  claimType: string;
  importance: number;
  status: string | null;
  confidence: number | null;
  reasoningTrace: string | null;
  subclaims: Array<{ relation: string; text: string; status: string | null }>;
}

export interface JudgeVerdict {
  id: string;
  text: string;
  importanceStored: number;
  status: string | null;
  readability: number;
  reasoning_fit: number;
  impartiality: number;
  claim_bar: "yes" | "no";
  decomposition_granularity: "good" | "too_granular" | "too_shallow" | "n_a";
  importance_judged: number;
  flags: string[];
  note: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    readability: { type: "number", description: "1-5: can a reader follow, from the reasoning alone, why this status was chosen?" },
    reasoning_fit: { type: "number", description: "1-5: does the content of the reasoning justify the chosen status and confidence?" },
    impartiality: { type: "number", description: "1-5: even-handed weighing of counter-evidence, no rounding, no one-sided framing; false parity also fails." },
    claim_bar: { type: "string", enum: ["yes", "no"], description: "Does the text pass the claim bar of §2: a disputable, reusable proposition, not an argument, definition, or settled textbook fact?" },
    decomposition_granularity: {
      type: "string",
      enum: ["good", "too_granular", "too_shallow", "n_a"],
      description: "too_granular: settled material unfolded into derivation steps or non-claims. too_shallow: dependencies the discourse actually contains are missing, and the claim's importance warranted mapping them. n_a if atomic.",
    },
    importance_judged: { type: "number", description: "0..1: your independent importance for this claim, on the §19 anchors." },
    flags: {
      type: "array",
      items: { type: "string", enum: ["status_miscalibrated", "false_precision", "bias", "hallucination_risk", "boilerplate_trace", "opaque_ids", "other"] },
      description: "Any quality flags that apply.",
    },
    note: { type: "string", description: "One or two sentences: the single most important observation." },
  },
  required: ["readability", "reasoning_fit", "impartiality", "claim_bar", "decomposition_granularity", "importance_judged", "flags", "note"],
  // Required by native structured outputs' strict schema subset.
  additionalProperties: false,
};

export async function judgeClaim(input: JudgeInput): Promise<JudgeVerdict> {
  const subs =
    input.subclaims.length > 0
      ? input.subclaims.map((s) => `- [${s.relation}] ${s.text} (status: ${s.status ?? "none"})`).join("\n")
      : "(atomic: no decomposition)";

  const prompt = `You are auditing one claim from a claim graph maintained by LLM agents. Grade it against the standards below. Be concretely critical: this is a quality audit, not a compliment, and a defect named is worth more than a rounded-up score.

${CONSTITUTION_STANDARDS}

## Claim
Text: ${input.text}
Type: ${input.claimType}
Stored importance: ${input.importance}
Assessment status: ${input.status ?? "(none)"} (confidence ${input.confidence ?? "n/a"})

## Reasoning
${input.reasoningTrace ?? "(none)"}

## Direct subclaims (${input.subclaims.length})
${subs}`;

  const model = loadConfig().judgeModel;
  // Tagged "judge" so its llm_usage rows are attributable and separable from
  // the agents under test — the judge is an agent like any other to the meter.
  const verdict = await withAgent("judge", () =>
    completeStructured<Omit<JudgeVerdict, "id" | "text" | "importanceStored" | "status">>({
      messages: [{ role: "user", content: prompt }],
      schema: SCHEMA,
      schemaName: "ClaimQualityVerdict",
      model,
      // Claude-5 judge models think before answering, and thinking counts against
      // max_tokens: too low a budget is spent thinking and the structured JSON
      // output is truncated. Give comfortable headroom for a small JSON verdict —
      // the cap is a backstop, not a budget.
      maxTokens: 8192,
    })
  );

  return {
    id: input.id,
    text: input.text,
    importanceStored: input.importance,
    status: input.status,
    ...verdict,
  };
}
