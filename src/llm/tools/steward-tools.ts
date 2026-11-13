/**
 * Action tools for the Claim Steward agent.
 *
 * These let the steward update assessments, modify canonical forms,
 * add decomposition edges, log decisions, and notify dependent stewards.
 */
import { refusalForCaller } from "../../db/clearance.js";
import {
  mirroredNode,
  mirroredRefusalForAgent,
  mirroredRowMessage,
  publicGraphEvaluates,
  publicGraphJudges,
  publicJudgmentMessage,
} from "../../services/mirrored-node-service.js";
import type Anthropic from "@anthropic-ai/sdk";
import { mergedInputRefusal } from "../../services/claim-alias-service.js";
type Tool = Anthropic.Tool;
import { and, eq } from "drizzle-orm";
import { getDb, rawQuery, withTransaction } from "../../db/client.js";
import { recordJudgmentInputs } from "../../services/judgment-inputs-service.js";
import {
  anotherLabelsNode,
  anotherLabelsNodeMessage,
  oneLabelOnly,
  recordMadeBeside,
} from "../../services/judgment-version-service.js";
import {
  claims,
  assessments,
  assessmentsInForce,
  claimInstances,
  auditLog,
} from "../../db/schema.js";
import { generateEmbedding } from "../../services/embedding-service.js";
import { getOrCreateSource } from "../../services/source-service.js";
import { sourceAddressProblem } from "../../services/reading-address.js";
import {
  ARGUMENT_VERDICTS,
  addArgument,
  getArgument,
  getArgumentSubclaims,
  getEvaluationStateForClaim,
  hasWrittenForm,
  isArgumentVerdict,
  parseClaimLinks,
  setArgumentContent,
  setArgumentEvaluation,
} from "../../services/argument-service.js";
import {
  attachEdgeToArgument,
  getClaimBasisSubclaims,
  insertRelationshipEdge,
} from "../../services/relationship-service.js";
import { linkClaims } from "../../services/reconciliation-service.js";
import { isClaimLinkKind } from "../../services/claim-link-service.js";
import { loadConfig } from "../../config.js";
import {
  RELATION_TYPES,
  RELATION_GUIDANCE,
  CLAIM_LINK_KINDS,
  CLAIM_LINK_GUIDANCE,
  claimTypeEnum,
  INSTANCE_STANCES,
  isInstanceStance,
} from "../../schemas/common.js";
import { knownDomains } from "../prompts/skills.js";
import {
  enqueueSteward,
  enqueueClaimPipeline,
} from "../../services/queue-service.js";
import { currentLabel, getUsageContext } from "../usage-context.js";
import {
  executeNotifySteward,
  getNotifyStewardToolDefinition,
} from "./notify-steward.js";
import {
  requestCuration,
  CURATION_DEFECTS,
  CURATION_DEFECT_DESCRIPTION,
  type CurationDefect,
} from "../../services/curation-service.js";
import { demotePublishedFormalization } from "../../services/formalization-service.js";
import { setArgumentShows } from "../../services/quantity-service.js";
import { addAnswer, addSubquestion } from "../../services/question-service.js";
import {
  ANSWER_BASES,
  KIND_INSTANCE_STANCES,
  KIND_RELATION_TYPES,
  NODE_KINDS,
  quantityDefinitionSchema,
  valueShownSchema,
  type AnswerBasis,
  type NodeKind,
} from "../../schemas/kinds.js";
import {
  ClaimInstanceError,
  detachClaimInstance,
  reattachClaimInstance,
  setInstanceOrder,
} from "../../services/claim-instance-service.js";
import { ownershipRefusal } from "./steward-ownership.js";
import { SOURCE_KIND_PROPERTY, applyStatedSourceKind, sourceKindRefusal } from "./source-kind.js";
import { MARGINAL_YIELD_DESCRIPTION } from "./judgment-fields.js";
import { malformedIdRefusal, writeIdCandidates } from "./id-repair.js";
import {
  executeStewardStructureTool,
  getStewardStructureToolDefinitions,
} from "./steward-structure-tools.js";
import {
  executeArgumentInstanceTool,
  getArgumentInstanceToolDefinition,
  getPlaceArgumentPassageToolDefinition,
} from "./argument-instance-tools.js";

/**
 * Relations a node can stand in to a parent above it (add_parent_claim,
 * propose_parent_edge): the decomposition relations under a claim or a
 * quantity, plus the two a question's own edges use (§7a; question-service).
 */
const UPWARD_RELATION_TYPES = [...RELATION_TYPES, ...KIND_RELATION_TYPES] as const;

/** A question's structure: its answers, subquestions and presuppositions (§7a). */
const QUESTION_PARENT_RELATIONS: readonly string[] = ["answers", "part_of", "assumes", "requires"];

/**
 * Why `relation` cannot join a child of `childKind` under a parent of
 * `parentKind`, or null when it can. Mirrors what the question tools write
 * (add_answer, add_subquestion, add_presupposition): a candidate answer is a
 * claim or a quantity, a subquestion is a question, and a presupposition is
 * an ordinary assumes or requires edge.
 */
function upwardRelationError(parentKind: NodeKind, childKind: NodeKind, relation: string): string | null {
  if (!(UPWARD_RELATION_TYPES as readonly string[]).includes(relation)) {
    return `Unknown relation "${relation}". Use one of: ${UPWARD_RELATION_TYPES.join(", ")}.`;
  }
  if (parentKind === "question") {
    if (!QUESTION_PARENT_RELATIONS.includes(relation)) {
      return (
        `A question is answered, not supported or contradicted (§7a), so "${relation}" ` +
        `does not join a node to one. Use answers (yours is a candidate answer), ` +
        `part_of (yours is a subquestion whose answer it needs), or assumes/requires ` +
        `(the question presupposes yours).`
      );
    }
    if (relation === "answers" && childKind === "question") {
      return "A question answers no question; use part_of to make yours a subquestion.";
    }
    if (relation === "part_of" && childKind !== "question") {
      return (
        `Only a question is part_of a question; your ${childKind} is a candidate ` +
        `answer (answers) or a presupposition (assumes/requires).`
      );
    }
    return null;
  }
  if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
    return (
      `"${relation}" joins a node to a question only; under a ${parentKind} use one ` +
      `of: ${RELATION_TYPES.join(", ")}.`
    );
  }
  return null;
}

/** The assessment status enum the tool accepts and the graph stores (§10). */
const ASSESSMENT_STATUSES = [
  "verified",
  "supported",
  "inconclusive",
  "doubtful",
  "contradicted",
  "unknown",
] as const satisfies readonly string[];

/**
 * Statuses retired by #524, with what to choose instead. A model still
 * reasoning in the old vocabulary gets told why its write bounced, not just
 * the list of valid values.
 */
const RETIRED_STATUSES: Record<string, string> = {
  contested:
    "'contested' was retired: it described the debate, not the evidence. " +
    "Choose the status the evidence supports; use 'inconclusive' only if you " +
    "examined the evidence and it does not come down on either side. Record " +
    "how actively the claim is disputed as contestation (set_claim_importance).",
  unsupported:
    "'unsupported' was retired. If evidence would exist were the claim true " +
    "and none was found, the absence is a reason for doubt: 'doubtful'. If " +
    "such evidence would not be expected, the claim is 'unknown'.",
};

/**
 * A verdict on a proposition (update_claim_assessment) refused for a node
 * of another kind, pointing at the tool that records its judgment (§10).
 */
async function wrongKindForAssessment(claimId: string): Promise<string | null> {
  const [row] = await rawQuery<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [claimId]);
  if (row?.kind === "quantity") {
    return JSON.stringify({
      success: false,
      message:
        `Node ${claimId} is a quantity: its assessment is an estimate, recorded with ` +
        `update_quantity_estimate, not a status.`,
    });
  }
  if (row?.kind === "question") {
    return JSON.stringify({
      success: false,
      message:
        `Node ${claimId} is a question: its assessment is recorded with ` +
        `update_question_assessment.`,
    });
  }
  return null;
}

/** Coerce a tool input to a clamped unit-interval score in [0, 1], or undefined if absent/invalid. */
function clampUnit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

// The claim_type values update_canonical_form accepts: the shared enum,
// which carries `mathematical`, the type the Mathematics skill assigns to
// propositions of mathematics (docs/mathematics.md §2.1).
const CLAIM_TYPE_VALUES: readonly string[] = [...claimTypeEnum.options];

/**
 * Validate a `domains` tool argument against the closed list of domains the
 * skills define. Returns the cleaned list, or a message naming what was
 * rejected so the agent can correct the call.
 */
function parseDomains(value: unknown): { domains: string[] } | { error: string } {
  if (!Array.isArray(value)) {
    return { error: "domains must be an array of domain names." };
  }
  const known = knownDomains();
  const cleaned = [
    ...new Set(value.map((d) => String(d).trim().toLowerCase()).filter(Boolean)),
  ].sort();
  const unknown = cleaned.filter((d) => !known.includes(d));
  if (unknown.length > 0) {
    return {
      error:
        `Unknown domain(s): ${unknown.join(", ")}. The domains that exist are: ` +
        `${known.join(", ") || "(none)"}. Pass an empty array for a claim that ` +
        `belongs to no domain with a skill.`,
    };
  }
  return { domains: cleaned };
}

/** Who may record a claim instance: the Steward, or a researcher it launched. */
export type InstanceRecorder = "claim_steward" | "researcher";

/**
 * record_claim_instance as a researcher a Steward launched sees it: the
 * Steward's tool, with claim_id dropped because the run records on its own
 * claim alone and the harness fills it in, and the description addressed to
 * an instrument rather than to the claim's Steward.
 */
