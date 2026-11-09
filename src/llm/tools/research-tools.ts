/**
 * The delegation tools (#298): `delegate_research` and `get_research_run`,
 * one bundle for every administrator that may launch the researcher (the
 * Claim Steward on its claim, the Grantmaker on its mandate).
 *
 * Only the Claim Steward's runs write to the graph. A Grantmaker serves its
 * mandate as well as the graph, and funding is kept apart from what the
 * graph says (constitution §19), so a run it launches gets neither the
 * provenance tools nor an examination: it reads and reports, and anything
 * it finds reaches the graph the way anyone's findings do.
 *
 * Launching is a judgment the administrator makes: what to ask, on which
 * tier, with how much budget, and whether the instrument should carry the
 * constitution. The tool description says what each tier can do, so the
 * brief can be written with the instrument's affordances in mind. What
 * lives here is the mechanism around that judgment: the launcher's own
 * money (a Steward pays from its pass's budget, a Grantmaker from its
 * mandate's uncommitted budget, and each is shown what it has), the daily
 * cap on research no funder pays for (stated in the description on such a
 * pass, with what is left of it in each result), the pause flag, the run
 * row, and the synchronous run itself. There is no count of runs: money
 * bounds them (CLAUDE.md, "Prefer money to counts"). The
 * launcher's tool call blocks until the researcher reports; the report comes back as the tool result and is
 * also kept on the run row for `get_research_run` and for the record.
 *
 * Same factory shape as the report tools: per-run state (how many runs
 * were launched, for the record and tests; nothing limits it) lives in a
 * closure, and `execute` returns null for any name it does not own.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { loadConfig } from "../../config.js";
import {
  contributionBudgetLine,
  mandateContributionBudget,
  reviewCostEstimateMicroUsd,
} from "../../services/contribution-service.js";
import { rawQuery } from "../../db/client.js";
import { resolveProvider } from "../providers/routing.js";
import { LlmBudgetExceededError } from "../errors.js";
import { getUsageContext, passBudgetLeftMicroUsd, runWithUsageContext, withPassBudget } from "../usage-context.js";
import { grantCommittedMicroUsd } from "../../services/regrant-service.js";
import {
  RESEARCH_MODEL_TIERS,
  checkResearcherBudget,
  closeResearchRun,
  getResearchRun,
  launcherWritesGraph,
  modelForTier,
  openResearchRun,
  readResearcherPaused,
  researcherSpentTodayMicroUsd,
  type ResearchModelTier,
  type ResearchRunRow,
} from "../../services/research-run-service.js";
import { runResearcher, type ResearcherInput, type ResearcherResult } from "../agents/researcher.js";
import { allocateMandateToRequest } from "../../services/allocation-service.js";
import { owlsToMicroUsd } from "../../services/owl.js";
import {
  ExaminationError,
  linkResearchRun,
  openExamination,
  type ExaminationRow,
} from "../../services/examination-service.js";

export const DELEGATE_RESEARCH_TOOL_NAME = "delegate_research";
export const GET_RESEARCH_RUN_TOOL_NAME = "get_research_run";
export const FUND_REQUEST_TOOL_NAME = "fund_request";
export const RESEARCH_TOOL_NAMES: readonly string[] = [
  DELEGATE_RESEARCH_TOOL_NAME,
  GET_RESEARCH_RUN_TOOL_NAME,
  FUND_REQUEST_TOOL_NAME,
];

export const EFFORT_LEVELS = ["medium", "high", "max"] as const;

export interface ResearchTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (name: string, input: Record<string, unknown>) => Promise<string | null>;
  /** Runs launched by this launcher run so far: a record, not a limit. */
  readonly launchedCount: number;
}

