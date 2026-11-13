/**
 * The research tools besides commissioning (#298): reading research runs
 * (`get_research_run`), and, for a mandate's Grantmaker, funding the work on
 * a request (`fund_request`). Research itself is commissioned with
 * `commission` (kind research): it runs on the ledger while its commissioner
 * carries on, and its report returns into that agent's session, or to its
 * node's inbox, or stays on the run for `get_research_run`. Nothing launches
 * the Researcher inline any more, so no run blocks on one.
 *
 * Also here: the sentences every brief-writer reads about what the
 * Researcher's tiers can do (tools, the sandbox, figures), so a brief is
 * written with the instrument's affordances in mind.
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
import { modelSeesImages } from "../models.js";
import { grantCommittedMicroUsd } from "../../services/regrant-service.js";
import {
  RESEARCH_MODEL_TIERS,
  getResearchRun,
  modelForTier,
  type ResearchRunRow,
} from "../../services/research-run-service.js";
import { type ResearcherInput, type ResearcherResult } from "../agents/researcher.js";
import { allocateMandateToRequest } from "../../services/allocation-service.js";

export const GET_RESEARCH_RUN_TOOL_NAME = "get_research_run";
export const FUND_REQUEST_TOOL_NAME = "fund_request";
export const RESEARCH_TOOL_NAMES: readonly string[] = [
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
      "budget (it returns a quote, which becomes the request's budget_usd and what the full work is " +
      "priced at), then the full work. The run works to the budget you give here, not to the quote: " +
      "you decide whether the request is worth doing and what to pay, and nothing raises a smaller " +
      "budget to the quote. Fund the full work at its quote unless you mean to buy one stage of it. " +
      "A budget below the quote is accepted, and the result says so plainly: that run is told it is " +
      "funded below the quote, does only part of the plan, usually returns partly_met, and is marked " +
      "on the request's work log (funding: \"funded at $X of a $Y quote\"), so read that mark before " +
      "you take an earlier partly_met as what the work can find or pay for another run like it. " +
      "The request is the brief, and how " +
      "the work is done and what it finds are not yours to shape. Every outcome is a complete one and " +
      "paid for alike, and is recorded on the request for its keeper to judge. The run starts at once; " +
      "what it does not spend comes back when it settles, and all of it if the request closes first. " +
      "It counts against your mandate's pace and escrow like any commission.",
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
/**
 * What a Researcher run can use, for whoever writes its brief (#847): a
 * brief that names a tool the Researcher lacks sends the run looking for
 * it. Used by commission (kind research).
 */
export function researcherToolsSentence(graphWrites = true): string {
  return (
    "The researcher's tools are web search, read_page, read_arxiv_source (the TeX, tables and data " +
    "files of an arXiv paper's source), the graph's read tools, query_sql " +
    "(read-only SQL over the graph's public views), scholarly search where configured, " +
    (graphWrites
      ? "a notebook, and the provenance tools on a claim-scoped task. "
      : "and a notebook. ") +
    "It has no others: no Lean checker, no model or other API to call, no GPU, and it cannot " +
    "commission or delegate work of its own, so a brief should not ask for a tool outside this list. "
  );
}

/**
 * Which tiers can look at an image (#912). view_image is offered only to a
 * model that takes images (models.ts, modelSeesImages), so a brief that
 * turns on reading values off a plot has to go to a tier that has it.
 */
export function figureTiersSentence(): string {
  const caveat =
    "a value read off a plot is an estimate, and a figure that exists only as EPS or SVG cannot be shown. ";
  const seeing = RESEARCH_MODEL_TIERS.filter((t) => {
    const model = modelForTier(t);
    return !!model && modelSeesImages(model);
  });
  const list = (tiers: readonly string[]) => tiers.map((t) => `'${t}'`).join(" and ");
  if (seeing.length === RESEARCH_MODEL_TIERS.length) {
    return `Every tier can look at a figure by its image URL (view_image); ${caveat}`;
  }
  if (seeing.length === 0) {
    return (
      "No tier can look at images here, so a value that exists only as a plotted point is beyond the " +
      "researcher; the numbers in a paper's TeX and data files are not. "
    );
  }
  const blind = RESEARCH_MODEL_TIERS.filter((t) => !seeing.includes(t));
  return (
    `${list(seeing)} can look at a figure by its image URL (view_image); ${list(blind)} cannot, and ` +
    `${blind.length === 1 ? "reads" : "read"} only text and source files. Where it can, ${caveat}`
  );
}

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

