import type {
  ArgumentVerdict, AssessmentStatus, ClaimType, RelationType, Stance, TreeNode,
} from "./types";
import { orderByMention } from "./claim-links";

// Where each vocabulary family is defined in the narrative sources, so any
// rendered term can link the reader to the definition (#198). The constitution
// anchors are the GitHub-style slugs <Markdown> assigns its headings; the
// relation vocabulary is enumerated only in the Claim Steward's instructions,
// so it links there instead.
export const DEFINED_IN = {
  claim: "/docs/constitution#2-what-a-claim-is",
  status: "/docs/constitution#10-explicit-uncertainty",
  confidence: "/docs/constitution#10-explicit-uncertainty",
  claimType: "/docs/constitution#8-uniformity-across-claim-types",
  relation: "/docs/agents/claim-steward#decomposition",
  argument: "/docs/constitution#7-arguments",
  importance: "/docs/constitution#claim-importance-and-proportional-effort",
  effect: "/docs/constitution#6-decomposition",
} as const;

// The relation source is the steward's instructions, not the constitution;
// terms show this label next to the link so the reader knows where they land.
export const STEWARD_SOURCE = "steward instructions";

// Status metadata. Definitions are verbatim from the Admin Constitution §7 so
// the UI teaches the same vocabulary the agents reason in.
export const STATUS: Record<
  AssessmentStatus,
  { label: string; glyph: string; cls: string; def: string }
> = {
  verified: {
    label: "Verified", glyph: "✓", cls: "st-verified",
    def: "The claim traces to reliable primary sources through a clear chain of evidence.",
  },
  supported: {
    label: "Supported", glyph: "↑", cls: "st-supported",
    def: "Evidence favors the claim, but the chain is incomplete or the sources are secondary.",
  },
  contested: {
    label: "Contested", glyph: "⇄", cls: "st-contested",
    def: "Credible evidence or argument exists on multiple sides.",
  },
  unsupported: {
    label: "Unsupported", glyph: "○", cls: "st-unsupported",
    def: "No credible evidence found, though the claim is not contradicted.",
  },
  contradicted: {
    label: "Contradicted", glyph: "✕", cls: "st-contradicted",
    def: "Available evidence weighs against the claim.",
  },
  unknown: {
    label: "Unknown", glyph: "?", cls: "st-unknown",
    def: "Insufficient information to assess.",
  },
};

export const STATUS_ORDER: AssessmentStatus[] = [
  "verified", "supported", "contested", "unsupported", "contradicted", "unknown",
];

// Live data can be mid-pipeline: an assessment may exist with a null/unknown
// status. Treat anything off-enum as "unknown" so rendering never throws.
export function isStatus(s: unknown): s is AssessmentStatus {
  return typeof s === "string" && s in STATUS;
}
export function statusMeta(s: unknown) {
  return isStatus(s) ? STATUS[s] : STATUS.unknown;
}

// A claim with no current assessment is a pending state, NOT a verdict — and
// specifically not the "Unknown" verdict, which is an assessed outcome
// ("insufficient information to assess"). Surfaces that render mixed
// populations (the dependents rail, map glyphs) must use this meta for null
// statuses instead of letting statusMeta() fall through to Unknown (#160).
export const UNASSESSED_META = {
  label: "Unassessed",
  glyph: "◌",
  cls: "st-unassessed",
  def: "No current assessment. Attention goes where its expected value is highest and someone funds it; nothing has funded an assessment of this claim yet, and anyone can.",
} as const;

export function nodeStatusMeta(s: unknown) {
  return s == null ? UNASSESSED_META : statusMeta(s);
}

export const RELATION: Record<RelationType, { label: string; cls: string; gloss: string }> = {
  requires:    { label: "requires",    cls: "rel-requires",    gloss: "a load-bearing premise: the parent is false without it" },
  supports:    { label: "supports",    cls: "rel-supports",    gloss: "this provides evidence for the parent" },
  contradicts: { label: "contradicts", cls: "rel-contradicts", gloss: "this argues against the parent" },
  specifies:   { label: "specifies",   cls: "rel-specifies",   gloss: "a more specific version of the parent" },
  defines:     { label: "defines",     cls: "rel-defines",     gloss: "defines a key term in the parent" },
  assumes:     { label: "assumes",     cls: "rel-assumes",     gloss: "background the parent's framing takes as given" },
};

