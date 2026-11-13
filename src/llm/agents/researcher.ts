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
 * tools, the claim's instances through record_claim_instance, and the stored
 * copy of a source it fetched, besides the issue reports any agent may raise
 * for the maintainers. Nothing else; a unit test holds that line. A run a Grantmaker launched writes only its
 * notebook: the provenance and examination tools are withheld from it
 * whatever it was given (research-run-service.ts says why).
 *
 * The toolset follows the model. Every tier has web_search, read_page and
 * read_arxiv_source, and a model that takes images has view_image (#912;
 * tools/web-search-tool.ts serves the search on any provider). A
 * strong-tier model runs the long-run loop with the code-execution sandbox;
 * a standard Claude model runs the ordinary loop with the same sandbox; the
 * cheap tier runs the ordinary loop without it, since the sandbox is an
 * Anthropic server tool. The task message tells the researcher which it has.
 */
import { RUN_TURN_GUARD } from "../prompts/turn-budget.js";
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
import { currentLabel, getUsageContext, markCurrentRunPrivate, withAgent, withSkills } from "../usage-context.js";
import {
  CODE_EXECUTION_TOOL,
  estimateBudget,
  MAX_TURNS_GUARD,
  REMINDER_FRACTION,
  STOP_CEILING,
  STOP_PAUSED,
  meterCodeExecution,
  meterMicroUsd,
  spendLine,
  turnUsedCodeExecution,
} from "../instrument-harness.js";
import {
  buildResearcherTaskMessage,
  getResearcherSystemPromptBlocks,
} from "../prompts/researcher.js";
import { listSkills } from "../prompts/skills.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { sanitizeDomains } from "./skill-selection.js";
import {
  executeSkillTool,
  getActiveSkillToolDefinitions,
  isSkillTool,
} from "../tools/skill-tools.js";
import { isLeanTool } from "../tools/lean-tools.js";
import { createWebSearch, WEB_SEARCH_TOOL_NAME } from "../tools/web-search-tool.js";
import { executeReadPage, getReadPageToolDefinition, READ_PAGE_TOOL_NAME } from "../tools/read-page-tool.js";
import { createFigureTools } from "../tools/figure-tools.js";
import type { ToolExecution } from "../tool-output.js";
import { NO_CONNECTION_TOOLS, createConnectionTools } from "../tools/connection-tools.js";
import {
  MAX_PASSAGE_CHARS,
  NO_ANSWER_REASONS,
  answersForLauncher,
  answersInOrder,
  checkValue,
  cutPassage,
  type NoAnswerReason,
  type ReaderAnswer,
  type ReaderQuestion,
} from "../../services/reader-answers.js";
import {
  currentSourceTextRule,
  readerNote,
  recordedSourceAddress,
  sourceTextRuleFor,
  storedTextForPassage,
  withSourceTextRule,
  withoutSourcesNote,
} from "../../services/separate-reader.js";
import { htmlToText } from "../../services/source-map-service.js";

/** The reasons a reader may give for leaving a question unanswered. `not_reached` is the harness's, for a run that ended first. */
const READER_NO_ANSWER = (Object.keys(NO_ANSWER_REASONS) as NoAnswerReason[]).filter((r) => r !== "not_reached");
import { NO_FILE_SET_TOOLS, createFileSetTools, withRunScratch } from "../tools/file-set-tools.js";
import {
  elicitConfigured,
  executeElicitTool,
  getElicitToolDefinitions,
  isElicitTool,
} from "../tools/elicit-tools.js";
import { createPangramTools } from "../tools/pangram-tools.js";
import { createReportTools } from "../tools/report-tools.js";
import { createResearcherReadTools } from "../tools/researcher-read-tools.js";
import {
  executeKindTool,
  getRequestToolDefinitions,
  getResearcherQuestionInstanceToolDefinition,
} from "../tools/kind-tools.js";
import { executeStewardTool, getResearcherInstanceToolDefinition } from "../tools/steward-tools.js";
import { REQUEST_OUTCOMES } from "../../schemas/kinds.js";
import {
  contributionBudgetLine,
  MANDATE_CONTRIBUTION_TYPES,
  RESEARCH_CONTRIBUTION_TYPES,
  mandateContributionBudget,
  reviewCostEstimateMicroUsd,
  submitMandateContribution,
} from "../../services/contribution-service.js";

export { MANDATE_CONTRIBUTION_TYPES, RESEARCH_CONTRIBUTION_TYPES };

/** For research a mandate funds: submit a finding the graph should hold, as a contribution under the mandate. */
export const SUBMIT_CONTRIBUTION_TOOL: Tool = {
  name: "submit_contribution",
  description:
    "Submit something you found that the graph should hold, as a contribution on one node, under the " +
    "mandate (shown as \"a funded mandate\"). It is reviewed like anyone's, at the mandate's expense, " +
    "and the node's Steward decides what it changes; nothing you submit goes onto the page directly. " +
    "Submit only what you established, with its evidence, and only what bears on the node you name; " +
    "everything else belongs in your report. Structure has its own types: two nodes that are one " +
    "(propose_merge, naming the other in merge_target_claim_id), one node that is two (propose_split), " +
    "a better canonical wording (propose_edit, with proposed_text). The same holds for a node's arguments, " +
    "named with argument_id: two that are one inference (propose_merge, with merge_target_argument_id), " +
    "one that is two (propose_split), and a source that makes or attacks one (add_instance). Filed so, an accepted merge or " +
    "split case is carried to the Curator, which adjudicates them; filed as a challenge, it is not.",
  input_schema: {
    type: "object",
    properties: {
      claim_id: { type: "string", description: "The node the contribution bears on." },
      contribution_type: { type: "string", enum: [...RESEARCH_CONTRIBUTION_TYPES] },
      merge_target_claim_id: {
        type: "string",
        description: "propose_merge only: the other node, which claim_id's node duplicates.",
      },
      argument_id: {
        type: "string",
        description:
          "One of the node's arguments, when the contribution is about it: add_instance (a source that makes, " +
          "attacks or mentions the argument), propose_split (it carries several lines of reasoning), or " +
          "propose_merge with merge_target_argument_id (two arguments on the node are one).",
      },
      merge_target_argument_id: {
        type: "string",
        description: "propose_merge of two arguments on the node: the other argument.",
      },
      proposed_text: {
        type: "string",
        maxLength: 2000,
        description: "propose_edit only: the canonical wording you propose, neutral, presupposing no more than it must.",
      },
      content: {
        type: "string",
        description:
          "The contribution, written for the Reviewer and the node's Steward: what you found, with the " +
          "locator and the words or numbers it rests on. For answer_request, name the request id.",
      },
      evidence_urls: { type: "array", items: { type: "string" } },
    },
    required: ["claim_id", "contribution_type", "content"],
    additionalProperties: false,
  },
};