export interface ResearchToolsOptions {
  /**
   * The agent key recorded as the launcher: claim_steward, grantmaker,
   * curator or audit (RESEARCH_LAUNCHERS). Only a Steward's research writes
   * to the graph; the others read and report.
   */
  requestedBy: string;
  /** The claim the launcher serves; a Grantmaker passes none and may name one per call. */
  claimId?: string | null;
  /** The mandate the launcher serves, when it serves one. */
  grantId?: string | null;
  /** Test seam: the researcher entry point. */
  runResearcher?: (input: ResearcherInput) => Promise<ResearcherResult>;
}

/** The tool definitions, with the affordances of each tier spelled out. */
/**
 * fund_request (Part VIII, Requests): a mandate's Grantmaker puts money on
 * the work on an open request, its row on the action ledger. The request is
 * the brief; the Grantmaker decides whether and how much, and nothing about
 * how the work is done or what it finds. The row runs once its funders,
 * this mandate among them, cover its cost.
 */
export function getFundRequestToolDefinition(): Tool {
  return {
    name: FUND_REQUEST_TOOL_NAME,
    description:
      "Commission the work on an open request in your scope (list_requests shows them), whole, from " +
      "your mandate. The work is a row on the action ledger: a scoping pass while the request has no " +
      "budget (it returns a quote, which becomes the budget), then the full work. You decide whether " +
      "the request is worth doing and the budget it should have to be done properly (set it at the " +
      "high end of what the costing skill says such work costs); the request is the brief, and how " +
      "the work is done and what it finds are not yours to shape. Every outcome is a complete one and " +
      "paid for alike, and is recorded on the request for its keeper to judge. The run starts at once; " +
      "what it does not spend comes back when it settles, and all of it if the request closes first. " +
      "It counts against your daily rate and escrow like any commission.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        budget_usd: { type: "number" },
      },
      required: ["request_id", "budget_usd"],
      additionalProperties: false,
    },
  };
}

/**
 * Which tiers carry the code-execution sandbox in this deployment. The
 * sandbox is an Anthropic server tool, so a tier has it only when its
 * configured model is Anthropic-served (agents/researcher.ts); the launcher
 * is told which, since a replication on a tier without it cannot run code.
 */
export function sandboxTiersSentence(): string {
  const withSandbox = RESEARCH_MODEL_TIERS.filter((t) => {
    const model = modelForTier(t);
    return !!model && resolveProvider(model) === "anthropic";
  });
  const list = (tiers: readonly string[]) => tiers.map((t) => `'${t}'`).join(" and ");
  if (withSandbox.length === RESEARCH_MODEL_TIERS.length) {
    return "Every tier has a code-execution sandbox (Python, no network). ";
  }
  if (withSandbox.length === 0) {
    return "No tier has a code-execution sandbox here: the researcher cannot run code. ";
  }
  const without = RESEARCH_MODEL_TIERS.filter((t) => !withSandbox.includes(t));
  return (
    `${list(withSandbox)} ${withSandbox.length === 1 ? "has" : "have"} a code-execution sandbox ` +
    `(Python, no network); ${list(without)} ${without.length === 1 ? "has" : "have"} none and cannot run code. `
  );
}

