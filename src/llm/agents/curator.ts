/**
 * Curator agent.
 *
 * The graph-level structure agent (#31): it reconciles claim identity over time —
 * merging duplicates/counterparts the Matcher missed, splitting conflated claims,
 * and suggesting cross-claim edges to the owning Stewards. Agentic tool-use loop;
 * acts through tools, no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getCuratorSystemPrompt } from "../prompts/curator.js";
import {
  getGraphToolDefinitions,
  executeGraphTool,
} from "../tools/graph-tools.js";
import {
  getClaimContextToolDefinitions,
  executeGovernanceTool,
} from "../tools/governance-tools.js";
import {
  getMatcherToolDefinition,
  executeMatcherTool,
} from "../tools/matcher-tools.js";
import {
  getCuratorToolDefinitions,
  executeCuratorTool,
} from "../tools/curator-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runCurator(
  input: Parameters<typeof runCuratorImpl>[0]
): ReturnType<typeof runCuratorImpl> {
  return withAgent("curator", () => runCuratorImpl(input));
}

async function runCuratorImpl(input: {
  trigger: string;
  claimId: string;
  context: string;
  model?: string;
}): Promise<void> {
  const config = loadConfig();
  const model = input.model ?? config.curatorModel;

  const graphTools = getGraphToolDefinitions();
  // Claim-scoped subset only: the contribution/contributor/decision tools in
  // the full governance bundle are never referenced by the Curator's prompt.
  const claimContextTools = getClaimContextToolDefinitions();
  const curatorTools = getCuratorToolDefinitions();
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });

  const graphNames = new Set(graphTools.map((t) => t.name));
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  const tools = [
    ...graphTools,
    ...claimContextTools,
    getMatcherToolDefinition(),
    ...curatorTools,
    ...reportTools.definitions,
  ];

  const userMessage = `You have been triggered to curate the graph around a claim.

Trigger: ${input.trigger}
Anchor claim ID: ${input.claimId}
Context: ${input.context}

Proceed:
1. Use get_claim_with_context and search_similar_claims (and match_claim) to
   examine the anchor claim and its neighborhood.
2. Look for: duplicates / counterparts to MERGE; a conflated claim to SPLIT; and
   related-but-disconnected claims that should be linked.
3. For merges/splits, perform the surgery, then notify_steward the affected
   claims. For a routine edge into a claim you are not reconciling, use
   suggest_edge_to_steward (do not write it yourself).
4. Be conservative: act only when the structure is clearly wrong. Doing
   nothing is a fine outcome.`;

  await toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system: getCuratorSystemPrompt(),
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    // Backstop only; one reconciliation can take many steps. Total Curator spend
    // is bounded by curatorMaxRuns + the LLM budget tracker.
    maxIterations: 40,
    executeTool: async (name, toolInput) => {
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      if (name === "match_claim") return executeMatcherTool(name, toolInput);
      if (graphNames.has(name)) return executeGraphTool(name, toolInput);
      if (claimContextNames.has(name)) return executeGovernanceTool(name, toolInput);
      return executeCuratorTool(name, toolInput);
    },
  });
}
