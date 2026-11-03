/**
 * The Grantmaker agent — the granting conversation (issue: owl economy,
 * corrected model).
 *
 * Grantmaking is not a form. A funder talks their mandate through with this
 * agent the way they would delegate a project to a capable colleague in
 * plan mode: the agent surveys the graph, asks what it needs to, pushes
 * back where judgment differs, quotes expected costs in owls from the live
 * cost estimates, and either drafts a concrete mandate (propose_mandate) or
 * refuses one it must not accept (decline_mandate). Nothing runs and no owl
 * moves until the funder explicitly funds the drafted mandate
 * (grant-conversation-service.fundConversationMandate).
 *
 * The agent runs on the best available model with the full constitution as
 * Layer 1 of its prompt. Its loyalty ordering is explicit in the role
 * prompt: the integrity of the claim graph and the truth outrank the
 * funder, and ideology-warping mandates are declined outright.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { rawQuery } from "../../db/client.js";
import { loadConfig } from "../../config.js";
import { withAgent, withSkills } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { createResearchTools } from "../tools/research-tools.js";
import { createGrantContributionTools } from "../tools/grant-contribution-tools.js";
import { annotateOpenActions } from "../../services/open-actions-service.js";
import { executeKindTool, getRequestToolDefinitions } from "../tools/kind-tools.js";

const LIST_REQUESTS_TOOL = getRequestToolDefinitions("grantmaker").find((t) => t.name === "list_requests")!;
import {
  CHAT_SECTION,
  GRANTING_CONVERSATION_SECTION,
  getGrantmakerSystemPromptBlocks,
} from "../prompts/grantmaker.js";
import { listSkills } from "../prompts/skills.js";
import { modelSupportsLongRun } from "../models.js";
import { skillsForGrant } from "./skill-selection.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { createMandateTools } from "../tools/mandate-tools.js";
import { microUsdToOwls } from "../../services/owl.js";
import {
  PLAN_ITEM_SCHEMA,
  PLAN_KIND_RULES,
  normalizePlanItems,
  validatePlanItems,
  type PlanItem,
} from "../../services/grant-service.js";
import { materializePlanItems } from "../../services/action-service.js";
import { countPlanItems, describePlanItems } from "../../services/plan-state.js";
import { getMandatePipeline } from "../../services/mandate-service.js";
import {
  describePolicyKnobs,
  getMandateAllocationPolicy,
  isFormulaPolicy,
  policyKnobs,
  updateAllocationPolicy,
  type AllocationPolicy,
} from "../../services/allocation-policy-service.js";
import type { ValuationEntry } from "../../services/mandate-valuer-service.js";
import {
  getJobContributions,
  getJobSpentMicroUsd,
} from "../../services/budget-job-service.js";
import {
  requestBounty,
  openBounty,
  withdrawBounty,
  getBountyById,
  getLiveBountyForClaim,
  formatOwls,
} from "../../services/bounty-service.js";
import {
  executeLookoutManagementTool,
  getLookoutManagementToolDefinitions,
} from "../tools/lookout-management-tools.js";

export interface GrantMandate {
  /** Agent-written public title: on the mandate's page and, with the work it pays for, on claim pages. */
  title: string;
  objective: string;
  scope_claim_id?: string | null;
  scope_query?: string | null;
  plan: { strategy: string; items: PlanItem[] };
  expected_cost_owls: number;
  notes?: string;
  /**
   * The domain skills this mandate's Grantmaker carries on its review passes
   * (skill names). Selects the Grantmaker's own view and nothing else: the
   * agents that write to the graph take their skills from the claim.
   */
  skills?: string[];
  /**
   * Who funds it (docs/allocation.md, "Who funds a mandate"), asked by the
   * Grantmaker and shown on the mandate's page, never to the agents that
   * judge: whether the funder is named there, and the stake they declared
   * in its subject (null for none). Absent on mandates funded before
   * funders were asked.
   */
  funder_named?: boolean;
  funder_stake?: string | null;
  /** "deep_decomposition" for a mandate bought on one claim (claim-mandate-service.ts). */
  origin?: string;
  /** The part of the budget its Grantmaker passes may spend, when it has one. */
  grantmaker_share_owls?: number;
}

export interface GrantmakerTurnResult {
  reply: string;
  mandate?: GrantMandate;
  declined?: { reason: string };
}

// The title is a heading on the mandate's page and claim pages, and the
// stake is one line beside it: both are stated in the schema (maxLength)
// and refused past it, never cut silently (#698).
const TITLE_MAX_CHARS = 200;
const FUNDER_STAKE_MAX_CHARS = 500;

/**
 * Tool-use turns in one chat reply. Not a spending limit (funded turns
 * meter to the escrow, conversation turns are rate-limited): a person is
 * waiting on the reply, so a turn that has not answered after this many
 * steps should answer with what it has. Stated to the agent up front.
 */
const CHAT_MAX_TURNS = 16;

const MANDATE_SCHEMA = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      maxLength: TITLE_MAX_CHARS,
      description:
        "The mandate's public title, shown on its page and with the work it " +
        "pays for on claim pages: neutral and faithful, what the work is, in " +
        "words that read the same to every side of the questions it touches.",
    },
    objective: {
      type: "string",
      description:
        "One paragraph: what this mandate is for, in plain terms, as neutral " +
        "and faithful as the title.",
    },
    funder_named: {
      type: "boolean",
      description:
        "Whether the funder chose to be named on the mandate's page; false " +
        "shows them as an anonymous funder.",
    },
    funder_stake: {
      type: "string",
      maxLength: FUNDER_STAKE_MAX_CHARS,
      description:
        "The stake the funder declared in the mandate's subject, in words a " +
        "reader can weigh, or \"none\" when they declared none. Shown on the " +
        "mandate's page whether or not the funder is named.",
    },
    scope_claim_id: {
      type: "string",
      description:
        "Optional subtree root the mandate is scoped to: the id of a claim, " +
        "a quantity, or a question (a question with its subquestions is the " +
        "natural root of a programme of research).",
    },
    scope_query: {
      type: "string",
      description:
        "Optional keyword search hint for graph tooling. Not the scope: " +
        "the mandate's scope is its words, judged by you.",
    },
    plan: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          description:
            "How you read the scope and why this allocation maximizes " +
            "epistemic value per owl.",
        },
        items: {
          type: "array",
          description: "The work, in execution order. " + PLAN_KIND_RULES,
          items: PLAN_ITEM_SCHEMA,
        },
      },
      required: ["strategy", "items"],
    },
    expected_cost_owls: {
      type: "number",
      description:
        "Your honest total estimate in owls, priced from cost_sheet, " +
        "including your own passes. The funder will be asked to escrow at " +
        "least this.",
    },
    notes: {
      type: "string",
      description:
        "Anything the funder should know: uncertainties in the estimate, " +
        "what you deliberately left out, what a top-up would buy next.",
    },
    skills: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional: the skills this mandate's review passes and lookouts are " +
        "pointed to, from the catalog in your Skills section; each pass loads " +
        "them as its work needs. Only the mandate's own runs are pointed; the " +
        "claims' administrators are pointed by each claim's recorded domains, " +
        "never by the mandate.",
    },
  },
  required: ["title", "objective", "funder_named", "funder_stake", "plan", "expected_cost_owls"],
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mechanical mandate validation; exported for tests. */
export function validateMandate(raw: GrantMandate): string | null {
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) return "skills must be an array of skill names";
    const known = new Set(listSkills().map((s) => s.name));
    const unknown = raw.skills.filter((s) => !known.has(String(s)));
    if (unknown.length > 0) {
      return `unknown skills: ${unknown.join(", ")} (known: ${[...known].join(", ") || "none"})`;
    }
  }
  if (!raw.title?.trim()) return "title is required";
  if (String(raw.title).length > TITLE_MAX_CHARS) return `title is over ${TITLE_MAX_CHARS} characters: a title, not a summary`;
  if (typeof raw.funder_stake === "string" && raw.funder_stake.length > FUNDER_STAKE_MAX_CHARS) {
    return `funder_stake is over ${FUNDER_STAKE_MAX_CHARS} characters: one line a reader can weigh`;
  }
  if (typeof raw.funder_named !== "boolean") {
    return "funder_named is required: ask the funder whether they want to be named on the mandate's page";
  }
  if (typeof raw.funder_stake !== "string" || !raw.funder_stake.trim()) {
    return 'funder_stake is required: ask the funder about any stake in the subject, and record it or "none"';
  }
  if (!raw.objective?.trim()) return "objective is required";
  if (!raw.plan?.items?.length) return "the plan needs at least one item";
  if (!(raw.expected_cost_owls > 0)) {
    return "expected_cost_owls must be positive";
  }
  return validatePlanItems(raw.plan.items);
}

