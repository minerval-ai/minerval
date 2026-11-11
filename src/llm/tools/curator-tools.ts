/**
 * Action tools for the Curator — the graph-level agent that owns the connective
 * tissue between claims (constitution Part VIII; merges and splits per §5).
 *
 * Two kinds of action:
 *  - **Re-individuation surgery** (merge/split): the Curator mutates nodes, edges,
 *    and instances directly via the reconciliation service. That IS the operation.
 *    Every surgery ends by handing the affected claims to their Stewards.
 *  - **Steady-state suggestions**: a routine decomposition edge into a claim is
 *    owned by that claim's Steward, so the Curator never writes it directly — it
 *    enqueues the parent's Steward to adopt it.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { ZodError } from "zod";
import {
  mergeArguments,
  splitArgument,
  mergeClaims,
  setQuantityDefinition,
  reclassifyClaim,
  listReconciliationEvents,
  reverseReconciliation,
  RECONCILIATION_EVENTS_LIMIT,
  createClaim,
  addRelationshipEdge,
  removeRelationshipEdge,
  reassignInstance,
  linkClaims,
  unlinkClaims,
} from "../../services/reconciliation-service.js";
import { isClaimLinkKind } from "../../services/claim-link-service.js";
import { UnknownRelationError } from "../../services/relationship-service.js";
import { enqueueSteward } from "../../services/queue-service.js";
import {
  executeNotifySteward,
  getNotifyStewardToolDefinition,
} from "./notify-steward.js";
import {
  RELATION_TYPES,
  RELATION_GUIDANCE,
  CLAIM_LINK_KINDS,
  CLAIM_LINK_GUIDANCE,
} from "../../schemas/common.js";

import { claimTypeEnum } from "../../schemas/common.js";
import { NODE_KINDS, type QuantityDefinitionInput } from "../../schemas/kinds.js";
import { knownDomains } from "../prompts/skills.js";
import { DEFINITION_PROPERTIES, ESTIMATE_SCHEMA } from "./kind-tools.js";

const RELATION_ENUM = RELATION_TYPES;
const CLAIM_TYPES = claimTypeEnum.options;

/** A quantity definition from a tool call's flat properties (as kind-tools reads them). */
function definitionFrom(input: Record<string, unknown>): QuantityDefinitionInput {
  const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    measures: typeof input.measures === "string" ? input.measures.trim() : "",
    population: opt(input.population),
    conditions: opt(input.conditions),
    unit: input.unit as QuantityDefinitionInput["unit"],
  };
}

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`).join("; ");
}

export function getCuratorToolDefinitions(): Tool[] {
  return [
    {
      name: "merge_claims",
      description:
        "Merge two claims that are one node into one (a duplicate the Matcher " +
        "missed, or a claim and its plain denial, §2). Moves the loser's instances, " +
        "arguments, and edges onto the survivor and marks the loser a merged alias. " +
        "Set stance_relation='opposed' when the loser is the survivor's negation; " +
        "moved instance/argument stances are then flipped. A contrary (both could " +
        "be false) is a distinct claim: link it as a rival_explanation, never " +
        "merge it. After " +
        "merging, notify the survivor's Steward to reconcile wording/arguments and " +
        "re-assess. Returns the event_id that reverse_reconciliation takes. Nodes " +
        "merge within a kind; across kinds, only a claim that " +
        "states a value into its quantity, or a question into the claim or " +
        "quantity it asks about (stance_relation 'same'), and their instances " +
        "take the survivor's stances. A quantity's readings and cuts, a " +
        "question's answer relations, and the requests on the loser move too.",
      input_schema: {
        type: "object" as const,
        properties: {
          survivor_id: { type: "string", description: "The claim that remains" },
          loser_id: { type: "string", description: "The claim merged into the survivor" },
          stance_relation: {
            type: "string",
            enum: ["same", "opposed"],
            description:
              "'same' if both state the proposition the same way; 'opposed' only if " +
              "the loser is the survivor's negation, its plain denial (flips moved " +
              "stances). Never for a contrary.",
          },
          reasoning: { type: "string", description: "Why these are one claim" },
        },
        required: ["survivor_id", "loser_id", "stance_relation", "reasoning"],
      },
    },
    {
      name: "merge_arguments",
      description:
        "Merge two arguments on the same node that are one argument: they reach the same " +
        "conclusion through the same inference, so that whatever would break one would break the " +
        "other, however they are worded (§7). Arguments on different nodes, or on opposite sides of " +
        "one, are different arguments. The absorbed argument's instances and premise groupings move " +
        "to the survivor, and it stays as an alias with its evaluations as history. written_form_from " +
        "says whose written form the survivor keeps: whichever states the inference better, not " +
        "whichever came first. Read both with get_argument first. After merging, notify the node's " +
        "Steward to check the written form and evaluation. Returns the event_id that " +
        "reverse_reconciliation takes.",
      input_schema: {
        type: "object" as const,
        properties: {
          survivor_id: { type: "string", description: "The argument that remains" },
          absorbed_id: { type: "string", description: "The argument merged into it" },
          written_form_from: {
            type: "string",
            enum: ["survivor", "absorbed"],
            description: "Whose written form the survivor keeps: the one that states the inference better",
          },
          reasoning: { type: "string", description: "Why these are one argument" },
        },
        required: ["survivor_id", "absorbed_id", "written_form_from", "reasoning"],
      },
    },
    {
      name: "split_argument",
      description:
        "Split an argument that conflates several lines of reasoning, each of which could succeed or " +
        "fail without the others (§7). Each part becomes a new argument on the same node with the " +
        "same stance, taking the premise edges (edge ids, from get_claim's subclaims) and instances " +
        "(from get_argument) named for it; the original keeps the rest and its current evaluation " +
        "stops being current. Give each part a name by its reasoning and a written form referencing " +
        "its premises inline as [[claim:<id>]]. After splitting, notify the node's Steward to rewrite " +
        "and evaluate what results. Returns the event_id that reverse_reconciliation takes; the undo " +
        "retires the parts rather than deleting them.",
      input_schema: {
        type: "object" as const,
        properties: {
          argument_id: { type: "string", description: "The argument to split" },
          parts: {
            type: "array",
            description: "The lines of reasoning to split off; the original keeps whatever no part names",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                written_form: { type: "string" },
                edge_ids: { type: "array", items: { type: "string" } },
                instance_ids: { type: "array", items: { type: "string" } },
              },
              required: ["name", "written_form"],
            },
          },
          reasoning: { type: "string", description: "Why these are separate arguments" },
        },
        required: ["argument_id", "parts", "reasoning"],
      },
    },
    {
      name: "create_claim",
      description:
        "Create a new node (embedded immediately) when splitting a conflated one: " +
        "a claim, a quantity (with its definition), or a question. Call " +
        "match_claim first, every time: a split-off part often already exists " +
        "under another wording or as a negation. Returns the claim_id and the " +
        "event_id that reverse_reconciliation takes.",
      input_schema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Canonical text of the new node" },
          kind: {
            type: "string",
            enum: [...NODE_KINDS],
            description: "The node's kind (default claim).",
          },
          claim_type: {
            type: "string",
            enum: [...CLAIM_TYPES],
            description: "The proposition's type (optional; defaults to empirical_derived)",
          },
          definition: {
            type: "object",
            description: "Required for a quantity: what its value is a value of (§3).",
            properties: DEFINITION_PROPERTIES,
            required: ["measures", "unit"],
          },
        },
        required: ["text"],
      },
    },
    {
      name: "add_relationship_edge",
      description:
        "Add an edge between two existing claims as part of a merge/split surgery. " +
        "For steady-state suggestions into a claim you are not reconciling, use " +
        "suggest_edge_to_steward instead: routine edges are the parent Steward's.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "Parent claim UUID" },
          child_id: { type: "string", description: "Child (subclaim) UUID" },
          relation: { type: "string", enum: [...RELATION_ENUM], description: RELATION_GUIDANCE },
          reasoning: { type: "string", description: "Why this edge holds" },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    {
      name: "remove_relationship_edge",
      description:
        "Remove an edge between two claims (one relation type, or all). Used when " +
        "redistributing edges during a split.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "Parent claim UUID" },
          child_id: { type: "string", description: "Child claim UUID" },
          relation: {
            type: "string",
            enum: [...RELATION_ENUM],
            description: "Specific relation type to remove (omit to remove all)",
          },
        },
        required: ["parent_id", "child_id"],
      },
    },
    {
      name: "reassign_instance",
      description:
        "Put a source's passage on the node it is about (a claim, a quantity or a " +
        "question): the one operation for redistributing instances in a split (§4, §5). " +
        "By default the instance moves. With copy, it stays where it is and a second " +
        "instance of the same passage (same source, text, context, speaker, date) is " +
        "recorded on the target: for a passage that states several nodes' content, " +
        "such as one sentence giving four figures, copied to each node with what it " +
        "says about that node. A copy starts unread: the readings and provenance " +
        "recorded on the original stay with it. The stance is read into the target's " +
        "kind (a claim's instance on a question asks it). A claim target takes " +
        "stance_relation; a quantity target needs stated; a question target may take " +
        "answer_claim_id. A move drops the instance's argument, answer and page " +
        "position, which belonged to the old node. A copy onto a claim that already " +
        "has an instance from the same source and speaker is refused, naming it; a " +
        "quantity holds each figure a source gives. Logged with your reasoning and " +
        "reversible: returns the event_id that reverse_reconciliation takes, which " +
        "puts a moved instance back as it was and detaches a copy.",
      input_schema: {
        type: "object" as const,
        properties: {
          instance_id: { type: "string", description: "The instance UUID to move or copy" },
          to_claim_id: { type: "string", description: "The node (claim, quantity or question) it belongs on" },
          copy: {
            type: "boolean",
            description:
              "true to leave the instance where it is and record the same passage on the target as well. Default false (move).",
          },
          stance_relation: {
            type: "string",
            enum: ["same", "opposed"],
            description:
              "For a claim target. 'opposed' when the target is worded as the denial of " +
              "what the instance was recorded against, so the source that affirmed the " +
              "one denies the other: affirms and denies flip, poses and mentions stay. " +
              "Default 'same'. Refused on a quantity or a question.",
          },
          stated: {
            ...ESTIMATE_SCHEMA,
            description:
              "Required for a quantity target: the figure this passage states for that " +
              "quantity, as the source gives it, never your own estimate. Its Steward can " +
              "correct it with record_estimate. " +
              ESTIMATE_SCHEMA.description,
          },
          answer_claim_id: {
            type: "string",
            description:
              "For a question target, optional: the node in its answer set that this passage gives as its answer.",
          },
          reasoning: { type: "string", description: "Why the passage belongs on that node, and what it says about it" },
        },
        required: ["instance_id", "to_claim_id", "reasoning"],
      },
    },
    {
      name: "link_claims",
      description:
        "Record a lateral link between two claims that are neither premise nor " +
        "conclusion of each other (§19): rival explanations, two halves of one " +
        "position, or two formulations kept apart because their identity was " +
        "unclear (§5). Symmetric and non-evaluative: it renders as a see-also on " +
        "both claim pages and never enters propagation or assessment. Connective " +
        "tissue between claims is yours, so this is a direct write, logged and " +
        "reversible. Do NOT use it for a dependency; that is the Steward's edge " +
        "(suggest_edge_to_steward).",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "One claim's UUID" },
          other_claim_id: { type: "string", description: "The other claim's UUID" },
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
      name: "unlink_claims",
      description:
        "Remove a lateral link recorded with link_claims (all kinds between the " +
        "pair unless one is given). Logged and reversible.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "One claim's UUID" },
          other_claim_id: { type: "string", description: "The other claim's UUID" },
          kind: {
            type: "string",
            enum: [...CLAIM_LINK_KINDS],
            description: "Only this kind of link; omit to remove every link between the pair",
          },
          reasoning: { type: "string", description: "Why the link does not hold" },
        },
        required: ["claim_id", "other_claim_id", "reasoning"],
      },
    },
    {
      name: "complete_quantity_definition",
      description:
        "Complete or correct the definition of an existing quantity whose " +
        "definition leaves its value open (Part VIII), where one completion is " +
        "plainly what the discourse means: what its value is a value of, for " +
        "what population, under what conditions, in what unit. Where several " +
        "completions are in use, split instead (create_claim a quantity for each). " +
        "The quantity's Steward is asked to re-estimate. Logged; reversible with " +
        "reverse_reconciliation (the result carries the event_id).",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The quantity" },
          ...DEFINITION_PROPERTIES,
          reasoning: { type: "string", description: "Why this completion is the one meant" },
        },
        required: ["claim_id", "measures", "unit", "reasoning"],
      },
    },
    {
      name: "reclassify_claim",
      description:
        "Correct a node's proposition type (claim_type) or its domain tags " +
        "(domains), which point every administrator's run on it to the domain " +
        "skills that cover its subject. Use it when a node is mistyped, such as " +
        "a published theorem typed empirical_derived. Give either or both; " +
        "domains replaces the whole list (an empty list for a node no domain " +
        "skill covers). The node's Steward is told. Logged; reversible with " +
        "reverse_reconciliation (the result carries the event_id).",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string" },
          claim_type: { type: "string", enum: [...CLAIM_TYPES] },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Domain tags, from the domains that have a skill (see the Skills section).",
          },
          reasoning: { type: "string", description: "Why the type or tags were wrong" },
        },
        required: ["claim_id", "reasoning"],
      },
    },
    {
      name: "list_reconciliation_events",
      description:
        "The logged structural operations (merges, kind changes, created nodes, " +
        "edge and instance moves, links, definitions, reclassifications) that " +
        `touched a node, newest first, at most ${RECONCILIATION_EVENTS_LIMIT}: ` +
        "each with its event_id, the nodes it touched, its reasoning, and " +
        "whether it was reversed. Use it to find a wrong operation to reverse.",
      input_schema: {
        type: "object" as const,
        properties: { claim_id: { type: "string" } },
        required: ["claim_id"],
      },
    },
    {
      name: "reverse_reconciliation",
      description:
        "Undo a logged operation (§5: structure is always recoverable): a merge " +
        "un-merges the loser and moves back what moved, a kind change restores " +
        "the old kind and its records, a created node is deprecated, an edge, " +
        "instance, link, definition or classification goes back as it was. " +
        "Refused while a later, unreversed operation touched the same nodes: " +
        "reverse those first, newest first. The reversal is logged with your " +
        "reasoning. Afterwards notify the Stewards of the nodes involved.",
      input_schema: {
        type: "object" as const,
        properties: {
          event_id: { type: "string", description: "From a surgery tool's result or list_reconciliation_events" },
          reasoning: { type: "string", description: "Why the operation was wrong" },
        },
        required: ["event_id", "reasoning"],
      },
    },
    {
      name: "suggest_edge_to_steward",
      description:
        "Propose a structural edge into a claim you are NOT reconciling: routine " +
        "decomposition edges are owned by the parent claim's Steward. This enqueues " +
        "the parent's Steward to consider adopting the edge; it does not write it.",
      input_schema: {
        type: "object" as const,
        properties: {
          parent_id: { type: "string", description: "The claim that would gain the subclaim" },
          child_id: { type: "string", description: "The existing claim to suggest as a subclaim" },
          relation: { type: "string", enum: [...RELATION_ENUM], description: `Suggested relationship type. ${RELATION_GUIDANCE}` },
          reasoning: { type: "string", description: "Why this dependency likely holds" },
        },
        required: ["parent_id", "child_id", "relation", "reasoning"],
      },
    },
    getNotifyStewardToolDefinition("curator"),
  ];
}

export async function executeCuratorTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  try {
    switch (toolName) {
      case "merge_claims": {
        // Strict on purpose (#182): 'opposed' flips every moved stance, so a
        // hedged or misspelled value silently coerced to 'same' would corrupt
        // all of them. Reject and make the model restate its intent exactly.
        const stanceRelation = input.stance_relation;
        if (stanceRelation !== "same" && stanceRelation !== "opposed") {
          return JSON.stringify({
            success: false,
            message:
              `Invalid stance_relation ${JSON.stringify(stanceRelation)}: must be ` +
              `exactly "same" or "opposed". Nothing was merged; re-call with a ` +
              `legal value.`,
          });
        }
        const result = await mergeClaims({
          survivorId: String(input.survivor_id),
          loserId: String(input.loser_id),
          stanceRelation,
          reasoning: String(input.reasoning ?? ""),
        });
        return JSON.stringify({
          success: true,
          message: `Merged ${result.loserId} into ${result.survivorId}. Now notify the survivor's Steward to reconcile and re-assess.`,
          survivor_id: result.survivorId,
          event_id: result.eventId,
        });
      }

      case "merge_arguments": {
        const from = input.written_form_from;
        if (from !== "survivor" && from !== "absorbed") {
          return JSON.stringify({
            success: false,
            message: `written_form_from must be "survivor" or "absorbed". Nothing was merged.`,
          });
        }
        const reasoning = String(input.reasoning ?? "").trim();
        if (!reasoning) return JSON.stringify({ success: false, message: "reasoning is required. Nothing was merged." });
        const result = await mergeArguments({
          survivorId: String(input.survivor_id ?? ""),
          absorbedId: String(input.absorbed_id ?? ""),
          writtenFormFrom: from,
          reasoning,
        });
        return JSON.stringify({
          success: true,
          message:
            `Merged argument ${String(input.absorbed_id)} into ${String(input.survivor_id)}: ` +
            `${result.movedInstances} instance(s) and ${result.movedPremises} premise grouping(s) moved. ` +
            `Now notify the Steward of node ${result.claimId} to check the written form and evaluation.`,
          claim_id: result.claimId,
          event_id: result.eventId,
        });
      }

      case "split_argument": {
        const reasoning = String(input.reasoning ?? "").trim();
        if (!reasoning) return JSON.stringify({ success: false, message: "reasoning is required. Nothing was split." });
        const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
        const parts = (Array.isArray(input.parts) ? input.parts : []).map((raw) => {
          const part = (raw ?? {}) as Record<string, unknown>;
          return {
            name: String(part.name ?? ""),
            writtenForm: String(part.written_form ?? ""),
            relationshipIds: strings(part.edge_ids),
            instanceIds: strings(part.instance_ids),
          };
        });
        const result = await splitArgument({ argumentId: String(input.argument_id ?? ""), parts, reasoning });
        return JSON.stringify({
          success: true,
          message:
            `Split ${parts.length} part(s) off argument ${String(input.argument_id)}: ${result.partIds.join(", ")}. ` +
            `Its evaluation is no longer current. Now notify the Steward of node ${result.claimId} to ` +
            `rewrite and evaluate what results.`,
          claim_id: result.claimId,
          argument_ids: result.partIds,
          event_id: result.eventId,
        });
      }

      case "create_claim": {
        const kind = input.kind === undefined ? "claim" : String(input.kind);
        if (!(NODE_KINDS as readonly string[]).includes(kind)) {
          return JSON.stringify({ success: false, message: `Unknown kind "${kind}". Use one of: ${NODE_KINDS.join(", ")}.` });
        }
        const claimType = input.claim_type ? String(input.claim_type) : undefined;
        if (claimType !== undefined && !(CLAIM_TYPES as readonly string[]).includes(claimType)) {
          return JSON.stringify({ success: false, message: `Unknown claim_type "${claimType}". Use one of: ${CLAIM_TYPES.join(", ")}.` });
        }
        const rawDefinition = input.definition as Record<string, unknown> | undefined;
        if (kind === "quantity" && !rawDefinition) {
          return JSON.stringify({ success: false, message: "A quantity needs its definition (measures and unit at least). Nothing was created." });
        }
        try {
          const { id, eventId } = await createClaim({
            text: String(input.text),
            claimType,
            kind: kind as "claim" | "quantity" | "question",
            definition: kind === "quantity" && rawDefinition ? definitionFrom(rawDefinition) : null,
          });
          return JSON.stringify({ success: true, claim_id: id, kind, event_id: eventId });
        } catch (err) {
          if (err instanceof ZodError) {
            return JSON.stringify({ success: false, message: `Nothing was created: ${zodMessage(err)}.` });
          }
          throw err;
        }
      }

      case "complete_quantity_definition": {
        const claimId = String(input.claim_id ?? "");
        const reasoning = String(input.reasoning ?? "");
        let eventId: string | undefined;
        try {
          ({ eventId } = await setQuantityDefinition({ claimId, definition: definitionFrom(input), reasoning }));
        } catch (err) {
          if (err instanceof ZodError) {
            return JSON.stringify({ success: false, message: `Not recorded: ${zodMessage(err)}.` });
          }
          throw err;
        }
        await enqueueSteward({
          claimId,
          trigger: "curator_change",
          context: `The Curator completed this quantity's definition; re-estimate it against the definition as it now stands: ${reasoning}`,
        });
        return JSON.stringify({
          success: true,
          message: `Definition of ${claimId} recorded; its Steward is asked to re-estimate.`,
          event_id: eventId,
        });
      }

      case "reclassify_claim": {
        const claimId = String(input.claim_id ?? "");
        const claimType = input.claim_type === undefined ? undefined : String(input.claim_type);
        if (claimType !== undefined && !(CLAIM_TYPES as readonly string[]).includes(claimType)) {
          return JSON.stringify({ success: false, message: `Unknown claim_type "${claimType}". Use one of: ${CLAIM_TYPES.join(", ")}.` });
        }
        let domains: string[] | undefined;
        if (input.domains !== undefined) {
          if (!Array.isArray(input.domains)) {
            return JSON.stringify({ success: false, message: "domains must be an array of domain names." });
          }
          const known = knownDomains();
          domains = [...new Set(input.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))].sort();
          const unknown = domains.filter((d) => !known.includes(d));
          if (unknown.length > 0) {
            return JSON.stringify({
              success: false,
              message: `Unknown domain(s): ${unknown.join(", ")}. The domains that exist are: ${known.join(", ") || "(none)"}.`,
            });
          }
        }
        if (claimType === undefined && domains === undefined) {
          return JSON.stringify({ success: false, message: "Give claim_type, domains, or both." });
        }
        const reasoning = String(input.reasoning ?? "");
        const { changed, eventId } = await reclassifyClaim({ claimId, claimType, domains, reasoning });
        if (!changed) {
          return JSON.stringify({ success: true, changed: false, message: "The node already carries that type and those tags." });
        }
        await enqueueSteward({
          claimId,
          trigger: "curator_change",
          context:
            `The Curator reclassified this node` +
            `${claimType !== undefined ? `: claim_type ${claimType}` : ""}` +
            `${domains !== undefined ? `; domains [${domains.join(", ")}]` : ""}. ${reasoning}`,
        });
        return JSON.stringify({ success: true, changed: true, event_id: eventId });
      }

      case "list_reconciliation_events": {
        const claimId = String(input.claim_id ?? "");
        return JSON.stringify({ success: true, events: await listReconciliationEvents(claimId) });
      }

      case "reverse_reconciliation": {
        const eventId = String(input.event_id ?? "").trim();
        const reasoning = String(input.reasoning ?? "").trim();
        if (!reasoning) {
          return JSON.stringify({ success: false, message: "Say why the operation was wrong (reasoning). Nothing was reversed." });
        }
        const result = await reverseReconciliation(eventId, { reasoning });
        if (!result.reversed) {
          return JSON.stringify({
            success: false,
            message: `Not reversed: ${result.reason}.`,
            ...(result.blockedBy ? { reverse_first: result.blockedBy } : {}),
          });
        }
        return JSON.stringify({
          success: true,
          message: `Reversed ${eventId}. Notify the Stewards of the nodes it touched.`,
        });
      }

      case "add_relationship_edge": {
        let result: Awaited<ReturnType<typeof addRelationshipEdge>>;
        try {
          result = await addRelationshipEdge({
            parentId: String(input.parent_id),
            childId: String(input.child_id),
            relationType: String(input.relation ?? ""),
            reasoning: String(input.reasoning ?? ""),
          });
        } catch (err) {
          // The service checks the relation for every caller (#658).
          if (err instanceof UnknownRelationError) {
            return JSON.stringify({ success: false, message: err.message });
          }
          throw err;
        }
        const { added, eventId } = result;
        return JSON.stringify({
          success: true,
          added,
          message: added ? "Edge added." : "Edge already existed or was a self-edge.",
          ...(eventId ? { event_id: eventId } : {}),
        });
      }

      case "remove_relationship_edge": {
        const { removed, eventId } = await removeRelationshipEdge({
          parentId: String(input.parent_id),
          childId: String(input.child_id),
          relationType: input.relation ? String(input.relation) : undefined,
        });
        return JSON.stringify({ success: true, removed, ...(eventId ? { event_id: eventId } : {}) });
      }

      case "reassign_instance": {
        const reasoning = String(input.reasoning ?? "").trim();
        if (!reasoning) {
          return JSON.stringify({
            success: false,
            reassigned: false,
            message: "Say why the passage belongs on that node (reasoning). Nothing was changed.",
          });
        }
        const relation = input.stance_relation === undefined ? "same" : String(input.stance_relation);
        if (relation !== "same" && relation !== "opposed") {
          return JSON.stringify({
            success: false,
            reassigned: false,
            message: `stance_relation must be "same" or "opposed"; got "${relation}". Nothing was changed.`,
          });
        }
        const answerClaimId =
          typeof input.answer_claim_id === "string" && input.answer_claim_id.trim()
            ? input.answer_claim_id.trim()
            : null;
        const result = await reassignInstance({
          instanceId: String(input.instance_id),
          toClaimId: String(input.to_claim_id),
          copy: input.copy === true,
          reasoning,
          stanceRelation: relation,
          stated: input.stated,
          answerClaimId,
        });
        if (!result.reassigned) {
          return JSON.stringify({
            success: false,
            reassigned: false,
            message: `Nothing was changed: ${result.reason ?? "the instance could not be reassigned"}.`,
          });
        }
        return JSON.stringify({
          success: true,
          reassigned: true,
          mode: result.mode,
          instance_id: result.instanceId,
          stance: result.stance,
          message:
            result.mode === "copy"
              ? `Copied the passage onto ${String(input.to_claim_id)} as instance ${result.instanceId} (stance: ${result.stance}); the original stays where it was. The copy has no reading yet.`
              : `Moved the instance to ${String(input.to_claim_id)} (stance: ${result.stance}).`,
          ...(result.eventId ? { event_id: result.eventId } : {}),
        });
      }

      case "link_claims": {
        const kind = String(input.kind ?? "").toLowerCase();
        if (!isClaimLinkKind(kind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown link kind "${kind}". Use one of: ${CLAIM_LINK_KINDS.join(", ")}.`,
          });
        }
        const claimId = String(input.claim_id);
        const otherClaimId = String(input.other_claim_id);
        if (claimId === otherClaimId) {
          return JSON.stringify({
            success: false,
            message: "A claim cannot be linked to itself.",
          });
        }
        const { linked, linkId } = await linkClaims({
          claimId,
          otherClaimId,
          kind,
          reasoning: String(input.reasoning ?? ""),
          createdBy: "curator",
        });
        return JSON.stringify({
          success: true,
          linked,
          link_id: linkId,
          message: linked
            ? `Linked ${claimId} <-> ${otherClaimId} (${kind}).`
            : `A ${kind} link between these claims already existed; nothing was written.`,
        });
      }

      case "unlink_claims": {
        const kind =
          input.kind === undefined ? undefined : String(input.kind).toLowerCase();
        if (kind !== undefined && !isClaimLinkKind(kind)) {
          return JSON.stringify({
            success: false,
            message: `Unknown link kind "${kind}". Use one of: ${CLAIM_LINK_KINDS.join(", ")}.`,
          });
        }
        const { removed } = await unlinkClaims({
          claimId: String(input.claim_id),
          otherClaimId: String(input.other_claim_id),
          kind,
          reasoning: String(input.reasoning ?? ""),
        });
        return JSON.stringify({ success: true, removed });
      }

      case "suggest_edge_to_steward": {
        const parentId = String(input.parent_id);
        await enqueueSteward({
          claimId: parentId,
          trigger: "curator_change",
          context:
            `The Curator suggests adding claim ${String(input.child_id)} as a ` +
            `subclaim (${String(input.relation)}): ${String(input.reasoning ?? "")}. ` +
            `If apt, attach it with add_relationship_edge.`,
        });
        return JSON.stringify({
          success: true,
          message: `Suggested edge to the Steward of ${parentId}.`,
        });
      }

      case "notify_steward":
        return executeNotifySteward({ role: "curator" }, input);

      default:
        return `Error: Unknown curator tool: ${toolName}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
