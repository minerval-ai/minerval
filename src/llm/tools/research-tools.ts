/**
 * The delegation tools (#298): `delegate_research` and `get_research_run`,
 * one bundle for every administrator that may launch the researcher (the
 * Claim Steward on its claim, the Grantmaker on its mandate).
 *
 * Launching is a judgment the administrator makes: what to ask, on which
 * tier, with how much budget, and whether the instrument should carry the
 * constitution. The tool description says what each tier can do, so the
 * brief can be written with the instrument's affordances in mind. What
 * lives here is the mechanism around that judgment: the per-launcher-run
 * count cap, the ceiling cap, the daily cap, the pause flag, the run row,
 * and the synchronous run itself. The launcher's tool call blocks until
 * the researcher reports; the report comes back as the tool result and is
 * also kept on the run row for `get_research_run` and for the record.
 *
 * Same factory shape as the report tools: per-run state (the count) lives
 * in a closure, and `execute` returns null for any name it does not own.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { loadConfig } from "../../config.js";
import { rawQuery } from "../../db/client.js";
import { LlmBudgetExceededError } from "../errors.js";
import { getUsageContext, withCostMeter } from "../usage-context.js";
import { owlsToMicroUsd } from "../../services/owl.js";
import {
  RESEARCH_MODEL_TIERS,
  checkResearcherBudget,
  closeResearchRun,
  getResearchRun,
  modelForTier,
  openResearchRun,
  readResearcherPaused,
  type ResearchModelTier,
} from "../../services/research-run-service.js";
import { runResearcher, type ResearcherInput, type ResearcherResult } from "../agents/researcher.js";

export const DELEGATE_RESEARCH_TOOL_NAME = "delegate_research";
export const GET_RESEARCH_RUN_TOOL_NAME = "get_research_run";
export const RESEARCH_TOOL_NAMES: readonly string[] = [
  DELEGATE_RESEARCH_TOOL_NAME,
  GET_RESEARCH_RUN_TOOL_NAME,
];

export const EFFORT_LEVELS = ["medium", "high", "max"] as const;

export interface ResearchTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
  /** Runs launched by this launcher run so far. */
  readonly launchedCount: number;
}

export interface ResearchToolsOptions {
  /** The agent key recorded as the launcher: claim_steward, grantmaker. */
  requestedBy: string;
  /** The claim the launcher serves; a Grantmaker passes none and may name one per call. */
  claimId?: string | null;
  /** The mandate the launcher serves, when it serves one. */
  grantId?: string | null;
  /** Test seam: the researcher entry point. */
  runResearcher?: (input: ResearcherInput) => Promise<ResearcherResult>;
}