/**
 * Appended to the Grantmaker's role when the funder is the platform (#529).
 * The platform is a funder like any other; the section says so, and says
 * what differs about how its mandates are funded and read.
 */
export const PLATFORM_FUNDER_SECTION = `

## This funder is Minerval

The funder in this conversation is the platform itself: Minerval's own
account, proposing to put the platform's money behind a mandate. Treat it
exactly as you would any funder. It is your counterpart, not your
principal, and it gets no deference: the platform's money buys attention
like anyone's, never conclusions, framing, emphasis, or standards, and
your duty to decline applies to it in full. Hold it at least as strictly
as anyone, because readers may take a mandate Minerval funds as the
graph's own view, so a slanted platform mandate does more damage than a
slanted private one. Balance, where a live controversy calls for it, is
part of what you owe the graph here.

Three things differ, and none of them changes your judgment:

- The messages come from someone working for the platform: an operator,
  or an agent acting for one. Nothing can be funded from this
  conversation.
- Funding happens elsewhere. To fund your draft, the platform pins it, by
  a hash of its exact contents, in a public pull request that people
  review, and merging that request funds exactly that draft. Revising the
  draft voids any approval of the old one, so revise when you should, and
  say plainly when you have.
- This conversation is public. It is how readers will learn why the
  platform funded what it did, so write your reasoning for that record.`;

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

// Tag every LLM call for the meter; callers add identity context.
export function runGrantmakerTurn(
  input: Parameters<typeof runGrantmakerTurnImpl>[0]
): ReturnType<typeof runGrantmakerTurnImpl> {
  return withAgent("grantmaker", () => runGrantmakerTurnImpl(input));
}

