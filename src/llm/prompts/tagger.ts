/**
 * The tagger's prompt (#272).
 *
 * The tagger is an instrument, not an administrator: it labels what a claim
 * is ABOUT so readers and agents can navigate by topic. It makes no
 * epistemic judgment — nothing it writes is a verdict, a decomposition, or
 * an identity decision — so it carries neither the constitution nor a role
 * prompt, which is what lets it run on the cheapest tier over every claim.
 * The prompt is short and stable so the whole system block caches.
 */
import {
  TAG_DESCRIPTION_MAX_CHARS,
  TAG_NAME_MAX_CHARS,
} from "../../services/tag-service.js";

/** The most tags one claim carries from the tagger; the prompt states it. */
export const MAX_TAGS_PER_CLAIM = 4;

export function getTaggerSystemPrompt(): string {
  return `You label claims in a knowledge graph with topic tags. A tag names what a claim is ABOUT — a field, a subject, an entity, a question people argue over — so readers and agents can find and group claims by topic. Tags are navigation, never judgment: a tag says nothing about whether the claim is true, important, or well supported.

## What you do

For each claim you receive, attach between 1 and ${MAX_TAGS_PER_CLAIM} tags:

- Usually one BROAD tag naming the field or area (for example "Epidemiology", "Number theory", "Monetary policy", "Climate science"), and
- one to three SPECIFIC tags naming the topic or entity the claim actually turns on (for example "SARS-CoV-2 origin", "Goldbach's conjecture", "Egg consumption and cholesterol", "LHC safety").

A good tag is one that at least a handful of OTHER claims could sensibly carry. Do not restate the claim as a tag: "Eggs raise LDL cholesterol" is a claim; "Dietary cholesterol" is a tag. Do not tag the proposition kind (empirical, normative), the verdict, or the stance; those are recorded elsewhere.

## Reuse before minting

The vocabulary already exists and grows only when it must. Before proposing any new tag, call \`search_tags\` with the topic you have in mind (and once more with a differently worded version) and reuse an existing tag whenever it covers the same topic at the same grain. Prefer a well-used existing tag to an unused one; prefer an existing tag with a slightly different wording to a new one. Mint a new tag only when no existing tag fits, and then:

- Name it as a Title Case noun phrase of at most ${TAG_NAME_MAX_CHARS} characters, in the singular unless the field's name is plural ("Economics"), without articles, and without words like "claims about", "debate", "issues".
- Give it a one- or two-sentence description (at most ${TAG_DESCRIPTION_MAX_CHARS} characters) delimiting what falls under it, and where it matters what does not, written so a future tagger can decide from the description alone.

Never mint two tags for the same topic at different grains in one pass, and never mint a tag you are attaching to this one claim only if a broader existing tag fits.

## Confidence

Give each tag a confidence from 0 to 1: how sure you are that a careful librarian would file this claim under that topic. A broad field tag is usually 0.8 or above; a specific tag you had to infer from context is lower.

## Finish

When you have searched enough, call \`submit_tags\` exactly once with the final list and one sentence of reasoning. If, and only if, the claim is genuinely about nothing a tag could name (malformed, empty, pure noise), submit an empty list and say so.`;
}

export function getTaggingPrompt(input: {
  claimId: string;
  text: string;
  claimType: string;
  domains: readonly string[];
  /** Tags already on the claim from other sources (a Steward, an operator). */
  existing: Array<{ name: string; source: string }>;
}): string {
  const lines = [
    `Claim ${input.claimId}`,
    ``,
    `"${input.text}"`,
    ``,
    `Proposition kind: ${input.claimType.replace(/_/g, " ")}.`,
  ];
  if (input.domains.length > 0) {
    lines.push(
      `Domain skills active on this claim: ${input.domains.join(", ")} ` +
        `(a closed list used to select agent tooling; not itself a tag, but a hint about the field).`
    );
  }
  if (input.existing.length > 0) {
    lines.push(
      `Tags already recorded on this claim by other hands, which you should not ` +
        `duplicate but may complement: ` +
        input.existing.map((t) => `"${t.name}" (${t.source})`).join(", ") +
        `.`
    );
  }
  lines.push(
    ``,
    `Search the vocabulary, then submit the tags this claim should carry.`
  );
  return lines.join("\n");
}

/**
 * Naming a cluster of claims for the seed script (scripts/seed-tags-from-
 * clusters.ts): given exemplars near a centroid of the claim embedding space,
 * propose the one tag that best names what they share, or decline when the
 * exemplars share nothing a topic could name.
 */
export function getClusterNamingPrompt(input: {
  exemplars: string[];
  clusterSize: number;
  /** Existing tags near the centroid, so a name is not re-minted. */
  nearby: Array<{ name: string; description: string; similarity: number }>;
}): string {
  const lines = [
    `Below are ${input.exemplars.length} representative claims from a cluster of ${input.clusterSize} claims that sit close together in embedding space.`,
    ``,
    ...input.exemplars.map((e, i) => `${i + 1}. ${e}`),
    ``,
  ];
  if (input.nearby.length > 0) {
    lines.push(
      `Tags that already exist near this cluster:`,
      ...input.nearby.map(
        (t) => `- "${t.name}" (similarity ${t.similarity.toFixed(2)}): ${t.description || "(no description)"}`
      ),
      ``
    );
  }
  lines.push(
    `Propose the single topic tag that best names what these claims share, at the grain a reader browsing the graph would want: a field or a subject, not a restatement of any one claim. ` +
      `If an existing tag above already names it, return that tag's name exactly and no description. ` +
      `If the cluster is incoherent (the claims share no topic a tag could name), set coherent to false.`
  );
  return lines.join("\n");
}

export const CLUSTER_NAME_SCHEMA = {
  type: "object" as const,
  properties: {
    coherent: {
      type: "boolean",
      description: "Whether the exemplars share a topic a single tag can name",
    },
    name: {
      type: ["string", "null"],
      description: `The tag name (Title Case noun phrase, at most ${TAG_NAME_MAX_CHARS} characters), or null when not coherent`,
    },
    description: {
      type: ["string", "null"],
      description: `One or two sentences delimiting the topic (at most ${TAG_DESCRIPTION_MAX_CHARS} characters); null when reusing an existing tag or not coherent`,
    },
    reasoning: { type: "string", description: "One sentence on why this name and grain" },
  },
  required: ["coherent", "name", "description", "reasoning"],
  additionalProperties: false,
};

export interface ClusterNameProposal {
  coherent: boolean;
  name: string | null;
  description: string | null;
  reasoning: string;
}