// Legacy alias (#205): the relation was `presupposes` until it was renamed to
// `assumes`. Rows written before the data migration lands — or served by an API
// that redeploys after the frontend — still carry the old token, so resolve it
// to the same meta rather than rendering an unlabelled edge during the race.
(RELATION as Record<string, (typeof RELATION)["assumes"]>).presupposes = RELATION.assumes;

// True for both the current `assumes` token and its legacy `presupposes` form,
// so the map's special treatment survives the same deploy race.
export function isAssumesRelation(rel: string | null | undefined): boolean {
  return rel === "assumes" || rel === "presupposes";
}

// Claim types (constitution §2 and §8: the system treats all of these
// uniformly). The two empirical variants are the pipeline's split of the
// constitution's "factual" family: checkable directly, or only by inference.
export const CLAIM_TYPE: Record<ClaimType, { label: string; gloss: string }> = {
  empirical_verifiable: {
    label: "empirical · verifiable",
    gloss: "A factual claim that could be checked directly against observation or primary records.",
  },
  empirical_derived: {
    label: "empirical · derived",
    gloss: "A factual claim that rests on inference from other evidence rather than direct observation.",
  },
  definitional: {
    label: "definitional",
    gloss: "A claim about what a term means. It earns a node only when the definition itself is disputed.",
  },
  evaluative: {
    label: "evaluative",
    gloss: "A judgment of worth or quality against some standard: good, fair, effective.",
  },
  causal: {
    label: "causal",
    gloss: "A claim that one thing brings about another, not merely that the two go together.",
  },
  normative: {
    label: "normative",
    gloss: "A claim about what should be done or how things ought to be, settled by argument rather than evidence alone.",
  },
};

export const CLAIM_TYPE_LABEL = Object.fromEntries(
  Object.entries(CLAIM_TYPE).map(([k, v]) => [k, v.label]),
) as Record<ClaimType, string>;

// Live data can carry claim types from outside the enum; render those as a
// plain label with no definition rather than throwing or guessing.
export function claimTypeMeta(t: unknown): { label: string; gloss: string } | null {
  return typeof t === "string" && t in CLAIM_TYPE ? CLAIM_TYPE[t as ClaimType] : null;
}

// The default decomposition (#204): the subclaims a claim rests on directly that
// are not (yet) gathered into a named line of reasoning (constitution §7, "a
// simple claim with one natural line of support ... no explicit grouping is
// needed"). Naming it stops the argument-less skeleton from reading as a
// mysterious unnamed argument, in both the centre tree and the left compass.
export const BASIS = {
  label: "Basis",
  gloss: "The claims this one rests on directly, not gathered into a named line of reasoning.",
} as const;

export const STANCE_LABEL: Record<Stance, string> = {
  for: "for", against: "against", neutral: "neutral",
};

// What an argument's stance says about its bearing on the claim it hangs from
// (constitution §7).
export const STANCE_GLOSS: Record<Stance, string> = {
  for: "This argument, if it holds, bears in favour of the claim.",
  against: "This argument, if it holds, weighs against the claim.",
  neutral: "This argument informs or reframes the claim without taking a side.",
};

// The steward's evaluation of a named argument (issue #173): does the
// inference go through granting its premises? Distinct from the computed net
// effect below — that mechanically rolls up premise statuses, while this is
// the steward's recorded judgment of the inference itself. The two can
// disagree, and the disagreement is itself informative.
export const ARGUMENT_VERDICT: Record<
  ArgumentVerdict,
  { label: string; cls: string; gloss: string }
> = {
  holds: {
    label: "inference holds", cls: "st-supported",
    gloss: "Granting its premises, the conclusion follows.",
  },
  holds_with_caveats: {
    label: "holds with caveats", cls: "st-contested",
    gloss: "The inference goes through only under the qualifications the evaluation states.",
  },
  fails: {
    label: "inference fails", cls: "st-contradicted",
    gloss: "The conclusion does not follow even granting the premises.",
  },
  contested: {
    label: "validity contested", cls: "st-contested",
    gloss: "Whether this argument's framework is valid is itself disputed.",
  },
};

export function isArgumentVerdict(v: unknown): v is ArgumentVerdict {
  return typeof v === "string" && v in ARGUMENT_VERDICT;
}

// Null for an unevaluated argument (render nothing, not a default verdict).
export function argumentVerdictMeta(v: unknown) {
  return isArgumentVerdict(v) ? ARGUMENT_VERDICT[v] : null;
}