/** The one request tool a run that takes up a request carries. */
const FILE_REQUEST_TOOL: Tool = getRequestToolDefinitions("researcher").find((t) => t.name === "file_request")!;

/**
 * The Steward's record_claim_instance, for a run that records on its claim:
 * without the provenance recording tools a new source the researcher finds
 * asserting the claim could only go in its report, since every one of them
 * needs an instance to record on. claim_id is filled from the run.
 */
const RECORD_INSTANCE_TOOL: Tool = getResearcherInstanceToolDefinition();

/** The same, on a question: record_question_instance, question_id filled from the run. */
const RECORD_QUESTION_INSTANCE_TOOL: Tool = getResearcherQuestionInstanceToolDefinition();

/**
 * record_argument_instance (#541), on the run's node's arguments: a claim's
 * or a quantity's, since a question has no arguments of its own (§7a).
 */
const RECORD_ARGUMENT_INSTANCE_TOOL: Tool = getResearcherArgumentInstanceToolDefinition();
import {
  executeArgumentInstanceTool,
  getResearcherArgumentInstanceToolDefinition,
} from "../tools/argument-instance-tools.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import { leanCheckerConfigured } from "../../services/lean-checker-client.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";
import {
  RESEARCHER_AGENT,
  launcherWritesGraph,
  readResearcherPaused,
  stampResearchRun,
  writeReaderAnswers,
  updateResearchProgress,
  writeResearchNotebookSection,
  type ResearchRunRow,
  type ResearchRunStatus,
} from "../../services/research-run-service.js";

type Tool = Anthropic.Tool;
type ToolUnion = Anthropic.Messages.ToolUnion;

const PROVENANCE_PREFIX = "provenance_";
/**
 * The Provenance skill's one tool without the prefix: it records a stake a
 * source has in what it says (§9). It is offered and withheld with the
 * provenance tools that write.
 */
const SOURCE_INTEREST_TOOL = "record_source_interest";

function isProvenanceTool(name: string): boolean {
  return name.startsWith(PROVENANCE_PREFIX) || name === SOURCE_INTEREST_TOOL;
}

/**
 * The provenance tools that read or record on one node. On a request run
 * bearing on several nodes they take a claim_id naming one of them (#728);
 * provenance_read_source and provenance_record_source_relationship work
 * on sources alone.
 */
const NODE_PROVENANCE_TOOLS = new Set(["provenance_get_map", "provenance_record_reading", "provenance_record_edge"]);

/**
 * A node provenance tool with a claim_id limited to the request's nodes:
 * required, except where the tool can also record on a source alone.
 */
function withRequestNodeId(
  tool: Tool,
  nodes: { id: string; text: string; kind: string }[],
  required = true
): Tool {
  const schema = tool.input_schema as { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    input_schema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        claim_id: {
          type: "string",
          enum: nodes.map((n) => n.id),
          description:
            (required
              ? "The node this call reads or records on: one of the nodes the request bears on ("
              : "The node the record is scoped to, for scope 'claim': one of the nodes the request bears on (") +
            nodes.map((n) => `${n.id}, the ${n.kind} "${n.text.slice(0, 120)}"`).join("; ") +
            ").",
        },
      },
      required: required ? [...new Set([...(schema.required ?? []), "claim_id"])] : (schema.required ?? []),
    },
  };
}
const EXAMINATION_PREFIX = "examination_";

/** Thrown from the ordinary loop's beforeTurn hook to end the run. */
class HarnessStop extends Error {
  constructor(readonly stopReason: "hook" | "max_wall") {
    super(`researcher harness stop: ${stopReason}`);
  }
}

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

export const RESEARCH_OUTCOMES = ["answered", "partly_answered", "not_answered", "ill_posed"] as const;