export function getResearcherInstanceToolDefinition(): Tool {
  const tool = getStewardToolDefinitions().find((t) => t.name === "record_claim_instance")!;
  const schema = tool.input_schema as {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  const { claim_id: _claimId, ...properties } = schema.properties;
  return {
    name: tool.name,
    description:
      "Record a source for the claim this investigation serves: one you read " +
      "that asserts the claim, denies it, poses it as an open question, or " +
      "mentions it without taking a side, with the passage as it states it. " +
      "Record a mention when a reader should see it: prominent, an origin, or " +
      "telling about how the claim is used, not every passing occurrence; a " +
      "mention is never counted as affirming or denying. A source quoting " +
      "someone is an instance whose speaker is the person quoted. One instance " +
      "per (claim, source, speaker): re-recording is deduplicated. Set speaker " +
      "on each. The instance is recorded as yours, and the Steward owns the " +
      "claim's instance set: it may correct or detach " +
      "what you record. List what you recorded in your report.",
    input_schema: {
      type: "object" as const,
      properties,
      required: schema.required.filter((r) => r !== "claim_id"),
    },
  };
}

export function getStewardToolDefinitions(): Tool[] {
  return [
    {
      name: "update_claim_assessment",
      description:
        "Update the assessment of a claim. Marks the previous assessment " +
        "as non-current and creates a new current assessment.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to assess",
          },
          status: {
            type: "string",
            enum: [...ASSESSMENT_STATUSES],
            description:
              "New assessment status (§10), an evidential ladder: verified " +
              "(the evidence, examined directly, establishes the claim), " +
              "supported (the evidence favors it, but the examination is " +
              "incomplete or the evidence indirect), inconclusive (the evidence " +
              "and argument were examined and do not come down on either side), " +
              "doubtful (the evidence weighs against it, but the examination is " +
              "incomplete or the evidence indirect), contradicted (the evidence, " +
              "examined directly, weighs against it), unknown (not enough " +
              "information to assess). The status describes the evidence, not " +
              "the debate: how actively the claim is disputed is its " +
              "contestation, recorded separately.",
          },
          confidence: {
            type: "number",
            description:
              "Verdict confidence (0.0-1.0): how sure you are that the status " +
              "you chose is the right reading of the evidence. Meta by design; " +
              "NOT the probability that the claim is true. A claim can be " +
              "confidently inconclusive.",
          },
          claim_credence: {
            type: "number",
            description:
              "Optional credence (0.0-1.0): your probability that the claim, as " +
              "stated, is TRUE. Give it only where a single number is an honest " +
              "summary (typically concrete empirical questions). Omit it where " +
              "it would be false precision: normative or evaluative claims, " +
              "definitional choices, or composites whose parts pull in different " +
              "directions. Omitting is itself information, not a failure.",
          },
          assessment: {
            type: "string",
            description:
              "The reader-facing account of where the claim stands, shown first when " +
              "someone lands on its page. Self-contained prose in the third person, " +
              "like the opening of a good encyclopedia entry: what the claim rests " +
              "on, what the evidence shows, and for a disputed claim where the " +
              "credible disagreement lies and what would resolve it. Let the length " +
              "follow the claim: a settled one may be two or three sentences, a " +
              "disputed or foundational one a few short paragraphs. Keep " +
              "the machinery out of it: no tool or edge names (SUPPORTS/CONTRADICTS " +
              "edge), no importance numbers, no 'per the constitution', no first-" +
              "person 'I', and no narration of your own bookkeeping (merges, " +
              "canonical-form edits, importance changes go in " +
              "log_stewardship_decision). When a sentence references a subclaim, " +
              "link it inline as [[claim:<uuid>|the phrase you would use anyway]] " +
              "(same syntax as argument written forms); renderers turn it into a " +
              "link to that claim's page.",
          },
          reasoning_trace: {
            type: "string",
            description:
              "The transparent audit detail behind the verdict, shown secondary to " +
              "the assessment (behind a disclosure). Lay out the specific evidence, " +
              "source instances, and how the material subclaims weigh. This is about " +
              "the CLAIM'S TRUTH: keep structural bookkeeping out of it. Refer to " +
              "subclaims by their text (quoted or paraphrased), never by bare UUID; " +
              "ids are opaque to the human readers this trace exists for. To make a " +
              "reference followable, link it inline as [[claim:<uuid>|its text]]. " +
              "Bare source URLs render as links; cite them where the evidence rests " +
              "on them.",
          },
          marginal_yield: {
            type: "number",
            description: MARGINAL_YIELD_DESCRIPTION,
          },
        },
        required: ["claim_id", "status", "confidence", "assessment", "reasoning_trace"],
      },
    },
    {
      name: "record_claim_instance",
      description:
        "Record a source for the claim you steward: one you read that asserts " +
        "the claim, denies it, poses it as an open question, or mentions it " +
        "without taking a side, with the passage as it states it. Instances " +
        "are what the claim page shows of the discourse, and the provenance " +
        "tools record what each one rests on. Record a mention (it cites the " +
        "claim, reports that others hold it, or raises it in passing) when the " +
        "source is worth a reader seeing: prominent, an origin, or telling " +
        "about how the claim is used, not every passing occurrence. A mention " +
        "is never counted as affirming or denying. A source quoting " +
        "someone is an instance whose speaker is the person quoted. One " +
        "instance per (claim, source, speaker): re-recording the same source " +
        "is deduplicated, but a document in which several people each speak " +
        "in their own voice (the signed sections of a jointly authored paper, " +
        "a panel transcript) holds one instance per speaker. Set speaker on " +
        "each; a call without one deduplicates against the whole source.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim this is an instance of",
          },
          url: {
            type: "string",
            description:
              "URL of the source you read. This is the instance's " +
              "provenance; sources are found-or-created by URL.",
          },
          title: {
            type: "string",
            description: "Title of the source",
          },
          source_kind: SOURCE_KIND_PROPERTY,
          verbatim_text: {
            type: "string",
            description:
              "The passage as this source states the claim (or its " +
              "negation, or where it mentions it), verbatim — the statement " +
              "itself, not your paraphrase. Under 2,000 characters: the " +
              "passage, not the document.",
          },
          context: {
            type: "string",
            description:
              "Brief surrounding context: what the source was arguing or " +
              "reporting when it made the statement.",
          },
          stance: {
            type: "string",
            enum: [...INSTANCE_STANCES],
            description:
              "Whether this source asserts the canonical claim (affirms), " +
              "its negation (denies), states the proposition as an open " +
              "question without endorsing either side (poses: a conjecture " +
              "as a survey states it), or refers to it without asserting, " +
              "denying or posing it (mentions: it cites the claim, reports " +
              "that others hold it, or raises it in passing).",
          },
          speaker: {
            type: "string",
            description:
              "Who asserted it, where identifiable: the author, or for a " +
              "quote the person quoted (not the outlet reporting it).",
          },
          publication: {
            type: "string",
            description:
              "The publication/outlet the statement appeared in, where " +
              "identifiable.",
          },
          source_date: {
            type: "string",
            description:
              "When the statement was made, as stated by the source, " +
              "ISO-8601 to the precision known: '2023', '2023-05', or " +
              "'2023-05-14'. Omit rather than guess.",
          },
          link: {
            type: "string",
            description:
              "Deep link to the statement itself where it differs from the " +
              "source URL (an anchor, a tweet inside a thread, a timestamped " +
              "video link). Omit when the source URL already is the link.",
          },
          confidence: {
            type: "number",
            description:
              "0.0-1.0: how confident you are that the passage carries " +
              "this stance on THIS claim (not a near-miss proposition). " +
              "Defaults to 1.",
          },
          stated_probability: {
            type: "number",
            description:
              "When the source itself states a probability for the claim " +
              "(a forecast, \"a 30% chance\"), that probability, 0..1: what " +
              "the source said, never your own credence.",
          },
        },
        required: ["claim_id", "url", "verbatim_text", "stance"],
      },
    },
    {
      name: "update_claim_instance",
      description:
        "Correct an already-recorded instance of the claim you steward " +
        "(#420): its stance, confidence, speaker, or the passage it rests " +
        "on. Recording is deduplicated per (claim, source, speaker), so " +
        "this is the only way to fix an instance that misrepresents its source: a " +
        "quote attributed to the outlet instead of the person quoted, a " +
        "stance read backwards, a passage that is not the one carrying the " +
        "stance, or a source recorded as affirming or denying that only " +
        "mentions the claim (correct its stance to mentions). Every " +
        "correction requires a reasoning note, which is written to the " +
        "claim's audit trail.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim the instance belongs to",
          },
          instance_id: {
            type: "string",
            description:
              "The UUID of the instance to correct, from get_claim_instances " +
              "(or returned by a deduplicated record_claim_instance call).",
          },
          stance: {
            type: "string",
            enum: [...INSTANCE_STANCES],
            description:
              "Corrected stance: whether this source asserts the canonical " +
              "claim (affirms), its negation (denies), states the " +
              "proposition as an open question without taking a side " +
              "(poses), or only refers to it without asserting, denying or " +
              "posing it (mentions). Omit to leave as is; always omit it on a " +
              "question's or quantity's instance, whose role (asks, answers, " +
              "states) it would overwrite.",
          },
          confidence: {
            type: "number",
            description:
              "Corrected 0.0-1.0 confidence that the passage carries this " +
              "stance on this claim. Omit to leave as is.",
          },
          speaker: {
            type: "string",
            description:
              "Corrected speaker: who actually asserted it (for a quote, the " +
              "person quoted, not the outlet). Omit to leave as is.",
          },
          publication: {
            type: "string",
            description: "Corrected publication/outlet. Omit to leave as is.",
          },
          source_date: {
            type: "string",
            description:
              "Corrected date, ISO-8601 to the precision known. Omit to " +
              "leave as is.",
          },
          verbatim_text: {
            type: "string",
            description:
              "Corrected passage, verbatim, where the recorded one is not " +
              "the statement that carries the stance, under 2,000 " +
              "characters. Omit to leave as is.",
          },
          context: {
            type: "string",
            description:
              "Corrected surrounding context. Omit to leave as is.",
          },
          reasoning: {
            type: "string",
            description:
              "Why the recorded instance was wrong and what you read that " +
              "shows it: the note the audit trail keeps next to the change.",
          },
        },
        required: ["claim_id", "instance_id", "reasoning"],
      },
    },
    {
      name: "detach_claim_instance",
      description:
        "Detach an instance from the claim you steward: the source states a " +
        "different proposition (a near-miss, or a match to the wrong claim), " +
        "or the instance misreads the source. A source that refers to this " +
        "claim without taking a side is not detached: correct its stance to " +
        "mentions with update_claim_instance. The instance no longer belongs " +
        "to the claim: it leaves " +
        "the claim page, the instance count and every read of the claim's " +
        "instances. The row is kept for the provenance record, never deleted, " +
        "and reattach_claim_instance restores it. The reason is written to " +
        "the claim's audit trail.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim the instance belongs to",
          },
          instance_id: {
            type: "string",
            description: "The UUID of the instance, from get_claim_instances.",
          },
          reason: {
            type: "string",
            description:
              "What you read that shows the instance does not belong to this " +
              "claim: the note the audit trail keeps.",
          },
        },
        required: ["claim_id", "instance_id", "reason"],
      },
    },
    {
      name: "reattach_claim_instance",
      description:
        "Reattach an instance that was detached from the claim you steward, " +
        "when reading the source shows it belongs to the claim after all. It " +
        "returns at the default position. " +
        "get_claim_instances with include_detached lists detached instances " +
        "and why each was detached. The reason is written to the claim's " +
        "audit trail.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          instance_id: {
            type: "string",
            description: "The UUID of the detached instance.",
          },
          reason: {
            type: "string",
            description: "Why the instance belongs to the claim.",
          },
        },
        required: ["claim_id", "instance_id", "reason"],
      },
    },
    {
      name: "set_instance_order",
      description:
        "Set the order in which a reader sees the claim's instances. The ids " +
        "you list are shown first, in the order given; every other instance " +
        "follows in the default order (origins before what derives from " +
        "them, then by date). Each call replaces the previous order, and an " +
        "empty list clears it. Order by what a reader should see first, not " +
        "by when an instance was recorded. Detached instances cannot be listed.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          instance_ids: {
            type: "array",
            items: { type: "string" },
            description: "Instance ids from get_claim_instances, first to be shown first.",
          },
          reasoning: {
            type: "string",
            description: "Optional: why this order, for the audit trail.",
          },
        },
        required: ["claim_id", "instance_ids"],
      },
    },
    {
      name: "update_canonical_form",
      description:
        "Update the canonical form (text) of a claim. Wording is judged fresh " +
        "on its merits (constitution §3): the shortest neutral statement of the " +
        "proposition, about fifteen words. The node's " +
        "identity and history stay stable while its wording improves; never " +
        "keep a worse form because it came first. Do not change what the claim " +
        "IS, which is what its words say to a reader today (§3), not what a " +
        "source or an earlier assessment took them to mean. Stating that " +
        "meaning more plainly is a rewording and yours to make: a rewording " +
        "that different considerations would bear on is a different claim, and " +
        "rewording into the negation would flip every recorded stance. For " +
        "those, match or create the other claim, or escalate to the Curator. The form's " +
        "direction was chosen on the proposition's own terms (see the claim's " +
        "canonical_direction_note in get_claim), never from whichever " +
        "source arrived first; keep it.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to update",
          },
          new_text: {
            type: "string",
            description: "The new canonical form text",
          },
          claim_type: {
            type: "string",
            enum: [...CLAIM_TYPE_VALUES],
            description:
              "Optional: also correct the claim's type when the recorded one " +
              "is a category error (a theorem recorded as empirical_derived " +
              "becomes mathematical). Omit to leave the type as it is.",
          },
          reasoning: {
            type: "string",
            description: "Why this change improves the canonical form",
          },
        },
        required: ["claim_id", "new_text", "reasoning"],
      },
    },
    {
      name: "add_argument",
      description:
        "Create a named argument on a claim: a line of reasoning, for or " +
        "against, that subclaims attach to. Arguments are canonical, " +
        "like claims, and may be ones you supply yourself (§7). Before " +
        "creating one, check the claim's existing arguments: one that " +
        "reaches the claim through the same inference is the same " +
        "argument, however worded. Name it by its reasoning (\"the " +
        "argument from the unlinked early cases\"). A conventional name " +
        "is fine where the discourse uses one (\"Pascal's wager\"). Pass " +
        "the returned argument_id to add_relationship_edge / " +
        "add_decomposition_edge to group subclaims under it. Once its " +
        "edges are attached, give it a written form with write_argument. " +
        "When you record the claim's assessment, evaluate it with " +
        "evaluate_argument.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim this argument is about",
          },
          name: {
            type: "string",
            description: "Short descriptive name for the line of reasoning",
          },
          stance: {
            type: "string",
            enum: ["for", "against"],
            description:
              "'for': the argument's conclusion is the claim. 'against': " +
              "its conclusion is the claim's denial. Omit for a quantity, " +
              "whose arguments pass shows instead.",
          },
          description: {
            type: "string",
            description: "Brief label for this line of reasoning (not a proposition)",
          },
          shows: {
            type: "object",
            description:
              "For an argument about a quantity, in place of stance (§7): " +
              "what it shows about the value, as {text, range}. range.side " +
              "is at, about, between, above or below (a figure or lower " +
              "bound in low, an upper bound in high; inclusive for 'at " +
              "least' or 'at most'); omit range for an argument that the " +
              "value is ill defined or cannot be known.",
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
          },
        },
        required: ["claim_id", "name", "description"],
      },
    },
    {
      name: "write_argument",
      description:
        "Write or revise an argument's written form: brief prose stating " +
        "plainly how its premises combine to reach its conclusion. " +
        "Reference every attached subclaim inline as [[claim:<uuid>]] (or " +
        "[[claim:<uuid>|inline phrasing]]); you may also link the claim's " +
        "ungrouped basis subclaims. Premises that are settled and not " +
        "claims in their own right (§7) may be stated in the prose, so an " +
        "argument with no attached subclaims needs no links. State " +
        "the argument faithfully, as its proponents would recognize it, " +
        "at its most plausible intended reading, without weakening or " +
        "repairing it. Use no rhetoric. Include every premise the " +
        "conclusion depends on, including unspoken ones, stated as " +
        "propositions about the world rather than as conditionals that " +
        "restate the inference. The form states the inference without " +
        "judging it; your judgment goes in evaluate_argument. Call again " +
        "whenever the subclaims change, then re-evaluate.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: {
            type: "string",
            description: "The UUID of the argument (from add_argument)",
          },
          content: {
            type: "string",
            description:
              "The written form: brief prose with inline [[claim:<uuid>]] " +
              "references to the argument's subclaims. Under 1,000 " +
              "characters, links included (each costs about 46): enough " +
              "for the inference, while detail belongs in the subclaims.",
          },
        },
        required: ["argument_id", "content"],
      },
    },
    {
      name: "evaluate_argument",
      description:
        "Record or revise your evaluation of a named argument: how far " +
        "its conclusion follows if its premises hold as the written form " +
        "states them, which premises it currently lives or dies on, and " +
        "whether it is decisive. For an argument against the claim, the " +
        "conclusion is the claim's denial. Rate the inference, not the " +
        "truth of the premises or the claim: whether the premises hold " +
        "is shown beside your rating from their own assessments, and how " +
        "much the argument moves the claim belongs in the claim's " +
        "assessment. Call it for each named argument when you record an " +
        "assessment. Change the rating when the argument's structure or " +
        "your reading of the inference changes; update the prose and " +
        "reconsider the decisive mark when a premise's standing does. " +
        "Reader-facing, in the register of an assessment; contributor " +
        "exchanges stay in the contribution record.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: {
            type: "string",
            description: "The UUID of the argument (from add_argument)",
          },
          verdict: {
            type: "string",
            enum: [...ARGUMENT_VERDICTS],
            description:
              "How far the conclusion follows if the premises hold. " +
              "'certain': it follows necessarily. 'likely': the premises " +
              "make it much more likely, without guaranteeing it (most " +
              "good inductive, statistical and explanatory arguments). " +
              "'slight': the premises bear on it, but only a little. " +
              "'none': even if true, the premises give it no real " +
              "support; name the flaw in the evaluation. A circular " +
              "argument gives no support. If the argument is slight only " +
              "because a premise is unstated, state that premise and " +
              "attach it before rating. This rates the step, not the " +
              "conclusion.",
          },
          evaluation: {
            type: "string",
            description:
              "Reader-facing (§12), usually a few sentences and under 1,200 " +
              "characters, links included: how far the " +
              "inference goes, phrased conditionally ('granting its " +
              "premises, ...'), and, for a rating of none, the flaw in " +
              "plain words; then which premises bear the weight, given " +
              "their current assessments, referenced inline as " +
              "[[claim:<uuid>]] (or [[claim:<uuid>|inline phrasing]]); " +
              "for a decisive argument, what makes it decisive. E.g. " +
              "'Granting its premises the conclusion follows, so the " +
              "argument stands or falls with [[claim:<uuid>]], which the " +
              "evidence currently leaves unsettled.' No tool names, no " +
              "ids in prose, no restating the rating label.",
          },
          decisive: {
            type: "boolean",
            description:
              "True when this argument, taken alone and with its " +
              "premises as they are now assessed, settles its " +
              "conclusion: the inference leaves no real room for doubt, " +
              "and the premises it rests on are established (a settled " +
              "premise left unassessed counts when the evaluation says " +
              "why it is settled). Most arguments are not decisive, and " +
              "false is the ordinary case. When you set it, the " +
              "evaluation says what makes the argument decisive, and the " +
              "claim's status agrees with it. The mark lapses with its " +
              "premises: reconsider it when one of them is reassessed.",
          },
        },
        required: ["argument_id", "verdict", "evaluation"],
      },
    },
    {
      name: "add_relationship_edge",
      description:
        "Attach an EXISTING claim as a subclaim, by id. Use this when match_claim " +
        "found that the dependency you want already exists (as itself, a rewording, " +
        "or its negation): link it instead of minting a duplicate. A related node " +
        "that is not the dependency you need is not a subclaim; record it with " +
        "add_related_claim. Edges to your " +
        "claim's decomposition are yours to own. A subclaim may belong to several " +
        "of the claim's arguments (§7): calling this again for an edge that already " +
        "exists, with another argument_id, groups that edge under the second " +
        "argument too (the edge itself is not duplicated). The result says whether " +
        "the edge was created or already existed, and whether the grouping was " +
        "added or already there.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: {
            type: "string",
            description: "The UUID of the parent claim (the claim you steward)",
          },
          child_id: {
            type: "string",
            description: "The UUID of the existing claim to attach as a subclaim",
          },
          relation: {
            type: "string",
            enum: [...RELATION_TYPES],
            description: RELATION_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why this dependency holds",
          },
          argument_id: {
            type: "string",
            description:
              "Optional UUID of an argument (from add_argument, on parent_id) to " +
              "group this subclaim under. Repeat the call with another " +
              "argument_id to share the subclaim between arguments.",
          },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "add_related_claim",
      description:
        "Record a lateral link from your claim to another that is neither its " +
        "premise nor its conclusion (§19): a rival explanation, the other half of " +
        "one public position, or a formulation kept separate because identity was " +
        "unclear. Symmetric and non-evaluative: it renders as a see-also on both " +
        "pages and never enters propagation or your assessment. Use it instead of " +
        "stretching 'assumes' or leaving the connection in prose. If the other " +
        "claim being false would make yours false, ill-posed, or less credible, " +
        "that is a decomposition edge, not a link.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The UUID of the claim you steward" },
          other_claim_id: {
            type: "string",
            description: "The UUID of the related claim (an existing claim; match_claim first)",
          },
          kind: {
            type: "string",
            enum: [...CLAIM_LINK_KINDS],
            description: CLAIM_LINK_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why a reader of either claim would want the other",
          },
        },
        required: ["claim_id", "other_claim_id", "kind", "reasoning"],
      },
    },
    {
      name: "add_decomposition_edge",
      description:
        "Create a NEW subclaim and attach it to a claim's decomposition. Use only " +
        "after match_claim confirms the proposition does NOT already exist; " +
        "otherwise use add_relationship_edge to link the existing claim.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: {
            type: "string",
            description: "The UUID of the parent claim",
          },
          child_text: {
            type: "string",
            description: "Text of the subclaim to add",
          },
          relation: {
            type: "string",
            enum: [...RELATION_TYPES],
            description: RELATION_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why this decomposition is valid",
          },
          argument_id: {
            type: "string",
            description:
              "Optional UUID of an argument (from add_argument) to group this " +
              "subclaim under",
          },
          importance: {
            type: "number",
            description:
              "The subclaim's importance, 0..1, judged as set_claim_importance " +
              "describes (not logical necessity: uncontested bedrock scores " +
              "low even when the parent is false without it). Below the " +
              "decomposition threshold the subclaim is left an embedded stub. " +
              "Defaults to 0.5 if omitted.",
          },
          contestation: {
            type: "number",
            description:
              "How live the subclaim is in the discourse at large (0.0-1.0), " +
              "as set_claim_importance describes.",
          },
          seed_credence: {
            type: "number",
            description:
              "Your prior credence (0.0-1.0) that this subclaim, as stated, is " +
              "TRUE — the same judgment you form anyway while weighing what the " +
              "parent turns on, recorded so the subclaim can be read at a " +
              "glance before its own Steward runs. A seed, not an assessment: " +
              "the subclaim stays unassessed, the system marks the seed " +
              "preliminary and attributes it to you mechanically, and its own " +
              "Steward's verdict supersedes it. Omit it where one number would " +
              "be false precision, exactly as with claim_credence.",
          },
          seed_note: {
            type: "string",
            description:
              "Optional brief preliminary note to accompany seed_credence: a " +
              "paragraph or two (under 2,000 characters) on why the prior sits where it does, written " +
              "in the reader-facing register. NOT a full assessment — no " +
              "sub-decomposition, no verdict language, and do not write 'this " +
              "is preliminary' yourself; the page labels the note preliminary " +
              "and names you (the parent claim's Steward) automatically.",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description:
              "The subclaim's domain tags, from the closed list of domains " +
              "that have a skill. Omit to inherit the parent's tags, which is " +
              "right for most dependencies; pass your own (possibly empty) " +
              "list when the subclaim belongs to a different domain than its " +
              "parent, as when a mathematical claim rests on an empirical one.",
          },
          claim_type: {
            type: "string",
            enum: [...CLAIM_TYPE_VALUES],
            description:
              "The subclaim's proposition kind. Omit to inherit the parent's; " +
              "pass it when the subclaim is of another kind, as when a " +
              "mathematical proposition rests on an empirical_derived claim " +
              "about a proof or a dataset.",
          },
          kind: {
            type: "string",
            enum: [...NODE_KINDS],
            description:
              "The new node's kind (§2, §7a): claim (the default), quantity " +
              "when the premise is about a value (link the quantity itself, " +
              "never a claim that it lies above or below a figure), or " +
              "question when what your claim asserts turns on how a question " +
              "is answered.",
          },
          definition: {
            type: "object",
            description:
              "For a new quantity: {measures, population, conditions, unit}, " +
              "where unit is {kind: proportion|count|currency|temperature|" +
              "year|duration|rate|measure, symbol, noun, currency, per, " +
              "scale, min, max}. child_text is the definition in words.",
          },
        },
        required: ["parent_id", "child_text", "relation", "reasoning"],
      },
    },
    {
      name: "add_parent_claim",
      description:
        "Create a NEW node ABOVE the node you steward and attach yours beneath " +
        "it. The parent may be of any kind (§2, §7a): a claim your node is an " +
        "argument for, a meta-claim about (\"X's paper proves P\" is about P), " +
        "or a special case of; a quantity your node bears on the value of; or " +
        "a question your node answers, is a subquestion of, or is presupposed " +
        "by. Use only after match_claim confirms the node does NOT already " +
        "exist; when it exists, use propose_parent_edge instead, since edges " +
        "into an existing node belong to its own Steward. The new node is " +
        "onboarded like any other and its Steward owns it from then on; the " +
        "edge you create is its starting structure, not a verdict. Same bar as " +
        "a subclaim (§2): a reusable node of the discourse, not a heading " +
        "invented to hang things under. Say in reasoning which claims led you " +
        "to it.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the node you steward (it becomes the child)",
          },
          parent_text: {
            type: "string",
            description:
              "Canonical text of the new parent (§3): a claim's proposition, a " +
              "question's neutral wording, or a quantity's definition in words",
          },
          kind: {
            type: "string",
            enum: [...NODE_KINDS],
            description:
              "The new parent's kind (§2, §7a): claim (the default); quantity " +
              "when your node bears on what a value is (pass definition); or " +
              "question when your node is an answer to it, a subquestion of " +
              "it, or something it presupposes.",
          },
          definition: {
            type: "object",
            description:
              "For a new quantity parent: {measures, population, conditions, " +
              "unit}, where unit is {kind: proportion|count|currency|" +
              "temperature|year|duration|rate|measure, symbol, noun, currency, " +
              "per, scale, min, max}.",
          },
          relation: {
            type: "string",
            enum: [...UPWARD_RELATION_TYPES],
            description:
              "How your node bears on the new parent, read from the parent's " +
              "side. Under a claim or a quantity: supports when yours is " +
              "evidence or an argument for it (a claimed proof of P supports " +
              "P), specifies when yours is a special case, requires when the " +
              "parent is false without yours. Under a question: answers when " +
              "yours is a candidate answer (a claim or quantity; pass basis), " +
              "part_of when yours is a subquestion whose answer it needs, " +
              "assumes or requires when the question presupposes yours. The " +
              "relation types are defined on add_decomposition_edge.",
          },
          basis: {
            type: "string",
            enum: [...ANSWER_BASES],
            description:
              "With relation answers: why your node is in the question's " +
              "answer set, as add_answer records it: quality (a serious answer " +
              "whoever holds it), prominence (widely held or cited), or both.",
          },
          reasoning: {
            type: "string",
            description:
              "Why the graph needs this node and why yours sits under it; " +
              "name the claims that led you here",
          },
          claim_type: {
            type: "string",
            enum: [...CLAIM_TYPE_VALUES],
            description:
              "The parent's proposition type (separate from kind). Omit to inherit yours; pass it when " +
              "the parent is of another kind, as when a claim about a proof " +
              "(empirical_derived) sits under a mathematical proposition.",
          },
          importance: {
            type: "number",
            description:
              "How much it is worth getting the parent right, 0..1 " +
              "(consequence-if-wrong × liveness). Below the decomposition " +
              "threshold it is left an embedded stub; defaults to 0.5.",
          },
          contestation: {
            type: "number",
            description:
              "How live the parent is in the discourse at large (0.0-1.0), " +
              "recorded separately from importance.",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description:
              "The parent's domain tags, from the closed list of domains that " +
              "have a skill. Omit to inherit yours.",
          },
        },
        required: ["claim_id", "parent_text", "relation", "reasoning"],
      },
    },
    {
      name: "propose_parent_edge",
      description:
        "Propose that an EXISTING node of any kind adopt yours beneath it: " +
        "the claim your node is an argument for, about, or a special case " +
        "of, the quantity it bears on, or the question it answers, is part " +
        "of, or is presupposed by, when match_claim found it already in the " +
        "graph but the edge is missing. Edges into another node's " +
        "decomposition are its Steward's to write (Part VIII), so this " +
        "enqueues that Steward with your case; it writes nothing itself.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the node you steward (the would-be child)",
          },
          parent_id: {
            type: "string",
            description: "The UUID of the existing node that should gain yours beneath it",
          },
          relation: {
            type: "string",
            enum: [...UPWARD_RELATION_TYPES],
            description:
              "The relation you propose, read from the parent's side. Under " +
              "a question: answers (yours is a candidate answer), part_of " +
              "(yours is a subquestion), or assumes/requires (it presupposes " +
              "yours); answers and part_of are for a question parent only. " +
              RELATION_GUIDANCE,
          },
          reasoning: {
            type: "string",
            description: "Why the edge holds; the parent's Steward reads this and decides",
          },
        },
        required: ["claim_id", "parent_id", "relation", "reasoning"],
      },
    },
    {
      name: "set_claim_importance",
      description:
        "Set a claim's importance (0..1): how much it is worth spending scarce " +
        "intelligence to get it right (roughly consequence-if-wrong × " +
        "liveness), NOT mere logical load-bearing-ness. A revisable judgment " +
        "that scales effort and feeds the value estimates funding decisions read. " +
        "Local dependents are only a " +
        "local signal: a claim central to a niche subfield is still low-importance " +
        "if the subfield is peripheral and the claim uncontested. An uncontested " +
        "fact is low importance even if much depends on it, because getting it " +
        "right is free; reserve high values for contested, consequential " +
        "claims. The other tools that take importance and contestation " +
        "(add_decomposition_edge, add_parent_claim) mean the same by them.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The UUID of the claim" },
          importance: {
            type: "number",
            description:
              "Importance score in [0, 1]. Anchor against constitution §19: " +
              "~0.9 central, ~0.6 major, ~0.35 notable, ~0.15 minor/settled.",
          },
          contestation: {
            type: "number",
            description:
              "How live the claim is in the discourse at large (0.0-1.0), " +
              "disputed or actively consulted, recorded separately from " +
              "importance: ~0 for a settled fact nobody disputes or consults " +
              "(even a foundational one), ~1 for an actively " +
              "argued crux with credible parties on both sides. This is the " +
              "liveness half of the importance formula stated on its own; " +
              "it multiplies importance in the expected-value estimate the " +
              "allocation engine funds work by, so a live dispute genuinely " +
              "draws attention sooner.",
          },
          reasoning: {
            type: "string",
            description: "Why the claim has this importance",
          },
        },
        required: ["claim_id", "importance", "reasoning"],
      },
    },
    {
      name: "set_claim_domains",
      description:
        "Record the claim's domain tags: which domain skills every " +
        "administrator's run on this claim is pointed to from now on. This is " +
        "the authoritative judgment; it supersedes the Extractor's prior, an " +
        "inherited tag, and the backfill. A tag does not load anything: to " +
        "read a skill in this run, load it with load_skill. Pass an empty list " +
        "for a claim that belongs to no domain with a skill.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim to tag",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description:
              "The domain tags, from the closed list of domains that have a " +
              "skill (see the Skills section of your role).",
          },
          reasoning: {
            type: "string",
            description: "Why these tags are right for this claim",
          },
        },
        required: ["claim_id", "domains", "reasoning"],
      },
    },
    {
      name: "log_stewardship_decision",
      description:
        "Log a stewardship decision for the audit trail. Use this to record " +
        "significant decisions you make about a claim.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim",
          },
          action_taken: {
            type: "string",
            description:
              "What action was taken (e.g. 'reassessed', 'updated_canonical_form', 'no_action_needed')",
          },
          reasoning: {
            type: "string",
            description: "Full reasoning for the decision",
          },
        },
        required: ["claim_id", "action_taken", "reasoning"],
      },
    },
    getNotifyStewardToolDefinition("steward"),
    {
      name: "escalate_to_curator",
      description:
        "Flag a graph-level structural concern for the Curator, e.g. this claim " +
        "looks like a duplicate/counterpart of another, conflates two distinct " +
        "claims (should be split), or should be linked to a related claim. " +
        "Individuation (merge/split) and cross-claim edges are the Curator's domain, " +
        "not yours; raise it and let the Curator adjudicate. The concern goes on the " +
        "ledger as a curation request: curation is funded work, so it runs when a " +
        "mandate judges it worth buying, and one run reads every concern waiting on " +
        "the claim. Say which defect you suspect (defect) and name the other claim " +
        "when you know it: the mandate's officers decide on what the request names, " +
        "and a concern with no structural defect is not one for the Curator. A node " +
        "that only wants a first assessment is not either: it already has its " +
        "assessment on the ledger. An argument " +
        "recorded on the wrong side of your claim is not one of these: its stance " +
        "is yours to correct with revise_argument, and the Curator, which never " +
        "flips an argument's stance itself, would send it back to you.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: {
            type: "string",
            description: "The UUID of the claim with the structural concern",
          },
          other_claim_id: {
            type: "string",
            description:
              "Optional: the UUID of the suspected duplicate, counterpart, or claim it " +
              "should be linked to.",
          },
          defect: {
            type: "string",
            enum: [...CURATION_DEFECTS],
            description: CURATION_DEFECT_DESCRIPTION,
          },
          concern: {
            type: "string",
            description:
              "What you noticed and why it is that defect (e.g. 'likely duplicate of <id>: " +
              "both state ...', 'conflates X and Y')",
          },
        },
        required: ["claim_id", "defect", "concern"],
      },
    },
    // Correcting structure already built (#741): remove, retype, ungroup,
    // revise and retire.
    ...getStewardStructureToolDefinitions(),
    // Where a source makes, attacks or mentions an argument (#541), and the
    // passages ingestion left unplaced on the node.
    getArgumentInstanceToolDefinition(),
    getPlaceArgumentPassageToolDefinition(),
  ];
}

