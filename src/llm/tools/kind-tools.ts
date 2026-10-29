/**
 * Tools for the kinds of node and for requests (constitution §2, §3, §7,
 * §7a, §10, Part VIII).
 *
 * - Quantity tools, for the Steward of a quantity and for any Steward that
 *   meets a figure: set_quantity_definition, record_estimate,
 *   update_quantity_estimate, record_quantity_reading, set_argument_shows,
 *   record_cut.
 * - Question tools, for the Question Steward: add_presupposition,
 *   add_subquestion, add_answer, remove_answer, set_answer_relation,
 *   update_question_assessment, record_question_instance.
 * - Request tools, for Stewards and the Curator: file_request,
 *   list_requests, revise_request, close_request; the Curator also has
 *   set_request_targets.
 * - change_node_kind, for the Curator.
 *
 * The services (quantity-service, question-service, request-service,
 * reconciliation-service) hold the invariants; these tools translate a
 * model's call into a service call and a refusal into a message the agent
 * can act on. `executeKindTool` returns null for a name it does not own.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { ZodError } from "zod";
import { rawQuery, withTransaction } from "../../db/client.js";
import { claims } from "../../db/schema.js";
import { loadConfig } from "../../config.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { getOrCreateSource } from "../../services/source-service.js";
import { insertRelationshipEdge } from "../../services/relationship-service.js";
import { enqueueClaimPipeline, enqueueSteward } from "../../services/queue-service.js";
import { parseClaimLinks } from "../../services/argument-service.js";
import { KindError, lockNodeKind } from "../../services/node-kind.js";
import {
  addReading,
  defineQuantity,
  recordCut,
  recordEstimate,
  setArgumentShows,
  setStatedEstimate,
} from "../../services/quantity-service.js";
import {
  addAnswer,
  addSubquestion,
  recordQuestionAssessment,
  setAnswerRelation,
  setQuestionInstance,
} from "../../services/question-service.js";
import {
  RequestError,
  fileRequest,
  listRequests,
  reviseRequest,
  setRequestState,
  setRequestTargets,
} from "../../services/request-service.js";
import { changeNodeKind } from "../../services/reconciliation-service.js";
import {
  ANSWER_BASES,
  ANSWER_RELATIONS,
  ESTIMATE_FORMS,
  NODE_KINDS,
  QUANTITY_UNIT_KINDS,
  QUESTION_STANDINGS,
  quantityDefinitionSchema,
  type NodeKind,
  type QuantityDefinitionInput,
} from "../../schemas/kinds.js";
import { getUsageContext } from "../usage-context.js";

/** Who is calling, and on which node. */
export interface KindToolContext {
  role: "claim_steward" | "question_steward" | "curator" | "researcher" | "grantmaker";
  /** The node this run stewards; absent for the Curator. */
  claimId?: string | null;
  model?: string | null;
  trigger?: string | null;
  context?: string | null;
}

// ---------------------------------------------------------------------------
// Schemas the tools share
// ---------------------------------------------------------------------------

const ESTIMATE_SCHEMA = {
  type: "object",
  description:
    "A value at the precision the evidence supports (§10). form is one of: distribution " +
    "(quantiles, at least two, as {p, v} with P(value <= v) = p, p strictly between 0 and 1, " +
    "increasing), interval (low and high, with level the coverage, 0.9 for a 90% interval), " +
    "bound (bound: {side: above|below, value}), magnitude (magnitude: the power of ten), point " +
    "(central), or none (reason: why no figure can be given). central may accompany any form. " +
    "outside: {share, meaning} when some probability lies outside every value, as when the " +
    "event a date refers to may not happen.",
  properties: {
    form: { type: "string", enum: [...ESTIMATE_FORMS] },
    quantiles: {
      type: "array",
      items: {
        type: "object",
        properties: { p: { type: "number" }, v: { type: "number" } },
        required: ["p", "v"],
      },
    },
    low: { type: "number" },
    high: { type: "number" },
    level: { type: "number" },
    central: { type: "number" },
    bound: {
      type: "object",
      properties: { side: { type: "string", enum: ["above", "below"] }, value: { type: "number" } },
      required: ["side", "value"],
    },
    magnitude: { type: "number" },
    shape: { type: "string", description: "The distribution's shape in a few words, where it matters." },
    reason: { type: "string" },
    outside: {
      type: "object",
      properties: { share: { type: "number" }, meaning: { type: "string" } },
      required: ["share", "meaning"],
    },
  },
  required: ["form"],
} as const;

const UNIT_SCHEMA = {
  type: "object",
  description:
    "What the value is measured in. kind: proportion (0..1), count (with noun: deaths, stars), " +
    "currency (with currency: USD), temperature (with symbol), year (a calendar year), duration " +
    "(with symbol: years), rate (with noun and per: per year), or measure (anything else, with " +
    "symbol). scale: linear or log, where you have a view. min and max: the value's natural bounds.",
  properties: {
    kind: { type: "string", enum: [...QUANTITY_UNIT_KINDS] },
    symbol: { type: "string" },
    noun: { type: "string" },
    currency: { type: "string" },
    per: { type: "string" },
    scale: { type: "string", enum: ["linear", "log"] },
    min: { type: "number" },
    max: { type: "number" },
  },
  required: ["kind"],
} as const;