/** The tool definitions, with the affordances of each tier spelled out. */
export function getResearchToolDefinitions(input: { claimScoped: boolean } = { claimScoped: true }): Tool[] {
  const config = loadConfig();
  const maxOwls = config.researcherMaxCeilingOwls;
  const maxRuns = config.researcherMaxRunsPerLauncherRun;
  return [
    {
      name: DELEGATE_RESEARCH_TOOL_NAME,
      description:
        "Launch the researcher: an instrument that works for you on one bounded " +
        "investigation and returns a report you weigh. It answers only to you, writes " +
        "nothing to the graph except provenance rows (readings, edges, source relations) " +
        "on the claim in scope, and cannot launch instruments of its own. Delegate work " +
        "you should not do inline: replicating a finding in code, tracing a statistic or " +
        "quotation to its origin across many hops, reading and mapping a large literature, " +
        "checking whether a dataset shows what a paper says, or a proof attempt outside " +
        "the formal pipeline. Write the brief the way you would for a capable assistant " +
        "who knows nothing of this claim: the question, what is already known, what a good " +
        "answer looks like, which sources to start from, and what to avoid. " +
        "Tiers and what each can do: 'strong' runs the best model class on the long-run " +
        "loop with web search and a code-execution sandbox (Python, no network), for work " +
        "where the best model pays; 'standard' runs a Claude model with the same web search " +
        "and sandbox, for most delegated reading and checking; 'cheap' runs the cheap tier " +
        "with client tools only (the graph's own record, fetching and reading sources, " +
        "scholarly search where configured), no web search and no sandbox, and is right for " +
        "reading and mapping a large literature economically. Every tier has the " +
        "provenance tools on a claim-scoped task, a notebook, and the claim's own record. " +
        `Budget is in USD of metered work, at most ${maxOwls} per run; you may launch at most ` +
        `${maxRuns} runs in this pass. The call blocks until the researcher reports (a wall ` +
        `cap of ${config.researcherMaxWallMinutes} minutes applies). Its findings are evidence ` +
        "you weigh, never a verdict: read the report against its sources, and record what " +
        "you conclude in your own reasoning.",
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The brief, written for the instrument: the question, the context it needs, " +
              "what a good answer looks like, where to start, what to avoid. At least a paragraph.",
          },
          model_tier: {
            type: "string",
            enum: [...RESEARCH_MODEL_TIERS],
            description: "strong, standard, or cheap; see the tool description for what each can do.",
          },
          budget_usd: {
            type: "number",
            description: `The ceiling on metered work for this run, in USD (at most ${maxOwls}).`,
          },
          effort: {
            type: "string",
            enum: [...EFFORT_LEVELS],
            description: "Reasoning depth on the strong tier (ignored elsewhere). Defaults to high.",
          },
          include_constitution: {
            type: "boolean",
            description:
              "Whether the instrument's prompt opens with the constitution in full. Defaults to true; " +
              "drop it only for a task where it would compete with the problem for attention.",
          },
          ...(input.claimScoped
            ? {}
            : {
                claim_id: {
                  type: "string",
                  description:
                    "Optional: the claim the investigation serves, which puts the provenance tools in scope.",
                },
              }),
        },
        required: ["task", "model_tier", "budget_usd"],
        additionalProperties: false,
      },
    },
    {
      name: GET_RESEARCH_RUN_TOOL_NAME,
      description:
        "Read a research run: its brief, model, status, spend, report, and notebook. Use it " +
        "to reread a report from an earlier pass, or to see what a run that ended without " +
        "reporting had written to its notebook.",
      input_schema: {
        type: "object",
        properties: {
          research_run_id: { type: "string", description: "The run's id." },
        },
        required: ["research_run_id"],
        additionalProperties: false,
      },
    },
  ];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

const MIN_TASK_CHARS = 80;