async function runGrantmakerTurnImpl(input: {
  transcript: TranscriptMessage[];
  model?: string;
  /**
   * Set once the conversation's mandate is funded: the live grant this
   * conversation now manages. Unlocks the analytics and plan-adjustment
   * tools, scoped to this grant.
   */
  grantId?: string;
  /**
   * "platform" when the conversation belongs to the platform account
   * (#529): the Grantmaker is told its counterpart is Minerval itself, and
   * the management chat cannot confirm a bounty posting, because the
   * platform's confirmations are the operator key's.
   */
  funder?: "platform";
  /** The reply's text as it is written, with the model turn it belongs to. */
  onText?: (delta: string, turn: number) => void;
}): Promise<GrantmakerTurnResult> {
  const config = loadConfig();

  // search_claims / get_claim / get_decomposition / get_dependents come from
  // the shared graph reads (llm/tools/graph-read-tools.ts). search_claims used
  // to be hand-rolled here as a tsvector match sorted by importance; it now
  // goes through hybridSearch like every other search path, and the three
  // reads beside it were previously MCP-only.
  const graphReadTools = getGraphReadToolDefinitions();
  const proposeTool: Tool = {
    name: "propose_mandate",
    description:
      "Record the drafted mandate for the funder to fund. Call this once " +
      "the conversation has converged; then summarize the draft in your " +
      "reply and tell the funder that funding it escrows the budget.",
    input_schema: MANDATE_SCHEMA as Tool["input_schema"],
  };
  const declineTool: Tool = {
    name: "decline_mandate",
    description:
      "Refuse the mandate this conversation is asking for, because it " +
      "conflicts with the integrity of the graph or attempts to influence " +
      "its conclusions or ideology. The reason is recorded. Tell the " +
      "funder directly in your reply; the conversation may continue toward " +
      "an acceptable goal.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "A reason you would be comfortable publishing.",
        },
      },
      required: ["reason"],
    },
  };

  // Management tools, available once the mandate is funded: full
  // visibility into the live grant and near-total control of its remaining
  // plan, within the framework (never past the escrowed budget, never
  // into verdicts or importance).
  const overviewTool: Tool = {
    name: "grant_overview",
    description:
      "The live state of this conversation's funded grant: budget, metered " +
      "spend, status, contributors, the plan with each item's execution " +
      "state, the review passes' workspace and last note, any closure or " +
      "bounty they have pending, and the notes they left for the funder.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const pipelineTool: Tool = {
    name: "ingestion_report",
    description:
      "The grant's ingestion pipeline: each source brought in, extraction " +
      "status, how many claims it linked or minted, how many are assessed, " +
      "average and max importance, contested counts, and an importance " +
      "histogram per source. Use this for 'where are the claims coming " +
      "from' and source-quality questions.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const distributionTool: Tool = {
    name: "importance_distribution",
    description:
      "Importance and contestation distribution over the claims this " +
      "grant's work has touched (funded assessments plus ingested-source " +
      "claims): decile histogram, mean, and counts by assessment status. " +
      "For data-analytics questions about the mandate's yield.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  };
  const regrantTool: Tool = {
    name: "regrant",
    description:
      "Put part of this mandate's uncommitted budget behind another live " +
      "mandate. The target's unspent budget refunds back here pro rata if " +
      "it settles.",
    input_schema: {
      type: "object" as const,
      properties: {
        to_mandate_id: { type: "string" },
        owls: { type: "number" },
        note: { type: "string" },
      },
      required: ["to_mandate_id", "owls", "note"],
    },
  };
  const spawnTool: Tool = {
    name: "spawn_mandate",
    description:
      "Carve part of the mission into a new mandate with its own budget " +
      "and its own Grantmaker. It starts in planning: its agent surveys and drafts its " +
      "own plan. Use when a slice of the work deserves dedicated " +
      "stewardship, e.g. a whole ingestion program.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        owls: { type: "number" },
        note: { type: "string" },
      },
      required: ["title", "objective", "owls", "note"],
    },
  };
  const rateTool: Tool = {
    name: "set_daily_rate",
    description:
      "Set this mandate's daily allocation rate, in owls per day. The " +
      "escrow is the hard bound either way.",
    input_schema: {
      type: "object" as const,
      properties: { owls_per_day: { type: "number" } },
      required: ["owls_per_day"],
    },
  };
  const adjustTool: Tool = {
    name: "adjust_plan",
    description:
      "Replace the not-yet-executed remainder of the grant's plan with new " +
      "items (already-executed items are immutable history). Use this when " +
      "the funder and you agree the mandate's remaining budget should be " +
      "spent differently. Same item rules as propose_mandate; the same " +
      "refusal duties apply. Does not change the budget.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "The new remaining plan, in execution order. " + PLAN_KIND_RULES,
          items: PLAN_ITEM_SCHEMA,
        },
        note: {
          type: "string",
          description: "One sentence recorded with the amendment: why.",
        },
      },
      required: ["items", "note"],
    },
  };

  // The funder present in a person-funded mandate's chat may confirm a
  // posting parked at the autonomy threshold; on a platform mandate that
  // is the operator key's act.
  const bountyTools = [
    ...getBountyToolDefinitions(),
    ...(input.funder === "platform" ? [] : [getConfirmBountyToolDefinition()]),
  ];
  // The lookout tools (docs/allocation.md, "Lookouts"): standing watches
  // the mandate funds, shared with the review pass.
  const lookoutTools = getLookoutManagementToolDefinitions();

  let mandate: GrantMandate | undefined;
  let declined: { reason: string } | undefined;

  const managed = !!input.grantId;
  // Anchors the two-pass posting rule for the chat path: a request recorded
  // in an earlier turn is confirmable by a turn that started after it.
  const passStartedAt = new Date();
  const model = input.model ?? config.grantmakerModel;
  // Every agent carries the report channel (#366).
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394), the same shape without a cap.
  const findingTools = createFindingTools({ model, mandate: true });
  // Web search on every provider (tools/web-search-tool.ts): a funder who
  // says "ingest the best writing on X" is asking the Grantmaker to go and
  // find it, in the conversation as much as on a review pass.
  const webSearch = createWebSearch(model);
  // The mandate toolbox (#333): survey_scope, read_page,
  // and — once a mandate is live — its workspace, one implementation
  // shared with the planning and review passes.
  const mandateTools = createMandateTools({ grantId: input.grantId ?? null });
  // The delegation channel (#298): a survey or a check the mandate needs,
  // launched from this run and funded by it; a claim may be named per call.
  // Only a funded mandate carries it: a conversation that has not yet
  // proposed one has no budget for the researcher's spend to ride on.
  const researchTools = createResearchTools({
    requestedBy: "grantmaker",
    grantId: input.grantId ?? null,
  });
  // Contributions are paid from the escrow: a live mandate only (§19).
  const contributionTools = managed ? createGrantContributionTools(input.grantId!) : null;
  // The live mandate's policy decides which spending lever the chat holds
  // (#687): a judgment mandate revalues the ledger itself, as its review
  // passes do; a formula mandate amends the formula. Either way
  // update_allocation_policy lists exactly the knobs this mandate reads.
  const [policyRow] = managed
    ? await rawQuery<{ policy: string | null }>(
        `SELECT policy FROM grants WHERE id = $1`,
        [input.grantId]
      ).catch(() => [])
    : [];
  const mandatePolicy = policyRow?.policy ?? null;
  // What the review passes left for the funder (#701), newest last: the
  // chat is where the funder hears it.
  const [notesRow] = managed
    ? await rawQuery<{ notes: Array<{ at: string; note: string }> | null }>(
        `SELECT mandate->'funder_notes' AS notes FROM grants WHERE id = $1`,
        [input.grantId]
      ).catch(() => [])
    : [];
  const funderNotes = (notesRow?.notes ?? []).slice(-5);
  const formula = isFormulaPolicy(mandatePolicy);
  let valuationsWritten = 0;
  const tools: Tool[] = [
    ...graphReadTools,
    ...reportTools.definitions, ...findingTools.definitions,
    ...mandateTools.definitions,
    ...(managed ? researchTools.definitions : []),
    ...(contributionTools ? contributionTools.definitions : []),
    // The open requests a funded mandate's money may be able to meet
    // (fund_request); reading them commits nothing.
    ...(managed && researchTools.definitions.length > 0 ? [LIST_REQUESTS_TOOL] : []),
    ...(managed
      ? [
          overviewTool,
          pipelineTool,
          distributionTool,
          ...getManagementReadToolDefinitions(),
          ...(formula ? [] : getValuationToolDefinitions()),
          adjustTool,
          getAllocationPolicyToolDefinition(
            mandatePolicy,
            await getMandateAllocationPolicy(input.grantId!).catch(() => null)
          ),
          regrantTool,
          spawnTool,
          rateTool,
          ...bountyTools,
          ...lookoutTools,
        ]
      : [proposeTool, declineTool]),
  ];

  // Skills load on demand. A funded mandate's grants.skills points the
  // Grantmaker to the skills its work needs; a conversation with no mandate
  // yet has nothing to point to. The conversation has no task message, so
  // the pointer rides on the role block.
  const pointedSkills = input.grantId ? await skillsForGrant(input.grantId) : [];
  const skillLoader = createSkillLoadTools("grantmaker", {
    names: pointedSkills.map((s) => s.name),
  });
  const blocks = getGrantmakerSystemPromptBlocks();
  if (skillLoader.pointerNote) blocks[0] = blocks[0] + skillLoader.pointerNote;
  if (managed) {
    blocks[0] =
      blocks[0] +
      `\n\n## Management mode\n\n` +
      `This conversation's mandate is funded and live. You have full ` +
      `visibility into its execution through your grant tools and ` +
      `near-total control of the remaining plan through adjust_plan, ` +
      (formula
        ? `and of the formula its spending follows (update_allocation_policy), `
        : `and of its spending through your valuations over the open ledger ` +
          `(list_open_actions, set_valuations), as on your review passes, `) +
      `within the framework: you cannot spend past the escrowed budget, ` +
      `cannot touch verdicts or importance, and the refusal duties that ` +
      `govern new mandates govern adjustments equally. Answer data ` +
      `questions from tool results, never from memory; give real numbers. ` +
      `Discuss the technical setup as deeply as the funder wants: you can ` +
      `see the pipeline, the sources, the claims, and the spend. The ` +
      `workspace is your review passes' working memory: read it ` +
      `(grant_overview) before you write it, and prefer update_workspace's ` +
      `append or replace_section to a whole rewrite.` +
      (funderNotes.length > 0
        ? `\n\nYour review passes left these notes for the funder (newest last); raise ` +
          `them when they bear on the conversation:\n` +
          funderNotes.map((n) => `- ${n.at}: ${n.note}`).join("\n")
        : ``);
  }
  if (input.funder === "platform") {
    blocks[0] = blocks[0] + PLATFORM_FUNDER_SECTION;
  }
  // The chat's own rules (#692): the planning and review passes share the
  // role prompt but have nobody to talk to and no propose/decline tools.
  blocks[0] =
    blocks[0] +
    CHAT_SECTION +
    ` Each reply may take up to ${CHAT_MAX_TURNS} tool-use turns, because ` +
    `the funder is waiting on it; if the work needs more, answer with what ` +
    `you have and say what you would look at next.` +
    (managed ? `` : GRANTING_CONVERSATION_SECTION);
  // One cached block for the constitution and role (management mode appended
  // to it).
  const system = blocks;

  const result = await withSkills([], () => toolUseLoop({
    initialMessages: input.transcript.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: [webSearch.tool, ...tools, ...skillLoader.definitions, ...getActiveSkillToolDefinitions(listSkills(), "grantmaker")],
    system,
    model,
    // A drafted mandate is one propose_mandate call carrying the whole plan,
    // and thinking draws on the same allowance. Streamed, a turn takes the
    // model's full output: nothing here is a spending limit (conversation
    // turns are rate-limited, funded turns meter to the escrow), and the
    // turn runs in the background, so no caller is waiting on a request. A
    // model below the long-run tier keeps 16384, inside its own output limit
    // and, on a provider with no streaming path, inside the request timeout
    // (LLM_REQUEST_TIMEOUT_MS).
    stream: true,
    ...(modelSupportsLongRun(model) ? {} : { maxTokens: 16384 }),
    ...(input.onText ? { onText: input.onText } : {}),
    maxIterations: CHAT_MAX_TURNS,
    executeTool: async (name, toolInput) => {
      if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      if (isSkillTool(name)) return executeSkillTool(name, toolInput, { role: "grantmaker" });
      // The report channel first (#366): null means "not my tool".
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      if (contributionTools) {
        const contributed = await contributionTools.execute(name, toolInput);
        if (contributed !== null) return contributed;
      }
      if (managed) {
        const research = await researchTools.execute(name, toolInput);
        if (research !== null) return research;
        if (name === LIST_REQUESTS_TOOL.name) {
          return (await executeKindTool(name, toolInput, { role: "grantmaker", model }))!;
        }
      }
      // Shared graph reads first; returns null for anything it doesn't own,
      // so the mandate-specific handlers below still get their turn.
      // On a live mandate, each node a read returns carries its open actions.
      const graphRead = await executeGraphReadTool(name, toolInput);
      if (graphRead !== null) return input.grantId ? annotateOpenActions(name, graphRead, input.grantId) : graphRead;
      const mandateTool = await mandateTools.execute(name, toolInput);
      if (mandateTool !== null) return input.grantId ? annotateOpenActions(name, mandateTool, input.grantId) : mandateTool;
      if (name === "propose_mandate") {
        const raw = toolInput as unknown as GrantMandate;
        const problem = validateMandate(raw);
        if (problem) return JSON.stringify({ success: false, problem });
        mandate = {
          title: String(raw.title).trim(),
          objective: String(raw.objective),
          scope_claim_id: raw.scope_claim_id || null,
          scope_query: raw.scope_query || null,
          plan: raw.plan,
          expected_cost_owls: raw.expected_cost_owls,
          funder_named: raw.funder_named,
          funder_stake: /^none\.?$/i.test(String(raw.funder_stake).trim())
            ? null
            : String(raw.funder_stake).trim(),
          ...(raw.notes ? { notes: String(raw.notes) } : {}),
          ...(raw.skills && raw.skills.length > 0
            ? { skills: [...new Set(raw.skills.map(String))].sort() }
            : {}),
        };
        return JSON.stringify({
          success: true,
          recorded_items: mandate.plan.items.length,
        });
      }
      if (name === "decline_mandate") {
        declined = { reason: String(toolInput.reason ?? "") };
        return JSON.stringify({ success: true });
      }
      if (managed && input.grantId) {
        const out = await executeManagementTool(input.grantId, name, toolInput, {
          passStartedAt,
          // The funder in the management chat is the person who can confirm
          // a posting at or above the autonomy threshold (§8.1). On a
          // platform mandate that is the operator key's act, never the
          // conversation's: whoever holds the platform's conversation key
          // cannot open a large prize from here.
          ...(input.funder === "platform"
            ? { actor: "grantmaker:chat" }
            : { confirmedBy: "founder:management_chat" }),
        });
        if (out != null) {
          if (name === "set_valuations") valuationsWritten += writtenCount(out);
          return out;
        }
      }
      return `Unknown tool: ${name}`;
    },
  }));

  // Fund what the turn valued now, as a review pass does when it ends: the
  // allocator is idempotent, locked per mandate, and bounded by the daily
  // rate and the escrow. A failure leaves the valuations for the sweep.
  if (valuationsWritten > 0 && input.grantId) {
    const { runMandateAllocator } = await import("../../services/allocation-service.js");
    await runMandateAllocator(input.grantId).catch((err) =>
      console.error(`[grantmaker] allocation after the turn failed for ${input.grantId}: ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  const reply = (result?.content ?? "").trim();
  return {
    reply:
      reply ||
      "I recorded that. Tell me more about what you want this mandate to do.",
    ...(mandate ? { mandate } : {}),
    ...(declined ? { declined } : {}),
  };
}

/**
 * The bounty tools (docs/mathematics.md §8.1), shared by the review pass
 * and the management chat. Every bound the posting service enforces is
 * stated here with its configured value (#698): an agent is never refused
 * by a number it was not told.
 */
export function getBountyToolDefinitions(): Tool[] {
  const c = loadConfig();
  return [
    {
      name: "post_bounty",
      description:
        "Post a bounty, from this mandate's escrow, for a Lean proof or " +
        "disproof of a mathematical claim's published formal statement. " +
        "Only for mathematical claims with a published Lean statement; the " +
        "mathematics skill says when and how. Otherwise do not use. Bounds: " +
        `${c.minBountyPerClaimOwls} to ${c.maxBountyPerClaimOwls} owls per claim, one live bounty per claim, ` +
        `covered by the mandate's headroom (budget less committed money), and at most ` +
        `${c.bountyEscrowFractionPerPass} of the escrow posted in one pass and ` +
        `${c.bountyEscrowFractionPerDay} in one day. Posting is two-pass: the first call records ` +
        `the request, and a call from a later pass, within ${BOUNTY_CONFIRM_WINDOW_DAYS} days, opens it ` +
        `(after that the request is stale and starts over). At or above ` +
        `${c.bountyAutonomyThresholdOwls} owls it then waits for a person's confirmation, because a ` +
        `public reward offer binds the company.`,
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          owls: { type: "number", description: "The amount, in owls." },
          expires_in_days: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["claim_id", "owls", "rationale"],
      },
    },
    {
      name: "withdraw_bounty",
      description:
        "Give notice that a bounty is withdrawn: prospective only, with " +
        `${c.bountyNoticeDays} days' public notice on the claim page and the prize ` +
        "listing; submissions received before the effective time are judged " +
        "under the prior terms, and the withdrawal waits while any prize " +
        "claim is live. A bounty not yet open withdraws at once.",
      input_schema: {
        type: "object" as const,
        properties: {
          bounty_id: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["bounty_id", "rationale"],
      },
    },
  ];
}