const SHOWS_SCHEMA = {
  type: "object",
  description:
    "What the argument shows about the value (§7): text in your words, and range where the " +
    "argument places the value on its axis. range.side: at (a figure, in low), about (roughly " +
    "a figure, in low), between (low and high), above (low; inclusive for 'at least'), below " +
    "(high; inclusive for 'at most'). Omit range for an argument that the value is ill defined " +
    "or cannot be known.",
  properties: {
    text: { type: "string" },
    range: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["at", "about", "between", "above", "below"] },
        low: { type: "number" },
        high: { type: "number" },
        inclusive: { type: "boolean" },
      },
      required: ["side"],
    },
  },
  required: ["text"],
} as const;

const DEFINITION_PROPERTIES = {
  measures: {
    type: "string",
    description: "What the value is a value of, stated so that it settles what would count as the value.",
  },
  population: { type: "string", description: "The population or scope, where one applies." },
  conditions: { type: "string", description: "Conditions, period, or method that the definition fixes." },
  unit: UNIT_SCHEMA,
} as const;

const SOURCE_PROPERTIES = {
  url: { type: "string", description: "URL of the source you read; sources are found or created by URL." },
  title: { type: "string", description: "Title of the source." },
  speaker: { type: "string", description: "Who stated it, where identifiable." },
  publication: { type: "string" },
  source_date: { type: "string", description: "ISO-8601 to the precision known; omit rather than guess." },
} as const;

const NEW_NODE_PROPERTIES = {
  new_text: {
    type: "string",
    description:
      "Instead of an existing id: the text of a new node to create, only after match_claim found " +
      "no existing node. For a quantity, its definition in words.",
  },
  new_kind: { type: "string", enum: [...NODE_KINDS], description: "The new node's kind (default claim)." },
  new_definition: {
    type: "object",
    description: "For a new quantity: its definition.",
    properties: DEFINITION_PROPERTIES,
    required: ["measures", "unit"],
  },
  importance: { type: "number", description: "The new node's importance, 0..1, as for a subclaim." },
} as const;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function getQuantityToolDefinitions(): Tool[] {
  return [
    {
      name: "set_quantity_definition",
      description:
        "Set or revise the definition of a quantity you steward (§3): what its value is a value " +
        "of, for what population, under what conditions, in what unit. A definition change that " +
        "different considerations would bear on makes a different quantity: escalate it instead.",
      input_schema: {
        type: "object" as const,
        properties: { claim_id: { type: "string" }, ...DEFINITION_PROPERTIES },
        required: ["claim_id", "measures", "unit"],
      },
    },
    {
      name: "record_estimate",
      description:
        "Record a source's statement of a quantity's value (a figure, a range, a bound) as an " +
        "instance of that quantity (§4): what the source said, as it said it, never your own " +
        "estimate. Pass instance_id to record the figure on an instance already recorded; " +
        "otherwise url and the passage. verbatim_text may be omitted for a figure read from a " +
        "table. argument_id names the quantity's argument that rests on this figure, if one does.",
      input_schema: {
        type: "object" as const,
        properties: {
          quantity_id: { type: "string", description: "The quantity (find it with match_claim)." },
          instance_id: { type: "string" },
          ...SOURCE_PROPERTIES,
          verbatim_text: { type: "string", description: "The passage that states the figure, verbatim." },
          stated: ESTIMATE_SCHEMA,
          argument_id: { type: "string" },
        },
        required: ["quantity_id", "stated"],
      },
    },
    {
      name: "update_quantity_estimate",
      description:
        "Record your assessment of a quantity you steward: your own probability distribution " +
        "over its value, all things considered, not an average of the sources (§10), at the " +
        "resolution the evidence supports. State intervals as 90% intervals. assessment is the " +
        "reader-facing account; work shows which figures and arguments the estimate rests on, how " +
        "you combined them, and the arithmetic. Both may link nodes as [[claim:<uuid>|phrase]].",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          estimate: ESTIMATE_SCHEMA,
          assessment: { type: "string" },
          work: { type: "string" },
        },
        required: ["claim_id", "estimate", "assessment", "work"],
      },
    },
    {
      name: "record_quantity_reading",
      description:
        "Record a reading of an instrument (a survey, a test, a register, a model) taken to " +
        "indicate a quantity (§3): evidence about it, not its value. measured is what the " +
        "instrument actually measured; figure is its reading; bearing is how far that speaks to " +
        "the quantity. Where that connection is disputed or carries weight, state it as a claim " +
        "and pass bearing_claim_id.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The quantity." },
          ...SOURCE_PROPERTIES,
          measured: { type: "string" },
          figure: { type: "string" },
          bearing: { type: "string" },
          bearing_claim_id: { type: "string" },
        },
        required: ["claim_id", "url", "measured", "figure", "bearing"],
      },
    },
    {
      name: "set_argument_shows",
      description:
        "Record what an argument about a quantity shows about its value (§7). An argument about " +
        "a quantity has no for or against: it argues for a value or a range, that the value is " +
        "higher or lower than something, or that the quantity is ill defined or cannot be known.",
      input_schema: {
        type: "object" as const,
        properties: { argument_id: { type: "string" }, shows: SHOWS_SCHEMA },
        required: ["argument_id", "shows"],
      },
    },
    {
      name: "record_cut",
      description:
        "Record that the claim you steward says which side of a figure a quantity lies (\"the " +
        "toll exceeded 50 million\"), so its credence is read against the quantity's estimate " +
        "(§21). Only for a claim that has standing of its own; a statement about a value " +
        "otherwise belongs on the quantity as an estimate.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          quantity_id: { type: "string" },
          direction: { type: "string", enum: ["above", "below"] },
          value: { type: "number" },
        },
        required: ["claim_id", "quantity_id", "direction", "value"],
      },
    },
  ];
}