/** The terminal tool's schema. */
export const RESEARCH_REPORT_TOOL: Tool = {
  name: "report",
  description:
    "End the investigation with your report to the administrator that launched you. " +
    "Call it exactly once: when you have answered the question, exhausted the routes you " +
    "can see, or received the budget notice. A precise negative result is a good outcome.",
  input_schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: [...RESEARCH_OUTCOMES],
        description:
          "answered, partly_answered, not_answered (the routes you could see did not settle it), " +
          "or ill_posed (the question as briefed cannot be answered as asked; say why in answer).",
      },
      answer: {
        type: "string",
        description:
          "The direct answer, conclusion first, as long as it needs to be and no longer, with the " +
          "reading of the brief you took if it was ambiguous.",
      },
      findings: {
        type: "array",
        description: "Each finding a single claim, with the evidence it rests on and your confidence in it.",
        items: {
          type: "object",
          properties: {
            finding: { type: "string" },
            evidence: {
              type: "string",
              description:
                "The source, the locator (page, section, table, or URL), and the exact words or " +
                "numbers that carry the weight, or the computation and its output.",
            },
            confidence: {
              type: "number",
              description: "Your probability, 0 to 1, that the finding is correct as stated.",
            },
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
        description: "What you recorded on the graph (instances, readings, edges, source relations), or 'none'.",
      },
      caveats: { type: "string", description: "What you could not do or check, and why." },
      what_would_change: { type: "string", description: "What evidence would overturn your answer." },
      suggested_next_steps: {
        type: "string",
        description: "What the administrator might do or delegate next.",
      },
    },
    required: ["outcome", "answer", "findings", "sources_consulted", "provenance_recorded", "caveats", "what_would_change", "suggested_next_steps"],
    additionalProperties: false,
  },
};

/**
 * The report a run that takes up a request ends with: the ordinary report,
 * plus the request's outcome (Part VIII). Every outcome is a complete one.
 */
export const REQUEST_REPORT_TOOL: Tool = {
  ...RESEARCH_REPORT_TOOL,
  description:
    RESEARCH_REPORT_TOOL.description +
    " This run takes up a request: request_outcome says what came of it, for its keeper to judge.",
  input_schema: {
    ...RESEARCH_REPORT_TOOL.input_schema,
    properties: {
      ...(RESEARCH_REPORT_TOOL.input_schema.properties as Record<string, unknown>),
      request_outcome: {
        type: "string",
        enum: [...REQUEST_OUTCOMES],
        description:
          "met, partly_met (say which parts in answer), negative (you looked properly and the evidence is " +
          "not there or points the other way), cannot_be_met (with the reason), declined (the request is " +
          "flawed, moot, or could be met only by intrusion), or revise (say how in answer).",
      },
      remaining_budget_usd: {
        type: "number",
        description:
          "When the work stopped short of what the request asks (partly_met, or cannot_be_met for want of " +
          "budget): your estimate of what the rest would cost, in USD. Omit otherwise.",
      },
    },
    required: [...((RESEARCH_REPORT_TOOL.input_schema.required as string[]) ?? []), "request_outcome"],
  },
};

/**
 * The report a run that scopes a request ends with: the ordinary report,
 * with the plan it prices in plan (#732), plus the quote for the full work and
 * what came of the scoping.
 */
