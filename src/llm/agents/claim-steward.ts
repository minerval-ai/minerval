/**
 * Claim Steward agent.
 *
 * Owns a claim over time: it ASSESSES the claim it stewards (there is no separate
 * Assessor — see #30), maintains its canonical form and decomposition, integrates
 * accepted contributions, and re-judges as evidence and depended-on claims change.
 * It always has web_search and may traverse the graph. Acts through tools -- no
 * structured return value.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { toolUseLoop } from "../client.js";
import { getClaimStewardSystemPrompt } from "../prompts/claim-steward.js";
import {
  getGraphToolDefinitions,
  executeGraphTool,
} from "../tools/graph-tools.js";
import {
  getClaimContextToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getStewardToolDefinitions,
  executeStewardTool,
} from "../tools/steward-tools.js";
import {
  getMatcherToolDefinition,
  executeMatcherTool,
} from "../tools/matcher-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runClaimSteward(
  input: Parameters<typeof runClaimStewardImpl>[0]
): ReturnType<typeof runClaimStewardImpl> {
  return withAgent("steward", () => runClaimStewardImpl(input));
}

async function runClaimStewardImpl(input: {
  trigger: string;
  claimId: string;
  context: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = input.model ?? config.stewardModel;

  // The steward always has web search — it may need fresh external evidence to
  // assess any claim, atomic or compound (#30).
  const webSearchTool: Anthropic.Messages.WebSearchTool20260209 = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
  };

  // Same read/navigation set the Curator gets (#69): the Steward owns a claim's
  // structure, so it must be able to read parents, subclaims, and neighbors.
  const graphTools = getGraphToolDefinitions();
  const graphNames = new Set(graphTools.map((t) => t.name));

  // Claim-scoped subset only: the contribution/contributor/decision tools in
  // the full governance bundle are never referenced by the Steward's prompt.
  const claimContextTools = getClaimContextToolDefinitions();
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  const tools = [
    ...graphTools,
    ...claimContextTools,
    ...getStewardToolDefinitions(),
    getMatcherToolDefinition(),
    webSearchTool,
  ];

  const isInitial = input.trigger === "structure_and_assess";

  const structureStep = isInitial
    ? `2. DECOMPOSE the claim (this is its first pass). Identify what it turns on:
   the dependencies that would undermine it if false, and the strongest
   considerations for and against it, each a subclaim passing the claim bar. A
   handful, not an exhaustive list (see the Decomposition guidance). For EACH
   dependency, FIRST call match_claim to check whether it already exists in the
   graph (as itself, a rewording, or its negation). If it matches, attach the
   existing claim with add_relationship_edge; only when the Matcher says it is
   novel, create it with add_decomposition_edge. Never mint a duplicate. If the
   claim is simple, leave it atomic; do not invent dependencies.`
    : `2. RE-ASSESS in light of what changed. Adjust structure only if you discover a
   missing dependency the claim turns on, and then match_claim FIRST, linking
   an existing claim with add_relationship_edge or creating a new one with
   add_decomposition_edge. Do not re-decompose from scratch.`;

  const iterationBudget = config.stewardMaxIterations;
  let newSubclaimsThisRun = 0;

  const userMessage = `You have been triggered to steward a claim.

Trigger: ${input.trigger}
Claim ID: ${input.claimId}
Context: ${input.context}

Budget: you have up to ${iterationBudget} tool-use iterations for this stewardship.
That is a generous backstop, not a target: use as few or as many as the claim's
importance warrants. But it IS a hard limit: make sure you have recorded an
assessment (update_claim_assessment) and logged your decision
(log_stewardship_decision) before you approach it, so your work is never lost
mid-task. If you are warned that few iterations remain, stop exploring and record
your conclusion immediately.

You OWN this claim: its structure (decomposition) and its assessment. Proceed:
1. Use get_claim_with_context to understand the claim, its subclaims and their
   assessments, its source instances (note each instance's affirm/deny stance),
   and its current assessment if any.
${structureStep}
3. Gauge the claim's importance: how much it is worth getting right
   (consequence-if-wrong × contestability), NOT mere dependency count.
   get_claim_dependents is only a local signal; an uncontested or niche claim is
   low importance even with many local dependents. Scale effort accordingly:
   consequential, contested claims warrant deeper search and a second, adversarial
   pass; minor or settled claims warrant a light touch.
4. Reach a holistic assessment using your judgment (no mechanical aggregation).
   Use web_search for external evidence where it would change the verdict.
   Credible instances that BOTH affirm and deny the claim are a strong signal
   toward CONTESTED.
5. Record it with update_claim_assessment. Provide BOTH texts: a reader-facing
   **assessment** (an encyclopedia-style account of where the claim stands, no
   internal machinery or bookkeeping) and the **reasoning_trace** (the audit
   detail behind the verdict). See "Writing the Assessment: Two Audiences".
6. If the canonical form needs improving, use update_canonical_form.
7. Log your decision with log_stewardship_decision.
8. If you established or changed a material assessment, use
   notify_dependent_stewards so claims that depend on this one are re-judged.`;

  await toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system: getClaimStewardSystemPrompt(),
    model,
    maxTokens: 8192,
    // A pure runaway backstop — judgment, not the iteration count, decides when
    // to stop. The Steward now decomposes AND assesses in one loop, so this is
    // set high; real spend is bounded by stewardMaxRuns + the LLM budget tracker.
    maxIterations: iterationBudget,
    iterationBudgetNotice: {
      warnWithin: 3,
      message: (remaining) =>
        `⚠ Stewardship budget notice: ${remaining} tool-use iteration(s) remain ` +
        `before you are stopped. Wrap up now: if you have not yet recorded your ` +
        `assessment with update_claim_assessment and logged it with ` +
        `log_stewardship_decision, do so on your next turn so your work is saved.`,
    },
    executeTool: async (name, toolInput) => {
      if (name === "match_claim") {
        return executeMatcherTool(name, toolInput);
      }
      if (graphNames.has(name)) {
        return executeGraphTool(name, toolInput);
      }
      if (claimContextNames.has(name)) {
        return executeGovernanceTool(name, toolInput);
      }
      // Blast-radius backstop (#157 phase 3): cap the NEW subclaims one run
      // may mint. Like the iteration cap this is a runaway guard, not a
      // target — the judgment about how far to decompose stays with the
      // Steward (and the importance brake bounds recursion). Linking
      // existing claims (add_relationship_edge) is never capped.
      if (name === "add_decomposition_edge") {
        const cap = config.stewardMaxNewSubclaimsPerRun;
        if (cap > 0 && newSubclaimsThisRun >= cap) {
          return JSON.stringify({
            success: false,
            message:
              `This run has already minted ${newSubclaimsThisRun} new subclaims, the ` +
              `per-run backstop (${cap}). Do not create more in this pass: link any ` +
              `remaining dependencies that already exist with add_relationship_edge, ` +
              `note the rest in your reasoning_trace, and proceed to your assessment. ` +
              `A future stewardship pass can continue the decomposition.`,
          });
        }
        newSubclaimsThisRun++;
      }
      return executeStewardTool(name, toolInput, {
        trigger: input.trigger,
        context: input.context,
        // Recorded on the assessment row (#294): the verdict names the model
        // that produced it. This is the same resolved id every LLM call in
        // this run uses.
        model,
      });
    },
  });
}