export function getQuestionToolDefinitions(): Tool[] {
  return [
    {
      name: "add_presupposition",
      description:
        "Record what the question presupposes, as a claim (§7a). Pass claim_id for an existing " +
        "claim, or new_text after match_claim found none.",
      input_schema: {
        type: "object" as const,
        properties: {
          question_id: { type: "string" },
          claim_id: { type: "string" },
          ...NEW_NODE_PROPERTIES,
          reasoning: { type: "string" },
        },
        required: ["question_id", "reasoning"],
      },
    },
    {
      name: "add_subquestion",
      description:
        "Attach a subquestion whose answer this question needs. Pass subquestion_id for an " +
        "existing question, or new_text after match_claim found none.",
      input_schema: {
        type: "object" as const,
        properties: {
          question_id: { type: "string" },
          subquestion_id: { type: "string" },
          ...NEW_NODE_PROPERTIES,
          reasoning: { type: "string" },
        },
        required: ["question_id", "reasoning"],
      },
    },
    {
      name: "add_answer",
      description:
        "Add a candidate answer, a claim or a quantity, to the question's set (§7a), or change " +
        "why it is there. basis: quality (a serious answer whoever holds it), prominence (widely " +
        "held or cited), or both. Pass answer_id for an existing node, or new_text (with new_kind " +
        "and, for a quantity, new_definition) after match_claim found none.",
      input_schema: {
        type: "object" as const,
        properties: {
          question_id: { type: "string" },
          answer_id: { type: "string" },
          ...NEW_NODE_PROPERTIES,
          basis: { type: "string", enum: [...ANSWER_BASES] },
          reasoning: { type: "string" },
        },
        required: ["question_id", "basis", "reasoning"],
      },
    },
    {
      name: "remove_answer",
      description: "Take a node out of the question's answer set, saying why.",
      input_schema: {
        type: "object" as const,
        properties: { question_id: { type: "string" }, answer_id: { type: "string" }, reasoning: { type: "string" } },
        required: ["question_id", "answer_id", "reasoning"],
      },
    },
    {
      name: "set_answer_relation",
      description:
        "Record whether two of the question's answers exclude each other or can both be true.",
      input_schema: {
        type: "object" as const,
        properties: {
          question_id: { type: "string" },
          answer_a: { type: "string" },
          answer_b: { type: "string" },
          relation: { type: "string", enum: [...ANSWER_RELATIONS] },
          reasoning: { type: "string" },
        },
        required: ["question_id", "answer_a", "answer_b", "relation"],
      },
    },
    {
      name: "update_question_assessment",
      description:
        "Record your assessment of the question you steward: your best answer, as directly as a " +
        "claim's assessment, and how well answered the question is (§10). standing: answered " +
        "(favor exactly one answer), leaning (favor one or more), open (examined and level), " +
        "ill_posed (a presupposition fails or the question has no answer of the kind it asks " +
        "for), or unknown (too little is known to say). assessment is the reader-facing account; " +
        "reasoning_trace the audit record. incomplete: your note when the answer set is missing " +
        "a serious answer you could not yet add.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          standing: { type: "string", enum: [...QUESTION_STANDINGS] },
          favored_answer_ids: { type: "array", items: { type: "string" } },
          assessment: { type: "string" },
          reasoning_trace: { type: "string" },
          incomplete: { type: "string" },
        },
        required: ["claim_id", "standing", "assessment", "reasoning_trace"],
      },
    },
    {
      name: "record_question_instance",
      description:
        "Record where a source asks the question or answers it (§4, §7a), as the source puts it. " +
        "For an answering source, answer_id names the answer node its answer matches. Pass " +
        "instance_id to reclassify an instance already recorded; otherwise url and the passage.",
      input_schema: {
        type: "object" as const,
        properties: {
          question_id: { type: "string" },
          instance_id: { type: "string" },
          ...SOURCE_PROPERTIES,
          role: { type: "string", enum: ["asks", "answers"] },
          verbatim_text: { type: "string" },
          answer_id: { type: "string" },
        },
        required: ["question_id", "role"],
      },
    },
  ];
}