/**
 * confirm_bounty, for the funder in the management chat of a mandate a
 * person funds (§8.1): a posting at or above the autonomy threshold waits
 * on a person, and the funder present in the chat is one. Not offered on
 * the review pass (nobody is there) or on a platform mandate (the
 * operator key confirms those).
 */
export function getConfirmBountyToolDefinition(): Tool {
  return {
    name: "confirm_bounty",
    description:
      "Open a bounty that waits at confirm_pending, on the funder's explicit " +
      "say-so in this conversation: ask them first, quote the amount and " +
      "the claim, and call this only when they confirm.",
    input_schema: {
      type: "object" as const,
      properties: { bounty_id: { type: "string" } },
      required: ["bounty_id"],
    },
  };
}

/**
 * The read tools both the management chat and the autonomous review pass
 * carry (#683): what the mandate's money bought (list_funded_assessments),
 * what one ingested source carries (claims_from_source), and today's
 * placements against the day's bar (allocation_report). One definition and
 * one handler (executeManagementTool), so the two paths read the same.
 */
export function getManagementReadToolDefinitions(): Tool[] {
  return [
    {
      name: "list_funded_assessments",
      description:
        "The assessments this grant has paid for so far, newest first, with " +
        "status, credence, importance, and cost attribution.",
      input_schema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            description: "Optional status filter (supported, contradicted, …).",
          },
          limit: { type: "number", description: "Max rows, default 30." },
        },
        required: [],
      },
    },
    {
      name: "claims_from_source",
      description:
        "The nodes linked to one ingested source (by the source_id the " +
        "ingestion report gives), with kind, importance, contestation, stance, " +
        "and when each was last assessed. Pages through every node the " +
        "source carries: the result gives the total and the next offset.",
      input_schema: {
        type: "object" as const,
        properties: {
          source_id: { type: "string" },
          assessed: {
            type: "string",
            enum: ["any", "assessed", "unassessed"],
            description: "Only nodes with, or without, a current assessment. Default any.",
          },
          order: {
            type: "string",
            enum: ["importance", "contestation", "recent"],
            description: "Default importance; recent is by when the node was last assessed.",
          },
          offset: { type: "number", description: "Rows to skip, default 0." },
          limit: { type: "number", description: "Rows per page, default 40, at most 100." },
        },
        required: ["source_id"],
      },
    },
    {
      name: "allocation_report",
      description:
        "This mandate's live allocation view, the same data its public " +
        "page renders: the policy in force, budget and daily rate, today's " +
        "placements and the day's emergent value-per-owl bar, per-kind " +
        "action tiles (candidates / valued / covered), and the mandate's " +
        "best-ranked open actions with backing and marginal upgrade ratios. " +
        "Use this for 'where is the money going and why' questions.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            description:
              "Optional drill-down filter: assess, reassess, ingest, or " +
              "grant_planning.",
          },
          limit: { type: "number", description: "Max ranked rows, default 10." },
        },
        required: [],
      },
    },
  ];
}

