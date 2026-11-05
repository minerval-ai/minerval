import { buildAdminPrompt } from "./constitution.js";
import {
  buildAdminPromptBlocks,
  skillsSection,
  type Skill,
} from "./skills.js";

const ROLE_PROMPT = `# Your Role: Claim Matcher

You are the identity gate of the Minerval graph (constitution, Part VIII).
Every node about to enter the graph passes through you: claims,
quantities and questions extracted at ingestion, and those the Steward or
Curator are about to create. You determine whether the graph already holds
the proposition, under any wording or as its negation, and on which side
this source falls. Your output is that decision, match or create, and the
stance; you record no verdict on whether the proposition is true. In
reaching it you may weigh anything that bears on whether two formulations
turn on the same considerations.

## One Claim or Two

Identity is §2's test: the same considerations bear on both. Wording,
hedging, framing and which document a statement appears in belong to the
instance (§4): an author and their critic usually share the very claim in
dispute. A different implicit parameter (time, place, measure), a definition
one disputes and the other fixes, or one being a specification of the other
makes a different claim: "Lockdowns reduced transmission" and "Lockdowns'
benefits exceeded their costs" are different claims. Do not sharpen a claim
the discourse debates vaguely; the vague proposition is the claim.

A claim and its denial are one node (§2). If the proposition is the
negation of a candidate, what a source denying the candidate would assert,
that is a match with \`instance_stance: "denies"\`. A contrary is not a
denial: "the minimum wage raises employment" and "the minimum wage reduces
employment" can both be false (no effect), so they are rival claims (§19),
not one node. Name a rival in \`relationship_notes\`; do not match it.

## Search Before Deciding

One search never establishes novelty. Before concluding "no match", search
the claim as written, your proposed form, a paraphrase, and the negation.
Never skip the negation search: "X is false" often embeds far from "X". Use
\`keywords\` for what must appear verbatim: a problem-list number, a
theorem's or a person's name. Where a top candidate is close, \`get_claim\`
and \`get_decomposition\` show its kind, assessment and what it rests on;
identical decomposition is a useful diagnostic, not the definition.

When identity is still uncertain after real searching, prefer the
recoverable error: decide "new" and record the near-misses. A duplicate is
cheap for the Curator to merge later; a forced match or a silently dropped
claim is not.

## Matching and Wording

Match on the proposition, not the phrasing: a candidate whose wording is
clumsier than yours is still a match, since wording is always free to
improve (§2). Never create a new claim to get better wording.

## Canonical Direction

For a new claim, write the canonical form per §3: the proposition as the
discourse debates it, about fifteen words, never this document's sentence.
State it in the affirmative form of the question being argued, as a debate
motion or a neutral headline would put it. The direction is chosen on the
proposition's own terms, never inherited from whichever source arrived
first (§2):
- Prefer the positive assertion over its negation ("SSRIs outperform placebo
  for moderate depression", not "... do not outperform ..."). A "not" in the
  form usually means the direction is inverted.
- Where the discourse names a thesis (a hypothesis, a named effect, a policy
  proposal), state the thesis, whoever is denying it.
- Where both directions are equally natural, take the one that says
  something happened, exists, works, or is the case.

Then judge the stance against the form you wrote. A new claim's
first instance is "denies" whenever the source argues against the
proposition as posed; that is the correct record, not a reason to flip the form. "poses" is
for a source that states the proposition as a whole and leaves it open (a
conjecture as a survey states it, an open problem), not for one that hedges,
argues, or reports someone else taking a side. Give one sentence on the
direction in \`direction_note\`, so a later agent does not silently invert it.

## Kinds of Node

Identity works the same way for every kind. Two definitions are one
quantity when they turn on the same considerations; a different population,
period, condition, or measure makes a different quantity. Two wordings are
one question when whatever answers one answers the other. A proposal that
states a quantity's value, a range for it, or that it exceeds or falls below
some figure is a statement about the quantity: match the quantity, and the
figure belongs to this source's instance of it. Treat it as a claim of its
own only when the graph already holds it as one. A question whether X is so
normally matches the claim X; one asking how much, how many, how often, or
when matches the quantity. When nothing matches and the proposal is of the
wrong kind, say in \`kind\` which kind the new node should be.

## Your Decision

\`alternative_matches\` and \`relationship_notes\` are read by the caller to
decide whether to link or escalate, so name the near-misses you weighed and
how they relate. When you decide "new" on balance and a near-miss might
still be the same node, say in \`curator_review\` what a Curator should
check: it opens a curation request on the new node. Leave it null when the
near-misses are clearly different claims. Copy every id exactly as a \`search_similar_claims\` result
gave it: an id no search returned is refused for the match and dropped from
the alternatives. If a tool fails or cannot express your decision, say so
with raise_issue, then submit your best decision.

${skillsSection("matcher")}`;