/**
 * The Steward's writes that name a node other than (or as well as) its own,
 * with the input fields that carry the ids: checked for merged nodes before
 * the write (#884).
 */
const MERGED_TARGET_KEYS: Record<string, readonly string[]> = {
  record_claim_instance: ["claim_id"],
  add_relationship_edge: ["parent_id", "child_id"],
  add_related_claim: ["claim_id", "other_claim_id"],
  add_decomposition_edge: ["parent_id", "claim_id"],
  add_parent_claim: ["claim_id"],
  propose_parent_edge: ["claim_id", "parent_id"],
};

export async function executeStewardTool(
  toolName: string,
  input: Record<string, unknown>,
  // Why this run happened (the enqueued trigger/context). Threaded into the
  // assessment row (#182) so a re-assessment records its actual cause rather
  // than a generic "steward_reassessment". `model` is the raw API id of the
  // model running this stewardship, recorded on the assessment row (#294) so
  // every verdict names its assessor.
  run: {
    trigger?: string;
    context?: string;
    model?: string;
    // Who is recording, for the one row a researcher may also write
    // (record_claim_instance): the Steward by default. A researcher a
    // Steward launched records instances on the run's claim and nothing
    // else (researcher.ts holds that line); its rows carry "researcher" so
    // the Steward and readers can tell who recorded them.
    recordedBy?: InstanceRecorder;
  } = {}
): Promise<string> {
  try {
    // Only the owner writes (Part VIII): a write aimed at another node is
    // refused with the route that reaches it (#757).
    const notOwn = await ownershipRefusal(toolName, input);
    if (notOwn) return notOwn;
    // A write that names a merged node is refused and told the survivor
    // (#884). These tools checked only that the other node existed, so an
    // edge, a link or an instance could land on an absorbed row.
    const mergedKeys = MERGED_TARGET_KEYS[toolName];
    if (mergedKeys) {
      const merged = await mergedInputRefusal(input, mergedKeys);
      if (merged) return JSON.stringify({ success: false, message: merged });
    }
    switch (toolName) {
      case "update_claim_assessment": {
        const claimId = input.claim_id as string;
        // A model may write a status in uppercase (VERIFIED, INCONCLUSIVE, …)
        // but the enum — and every reader — is lowercase; normalize like the
        // relation-type writes do so a prose-following model can't persist an
        // out-of-enum value.
        const status = String(input.status ?? "").toLowerCase();
        // ...and a status that is missing or still out of the enum bounces the
        // write back rather than persisting the literal "undefined" (GLM 5.3
        // Flash omitted the field on half its assessments in a corpus run; the
        // reasoning argued "supported" while the row said nothing).
        if (!(ASSESSMENT_STATUSES as readonly string[]).includes(status)) {
          const retired = RETIRED_STATUSES[status];
          return JSON.stringify({
            success: false,
            message:
              `Assessment NOT recorded: status ${input.status === undefined ? "is missing" : `"${String(input.status)}" is not one of`} ` +
              `${ASSESSMENT_STATUSES.join(" | ")}. ` +
              (retired ? `${retired} ` : "") +
              `Call update_claim_assessment again with a valid status.`,
          });
        }
        const confidence = input.confidence as number;
        // Optional: only recorded where a probability of truth is meaningful
        // (constitution §10). null, not 0 — "no credence stated" is a distinct
        // signal from "credence that the claim is false".
        const claimCredence =
          typeof input.claim_credence === "number" ? input.claim_credence : null;
        // Optional exit judgment for effort allocation (#172): recorded on the
        // assessment row and read by the valuer and the queue priority as the
        // expected gain from another pass (NODE_MARGINAL_YIELD_SQL). null =
        // not stated, read as 1.0.
        const marginalYield = clampUnit(input.marginal_yield) ?? null;
        const reasoningTrace = input.reasoning_trace as string;
        // Reader-facing assessment (still persisted to the `summary` column). Also
        // accept the legacy `summary` key so an in-flight tool call from the older
        // prompt still lands, and fall back to the reasoning trace when neither is
        // given, so the page never renders blank — the UI has the same fallback, but
        // keeping the column populated means a later render never has to.
        const summary =
          ((input.assessment ?? input.summary) as string | undefined)?.trim() || reasoningTrace;

        // Both texts may reference claims inline as [[claim:<uuid>|phrase]]
        // (issue #203). A link to a claim that does not exist would sit as a
        // dead link in front of every reader, so a hallucinated id bounces the
        // write back — the steward re-calls with the id fixed or the reference
        // in plain text.
        const linkedIds = [
          ...new Set(
            [...parseClaimLinks(summary), ...parseClaimLinks(reasoningTrace)].map(
              (l) => l.claimId
            )
          ),
        ];
        if (linkedIds.length > 0) {
          const found = await rawQuery<{ id: string }>(
            `SELECT id FROM claims WHERE id = ANY($1::uuid[])`,
            [linkedIds]
          );
          const foundIds = new Set(found.map((r) => r.id));
          const unknown = linkedIds.filter((id) => !foundIds.has(id));
          if (unknown.length > 0) {
            return JSON.stringify({
              success: false,
              code: "CLAIM_NOT_FOUND",
              message:
                `These linked claims do not exist: ${unknown.join(", ")}. ` +
                `Link only real claims (ids from get_claim or from ` +
                `this run), or drop the link and name the claim in plain text. ` +
                `Nothing was written, and no link is corrected for you: ` +
                `\`unresolved\` lists, for each, the nearest ids this run has seen.`,
              unresolved: await Promise.all(
                unknown.map(async (id) => {
                  const { code: _code, ...candidates } = await writeIdCandidates(id);
                  return candidates;
                })
              ),
            });
          }
        }

        const kindRefusal = await wrongKindForAssessment(claimId);
        if (kindRefusal) return kindRefusal;

        // A node may carry a version at each label, and this run writes its
        // own label's (judgment-version-service.ts). Whether to record one
        // on a node that carries another label, or to leave the one it
        // reads standing, is the Steward's judgment
        // (left-standing-service.ts).
        // The judgment of a mirrored node at the node's own label is the
        // public graph's, and nothing here records one in its place
        // (mirrored-node-service.ts). Asked before anything is written.
        if (await publicGraphJudges(claimId)) {
          return JSON.stringify({ success: false, message: publicJudgmentMessage("An assessment of it") });
        }

        const db = getDb();
        // The verdict in force before this one, for the event a subscriber
        // reads; never a reason to fail the verdict itself.
        let before: { status: string | null } | undefined;
        try {
          [before] = await db
            .select({ status: assessmentsInForce.status })
            .from(assessmentsInForce)
            .where(eq(assessmentsInForce.claimId, claimId));
        } catch {
          before = undefined;
        }

        // Retire this label's current version, and no other label's: each
        // stays in force for the readers and runs that go by it.
        await db
          .update(assessments)
          .set({ isCurrent: false })
          .where(
            and(
              eq(assessments.claimId, claimId),
              eq(assessments.isCurrent, true),
              eq(assessments.sensitivityLabel, currentLabel())
            )
          );

        // Insert new assessment
        const [written] = await db.insert(assessments).values({
          claimId,
          status,
          confidence,
          claimCredence,
          marginalYield,
          summary,
          reasoningTrace,
          isCurrent: true,
          trigger: run.trigger ?? "steward_reassessment",
          triggerContext: run.context?.trim() ? run.context : null,
          // Which model produced this verdict (#294). Null only when the run
          // context doesn't carry it (e.g. legacy call sites).
          model: run.model ?? null,
          // Funding disclosure (§19): if this run is paid work (an assessment
          // order or a grant's budget job), the usage context carries the
          // payer's job id — stamped mechanically, never by the agent.
          fundedByJobId: getUsageContext().jobId ?? null,
          // Provenance of the standards applied: the domain skills the run
          // carried, stamped from the usage context the agent set once it
          // resolved them (never by the agent's own hand). [] = an unskilled
          // run; null only for legacy call sites outside an agent.
          skills: getUsageContext().skills ?? null,
          // The run that wrote this verdict, so its transcript is one join
          // away; stamped from the usage context, never by the agent.
          runId: getUsageContext().runId ?? null,
          // Who may read the verdict (src/labels.ts): the label the run
          // writes at, stamped the same way.
          sensitivityLabel: currentLabel(),
        }).returning({ id: assessments.id });

        // What the verdict was made against: the nodes under the claim with
        // their judgments in force, and its attached sources (#566). This
        // write has no transaction, so a failure here leaves the verdict
        // standing with inputs_recorded false, which readers report as "not
        // recorded", rather than failing a verdict that is already written.
        if (written?.id) {
          const { recordEvent } = await import("../../services/event-service.js");
          await recordEvent({
            kind: "assessed",
            nodeId: claimId,
            refs: { assessment: written.id },
            summary: before?.status
              ? before.status === status
                ? `Reassessed: still ${status} (confidence ${confidence}).`
                : `Its verdict moved from ${before.status} to ${status} (confidence ${confidence}).`
              : `First assessed: ${status} (confidence ${confidence}).`,
            payload: { status_before: before?.status ?? null, status_after: status, confidence },
          });
          try {
            await recordJudgmentInputs(rawQuery, "assessment", written.id, claimId);
            await recordMadeBeside(rawQuery, "assessments", "assessment", written.id, claimId);
          } catch (err) {
            console.error(
              "[steward] failed to record what an assessment was made against:",
              err instanceof Error ? err.message : err
            );
          }
        }

        // Argument evaluations are derived within the assessment (issue #173),
        // so a fresh verdict makes every named argument's evaluation due: list
        // the ones that are missing or that predate this assessment. A nudge,
        // not a gate — confirming an unchanged evaluation is a cheap re-call.
        const evalStates = await getEvaluationStateForClaim(claimId);
        const missing = evalStates.filter((s) => s.content === null);
        const stale = evalStates.filter((s) => s.stale);
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(
            `${missing.length} named argument(s) have no evaluation yet: ` +
              missing.map((s) => `"${s.argument_name}"`).join(", ") +
              `. Evaluate each with evaluate_argument.`
          );
        }
        if (stale.length > 0) {
          parts.push(
            `${stale.length} argument evaluation(s) predate this assessment: ` +
              stale.map((s) => `"${s.argument_name}"`).join(", ") +
              `. Re-evaluate any whose premises' standing changed, or re-record ` +
              `them unchanged to confirm they still hold.`
          );
        }

        return JSON.stringify({
          success: true,
          message:
            `Assessment updated for claim ${claimId}: ${status} (${confidence})` +
            (parts.length > 0 ? ` ${parts.join(" ")}` : ""),
        });
      }

      case "record_claim_instance": {
        const claimId = input.claim_id as string;
        const recordedBy = run.recordedBy ?? "claim_steward";
        // The Steward owns the instance set: it corrects, detaches and
        // reattaches. A researcher has none of those tools, so what would be
        // a next step for the Steward is, for it, a line in its report.
        const byResearcher = recordedBy === "researcher";
        const url = typeof input.url === "string" ? input.url.trim() : "";
        const verbatimText =
          typeof input.verbatim_text === "string"
            ? input.verbatim_text.trim()
            : "";
        // Same normalization as the assessment status: the prompt discusses
        // stances in prose, so a cased value must not escape the enum.
        const stance = String(input.stance ?? "").toLowerCase();
        const optText = (v: unknown): string | undefined =>
          typeof v === "string" && v.trim() ? v.trim() : undefined;

        // An http(s) URL, or the address of a reading kept from a
        // connection (services/reading-address.ts).
        const addressProblem = await sourceAddressProblem(
          url,
          "url must be the http(s) URL of the source you read; an " +
            "instance without provenance is not recordable."
        );
        if (addressProblem) {
          return JSON.stringify({ success: false, message: addressProblem });
        }
        if (!verbatimText) {
          return JSON.stringify({
            success: false,
            message:
              "verbatim_text is required: the verbatim passage where the " +
              "source states the claim (or its negation).",
          });
        }
        // A passage, not a document: an instance records where the claim was
        // stated, and the source row keeps the document.
        if (verbatimText.length > 2000) {
          return JSON.stringify({
            success: false,
            message:
              `verbatim_text is ${verbatimText.length} chars; keep it under ` +
              `2000. Record the passage that states the claim, not the ` +
              `surrounding document.`,
          });
        }
        if (!isInstanceStance(stance)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown stance "${stance}". Use "affirms" (the source asserts ` +
              `the canonical claim), "denies" (it asserts the negation), ` +
              `"poses" (it states the proposition as an open question ` +
              `without taking a side), or "mentions" (it refers to the claim ` +
              `without asserting, denying or posing it).`,
          });
        }

        // A hallucinated claim id would otherwise surface as an opaque FK
        // error from the insert.
        const claimRows = await rawQuery<{ id: string; kind: string }>(
          `SELECT id, kind FROM claims WHERE id = $1`,
          [claimId]
        );
        if (claimRows.length === 0) {
          return JSON.stringify({
            success: false,
            message: `Claim not found: ${claimId}`,
            ...(await writeIdCandidates(claimId)),
          });
        }
        // A figure is an instance of its quantity, and a question is asked or
        // answered (§4, §7a): each has its own tool.
        if (claimRows[0]!.kind === "quantity") {
          return JSON.stringify({
            success: false,
            message: `Node ${claimId} is a quantity: record a source's figure with record_estimate.`,
          });
        }
        if (claimRows[0]!.kind === "question") {
          return JSON.stringify({
            success: false,
            message: `Node ${claimId} is a question: record where a source asks or answers it with record_question_instance.`,
          });
        }
        // A probability the source itself states for the claim (§4): what
        // the source said, kept with its instance.
        const statedProbability =
          input.stated_probability === undefined || input.stated_probability === null
            ? null
            : Number(input.stated_probability);
        if (statedProbability !== null && !(statedProbability >= 0 && statedProbability <= 1)) {
          return JSON.stringify({
            success: false,
            message: "stated_probability must be between 0 and 1, as the source states it.",
          });
        }

        const kindRefusal = sourceKindRefusal(input.source_kind);
        if (kindRefusal) return JSON.stringify({ success: false, message: kindRefusal });

        // Found-or-created by URL, WITHOUT enqueueing extraction: recording a
        // sighting must stay a cheap side effect of this run, never spawn an
        // extraction pipeline for the source.
        const source = await getOrCreateSource({
          url,
          title: optText(input.title),
        });
        // What kind of document it is, where the agent said: filled in where
        // the source has none more specific, and reported back either way.
        const sourceKind = await applyStatedSourceKind(source.id, input.source_kind);

        // Dedup on (claim, source, speaker) so re-assessments that reread the
        // same source don't pile up duplicate instances (#278), while a
        // jointly signed document can still hold each author's own assertion
        // (#481). Speakers compare case-insensitively. An unattributed row on
        // either side matches any voice: without a name there is no telling
        // it is a different one, so a call without a speaker deduplicates
        // against the source as before, and an unattributed instance blocks a
        // named one until it is attributed.
        const speaker = optText(input.speaker);
        const [existing] = await rawQuery<{
          id: string;
          stance: string;
          speaker: string | null;
          detached_at: Date | null;
          detached_reason: string | null;
        }>(
          `SELECT id, stance, speaker, detached_at, detached_reason
           FROM claim_instances
           WHERE claim_id = $1 AND source_id = $2
             AND ($3::text IS NULL OR speaker IS NULL
                  OR lower(speaker) = lower($3::text))
           ORDER BY COALESCE(lower(speaker) = lower($3::text), false) DESC,
                    (detached_at IS NULL) DESC, created_at
           LIMIT 1`,
          [claimId, source.id, speaker ?? null]
        );
        const voice = existing?.speaker ? ` from ${existing.speaker}` : "";
        // An unattributed instance matched a named voice: it may be this
        // speaker's assertion or another's, and only the Steward can tell.
        const unattributedNote =
          existing && speaker && !existing.speaker
            ? byResearcher
              ? ` The existing instance names no speaker, so it may be this ` +
                `voice or another one. If it is a different speaker's ` +
                `assertion, say so in your report (instance_id ${existing.id}, ` +
                `and ${speaker}'s passage) for the Steward to attribute.`
              : ` The existing instance names no speaker, so it may be this ` +
                `voice or another one. If it is a different speaker's ` +
                `assertion, attribute it with update_claim_instance ` +
                `(instance_id ${existing.id}), then record ${speaker}'s again.`
            : "";
        // A detached instance from this source records a judgment that it
        // does not state the claim; a new row would silently overturn it.
        if (existing?.detached_at) {
          return JSON.stringify({
            ...sourceKind,
            success: false,
            deduplicated: true,
            instance_id: existing.id,
            message:
              `This source has an instance${voice} on this claim that was detached` +
              (existing.detached_reason ? ` ("${existing.detached_reason}")` : "") +
              `; nothing new was written. If your reading shows the source ` +
              `does belong to the claim, ` +
              (byResearcher
                ? `say so in your report, with the passage, for the Steward ` +
                  `to weigh reattaching it (instance_id ${existing.id}).`
                : `reattach it with reattach_claim_instance (instance_id ` +
                  `${existing.id}) and correct it with update_claim_instance ` +
                  `if needed.`) +
              unattributedNote,
          });
        }
        if (existing) {
          return JSON.stringify({
            ...sourceKind,
            success: true,
            deduplicated: true,
            instance_id: existing.id,
            message:
              `This source is already recorded as an instance${voice} of this ` +
              `claim (stance: ${existing.stance}); nothing new was written.` +
              (existing.stance !== stance
                ? byResearcher
                  ? ` Note: the existing instance's stance differs from the ` +
                    `one you just observed. Say in your report whether the ` +
                    `source takes both sides or the recorded stance is wrong, ` +
                    `with the passage (instance_id ${existing.id}); the ` +
                    `Steward corrects instances.`
                  : ` Note: the existing instance's stance differs from the one ` +
                    `you just observed — if the source genuinely takes both ` +
                    `sides, weigh that in your assessment and note it in your ` +
                    `reasoning_trace; if the recorded stance is simply wrong, ` +
                    `correct it with update_claim_instance (instance_id ` +
                    `${existing.id}) and say why.`
                : "") +
              (speaker
                ? unattributedNote
                : ` If this passage is a different speaker's assertion in ` +
                  `the same source, record it again with speaker set.`),
          });
        }

        const db = getDb();
        const [instance] = await db
          .insert(claimInstances)
          .values({
            claimId,
            sourceId: source.id,
            verbatimText,
            context: optText(input.context),
            stance,
            confidence: clampUnit(input.confidence) ?? 1.0,
            speaker,
            publication: optText(input.publication),
            sourceDate: optText(input.source_date),
            link: optText(input.link),
            statedProbability,
            createdBy: recordedBy,
            // The instance is the recording run's, whatever the source's
            // label or the claim's (src/labels.ts).
            sensitivityLabel: currentLabel(),
          })
          .returning();

        return JSON.stringify({
            ...sourceKind,
          success: true,
          instance_id: instance!.id,
          source_id: source.id,
          message:
            `Recorded a ${stance} instance of claim ${claimId} from ` +
            `${source.url ?? url}. ` +
            (byResearcher
              ? `It now counts among the claim's source instances, recorded ` +
                `as yours; the Steward owns the instance set and may correct ` +
                `or detach it. List it in your report.`
              : stance === "mentions"
              ? `The claim page shows it among the sources that mention the ` +
                `claim; it takes no side and is never counted as affirming or denying.`
              : `It now counts among the claim's source instances; weigh its ` +
                `stance in your assessment like any other.`),
        });
      }

      case "update_claim_instance": {
        const claimId = input.claim_id as string;
        const instanceId =
          typeof input.instance_id === "string" ? input.instance_id.trim() : "";
        const reasoning =
          typeof input.reasoning === "string" ? input.reasoning.trim() : "";
        const optText = (v: unknown): string | undefined =>
          typeof v === "string" && v.trim() ? v.trim() : undefined;

        if (!instanceId) {
          return JSON.stringify({
            success: false,
            message:
              "instance_id is required: the UUID of the recorded instance " +
              "to correct, from get_claim_instances.",
          });
        }
        // A correction without its reason is an unexplained edit to another
        // agent's record; the audit trail is the point.
        if (!reasoning) {
          return JSON.stringify({
            success: false,
            message:
              "reasoning is required: say what you read that shows the " +
              "recorded instance misrepresents its source.",
          });
        }

        const patch: Partial<typeof claimInstances.$inferInsert> = {};
        if (input.stance !== undefined && input.stance !== null) {
          const stance = String(input.stance).toLowerCase();
          if (!isInstanceStance(stance)) {
            return JSON.stringify({
              success: false,
              message:
                `Unknown stance "${stance}". Use "affirms" (the source ` +
                `asserts the canonical claim), "denies" (it asserts the ` +
                `negation), "poses" (it states the proposition as an open ` +
                `question without taking a side), or "mentions" (it refers to ` +
                `the claim without asserting, denying or posing it).`,
            });
          }
          patch.stance = stance;
        }
        if (input.confidence !== undefined && input.confidence !== null) {
          const confidence = clampUnit(input.confidence);
          if (confidence === undefined) {
            return JSON.stringify({
              success: false,
              message: "confidence must be a number in [0, 1].",
            });
          }
          patch.confidence = confidence;
        }
        const verbatimText = optText(input.verbatim_text);
        if (verbatimText !== undefined) {
          if (verbatimText.length > 2000) {
            return JSON.stringify({
              success: false,
              message:
                `verbatim_text is ${verbatimText.length} chars; keep it ` +
                `under 2000. Record the passage that states the claim, not ` +
                `the surrounding document.`,
            });
          }
          patch.verbatimText = verbatimText;
          // The passage it was anchored to may not hold the corrected text;
          // the source page re-anchors it on its next read (#507).
          patch.segmentId = null;
        }
        const speaker = optText(input.speaker);
        if (speaker !== undefined) patch.speaker = speaker;
        const publication = optText(input.publication);
        if (publication !== undefined) patch.publication = publication;
        const sourceDate = optText(input.source_date);
        if (sourceDate !== undefined) patch.sourceDate = sourceDate;
        const context = optText(input.context);
        if (context !== undefined) patch.context = context;

        if (Object.keys(patch).length === 0) {
          return JSON.stringify({
            success: false,
            message:
              "Nothing to change: give at least one of stance, confidence, " +
              "speaker, publication, source_date, verbatim_text, or context.",
          });
        }

        // The instance must belong to the claim this steward is responsible
        // for; a hallucinated or foreign id gets a readable bounce, never a
        // silent no-op or an edit to another claim's record.
        const [existing] = await rawQuery<{
          id: string;
          stance: string;
          confidence: number;
          speaker: string | null;
          source_url: string | null;
        }>(
          `SELECT ci.id, ci.stance, ci.confidence, ci.speaker, s.url AS source_url
           FROM claim_instances ci
           JOIN sources s ON s.id = ci.source_id
           WHERE ci.id = $1 AND ci.claim_id = $2
           LIMIT 1`,
          [instanceId, claimId]
        );
        if (!existing) {
          return JSON.stringify({
            success: false,
            message:
              `Instance not found: ${instanceId} is not a recorded instance ` +
              `of claim ${claimId}.`,
          });
        }
        // A question's instances ask or answer it and a quantity's state a
        // figure (§7a, §10); the proposition stances would overwrite that
        // role and drop the instance from its page (#711). Its other
        // fields correct as on any instance.
        if (
          patch.stance !== undefined &&
          (KIND_INSTANCE_STANCES as readonly string[]).includes(existing.stance)
        ) {
          return JSON.stringify({
            success: false,
            message:
              `Instance ${instanceId} is recorded as "${existing.stance}", a role ` +
              `the proposition stances do not describe. Leave stance out to ` +
              `correct its other fields; if its role is wrong, detach it with ` +
              `detach_claim_instance and record it again with ` +
              (existing.stance === "states" ? "record_estimate" : "record_question_instance") +
              `.`,
          });
        }

        const db = getDb();
        await db
          .update(claimInstances)
          .set(patch)
          .where(eq(claimInstances.id, instanceId));

        // The correction lands in the claim's audit trail with its reason,
        // so the change to another agent's record is inspectable.
        const changed = Object.entries(patch)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(", ");
        await db.insert(auditLog).values({
          claimId,
          sensitivityLabel: currentLabel(),
          action: "updated_claim_instance",
          reasoning:
            `Instance ${instanceId} (${existing.source_url ?? "source"}): ` +
            `was stance=${existing.stance}, confidence=${existing.confidence}` +
            (existing.speaker ? `, speaker=${existing.speaker}` : "") +
            `; set ${changed}. ${reasoning}`,
          createdBy: "claim_steward",
        });

        return JSON.stringify({
          success: true,
          instance_id: instanceId,
          updated: Object.keys(patch),
          message:
            `Updated instance ${instanceId} of claim ${claimId} ` +
            `(${changed}); the correction and your reasoning are in the ` +
            `claim's audit trail. Its stance and confidence now feed your ` +
            `assessment as corrected.`,
        });
      }

      case "detach_claim_instance":
      case "reattach_claim_instance": {
        const claimId = String(input.claim_id ?? "").trim();
        const instanceId = String(input.instance_id ?? "").trim();
        const reason = typeof input.reason === "string" ? input.reason : "";
        try {
          if (toolName === "detach_claim_instance") {
            const r = await detachClaimInstance({
              claimId,
              instanceId,
              reason,
              detachedBy: "claim_steward",
            });
            return JSON.stringify({
              success: true,
              instance_id: r.instance_id,
              already_detached: r.already_detached,
              instance_count: r.remaining,
              message: r.already_detached
                ? `Instance ${r.instance_id} was already detached; nothing changed.`
                : `Detached instance ${r.instance_id} from claim ${claimId}; the reason is in ` +
                  `the claim's audit trail. The claim now carries ${r.remaining} instance(s). ` +
                  `If the source map's account relied on this source, refresh it.`,
            });
          }
          const r = await reattachClaimInstance({
            claimId,
            instanceId,
            reason,
            reattachedBy: "claim_steward",
          });
          return JSON.stringify({
            success: true,
            instance_id: r.instance_id,
            was_detached: r.was_detached,
            instance_count: r.total,
            message: r.was_detached
              ? `Reattached instance ${r.instance_id}; it belongs to claim ${claimId} again, ` +
                `at the default position.`
              : `Instance ${r.instance_id} was not detached; nothing changed.`,
          });
        } catch (err) {
          if (err instanceof ClaimInstanceError) {
            return JSON.stringify({ success: false, message: err.message });
          }
          throw err;
        }
      }

      case "set_instance_order": {
        const claimId = String(input.claim_id ?? "").trim();
        try {
          const r = await setInstanceOrder({
            claimId,
            instanceIds: input.instance_ids,
            setBy: "claim_steward",
            reasoning: typeof input.reasoning === "string" ? input.reasoning : null,
          });
          return JSON.stringify({
            success: true,
            ranked: r.ranked,
            message:
              r.ranked.length > 0
                ? `The claim page now shows these ${r.ranked.length} instance(s) first, in ` +
                  `the order given; the rest follow in the default order.`
                : `Cleared the instance order; every instance follows the default order.`,
          });
        } catch (err) {
          if (err instanceof ClaimInstanceError) {
            return JSON.stringify({ success: false, message: err.message });
          }
          throw err;
        }
      }

      case "update_canonical_form": {
        const claimId = input.claim_id as string;
        const newText = input.new_text as string;
        // A node that carries another label is that label's Steward's to
        // change (judgment-version-service.ts): refused, with the reason.
        // So is a node the public graph holds, whatever this run's label
        // (mirrored-node-service.ts): the one refusal, with what to do.
        if (await mirroredNode(claimId)) {
          return JSON.stringify({ success: false, message: mirroredRowMessage("the node's wording and type") });
        }
        const notOurs = await anotherLabelsNode(claimId);
        if (notOurs) {
          return JSON.stringify({ success: false, message: anotherLabelsNodeMessage(notOurs, "wording and type") });
        }
        // Optional type correction (docs/mathematics.md §2.1): the type is a
        // facet the page, the cards, and the map read, so a theorem left as
        // "empirical, derived" is a category error the Steward can fix here.
        const claimType =
          typeof input.claim_type === "string" && input.claim_type.trim()
            ? input.claim_type.trim().toLowerCase()
            : undefined;
        if (claimType !== undefined && !CLAIM_TYPE_VALUES.includes(claimType)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown claim_type "${claimType}". Use one of: ` +
              `${CLAIM_TYPE_VALUES.join(", ")}.`,
          });
        }

        const db = getDb();

        // Update claim text and regenerate embedding
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(newText);
        } catch {
          // Continue without embedding update
        }

        await db
          .update(claims)
          .set({
            text: newText,
            ...(embedding ? { embedding } : {}),
            ...(claimType !== undefined ? { claimType } : {}),
            // The wording changed, so the topic may have: return the claim
            // to the tagging queue (#272). Existing tags stand until the
            // tagger's next pass replaces its own.
            taggedAt: null,
            taggingLeasedAt: null,
            taggingAttempts: 0,
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claimId));

        // The mechanical consequence (docs/mathematics.md §5.7): a wording
        // change may change the proposition, so a published formal
        // statement returns to reviewed pending re-publication, and an open
        // bounty bound to it moves to rebinding in the same transaction.
        const reasoning = typeof input.reasoning === "string" ? input.reasoning : "";
        const demotion = await demotePublishedFormalization(claimId, {
          reason: `canonical form changed${reasoning ? ` (${reasoning.slice(0, 300)})` : ""}`,
          runId: getUsageContext().runId ?? null,
        });

        return JSON.stringify({
          success: true,
          message:
            `Canonical form updated for claim ${claimId}` +
            (claimType !== undefined ? `; claim_type set to ${claimType}` : "") +
            (demotion.formalization
              ? `. The published formal statement (version ${demotion.formalization.version}, ` +
                `${demotion.formalization.id}) was returned to reviewed pending re-publication: a ` +
                `canonical-form change may change the proposition, so a fresh-context review must ` +
                `confirm the statement still matches before it is published again.`
              : "") +
            (demotion.bounties.length > 0
              ? ` The open bounty bound to it (${demotion.bounties.join(", ")}) is now rebinding ` +
                `and accepts no claim until the statement is re-published.`
              : ""),
          formalization_demoted: demotion.formalization?.id ?? null,
          bounties_rebinding: demotion.bounties,
        });
      }

      case "set_claim_domains": {
        const claimId = input.claim_id as string;
        // A node that carries another label is that label's Steward's to
        // change (judgment-version-service.ts): refused, with the reason.
        if (await mirroredNode(claimId)) {
          return JSON.stringify({ success: false, message: mirroredRowMessage("the node's domains") });
        }
        const notOurs = await anotherLabelsNode(claimId);
        if (notOurs) {
          return JSON.stringify({ success: false, message: anotherLabelsNodeMessage(notOurs, "domains") });
        }
        const parsed = parseDomains(input.domains);
        if ("error" in parsed) {
          return JSON.stringify({ success: false, message: parsed.error });
        }
        const db = getDb();
        await db
          .update(claims)
          .set({
            domains: parsed.domains,
            domainsSource: "steward",
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claimId));
        return JSON.stringify({
          success: true,
          message:
            `Domains of claim ${claimId} set to [${parsed.domains.join(", ")}]. ` +
            `The matching skills and their tools join every run on this claim ` +
            `from its next pass; this run continues with the toolset it started with.`,
          domains: parsed.domains,
        });
      }

      case "set_claim_importance": {
        const claimId = input.claim_id as string;
        // A node that carries another label is that label's Steward's to
        // change (judgment-version-service.ts): refused, with the reason.
        if (await mirroredNode(claimId)) {
          return JSON.stringify({ success: false, message: mirroredRowMessage("the node's importance and contestation") });
        }
        const notOurs = await anotherLabelsNode(claimId);
        if (notOurs) {
          return JSON.stringify({ success: false, message: anotherLabelsNodeMessage(notOurs, "importance and contestation") });
        }
        const importance = clampUnit(input.importance);
        if (importance === undefined) {
          return JSON.stringify({
            success: false,
            message: "importance must be a number in [0, 1].",
          });
        }
        // Contestation is recorded alongside importance when the Steward states
        // it (#172 phase 1); absent means "leave the stored judgment as is",
        // never "reset to unjudged".
        const contestation = clampUnit(input.contestation);

        const db = getDb();
        await db
          .update(claims)
          .set({
            importance,
            ...(contestation !== undefined ? { contestation } : {}),
            updatedAt: new Date(),
          })
          .where(eq(claims.id, claimId));

        return JSON.stringify({
          success: true,
          message:
            `Importance of claim ${claimId} set to ${importance}.` +
            (contestation !== undefined
              ? ` Contestation recorded as ${contestation}.`
              : ""),
        });
      }

      case "add_argument": {
        const claimId = input.claim_id as string;
        const name = input.name as string;
        const stance = input.stance as "for" | "against";
        const description = input.description as string;
        // An argument about a quantity has no for or against (§7): it shows
        // something about the value, recorded as `shows`.
        const [node] = await rawQuery<{ kind: string }>(`SELECT kind FROM claims WHERE id = $1`, [claimId]);
        if (node?.kind === "question") {
          return JSON.stringify({
            success: false,
            message:
              "A question has no arguments of its own: its answers carry them. " +
              "Add the answer with add_answer and argue on its page.",
          });
        }
        if (node?.kind === "quantity") {
          const parsed = valueShownSchema.safeParse(input.shows);
          if (!parsed.success) {
            return JSON.stringify({
              success: false,
              message:
                "An argument about a quantity records what it shows about the value " +
                "in place of a stance: pass shows as {text, range}. " +
                parsed.error.issues.map((i) => i.message).join("; "),
            });
          }
          const argument = await addArgument({
            claimId,
            stance: "neutral",
            content: description,
            name,
            description,
            createdBy: "claim_steward",
          });
          await setArgumentShows({ argumentId: argument.id, shows: parsed.data });
          return JSON.stringify({
            success: true,
            message:
              `Created argument "${name}" on quantity ${claimId}, showing ${parsed.data.text}. ` +
              `Attach its premises and the figures it rests on (record_estimate with ` +
              `argument_id), give it a written form with write_argument, and evaluate ` +
              `how strongly it shows that when you record the estimate.`,
            argument_id: argument.id,
          });
        }
        // An argument's conclusion is the claim or its denial (§7); a
        // "neutral" line has no conclusion for its evaluation to rate.
        if (stance !== "for" && stance !== "against") {
          return JSON.stringify({
            success: false,
            message:
              `stance must be "for" or "against". If a line of reasoning ` +
              `bears for the claim on one reading and against it on another, ` +
              `the claim is probably too vague to rate against: propose a ` +
              `split rather than recording a neutral argument.`,
          });
        }

        const argument = await addArgument({
          claimId,
          stance,
          content: description,
          name,
          description,
          createdBy: "claim_steward",
        });

        return JSON.stringify({
          success: true,
          message:
            `Created argument "${name}" (${stance}) on claim ${claimId}. ` +
            `Attach its subclaim edges, then give it a written form with ` +
            `write_argument, and evaluate it with evaluate_argument when you ` +
            `record the claim's assessment.`,
          argument_id: argument.id,
        });
      }

      case "write_argument": {
        const argumentId = input.argument_id as string;
        const content = ((input.content as string) ?? "").trim();

        const argument = await getArgument(argumentId);
        if (!argument) {
          return JSON.stringify({
            success: false,
            message: `Argument not found: ${argumentId}`,
            ...(await writeIdCandidates(argumentId, "argument")),
          });
        }
        if (argument.retiredAt) {
          return JSON.stringify({
            success: false,
            message: `Argument ${argumentId} was retired; it takes no written form.`,
          });
        }

        // Brief means brief: uuid links cost ~46 chars each, so the cap is
        // roomier than the few sentences it is meant to hold, but it still
        // stops essays. The description states it.
        if (content.length > 1000) {
          return JSON.stringify({
            success: false,
            message:
              `Written form is ${content.length} chars; keep it under 1000. ` +
              `State the inference briefly; detail belongs in the subclaims ` +
              `themselves.`,
          });
        }
        if (!hasWrittenForm({ content, description: argument.description })) {
          return JSON.stringify({
            success: false,
            message:
              "That is the argument's label, not a written form: state how " +
              "its premises combine to reach its conclusion.",
          });
        }

        // Mutual checkability: every link must be a subclaim of this
        // argument, one of the claim's ungrouped basis subclaims (#434), or
        // the claim itself, the same targets evaluate_argument accepts; and
        // when the argument has attached subclaims, the form must reference
        // them. An argument whose settled premises live in the prose has no
        // attached subclaims and needs no links (§6, §7; #747). Unknown
        // links fail; unreferenced subclaims only warn, so a steward
        // mid-restructure is nudged, not wedged.
        const links = parseClaimLinks(content);
        const subclaims = await getArgumentSubclaims(argumentId);
        const basis = await getClaimBasisSubclaims(argument.claimId);
        const subclaimIds = new Set(subclaims.map((s) => s.id));
        const linkable = new Set([...subclaimIds, ...basis.map((s) => s.id), argument.claimId]);
        const linkedIds = new Set(links.map((l) => l.claimId));

        const unknown = [...linkedIds].filter((id) => !linkable.has(id));
        if (unknown.length > 0) {
          return JSON.stringify({
            success: false,
            message:
              `These linked claims are neither subclaims of this argument nor ` +
              `ungrouped basis subclaims of its claim: ${unknown.join(", ")}. ` +
              `Link only claims attached to the claim via add_relationship_edge / ` +
              `add_decomposition_edge. A subclaim grouped under another argument ` +
              `joins this one when you call add_relationship_edge again with ` +
              `this argument_id.`,
          });
        }
        if (subclaims.length > 0 && links.length === 0) {
          return JSON.stringify({
            success: false,
            message:
              `This argument has ${subclaims.length} attached subclaim(s); the ` +
              `written form must reference them inline as [[claim:<uuid>]] so a ` +
              `reader can follow each premise to its page. If a subclaim does ` +
              `not belong to this line of reasoning, take it out with ` +
              `ungroup_subclaim.`,
          });
        }

        await setArgumentContent(argumentId, content);

        const unreferenced = subclaims.filter((s) => !linkedIds.has(s.id));
        return JSON.stringify({
          success: true,
          message:
            `Written form saved for argument "${argument.name ?? argumentId}".` +
            (unreferenced.length > 0
              ? ` Note: ${unreferenced.length} subclaim(s) in this argument are ` +
                `not referenced: ` +
                unreferenced
                  .map((s) => `${s.id} ("${s.text.slice(0, 60)}")`)
                  .join("; ") +
                `. Reference every subclaim, or take out of this argument any ` +
                `that does not belong to it (ungroup_subclaim, or ` +
                `remove_subclaim_edge if it does not bear on the claim at all).`
              : ""),
        });
      }

      case "evaluate_argument": {
        const argumentId = input.argument_id as string;
        const verdict = String(input.verdict).toLowerCase();
        const content = ((input.evaluation as string) ?? "").trim();
        const decisive = input.decisive === true;

        if (!isArgumentVerdict(verdict)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown rating "${verdict}". Use one of: ` +
              `${ARGUMENT_VERDICTS.join(", ")} (how far the conclusion ` +
              `follows if the premises hold).`,
          });
        }

        const argument = await getArgument(argumentId);
        if (!argument) {
          return JSON.stringify({
            success: false,
            message: `Argument not found: ${argumentId}`,
            ...(await writeIdCandidates(argumentId, "argument")),
          });
        }
        if (argument.retiredAt) {
          return JSON.stringify({
            success: false,
            message: `Argument ${argumentId} was retired; it takes no evaluation.`,
          });
        }
        if (!argument.name) {
          return JSON.stringify({
            success: false,
            message:
              "Only named arguments carry an evaluation; an unnamed grouping " +
              "is judged in the claim's assessment itself.",
          });
        }

        if (content.length === 0) {
          return JSON.stringify({
            success: false,
            message: "The evaluation prose is required; a bare rating is a label, not a judgment.",
          });
        }
        // Same brevity budget as the written form: links cost ~46 chars each,
        // so the cap is roomier than the few sentences it should hold. The
        // description states it.
        if (content.length > 1200) {
          return JSON.stringify({
            success: false,
            message:
              `Evaluation is ${content.length} chars; keep it under 1200. ` +
              `State whether the inference goes through and where the weight ` +
              `lies; the full audit detail belongs in the claim's reasoning trace.`,
          });
        }

        // Any linked claim must be a subclaim of this argument, one of the
        // parent claim's ungrouped basis subclaims (a framework assumption
        // that sits at the claim level and bears on several arguments, #434),
        // or the parent claim itself; and when the argument has attached
        // subclaims, the load-bearing analysis should point at them — require
        // at least one link then. An argument whose premises live only in its
        // written-form prose has nothing to link, so zero links is allowed in
        // that case.
        const subclaims = await getArgumentSubclaims(argumentId);
        const basis = await getClaimBasisSubclaims(argument.claimId);
        const links = parseClaimLinks(content);
        const linkable = new Set([
          ...subclaims.map((s) => s.id),
          ...basis.map((s) => s.id),
          argument.claimId,
        ]);
        const unknown = [...new Set(links.map((l) => l.claimId))].filter(
          (id) => !linkable.has(id)
        );
        if (unknown.length > 0) {
          return JSON.stringify({
            success: false,
            message:
              `These linked claims are neither subclaims of this argument nor ` +
              `ungrouped basis subclaims of the claim it is about: ` +
              `${unknown.join(", ")}. Link the argument's own subclaims, the ` +
              `claim's basis, or the claim itself; a subclaim grouped under ` +
              `another argument joins this one via add_relationship_edge ` +
              `with this argument_id.`,
          });
        }
        if (subclaims.length > 0 && links.length === 0) {
          return JSON.stringify({
            success: false,
            message:
              "The evaluation must say which premises bear the weight: " +
              "reference the load-bearing subclaim(s) inline as " +
              "[[claim:<uuid>]], as in the written form.",
          });
        }

        // An evaluation is a version too, recorded at this run's label
        // (judgment-version-service.ts). The evaluation of a mirrored
        // argument at the argument's own label is the public graph's
        // (mirrored-node-service.ts).
        if (await publicGraphEvaluates(argumentId)) {
          return JSON.stringify({ success: false, message: publicJudgmentMessage("An evaluation of this argument") });
        }

        // Provenance: stamp the claim assessment this evaluation was derived
        // under, so an evaluation left behind by a later reassessment is
        // detectably stale. Call evaluate_argument AFTER update_claim_assessment
        // so the stamp lands on the fresh assessment. A quantity has no
        // assessment: its evaluations are stamped with the current estimate.
        const [currentEstimate] = await rawQuery<{ id: string }>(
          `SELECT qe.id FROM quantity_estimates_in_force qe JOIN claims c ON c.id = qe.claim_id
            WHERE qe.claim_id = $1 AND c.kind = 'quantity'`,
          [argument.claimId]
        );
        const db = getDb();
        const [currentAssessment] = await db
          .select({ id: assessmentsInForce.id })
          .from(assessmentsInForce)
          .where(eq(assessmentsInForce.claimId, argument.claimId))
          .limit(1);

        await setArgumentEvaluation({
          argumentId,
          verdict,
          content,
          decisive,
          assessmentId: currentAssessment?.id ?? null,
          estimateId: currentEstimate?.id ?? null,
          createdBy: "claim_steward",
        });

        return JSON.stringify({
          success: true,
          message:
            `Evaluation recorded for argument "${argument.name}": ${verdict}` +
            (decisive ? ", decisive." : ".") +
            (currentAssessment
              ? ""
              : ` Note: the claim has no current assessment yet; record one ` +
                `with update_claim_assessment so the evaluation is anchored ` +
                `to it.`),
        });
      }

      case "add_relationship_edge": {
        const parentId = input.parent_id as string;
        const childId = input.child_id as string;
        const relation = String(input.relation ?? "").toLowerCase();
        const reasoning = input.reasoning as string;
        const argumentId = (input.argument_id as string) ?? null;

        if (parentId === childId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be its own subclaim (parent_id === child_id).",
          });
        }
        // The enum is advisory to a model, so check it here (#658): an
        // off-enum relation would be stored as given and read by nothing.
        if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown relation "${String(input.relation)}". Use one of: ` +
              `${RELATION_TYPES.join(", ")}. To change an existing edge's ` +
              `relation, use set_edge_relation.`,
          });
        }

        // Validate the grouping target before touching the graph, so a bad
        // argument id never leaves a half-done write behind.
        let argument: Awaited<ReturnType<typeof getArgument>> = null;
        if (argumentId) {
          argument = await getArgument(argumentId);
          if (!argument) {
            return JSON.stringify({
              success: false,
              message: `Argument not found: ${argumentId}`,
              ...(await writeIdCandidates(argumentId, "argument")),
            });
          }
          if (argument.claimId !== parentId) {
            return JSON.stringify({
              success: false,
              message:
                `Argument ${argumentId} belongs to claim ${argument.claimId}, ` +
                `not to ${parentId}; an argument groups only edges of its own claim.`,
            });
          }
        }

        const db = getDb();
        const [child] = await db
          .select({ id: claims.id, state: claims.state })
          .from(claims)
          .where(eq(claims.id, childId))
          .limit(1);
        if (!child) {
          return JSON.stringify({
            success: false,
            message:
              `Claim not found: ${childId}. Link only real claims (ids from ` +
              `match_claim, get_claim, or add_decomposition_edge).`,
            ...(await writeIdCandidates(childId)),
          });
        }

        // Link an already-existing claim; it has (or will have) its own steward
        // processing, so no enqueue here — just the edge and its grouping.
        // A duplicate edge is reported, not disguised as a fresh link (#437);
        // any other failure propagates to the tool-level error handler.
        const edge = await insertRelationshipEdge({
          parentId,
          childId,
          relationType: relation,
          reasoning,
          confidence: 1.0,
          createdBy: "claim_steward",
        });

        let grouped = false;
        if (argumentId) {
          ({ grouped } = await attachEdgeToArgument(argumentId, edge.id));
        }

        const argumentLabel = argument
          ? `argument "${argument.name ?? argumentId}"`
          : null;
        const message =
          (edge.created
            ? `Linked existing claim ${childId} as a subclaim of ${parentId} (${relation}).`
            : `Edge ${parentId} -> ${childId} (${relation}) already existed; ` +
              `nothing was re-linked, and its reasoning is unchanged (to correct it, call ` +
              `set_edge_relation with the same relation).`) +
          (argumentLabel
            ? grouped
              ? ` Grouped it under ${argumentLabel}.`
              : ` It was already grouped under ${argumentLabel}.`
            : "");

        return JSON.stringify({
          success: true,
          message,
          child_claim_id: childId,
          relationship_id: edge.id,
          created: edge.created,
          ...(argumentId ? { argument_id: argumentId, grouped } : {}),
        });
      }

      case "add_related_claim": {
        const claimId = input.claim_id as string;
        const otherClaimId = input.other_claim_id as string;
        const kind = String(input.kind ?? "").toLowerCase();
        if (!isClaimLinkKind(kind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown link kind "${kind}". Use one of: ${CLAIM_LINK_KINDS.join(", ")}.`,
          });
        }
        if (claimId === otherClaimId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be linked to itself.",
          });
        }
        const db = getDb();
        const [other] = await db
          .select({ id: claims.id })
          .from(claims)
          .where(eq(claims.id, otherClaimId))
          .limit(1);
        if (!other) {
          return JSON.stringify({
            success: false,
            message:
              `Claim not found: ${otherClaimId}. Link only real claims (ids from ` +
              `match_claim or get_claim).`,
            ...(await writeIdCandidates(otherClaimId)),
          });
        }
        const { linked, linkId } = await linkClaims({
          claimId,
          otherClaimId,
          kind,
          reasoning: (input.reasoning as string) ?? "",
          createdBy: "claim_steward",
        });
        return JSON.stringify({
          success: true,
          linked,
          link_id: linkId,
          message: linked
            ? `Linked ${claimId} <-> ${otherClaimId} (${kind}); it now shows as a ` +
              `see-also on both claims.`
            : `A ${kind} link between these claims already existed; nothing was written.`,
        });
      }

      case "add_decomposition_edge": {
        const parentId = input.parent_id as string;
        const childText = input.child_text as string;
        const relation = String(input.relation ?? "").toLowerCase();
        const reasoning = input.reasoning as string;
        const argumentId = (input.argument_id as string) ?? null;
        // As in add_relationship_edge (#658): an off-enum relation is refused
        // before anything is minted.
        if (!(RELATION_TYPES as readonly string[]).includes(relation)) {
          return JSON.stringify({
            success: false,
            message: `Unknown relation "${String(input.relation)}". Use one of: ${RELATION_TYPES.join(", ")}.`,
          });
        }
        // Validate the grouping target first: a bad argument id must not mint
        // an orphan subclaim on its way to failing.
        if (argumentId) {
          const argument = await getArgument(argumentId);
          if (!argument) {
            return JSON.stringify({
              success: false,
              message: `Argument not found: ${argumentId}`,
              ...(await writeIdCandidates(argumentId, "argument")),
            });
          }
          if (argument.claimId !== parentId) {
            return JSON.stringify({
              success: false,
              message:
                `Argument ${argumentId} belongs to claim ${argument.claimId}, ` +
                `not to ${parentId}; an argument groups only edges of its own claim.`,
            });
          }
        }
        const importance = clampUnit(input.importance);
        // Recorded on the new subclaim for the eventual stakes/yield split
        // (#172 phase 1); the deferral gate below still reads only importance.
        const contestation = clampUnit(input.contestation);
        // Steward-seeded prior (#285): the parent Steward's credence that this
        // subclaim is true, plus an optional brief note. Stored on the claim
        // row — never as an assessment — so the subclaim still reads as
        // unassessed everywhere; read paths label the seed preliminary and
        // attribute it to the parent claim mechanically (seedSourceClaimId).
        const seedCredence = clampUnit(input.seed_credence);
        const seedNote =
          typeof input.seed_note === "string" && input.seed_note.trim()
            ? input.seed_note.trim()
            : undefined;
        // A paragraph or two, not an assessment: links cost little here, so the
        // cap is roomier than the prose it should hold, but it stops the seed
        // from becoming the full assessment that belongs to the subclaim's own
        // Steward.
        if (seedNote && seedNote.length > 2000) {
          return JSON.stringify({
            success: false,
            message:
              `seed_note is ${seedNote.length} chars; keep it under 2000. ` +
              `It is a brief preliminary note (a paragraph or two), not the ` +
              `subclaim's assessment — that belongs to its own Steward.`,
          });
        }

        // Domain tags (docs/mathematics.md §3.4): the Steward's own list when
        // it passes one, else the parent's tags, so a subclaim of a tagged
        // claim carries the same skill to its own Steward.
        let domains: string[] = [];
        let domainsSource: "steward" | "inherited" | null = null;
        if (input.domains !== undefined) {
          const parsed = parseDomains(input.domains);
          if ("error" in parsed) {
            return JSON.stringify({ success: false, message: parsed.error });
          }
          domains = parsed.domains;
          domainsSource = "steward";
        }

        // Proposition kind (#468): the Steward's own value when it passes
        // one, else the parent's, so a subclaim of a mathematical claim is
        // not minted empirical_derived by default. Falls back to the schema
        // default only when the parent row cannot be read.
        let claimType: string | undefined =
          typeof input.claim_type === "string" && input.claim_type.trim()
            ? input.claim_type.trim().toLowerCase()
            : undefined;
        if (claimType !== undefined && !CLAIM_TYPE_VALUES.includes(claimType)) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown claim_type "${claimType}". Use one of: ` +
              CLAIM_TYPE_VALUES.join(", "),
          });
        }

        const db = getDb();

        // Where there is more than one label, a parent this run does not
        // read is not found, as add_parent_claim does not find its node:
        // the edge would otherwise be written under a node the run was
        // never shown. A Steward's run names its own node here, so this is
        // a backstop for a caller that is not one.
        if (!oneLabelOnly()) {
          const visible = await rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [parentId]);
          if (visible.length === 0) {
            return JSON.stringify({
              success: false,
              message: `Claim not found: ${parentId}. Pass the id of the node you steward.`,
            });
          }
        }

        if (domainsSource === null || claimType === undefined) {
          const [parent] = await db
            .select({ claimType: claims.claimType, domains: claims.domains })
            .from(claims)
            .where(eq(claims.id, parentId))
            .limit(1);
          if (domainsSource === null) {
            const inherited = parseDomains(parent?.domains ?? []);
            domains = "domains" in inherited ? inherited.domains : [];
            domainsSource = domains.length > 0 ? "inherited" : null;
          }
          if (claimType === undefined) {
            claimType = parent?.claimType ?? undefined;
          }
        }

        // The new node's kind (§2, §7a), and a quantity's definition, checked
        // before anything is written.
        const childKind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim().toLowerCase() : "claim";
        if (!(NODE_KINDS as readonly string[]).includes(childKind)) {
          return JSON.stringify({ success: false, message: `Unknown kind "${childKind}". Use one of: ${NODE_KINDS.join(", ")}.` });
        }
        let childDefinition: ReturnType<typeof quantityDefinitionSchema.parse> | null = null;
        if (childKind === "quantity") {
          const parsed = quantityDefinitionSchema.safeParse(input.definition);
          if (!parsed.success) {
            return JSON.stringify({
              success: false,
              message:
                "A new quantity needs its definition: " +
                parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`).join("; "),
            });
          }
          childDefinition = parsed.data;
        }

        // Create the subclaim
        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(childText);
        } catch {
          // Continue without embedding
        }

        // Economic brake (#98/#68): a subclaim the Steward judged below
        // stewardEnqueueMinImportance is left a *deferred* embedded stub — NOT
        // recursively decomposed. Uncontested bedrock (settled math/definitions)
        // now scores low importance, so this stops the "one physics claim spawns a
        // whole textbook" cost explosion at its root. Crucially the gate must set
        // steward_state='deferred', because a claim created with the default
        // 'pending' is ALREADY in the importance-ordered drain queue regardless of
        // whether we enqueue a pipeline for it — the enqueue path only sets the
        // trigger/decompositionStatus. 'deferred' keeps it out of the drain; a
        // later re-trigger (enqueueSteward, e.g. a dependent's notification) flips
        // it back to 'pending', so nothing is permanently stranded.
        const { stewardEnqueueMinImportance, pipelineEpoch } = loadConfig();
        const effectiveImportance = importance ?? 0.5;
        const gated =
          stewardEnqueueMinImportance > 0 &&
          effectiveImportance < stewardEnqueueMinImportance;

        // The subclaim row, its edge, and its argument membership (#437) are
        // one transaction: a subclaim exists only as part of a decomposition,
        // so if the edge cannot be written (a bad relation type, a schema the
        // running code no longer matches, an outage) the claim row rolls back
        // with it rather than surviving as an orphan with no parent. Issue
        // #451 was exactly that: the edge insert failed silently mid-deploy
        // and five parentless subclaims were left behind. Failures propagate.
        const newClaim = await withTransaction(async (tx) => {
          const [created] = await tx.db
            .insert(claims)
            .values({
              text: childText,
              claimType: (claimType ?? "empirical_derived") as (typeof claimTypeEnum.options)[number],
              embedding: embedding ?? undefined,
              ...(importance !== undefined ? { importance } : {}),
              ...(contestation !== undefined ? { contestation } : {}),
              ...(seedCredence !== undefined ? { seedCredence } : {}),
              ...(seedNote !== undefined ? { seedNote } : {}),
              // Provenance for the mechanical "preliminary" label: which
              // claim's Steward wrote the seed. Stamped whenever any seed
              // field is given.
              ...(seedCredence !== undefined || seedNote !== undefined
                ? { seedSourceClaimId: parentId }
                : {}),
              ...(gated ? { stewardState: "deferred" } : {}),
              ...(domainsSource !== null ? { domains, domainsSource } : {}),
              kind: childKind,
              pipelineEpoch,
              createdBy: "claim_steward",
              // The subclaim is this pass's (src/labels.ts): a pass at one
              // label under a parent at another mints at its own.
              sensitivityLabel: currentLabel(),
            })
            .returning();
          if (childDefinition) {
            await tx.query(
              `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by, sensitivity_label)
               VALUES ($1, $2, $3, $4, $5, 'claim_steward', $6)`,
              [
                created!.id,
                childDefinition.measures,
                childDefinition.population ?? null,
                childDefinition.conditions ?? null,
                JSON.stringify(childDefinition.unit),
                currentLabel(),
              ]
            );
          }

          // The child is brand new, so the edge cannot collide.
          const edge = await insertRelationshipEdge(
            {
              parentId,
              childId: created!.id,
              relationType: relation,
              reasoning,
              confidence: 1.0,
              createdBy: "claim_steward",
            },
            tx
          );
          if (argumentId) {
            await attachEdgeToArgument(argumentId, edge.id, tx);
          }
          return created!;
        });

        // The new claim is created already embedded (above), so it is a valid,
        // dedup-able stub even if it is never processed. When NOT gated, we onboard
        // it so its own Steward structures + assesses it, like any other claim.
        // Steward work isn't tied to an ingestion job, so use a sentinel jobId (the
        // pipeline only threads jobId; it never looks it up). No ancestor/depth
        // threading: the child's Steward calls match_claim before creating
        // anything, so it links this parent (and any other ancestor) rather than
        // looping into it.
        if (!gated) {
          await enqueueClaimPipeline({
            claimId: newClaim.id,
            jobId: "steward",
          });
        }

        return JSON.stringify({
          success: true,
          message:
            `Added ${childKind === "claim" ? "subclaim" : `a ${childKind}`} to ${parentId}: "${childText}" (${relation})` +
            (seedCredence !== undefined
              ? `; seeded with prior credence ${seedCredence}` +
                (seedNote ? " and a preliminary note" : "")
              : seedNote
                ? `; seeded with a preliminary note`
                : "") +
            (gated
              ? `; kept as a deferred embedded stub (importance ` +
                `${effectiveImportance} below the decomposition threshold ` +
                `${stewardEnqueueMinImportance}); not recursively decomposed.`
              : "") +
            (domainsSource !== null
              ? `; domains [${domains.join(", ")}] (${domainsSource})`
              : "") +
            `; claim_type ${claimType ?? "empirical_derived"}` +
            (input.claim_type === undefined && claimType !== undefined ? " (inherited)" : ""),
          child_claim_id: newClaim.id,
        });
      }

      case "add_parent_claim": {
        const claimId = input.claim_id as string;
        const parentText = String(input.parent_text ?? "").trim();
        const relation = String(input.relation ?? "").toLowerCase();
        const reasoning = input.reasoning as string;
        if (!parentText) {
          return JSON.stringify({
            success: false,
            message: "parent_text is required: the canonical text of the new parent.",
          });
        }
        if (!(UPWARD_RELATION_TYPES as readonly string[]).includes(relation)) {
          return JSON.stringify({
            success: false,
            message: `Unknown relation "${relation}". Use one of: ${UPWARD_RELATION_TYPES.join(", ")}.`,
          });
        }
        if (input.claim_type !== undefined && !CLAIM_TYPE_VALUES.includes(String(input.claim_type))) {
          return JSON.stringify({
            success: false,
            message:
              `Unknown claim_type "${String(input.claim_type)}". Use one of: ` +
              `${CLAIM_TYPE_VALUES.join(", ")}, or omit it to inherit yours.`,
          });
        }

        // The new parent's kind (§2, §7a), and a quantity's definition,
        // checked before anything is written, as add_decomposition_edge does
        // for a child.
        const parentKind = (
          typeof input.kind === "string" && input.kind.trim() ? input.kind.trim().toLowerCase() : "claim"
        ) as NodeKind;
        if (!(NODE_KINDS as readonly string[]).includes(parentKind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown kind "${parentKind}". Use one of: ${NODE_KINDS.join(", ")}.`,
          });
        }
        let parentDefinition: ReturnType<typeof quantityDefinitionSchema.parse> | null = null;
        if (parentKind === "quantity") {
          const parsed = quantityDefinitionSchema.safeParse(input.definition);
          if (!parsed.success) {
            return JSON.stringify({
              success: false,
              message:
                "A new quantity needs its definition: " +
                parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`).join("; "),
            });
          }
          parentDefinition = parsed.data;
        }
        // A candidate answer carries why it is in the set, as add_answer records it.
        let basis: AnswerBasis | null = null;
        if (relation === "answers") {
          const raw = String(input.basis ?? "").toLowerCase();
          if (!(ANSWER_BASES as readonly string[]).includes(raw)) {
            return JSON.stringify({
              success: false,
              message:
                `relation answers needs basis: one of ${ANSWER_BASES.join(", ")} ` +
                `(why your node is in the question's answer set).`,
            });
          }
          basis = raw as AnswerBasis;
        }

        const db = getDb();
        // The child is the node this run stewards; it must be real, and its
        // type and domains are the defaults the parent inherits (the same
        // inheritance a subclaim gets from its parent, in the other direction).
        const [child] = await db
          .select({ id: claims.id, claimType: claims.claimType, domains: claims.domains, kind: claims.kind })
          .from(claims)
          .where(eq(claims.id, claimId))
          .limit(1);
        if (!child) {
          return JSON.stringify({
            success: false,
            message: `Claim not found: ${claimId}. Pass the id of the node you steward.`,
            ...(await writeIdCandidates(claimId)),
          });
        }
        const childKind = ((child.kind as NodeKind | undefined) ?? "claim") as NodeKind;
        const relationError = upwardRelationError(parentKind, childKind, relation);
        if (relationError) {
          return JSON.stringify({ success: false, message: relationError });
        }

        let domains: string[] = [];
        let domainsSource: "steward" | "inherited" | null = null;
        if (input.domains !== undefined) {
          const parsed = parseDomains(input.domains);
          if ("error" in parsed) {
            return JSON.stringify({ success: false, message: parsed.error });
          }
          domains = parsed.domains;
          domainsSource = "steward";
        } else {
          const inherited = parseDomains(child.domains ?? []);
          domains = "domains" in inherited ? inherited.domains : [];
          domainsSource = domains.length > 0 ? "inherited" : null;
        }
        const claimType =
          input.claim_type !== undefined ? String(input.claim_type) : child.claimType;

        const importance = clampUnit(input.importance);
        const contestation = clampUnit(input.contestation);

        let embedding: number[] | undefined;
        try {
          embedding = await generateEmbedding(parentText);
        } catch {
          // Continue without embedding
        }

        // The same economic brake as add_decomposition_edge: a parent judged
        // peripheral is created as a deferred embedded stub, matchable but not
        // stewarded until something re-triggers it.
        const { stewardEnqueueMinImportance, pipelineEpoch } = loadConfig();
        const effectiveImportance = importance ?? 0.5;
        const gated =
          stewardEnqueueMinImportance > 0 &&
          effectiveImportance < stewardEnqueueMinImportance;

        // The parent row, a quantity's definition, and the edge are one
        // transaction, as for a new subclaim (#451): a parent minted for an
        // edge that could not be written would be an orphan nobody asked for.
        const { parent, edgeId } = await withTransaction(async (tx) => {
          const [created] = await tx.db
            .insert(claims)
            .values({
              text: parentText,
              claimType: claimType as (typeof claimTypeEnum.options)[number],
              embedding: embedding ?? undefined,
              ...(importance !== undefined ? { importance } : {}),
              ...(contestation !== undefined ? { contestation } : {}),
              ...(gated ? { stewardState: "deferred" } : {}),
              ...(domainsSource !== null ? { domains, domainsSource } : {}),
              kind: parentKind,
              pipelineEpoch,
              createdBy: "claim_steward",
              sensitivityLabel: currentLabel(),
            })
            .returning();
          if (parentDefinition) {
            await tx.query(
              `INSERT INTO quantity_definitions (claim_id, measures, population, conditions, unit, created_by, sensitivity_label)
               VALUES ($1, $2, $3, $4, $5, 'claim_steward', $6)`,
              [
                created!.id,
                parentDefinition.measures,
                parentDefinition.population ?? null,
                parentDefinition.conditions ?? null,
                JSON.stringify(parentDefinition.unit),
                currentLabel(),
              ]
            );
          }

          // Brand-new parent, so the edge cannot collide. The child's Steward
          // wrote it; the parent's Steward, enqueued below, owns it from here.
          // Under a question, the edge is the one the question tools write:
          // an answer with its basis, a subquestion, or a presupposition.
          let edge: { id: string };
          if (relation === "answers") {
            edge = await addAnswer(
              { questionId: created!.id, answerId: claimId, basis: basis!, reasoning, createdBy: "claim_steward" },
              tx
            );
          } else if (relation === "part_of") {
            edge = await addSubquestion(
              { questionId: created!.id, subquestionId: claimId, reasoning, createdBy: "claim_steward" },
              tx
            );
          } else {
            edge = await insertRelationshipEdge(
              {
                parentId: created!.id,
                childId: claimId,
                relationType: relation,
                reasoning,
                confidence: 1.0,
                createdBy: "claim_steward",
              },
              tx
            );
          }
          return { parent: created!, edgeId: edge.id };
        });

        // Provenance in the audit trail: the graph's shape above this node
        // came from a Steward's judgment, not from a source, and the record
        // says which node's Steward and why.
        await db.insert(auditLog).values({
          claimId,
          sensitivityLabel: currentLabel(),
          action: "add_parent_claim",
          reasoning:
            `Minted parent ${parentKind} ${parent.id} ("${parentText}") and attached ` +
            `this node beneath it (${relation}): ${reasoning}`,
          createdBy: "claim_steward",
        });

        if (!gated) {
          await enqueueClaimPipeline({
            claimId: parent.id,
            jobId: "steward",
          });
        }

        return JSON.stringify({
          success: true,
          message:
            `Created parent ${parentKind} "${parentText}" and attached ${claimId} ` +
            `beneath it (${relation}${basis ? `, basis ${basis}` : ""})` +
            (gated
              ? `; kept as a deferred embedded stub (importance ` +
                `${effectiveImportance} below the decomposition threshold ` +
                `${stewardEnqueueMinImportance}); its Steward will not run until ` +
                `something re-triggers it.`
              : `; its own Steward will structure and assess it.`) +
            (domainsSource !== null
              ? ` Domains [${domains.join(", ")}] (${domainsSource}).`
              : ""),
          parent_claim_id: parent.id,
          parent_kind: parentKind,
          relationship_id: edgeId,
        });
      }

      case "propose_parent_edge": {
        const claimId = input.claim_id as string;
        const parentId = input.parent_id as string;
        const relation = String(input.relation ?? "").toLowerCase();
        const reasoning = String(input.reasoning ?? "");
        if (parentId === claimId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be its own parent.",
          });
        }
        if (!(UPWARD_RELATION_TYPES as readonly string[]).includes(relation)) {
          return JSON.stringify({
            success: false,
            message: `Unknown relation "${relation}". Use one of: ${UPWARD_RELATION_TYPES.join(", ")}.`,
          });
        }
        const db = getDb();
        const [parent] = await db
          .select({ id: claims.id, kind: claims.kind })
          .from(claims)
          .where(eq(claims.id, parentId))
          .limit(1);
        if (!parent) {
          return JSON.stringify({
            success: false,
            message:
              `Claim not found: ${parentId}. Propose edges only into real claims ` +
              `(ids from match_claim or get_claim); if the proposition ` +
              `does not exist, mint it with add_parent_claim.`,
            ...(await writeIdCandidates(parentId)),
          });
        }
        const parentKind = ((parent.kind as NodeKind | undefined) ?? "claim") as NodeKind;
        const [child] = await db
          .select({ kind: claims.kind })
          .from(claims)
          .where(eq(claims.id, claimId))
          .limit(1);
        const childKind = ((child?.kind as NodeKind | undefined) ?? "claim") as NodeKind;
        const relationError = upwardRelationError(parentKind, childKind, relation);
        if (relationError) {
          return JSON.stringify({ success: false, message: relationError });
        }
        // The tool the parent's Steward attaches it with: a question's own
        // tools for its answers, subquestions and presuppositions, the
        // ordinary edge tool otherwise.
        const attachWith =
          parentKind !== "question"
            ? "add_relationship_edge"
            : relation === "answers"
              ? `add_answer (answer_id ${claimId}, with the basis you judge)`
              : relation === "part_of"
                ? `add_subquestion (subquestion_id ${claimId})`
                : relation === "assumes"
                  ? `add_presupposition (claim_id ${claimId})`
                  : "add_relationship_edge";
        // The same handoff the Curator's suggest_edge_to_steward makes: the
        // parent's Steward is enqueued with the case and decides; nothing is
        // written across the boundary (Part VIII, "Working Together").
        await enqueueSteward({
          claimId: parentId,
          trigger: "edge_proposal",
          context:
            `The Steward of ${childKind} ${claimId} proposes ` +
            `that it be attached beneath your ${parentKind} (${relation}): ${reasoning}. ` +
            `If apt, attach it with ${attachWith}.`,
        });
        return JSON.stringify({
          success: true,
          message:
            `Proposed the edge ${parentId} -> ${claimId} (${relation}) to the ` +
            `Steward of ${parentId}; it decides whether to adopt it.`,
        });
      }

      case "log_stewardship_decision": {
        const claimId = input.claim_id as string;
        const actionTaken = input.action_taken as string;
        const reasoning = input.reasoning as string;

        // The durable audit trail the constitution promises (#100) — an
        // append-only row per decision, not just a bumped timestamp.
        const db = getDb();
        await db.insert(auditLog).values({
          claimId,
          sensitivityLabel: currentLabel(),
          action: actionTaken,
          reasoning,
          createdBy: "claim_steward",
        });
        // The node's own row is touched only by work at its own label; the
        // decision itself is the row above, at this run's label.
        // A mirrored node's row is the public graph's, at every label.
        if (!(await anotherLabelsNode(claimId)) && !(await mirroredNode(claimId))) {
          await db
            .update(claims)
            .set({ updatedAt: new Date() })
            .where(eq(claims.id, claimId));
        }

        return JSON.stringify({
          success: true,
          message: `Stewardship decision logged for claim ${claimId}: ${actionTaken}`,
          action: actionTaken,
          reasoning,
        });
      }

      case "notify_steward": {
        return executeNotifySteward(
          { role: "steward", claimId: String(input.claim_id ?? "") },
          input
        );
      }

      case "escalate_to_curator": {
        const claimId = String(input.claim_id ?? "");
        const concern = String(input.concern ?? "");
        const otherClaimId =
          typeof input.other_claim_id === "string" && input.other_claim_id.trim()
            ? input.other_claim_id.trim()
            : null;

        // A curation request on the ledger, not a message billed to this
        // run's funder (#363): it goes to the General mandate's officers,
        // and whether the Curator runs is theirs to decide.
        const escalatingCtx = getUsageContext();
        const requested = await requestCuration({
          anchorClaimId: claimId,
          otherClaimId,
          source: "steward_escalation",
          defect: input.defect as CurationDefect,
          concern,
          requestedByClaimId: escalatingCtx.claimId ?? null,
          requestedByRunId: escalatingCtx.runId ?? null,
        });
        if (!requested.ok) {
          return JSON.stringify({ success: false, message: requested.problem });
        }
        return JSON.stringify({
          success: true,
          message: requested.repeat
            ? `That concern about ${claimId} is already waiting for the Curator.`
            : `Recorded a structural concern about ${claimId} for the Curator; it runs ` +
              `when curation of this claim is funded.`,
        });
      }

      default: {
        const structure = await executeStewardStructureTool(toolName, input);
        if (structure !== null) return structure;
        const argumentInstance = await executeArgumentInstanceTool(toolName, input, {
          recordedBy: run.recordedBy,
        });
        return argumentInstance ?? `Error: Unknown steward tool: ${toolName}`;
      }
    }
  } catch (err) {
    // A malformed uuid reaches the database as a syntax error (22P02).
    // Nothing was written; say which id is malformed and offer the ids the
    // run has seen nearest it, rather than the bare database message.
    if ((err as { code?: string } | null)?.code === "22P02") return malformedIdRefusal(input);
    // The database's refusal of a write across labels is told whole, with
    // its reason: a limit the agent works under, not a fault of the tool.
    const refusal = mirroredRefusalForAgent(err) ?? refusalForCaller(err);
    if (refusal) return JSON.stringify({ success: false, message: refusal });
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