export function getRequestToolDefinitions(role: KindToolContext["role"]): Tool[] {
  const tools: Tool[] = [
    {
      name: "file_request",
      description:
        "File a request (Part VIII): something that would improve what the graph knows and that " +
        "you are not doing in this run, beside your work, not in place of it. ask: what is " +
        "asked for. why: what your judgment would become under its possible outcomes. " +
        "satisfied_by: what would satisfy it. A request asks for what would decide the matter " +
        "either way, never a particular result. It bears on nodes (claim_ids), sources " +
        "(source_urls), or something the graph does not hold yet (bears_on_text). Look at the " +
        "open requests first (list_requests) and join one that asks for the same thing.",
      input_schema: {
        type: "object" as const,
        properties: {
          ask: { type: "string" },
          why: { type: "string" },
          satisfied_by: { type: "string" },
          who_could: { type: "string", description: "Who could do it and what it would take, where you know." },
          addressed_to: { type: "string", description: "A party it is put to; omit to leave it open to anyone." },
          claim_ids: { type: "array", items: { type: "string" } },
          source_urls: { type: "array", items: { type: "string" } },
          bears_on_text: { type: "string" },
        },
        required: ["ask", "why", "satisfied_by"],
      },
    },
    {
      name: "list_requests",
      description:
        "List requests: those bearing on a node (claim_id), or with live: true only the ones " +
        "still open to work. Each comes with its keeper and the work done on it.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          live: { type: "boolean" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "revise_request",
      description:
        "Sharpen a request you keep: reword what it asks, why, or what would satisfy it, or put " +
        "it to a party. Keep its sense; a different ask is a different request.",
      input_schema: {
        type: "object" as const,
        properties: {
          request_id: { type: "string" },
          ask: { type: "string" },
          why: { type: "string" },
          satisfied_by: { type: "string" },
          who_could: { type: "string" },
          addressed_to: { type: "string" },
        },
        required: ["request_id"],
      },
    },
    {
      name: "close_request",
      description:
        "Close a request you keep. met: the work returned meets it. declined: it asks for a " +
        "particular result, or could be met only by intrusion. moot: it no longer bears on " +
        "anything, or duplicates another (name it). The note says why, and is shown with it.",
      input_schema: {
        type: "object" as const,
        properties: {
          request_id: { type: "string" },
          state: { type: "string", enum: ["met", "declined", "moot"] },
          note: { type: "string" },
        },
        required: ["request_id", "state", "note"],
      },
    },
  ];
  if (role === "curator") {
    tools.push({
      name: "set_request_targets",
      description:
        "Set what a request bears on, as the graph comes to hold it. A request that comes to bear " +
        "on one node alone passes to that node's Steward; you keep the others.",
      input_schema: {
        type: "object" as const,
        properties: {
          request_id: { type: "string" },
          claim_ids: { type: "array", items: { type: "string" } },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: ["request_id", "claim_ids"],
      },
    });
  }
  return tools;
}

export function getChangeKindToolDefinition(): Tool {
  return {
    name: "change_node_kind",
    description:
      "Correct a node created as the wrong kind (§2, §7a), keeping its identity: a question that " +
      "asks whether X is so becomes the claim X, one that asks for a value becomes the quantity, " +
      "a claim that names a value becomes the quantity. The old kind's verdict, estimate or " +
      "standing is retired to history, instance stances are mapped, and the node's Steward is " +
      "asked to re-judge. A quantity needs its definition. Reversible.",
    input_schema: {
      type: "object" as const,
      properties: {
        claim_id: { type: "string" },
        to: { type: "string", enum: [...NODE_KINDS] },
        definition: {
          type: "object",
          properties: DEFINITION_PROPERTIES,
          required: ["measures", "unit"],
        },
        reasoning: { type: "string" },
      },
      required: ["claim_id", "to", "reasoning"],
    },
  };
}

/** Every name this module executes. */
export const KIND_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...getQuantityToolDefinitions().map((t) => t.name),
  ...getQuestionToolDefinitions().map((t) => t.name),
  ...getRequestToolDefinitions("curator").map((t) => t.name),
  getChangeKindToolDefinition().name,
]);

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ok(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, message, ...extra });
}
function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function optStr(v: unknown): string | undefined {
  const s = str(v);
  return s || undefined;
}
function ids(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : [];
}
function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");
}

