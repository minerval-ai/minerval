/**
 * The tools of a safety case's Steward (constitution §7b, #1211): keep the
 * specification clear, write and revise the structure, record where each
 * defeater stands, and judge the case. Each acts on the run's own node and
 * takes no node id for the case, so a Steward cannot write to another
 * node's case (Part VIII, "Working Together").
 *
 * safety-case-service.ts holds the invariants and case-form.ts the check of
 * form; these tools turn a model's call into a service call and a refusal
 * into a message it can act on. Every tool that writes the structure
 * answers with where the case's form now fails, so the Steward is told as
 * it goes and nothing is refused for it. `executeCaseTool` returns null for
 * a name it does not own.
 *
 * No tool here counts or caps anything: how large a case grows is bounded
 * by the run's budget, which the run is told (docs/allocation.md).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import { refusalForCaller } from "../../db/clearance.js";
import { mergedAliasRefusal } from "../../services/claim-alias-service.js";
import { rawQuery } from "../../db/client.js";
import { mirroredRefusalForAgent } from "../../services/mirrored-node-service.js";
import { KindError } from "../../services/node-kind.js";
import {
  getCaseDetail,
  recordCaseAssessment,
  removeCaseElement,
  restateCaseSpec,
  setDefeaterStanding,
  writeCaseElement,
} from "../../services/safety-case-service.js";
import {
  ARTIFACT_FIDELITIES,
  CASE_BLOCKS,
  CASE_ELEMENT_TYPES,
  CASE_VERDICTS,
  DEFEATER_STANDINGS,
  type ArtifactFidelity,
  type CaseBlock,
  type CaseElementType,
  type CaseVerdict,
  type DefeaterStanding,
} from "../../schemas/kinds.js";
import { getUsageContext } from "../usage-context.js";
import { MARGINAL_YIELD_DESCRIPTION } from "./judgment-fields.js";

type Tool = Anthropic.Tool;

export const CASE_ASSESSMENT_TOOL = "update_case_assessment";

export function getCaseToolDefinitions(): Tool[] {
  return [
    {
      name: "restate_case_spec",
      description:
        "Restate this case's specification in clearer words, for the same system, deployment and standard (§7b). " +
        "The specification is the case's identity. The conclusion and the framework are not restated here: a case " +
        "for another conclusion is another case; say so with escalate_to_curator.",
      input_schema: {
        type: "object",
        properties: {
          system: { type: "string", description: "The system, named specifically enough that a later model is plainly another case." },
          deployment: { type: "string", description: "The deployment, likewise: who uses it, for what, under which controls." },
          standard: { type: "string", description: "The standard the conclusion has to meet." },
          standard_of: { type: "string", description: "Whose standard it is, and where it is written." },
          not_covered: { type: "string", description: "What the case does not cover. Omit when it names nothing." },
          reasoning: { type: "string", description: "Why the new words state the same case better." },
        },
        required: ["system", "deployment", "standard", "standard_of", "reasoning"],
      },
    },
    {
      name: "write_case_element",
      description:
        "Add an element to this case's structure, or revise one (give element_id). A step argues for the claim it " +
        "hangs under and is one of the framework's building blocks; a side claim hangs under its step and says why " +
        "the step is legitimate; a claim hangs under the step it is a premise of, or under the defeater its subcase " +
        "answers; evidence hangs under an evidence incorporation step; a defeater hangs under what it doubts and " +
        "starts open. Every element but a step presents a node the graph holds: find or propose it with match_claim " +
        "first. The answer lists where the case's form now fails; nothing is refused for a failure of form.",
      input_schema: {
        type: "object",
        properties: {
          element_id: { type: "string", description: "The element to revise. Omit to add one." },
          type: { type: "string", enum: [...CASE_ELEMENT_TYPES] },
          parent_id: { type: "string", description: "The element this one hangs under. Required when adding; an element keeps its place when revised." },
          node_id: { type: "string", description: "The claim (or quantity) the element presents. Required for every element but a step." },
          block: { type: "string", enum: [...CASE_BLOCKS], description: "A step's building block: the case's own reading of the inference." },
          argument_id: { type: "string", description: "A step: the argument (§7) it is the case's reading of, where the graph holds one." },
          statement: {
            type: "string",
            description:
              "A step: the inference in words. Any other element: what the case needs of the node, in a sentence shown beside the graph's own judgment of it.",
          },
          departure: { type: "string", description: "Where this element departs from the framework and why the subject needs it. Shown on the page and in any export." },
          raised_in_published: {
            type: "boolean",
            description: "Whether the developer's own published case raises this element. Omit where no published case is being read in.",
          },
        },
        required: ["type", "statement"],
      },
    },
    {
      name: "remove_case_element",
      description:
        "Take an element out of this case's structure, with everything that hangs under it. The top claim, the case's conclusion, stays.",
      input_schema: {
        type: "object",
        properties: { element_id: { type: "string" }, reason: { type: "string" } },
        required: ["element_id", "reason"],
      },
    },
    {
      name: "set_defeater_standing",
      description:
        "Record where a defeater stands in this case: open (not yet settled), answered (a subcase under it answers it: " +
        "add that subcase first), or sustained (the doubt stands). A sustained defeater the case proceeds past is a " +
        "residual doubt: record who accepted it and why, only where that party has said so. The standing is your " +
        "judgment with the claim's assessment in front of you, and the assessment is not the standing: a doubt the " +
        "graph finds inconclusive is still open against a case that carries the burden.",
      input_schema: {
        type: "object",
        properties: {
          element_id: { type: "string" },
          standing: { type: "string", enum: [...DEFEATER_STANDINGS] },
          reason: { type: "string", description: "Why it stands so, in a sentence or two a reader can check." },
          accepted_by: { type: "string", description: "For a residual doubt: the party that accepted it." },
          acceptance: { type: "string", description: "For a residual doubt: why it was accepted, and where that party said so." },
        },
        required: ["element_id", "standing", "reason"],
      },
    },
    {
      name: "check_case_form",
      description:
        "Read this case's structure as it stands: every element with its id, where the form fails under the case's " +
        "framework, and what counts against the case under its own burden. It checks form and judges nothing.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: CASE_ASSESSMENT_TOOL,
      description:
        "Record this case's judgment, in two parts (§7b). fidelity says how far the case can be relied on as a piece " +
        "of work: faithful (the structure is accurate to what it draws on, complete for its specification, current, " +
        "and fair in what it selects and presents); incomplete (parts the specification calls for are known to be " +
        "missing: say which in gaps); misleading (the selection or framing would lead a reader to a conclusion the " +
        "structure does not support, and you cannot yet repair it); ill_specified (the specification does not fix " +
        "which system, deployment or standard the case is about, or quietly asserts something contested). verdict " +
        "says whether the case establishes its conclusion to the standard in its specification. The burden is on " +
        "the case: established is refused while a defeater is open, a sustained one is unaccepted, or a failure of " +
        "form has no stated departure. The verdict is about the case; it is not the conclusion's assessment and " +
        "changes nothing in it.",
      input_schema: {
        type: "object",
        properties: {
          fidelity: { type: "string", enum: [...ARTIFACT_FIDELITIES] },
          verdict: { type: "string", enum: [...CASE_VERDICTS] },
          verdict_basis: {
            type: "string",
            description: "Reader-facing: what the verdict rests on, the residual doubts among it. Link nodes as [[claim:<uuid>|phrase]].",
          },
          would_change: { type: "string", description: "Reader-facing: what would change the verdict." },
          assessment: {
            type: "string",
            description: "Reader-facing, shown first on the case's page: what a reader should know before relying on the case.",
          },
          reasoning_trace: { type: "string", description: "The audit record: how you built the structure, what you checked each step and side claim against, how you looked for doubts." },
          gaps: { type: "string", description: "What you know is missing. Required when incomplete." },
          confidence: { type: "number", description: "How sure you are of this judgment, 0..1." },
          marginal_yield: { type: "number", description: MARGINAL_YIELD_DESCRIPTION },
        },
        required: ["fidelity", "verdict", "verdict_basis", "assessment", "reasoning_trace"],
      },
    },
  ];
}

export const CASE_TOOL_NAMES = new Set(getCaseToolDefinitions().map((t) => t.name));

/** Who is calling: the case's own Steward, on its own node. */
export interface CaseToolContext {
  claimId: string;
  model?: string | null;
  trigger?: string | null;
  context?: string | null;
}

