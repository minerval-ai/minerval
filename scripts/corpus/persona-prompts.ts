/**
 * Persona simulation (#334 S8, from #82) — the prompt and the tools, as
 * pure functions. The evals page shows every prompt an eval runs verbatim,
 * so the persona system prompt is built here from a manifest entry (the
 * same way buildJudgePrompt is vendored by scripts/evals-content.ts) and
 * the tool definitions are data. personas.ts executes them; nothing in this
 * file touches a database or a model.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { CONTRIBUTION_TYPES } from "./contributions-lib.js";
import { parseBudget, type PersonaEntry, type PersonaKind } from "./personas-lib.js";

type Tool = Anthropic.Tool;

/** The exact statement every persona is given about where it is. */
export const SIMULATION_NOTICE =
  "You are a simulated user in an isolated evaluation deployment of Minerval, a " +
  "knowledge graph of claims with transparent provenance and validity assessments. " +
  "Nothing here is production: the graph is a disposable copy built from a small " +
  "corpus, the accounts are minted for this run, no real person reads what you " +
  "write, and no money moves. You are here so the people who build Minerval can " +
  "watch how it treats someone like you. Act as the person described below would " +
  "act — including their mistakes, impatience, and blind spots — and never break " +
  "character to comment on the simulation.";

export const PERSONA_TOOL_NAMES = [
  "search_claims",
  "get_claim",
  "submit_contribution",
  "propose_claim",
  "file_finding",
] as const;
export type PersonaToolName = (typeof PERSONA_TOOL_NAMES)[number];

/** Which tools each kind of persona holds. Readers cannot contribute against a claim; programmatic clients only read and report. */
export function personaToolNames(kind: PersonaKind): PersonaToolName[] {
  switch (kind) {
    case "reader":
      return ["search_claims", "get_claim", "propose_claim", "file_finding"];
    case "programmatic":
      return ["search_claims", "get_claim", "file_finding"];
    case "contributor":
    case "adversarial":
      return ["search_claims", "get_claim", "submit_contribution", "propose_claim", "file_finding"];
  }
}

/**
 * The action tools, as the persona sees them. The two read tools come from
 * src/llm/tools/graph-read-tools.ts (the same search_claims and get_claim
 * every agent holds); these three are the persona's own.
 */
export function personaActionToolDefinitions(): Tool[] {
  return [
    {
      name: "submit_contribution",
      description:
        "Submit a contribution against an existing claim, exactly as a user of the " +
        "site would through POST /contributions. It goes to the Contribution " +
        "Reviewer; you will not see the decision during this session. Types: " +
        "challenge (you think the claim or its assessment is wrong), support (you " +
        "have evidence for it), propose_edit (a better canonical wording — give " +
        "proposed_canonical_form), propose_merge (it duplicates another claim — give " +
        "merge_target_claim_id), add_instance (somewhere this claim is stated in the " +
        "wild), propose_argument (a distinct line of reasoning for or against).",
      input_schema: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: [...CONTRIBUTION_TYPES] },
          claim_id: { type: "string", description: "The claim you are contributing against (from search_claims / get_claim)." },
          content: { type: "string", description: "What you have to say, in your own words." },
          evidence_urls: { type: "array", items: { type: "string" }, description: "Sources, if you have any. http(s) URLs." },
          proposed_canonical_form: { type: "string", description: "propose_edit only: the wording you propose." },
          merge_target_claim_id: { type: "string", description: "propose_merge only: the claim this one should merge into." },
        },
        required: ["type", "claim_id", "content"],
      },
    },
    {
      name: "propose_claim",
      description:
        "Propose a claim that is not in the graph yet, with the argument for it — " +
        "the intake path a user takes when search finds nothing. It goes to review " +
        "like any contribution; if accepted, the claim is created and assessed.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_text: { type: "string", description: "The claim, as one clear proposition." },
          argument_text: { type: "string", description: "Why you think it belongs in the graph and what supports it." },
        },
        required: ["claim_text", "argument_text"],
      },
    },
    {
      name: "file_finding",
      description:
        "Record something that got in your way: a result that made no sense, a dead " +
        "end, a claim you could not find though it should exist, an assessment you " +
        "could not follow, an error. This is not a contribution and nobody in the " +
        "graph sees it — it goes to the people who build the system. Say where you " +
        "were, what happened, and what you expected instead.",
      input_schema: {
        type: "object" as const,
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"], description: "high = you could not do what you came for; medium = you managed with difficulty; low = a rough edge." },
          where: { type: "string", description: "Which tool or claim, in a few words (e.g. 'search_claims for X', 'get_claim <id> assessment')." },
          what: { type: "string", description: "What happened." },
          expected: { type: "string", description: "What you expected instead." },
        },
        required: ["severity", "where", "what", "expected"],
      },
    },
  ];
}

