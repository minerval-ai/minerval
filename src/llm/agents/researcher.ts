/**
 * The researcher (#298): an instrument an administrator launches for one
 * bounded investigation, answerable only to the administrator that launched
 * it. The Claim Steward delegates the sub-questions it should not work
 * inline (replicate a finding, trace a statistic to its origin, read and map
 * a literature, attempt a computation) and gets a report back to weigh; a
 * Grantmaker delegates a survey for its mandate. The solver is the special
 * case of this instrument that runs with Lean, no network, and no
 * constitution; this is the general case, and the two share a harness
 * (src/llm/instrument-harness.ts).
 *
 * What the launcher chooses: the task, the model tier, the dollar ceiling,
 * the effort, and whether the constitution is prepended (yes by default).
 * What the harness guarantees: a ceiling read from the usage meter every
 * turn, one wrap-up notice, an operator pause flag polled every turn, wall
 * and turn caps, and a terminal `report` tool. What the researcher may
 * write: its notebook, the provenance tables through the Provenance skill's
 * tools, and the stored copy of a source it fetched. Nothing else; a unit
 * test holds that line.
 *
 * The toolset follows the model. A strong-tier model runs the long-run loop
 * with web search and the code-execution sandbox; a standard Claude model
 * runs the ordinary loop with the same server tools; the cheap tier runs the
 * ordinary loop with client tools only, since server tools are Anthropic's.
 * The task message tells the researcher which it has.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../config.js";
import {
  longRunToolLoop,
  toolUseLoop,
  type LongRunLoopState,
  type ToolCompletionResult,
} from "../client.js";
import { LlmRefusalError } from "../errors.js";
import { modelSupportsLongRun } from "../models.js";
import { resolveProvider } from "../providers/routing.js";
import { getUsageContext, withAgent, withSkills } from "../usage-context.js";
import {
  CODE_EXECUTION_TOOL,
  MAX_TURNS_GUARD,
  REMINDER_FRACTION,
  STOP_CEILING,
  STOP_PAUSED,
  meterCodeExecution,
  meterMicroUsd,
  taskBudgetTokens,
  turnUsedCodeExecution,
} from "../instrument-harness.js";
import {
  buildResearcherTaskMessage,
  getResearcherSystemPromptBlocks,
} from "../prompts/researcher.js";
import { sectionsForRole, skillsForDomains, type Skill } from "../prompts/skills.js";
import { sanitizeDomains } from "./skill-selection.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { isLeanTool } from "../tools/lean-tools.js";
import {
  elicitConfigured,
  executeElicitTool,
  getElicitToolDefinitions,
  isElicitTool,
} from "../tools/elicit-tools.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { leanCheckerConfigured } from "../../services/lean-checker-client.js";
import {
  NOTEBOOK_MAX_SECTIONS,
  NOTEBOOK_MAX_SECTION_CHARS,
  RESEARCHER_AGENT,
  readResearcherPaused,
  stampResearchRun,
  updateResearchProgress,
  writeResearchNotebookSection,
  type ResearchRunRow,
  type ResearchRunStatus,
} from "../../services/research-run-service.js";

type Tool = Anthropic.Tool;
type ToolUnion = Anthropic.Messages.ToolUnion;

export const WRAP_UP_NOTICE =
  "Harness notice: about fifteen percent of this investigation's budget remains. " +
  "Stop exploring. Write what you have to the notebook and call report now; the " +
  "harness stops the run at the ceiling whether or not you have reported.";

export const CEILING_REFUSAL =
  "This investigation has reached its cost ceiling. No further tool call will run. " +
  "Call report now with what you have.";

export const PAUSED_REFUSAL =
  "The operator has paused the researcher. No further tool call will run. " +
  "Call report now with what you have.";

/** The terminal tool's schema. */
export const RESEARCH_REPORT_TOOL: Tool = {
  name: "report",
  description:
    "End the investigation with your report to the administrator that launched you. " +
    "Call it exactly once: when you have answered the task, exhausted the routes you " +
    "can see, or received the budget notice. A precise negative report is a good outcome.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "The direct answer to the task, in plain prose, for the administrator.",
      },
      findings: {
        type: "array",
        description: "Each finding with the evidence it rests on and your confidence in it.",
        items: {
          type: "object",
          properties: {
            finding: { type: "string" },
            evidence: { type: "string", description: "What it rests on: the source, the passage, the computation." },
            confidence: { type: "number", description: "0 to 1." },
          },
          required: ["finding", "evidence", "confidence"],
          additionalProperties: false,
        },
      },
      sources_consulted: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            what_it_showed: { type: "string" },
            read_fully: { type: "boolean", description: "Whether you read the whole document rather than an excerpt." },
          },
          required: ["title", "what_it_showed", "read_fully"],
          additionalProperties: false,
        },
      },
      provenance_recorded: {
        type: "string",
        description: "What you recorded with the provenance tools, or 'none'.",
      },
      caveats: { type: "string", description: "What you could not do or check, and why." },
      what_would_change: { type: "string", description: "What evidence would overturn your answer." },
      suggested_next_steps: {
        type: "string",
        description: "What the administrator might do or delegate next.",
      },
    },
    required: ["answer", "findings", "sources_consulted", "provenance_recorded", "caveats", "what_would_change", "suggested_next_steps"],
    additionalProperties: false,
  },
};

