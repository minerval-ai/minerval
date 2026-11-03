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
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
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
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";

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

  // The shared graph reads the Checker and the MCP surface use (#766):
  // search_claims (hybrid keyword and semantic, every kind, a tag filter),
  // get_decomposition and get_dependents. Their get_claim is left out: the
  // governance get_claim below carries what the Curator corrects (type,
  // state, kind detail, findings, Steward state). The legacy graph-tools
  // reads overlapped these and omitted a node's kind.
  const graphTools = getGraphReadToolDefinitions().filter((t) => t.name !== "get_claim");
  // Claim-scoped subset: get_claim and get_claim_instances (get_dependents
  // above replaces get_claim_dependents).
  const claimContextTools = getClaimContextToolDefinitions().filter(
    (t) => t.name !== "get_claim_dependents"
  );
  const curatorTools = getCuratorToolDefinitions();
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model });

  const graphNames = new Set(graphTools.map((t) => t.name));
  const claimContextNames = new Set(claimContextTools.map((t) => t.name));

  // Skills load on demand; the anchor claim's recorded domains point to the
  // domain skills that cover its subject.
  const claimDomains = await domainsForClaim(input.claimId);
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
    ...skillLoader.definitions,
    // The tools the skills declare for this role (a price list, say), in
    // the toolset whether or not the run loads the skill.
    ...getActiveSkillToolDefinitions(listSkills(), "curator"),
    ...reportTools.definitions, ...findingTools.definitions,
  ];

  const system = getCuratorSystemPromptBlocks();

  const CURATOR_MAX_TURNS = RUN_TURN_GUARD;
  const userMessage = `You have been triggered to curate the graph around a claim.

Trigger: ${input.trigger}
Anchor claim ID: ${input.claimId}
Context: ${input.context}

Proceed:
1. Use get_claim, search_claims and match_claim to examine the anchor and
   its neighborhood; get_claim_instances shows how its sources state it
   when wording or identity turns on that.
2. Look for: duplicates or counterparts to merge; a conflated node to split;
   related but disconnected claims to link; a node of the wrong kind, type
   or domains; an earlier operation of yours that was wrong
   (list_reconciliation_events); and requests you keep that need
   sharpening, retargeting or closing (list_requests with keeper: curator).
3. Act as your role describes. The concerns above are what this run was
   funded to answer. Merge or split only when identity is clear after real
   looking; otherwise a link, a suggestion or nothing is the recoverable
   path. Doing nothing is a fine outcome.

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
    // Backstop only; one reconciliation can take many steps. The pass
    // budget bounds the run (curatorMaxRuns caps only the unfunded
    // fallback lane).
    maxIterations: CURATOR_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "curator" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      // The Matcher receives the domains its caller knows.
      if (name === "match_claim") {
        return executeMatcherTool(name, toolInput, { domains: claimDomains });
      }
      if (graphNames.has(name)) {
        const read = await executeGraphReadTool(name, toolInput);
        if (read !== null) return read;
      }
      if (claimContextNames.has(name)) return executeGovernanceTool(name, toolInput);
      const kindOutput = await executeKindTool(name, toolInput, { role: "curator", model });
      if (kindOutput !== null) return kindOutput;
      return executeCuratorTool(name, toolInput);
    },
  }));
}