/** Bounce a text that links a node which does not exist (as update_claim_assessment does). */
async function unknownLinks(...texts: string[]): Promise<string[]> {
  const linked = [...new Set(texts.flatMap((t) => parseClaimLinks(t).map((l) => l.claimId)))];
  if (linked.length === 0) return [];
  const found = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = ANY($1::uuid[])`, [linked]);
  const have = new Set(found.map((r) => r.id));
  return linked.filter((id) => !have.has(id));
}

async function nodeKind(claimId: string): Promise<NodeKind | null> {
  if (!UUID_RE.test(claimId)) return null;
  const [row] = await rawQuery<{ kind: NodeKind }>(`SELECT kind FROM claims WHERE id = $1 AND state = 'active'`, [claimId]);
  return row?.kind ?? null;
}

/**
 * Mint a node of any kind as a dependency of `parentId`, embedded and
 * onboarded like a new subclaim. Returns its id. The definition of a new
 * quantity is validated before anything is written.
 */
async function mintNode(input: {
  text: string;
  kind: NodeKind;
  definition?: unknown;
  importance?: number;
  parentId: string;
  createdBy: string;
}): Promise<string> {
  const definition: QuantityDefinitionInput | null =
    input.kind === "quantity" ? quantityDefinitionSchema.parse(input.definition ?? undefined) : null;
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(input.text);
  } catch {
    // Continue without an embedding, as subclaim creation does.
  }
  const [parent] = await rawQuery<{ claim_type: string; domains: string[] }>(
    `SELECT claim_type, domains FROM claims WHERE id = $1`,
    [input.parentId]
  );
  const { stewardEnqueueMinImportance, pipelineEpoch } = loadConfig();
  const importance = input.importance === undefined ? undefined : Math.min(1, Math.max(0, input.importance));
  const gated = stewardEnqueueMinImportance > 0 && (importance ?? 0.5) < stewardEnqueueMinImportance;
  const id = await withTransaction(async (tx) => {
    const [created] = await tx.db
      .insert(claims)
      .values({
        text: input.text,
        kind: input.kind,
        claimType: (parent?.claim_type ?? "empirical_derived") as "empirical_derived",
        embedding: embedding ?? undefined,
        ...(importance !== undefined ? { importance } : {}),
        ...(gated ? { stewardState: "deferred" } : {}),
        ...(parent?.domains?.length ? { domains: parent.domains, domainsSource: "inherited" } : {}),
        pipelineEpoch,
        createdBy: input.createdBy,
      })
      .returning({ id: claims.id });
    if (definition) {
      await tx.query(
        `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          created!.id,
          definition.measures,
          definition.population ?? null,
          definition.conditions ?? null,
          JSON.stringify(definition.unit),
          input.createdBy,
        ]
      );
    }
    return created!.id;
  });
  if (!gated) await enqueueClaimPipeline({ claimId: id, jobId: "steward" });
  return id;
}

/** An existing node by id, or a new one minted from new_text. */
async function existingOrNew(
  input: Record<string, unknown>,
  idField: string,
  defaultKind: NodeKind,
  parentId: string,
  createdBy: string
): Promise<{ id: string; created: boolean } | { error: string }> {
  const existing = str(input[idField]);
  if (existing) {
    if (!(await nodeKind(existing))) return { error: `No active node ${existing}.` };
    return { id: existing, created: false };
  }
  const text = str(input.new_text);
  if (!text) return { error: `Pass ${idField} for an existing node, or new_text for a new one.` };
  const kindRaw = str(input.new_kind) || defaultKind;
  if (!(NODE_KINDS as readonly string[]).includes(kindRaw)) return { error: `Unknown kind "${kindRaw}".` };
  const importance = typeof input.importance === "number" ? input.importance : undefined;
  const id = await mintNode({
    text,
    kind: kindRaw as NodeKind,
    definition: input.new_definition,
    importance,
    parentId,
    createdBy,
  });
  return { id, created: true };
}

async function sourceFor(input: Record<string, unknown>): Promise<{ id: string } | { error: string }> {
  const url = str(input.url);
  if (!/^https?:\/\//i.test(url)) return { error: "url must be the http(s) URL of the source you read." };
  const source = await getOrCreateSource({ url, title: optStr(input.title) });
  return { id: source.id };
}

async function insertInstance(input: {
  claimId: string;
  sourceId: string;
  verbatimText: string;
  stance: string;
  fields: Record<string, unknown>;
  createdBy: string;
}): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances
       (claim_id, source_id, verbatim_text, stance, speaker, publication, source_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      input.claimId,
      input.sourceId,
      input.verbatimText,
      input.stance,
      optStr(input.fields.speaker) ?? null,
      optStr(input.fields.publication) ?? null,
      optStr(input.fields.source_date) ?? null,
      input.createdBy,
    ]
  );
  return row!.id;
}