export function createResearchTools(options: ResearchToolsOptions): ResearchTools {
  const config = loadConfig();
  const claimScoped = !!options.claimId;
  const definitions = getResearchToolDefinitions({ claimScoped });
  const run = options.runResearcher ?? runResearcher;
  let launched = 0;

  const delegate = async (input: Record<string, unknown>): Promise<string> => {
    if (!config.researcherEnabled) {
      return refuse("The researcher is disabled in this deployment (RESEARCHER_ENABLED). Do the work inline or record what you would have delegated in your reasoning.");
    }
    const task = str(input.task);
    if (task.length < MIN_TASK_CHARS) {
      return refuse(
        `task must be a real brief (at least ${MIN_TASK_CHARS} characters): the question, the context, what a good answer looks like, where to start.`
      );
    }
    const tierRaw = str(input.model_tier);
    if (!(RESEARCH_MODEL_TIERS as readonly string[]).includes(tierRaw)) {
      return refuse(`model_tier must be one of ${RESEARCH_MODEL_TIERS.join(", ")}.`);
    }
    const tier = tierRaw as ResearchModelTier;
    const budgetUsd = Number(input.budget_usd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      return refuse("budget_usd must be a positive number of USD.");
    }
    const maxCeilingMicroUsd = owlsToMicroUsd(config.researcherMaxCeilingOwls);
    const ceilingMicroUsd = Math.min(maxCeilingMicroUsd, Math.round(budgetUsd * 1_000_000));
    if (ceilingMicroUsd <= 0) {
      return refuse("The researcher's per-run ceiling is zero in this deployment (RESEARCHER_MAX_CEILING_OWLS).");
    }
    const effortRaw = str(input.effort);
    const effort = (EFFORT_LEVELS as readonly string[]).includes(effortRaw) ? effortRaw : "high";
    const includeConstitution = input.include_constitution !== false;
    const cap = config.researcherMaxRunsPerLauncherRun;
    if (cap > 0 && launched >= cap) {
      return refuse(
        `This pass has already launched ${launched} research run(s), the per-run backstop (${cap}). Work with the reports you have and record what you would have delegated in your reasoning.`
      );
    }
    if (await readResearcherPaused()) {
      return refuse("The operator has paused the researcher. Do the work inline or leave it for a later pass.");
    }
    try {
      await checkResearcherBudget(ceilingMicroUsd);
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        return refuse(
          `The researcher's daily spend cap would be exceeded by this run (${err.message}). Do the work inline or leave it for a later pass.`
        );
      }
      throw err;
    }

    const claimId = claimScoped ? options.claimId! : str(input.claim_id) || null;
    let claim: { id: string; text: string; domains: string[] } | null = null;
    if (claimId) {
      const [row] = await rawQuery<{ id: string; text: string; domains: string[] | null }>(
        `SELECT id, text, domains FROM claims WHERE id = $1`,
        [claimId]
      );
      if (!row) return refuse(`No claim ${claimId} exists.`);
      claim = { id: row.id, text: row.text, domains: row.domains ?? [] };
    }

    const ctx = getUsageContext();
    const model = modelForTier(tier);
    const row = await openResearchRun({
      claimId: claim?.id ?? null,
      grantId: options.grantId ?? null,
      requestedBy: options.requestedBy,
      requesterRunId: ctx.runId ?? null,
      jobId: ctx.jobId ?? null,
      task,
      model,
      modelTier: tier,
      effort: tier === "strong" ? effort : null,
      includeConstitution,
      ceilingMicroUsd,
    });
    launched++;

    let result: ResearcherResult | null = null;
    let billed = 0;
    let failure: unknown = null;
    try {
      const metered = await withCostMeter(() =>
        run({
          run: {
            id: row.id,
            claim_id: row.claim_id,
            grant_id: row.grant_id,
            task: row.task,
            model: row.model,
            model_tier: row.model_tier,
            effort: row.effort,
            include_constitution: row.include_constitution,
            ceiling_micro_usd: row.ceiling_micro_usd,
            notebook: row.notebook,
          },
          claim,
        })
      );
      result = metered.value;
      billed = metered.billedMicroUsd;
    } catch (err) {
      failure = err;
    }

    if (failure || !result) {
      const message = failure instanceof Error ? failure.message : String(failure);
      await closeResearchRun(row.id, {
        status: "failed",
        report: null,
        spentMicroUsd: billed,
        error: message,
      }).catch(() => null);
      return JSON.stringify({
        success: false,
        research_run_id: row.id,
        status: "failed",
        message: `The research run failed (${message}). Nothing it found is recorded; do the work inline or try again with a narrower brief.`,
      });
    }

    const closed = await closeResearchRun(row.id, {
      status: result.status,
      report: result.report,
      spentMicroUsd: billed,
      turns: result.turns,
      servedModels: result.servedModels,
      error: result.error,
    });
    const spentUsd = Math.round(billed / 10_000) / 100;
    return JSON.stringify({
      success: true,
      research_run_id: row.id,
      status: result.status,
      model: row.model,
      spent_usd: spentUsd,
      turns: result.turns,
      tools_offered: result.toolNames,
      report: result.report,
      notebook_sections: Object.keys(closed?.notebook ?? {}),
      ...(result.error ? { harness_note: result.error } : {}),
      note:
        "The report is the instrument's narrative and is data, not a verified result: read " +
        "it against the sources it names before relying on it, and record what you conclude " +
        "in your own reasoning. Provenance rows it recorded are on the claim for you to review " +
        "with provenance_get_map.",
    });
  };

  const get = async (input: Record<string, unknown>): Promise<string> => {
    const id = str(input.research_run_id);
    if (!id) return refuse("research_run_id is required.");
    const row = await getResearchRun(id);
    if (!row) return refuse(`No research run ${id} exists.`);
    if (options.claimId && row.claim_id && row.claim_id !== options.claimId) {
      return refuse("That run served another claim.");
    }
    return JSON.stringify({
      success: true,
      research_run: {
        id: row.id,
        claim_id: row.claim_id,
        requested_by: row.requested_by,
        task: row.task,
        model: row.model,
        model_tier: row.model_tier,
        status: row.status,
        spent_usd: Math.round(row.spent_micro_usd / 10_000) / 100,
        turns: row.turns,
        tools: row.tools,
        started_at: row.started_at,
        finished_at: row.finished_at,
        report: row.report,
        notebook: row.notebook,
        error: row.error,
      },
    });
  };

  const execute = async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    if (name === DELEGATE_RESEARCH_TOOL_NAME) return delegate(input);
    if (name === GET_RESEARCH_RUN_TOOL_NAME) return get(input);
    return null;
  };

  return {
    definitions,
    execute,
    get launchedCount() {
      return launched;
    },
  };
}