export function getResearchToolDefinitions(
  input: {
    claimScoped: boolean;
    graphWrites?: boolean;
    /**
     * Who launches, when the research writes nothing: a mandate's Grantmaker
     * (the default), whose research may submit contributions, or the Curator
     * or the Audit Agent, whose research only reads and reports.
     */
    launcher?: "grantmaker" | "curator" | "audit";
    /** Where the launcher's research money comes from and what it holds now, for the description. */
    funding?: string;
  } = { claimScoped: true }
): Tool[] {
  const config = loadConfig();
  const graphWrites = input.graphWrites ?? true;
  const mandate = !graphWrites && (input.launcher ?? "grantmaker") === "grantmaker";
  const funding =
    input.funding ??
    (!mandate
      ? "Research is paid from this pass's own budget, and a run's budget_usd may be at most what the pass has left. "
      : "Research is paid from the mandate's uncommitted budget, and a run's budget_usd (with any " +
        "contribution_budget_usd) may be at most what that holds. ");
  return [
    {
      name: DELEGATE_RESEARCH_TOOL_NAME,
      description:
        "Launch the researcher: an instrument that works for you on one bounded " +
        "investigation and returns a report you weigh. It answers only to you, writes " +
        (graphWrites
          ? "nothing to the graph except provenance rows (readings, edges, source relations) " +
            "and instances (sources asserting, denying or posing a claim, or asking or answering a " +
            "question) on the node in scope, "
          : mandate
            ? "nothing to the graph directly (research a mandate launches reads and reports; it does " +
              "not record provenance or examine documents, and with contribution_budget_usd it submits " +
              "what the graph should hold as contributions, reviewed like anyone's and paid from that budget), "
            : "nothing to the graph (it reads and reports; it does not record provenance or examine " +
              "documents), ") +
        "and cannot launch instruments of its own. This runs inside your turn: you wait " +
        "for the report. Where commission (kind research) is in your toolset, use it for " +
        "anything longer than a quick check: the research runs on its own while you carry " +
        "on, and its report returns to you. Delegate work " +
        "you should not do inline: replicating a finding in code, tracing a statistic or " +
        "quotation to its origin across many hops, reading and mapping a large literature, " +
        "checking whether a dataset shows what a paper says, or exploring a route to a proof " +
        "(the researcher has no Lean checker, so it brings back a sketch or a lead to weigh, " +
        "never a checked proof; a checked attempt is the solver's, funded through a mandate's " +
        "plan). Write the brief the way you would for a capable assistant " +
        "who knows nothing of this claim: the question, what is already known, what a good " +
        "answer looks like, which sources to start from, and what to avoid. " +
        "Every tier has web search, read_page, the graph's read tools, scholarly search " +
        (graphWrites
          ? "where configured, a notebook, and the provenance tools on a claim-scoped task. "
          : "where configured, and a notebook. ") +
        "Tiers: 'strong' runs the best model class, for a replication or an analysis " +
        "where the best model pays; 'standard' for most delegated reading and checking; " +
        "'cheap' for reading and mapping a large literature economically. " +
        sandboxTiersSentence() +
        "Budget is in USD of metered work. " +
        funding +
        "Each result says what is left after the run. " +
        "The call blocks until the researcher reports (a wall-clock cap of " +
        `${config.researcherMaxWallMinutes} minutes applies, because your run waits on it). Its findings are evidence ` +
        "you weigh, never a verdict: read the report against its sources, and record what " +
        "you conclude in your own reasoning.",
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The brief, written for the instrument: the question, the context it needs, " +
              "what a good answer looks like, where to start, what to avoid. At least 80 characters; " +
              "a real brief is usually a paragraph or more.",
          },
          model_tier: {
            type: "string",
            enum: [...RESEARCH_MODEL_TIERS],
            description: "strong, standard, or cheap; see the tool description for what each can do.",
          },
          budget_usd: {
            type: "number",
            description: "The ceiling on metered work for this run, in USD, paid from your own budget.",
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
          ...(graphWrites ? { examine_source_id: {
            type: "string",
            description:
              "Optional: launch the run as an examination of one document, by its source id. The " +
              "researcher then records what it examined and what it found on the document's own " +
              "passages, a record that outlives the report and that every Steward whose claim " +
              "rests on the document can cite. " +
              (input.claimScoped
                ? "The document must be in your claim's map."
                : "Without a claim_id it is a review of the document for its own sake."),
          },
          facets: {
            type: "array",
            items: { type: "string" },
            description:
              "With examine_source_id: what to check, as short labels (\"data\", \"quotation\", " +
              "\"method\", \"attribution\"). Each facet shares the run's budget.",
          } } : {}),
          ...(mandate
            ? {
                contribution_budget_usd: {
                  type: "number",
                  description:
                    "USD of the mandate's budget delegated for reviewing the contributions the " +
                    "researcher submits from what it finds, each reviewed like anyone's (default 0: " +
                    "it only reports). Separate from budget_usd, which pays for the research itself. " +
                    "The researcher sees what is committed and left, and what a review is expected " +
                    "to cost, and stops submitting when what is left would not cover one; the result " +
                    "tells you what the reviews used.",
                },
              }
            : {}),
          ...(input.claimScoped || !graphWrites
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
    getResearchRunReadToolDefinition(),
  ];
}

/**
 * get_research_run: reading a run's report and notebook. A launcher reads
 * the runs it launched; the keeper of a request, and the Steward of each
 * node it bears on, read the runs that took it up or scoped it (#718). The
 * Curator carries it even where the researcher is off, for the requests it
 * keeps.
 */
export function getResearchRunReadToolDefinition(): Tool {
  return {
    name: GET_RESEARCH_RUN_TOOL_NAME,
    description:
      "Read a research run: its brief, model, status, spend, report, and notebook. Use it " +
      "to reread a report from an earlier pass, to see what a run that ended without " +
      "reporting had written to its notebook, or to read in full the work a Researcher " +
      "returned on a request you keep or that bears on your node (the work's research_run_id, " +
      "in list_requests or in the message that told you of it).",
    input_schema: {
      type: "object",
      properties: {
        research_run_id: { type: "string", description: "The run's id." },
      },
      required: ["research_run_id"],
      additionalProperties: false,
    },
  };
}

/** Who is reading a run: a node's Steward, a mandate's Grantmaker, the Curator or the Audit Agent. */
export interface ResearchRunReader {
  /**
   * The launcher role of a reader that serves no one node or mandate (the
   * Curator, the Audit Agent): it reads the runs its role launched, so a
   * later pass picks up an earlier one's thread.
   */
  role?: string | null;
  /** The node the reader stewards. */
  claimId?: string | null;
  /** The mandate the reader serves. */
  grantId?: string | null;
  /** The Curator, keeper of the requests that bear on several nodes or none. */
  curator?: boolean;
}

/**
 * Whether `reader` may read `row`. A launcher reads its own runs: a Steward
 * those on its node, a Grantmaker those its mandate launched, the Curator
 * and the Audit Agent those their role launched. A run on a
 * request is the request's (Part VIII: what it finds goes to the keeper and
 * to the Steward of each node it bears on), so its keeper and those
 * Stewards read it too.
 */
async function mayReadRun(row: ResearchRunRow, reader: ResearchRunReader): Promise<boolean> {
  if (reader.claimId && row.claim_id === reader.claimId) return true;
  if (!reader.claimId && reader.grantId && row.grant_id === reader.grantId) return true;
  if (!reader.claimId && !reader.grantId && reader.role && row.requested_by === reader.role) return true;
  if (!row.request_id || !(reader.claimId || reader.curator)) return false;
  const [req] = await rawQuery<{ keeper_kind: string; keeper_claim_id: string | null; bears: boolean }>(
    `SELECT r.keeper_kind, r.keeper_claim_id,
            EXISTS (SELECT 1 FROM request_targets t
                     WHERE t.request_id = r.id AND t.claim_id = $2) AS bears
       FROM requests r WHERE r.id = $1`,
    [row.request_id, reader.claimId ?? null]
  );
  if (!req) return false;
  if (reader.curator) return req.keeper_kind === "curator";
  return req.keeper_claim_id === reader.claimId || req.bears;
}

/** get_research_run's result for `reader`. */
export async function readResearchRun(input: Record<string, unknown>, reader: ResearchRunReader): Promise<string> {
  const id = str(input.research_run_id);
  if (!id) return refuse("research_run_id is required.");
  if (!UUID_RE.test(id)) return refuse(`"${id}" is not a research run id.`);
  const row = await getResearchRun(id);
  if (!row) return refuse(`No research run ${id} exists.`);
  if (!(await mayReadRun(row, reader))) {
    return refuse(
      "That run was launched for another claim, mandate or role, and was not on a request " +
        (reader.curator ? "you keep." : "you keep or that bears on your node.")
    );
  }
  return JSON.stringify({
    success: true,
    research_run: {
      id: row.id,
      claim_id: row.claim_id,
      ...(row.request_id ? { request_id: row.request_id } : {}),
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
      ...(await contributionReviews(row.id, row.contribution_budget_micro_usd)),
    },
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

const MIN_TASK_CHARS = 80;
const usdText = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
/**
 * Where a run's delegated review budget stands, for the Grantmaker that
 * delegated it. Reviews run after the research ends, so committed spend
 * keeps moving from estimates to real costs; get_research_run shows it later.
 */
async function contributionReviews(runId: string, budgetMicroUsd: number): Promise<{ contribution_reviews?: string }> {
  if (budgetMicroUsd <= 0) return {};
  const estimate = await reviewCostEstimateMicroUsd();
  return { contribution_reviews: contributionBudgetLine(await mandateContributionBudget(runId, estimate), estimate) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createResearchTools(options: ResearchToolsOptions): ResearchTools {
  const config = loadConfig();
  const claimScoped = !!options.claimId;
  const graphWrites = launcherWritesGraph(options.requestedBy);
  // The Curator and the Audit Agent launch research that reads and reports
  // (Part VIII, Instruments): the Curator owns structure, not sources, and
  // the Audit Agent judges the record rather than adding to it.
  const launcher =
    options.requestedBy === "curator" || options.requestedBy === "audit" ? options.requestedBy : ("grantmaker" as const);
  // A deployment with the researcher off offers nothing: a tool that only
  // refuses would cost every launcher's prompt and invite wasted calls.
  // Only a mandate's Grantmaker funds requests: a Steward files them.
  const fundsRequests = options.requestedBy === "grantmaker";
  // A Steward pays for research from its pass's budget, which the lane
  // funding the pass set; a pass with none (a test, an unfunded lane) has
  // nothing to launch research with, so it is offered only the reading of
  // earlier runs.
  const ctxAtStart = getUsageContext();
  const passLeft = passBudgetLeftMicroUsd(ctxAtStart);
  const paysFromPass = options.requestedBy !== "grantmaker";
  // On a pass no funder pays for, research also shares the operator's
  // daily allowance for such work (#736): stated up front with its reason,
  // and what is left of it today comes back with every launch.
  const unfunded = !ctxAtStart.jobId && !ctxAtStart.userId;
  const unfundedCap =
    unfunded
      ? "This pass is not paid for by a funder, so research it launches also shares the platform's daily " +
        `allowance for research no funder pays for (${usdText(owlsToMicroUsd(config.researcherDailyCapOwls))} a day, ` +
        "UTC), the operator's bound on spend no one has chosen to fund. A launch whose budget_usd would take " +
        "today's spend past it is refused; each result says what is left of it today. "
      : "";
  const stewardFunding =
    paysFromPass && passLeft !== null
      ? `Research is paid from this pass's own budget (${ctxAtStart.passBudget!.source}), which holds ` +
        `${usdText(passLeft)} now, less what the pass spends as it goes; a run's budget_usd may be at most ` +
        "what the pass has left when you launch it. " +
        unfundedCap
      : undefined;
  const definitions = config.researcherEnabled
    ? [
        ...getResearchToolDefinitions({ claimScoped, graphWrites, launcher, funding: stewardFunding }).filter(
          (t) => t.name !== DELEGATE_RESEARCH_TOOL_NAME || !paysFromPass || passLeft !== null
        ),
        ...(fundsRequests ? [getFundRequestToolDefinition()] : []),
      ]
    : [];

  /**
   * What the launcher's own money holds now: a Steward's pass budget less
   * what the pass has spent (research it launched included, since that is
   * added to the pass's meter), or a Grantmaker's mandate budget less
   * committed money.
   */
  const available = async (): Promise<{ microUsd: number; source: string } | null> => {
    if (paysFromPass) {
      const ctx = getUsageContext();
      const left = passBudgetLeftMicroUsd(ctx);
      return left === null ? null : { microUsd: left, source: `this pass's budget (${ctx.passBudget!.source})` };
    }
    if (!options.grantId) return null;
    const [grant] = await rawQuery<{ id: string; budget_job_id: string; budget: string }>(
      `SELECT g.id, g.budget_job_id, j.budget_micro_usd::bigint AS budget
         FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
      [options.grantId]
    );
    if (!grant) return null;
    // Committed money reads metered spend from llm_usage, whose rows are
    // written fire-and-forget, so right after a run it can trail by the
    // run's last call or two.
    const committed = await grantCommittedMicroUsd({ id: grant.id, budgetJobId: grant.budget_job_id });
    return { microUsd: Math.max(0, Number(grant.budget) - committed), source: "the mandate's uncommitted budget" };
  };

  /** What the launcher has left once a run is done, for its result. */
  const budgetLeft = async (): Promise<{ budget_left?: string; unfunded_daily_allowance_left?: string }> => {
    const have = await available();
    return {
      ...(have ? { budget_left: `${usdText(have.microUsd)} left in ${have.source}` } : {}),
      ...(await unfundedAllowanceLeft()),
    };
  };

  /** On an unfunded pass, what is left today of the daily allowance for unfunded research. */
  const unfundedAllowanceLeft = async (): Promise<{ unfunded_daily_allowance_left?: string }> => {
    const ctx = getUsageContext();
    if (ctx.jobId || ctx.userId) return {};
    const cap = owlsToMicroUsd(config.researcherDailyCapOwls);
    const spent = await researcherSpentTodayMicroUsd().catch(() => null);
    if (spent === null) return {};
    return {
      unfunded_daily_allowance_left: `${usdText(Math.max(0, cap - spent))} of ${usdText(cap)} left today (UTC)`,
    };
  };

  /** Refuse a launch the launcher's own money does not cover, saying what it has. */
  const unaffordable = async (askMicroUsd: number): Promise<string | null> => {
    const have = await available();
    if (!have) return refuse("There is no budget of your own here to pay for research.");
    if (askMicroUsd > have.microUsd) {
      return refuse(
        `This run asks for ${usdText(askMicroUsd)}, and ${have.source} has ${usdText(have.microUsd)} left. ` +
          "Ask for what that covers, or do the work inline."
      );
    }
    return null;
  };

  /** The daily cap is the operator's net under research no funder pays for. */
  const checkUnfundedDailyCap = async (ceilingMicroUsd: number): Promise<string | null> => {
    const ctx = getUsageContext();
    if (ctx.jobId || ctx.userId) return null;
    try {
      await checkResearcherBudget(ceilingMicroUsd);
      return null;
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        const left = (await unfundedAllowanceLeft()).unfunded_daily_allowance_left;
        return refuse(
          `This pass is not paid for by a funder, and this run's budget would take today's research no funder pays for past the platform's daily allowance` +
            (left ? ` (${left})` : "") +
            ". Ask for what is left, do the work inline, or leave it for a later pass."
        );
      }
      throw err;
    }
  };
  const run = options.runResearcher ?? runResearcher;
  let launched = 0;

  /**
   * Run the researcher on an opened run row under its own meter, and add
   * what it billed back to the launcher's meter, where the launcher's action
   * and allocation accounting read it.
   */
  const runOnRow = async (
    row: Awaited<ReturnType<typeof openResearchRun>>,
    claim: { id: string; text: string; domains: string[]; kind: string } | null,
    examination: ExaminationRow | null
  ): Promise<{ result: ResearcherResult | null; billed: number; failure: unknown }> => {
    const ctx = getUsageContext();
    let result: ResearcherResult | null = null;
    let billed = 0;
    let failure: unknown = null;
    // The researcher runs under its own meter and its own budget (its
    // ceiling), so its ceiling and its paid tools read only its own spend;
    // that meter shadows the launcher's, so what it billed is added back to
    // the launcher's below, where the launcher's action and allocation
    // accounting read it.
    const launcherMeter = ctx.meter;
    try {
      // A Grantmaker that names a claim attributes the spend to it, as the
      // Steward's context already does.
      const budget = { microUsd: Number(row.ceiling_micro_usd), source: "this research run's ceiling" };
      const metered = await runWithUsageContext(claim ? { claimId: claim.id } : {}, () => withPassBudget(budget, () =>
        run({
          run: {
            id: row.id,
            claim_id: row.claim_id,
            grant_id: row.grant_id,
            requested_by: row.requested_by,
            task: row.task,
            model: row.model,
            model_tier: row.model_tier,
            effort: row.effort,
            include_constitution: row.include_constitution,
            ceiling_micro_usd: row.ceiling_micro_usd,
            notebook: row.notebook,
            job_id: row.job_id,
            contribution_budget_micro_usd: row.contribution_budget_micro_usd,
          },
          claim,
          examination: examination
            ? {
                id: examination.id,
                source_id: examination.source_id,
                source_title: examination.source_title,
                source_url: examination.source_url,
                facets: examination.facets,
                scope: examination.scope,
              }
            : null,
        })
      ));
      result = metered.value;
      billed = metered.billedMicroUsd;
    } catch (err) {
      failure = err;
    }
    if (launcherMeter) launcherMeter.billedMicroUsd += billed;
    return { result, billed, failure };
  };

  const delegate = async (input: Record<string, unknown>): Promise<string> => {
    if (!config.researcherEnabled) {
      return refuse("The researcher is disabled in this deployment (RESEARCHER_ENABLED). Do the work inline or record what you would have delegated in your reasoning.");
    }
    if (!graphWrites && (input.claim_id !== undefined || input.examine_source_id !== undefined || input.facets !== undefined)) {
      return refuse(
        `Research ${launcher === "grantmaker" ? "a mandate launches" : "you launch"} writes nothing to the graph, so it takes no claim_id and examines no document. ` +
          "Name the claims or documents in the brief; the researcher can read them."
      );
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
    const ceilingMicroUsd = Math.round(budgetUsd * 1_000_000);
    // A mandate's research may submit what it finds, its reviews paid from
    // the budget its Grantmaker delegates (Part VIII); a Steward's research
    // records provenance instead.
    let contributionBudgetMicroUsd = 0;
    if (!graphWrites && launcher === "grantmaker" && input.contribution_budget_usd !== undefined) {
      const usd = Number(input.contribution_budget_usd);
      if (!Number.isFinite(usd) || usd < 0) return refuse("contribution_budget_usd must be a non-negative number of USD.");
      contributionBudgetMicroUsd = Math.round(usd * 1_000_000);
    }
    const effortRaw = str(input.effort);
    const effort = (EFFORT_LEVELS as readonly string[]).includes(effortRaw) ? effortRaw : "high";
    const includeConstitution = input.include_constitution !== false;
    if (await readResearcherPaused()) {
      return refuse("The operator has paused the researcher. Do the work inline or leave it for a later pass.");
    }
    const short = (await unaffordable(ceilingMicroUsd + contributionBudgetMicroUsd)) ?? (await checkUnfundedDailyCap(ceilingMicroUsd));
    if (short) return short;

    const claimId = claimScoped ? options.claimId! : str(input.claim_id) || null;
    if (claimId && !UUID_RE.test(claimId)) return refuse(`claim_id "${claimId}" is not a claim id.`);
    let claim: { id: string; text: string; domains: string[]; kind: string } | null = null;
    if (claimId) {
      const [row] = await rawQuery<{ id: string; text: string; domains: string[] | null; kind: string | null }>(
        `SELECT id, text, domains, kind FROM claims WHERE id = $1`,
        [claimId]
      );
      if (!row) return refuse(`No claim ${claimId} exists.`);
      claim = { id: row.id, text: row.text, domains: row.domains ?? [], kind: row.kind ?? "claim" };
    }

    // An examination of a document (#507): opened before the run so the
    // researcher records onto it, and refused before any spend if malformed.
    let examination: ExaminationRow | null = null;
    const examineSourceId = str(input.examine_source_id);
    if (examineSourceId) {
      try {
        examination = await openExamination({
          scope: claim ? "claim" : "document",
          trigger: options.requestedBy === "claim_steward" ? "claim" : "mandate",
          claimId: claim?.id ?? null,
          grantId: options.grantId ?? null,
          sourceId: examineSourceId,
          brief: task,
          facets: input.facets,
          requestedBy: options.requestedBy,
        });
      } catch (err) {
        if (err instanceof ExaminationError) return refuse(err.message);
        throw err;
      }
    } else if (input.facets !== undefined) {
      return refuse("facets go with examine_source_id: name the document to examine.");
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
      contributionBudgetMicroUsd,
    });
    launched++;
    if (examination) await linkResearchRun(examination.id, row.id);

    const { result, billed, failure } = await runOnRow(row, claim, examination);

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
      ...(await budgetLeft()),
      turns: result.turns,
      tools_offered: result.toolNames,
      report: result.report,
      ...(examination ? { examination_id: examination.id } : {}),
      notebook_sections: Object.keys(closed?.notebook ?? {}),
      ...(await contributionReviews(row.id, row.contribution_budget_micro_usd)),
      ...(result.error ? { harness_note: result.error } : {}),
      note:
        "The report is the instrument's narrative and is data, not a verified result: read " +
        "it against the sources it names before relying on it, and record what you conclude " +
        "in your own reasoning." +
        // A mandate's run records no provenance, and its Grantmaker has no
        // provenance tools: only a launcher that writes the graph is pointed
        // at provenance_get_map.
        (graphWrites
          ? " Provenance rows it recorded are on the claim for you to review with provenance_get_map" +
            (examination
              ? ", and its findings on the document are listed there under examinations for you to cite or not."
              : ".")
          : ""),
    });
  };

  const fund = async (input: Record<string, unknown>): Promise<string> => {
    if (!fundsRequests) return refuse("Only a mandate's Grantmaker funds requests.");
    if (!options.grantId) return refuse("There is no mandate here to fund a request from.");
    const requestId = str(input.request_id);
    if (!UUID_RE.test(requestId)) return refuse(`"${requestId}" is not a request id.`);
    const budgetUsd = Number(input.budget_usd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return refuse("budget_usd must be a positive number of USD.");
    const placed = await allocateMandateToRequest({
      grantId: options.grantId,
      requestId,
      microUsd: Math.round(budgetUsd * 1_000_000),
    });
    if (!placed.ok) return refuse(`${placed.message}.`);
    const what = placed.variant === "scope" ? "its scoping pass (it has no budget yet)" : "the full work";
    return JSON.stringify({
      success: true,
      request_id: requestId,
      funded: what,
      status: placed.status,
      budget_usd: usdText(placed.placedMicroUsd),
      note:
        placed.status === "commissioned"
          ? "Commissioned whole: the Researcher takes it up on the next pass with this budget, and its outcome is recorded on the request for its keeper. What it does not spend comes back."
          : "Its next piece of work is already commissioned or running; nothing was charged.",
      ...(await budgetLeft()),
    });
  };

  const get = (input: Record<string, unknown>): Promise<string> =>
    readResearchRun(input, {
      claimId: options.claimId ?? null,
      grantId: options.grantId ?? null,
      // The Curator and the Audit Agent read the runs their role launched.
      role: launcher !== "grantmaker" ? options.requestedBy : null,
      curator: options.requestedBy === "curator",
    });

  const execute = async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    if (name === DELEGATE_RESEARCH_TOOL_NAME) return delegate(input);
    if (name === GET_RESEARCH_RUN_TOOL_NAME) return get(input);
    if (name === FUND_REQUEST_TOOL_NAME) return fund(input);
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