/**
 * The judgment mandate's spending lever (#687): list_open_actions and
 * set_valuations, shared by the review pass and the management chat. A
 * formula mandate (isFormulaPolicy) is not offered them: its bulk refresh
 * upserts the same (grant, action) rows, so a hand-written valuation would
 * last only until the next refresh.
 */
export function getValuationToolDefinitions(): Tool[] {
  return [
    {
      name: "list_open_actions",
      description:
        "The open action ledger from your mandate's point of view: each " +
        "row's cost, what its funders have put on it, the gap left to fund, " +
        "and your valuation if you hold one, with the node it is on (kind, " +
        "text, tags, importance, contestation, days since assessed), its " +
        "alternatives (at most one of a set runs), and for a curate or " +
        "request row what it is about. Filter by territory (query by " +
        "meaning, tag, within a node's subtree, node kind, assessment " +
        "state) and by money (unfunded only, a cost ceiling, valued by you " +
        "or not); page with offset. The graph reads you make also carry " +
        "each node's open actions. An audit row whose subject is your own " +
        "mandate is never yours to fund.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "By meaning and keyword, over the nodes' text and the rows' labels." },
          tag: { type: "string", description: "A topic tag's slug, as graph reads return it." },
          within: { type: "string", description: "A node id: actions on it and the nodes beneath it." },
          within_depth: { type: "number", description: "Levels beneath `within`, default 3, at most 6." },
          kind: {
            type: "string",
            enum: [
              "assess",
              "reassess",
              "ingest",
              "grant_planning",
              "formalize",
              "attempt_proof",
              "prize_review",
              "curate",
              "audit",
              "request",
            ],
          },
          node_kind: { type: "string", enum: ["claim", "quantity", "question"] },
          assessed: { type: "string", enum: ["any", "assessed", "unassessed"] },
          unfunded_only: { type: "boolean", description: "Only rows whose backing does not yet cover their cost." },
          max_cost_owls: { type: "number" },
          valued: { type: "string", enum: ["any", "mine", "not_mine"], description: "Rows you have valued, or have not." },
          order: {
            type: "string",
            enum: ["relevance", "my_value", "value_per_owl", "gap", "importance", "contestation", "stale"],
            description: "Default relevance with a query, my_value without.",
          },
          offset: { type: "number" },
          limit: { type: "number", description: "Default 25, at most 50." },
        },
        required: [],
      },
    },
    {
      name: "set_valuations",
      description:
        "Write your mandate's valuations: for each action you judge " +
        "relevant, a value 0-10 (how much the action is worth to your " +
        "mandate's mission) and a one-line rationale. Sparse by design: " +
        "value only what you know and care about; actions you skip simply " +
        "carry no opinion from you. Your allocator funds the best marginal " +
        "value per owl among these, within your daily rate and escrow: on " +
        "a review pass as soon as the pass ends, in the chat at the end of " +
        "the turn. An action whose remaining cost is more than what is left " +
        "of today's rate is skipped, not part-funded, and one dearer than " +
        "the whole daily rate never funds by valuation: the result names " +
        "each such row, so raise the rate, or use fund_request for a " +
        "request, where it should run.",
      input_schema: {
        type: "object" as const,
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action_id: { type: "string" },
                value: { type: "number" },
                rationale: { type: "string" },
              },
              required: ["action_id", "value"],
            },
          },
        },
        required: ["entries"],
      },
    },
  ];
}

/**
 * update_allocation_policy, described for the mandate in hand (#687): the
 * keys its own machinery reads (policyKnobs), each with its bounds and the
 * value in force, generated from POLICY_BOUNDS. A judgment mandate's list
 * is short (its maintenance ceiling and its attempt priors and bounds); a
 * formula mandate's is its formula.
 */
export function getAllocationPolicyToolDefinition(
  policy: string | null | undefined,
  current?: Partial<AllocationPolicy> | null
): Tool {
  const formula = isFormulaPolicy(policy);
  return {
    name: "update_allocation_policy",
    description:
      (formula
        ? "Amend your mandate's allocation policy: the formula its " +
          "valuations are computed from, and the cadence and cost priors " +
          "around it. This is the lever for what you learn about allocation " +
          "itself rather than about one action: that uncontested work stays " +
          "more fundable than the floor allows, that the staleness horizon " +
          "is too short. "
        : "Amend the parts of your mandate's allocation policy its own " +
          "machinery reads: maintenance_share, the most of your daily rate " +
          "your allocator places on curate rows in a day (funded first, " +
          "best value per owl first; whatever they leave stays in the day " +
          "for everything else), and the cost priors and bounds your " +
          "attempt_proof items are priced and capped with. Your spending " +
          "otherwise follows your own valuations (set_valuations). ") +
      "Keys, with their bounds and the value in force: " +
      describePolicyKnobs(policy, current) +
      ". Out-of-range values are clamped; a key this mandate does not read " +
      "is refused with the list. The change takes effect on the next " +
      "allocation. The note is the public record of why.",
    input_schema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "object",
          description: "Key to number map of the policy values to set.",
        },
        note: {
          type: "string",
          description: "What you learned that justifies the change, in your own words.",
        },
      },
      required: ["updates", "note"],
    },
  };
}

/**
 * Of the actions a set_valuations call valued, the ones today's room (or
 * the whole daily rate) cannot cover (#688): the allocator skips an
 * increment larger than the day's room rather than part-fund it, so a
 * valuation on one of these does nothing until the room exists. Unpaced
 * mandates (rate 0) are bounded by escrow alone and get nothing here.
 */
export async function valuationRoomCheck(
  grantId: string,
  actionIds: string[]
): Promise<{
  day_room_owls: number;
  daily_rate_owls: number;
  over_todays_room: Array<{ action_id: string; gap_owls: number }>;
  over_daily_rate: Array<{ action_id: string; gap_owls: number }>;
} | null> {
  if (actionIds.length === 0) return null;
  const [g] = await rawQuery<{ rate: number; placed: number }>(
    `SELECT g.daily_budget_micro_usd AS rate,
            COALESCE((SELECT SUM(al.amount_micro_usd) FROM action_allocations al
                       WHERE al.grant_id = g.id
                         AND al.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
                     0)::bigint AS placed
       FROM grants g WHERE g.id = $1`,
    [grantId]
  );
  const rate = Number(g?.rate ?? 0);
  if (!g || rate <= 0) return null;
  const room = Math.max(0, rate - Number(g.placed ?? 0));
  const gaps = await rawQuery<{ action_id: string; gap: number }>(
    `SELECT a.id AS action_id,
            GREATEST(0, a.cost_est_micro_usd - COALESCE(
              (SELECT SUM(al.amount_micro_usd - al.spent_micro_usd) FROM action_allocations al
                WHERE al.exclusion_group = a.exclusion_group AND al.released_at IS NULL
                  AND (al.action_id IS NULL OR al.action_id = a.id)), 0))::bigint AS gap
       FROM actions a WHERE a.id = ANY($1::uuid[]) AND a.status = 'open'`,
    [actionIds]
  );
  const overRate = gaps.filter((r) => Number(r.gap) > rate);
  const overRoom = gaps.filter((r) => Number(r.gap) > room && Number(r.gap) <= rate);
  const shape = (r: { action_id: string; gap: number }) => ({
    action_id: r.action_id,
    gap_owls: microUsdToOwls(Number(r.gap)),
  });
  return {
    day_room_owls: microUsdToOwls(room),
    daily_rate_owls: microUsdToOwls(rate),
    over_todays_room: overRoom.map(shape),
    over_daily_rate: overRate.map(shape),
  };
}

/** How many valuations a set_valuations result says it wrote. */
export function writtenCount(result: string): number {
  try {
    return Number((JSON.parse(result) as { written?: number }).written ?? 0) || 0;
  } catch {
    return 0;
  }
}