function ok(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, message, ...extra });
}
function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optStr = (v: unknown): string | undefined => str(v) || undefined;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where the case's form fails and what counts against it, as a tool's answer carries it. */
async function formNote(caseId: string): Promise<Record<string, unknown>> {
  const detail = await getCaseDetail(caseId);
  return {
    form: {
      framework: detail.form.framework,
      well_formed: detail.form.well_formed,
      failures: detail.form.failures,
    },
    counts_against: detail.counts_against,
  };
}

export async function executeCaseTool(
  name: string,
  input: Record<string, unknown>,
  ctx: CaseToolContext
): Promise<string | null> {
  if (!CASE_TOOL_NAMES.has(name)) return null;
  try {
    return await executeCaseToolImpl(name, input, ctx);
  } catch (err) {
    if (err instanceof ZodError) return refuse(`Not recorded: ${err.issues.map((i) => i.message).join("; ")}.`);
    if (err instanceof KindError) return refuse(err.message);
    const refusal = mirroredRefusalForAgent(err) ?? refusalForCaller(err);
    if (refusal) return refuse(refusal);
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeCaseToolImpl(name: string, input: Record<string, unknown>, ctx: CaseToolContext): Promise<string> {
  const caseId = ctx.claimId;
  const by = "artifact_steward";
  switch (name) {
    case "restate_case_spec": {
      if (!str(input.reasoning)) return refuse("Say why the new words state the same case.");
      await restateCaseSpec({
        claimId: caseId,
        spec: {
          system: str(input.system),
          deployment: str(input.deployment),
          standard: str(input.standard),
          standard_of: str(input.standard_of),
          not_covered: optStr(input.not_covered) ?? null,
        },
        createdBy: by,
      });
      return ok("Restated the case's specification. Log the change with log_stewardship_decision.");
    }
    case "write_case_element": {
      const nodeId = optStr(input.node_id);
      if (nodeId) {
        const [node] = await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id::text = $1`, [nodeId]);
        if (!node || node.state !== "active") {
          return refuse((await mergedAliasRefusal(nodeId))?.message ?? `No active node ${nodeId}.`);
        }
      }
      const { id } = await writeCaseElement({
        caseId,
        elementId: optStr(input.element_id) ?? null,
        type: str(input.type) as CaseElementType,
        parentId: optStr(input.parent_id) ?? null,
        nodeId: nodeId ?? null,
        argumentId: optStr(input.argument_id) ?? null,
        block: (optStr(input.block) as CaseBlock | undefined) ?? null,
        statement: str(input.statement),
        departure: optStr(input.departure) ?? null,
        raisedInPublished: typeof input.raised_in_published === "boolean" ? input.raised_in_published : null,
        createdBy: by,
      });
      return ok(input.element_id ? `Revised element ${id}.` : `Added element ${id}.`, { element_id: id, ...(await formNote(caseId)) });
    }
    case "remove_case_element": {
      if (!str(input.reason)) return refuse("Say why the element comes out of the structure.");
      const { removed } = await removeCaseElement({ caseId, elementId: str(input.element_id), createdBy: by });
      return ok(`Removed ${removed} element${removed === 1 ? "" : "s"}.`, await formNote(caseId));
    }
    case "set_defeater_standing": {
      const standing = str(input.standing) as DefeaterStanding;
      await setDefeaterStanding({
        caseId,
        elementId: str(input.element_id),
        standing,
        reason: str(input.reason),
        acceptedBy: optStr(input.accepted_by) ?? null,
        acceptance: optStr(input.acceptance) ?? null,
      });
      return ok(`Recorded the defeater as ${standing}.`, await formNote(caseId));
    }
    case "check_case_form": {
      const detail = await getCaseDetail(caseId);
      return ok("The structure as it stands.", {
        elements: detail.elements.map((e) => ({
          id: e.id,
          type: e.type,
          parent: e.parent,
          ...(e.block ? { block: e.block } : {}),
          statement: e.statement,
          ...(e.node ? { node_id: e.node.id, node: e.node.text, graph_judgment: e.node.judgment } : {}),
          ...(e.type === "defeater" ? { standing: e.standing, accepted_by: e.accepted_by ?? null } : {}),
          ...(e.departure ? { departure: e.departure } : {}),
          changed_since_judged: e.changed_since,
        })),
        form: detail.form,
        counts_against: detail.counts_against,
        residual_doubts: detail.residual_doubts,
      });
    }
    case CASE_ASSESSMENT_TOOL: {
      const usage = getUsageContext();
      const verdict = str(input.verdict) as CaseVerdict;
      const { id } = await recordCaseAssessment({
        claimId: caseId,
        fidelity: str(input.fidelity) as ArtifactFidelity,
        verdict,
        verdictBasis: str(input.verdict_basis),
        wouldChange: optStr(input.would_change) ?? null,
        summary: optStr(input.assessment) ?? null,
        reasoningTrace: str(input.reasoning_trace),
        gaps: optStr(input.gaps) ?? null,
        confidence: num(input.confidence),
        marginalYield: num(input.marginal_yield),
        model: ctx.model ?? null,
        fundedByJobId: usage.jobId ?? null,
        trigger: ctx.trigger ?? null,
        triggerContext: ctx.context ?? null,
      });
      return ok(`Recorded the case's assessment: ${str(input.fidelity)}, ${verdict.replace(/_/g, " ")}.`, { assessment_id: id });
    }
    default:
      return refuse(`Unknown case tool ${name}.`);
  }
}