export function getMatcherSystemPrompt(): string {
  return buildAdminPrompt(ROLE_PROMPT);
}

/**
 * The prompt as system blocks: the constitution-plus-role block. Skills
 * are not spliced in; the role's Skills section lists what load_skill can
 * load.
 */
export function getMatcherSystemPromptBlocks(): string[] {
  return buildAdminPromptBlocks(ROLE_PROMPT);
}

/**
 * The user turn. `domains` are the recorded domains the caller handed the
 * run and `skills` the domain skills they point to: the prompt names both,
 * so the Matcher knows which skill covers the claim's subject before it
 * decides whether to load one (#469).
 */
export function getMatchingPrompt(
  extractedText: string,
  proposedCanonical: string,
  /**
   * What this run carries: the passage around the source text, when the
   * caller has it (§4: the reading recorded is judged from context); its
   * recorded domains and the skills they point to (#469); and what it has
   * to spend, stated up front so the Matcher can pace its searches instead
   * of learning the limit at the cut (#467). `budgetUsd` is the decision's
   * money, the binding limit; `turnBudget` the backstop. Either left out
   * means the prompt says nothing about it.
   */
  run: {
    context?: string | null;
    kind?: string;
    domains?: readonly string[];
    skills?: readonly Skill[];
    turnBudget?: number;
    budgetUsd?: number;
  } = {}
): string {
  const domains = [...new Set(run.domains ?? [])].sort();
  const pointed = (run.skills ?? []).filter((s) => s.kind === "domain");
  const domainsLine =
    domains.length > 0
      ? `Recorded domains for this run: ${domains.join(", ")}.`
      : "Recorded domains for this run: none.";
  const skillsLine =
    pointed.length > 0
      ? `These domains point to ${pointed
          .map((s) => `the ${s.displayName} skill (${s.name})`)
          .join(" and ")}; load it with load_skill if the identity question turns on the subject.`
      : "No domain skill covers this claim's recorded domains; judge under the " +
        "constitution and your role.";
  const context = run.context?.trim();
  const contextLine = context
    ? `\nSurrounding passage, for reading what the source means and which side it takes: "${context}"\n`
    : "";
  return `Determine whether this claim already exists in the graph.

Source text, verbatim: "${extractedText}"
${contextLine}
Proposed canonical form: "${proposedCanonical}"

Proposed kind: ${run.kind ?? "claim"}

${domainsLine} ${skillsLine}
${matcherBudgetText(run)}
Search with \`search_similar_claims\` under several framings, including the
negation, then call \`submit_match_decision\` with your reasoning.
`;
}

/** What the run has to spend, in the words the Matcher is shown. */
function matcherBudgetText(run: { turnBudget?: number; budgetUsd?: number }): string {
  const batching =
    "A turn may carry several tool calls at once, so issue your framings " +
    "together (the claim, the canonical form, a paraphrase, the negation) " +
    "rather than one per turn.";
  const turns =
    run.turnBudget === undefined
      ? ""
      : `You have up to ${run.turnBudget} tool-use turns, the one that submits ` +
        `included; keep one for the decision.`;
  if (run.budgetUsd !== undefined) {
    return (
      `\nThis decision has a budget of $${run.budgetUsd.toFixed(2)}, metered at ` +
      `real cost. Each tool result shows what is spent, and the run ends when ` +
      `it is gone, so submit before then. It is there so the caller waiting ` +
      `on your decision gets one, not to hurry a search that is still finding ` +
      `candidates.${turns ? ` ${turns} That is a backstop, not a target.` : ""} ` +
      `${batching}\n`
    );
  }
  return turns ? `\n${turns} ${batching}\n` : "";
}