export interface ManagementToolOptions {
  /** When this pass (review pass or chat turn) started: the two-pass anchor. */
  passStartedAt?: Date;
  /** A person present who can confirm a posting at or above the threshold. */
  confirmedBy?: string | null;
  /** Which path is acting, recorded on lookouts it stands up. */
  actor?: string;
}

/** How long a recorded bounty request stays confirmable by a later pass. */
const BOUNTY_CONFIRM_WINDOW_DAYS = 7;

/**
 * post_bounty (§8.1): the first call records the request on the mandate
 * and creates the `requested` bounty; a call from a later pass opens it
 * (or parks it at confirm_pending). One implementation for the review
 * pass and the management chat.
 */
async function executePostBounty(
  grantId: string,
  toolInput: Record<string, unknown>,
  opts: ManagementToolOptions
): Promise<string> {
  const claimId = String(toolInput.claim_id ?? "");
  const owls = Number(toolInput.owls ?? 0);
  const rationale = String(toolInput.rationale ?? "").trim();
  if (!UUID_RE.test(claimId)) return JSON.stringify({ success: false, problem: "claim_id must be a claim id from your survey" });
  if (!rationale) return JSON.stringify({ success: false, problem: "rationale is required; it is the public reasoning for the posting" });
  const passStartedAt = opts.passStartedAt ?? new Date();
  const [pending] = await rawQuery<{ at: string | null; bounty_id: string | null }>(
    `SELECT mandate->'bounty_requests'->$2->>'at' AS at,
            mandate->'bounty_requests'->$2->>'bounty_id' AS bounty_id
       FROM grants WHERE id = $1`,
    [grantId, claimId]
  );
  const requestedAt = pending?.at ? Date.parse(pending.at) : null;
  const live = await getLiveBountyForClaim(claimId);
  const confirmable =
    requestedAt !== null &&
    requestedAt < passStartedAt.getTime() &&
    requestedAt > Date.now() - BOUNTY_CONFIRM_WINDOW_DAYS * 86_400_000 &&
    live !== null &&
    live.id === pending?.bounty_id &&
    (live.status === "requested" || live.status === "confirm_pending");
  if (!confirmable) {
    const res = await requestBounty({ claimId, owls, expiresInDays: Number(toolInput.expires_in_days) || null, rationale, grantId, passStartedAt });
    if (!res.ok) return JSON.stringify({ success: false, code: res.code, problem: res.message });
    await rawQuery(
      `UPDATE grants
          SET mandate = jsonb_set(
                COALESCE(mandate, '{}'::jsonb),
                ARRAY['bounty_requests', $2::text],
                jsonb_build_object('at', to_jsonb(now()), 'bounty_id', $3::text,
                                   'owls', $4::numeric, 'rationale', $5::text),
                true),
              updated_at = now()
        WHERE id = $1`,
      [grantId, claimId, res.bounty_id, owls, rationale]
    );
    return JSON.stringify({
      success: true,
      opened: false,
      bounty_id: res.bounty_id,
      status: res.status,
      note:
        "Bounty requested and recorded on the mandate. Nothing is offered yet; if a later pass " +
        "still judges the posting right, calling post_bounty again for this claim opens it " +
        "(or waits for a person's confirmation at or above the autonomy threshold). Note the " +
        "pending request in your workspace.",
    });
  }
  const opened = await openBounty({ bountyId: live!.id, passStartedAt, confirmedBy: null });
  if (!opened.ok) return JSON.stringify({ success: false, code: opened.code, problem: opened.message });
  await rawQuery(
    `UPDATE grants SET mandate = COALESCE(mandate, '{}'::jsonb) #- ARRAY['bounty_requests', $2::text], updated_at = now() WHERE id = $1`,
    [grantId, claimId]
  );
  if (opened.status === "confirm_pending") {
    return JSON.stringify({
      success: true,
      opened: false,
      bounty_id: opened.bounty_id,
      status: "confirm_pending",
      note:
        `${formatOwls(live!.amount_micro_usd)} is at or above the autonomy threshold; the posting waits for a ` +
        `person's confirmation (POST /bounties/${opened.bounty_id}/confirm with the operator key` +
        (opts.confirmedBy ? ", or the funder here with confirm_bounty once they say so" : "") +
        `). Say so in your note.`,
    });
  }
  return JSON.stringify({
    success: true,
    opened: true,
    bounty_id: opened.bounty_id,
    status: "open",
    amount: formatOwls(live!.amount_micro_usd),
    note: "Bounty open: the offer is public on the claim page and the prize listing under the rules in force, and its amount is held against this mandate's escrow until it resolves.",
  });
}

/**
 * The funded-grant tool surface: live analytics over exactly the data the
 * public dashboard shows, and the writes a live mandate's steward holds
 * (the plan's remainder, valuations, policy, pacing, money moves, bounties,
 * lookouts). Returns null for tool names it doesn't own.
 *
 * Shared with the autonomous review pass (mandate-review.ts): one
 * implementation, so a guard added here holds on both paths rather than
 * being reasoned about twice.
 */
