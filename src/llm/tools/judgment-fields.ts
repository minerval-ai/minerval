/**
 * Field descriptions shared by the three tools that record a node's
 * judgment: update_claim_assessment, update_quantity_estimate and
 * update_question_assessment (§10). One text, so a Steward of any kind reads
 * the same meaning (#755).
 */

export const MARGINAL_YIELD_DESCRIPTION =
  "Exit judgment (0.0-1.0): how much would another, stronger pass improve " +
  "this judgment? Near 0 for an uncontested fact you have now assessed, a " +
  "value the evidence has pinned down, or a values dispute mapped down to " +
  "its terminal disagreement: more effort would not change the product. " +
  "High when this pass hit evidence it could not fully digest (an " +
  "unresolved empirical synthesis, sources you could not reach). Distinct " +
  "from confidence: a saturated inconclusive verdict can be high-confidence " +
  "AND zero-yield. Funders read it as the expected gain from another pass " +
  "(§19); omitted, it is read as 1.0. It does not affect the judgment itself.";

export const QUESTION_CONFIDENCE_DESCRIPTION =
  "Confidence (0.0-1.0): how sure you are that the standing and the " +
  "answers you favor are the right reading of the evidence, as a claim " +
  "assessment's confidence is. Not the probability that any answer is true.";