export function confidenceLabel(c: number): string {
  return c.toFixed(2).replace(/^0/, "·");
}

// The two numbers an assessment can carry answer different questions
// (constitution §7); every surface that shows either must say which one it is.
export const VERDICT_CONFIDENCE_GLOSS =
  "Verdict confidence, from 0 to 1: how sure the Steward is that this status is the right reading of the evidence. Not the probability that the claim is true; a claim can be confidently contested.";
export const CREDENCE_GLOSS =
  "Credence, from 0 to 1: the Steward's probability that the claim, as stated, is true. Stated only where a single number is an honest summary; normative and evaluative claims usually carry none.";

// Decomposition status — the backend stores this as a free-text column with four
// values (pending → processing → atomic | complete). The UI must not conflate
// "atomic" (decomposed and found irreducible) with "pending" (not yet looked at).
export type DecompositionState = "atomic" | "complete" | "processing" | "pending";

export function decompositionState(status: string): DecompositionState {
  if (status === "atomic" || status === "complete") return status;
  if (status === "processing") return "processing";
  return "pending";
}

// "Atomic" claims have finished decomposition with no subclaims; both the
// terminal statuses count, since a complete decomposition that produced no
// children is, in effect, atomic.
export function isAtomic(status: string): boolean {
  return status === "atomic" || status === "complete";
}

// Has the Steward actually processed this claim? Only then can "no subclaims"
// mean "irreducible" rather than "not looked at yet". A claim is processed if it
// carries a current assessment or its steward queue state has reached "done".
export function isProcessed(opts: { assessed: boolean; stewardState?: string }): boolean {
  return opts.assessed || opts.stewardState === "done";
}

// The decomposition section's caption when there are no rendered subclaims. The
// correction this encodes: under the Steward's importance budget most low-value
// claims are left queued, so an unprocessed claim with no children is NOT atomic
// — it simply hasn't been decomposed yet and very likely still will be. We only
// call a claim atomic once it has actually been processed and found irreducible.
export function decompositionNote(opts: {
  decompositionStatus: string;
  assessed: boolean;
  stewardState?: string;
}): string {
  if (opts.stewardState === "running") {
    return "This claim is being decomposed; its subclaims are still being worked out.";
  }
  if (isProcessed(opts)) {
    return isAtomic(opts.decompositionStatus)
      ? "This claim is atomic: it bottoms out in a bedrock fact, a contested empirical question, or a value premise, and does not decompose further."
      : "This claim has been assessed but its decomposition is not yet recorded.";
  }
  return "This claim has not been assessed yet. Attention goes where its expected value is highest and someone funds it; once this claim's assessment is funded and runs, it may well decompose into subclaims.";
}

// Claim importance — how much it is worth spending scarce intelligence to get the
// claim right (roughly consequence-if-wrong × contestability), 0..1, a revisable
// judgment set by the Steward that orders its work queue. NOT mere graph
// centrality: an uncontested claim is low importance even when much depends on it,
// because getting a settled fact right is essentially free (#68). We bucket the
// continuous score into five named bands for display and keep the exact value for
// the tooltip. The default for an unjudged claim is 0.5, so a "notable" reading is
// not necessarily a deliberate judgment.
// The union keys are historical; the user-facing wording lives in `label`/`gloss`.
export type ImportanceLevel = "foundational" | "high" | "medium" | "low" | "peripheral";

export const IMPORTANCE_ORDER: ImportanceLevel[] = [
  "peripheral", "low", "medium", "high", "foundational",
];

export function importanceLevel(v: number): ImportanceLevel {
  if (v >= 0.85) return "foundational";
  if (v >= 0.65) return "high";
  if (v >= 0.45) return "medium";
  if (v >= 0.25) return "low";
  return "peripheral";
}

export const IMPORTANCE: Record<ImportanceLevel, { label: string; gloss: string }> = {
  foundational: { label: "central",  gloss: "consequential and genuinely contested: a live crux" },
  high:         { label: "major",    gloss: "real consequence within a domain, actively argued" },
  medium:       { label: "notable",  gloss: "a contested point in a live debate (also the default before judging)" },
  low:          { label: "minor",    gloss: "narrow or largely settled, cheap to get right" },
  peripheral:   { label: "settled",  gloss: "uncontested, so low even when much depends on it" },
};