function budgetSentence(entry: PersonaEntry): string {
  const b = parseBudget(entry.budget);
  const parts: string[] = [];
  parts.push(`${b.reads} read${b.reads === 1 ? "" : "s"} (search_claims or get_claim calls)`);
  if (personaToolNames(entry.kind).includes("submit_contribution")) parts.push(`${b.contributions} contribution${b.contributions === 1 ? "" : "s"}`);
  if (personaToolNames(entry.kind).includes("propose_claim")) parts.push(`${b.proposals} proposed claim${b.proposals === 1 ? "" : "s"}`);
  parts.push(`${b.findings} finding${b.findings === 1 ? "" : "s"}`);
  return parts.join(", ");
}

const TIER_WORDS: Record<string, string> = {
  fresh: "a brand-new account with no history",
  standard: "an account in ordinary good standing with a few accepted contributions behind it",
  trusted: "a long-standing account the review process has learned to trust",
};

/**
 * The persona's system prompt: the simulation notice, the manifest entry in
 * plain words, its budget, and how the tools are to be used. Everything the
 * model is told about who it is comes from the manifest entry — nothing is
 * added per run except the cluster it is pointed at and, for the second
 * half of a sockpuppet pair, what its first account already did (that note
 * is a user-turn addendum built by personas.ts, not part of this prompt).
 */
export function buildPersonaSystemPrompt(entry: PersonaEntry, opts: { cluster: string; clusterDescription?: string | null }): string {
  const tools = personaToolNames(entry.kind);
  const lines: string[] = [];
  lines.push(SIMULATION_NOTICE);
  lines.push("");
  lines.push(`## Who you are`);
  lines.push(`Name: ${entry.name}`);
  lines.push(`Kind: ${entry.kind} — ${entry.archetype}`);
  lines.push(`Standing: ${TIER_WORDS[entry.tier] ?? entry.tier}.`);
  lines.push(`Goals:`);
  for (const g of entry.goals) lines.push(`- ${g}`);
  lines.push(`Style: ${entry.style}`);
  if (entry.opening) lines.push(`What is on your mind as you arrive: ${entry.opening}`);
  if (entry.pairWith) lines.push(`You also operate the account "${entry.pairWith}"; what it did this session will be told to you.`);
  lines.push("");
  lines.push(`## Where you are`);
  lines.push(
    `The graph in front of you was built from the "${opts.cluster}" corpus` +
      (opts.clusterDescription ? `: ${opts.clusterDescription}` : ".") +
      ` It is small; a question outside it will find little or nothing, and that is a legitimate thing to notice.`
  );
  lines.push("");
  lines.push(`## Your session`);
  lines.push(`You have a budget of ${budgetSentence(entry)}. The tools refuse calls past the budget; plan for it.`);
  lines.push(`Tools available to you: ${tools.join(", ")}.`);
  lines.push(`- Start from what you came for: search, open the claims that matter, read the assessment and its reasoning.`);
  if (tools.includes("submit_contribution")) {
    lines.push(`- Contribute the way this person would — the claim you challenge, the evidence you bring, the wording you propose, the tone you take. Do not improve on the persona.`);
  }
  if (tools.includes("propose_claim")) {
    lines.push(`- If what you came for is not in the graph, you may propose it as a new claim.`);
  }
  lines.push(`- Whenever something confuses you, breaks, or dead-ends — a search that returns nothing relevant, an assessment you cannot follow, a tool error, a claim that says something you know to be garbled — call file_finding right then, in your own words, with what you expected instead. Findings are the most valuable thing you produce.`);
  lines.push(`- When you are done, or the budget is spent, stop calling tools and write a short first-person account of what you did, what you thought of it, and whether you would come back.`);
  if (entry.kind === "adversarial") {
    lines.push("");
    lines.push(
      `## A note on your role\n` +
        `You are one of the deliberately unhelpful visitors in this evaluation. Play the part fully through the tools you have — that is the point of your being here — and stay within them.`
    );
  }
  return lines.join("\n");
}

/** The first user turn: what the persona is doing right now. */
export function buildPersonaOpeningMessage(entry: PersonaEntry, addendum?: string | null): string {
  const base =
    entry.opening
      ? `You open Minerval with this on your mind: ${entry.opening}\n\nBegin.`
      : `You open Minerval. Begin.`;
  return addendum ? `${base}\n\n${addendum}` : base;
}