export async function executeManagementTool(
  grantId: string,
  name: string,
  toolInput: Record<string, unknown>,
  opts: ManagementToolOptions = {}
): Promise<string | null> {
  // The lookout tools (spawn_lookout, list_lookouts, lookout_report,
  // update_lookout, poke_lookout, and the feed tools add_feed, update_feed,
  // feed_report, read_listing); null means "not one of them".
  const lookout = await executeLookoutManagementTool(grantId, name, toolInput, {
    createdBy: opts.actor ?? (opts.confirmedBy ? "grantmaker:chat" : "grantmaker:review"),
  });
  if (lookout !== null) return lookout;
  if (name === "post_bounty") {
    return executePostBounty(grantId, toolInput, opts);
  }
  if (name === "confirm_bounty") {
    // The funder in the management chat confirming a parked posting (§8.1).
    if (!opts.confirmedBy) return JSON.stringify({ success: false, problem: "confirmation is a person's act; not available on this path" });
    const bountyId = String(toolInput.bounty_id ?? "");
    const bounty = await getBountyById(bountyId);
    if (!bounty || bounty.posted_by_grant_id !== grantId) return JSON.stringify({ success: false, problem: "no such bounty on this mandate" });
    const res = await openBounty({ bountyId, passStartedAt: opts.passStartedAt ?? null, confirmedBy: opts.confirmedBy });
    return JSON.stringify(res.ok ? { success: true, ...res } : { success: false, code: res.code, problem: res.message });
  }
  if (name === "withdraw_bounty") {
    const bountyId = String(toolInput.bounty_id ?? "");
    const bounty = await getBountyById(bountyId);
    if (!bounty || bounty.posted_by_grant_id !== grantId) {
      return JSON.stringify({ success: false, problem: "no such bounty on this mandate" });
    }
    const res = await withdrawBounty({ bountyId, rationale: String(toolInput.rationale ?? ""), actor: `grantmaker:${grantId}` });
    return JSON.stringify(
      res.ok
        ? { success: true, status: res.status, effective_at: res.effective_at, note: res.effective_at ? "Notice given; the withdrawal takes effect at effective_at unless a prize claim is live." : "Withdrawn before opening." }
        : { success: false, code: res.code, problem: res.message }
    );
  }
  if (name === "grant_overview") {
    const [grant] = await rawQuery<{
      status: string;
      plan: { strategy?: string; items?: PlanItem[] } | null;
      plan_cursor: number;
      budget_job_id: string;
      budget_micro_usd: number;
      job_status: string;
      funder_notes: Array<{ at: string; note: string }> | null;
      workspace: string | null;
      last_review: unknown;
      close_requested: unknown;
      bounty_requests: unknown;
    }>(
      `SELECT g.status, g.plan, g.plan_cursor, g.budget_job_id,
              j.budget_micro_usd, j.status AS job_status,
              g.mandate->'funder_notes' AS funder_notes, g.workspace,
              g.mandate->'last_review' AS last_review,
              g.mandate->'close_requested' AS close_requested,
              g.mandate->'bounty_requests' AS bounty_requests
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
        WHERE g.id = $1`,
      [grantId]
    );
    if (!grant) return JSON.stringify({ error: "grant not found" });
    const spent = await getJobSpentMicroUsd(grant.budget_job_id);
    const contributions = await getJobContributions(grant.budget_job_id);
    return JSON.stringify({
      status: grant.status,
      budget_status: grant.job_status,
      budget_owls: microUsdToOwls(Number(grant.budget_micro_usd)),
      spent_owls: microUsdToOwls(spent),
      remaining_owls: microUsdToOwls(
        Math.max(0, Number(grant.budget_micro_usd) - spent)
      ),
      contributors: contributions.length,
      strategy: grant.plan?.strategy ?? null,
      // Each item's standing on the ledger (plan-state.ts): a blocked or
      // waiting item says why, so a slow queue and a dead one read
      // differently (#416). The counts are the executed tally: "done" is
      // the items whose work ran, not the cursor's position (#427).
      plan_counts: countPlanItems(grant.plan?.items ?? [], grant.plan_cursor),
      plan: describePlanItems(grant.plan?.items ?? [], grant.plan_cursor),
      // What the review passes asked of the funder (note_to_funder, #701).
      funder_notes: grant.funder_notes ?? [],
      // The review passes' working memory and record (#690): what the
      // last pass did, a closure or bounty it has pending, and the
      // workspace itself, so nothing writes the workspace without reading it.
      last_review: grant.last_review ?? null,
      close_requested: grant.close_requested ?? null,
      bounty_requests: grant.bounty_requests ?? null,
      workspace: grant.workspace ?? "",
    });
  }
  if (name === "list_funded_assessments") {
    const limit = Math.min(100, Math.max(1, Number(toolInput.limit ?? 30)));
    const status =
      typeof toolInput.status === "string" && toolInput.status
        ? toolInput.status
        : null;
    const rows = await rawQuery(
      `SELECT a.claim_id, c.text, a.status, a.claim_credence, c.importance,
              c.contestation, a.assessed_at
         FROM assessments a
         JOIN grants g ON g.id = $1
         JOIN claims c ON c.id = a.claim_id
        WHERE a.funded_by_job_id = g.budget_job_id
          AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.assessed_at DESC
        LIMIT $3`,
      [grantId, status, limit]
    );
    return JSON.stringify({ count: rows.length, assessments: rows });
  }
  if (name === "ingestion_report") {
    const pipeline = await getMandatePipeline(grantId);
    return JSON.stringify({ sources: pipeline.length, pipeline });
  }
  if (name === "claims_from_source") {
    const limit = Math.min(100, Math.max(1, Math.floor(Number(toolInput.limit ?? 40)) || 40));
    const offset = Math.max(0, Math.floor(Number(toolInput.offset ?? 0)) || 0);
    const assessed = ["assessed", "unassessed"].includes(String(toolInput.assessed))
      ? String(toolInput.assessed)
      : "any";
    const orderBy =
      toolInput.order === "contestation"
        ? "contestation DESC NULLS LAST, importance DESC NULLS LAST"
        : toolInput.order === "recent"
          ? "assessed_at DESC NULLS LAST, importance DESC NULLS LAST"
          : "importance DESC NULLS LAST, contestation DESC NULLS LAST";
    const page = (lim: number, off: number) =>
      rawQuery<Record<string, unknown> & { total: number }>(
        `WITH linked AS (
         SELECT ci.claim_id, cl.kind, cl.text, cl.importance, cl.contestation,
                cl.steward_state, ci.stance,
                a.status AS assessment_status,
                -- Each kind keeps its current assessment in its own table.
                GREATEST(
                  a.assessed_at,
                  (SELECT MAX(q.assessed_at) FROM quantity_estimates q
                    WHERE q.claim_id = cl.id AND q.is_current = true),
                  (SELECT MAX(qa.assessed_at) FROM question_assessments qa
                    WHERE qa.claim_id = cl.id AND qa.is_current = true)
                ) AS assessed_at
           FROM claim_instances ci
           JOIN grant_sources gs
             ON gs.source_id = ci.source_id AND gs.grant_id = $1 AND ci.detached_at IS NULL
           JOIN claims cl ON cl.id = ci.claim_id AND cl.state = 'active'
           LEFT JOIN assessments a
             ON a.claim_id = ci.claim_id AND a.is_current = true
          WHERE ci.source_id = $2
       )
       SELECT *, COUNT(*) OVER()::int AS total FROM linked
        WHERE ($3 = 'any'
               OR ($3 = 'assessed' AND assessed_at IS NOT NULL)
               OR ($3 = 'unassessed' AND assessed_at IS NULL))
        ORDER BY ${orderBy}
        LIMIT $4 OFFSET $5`,
        [grantId, String(toolInput.source_id ?? ""), assessed, lim, off]
      );
    const rows = await page(limit, offset);
    // An offset past the end returns no rows to carry the window count.
    const total = rows[0]?.total ?? (offset > 0 ? ((await page(1, 0))[0]?.total ?? 0) : 0);
    const next = offset + rows.length < total ? offset + rows.length : null;
    return JSON.stringify({
      total,
      offset,
      returned: rows.length,
      next_offset: next,
      claims: rows.map(({ total: _t, ...r }) => r),
    });
  }
  if (name === "importance_distribution") {
    const [row] = await rawQuery<Record<string, unknown>>(
      `WITH touched AS (
         SELECT DISTINCT cl.id, cl.importance, cl.contestation,
                a.status AS assessment_status
           FROM grants g
           LEFT JOIN assessments fa ON fa.funded_by_job_id = g.budget_job_id
           LEFT JOIN grant_sources gs ON gs.grant_id = g.id
           LEFT JOIN claim_instances ci ON ci.source_id = gs.source_id AND ci.detached_at IS NULL
           JOIN claims cl
             ON cl.id = COALESCE(fa.claim_id, ci.claim_id)
            AND cl.state = 'active'
           LEFT JOIN assessments a
             ON a.claim_id = cl.id AND a.is_current = true
          WHERE g.id = $1
       )
       SELECT COUNT(*)::int AS claims,
              ROUND(AVG(importance)::numeric, 3) AS mean_importance,
              ROUND(AVG(contestation)::numeric, 3) AS mean_contestation,
              array_agg_hist AS importance_deciles,
              statuses
         FROM touched,
       LATERAL (
         SELECT array_agg(n ORDER BY bucket) AS array_agg_hist FROM (
           SELECT width_bucket(importance, 0, 1.0001, 10) AS bucket,
                  COUNT(*)::int AS n
             FROM touched GROUP BY 1) h
       ) hist,
       LATERAL (
         SELECT jsonb_object_agg(COALESCE(assessment_status, 'unassessed'), n)
                AS statuses
           FROM (SELECT assessment_status, COUNT(*)::int AS n
                   FROM touched GROUP BY 1) s
       ) st
       GROUP BY array_agg_hist, statuses`,
      [grantId]
    );
    return JSON.stringify(row ?? { claims: 0 });
  }
  if (name === "regrant") {
    const { createRegrant } = await import(
      "../../services/regrant-service.js"
    );
    const res = await createRegrant({
      fromGrantId: grantId,
      toGrantId: String(toolInput.to_mandate_id ?? ""),
      owls: Number(toolInput.owls ?? 0),
      note: String(toolInput.note ?? ""),
    });
    return JSON.stringify(res);
  }
  if (name === "spawn_mandate") {
    const { spawnFundedMandate } = await import(
      "../../services/regrant-service.js"
    );
    const res = await spawnFundedMandate({
      fromGrantId: grantId,
      title: String(toolInput.title ?? ""),
      objective: String(toolInput.objective ?? ""),
      owls: Number(toolInput.owls ?? 0),
      note: String(toolInput.note ?? ""),
    });
    return JSON.stringify(res);
  }
  if (name === "set_daily_rate") {
    const owlsPerDay = Number(toolInput.owls_per_day);
    if (!Number.isFinite(owlsPerDay) || owlsPerDay < 0) {
      return JSON.stringify({
        success: false,
        problem: "owls_per_day must be a non-negative number",
      });
    }
    const { owlsToMicroUsd } = await import("../../services/owl.js");
    await rawQuery(
      `UPDATE grants SET daily_budget_micro_usd = $2, updated_at = now()
        WHERE id = $1 AND status = 'active'`,
      [grantId, owlsToMicroUsd(owlsPerDay)]
    );
    return JSON.stringify({ success: true, owls_per_day: owlsPerDay });
  }
  if (name === "allocation_report") {
    const { getMandateAllocationView } = await import(
      "../../services/mandate-service.js"
    );
    const view = await getMandateAllocationView(grantId, {
      kind: toolInput.kind ? String(toolInput.kind) : undefined,
      limit: toolInput.limit ? Number(toolInput.limit) : undefined,
    });
    return JSON.stringify(view ?? { error: "mandate not active" });
  }
  if (name === "list_open_actions") {
    const { listOpenActions } = await import("../../services/mandate-valuer-service.js");
    const str = (k: string) => (typeof toolInput[k] === "string" && toolInput[k] ? (toolInput[k] as string) : null);
    const res = await listOpenActions({
      grantId,
      query: str("query"),
      tag: str("tag"),
      within: str("within"),
      withinDepth: toolInput.within_depth === undefined ? undefined : Number(toolInput.within_depth),
      kind: str("kind"),
      nodeKind: str("node_kind") as "claim" | "quantity" | "question" | null,
      assessed: (str("assessed") ?? "any") as "any" | "assessed" | "unassessed",
      unfundedOnly: toolInput.unfunded_only === true,
      maxCostOwls: toolInput.max_cost_owls === undefined ? null : Number(toolInput.max_cost_owls),
      valued: (str("valued") ?? "any") as "any" | "mine" | "not_mine",
      order: (str("order") ?? undefined) as Parameters<typeof listOpenActions>[0]["order"],
      offset: Number(toolInput.offset ?? 0),
      limit: Number(toolInput.limit ?? 25),
    });
    return JSON.stringify(res);
  }
  if (name === "set_valuations") {
    // A formula mandate's refresh would overwrite these rows (the reason
    // the tool is not offered to one); refuse rather than write values
    // that silently revert.
    const [row] = await rawQuery<{ policy: string }>(`SELECT policy FROM grants WHERE id = $1`, [grantId]);
    if (!row) return JSON.stringify({ success: false, problem: "mandate not found" });
    if (isFormulaPolicy(row.policy)) {
      return JSON.stringify({
        success: false,
        problem:
          "This mandate's valuations come from its formula, which rewrites them on every " +
          "refresh; amend the formula with update_allocation_policy instead.",
      });
    }
    const { setMandateValuations } = await import("../../services/mandate-valuer-service.js");
    const entries = (Array.isArray(toolInput.entries) ? toolInput.entries : []) as ValuationEntry[];
    const res = await setMandateValuations(grantId, entries);
    // Tell the agent now which of these the day cannot cover (#688),
    // rather than leave it to find out that nothing happened.
    const notWritten = new Set([...res.unknownActionIds, ...res.recusedActionIds]);
    const room = await valuationRoomCheck(
      grantId,
      entries.map((e) => String(e.action_id)).filter((id) => UUID_RE.test(id) && !notWritten.has(id))
    ).catch(() => null);
    if (!room || (room.over_todays_room.length === 0 && room.over_daily_rate.length === 0)) {
      return JSON.stringify(res);
    }
    return JSON.stringify({
      ...res,
      room,
      note:
        `Today's room is ${room.day_room_owls} of a ${room.daily_rate_owls}-owl daily rate. ` +
        (room.over_todays_room.length > 0
          ? `${room.over_todays_room.length} valued row(s) need more than today's room and wait for a later day. `
          : "") +
        (room.over_daily_rate.length > 0
          ? `${room.over_daily_rate.length} need more than the whole daily rate and never fund by ` +
            `valuation: raise the rate (set_daily_rate) or, for a request, use fund_request.`
          : ""),
    });
  }
  if (name === "update_allocation_policy") {
    const note = String(toolInput.note ?? "").trim();
    if (!note) return JSON.stringify({ success: false, problem: "note required" });
    // Honesty guard, on the mandate's POLICY rather than its identity
    // (#687): each mandate may set exactly the keys its own machinery
    // reads (policyKnobs). A formula mandate, General or Governance, reads
    // its formula; a judgment mandate reads its maintenance ceiling and
    // its attempt priors and bounds, and nothing else, so a formula knob is
    // refused there rather than reported as a lever that does nothing.
    const [row] = await rawQuery<{ policy: string }>(
      `SELECT policy FROM grants WHERE id = $1`,
      [grantId]
    );
    if (!row) return JSON.stringify({ success: false, problem: "mandate not found" });
    const keys = policyKnobs(row.policy);
    const result = await updateAllocationPolicy(
      grantId,
      (toolInput.updates ?? {}) as Record<string, unknown>,
      keys
    );
    if (!result.ok) {
      return JSON.stringify({
        success: false,
        problem:
          result.problem +
          (isFormulaPolicy(row.policy)
            ? ""
            : ". Otherwise this mandate's spending follows your own valuations (set_valuations)."),
      });
    }
    const policy = result.policy as unknown as Record<string, number>;
    return JSON.stringify({
      success: true,
      changed: result.changed,
      policy_in_force: Object.fromEntries(keys.map((k) => [k, policy[k]])),
      note_recorded: note,
    });
  }
  if (name === "adjust_plan") {
    const items = (toolInput.items ?? []) as PlanItem[];
    const note = String(toolInput.note ?? "").trim();
    if (!note) return JSON.stringify({ success: false, problem: "note required" });
    const probe: GrantMandate = {
      title: "x",
      objective: "x",
      plan: { strategy: "x", items },
      expected_cost_owls: 1,
      funder_named: true,
      funder_stake: "none",
    };
    const problem = validateMandate(probe);
    if (problem) return JSON.stringify({ success: false, problem });
    // Stored in the one plan-item form every path writes (#684).
    const stored = normalizePlanItems(items);
    const rows = await rawQuery<{ plan_cursor: number }>(
      `UPDATE grants g
          SET plan = jsonb_set(
                COALESCE(g.plan, '{}'::jsonb), '{items}',
                (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                   FROM jsonb_array_elements(
                     COALESCE(g.plan->'items', '[]'::jsonb)) WITH ORDINALITY t(e, i)
                  WHERE t.i <= g.plan_cursor) || $2::jsonb),
              updated_at = now()
        WHERE g.id = $1 AND g.status = 'active'
        RETURNING g.plan_cursor`,
      [grantId, JSON.stringify(stored)]
    );
    if (rows.length === 0) {
      return JSON.stringify({
        success: false,
        problem: "grant is not active; the plan can no longer be amended",
      });
    }
    // The new items materialize now, so the owner's chat sees each one's
    // standing in the same turn (#416); a failure here never loses the
    // amendment, the sweep retries on cadence.
    const kept = Number(rows[0]!.plan_cursor);
    let materialized: unknown[] = [];
    let materializeProblem: string | null = null;
    try {
      materialized = await materializePlanItems(
        grantId,
        items.map((_, i) => kept + i)
      );
    } catch (err) {
      materializeProblem = err instanceof Error ? err.message : String(err);
    }
    return JSON.stringify({
      success: true,
      executed_items_kept: kept,
      new_remaining_items: items.length,
      items: materialized,
      ...(materializeProblem
        ? { note: `amended, but not yet materialized onto the ledger: ${materializeProblem}` }
        : {}),
      note_recorded: note,
    });
  }
  return null;
}