// Minimum-importance bands for the browse/search filter. Each `min` is the lower
// bound of an importanceLevel() band, so e.g. "high" means "high or foundational".
// Kept in lockstep with importanceLevel()'s cut points above.
export type ImportanceFloor = "any" | "low" | "medium" | "high" | "foundational";

export const IMPORTANCE_FLOORS: { value: ImportanceFloor; label: string; short: string; min: number }[] = [
  { value: "any",          label: "Any importance", short: "Any",     min: 0 },
  { value: "low",          label: "Minor & up",     short: "Minor",   min: 0.25 },
  { value: "medium",       label: "Notable & up",   short: "Notable", min: 0.45 },
  { value: "high",         label: "Major & up",     short: "Major",   min: 0.65 },
  { value: "foundational", label: "Central",        short: "Central", min: 0.85 },
];

// URL band value → numeric floor passed to the API (0 = no constraint).
export function importanceFloorMin(value: string | undefined): number {
  return IMPORTANCE_FLOORS.find((f) => f.value === value)?.min ?? 0;
}

// Numeric floor → the band value, so a shared link round-trips back into the
// dropdown's selected option.
export function importanceFloorValue(min: number | undefined): ImportanceFloor {
  if (!min) return "any";
  let match: ImportanceFloor = "any";
  for (const f of IMPORTANCE_FLOORS) if (min >= f.min) match = f.value;
  return match;
}

// ---------------------------------------------------------------------------
// Effect on the parent claim — "what does this subclaim do to the claim above
// it", as distinct from "how verified is this subclaim". Colouring decomposition
// by a subclaim's own status is misleading: a *verified* subclaim on a
// `contradicts` edge is strong evidence AGAINST the parent, yet it would read as
// reassuring green. So we score every node by its effect on the ROOT claim,
// composing edge polarity down the tree (`contradicts` flips the sign) and
// combining it with how established the node itself is.
//
// "Unassessed" is its own state, NOT a flavour of "unsettled" (#189): a node
// the Steward has not reached yet says nothing about the claim, whereas an
// assessed-but-inconclusive node is itself a finding. Folding the two together
// biased the compass toward whichever side happened to be assessed first — a
// Supported claim whose in-favour side was still queued read as all-against.
// ---------------------------------------------------------------------------

export type Effect = "supports" | "against" | "uncertain" | "weak" | "unassessed";

export const EFFECT: Record<Effect, { label: string; cls: string; gloss: string }> = {
  supports:   { label: "in favour",  cls: "st-supported",    gloss: "established evidence that bears in favour of this claim" },
  against:    { label: "against",    cls: "st-contradicted", gloss: "established evidence that weighs against this claim" },
  uncertain:  { label: "contested",  cls: "st-contested",    gloss: "credible argument exists on more than one side" },
  weak:       { label: "unsettled",  cls: "st-unknown",      gloss: "assessed, but too unsupported or unknown to move the needle either way" },
  unassessed: { label: "unassessed", cls: "st-unassessed",   gloss: "no assessment yet, so nothing here bears on this claim either way" },
};

// Reading order for the bar/legend: favour, contested, against, unsettled,
// then the still-queued remainder. We deliberately do NOT lead with "verified"
// — the point is to stop the eye reading green-first when the green doesn't
// actually support the claim.
export const EFFECT_ORDER: Effect[] = ["supports", "uncertain", "against", "weak", "unassessed"];

// Which way a node's edge chain points, independent of any assessment: the
// direction it WOULD bear if it were established. For an unseeded unassessed
// node this is the only directional signal there is, so surfaces render it
// distinctly (hatched, lightened — a direction, never a verdict). A confident
// steward-seeded prior credence (#285) REFINES this — same unassessed state,
// same preliminary styling, but the tint now says where the seed points
// instead of merely where the edge does.
export type EffectLean = "for" | "against";

export const EFFECT_LEAN_ORDER: EffectLean[] = ["for", "against"];

export const EFFECT_LEAN: Record<EffectLean, { label: string; cls: string; gloss: string }> = {
  for: {
    label: "unassessed · edge for", cls: "st-supported",
    gloss: "Not yet assessed. Its edge points in favour of this claim: a direction, not a verdict.",
  },
  against: {
    label: "unassessed · edge against", cls: "st-contradicted",
    gloss: "Not yet assessed. Its edge points against this claim: a direction, not a verdict.",
  },
};