export const REQUEST_SCOPE_REPORT_TOOL: Tool = {
  ...RESEARCH_REPORT_TOOL,
  description:
    RESEARCH_REPORT_TOOL.description +
    " This run scopes a request: plan holds the plan for the full work, budget_quote_usd what it would cost.",
  input_schema: {
    ...RESEARCH_REPORT_TOOL.input_schema,
    properties: {
      ...(RESEARCH_REPORT_TOOL.input_schema.properties as Record<string, unknown>),
      request_outcome: {
        type: "string",
        enum: ["scoped", "met", "negative", "cannot_be_met", "declined", "revise"],
        description:
          "scoped (ready to fund at your quote), met or negative (looking answered it), cannot_be_met or " +
          "declined (with the reason), or revise (the request should change first; say how in answer).",
      },
      plan: {
        type: "string",
        description:
          "The plan the quote prices (#732): the steps of the full work in order, what each reads or " +
          "runs, the sources and tools it needs and whether they can be reached, and what each step " +
          "costs on the tier the full work runs on. Funders read it beside the quote. Required when " +
          "request_outcome is scoped.",
      },
      budget_quote_usd: {
        type: "number",
        description:
          "Your estimate of what the full work would cost, in USD, with room for what you could not " +
          "foresee. Required when request_outcome is scoped; it becomes the request's budget.",
      },
    },
    required: [...((RESEARCH_REPORT_TOOL.input_schema.required as string[]) ?? []), "request_outcome"],
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
    "id" | "claim_id" | "grant_id" | "requested_by" | "task" | "model" | "model_tier" | "effort" | "include_constitution" | "ceiling_micro_usd" | "notebook"
  > & {
    job_id?: string | null;
    /**
     * For research a mandate funds: USD (micro) its Grantmaker delegated for
     * reviewing what it submits (Part VIII). 0 or absent offers no
     * submit_contribution tool.
     */
    contribution_budget_micro_usd?: number;
    /**
     * For a run launched as a reader (services/separate-reader.ts): the
     * questions its launching Steward asked. The run then has open to it the
     * sources the Steward is not given, records nothing on the node, and
     * its answers are what comes back.
     */
    questions?: ReaderQuestion[] | null;
    /**
     * For a follow-up: the marks of the run it continues, for the source
     * text that run was given (`source-text@<label>`). The follow-up opens
     * with that run's report and notebook, so it starts with its marks.
     */
    carried_marks?: readonly string[];
  };
  /**
   * The node the run serves. kind is the node's kind; absent is read as
   * "claim". A claim's instances are recorded with record_claim_instance and
   * a question's with record_question_instance; a quantity's figures are not
   * recorded by this run (record_estimate stays the Steward's).
   */
  claim: { id: string; text: string; domains: string[]; kind?: string } | null;
  /**
   * For a run that takes up a request bearing on several nodes (#728): the
   * nodes its provenance tools may record on, each call naming one. A
   * request on one node runs with that node as `claim` instead.
   */
  requestNodes?: { id: string; text: string; domains: string[]; kind: string }[];
  /**
   * For a run on a request: the earlier run whose notebook (and report) the
   * new one opens with (#730), so the next stage begins where it stopped.
   */
  priorRun?: { id: string; status: string; requestedBy: string } | null;
  /**
   * For a scoping run: the tier, model and effort the full work will run on
   * (#732), which the quote must price.
   */
  fullWork?: { tier: string; model: string; effort: string | null } | null;
  /**
   * For a run taking up a request: what the full work was priced at (the
   * request's budget when the run started). The run's own ceiling may be
   * below it, and the task message says so when it is (#885).
   */
  quoteMicroUsd?: number | null;
  /** The document examination this run carries out, when launched as one (#507). */
  examination?: { id: string; source_id: string; source_title: string; source_url: string | null; facets: string[]; scope: string } | null;
  /** For a scoping run on a request bearing on one document alone (#865): the document the full work reviews. */
  documentReview?: { title: string; url: string | null; chars: number | null; segments: number } | null;
  /**
   * Wall-clock cap for the run. Defaults to RESEARCHER_MAX_WALL_MINUTES on a
   * delegated run, whose launcher waits on it, and to the longer
   * RESEARCHER_REQUEST_MAX_WALL_MINUTES backstop on a request run (#734).
   */
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
  /** A reader's answers, in the order its questions were asked. Absent on any other run. */
  answers?: ReaderAnswer[] | null;
}

/**
 * The reader's one way of reaching the Steward that launched it
 * (services/reader-answers.ts). Every field is held to a form, and the
 * words of a passage are taken from the source's stored text, so nothing
 * the reader composes is in an answer.
 */
export const ANSWER_TOOL: Tool = {
  name: "answer",
  description:
    "Answer one of the Steward's questions, in the form it asked. yes_no: value is yes, no or unclear. number: " +
    "value is a number, in the unit asked. date: value is YYYY, YYYY-MM or YYYY-MM-DD. choice: value is one of " +
    "the question's options, exactly as written. passage: value is the words as the source has them, and source " +
    "is required; the words are found in the source's stored text and the passage is taken from there, so a " +
    `paraphrase is refused, and a passage holds at most ${MAX_PASSAGE_CHARS} characters. source is the address ` +
    "of the source the answer rests on: what keep_reading, keep_analysis or keep_file returned, or a recorded " +
    "source's url or id. Give it wherever an answer rests on one. Where the material does not answer the " +
    "question, leave value out and give no_answer. Answering a question again replaces the earlier answer. " +
    "These fields are all that reaches the Steward.",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question's id: q1, q2, ..." },
      value: { type: ["string", "number"], description: "The answer, in the question's form." },
      source: { type: "string", description: "The address of the source the answer rests on." },
      no_answer: {
        type: "string",
        enum: READER_NO_ANSWER,
        description: READER_NO_ANSWER.map((r) => `${r}: ${NO_ANSWER_REASONS[r]}`).join(" "),
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

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
  // The run's scratch directory in the sandbox goes when the run ends
  // (tools/file-set-tools.ts).
  return withAgent(RESEARCHER_AGENT, () =>
    withRunScratch(async () => {
      // Where a node this run serves has a page under a standing showing,
      // the run is given the text of sources that page's readers cannot
      // read only as a reader, whose answers are held to set forms
      // (services/separate-reader.ts). Looked up inside the run, on its own
      // connection; on the public graph this reads nothing.
      const nodeIds = input.claim ? [input.claim.id] : (input.requestNodes ?? []).map((n) => n.id);
      const rule = await sourceTextRuleFor(nodeIds);
      const asReader = (input.run.questions ?? []).length > 0;
      for (const mark of input.run.carried_marks ?? []) markCurrentRunPrivate(mark);
      return withSourceTextRule(rule ? { ...rule, reader: asReader } : null, () => runResearcherImpl(input));
    })
  );
}

async function runResearcherImpl(input: ResearcherInput): Promise<ResearcherResult> {
  const config = loadConfig();
  const now = input.now ?? Date.now;
  const run = input.run;
  const model = run.model;
  // The sandbox is an Anthropic server tool; web search is served on every
  // provider (client-side through OpenRouter elsewhere).
  const sandbox = resolveProvider(model) === "anthropic";
  const longRun = sandbox && modelSupportsLongRun(model);
  const ceiling = Math.max(1, run.ceiling_micro_usd);
  // Nobody blocks on a research run: every one is commissioned on the
  // ledger and its report returns to a session or an inbox when it ends, so
  // its budget bounds it and the wall clock is only a long backstop for a
  // run that has stopped making progress (#734). The task message says so.
  const runsRequest = run.requested_by === "request" || run.requested_by === "request_scope";
  const maxWallMs = input.maxWallMs ?? config.researcherRequestMaxWallMinutes * 60_000;
  const maxTurns = input.maxTurns ?? RUN_TURN_GUARD;

  // Skills load on demand; the claim's recorded domains point to the domain
  // skills that cover its subject. The tools every skill declares for the
  // researcher are offered whether or not it loads the skill, subject to
  // the conditions below.
  // A request on several nodes points to the skills of all of them (#728).
  const requestNodes = input.claim ? [] : (input.requestNodes ?? []);
  const claimDomains = sanitizeDomains([
    ...(input.claim?.domains ?? []),
    ...requestNodes.flatMap((n) => n.domains),
  ]);
  const skillLoader = createSkillLoadTools("researcher", { domains: claimDomains });
  const checker = leanCheckerConfigured(config);
  // Mathlib tools only with a checker to run them (none when mathematics is
  // switched off, src/features.ts); the provenance tools only
  // on a claim, since they read or record on a claim, or on the nodes a
  // request bears on, except that an examination needs
  // provenance_read_source to read its document, and a run taking up a
  // request reads sources whole whatever it bears on (#728); the
  // examination tools only on a run launched as an examination.
  const examination = input.examination ?? null;
  const graphWrites = launcherWritesGraph(run.requested_by);
  const takesUpRequest = run.requested_by === "request";
  const scopesRequest = run.requested_by === "request_scope";
  const onRequestNodes = takesUpRequest && requestNodes.length > 0;
  const requestNodeIds = new Set(requestNodes.map((n) => n.id));
  // A reader (services/separate-reader.ts) answers its launcher's questions
  // and records nothing on the node: of the provenance tools it keeps the
  // one that opens a source.
  const questions = (run.questions ?? []).length > 0 ? run.questions! : null;
  const asReader = questions !== null;
  const sourceTextRule = currentSourceTextRule();
  const skillTools = getActiveSkillToolDefinitions(listSkills(), "researcher")
    .filter(
      (t) =>
        (!asReader || !isProvenanceTool(t.name) || t.name === "provenance_read_source") &&
        (graphWrites || (!isProvenanceTool(t.name) && !t.name.startsWith(EXAMINATION_PREFIX))) &&
        (checker || !isLeanTool(t.name)) &&
        (!isProvenanceTool(t.name) ||
          !!input.claim ||
          onRequestNodes ||
          ((!!examination || takesUpRequest) && t.name === "provenance_read_source")) &&
        (!t.name.startsWith(EXAMINATION_PREFIX) || !!examination)
    )
    .map((t) =>
      !onRequestNodes
        ? t
        : NODE_PROVENANCE_TOOLS.has(t.name)
          ? withRequestNodeId(t, requestNodes)
          : t.name === SOURCE_INTEREST_TOOL
            ? withRequestNodeId(t, requestNodes, false)
            : t
    );

  const elicitTools = elicitConfigured(config) ? await getElicitToolDefinitions(config) : [];
  const pangramTools = createPangramTools({ config });
  // The reading tools of the systems this deployment is connected to, on a
  // run that may record on the graph: one a Steward launched, or one taking
  // up a request. A reading is for a source, and research for a mandate, the
  // Curator or the Audit Agent records none (tools/connection-tools.ts).
  const connectionTools = graphWrites ? await createConnectionTools({ config }) : NO_CONNECTION_TOOLS;
  // The file sets and the sandbox they are explored in, on the same runs
  // and for the same reason: an analysis is for a source.
  const fileSetTools = graphWrites ? await createFileSetTools({ config }) : NO_FILE_SET_TOOLS;
  const graphReadTools = getGraphReadToolDefinitions();
  const graphReadNames = new Set(graphReadTools.map((t) => t.name));
  // What the graph holds about documents, on every run, and about requests,
  // on a run that works one (#746); and the channel to the maintainers that
  // every agent carries, for a tool that failed or misled it (#743).
  const readTools = createResearcherReadTools({ requests: runsRequest });
  const reportTools = createReportTools({ model });
  // An instance is recorded on the run's node on exactly the runs that get
  // the provenance recording tools: a launcher that writes the graph, and a
  // run scoped to a node. A claim proper takes record_claim_instance, a
  // question record_question_instance; a quantity neither.
  const nodeKind = input.claim ? (input.claim.kind ?? "claim") : null;
  const recordsInstances = graphWrites && !asReader && nodeKind === "claim";
  const recordsQuestionInstances = graphWrites && !asReader && nodeKind === "question";
  const recordsArgumentInstances = graphWrites && !asReader && (nodeKind === "claim" || nodeKind === "quantity");
  const submitsContributions =
    run.requested_by === "grantmaker" && !!run.grant_id && (run.contribution_budget_micro_usd ?? 0) > 0;

  // The review budget a Grantmaker delegated, as the researcher sees it: in
  // the task message, after every turn (reviews settle while it works, so
  // committed spend moves from estimates to real costs), and in each
  // submission's result.
  let contributionBudgetNote = "";
  const readContributionBudget = async (): Promise<string> => {
    const estimate = await reviewCostEstimateMicroUsd();
    contributionBudgetNote = contributionBudgetLine(await mandateContributionBudget(run.id, estimate), estimate);
    return contributionBudgetNote;
  };

  const webSearch = createWebSearch(model);
  const figureTools = createFigureTools({ model });
  const tools: ToolUnion[] = [
    ...graphReadTools,
    ...readTools.definitions,
    // SQL over the public views. The Researcher runs inside another run's
    // budget (a commission) or a request's, so it has no commission or
    // petition of its own: what its work shows is needed, its report says.
    getSqlToolDefinition(),
    getReadPageToolDefinition(),
    // What read_page cannot give: a figure looked at, and the source arXiv
    // holds for a paper (#912). Which of them this model can use, the bundle
    // decides (tools/figure-tools.ts).
    ...figureTools.definitions,
    ...elicitTools,
    ...pangramTools.definitions,
    ...connectionTools.definitions,
    ...fileSetTools.definitions,
    ...skillLoader.definitions,
    ...skillTools,
    ...(recordsInstances ? [RECORD_INSTANCE_TOOL] : []),
    ...(recordsQuestionInstances ? [RECORD_QUESTION_INSTANCE_TOOL] : []),
    ...(recordsArgumentInstances ? [RECORD_ARGUMENT_INSTANCE_TOOL] : []),
    ...reportTools.definitions,
    ...(asReader ? [ANSWER_TOOL] : []),
    NOTEBOOK_WRITE_TOOL,
    NOTEBOOK_READ_TOOL,
    // A run that takes up a request reports its outcome, and may file the
    // further request its work shows is needed.
    ...(takesUpRequest
      ? [REQUEST_REPORT_TOOL, FILE_REQUEST_TOOL]
      : scopesRequest
        ? [REQUEST_SCOPE_REPORT_TOOL]
        : [RESEARCH_REPORT_TOOL]),
    // Research a mandate funds submits what the graph should hold as
    // contributions, their reviews paid from the budget its Grantmaker
    // delegated.
    ...(submitsContributions ? [SUBMIT_CONTRIBUTION_TOOL] : []),
    webSearch.tool,
    ...(sandbox ? [CODE_EXECUTION_TOOL] : []),
  ];
  const toolNames = tools.map((t) => (t as { name: string }).name);
  const offered = new Set(toolNames);
  await stampResearchRun(run.id, { runId: getUsageContext().runId ?? null, tools: toolNames });

  // A Grantmaker's task comes out of a funder's private conversation
  // (claim-extras-service.ts), and an Audit Agent's from contexts that can
  // carry operator data, so runs they launch are private
  // (llm/run-visibility.ts). Other launchers' tasks are public.
  if (run.requested_by === "grantmaker" || run.requested_by === "audit") {
    markCurrentRunPrivate(`input:${run.requested_by}-brief`);
  }

  const notebook: Record<string, string> = { ...(run.notebook ?? {}) };
  const system = getResearcherSystemPromptBlocks({
    includeConstitution: run.include_constitution,
  });
  const taskInput = {
    task: run.task,
    requestedBy: run.requested_by,
    contributionBudget: submitsContributions ? await readContributionBudget() : null,
    claim: input.claim ? { id: input.claim.id, text: input.claim.text, kind: input.claim.kind ?? "claim" } : null,
    requestNodes: requestNodes.map(({ id, text, kind }) => ({ id, text, kind })),
    priorRun: input.priorRun ?? null,
    fullWork: input.fullWork ?? null,
    quoteUsd: input.quoteMicroUsd ? input.quoteMicroUsd / 1_000_000 : null,
    examination: examination
      ? { sourceTitle: examination.source_title, sourceUrl: examination.source_url, facets: examination.facets, scope: examination.scope }
      : null,
    documentReview: input.documentReview ?? null,
    budgetUsd: ceiling / 1_000_000,
    model,
    estimate: null,
    maxTurns,
    elicitUsdPerCall: config.elicitUsdPerCall,
    maxWallMinutes: Math.round(maxWallMs / 60_000),
    pangramMaxUsdPerCall:
      config.pangramMaxWords * Math.max(config.pangramAiUsdPerWord, config.pangramPlagiarismUsdPerWord),
    toolNames,
    sandbox,
    notebook,
  };
  // The estimate is sized from the prompt the run will actually carry: the
  // system blocks, the tool definitions, and the task message itself.
  const promptChars =
    system.reduce((n, b) => n + b.length, 0) +
    JSON.stringify(tools).length +
    buildResearcherTaskMessage(taskInput).length;
  const taskMessage = buildResearcherTaskMessage({
    ...taskInput,
    estimate: estimateBudget({ model, ceilingMicroUsd: ceiling, promptChars, longRun }),
  }) + skillLoader.pointerNote + (connectionTools.note ? `\n\n${connectionTools.note}` : "") +
    (fileSetTools.note ? `\n\n${fileSetTools.note}` : "") +
    // What a run on a node under a standing showing is told: a reader what
    // it is for and its questions, any other run what it is not given.
    (asReader
      ? `\n\n${readerNote(sourceTextRule ?? { pageLabel: currentLabel(), withheldLabels: [], reader: true }, questions!)}`
      : sourceTextRule && graphWrites
        ? `\n\n${withoutSourcesNote(sourceTextRule, {
            connections: connectionTools.notOffered ?? [],
            fileSets: fileSetTools.notOffered ?? [],
          })}`
        : "");

  // A reader's answers, by question, as each was checked and stored.
  const given = new Map<string, ReaderAnswer>();
  const executeAnswer = async (toolInput: Record<string, unknown>): Promise<string> => {
    const refuse = (message: string) => JSON.stringify({ success: false, message });
    const id = asString(toolInput.question).trim();
    const question = questions!.find((q) => q.id === id);
    if (!question) return refuse(`There is no question "${id}". The questions are ${questions!.map((q) => q.id).join(", ")}.`);
    const ref = asString(toolInput.source).trim();
    const none = asString(toolInput.no_answer).trim();
    let recorded: ReaderAnswer;
    if (none) {
      if (!(READER_NO_ANSWER as string[]).includes(none)) return refuse(`no_answer is one of ${READER_NO_ANSWER.join(", ")}.`);
      recorded = { question: question.id, answer: null, no_answer: none as NoAnswerReason };
    } else if (question.form === "passage") {
      if (!ref) return refuse("A passage names the source it is from: give source.");
      const stored = await storedTextForPassage(ref);
      if (!stored) {
        return refuse(
          "The graph holds no stored text for a source at that address. Keep the reading, the analysis or the file " +
            "first, and give the address that returns."
        );
      }
      const readable = htmlToText(stored.text);
      const cut = cutPassage(asString(toolInput.value), stored.text, readable === stored.text ? null : readable);
      if (typeof cut === "string") return refuse(cut);
      recorded = { question: question.id, answer: cut, source: stored.address };
    } else {
      const value = checkValue(question, toolInput.value);
      if (typeof value === "string") return refuse(value);
      let source: string | undefined;
      if (ref) {
        const address = await recordedSourceAddress(ref);
        if (!address) {
          return refuse(
            "The graph records no source at that address. Keep the reading, the analysis or the file first, and " +
              "give the address that returns, or leave source out."
          );
        }
        source = address;
      }
      recorded = { question: question.id, answer: value, ...(source ? { source } : {}) };
    }
    given.set(question.id, recorded);
    await writeReaderAnswers(run.id, answersInOrder(questions!, given));
    return JSON.stringify({
      success: true,
      reaches_the_steward: answersForLauncher([question], [recorded])[0],
      not_yet_answered: questions!.filter((q) => !given.has(q.id)).map((q) => q.id),
    });
  };

  let reportInput: Record<string, unknown> | null = null;
  let reminded = false;
  // What the meter read after the previous turn, for the spend line.
  let meterAtLastTurn = 0;
  /**
   * The note after every turn: the spend line, and, once, the wrap-up
   * notice when the reminder fraction is crossed.
   */
  const turnNote = (): string => {
    const spent = meterMicroUsd();
    const spend = spendLine({ spentMicroUsd: spent, ceilingMicroUsd: ceiling, lastTurnMicroUsd: spent - meterAtLastTurn });
    const line = contributionBudgetNote ? `${spend}\n${contributionBudgetNote}` : spend;
    meterAtLastTurn = spent;
    if (!reminded && !halted && spent >= REMINDER_FRACTION * ceiling) {
      reminded = true;
      return `${line}\n\n${WRAP_UP_NOTICE}`;
    }
    return line;
  };
  let halted: string | null = null;
  const servedModels = new Set<string>();
  let lastTurnEndedAt = now();

  const executeNotebookWrite = async (toolInput: Record<string, unknown>): Promise<string> => {
    const section = asString(toolInput.section).trim().slice(0, 200);
    const content = asString(toolInput.content);
    if (!section) return JSON.stringify({ success: false, message: "section is required." });
    notebook[section] = content;
    await writeResearchNotebookSection(run.id, section, content);
    return JSON.stringify({ success: true, section, sections: Object.keys(notebook) });
  };

  const executeTool = async (name: string, toolInput: Record<string, unknown>): Promise<ToolExecution> => {
    // The ordinary loop has no beforeTurn hook, so the ceiling and the pause
    // flag are enforced here too: past either, every call is refused with
    // the instruction to report. The long-run loop stops before the turn.
    if (halted) return JSON.stringify({ success: false, message: halted });
    if (meterMicroUsd() >= ceiling) {
      halted = CEILING_REFUSAL;
      return JSON.stringify({ success: false, message: halted });
    }
    // Only what was offered runs: a name the model invents, or reads off a
    // page, is refused here, whatever executor would otherwise accept it.
    if (!offered.has(name)) {
      return JSON.stringify({ success: false, message: `${name} is not in this run's toolset.` });
    }
    const loaded = await skillLoader.execute(name, toolInput);
    if (loaded !== null) return loaded;
    if (name === "notebook_write") return executeNotebookWrite(toolInput);
    if (name === "notebook_read") return JSON.stringify({ success: true, notebook });
    if (name === ANSWER_TOOL.name) return executeAnswer(toolInput);
    if (name === "report") {
      return JSON.stringify({ success: false, message: "report was already received." });
    }
    if (name === WEB_SEARCH_TOOL_NAME && webSearch.execute) return webSearch.execute(toolInput);
    if (name === READ_PAGE_TOOL_NAME) return (await executeReadPage(name, toolInput))!;
    const figure = await figureTools.execute(name, toolInput);
    if (figure !== null) return figure;
    if (name === FILE_REQUEST_TOOL.name) {
      return (await executeKindTool(name, toolInput, { role: "researcher", model }))!;
    }
    if (name === RECORD_INSTANCE_TOOL.name && input.claim) {
      // The run's claim and no other: the schema has no claim_id, and one
      // the model supplies anyway that names a different claim is refused.
      const named = typeof toolInput.claim_id === "string" ? toolInput.claim_id.trim() : "";
      if (named && named !== input.claim.id) {
        return JSON.stringify({
          success: false,
          message: `This investigation serves claim ${input.claim.id}; record_claim_instance records on it alone.`,
        });
      }
      return executeStewardTool(
        name,
        { ...toolInput, claim_id: input.claim.id },
        { trigger: "research", context: run.task, model, recordedBy: RESEARCHER_AGENT }
      );
    }
    if (name === RECORD_ARGUMENT_INSTANCE_TOOL.name && input.claim && recordsArgumentInstances) {
      // The run's node's arguments and no other: the executor refuses an
      // argument on another node.
      return (await executeArgumentInstanceTool(name, toolInput, {
        recordedBy: RESEARCHER_AGENT,
        nodeId: input.claim.id,
      }))!;
    }
    if (name === RECORD_QUESTION_INSTANCE_TOOL.name && input.claim) {
      // The run's question and no other, as for a claim's instances; the
      // executor checks that an instance_id is this question's and that an
      // answer_id is in its answer set.
      const named = typeof toolInput.question_id === "string" ? toolInput.question_id.trim() : "";
      if (named && named !== input.claim.id) {
        return JSON.stringify({
          success: false,
          message: `This investigation serves question ${input.claim.id}; record_question_instance records on it alone.`,
        });
      }
      return (await executeKindTool(
        name,
        { ...toolInput, question_id: input.claim.id },
        { role: "researcher", claimId: input.claim.id, model, trigger: "research", context: run.task }
      ))!;
    }
    if (name === SUBMIT_CONTRIBUTION_TOOL.name) {
      const submitted = await submitMandateContribution({ researchRunId: run.id, input: toolInput });
      if (submitted.budget) contributionBudgetNote = submitted.budget;
      return JSON.stringify(submitted);
    }
    if (graphReadNames.has(name)) {
      const out = await executeGraphReadTool(name, toolInput);
      if (out !== null) return out;
    }
    const read = await readTools.execute(name, toolInput);
    if (read !== null) return read;
    const sql = await executeSqlTool(name, toolInput);
    if (sql !== null) return sql;
    const issue = await reportTools.execute(name, toolInput);
    if (issue !== null) return issue;
    if (isElicitTool(name)) return executeElicitTool(name, toolInput, config);
    const pangram = await pangramTools.execute(name, toolInput);
    if (pangram !== null) return pangram;
    const connection = await connectionTools.execute(name, toolInput);
    if (connection !== null) return connection;
    const fileSet = await fileSetTools.execute(name, toolInput);
    if (fileSet !== null) return fileSet;
    if (isSkillTool(name)) {
      // Provenance records land on the run's claim and no other: a claim_id
      // in the input that names a different one is refused, not honoured.
      if (isProvenanceTool(name) && input.claim) {
        const named = typeof toolInput.claim_id === "string" ? toolInput.claim_id.trim() : "";
        if (named && named !== input.claim.id) {
          return JSON.stringify({
            success: false,
            message: `This investigation serves claim ${input.claim.id}; provenance tools work on it alone.`,
          });
        }
      }
      // On a request bearing on several nodes, a call that records on a
      // node names one of them, and only one of them (#728).
      if (onRequestNodes && NODE_PROVENANCE_TOOLS.has(name)) {
        const named = typeof toolInput.claim_id === "string" ? toolInput.claim_id.trim() : "";
        if (!requestNodeIds.has(named)) {
          return JSON.stringify({
            success: false,
            message: `${name} records on one of the nodes this request bears on: name it in claim_id (${[...requestNodeIds].join(", ")}).`,
          });
        }
      }
      // An interest scoped to a claim is scoped to one of the request's
      // nodes; one scoped to the source names no node.
      if (onRequestNodes && name === SOURCE_INTEREST_TOOL && toolInput.scope === "claim") {
        const named = typeof toolInput.claim_id === "string" ? toolInput.claim_id.trim() : "";
        if (!requestNodeIds.has(named)) {
          return JSON.stringify({
            success: false,
            message: `With scope 'claim', ${name} records on one of the nodes this request bears on: name it in claim_id (${[...requestNodeIds].join(", ")}).`,
          });
        }
      }
      return executeSkillTool(name, toolInput, {
        role: "researcher",
        ...(input.claim ? { claimId: input.claim.id } : {}),
        ...(examination ? { examinationId: examination.id } : {}),
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
    ...(asReader ? { answers: answersInOrder(questions!, given) } : {}),
  });

  const runLoop = async () => {
    if (longRun) {
      const beforeTurn = async (_state: LongRunLoopState): Promise<{ stop?: string } | void> => {
        if (meterMicroUsd() >= ceiling) return { stop: STOP_CEILING };
        if (await readResearcherPaused()) return { stop: STOP_PAUSED };
        return undefined;
      };
      // The spend line rides on every turn's user message. The dollar
      // ceiling is the run's only budget: no provider task budget is sent
      // (instrument-harness.ts says why).
      const reminder = (): string => turnNote();
      const afterTurn = async (state: LongRunLoopState, result: ToolCompletionResult) => {
        const served = result.servedModel ?? result.model;
        if (served) servedModels.add(served);
        const endedAt = now();
        if (turnUsedCodeExecution(result)) {
          await meterCodeExecution((endedAt - lastTurnEndedAt) / 1000);
        }
        lastTurnEndedAt = endedAt;
        if (submitsContributions) await readContributionBudget();
        await progress(state.turn);
      };
      const loop = await longRunToolLoop({
        initialMessages: [{ role: "user", content: taskMessage }],
        tools,
        system,
        model,
        effort: (run.effort as "medium" | "high" | "max" | null) ?? "high",
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

    // The ordinary loop. Its beforeTurn hook is the backstop the executor
    // cannot be alone, since server tools and pause_turn continuations never
    // reach the executor: it ends the run at the wall cap, and at the
    // ceiling or the operator's pause it allows one last turn, in which
    // every tool call is refused with the instruction to report, and then
    // ends the run. The spend line, and the wrap-up notice once past the
    // reminder fraction, ride on every turn's note. toolUseLoop meters the
    // container time of each turn that used the sandbox into the same meter.
    let turns = 0;
    let lastTurn = false;
    const startedAt = now();
    const beforeTurn = async (turn: number) => {
      if (now() - startedAt >= maxWallMs) throw new HarnessStop("max_wall");
      if (!halted) {
        if (meterMicroUsd() >= ceiling) halted = CEILING_REFUSAL;
        else if (await readResearcherPaused()) halted = PAUSED_REFUSAL;
      }
      if (halted) {
        if (lastTurn) throw new HarnessStop("hook");
        lastTurn = true;
      }
      turns = turn + 1;
      if (submitsContributions) await readContributionBudget();
      await progress(turns);
    };
    let stopped: HarnessStop | null = null;
    let result: ToolCompletionResult | null = null;
    try {
      result = await toolUseLoop({
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
        beforeTurn,
        // The spend line replaces the turn counter: dollars bind first.
        turnNote: () => turnNote(),
        executeTool,
        onFinalTool,
      });
    } catch (err) {
      if (!(err instanceof HarnessStop)) throw err;
      stopped = err;
    }
    const served = result ? (result.servedModel ?? result.model) : null;
    if (served) servedModels.add(served);
    const hookStop = halted === CEILING_REFUSAL ? STOP_CEILING : halted === PAUSED_REFUSAL ? STOP_PAUSED : undefined;
    const stopReason = reportInput
      ? "final_tool"
      : stopped
        ? stopped.stopReason
        : result?.stopReason === "max_tokens"
          ? "max_tokens"
          : turns >= maxTurns
            ? "max_iterations"
            : "end_turn";
    return { turns, stopReason, hookStop };
  };
  let loop: { turns: number; stopReason: string; hookStop?: string };
  try {
    loop = await withSkills([], () => runLoop());
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
    "no_report",
    loop.turns,
    loop.stopReason,
    `the researcher ended (${loop.stopReason}) without calling report`
  );
}