const NOTEBOOK_WRITE_TOOL: Tool = {
  name: "notebook_write",
  description:
    "Record your work under a section name (a thread of the investigation, a source, " +
    "a dead end). Writing a section that exists replaces it. The notebook persists " +
    "with the run and is what the administrator reads beside your report.",
  input_schema: {
    type: "object",
    properties: {
      section: { type: "string", description: "A short section name." },
      content: { type: "string", description: "The section's content." },
    },
    required: ["section", "content"],
    additionalProperties: false,
  },
};

const NOTEBOOK_READ_TOOL: Tool = {
  name: "notebook_read",
  description: "Return everything you have written to the notebook, by section.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

export interface ResearcherInput {
  run: Pick<
    ResearchRunRow,
    "id" | "claim_id" | "grant_id" | "task" | "model" | "model_tier" | "effort" | "include_constitution" | "ceiling_micro_usd" | "notebook"
  >;
  claim: { id: string; text: string; domains: string[] } | null;
  /** Wall-clock cap for the run; defaults to RESEARCHER_MAX_WALL_MINUTES. */
  maxWallMs?: number;
  /** Turn cap for the ordinary loop; defaults to RESEARCHER_MAX_TURNS. */
  maxTurns?: number;
  /** Test seam: a clock. */
  now?: () => number;
}

export interface ResearcherResult {
  status: ResearchRunStatus;
  report: Record<string, unknown> | null;
  turns: number;
  stopReason: string;
  servedModels: string[];
  toolNames: string[];
  error: string | null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Run one investigation. Enter through withAgent("researcher") so every LLM,
 * container, and external row carries the agent, the run, and the claim and
 * job of the launching context. Returns what the run produced; the launcher
 * closes the row.
 */
export async function runResearcher(input: ResearcherInput): Promise<ResearcherResult> {
  return withAgent(RESEARCHER_AGENT, () => runResearcherImpl(input));
}

async function runResearcherImpl(input: ResearcherInput): Promise<ResearcherResult> {
  const config = loadConfig();
  const now = input.now ?? Date.now;
  const run = input.run;
  const model = run.model;
  const provider = resolveProvider(model);
  const serverTools = provider === "anthropic";
  const longRun = serverTools && modelSupportsLongRun(model);
  const ceiling = Math.max(1, run.ceiling_micro_usd);
  const maxWallMs = input.maxWallMs ?? config.researcherMaxWallMinutes * 60_000;
  const maxTurns = input.maxTurns ?? config.researcherMaxTurns;

  // Skills: the method skills that address the researcher, plus the claim's
  // domain skills for their tools (a domain skill with no researcher section
  // contributes tools and no block).
  const claimDomains = sanitizeDomains(input.claim?.domains ?? []);
  const skills: Skill[] = skillsForDomains(claimDomains, "researcher");
  const skillsWithText = skills.filter((s) => sectionsForRole(s, "researcher").length > 0);
  const checker = leanCheckerConfigured(config);
  const skillTools = getActiveSkillToolDefinitions(skills, "researcher").filter(
    (t) => checker || !isLeanTool(t.name)
  );

  const elicitTools = elicitConfigured(config) ? await getElicitToolDefinitions(config) : [];
  const graphReadTools = getGraphReadToolDefinitions();
  const graphReadNames = new Set(graphReadTools.map((t) => t.name));

  const webSearchTool: Anthropic.Messages.WebSearchTool20260209 = {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: Math.max(1, config.researcherWebSearchMaxUses),
  };
  const tools: ToolUnion[] = [
    ...graphReadTools,
    ...elicitTools,
    ...skillTools,
    NOTEBOOK_WRITE_TOOL,
    NOTEBOOK_READ_TOOL,
    RESEARCH_REPORT_TOOL,
    ...(serverTools ? [CODE_EXECUTION_TOOL, webSearchTool] : []),
  ];
  const toolNames = tools.map((t) => (t as { name: string }).name);
  await stampResearchRun(run.id, { runId: getUsageContext().runId ?? null, tools: toolNames });

  const notebook: Record<string, string> = { ...(run.notebook ?? {}) };
  const system = getResearcherSystemPromptBlocks({
    includeConstitution: run.include_constitution,
    skills: skillsWithText,
  });
  const taskMessage = buildResearcherTaskMessage({
    task: run.task,
    claim: input.claim ? { id: input.claim.id, text: input.claim.text } : null,
    budgetUsd: ceiling / 1_000_000,
    toolNames,
    serverTools,
    notebook,
  });

  let reportInput: Record<string, unknown> | null = null;
  let elicitCalls = 0;
  let reminded = false;
  let halted: string | null = null;
  const servedModels = new Set<string>();
  let lastTurnEndedAt = now();

  const executeNotebookWrite = async (toolInput: Record<string, unknown>): Promise<string> => {
    const section = asString(toolInput.section).trim().slice(0, 200);
    const content = asString(toolInput.content);
    if (!section) return JSON.stringify({ success: false, message: "section is required." });
    if (content.length > NOTEBOOK_MAX_SECTION_CHARS) {
      return JSON.stringify({
        success: false,
        message: `A section holds at most ${NOTEBOOK_MAX_SECTION_CHARS} characters; split it.`,
      });
    }
    if (!(section in notebook) && Object.keys(notebook).length >= NOTEBOOK_MAX_SECTIONS) {
      return JSON.stringify({
        success: false,
        message: `The notebook holds at most ${NOTEBOOK_MAX_SECTIONS} sections; rewrite one.`,
      });
    }
    notebook[section] = content;
    await writeResearchNotebookSection(run.id, section, content);
    return JSON.stringify({ success: true, section, sections: Object.keys(notebook) });
  };

  const executeTool = async (name: string, toolInput: Record<string, unknown>): Promise<string> => {
    // The ordinary loop has no beforeTurn hook, so the ceiling and the pause
    // flag are enforced here too: past either, every call is refused with
    // the instruction to report. The long-run loop stops before the turn.
    if (halted) return JSON.stringify({ success: false, message: halted });
    if (meterMicroUsd() >= ceiling) {
      halted = CEILING_REFUSAL;
      return JSON.stringify({ success: false, message: halted });
    }
    if (name === "notebook_write") return executeNotebookWrite(toolInput);
    if (name === "notebook_read") return JSON.stringify({ success: true, notebook });
    if (name === "report") {
      return JSON.stringify({ success: false, message: "report was already received." });
    }
    if (graphReadNames.has(name)) {
      const out = await executeGraphReadTool(name, toolInput);
      if (out !== null) return out;
    }
    if (isElicitTool(name)) {
      const cap = config.researcherElicitMaxCalls;
      if (cap > 0 && elicitCalls >= cap) {
        return JSON.stringify({
          success: false,
          message: `This run has made ${elicitCalls} Elicit calls, its cap (${cap}). Work with what they returned.`,
        });
      }
      elicitCalls++;
      return executeElicitTool(name, toolInput, config);
    }
    if (isSkillTool(name)) {
      return executeSkillTool(name, toolInput, {
        role: "researcher",
        ...(input.claim ? { claimId: input.claim.id } : {}),
        run: { trigger: "research", context: run.task, model },
      });
    }
    return JSON.stringify({ success: false, message: `Unknown tool: ${name}` });
  };

  const onFinalTool = (name: string, toolInput: Record<string, unknown>) => {
    if (name !== "report") return null;
    reportInput = toolInput;
    return toolInput;
  };

  const progress = async (turns: number) => {
    await updateResearchProgress(run.id, {
      turns,
      spentMicroUsd: meterMicroUsd(),
      servedModels: [...servedModels],
    }).catch(() => undefined);
  };

  const finish = (
    status: ResearchRunStatus,
    turns: number,
    stopReason: string,
    error: string | null
  ): ResearcherResult => ({
    status,
    report: reportInput
      ? { ...reportInput, harness: { stop_reason: stopReason, turns, model, tools: toolNames } }
      : null,
    turns,
    stopReason,
    servedModels: [...servedModels],
    toolNames,
    error,
  });

  const runLoop = async () => {
    if (longRun) {
      const beforeTurn = async (_state: LongRunLoopState): Promise<{ stop?: string } | void> => {
        if (meterMicroUsd() >= ceiling) return { stop: STOP_CEILING };
        if (await readResearcherPaused()) return { stop: STOP_PAUSED };
        return undefined;
      };
      const reminder = (): string | null => {
        if (reminded || meterMicroUsd() < REMINDER_FRACTION * ceiling) return null;
        reminded = true;
        return WRAP_UP_NOTICE;
      };
      const afterTurn = async (state: LongRunLoopState, result: ToolCompletionResult) => {
        const served = result.servedModel ?? result.model;
        if (served) servedModels.add(served);
        const endedAt = now();
        if (turnUsedCodeExecution(result)) {
          await meterCodeExecution((endedAt - lastTurnEndedAt) / 1000);
        }
        lastTurnEndedAt = endedAt;
        await progress(state.turn);
      };
      const loop = await longRunToolLoop({
        initialMessages: [{ role: "user", content: taskMessage }],
        tools,
        system,
        model,
        effort: (run.effort as "medium" | "high" | "max" | null) ?? "high",
        taskBudgetTokens: taskBudgetTokens(ceiling, model),
        fallbacks: "none",
        maxIterations: Math.min(MAX_TURNS_GUARD, maxTurns),
        maxWallMs,
        executeTool,
        onFinalTool,
        beforeTurn,
        afterTurn,
        reminder,
      });
      return { turns: loop.turns, stopReason: loop.stopReason, hookStop: loop.hookStop };
    }

    // The ordinary loop: turns are bounded by maxTurns, the ceiling and the
    // pause flag by the executor above, and the wrap-up notice rides on the
    // loop's own iteration notice. Container time is not metered per turn on
    // this path (the loop exposes no per-turn hook); the sandbox's published
    // free allowance covers a run of this size, and the token meter binds.
    let turns = 0;
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: taskMessage }],
      tools,
      system,
      model,
      maxTokens: 16384,
      maxIterations: maxTurns,
      iterationBudgetNotice: {
        warnWithin: 3,
        message: (remaining) =>
          `Harness notice: ${remaining} turn(s) remain before this investigation is stopped. ` +
          `Write what you have to the notebook and call report on your next turn.`,
      },
      executeTool: async (name, toolInput) => {
        turns++;
        if (!halted && (await readResearcherPaused())) halted = PAUSED_REFUSAL;
        const out = await executeTool(name, toolInput);
        await progress(turns);
        return out;
      },
      onFinalTool,
    });
    const served = result.servedModel ?? result.model;
    if (served) servedModels.add(served);
    const stopReason = reportInput
      ? "final_tool"
      : halted === CEILING_REFUSAL
        ? "hook"
        : halted === PAUSED_REFUSAL
          ? "hook"
          : result.stopReason === "max_tokens"
            ? "max_tokens"
            : turns >= maxTurns
              ? "max_iterations"
              : "end_turn";
    const hookStop = halted === CEILING_REFUSAL ? STOP_CEILING : halted === PAUSED_REFUSAL ? STOP_PAUSED : undefined;
    return { turns, stopReason, hookStop };
  };
  let loop: { turns: number; stopReason: string; hookStop?: string };
  try {
    loop = await withSkills(
      skills.map((s) => s.name),
      () => runLoop()
    );
  } catch (err) {
    if (err instanceof LlmRefusalError) {
      return finish("refused", 0, "refusal", err.message);
    }
    throw err;
  }

  if (reportInput) return finish("completed", loop.turns, loop.stopReason, null);
  if (loop.stopReason === "hook") {
    if (loop.hookStop === STOP_CEILING) {
      return finish("budget", loop.turns, loop.stopReason, "the investigation reached its cost ceiling before reporting");
    }
    return finish("paused", loop.turns, loop.stopReason, "the researcher was paused by the operator");
  }
  if (loop.stopReason === "max_wall") {
    return finish("timeout", loop.turns, loop.stopReason, "the investigation reached its wall-clock cap before reporting");
  }
  return finish(
    "completed",
    loop.turns,
    loop.stopReason,
    `the researcher ended (${loop.stopReason}) without calling report`
  );
}