/**
 * The research tools an agent carries besides commissioning: reading runs.
 * Research itself is commissioned with `commission` (kind research), and
 * its report returns into the commissioning session; nothing launches the
 * Researcher inline any more.
 */
export function getResearchToolDefinitions(): Tool[] {
  return [getResearchRunReadToolDefinition()];
}

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
  // Only a mandate's Grantmaker funds requests: a Steward files them.
  const fundsRequests = options.requestedBy === "grantmaker";
  const launcher =
    options.requestedBy === "curator" || options.requestedBy === "audit" ? options.requestedBy : ("grantmaker" as const);
  // A deployment with the researcher off offers nothing: a tool that only
  // refuses would cost every launcher's prompt and invite wasted calls.
  const definitions = config.researcherEnabled
    ? [getResearchRunReadToolDefinition(), ...(fundsRequests ? [getFundRequestToolDefinition()] : [])]
    : [];

  const fund = async (input: Record<string, unknown>): Promise<string> => {
    if (!fundsRequests) return refuse("Only a mandate's Grantmaker funds requests.");
    if (!options.grantId) return refuse("There is no mandate here to fund a request from.");
    let requestId = str(input.request_id);
    if (!UUID_RE.test(requestId)) return refuse(`"${requestId}" is not a request id.`);
    const budgetUsd = Number(input.budget_usd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return refuse("budget_usd must be a positive number of USD.");
    // A mandate pays for work at its own label (constitution §30). A request
    // filed at a label below is taken up at this one, and the money goes on
    // that request's row: on the row below it would buy a run that reads
    // less than this mandate does, and show the label below that someone
    // above is paying (request-adoption-service.ts).
    const asked = requestId;
    const { requestToActOn } = await import("../../services/request-adoption-service.js");
    const acted = await requestToActOn(asked, { kind: "mandate", grantId: options.grantId });
    requestId = acted.id;
    const placed = await allocateMandateToRequest({
      grantId: options.grantId,
      requestId,
      microUsd: Math.round(budgetUsd * 1_000_000),
    });
    if (!placed.ok) return refuse(`${placed.message}.${acted.note ? ` ${acted.note}` : ""}`);
    const what = placed.variant === "scope" ? "its scoping pass (it has no budget yet)" : "the full work";
    const committed = await grantCommittedMicroUsd({ id: options.grantId, budgetJobId: await budgetJobOf(options.grantId) }).catch(() => null);
    return JSON.stringify({
      success: true,
      request_id: requestId,
      ...(acted.note ? { taken_up_from: asked, taken_up: acted.note } : {}),
      funded: what,
      status: placed.status,
      budget_usd: usdText(placed.placedMicroUsd),
      ...(placed.quote
        ? { quote_usd: usdText(placed.quote.quoteMicroUsd), below_quote: placed.quote.underQuote, quote: placed.quote.note }
        : {}),
      note:
        placed.status === "commissioned"
          ? "Commissioned whole: the Researcher takes it up on the next pass with this budget, and its outcome is recorded on the request for its keeper. What it does not spend comes back."
          : "Its next piece of work is already commissioned or running; nothing was charged.",
      ...(committed !== null ? { committed_usd: usdText(committed) } : {}),
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
    if (name === GET_RESEARCH_RUN_TOOL_NAME) return get(input);
    if (name === FUND_REQUEST_TOOL_NAME) return fund(input);
    return null;
  };

  return { definitions, execute, launchedCount: 0 };
}

async function budgetJobOf(grantId: string): Promise<string> {
  const [g] = await rawQuery<{ budget_job_id: string }>(`SELECT budget_job_id FROM grants WHERE id = $1`, [grantId]);
  return g?.budget_job_id ?? "";
}