// ---------------------------------------------------------------------------
// Steward-seeded prior credence (#285). When a parent claim's Steward mints a
// subclaim it may seed a prior credence — its probability the subclaim is
// true — and a brief preliminary note. The subclaim STILL reads as
// unassessed: the seed never changes state, only how the unassessed node is
// tinted in scan-over-many surfaces (map, compass, tree). Only a confident
// seed colours anything; a mid-range prior is an honest "don't know yet" and
// renders exactly like an unseeded node.
// ---------------------------------------------------------------------------

export const SEED_LEANS_TRUE = 0.75;   // seed credence at/above: likely true
export const SEED_LEANS_FALSE = 0.25;  // seed credence at/below: likely false

// What a seed says about the node's OWN truth: +1 likely true, -1 likely
// false, 0 no confident signal. This is the map's tint (the map colours each
// claim by its own standing); the compass/tree compose it with edge polarity.
export function seedVerity(credence: number | null | undefined): -1 | 0 | 1 {
  if (credence == null) return 0;
  if (credence >= SEED_LEANS_TRUE) return 1;
  if (credence <= SEED_LEANS_FALSE) return -1;
  return 0;
}

// The mechanical "preliminary" label (#285): every surface that shows a seed
// says what it is, so it can never read as an assessment.
export const SEED_PRELIM_GLOSS =
  "Preliminary credence: the prior probability the parent claim's Steward gave this claim when creating it, pending this claim's own assessment. A seed, not a verdict; the claim is still unassessed.";

// Only `contradicts` reverses polarity. requires / supports / specifies /
// defines / assumes are all structurally affirmative edges (a failed
// assumption leaves the parent ill-posed, not argued-against, so it must not
// flip the sign).
function flipsPolarity(relation: string | null): boolean {
  return relation === "contradicts";
}

// sign: +1 if, walking from the root, this node ultimately bears in favour of
// the root; -1 if it bears against it. A node with no assessment scores
// "unassessed", never "weak" — pending is not a finding (#189, cf. #160's
// UNASSESSED_META for statuses).
function nodeEffect(status: string | null, sign: number): Effect {
  if (status == null) return "unassessed";
  if (status === "contested") return "uncertain";
  let truth = 0; // +1 established, -1 refuted, 0 unknown
  if (status === "verified" || status === "supported") truth = 1;
  else if (status === "contradicted") truth = -1;
  const contribution = sign * truth;
  if (contribution > 0) return "supports";
  if (contribution < 0) return "against";
  return "weak";
}

export interface ScoredNode {
  node: TreeNode;
  effect: Effect;
  // The structural direction of the node's edge chain toward the root — where
  // it would push if established. Carried for every node; it only drives
  // rendering where the effect is "unassessed".
  lean: EffectLean;
  // Where a confident steward-seeded prior says the node WOULD push the root
  // (#285): the seed's likely-truth composed with the edge chain's sign, so a
  // likely-FALSE premise on a supporting chain tints AGAINST even though its
  // edge leans for. Null when there is no seed, the seed is mid-range, or the
  // node is assessed (a real assessment supersedes any seed).
  seed: EffectLean | null;
}

function scoreNode(node: TreeNode, sign: number): ScoredNode {
  const effect = nodeEffect(node.assessment_status, sign);
  const verity = effect === "unassessed" ? seedVerity(node.seed_credence) : 0;
  return {
    node,
    effect,
    lean: sign < 0 ? "against" : "for",
    seed: verity === 0 ? null : sign * verity > 0 ? "for" : "against",
  };
}

// How an unassessed node is tinted (#285/#189): the seed's refined direction
// when a confident seed exists, the structural edge lean otherwise. Null for
// assessed nodes — their effect colours them solid.
export type UnassessedTint = "seed-for" | "seed-against" | "lean-for" | "lean-against";

export const UNASSESSED_TINT_ORDER: UnassessedTint[] = [
  "seed-for", "lean-for", "seed-against", "lean-against",
];

export const UNASSESSED_TINT: Record<
  UnassessedTint,
  { label: string; cls: string; gloss: string; seeded: boolean }
> = {
  "seed-for": {
    label: "unassessed · leans in favour", cls: "st-supported", seeded: true,
    gloss:
      "Not yet assessed, but the parent claim's Steward seeded it with a preliminary credence that would bear in favour of this claim: a hint pending its own assessment, not a verdict.",
  },
  "seed-against": {
    label: "unassessed · leans against", cls: "st-contradicted", seeded: true,
    gloss:
      "Not yet assessed, but the parent claim's Steward seeded it with a preliminary credence that would weigh against this claim: a hint pending its own assessment, not a verdict.",
  },
  "lean-for": { ...EFFECT_LEAN.for, seeded: false },
  "lean-against": { ...EFFECT_LEAN.against, seeded: false },
};