/** Whether this run may keep (revise, close) a request. */
async function mayKeep(requestId: string, ctx: KindToolContext): Promise<string | null> {
  const [req] = await rawQuery<{ keeper_kind: string; keeper_claim_id: string | null }>(
    `SELECT keeper_kind, keeper_claim_id FROM requests WHERE id = $1`,
    [requestId]
  );
  if (!req) return `Request ${requestId} not found.`;
  if (ctx.role === "curator") {
    return req.keeper_kind === "curator" ? null : "That request is kept by the Steward of the node it bears on.";
  }
  if (ctx.role !== "claim_steward" && ctx.role !== "question_steward") {
    return "Only a request's keeper revises or closes it.";
  }
  if (req.keeper_kind === "steward" && req.keeper_claim_id === ctx.claimId) return null;
  return req.keeper_kind === "curator"
    ? "That request bears on several nodes or on none, so the Curator keeps it."
    : "That request is kept by the Steward of another node.";
}

export async function executeKindTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KindToolContext
): Promise<string | null> {
  if (!KIND_TOOL_NAMES.has(name)) return null;
  try {
    return await executeKindToolImpl(name, input, ctx);
  } catch (err) {
    if (err instanceof ZodError) return refuse(`Not recorded: ${zodMessage(err)}.`);
    if (err instanceof KindError || err instanceof RequestError) return refuse(err.message);
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeKindToolImpl(
  name: string,
  input: Record<string, unknown>,
  ctx: KindToolContext
): Promise<string> {
  const createdBy = ctx.role;
  const usage = getUsageContext();
  switch (name) {
    // ---- quantities --------------------------------------------------------
    case "set_quantity_definition": {
      const claimId = str(input.claim_id);
      const kind = await nodeKind(claimId);
      if (kind !== "quantity") {
        return refuse(
          kind
            ? `Node ${claimId} is a ${kind}. Whether it should be a quantity is the Curator's call: escalate_to_curator.`
            : `No active node ${claimId}.`
        );
      }
      await defineQuantity({
        claimId,
        definition: {
          measures: str(input.measures),
          population: optStr(input.population) ?? null,
          conditions: optStr(input.conditions) ?? null,
          unit: input.unit as QuantityDefinitionInput["unit"],
        },
        createdBy,
      });
      return ok(`Definition recorded for quantity ${claimId}.`);
    }

    case "record_estimate": {
      const quantityId = str(input.quantity_id);
      const kind = await nodeKind(quantityId);
      if (kind !== "quantity") {
        return refuse(
          kind
            ? `Node ${quantityId} is a ${kind}, not a quantity. A figure belongs on the quantity it is a value of: find it with match_claim.`
            : `No active node ${quantityId}.`
        );
      }
      const argumentId = optStr(input.argument_id) ?? null;
      let instanceId = optStr(input.instance_id);
      if (!instanceId) {
        const source = await sourceFor(input);
        if ("error" in source) return refuse(source.error);
        const verbatim = str(input.verbatim_text);
        if (verbatim.length > 2000) return refuse("verbatim_text must stay under 2000 characters: the passage, not the document.");
        instanceId = await insertInstance({
          claimId: quantityId,
          sourceId: source.id,
          verbatimText: verbatim,
          stance: "states",
          fields: input,
          createdBy,
        });
      }
      await setStatedEstimate({ instanceId, stated: input.stated as never, argumentId });
      return ok(`Recorded the figure as an instance of quantity ${quantityId}.`, { instance_id: instanceId });
    }

    case "update_quantity_estimate": {
      const claimId = str(input.claim_id);
      const assessment = str(input.assessment);
      const work = str(input.work);
      if (!assessment || !work) return refuse("An estimate records both the reader-facing assessment and the work.");
      const unknown = await unknownLinks(assessment, work);
      if (unknown.length > 0) {
        return refuse(`These linked nodes do not exist: ${unknown.join(", ")}. Link only real nodes, or name them in plain text.`);
      }
      const { id } = await recordEstimate({
        claimId,
        estimate: input.estimate as never,
        summary: assessment,
        work,
        model: ctx.model ?? null,
        fundedByJobId: usage.jobId ?? null,
        trigger: ctx.trigger ?? "steward_reassessment",
        triggerContext: ctx.context?.trim() ? ctx.context : null,
      });
      return ok(`Estimate recorded for quantity ${claimId}.`, { estimate_id: id });
    }

    case "record_quantity_reading": {
      const source = await sourceFor(input);
      if ("error" in source) return refuse(source.error);
      const { id } = await addReading({
        claimId: str(input.claim_id),
        sourceId: source.id,
        measured: str(input.measured),
        figure: str(input.figure),
        bearing: str(input.bearing),
        bearingClaimId: optStr(input.bearing_claim_id) ?? null,
        createdBy,
      });
      return ok("Reading recorded in the quantity's provenance.", { reading_id: id });
    }

    case "set_argument_shows": {
      await setArgumentShows({ argumentId: str(input.argument_id), shows: input.shows as never });
      return ok("Recorded what the argument shows about the value.");
    }

    case "record_cut": {
      const claimId = str(input.claim_id);
      if (ctx.role === "claim_steward" && ctx.claimId && claimId !== ctx.claimId) {
        return refuse("Record a cut only for the claim you steward.");
      }
      await recordCut({
        claimId,
        quantityId: str(input.quantity_id),
        direction: str(input.direction) as "above" | "below",
        value: Number(input.value),
        createdBy,
      });
      return ok(`Recorded that claim ${claimId} cuts quantity ${str(input.quantity_id)}.`);
    }

    // ---- questions ---------------------------------------------------------
    case "add_presupposition": {
      const questionId = str(input.question_id);
      if ((await nodeKind(questionId)) !== "question") return refuse(`Node ${questionId} is not an active question.`);
      const node = await existingOrNew(input, "claim_id", "claim", questionId, createdBy);
      if ("error" in node) return refuse(node.error);
      await withTransaction(async (tx) => {
        await lockNodeKind(tx, questionId);
        await insertRelationshipEdge(
          { parentId: questionId, childId: node.id, relationType: "assumes", reasoning: str(input.reasoning), createdBy },
          tx
        );
      });
      return ok(`Presupposition ${node.id} attached${node.created ? " (new)" : ""}.`, { claim_id: node.id });
    }

    case "add_subquestion": {
      const questionId = str(input.question_id);
      if ((await nodeKind(questionId)) !== "question") return refuse(`Node ${questionId} is not an active question.`);
      const node = await existingOrNew({ ...input, new_kind: "question" }, "subquestion_id", "question", questionId, createdBy);
      if ("error" in node) return refuse(node.error);
      await addSubquestion({ questionId, subquestionId: node.id, reasoning: str(input.reasoning), createdBy });
      return ok(`Subquestion ${node.id} attached${node.created ? " (new)" : ""}.`, { subquestion_id: node.id });
    }

    case "add_answer": {
      const questionId = str(input.question_id);
      if ((await nodeKind(questionId)) !== "question") return refuse(`Node ${questionId} is not an active question.`);
      const node = await existingOrNew(input, "answer_id", "claim", questionId, createdBy);
      if ("error" in node) return refuse(node.error);
      await addAnswer({
        questionId,
        answerId: node.id,
        basis: str(input.basis) as never,
        reasoning: str(input.reasoning),
        createdBy,
      });
      return ok(`Answer ${node.id} is in the set${node.created ? " (new)" : ""}.`, { answer_id: node.id });
    }

    case "remove_answer": {
      const deleted = await rawQuery<{ id: string }>(
        `DELETE FROM claim_relationships
          WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = 'answers' RETURNING id`,
        [str(input.question_id), str(input.answer_id)]
      );
      if (deleted.length === 0) return refuse("That node is not in the question's answer set.");
      return ok(`Removed ${str(input.answer_id)} from the answer set.`);
    }

    case "set_answer_relation": {
      await setAnswerRelation({
        questionId: str(input.question_id),
        answerA: str(input.answer_a),
        answerB: str(input.answer_b),
        relation: str(input.relation) as never,
        reasoning: optStr(input.reasoning) ?? null,
        createdBy,
      });
      return ok("Recorded how the two answers bear on each other.");
    }

    case "update_question_assessment": {
      const claimId = str(input.claim_id);
      const assessment = str(input.assessment);
      const trace = str(input.reasoning_trace);
      if (!assessment || !trace) return refuse("An assessment records both the reader-facing text and the reasoning_trace.");
      const unknown = await unknownLinks(assessment, trace);
      if (unknown.length > 0) {
        return refuse(`These linked nodes do not exist: ${unknown.join(", ")}. Link only real nodes, or name them in plain text.`);
      }
      const { id } = await recordQuestionAssessment({
        claimId,
        standing: str(input.standing).toLowerCase() as never,
        favoredClaimIds: ids(input.favored_answer_ids),
        summary: assessment,
        reasoningTrace: trace,
        incomplete: optStr(input.incomplete) ?? null,
        model: ctx.model ?? null,
        fundedByJobId: usage.jobId ?? null,
        trigger: ctx.trigger ?? "steward_reassessment",
        triggerContext: ctx.context?.trim() ? ctx.context : null,
      });
      return ok(`Assessment recorded for question ${claimId}: ${str(input.standing)}.`, { assessment_id: id });
    }

    case "record_question_instance": {
      const questionId = str(input.question_id);
      if ((await nodeKind(questionId)) !== "question") return refuse(`Node ${questionId} is not an active question.`);
      const role = str(input.role) as "asks" | "answers";
      let instanceId = optStr(input.instance_id);
      if (!instanceId) {
        const source = await sourceFor(input);
        if ("error" in source) return refuse(source.error);
        const verbatim = str(input.verbatim_text);
        if (verbatim.length > 2000) return refuse("verbatim_text must stay under 2000 characters: the passage, not the document.");
        instanceId = await insertInstance({
          claimId: questionId,
          sourceId: source.id,
          verbatimText: verbatim,
          stance: role,
          fields: input,
          createdBy,
        });
      }
      await setQuestionInstance({ instanceId, role, answerClaimId: optStr(input.answer_id) ?? null });
      return ok(`Recorded the source as one that ${role === "asks" ? "asks" : "answers"} the question.`, {
        instance_id: instanceId,
      });
    }

    // ---- requests ----------------------------------------------------------
    case "file_request": {
      const sourceIds: string[] = [];
      for (const url of ids(input.source_urls)) {
        const source = await sourceFor({ url });
        if ("error" in source) return refuse(source.error);
        sourceIds.push(source.id);
      }
      const claimIds = ids(input.claim_ids);
      // Asked first, so a duplicate is visible before it is filed.
      const open = claimIds.length
        ? (await Promise.all(claimIds.map((c) => listRequests({ claimId: c, live: true, limit: 20 })))).flatMap((r) => r.items)
        : [];
      const { id } = await fileRequest({
        ask: str(input.ask),
        why: str(input.why),
        satisfiedBy: str(input.satisfied_by),
        whoCould: optStr(input.who_could) ?? null,
        addressedTo: optStr(input.addressed_to) ?? null,
        bearsOnText: optStr(input.bears_on_text) ?? null,
        claimIds,
        sourceIds,
        filer: { kind: "admin", agent: ctx.role, runId: usage.runId ?? null },
      });
      const others = [...new Map(open.map((r) => [r.id, r])).values()];
      return ok(
        `Request ${id} filed.` +
          (others.length
            ? ` Other open requests already bear on these nodes; if one asks for the same thing, close this one as moot and name it.`
            : ""),
        { request_id: id, ...(others.length ? { open_requests: others.map((r) => ({ id: r.id, ask: r.ask })) } : {}) }
      );
    }

    case "list_requests": {
      const claimId = optStr(input.claim_id);
      const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
      const { items, total } = await listRequests({ claimId, live: input.live === true, limit });
      return JSON.stringify({
        success: true,
        total,
        requests: items.map((r) => ({
          id: r.id,
          ask: r.ask,
          why: r.why,
          satisfied_by: r.satisfied_by,
          state: r.state,
          state_note: r.state_note,
          keeper: r.keeper,
          filed_by: r.filed_by,
          bears_on: r.bears_on,
          bears_on_text: r.bears_on_text,
          work: r.work,
        })),
      });
    }

    case "revise_request": {
      const requestId = str(input.request_id);
      const denied = await mayKeep(requestId, ctx);
      if (denied) return refuse(denied);
      await reviseRequest({
        requestId,
        ask: input.ask === undefined ? undefined : str(input.ask),
        why: input.why === undefined ? undefined : str(input.why),
        satisfiedBy: input.satisfied_by === undefined ? undefined : str(input.satisfied_by),
        whoCould: input.who_could === undefined ? undefined : str(input.who_could),
        addressedTo: input.addressed_to === undefined ? undefined : str(input.addressed_to),
      });
      return ok(`Request ${requestId} revised.`);
    }

    case "close_request": {
      const requestId = str(input.request_id);
      const denied = await mayKeep(requestId, ctx);
      if (denied) return refuse(denied);
      const state = str(input.state);
      if (!["met", "declined", "moot"].includes(state)) return refuse("state must be met, declined, or moot.");
      await setRequestState({ requestId, state: state as never, note: str(input.note) });
      return ok(`Request ${requestId} closed as ${state}.`);
    }

    case "set_request_targets": {
      if (ctx.role !== "curator") return refuse("Only the Curator sets what a request bears on.");
      const sourceIds: string[] = [];
      for (const url of ids(input.source_urls)) {
        const source = await sourceFor({ url });
        if ("error" in source) return refuse(source.error);
        sourceIds.push(source.id);
      }
      const requestId = str(input.request_id);
      const { keeper, keeperClaimId } = await setRequestTargets({
        requestId,
        claimIds: ids(input.claim_ids),
        sourceIds,
      });
      return ok(
        keeper === "steward"
          ? `Request ${requestId} now bears on one node alone and passes to its Steward (${keeperClaimId}).`
          : `Request ${requestId} retargeted; you keep it.`
      );
    }

    // ---- kinds -------------------------------------------------------------
    case "change_node_kind": {
      if (ctx.role !== "curator") return refuse("Changing a node's kind is the Curator's.");
      const claimId = str(input.claim_id);
      const to = str(input.to) as NodeKind;
      if (!(NODE_KINDS as readonly string[]).includes(to)) return refuse(`Unknown kind "${to}".`);
      const result = await changeNodeKind({
        claimId,
        to,
        definition: (input.definition as QuantityDefinitionInput | undefined) ?? null,
        reasoning: str(input.reasoning),
      });
      if (!result.changed) return refuse(`Node ${claimId} is already a ${to}.`);
      await enqueueSteward({
        claimId,
        trigger: "curator_change",
        context: `The Curator changed this node from a ${result.from} to a ${to}: ${str(input.reasoning)}`,
      });
      return ok(`Node ${claimId} is now a ${to}; its Steward is asked to re-judge it.`, { event_id: result.eventId });
    }
  }
  return `Error: Unknown kind tool: ${name}`;
}
