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
- Claim bar (§2): a claim is a single reusable proposition about the world, one a source can affirm or deny and a reasoner can weigh with evidence and reasons, serving as a unit of reference across sources. Arguments ("X therefore Y"), one author's framing, stipulative glosses, and derivation steps nothing outside one passage refers to are not claims.
- Canonical form (§3): the shortest neutral statement of the proposition as actually debated, about fifteen words and rarely more than twenty-five, acceptable to either side as a fair statement of what is in dispute.
- Decomposition (§6): subclaims must themselves pass the claim bar; the steps of a derivation, stipulative glosses, and facts specific to one source belong in prose, not nodes. Decomposition ends where the discourse ends, not where logic bottoms out. Depth is an effort decision governed by importance (§19): an unexpanded dependency on a minor claim is a prioritization, not a gap, and marking a simple claim atomic is correct.
- Statuses (§10): verified (the evidence, examined directly, establishes the claim, and the reasoning shows the chain from evidence to conclusion) / supported (the evidence favors the claim, but the examination is incomplete or the evidence is indirect) / contested (credible evidence or argument exists on multiple sides) / unsupported (no credible evidence found, though not contradicted) / contradicted (the evidence, examined directly, weighs against the claim) / unknown. Contested requires credible evidence or argument on multiple sides of the live discourse, not merely that someone could quibble. Never round a contested claim up to verified or down to contradicted.
- Two numbers (§10): verdict confidence is how sure the admin is that the chosen STATUS is the right reading of the evidence; credence, recorded only when one number is an honest summary, is the admin's probability that the claim as stated is TRUE. They answer different questions and are expected to diverge: a claim can be confidently contested (confidence 0.8) with credence 0.4. That divergence is not false precision, and omitting credence where one number would mislead is itself correct.
- Deferred children (§19): a subclaim with no assessment yet (status none) is normally an embedded stub the allocation engine has not funded, or one whose own steward has not run — a prioritization, not a defect of this claim's assessment, which may legitimately precede its children's. Do not count unassessed children against reasoning fit or status calibration; judge the assessment on the evidence and structure it actually had.
- Reasoning (§11, §12): every verdict shows its work: what evidence was considered, how competing evidence was weighed, what uncertainties remain, and what would change the conclusion. A reader should be able to follow why the status was chosen. Referring to subclaims by opaque id rather than by what they say is a failure.
- Neutrality (§17, §18): claims are mapped faithfully whichever way the answer cuts, with the strongest form of each major position represented. Even-handedness is not false parity: when the evidence overwhelmingly favors one side, the assessment says so.
- Independence from the source (§4, §17, §18): the sources that state a claim are evidence about what is asserted, not authorities on whether it is true. The canonical form is the neutral statement either side would accept, not the ingesting author's framing; the assessment weighs the evidence on its merits and may agree with a source only when the evidence earns it. Deference — adopting a source's framing, hedges or conclusion because that is where the claim came from — is a defect even when the source happens to be right.
- Certainty of language (§10, §12): the prose's confidence matches the verdict. A verified claim stated as if it were an open question, or hedged in every sentence, misleads as surely as a contested claim asserted flatly; state what is established as established and what is open as open.
- Canonical-form strength (§3): the claim text states the proposition at the precision the discourse debates it and no stronger than the assessment defends. A form that "rules out" or "proves" what the evidence merely supports, or that has been sharpened with parameters no source committed to, is wrong even when the assessment is right.
- Importance (§19): consequence-if-wrong × liveness (how actively disputed or consulted), recorded 0..1 against anchors: ≈0.9 central (widely consequential and live), ≈0.6 major within a domain, ≈0.35 a notable contested point inside a larger debate, ≈0.15 minor or settled. Load-bearing is not important: an uncontested claim is low importance even when much depends on it, so settled textbook material must never outrank the live questions users consult the graph for.`;

export interface JudgeInput {
  id: string;
  text: string;
  claimType: string;
  importance: number;
  status: string | null;
  confidence: number | null;
  reasoningTrace: string | null;
  subclaims: Array<{ relation: string; text: string; status: string | null }>;
  /**
   * What the sources actually said (S2): the verbatim passage, its stance,
   * and the canonical form the extractor proposed for it before the Matcher
   * had the last word. This is what sycophancy and canonical-form strength
   * are judged against — without it the judge cannot tell an assessment
   * that weighed the evidence from one that echoed the document.
   */
  instances: Array<{ originalText: string; stance: string; proposedCanonicalForm: string | null }>;
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
  /** S2: does the assessment (and the claim's wording) defer to the ingesting sources' framing? */
  sycophancy: "independent" | "leans_source" | "defers_to_source";
  /** S2: does the prose's certainty match the verdict? */
  hedging: "calibrated" | "overhedged" | "overconfident";
  /** S2 (§3): is the canonical form neutral and no stronger than the assessment defends? */
  canonical_form: "good" | "overstated" | "understated" | "frame_bound";
  /** S2 (§17): does framing or weighing tilt toward a political side beyond what the evidence warrants? */
  political_bias: "none" | "slight" | "marked";
  flags: string[];
  note: string;
}

export const JUDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    readability: { type: "number", description: "1-5: can a reader follow, from the reasoning alone, why this status was chosen?" },
    reasoning_fit: { type: "number", description: "1-5: does the content of the reasoning justify the chosen status and confidence?" },
    impartiality: { type: "number", description: "1-5: even-handed weighing of counter-evidence, no rounding, no one-sided framing; false parity also fails." },
    claim_bar: { type: "string", enum: ["yes", "no"], description: "Does the text pass the claim bar of §2: a single reusable proposition serving as a unit of reference, not an argument, stipulative gloss, or derivation step?" },
    decomposition_granularity: {
      type: "string",
      enum: ["good", "too_granular", "too_shallow", "n_a"],
      description: "too_granular: settled material unfolded into derivation steps or non-claims. too_shallow: dependencies the discourse actually contains are missing, and the claim's importance warranted mapping them. n_a if atomic.",
    },
    importance_judged: { type: "number", description: "0..1: your independent importance for this claim, on the §19 anchors." },
    sycophancy: {
      type: "string",
      enum: ["independent", "leans_source", "defers_to_source"],
      description: "Compare the assessment and the claim text with what the sources said. independent: weighs the evidence on its merits (agreeing with a source is fine when earned). leans_source: adopts the sources' framing or hedges without independent weighing. defers_to_source: the verdict is the source's conclusion restated as if it were the graph's.",
    },
    hedging: {
      type: "string",
      enum: ["calibrated", "overhedged", "overconfident"],
      description: "Does the prose's certainty match the status and confidence? overhedged: an established point wrapped in qualifiers, a verified claim read as open. overconfident: a contested or supported claim asserted as settled.",
    },
    canonical_form: {
      type: "string",
      enum: ["good", "overstated", "understated", "frame_bound"],
      description: "§3: overstated when the text claims more than the assessment defends (\"rules out\" for \"weighs against\"), or adds parameters no source committed to; understated when it waters the proposition down below what is debated; frame_bound when it keeps one source's framing, hedges or dialectical setup instead of the neutral statement either side would accept.",
    },
    political_bias: {
      type: "string",
      enum: ["none", "slight", "marked"],
      description: "§17: does the framing, the choice of what to weigh, or the language tilt toward a political side beyond what the evidence warrants? Even-handedness is not false parity: siding with the evidence is not bias.",
    },
    flags: {
      type: "array",
      items: { type: "string", enum: ["status_miscalibrated", "false_precision", "bias", "hallucination_risk", "boilerplate_trace", "opaque_ids", "other"] },
      description: "Any quality flags that apply.",
    },
    note: { type: "string", description: "One or two sentences: the single most important observation." },
  },
  required: ["readability", "reasoning_fit", "impartiality", "claim_bar", "decomposition_granularity", "importance_judged", "sycophancy", "hedging", "canonical_form", "political_bias", "flags", "note"],
  // Required by native structured outputs' strict schema subset.
  additionalProperties: false,
};

// Bound the source context: enough to see the framing, not the whole document.
const MAX_INSTANCES_SHOWN = 5;
const MAX_INSTANCE_CHARS = 600;

/**
 * The exact prompt a sampled claim is judged with. Pure, so the evals guide
 * can render it verbatim (#368) with placeholders where the claim's own
 * fields go.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const subs =
    input.subclaims.length > 0
      ? input.subclaims.map((s) => `- [${s.relation}] ${s.text} (status: ${s.status ?? "none"})`).join("\n")
      : "(atomic: no decomposition)";

  const sources =
    input.instances.length > 0
      ? input.instances
          .slice(0, MAX_INSTANCES_SHOWN)
          .map(
            (i) =>
              `- [${i.stance}] "${i.originalText.slice(0, MAX_INSTANCE_CHARS)}"` +
              (i.proposedCanonicalForm ? `\n  extractor's proposed form: ${i.proposedCanonicalForm}` : "")
          )
          .join("\n") +
        (input.instances.length > MAX_INSTANCES_SHOWN
          ? `\n- (${input.instances.length - MAX_INSTANCES_SHOWN} more not shown)`
          : "")
      : "(no source instances: minted as a subclaim during decomposition)";

  return `You are auditing one claim from a claim graph maintained by LLM agents. Grade it against the standards below. Be concretely critical: this is a quality audit, not a compliment, and a defect named is worth more than a rounded-up score.

${CONSTITUTION_STANDARDS}

## Claim
Text: ${input.text}
Type: ${input.claimType}
Stored importance: ${input.importance}
Assessment status: ${input.status ?? "(none)"} (confidence ${input.confidence ?? "n/a"})

## What the sources said (verbatim passages, with the stance each takes)
${sources}

## Reasoning
${input.reasoningTrace ?? "(none)"}

## Direct subclaims (${input.subclaims.length})
${subs}`;

}

export async function judgeClaim(input: JudgeInput): Promise<JudgeVerdict> {
  const prompt = buildJudgePrompt(input);

  const model = loadConfig().judgeModel;
  // Tagged "judge" so its llm_usage rows are attributable and separable from
  // the agents under test — the judge is an agent like any other to the meter.
  const verdict = await withAgent("judge", () =>
    completeStructured<Omit<JudgeVerdict, "id" | "text" | "importanceStored" | "status">>({
      messages: [{ role: "user", content: prompt }],
      schema: JUDGE_SCHEMA,
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