export function unassessedTintOf(s: ScoredNode): UnassessedTint | null {
  if (s.effect !== "unassessed") return null;
  return s.seed ? `seed-${s.seed}` : `lean-${s.lean}`;
}

// Flatten the decomposition (excluding the root) in outline order, tagging each
// node with its effect on the root claim.
export function decompositionEffects(root: TreeNode): ScoredNode[] {
  const out: ScoredNode[] = [];
  const walk = (node: TreeNode, sign: number) => {
    for (const child of node.children) {
      const childSign = flipsPolarity(child.relation_type) ? -sign : sign;
      out.push(scoreNode(child, childSign));
      walk(child, childSign);
    }
  };
  walk(root, 1);
  return out;
}

// The direct children only, each tagged with its effect on this claim. Surfaces
// that summarise a claim by its own top-level lines of reasoning (the compass,
// #204/#189) score these, rather than the whole recursive subtree.
export function topLevelEffects(root: TreeNode): ScoredNode[] {
  return root.children.map((child) =>
    scoreNode(child, flipsPolarity(child.relation_type) ? -1 : 1),
  );
}

export function effectCounts(scored: ScoredNode[]): Record<Effect, number> {
  const counts: Record<Effect, number> = {
    supports: 0, against: 0, uncertain: 0, weak: 0, unassessed: 0,
  };
  for (const s of scored) counts[s.effect] += 1;
  return counts;
}

// Collapse a set of effects into a single net effect for an argument: which way,
// on balance, does this line of reasoning push the main claim? A genuine split
// reads as contested; an argument with nothing established reads as unsettled;
// an argument nothing of which has been assessed reads as unassessed, so a
// still-queued line of reasoning never masquerades as an evaluated one (#189).
export function netEffect(counts: Record<Effect, number>): Effect {
  if (counts.supports > counts.against) return "supports";
  if (counts.against > counts.supports) return "against";
  if (counts.supports > 0 || counts.uncertain > 0) return "uncertain";
  if (counts.weak > 0) return "weak";
  return counts.unassessed > 0 ? "unassessed" : "weak";
}

export interface ArgumentGroup {
  id: string | null;
  name: string | null;
  stance: Stance | null;
  // The written form (issue #129): prose with [[claim:<id>]] links stating how
  // the subclaims combine. Null for the unnamed group and legacy label-only
  // arguments (render via hasClaimLinks to skip the latter).
  content: string | null;
  // The steward's evaluation (issue #173): verdict on the inference plus prose
  // naming the load-bearing premises. Null until the argument is evaluated.
  verdict: string | null;
  evaluation: string | null;
  named: boolean;
  nodes: ScoredNode[];
  counts: Record<Effect, number>;
  net: Effect;
}

// Group scored subclaims by the argument their edge belongs to, preserving
// first-appearance order. The argument primitive is OPTIONAL: nodes with no
// named argument collect into a single unnamed group, so a decomposition that
// never names an argument still renders as a flat outline.
export function groupByArgument(scored: ScoredNode[]): ArgumentGroup[] {
  const groups: ArgumentGroup[] = [];
  const byId = new Map<string | null, ArgumentGroup>();
  for (const s of scored) {
    const id = s.node.argument_name ? s.node.argument_id : null;
    let g = byId.get(id);
    if (!g) {
      g = {
        id,
        name: s.node.argument_name ?? null,
        stance: s.node.argument_stance ?? null,
        content: s.node.argument_content ?? null,
        verdict: s.node.argument_verdict ?? null,
        evaluation: s.node.argument_evaluation ?? null,
        named: Boolean(s.node.argument_name),
        nodes: [],
        counts: { supports: 0, against: 0, uncertain: 0, weak: 0, unassessed: 0 },
        net: "weak",
      };
      byId.set(id, g);
      groups.push(g);
    }
    g.nodes.push(s);
    g.counts[s.effect] += 1;
  }
  for (const g of groups) {
    g.net = netEffect(g.counts);
    // Within an argument, the written form's reading order wins (#201).
    g.nodes = orderByMention(g.nodes, (s) => s.node.id, g.content);
  }
  return groups;
}
