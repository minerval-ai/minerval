/**
 * Curator agent.
 *
 * The graph-level structure agent (#31): it reconciles claim identity over time —
 * merging duplicates/counterparts the Matcher missed, splitting conflated claims,
 * and suggesting cross-claim edges to the owning Stewards. Agentic tool-use loop;
 * acts through tools, no structured return value.
 */
import { toolUseLoop } from "../client.js";
import { getCuratorSystemPromptBlocks } from "../prompts/curator.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { listSkills } from "../prompts/skills.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { domainsForClaim } from "./skill-selection.js";
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
  executeKindTool,
  getChangeKindToolDefinition,
  getRequestToolDefinitions,
} from "../tools/kind-tools.js";
import {
  getCuratorToolDefinitions,
  executeCuratorTool,
} from "../tools/curator-tools.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { createResearchTools } from "../tools/research-tools.js";
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import {
  GET_RESEARCH_RUN_TOOL_NAME,
  getResearchRunReadToolDefinition,
  readResearchRun,
} from "../tools/research-tools.js";
import { rawQuery } from "../../db/client.js";

// Tag every LLM call in this agent for the per-token meter (#70); the
// wrapper keeps attribution correct for any call site.
export function runCurator(
  input: Parameters<typeof runCuratorImpl>[0]
): ReturnType<typeof runCuratorImpl> {
  return withAgent("curator", () => runCuratorImpl(input));
}

async function runCuratorImpl(input: {
  trigger: string;
  /** The anchor claim; null for a run on a request the Curator keeps (#722). */
  claimId: string | null;
  /** The request the run is about, when work on one it keeps came back. */
  requestId?: string | null;
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
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });
  // The researcher, for an identity or structure call that turns on what a
  // literature does (Part VIII, Instruments), paid from this pass's budget;
  // what it finds comes back as a report and writes nothing to the graph.
  // Offered only when the pass has a budget and the researcher is enabled.
  const researchTools = createResearchTools({ requestedBy: "curator" });

  const graphNames = new Set(graphTools.map((t) => t.name));
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  // Skills load on demand; the anchor claim's recorded domains point to the
  // domain skills that cover its subject. A request-anchored run takes the
  // domains of every node the request bears on.
  const anchors = input.claimId
    ? [input.claimId]
    : input.requestId
      ? (
          await rawQuery<{ claim_id: string }>(
            `SELECT claim_id FROM request_targets WHERE request_id = $1 AND claim_id IS NOT NULL`,
            [input.requestId]
          )
        ).map((r) => r.claim_id)
      : [];
  const claimDomains = [...new Set((await Promise.all(anchors.map((c) => domainsForClaim(c)))).flat())];
  const skillLoader = createSkillLoadTools("curator", { domains: claimDomains });

  const tools = [
    ...graphTools,
    ...claimContextTools,
    getMatcherToolDefinition(),
    ...curatorTools,
    // Kinds and requests (§2, §7a, Part VIII): correcting a node's kind, and
    // keeping the requests that bear on several nodes or on none.
    getChangeKindToolDefinition(),
    ...getRequestToolDefinitions("curator"),
    // The full report of work returned on a request it keeps (#718), even
    // where the researcher is off and the research bundle offers nothing.
    ...(researchTools.definitions.some((t) => t.name === GET_RESEARCH_RUN_TOOL_NAME)
      ? []
      : [getResearchRunReadToolDefinition()]),
    ...skillLoader.definitions,
    // The tools the skills declare for this role (a price list, say), in
    // the toolset whether or not the run loads the skill.
    ...getActiveSkillToolDefinitions(listSkills(), "curator"),
    ...reportTools.definitions, ...findingTools.definitions,
    ...researchTools.definitions,
  ];

  const system = getCuratorSystemPromptBlocks();

  const CURATOR_MAX_TURNS = RUN_TURN_GUARD;
  const userMessage = input.claimId ? `You have been triggered to curate the graph around a claim.

Trigger: ${input.trigger}
Anchor claim ID: ${input.claimId}
Context: ${input.context}

Proceed:
1. Use get_claim (include related and subclaims) and search_similar_claims
   (and match_claim) to examine the anchor claim and its neighborhood; get_claim_instances shows how its
   sources state it when wording or identity turns on that.
2. Look for: duplicates / counterparts to merge; a conflated claim to split;
   related-but-disconnected claims that should be linked; a node of the wrong
   kind; and requests you keep that need sharpening, retargeting or closing
   (list_requests).
3. For merges/splits, perform the surgery, then notify_steward the affected
   claims. For a routine edge into a claim you are not reconciling, use
   suggest_edge_to_steward (do not write it yourself).
4. Be conservative: act only when the structure is clearly wrong. Doing
   nothing is a fine outcome.

${turnBudgetLine(CURATOR_MAX_TURNS)}${skillLoader.pointerNote}` : `You have been triggered to keep a request.

Trigger: ${input.trigger}
${input.context}

Proceed:
1. Read the work returned, in full where a research run holds it
   (get_research_run), and what the request bears on (get_claim).
2. Decide whether the request has been met, and act with close_request,
   revise_request or set_request_targets. Judge it by what the work
   established, not by what it was hoped to show.
3. Look for structure the work exposes as wrong only where it is plain; the
   nodes' Stewards weigh the findings for their own nodes.

${turnBudgetLine(CURATOR_MAX_TURNS)}${skillLoader.pointerNote}`;

  await withSkills([], () => toolUseLoop({
    initialMessages: [{ role: "user", content: userMessage }],
    tools,
    system,
    model,
    // Headroom, not a budget: thinking is always on for this agent tier and
    // counts against max_tokens, and toolUseLoop treats a max_tokens stop as
    // terminal — a truncated final turn loses the run's work. 16384 matches
    // the extractor's post-incident ceiling; pacing belongs to the iteration
    // budget notice, not this cap.
    maxTokens: 16384,
    // Backstop only; one reconciliation can take many steps. Total Curator spend
    // is bounded by curatorMaxRuns + the LLM budget tracker.
    maxIterations: CURATOR_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "curator" });
      if (name === GET_RESEARCH_RUN_TOOL_NAME) return readResearchRun(toolInput, { curator: true, role: "curator" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const research = await researchTools.execute(name, toolInput);
      if (research !== null) return research;
      // The Matcher receives the domains its caller knows.
      if (name === "match_claim") {
        return executeMatcherTool(name, toolInput, { domains: claimDomains });
      }
      if (graphNames.has(name)) return executeGraphTool(name, toolInput);
      if (claimContextNames.has(name)) return executeGovernanceTool(name, toolInput);
      const kindOutput = await executeKindTool(name, toolInput, { role: "curator", model });
      if (kindOutput !== null) return kindOutput;
      return executeCuratorTool(name, toolInput);
    },
  }));
}
