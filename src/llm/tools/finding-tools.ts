/**
 * The finding tools (#394): note_finding and search_findings, wired into
 * every administrator's toolbelt beside raise_issue.
 *
 * Same shape as report-tools.ts (a factory yielding the definitions and a
 * null-delegate executor, so each agent wires it with one spread and one
 * early return). An agent searches the findings on record by meaning with
 * search_findings, and passes joins to note_finding when its finding is one
 * already noted, which adds a sighting rather than a new row. Attribution
 * comes from the ambient usage context, as for reports.
 *
 * The tools are not given to the extension agent, the MCP surface, the
 * Extractor, the Matcher, or the solver: findings are the administrators'
 * to note, and an outside agent's discovery is a contribution. A mandate's
 * Grantmaker notes them too (constitution §19, Part VIII), with its own
 * description: it makes no assessment, so its finding cites records
 * already on the graph, and never mentions the mandate or its funder.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  FINDING_REF_KINDS,
  FINDING_SEARCH_MAX_LIMIT,
  noteFinding,
  searchFindings,
  type FindingMatch,
} from "../../services/finding-service.js";
import { getUsageContext } from "../usage-context.js";

export const NOTE_FINDING_TOOL_NAME = "note_finding";
export const SEARCH_FINDINGS_TOOL_NAME = "search_findings";

export interface FindingTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string | null>;
}

/**
 * What a mandate's agent is told in place of "make the assessment first"
 * (constitution §19, Part VIII): it makes no assessment, argument, or merge,
 * so its finding cites only what is already recorded, and like every
 * finding it never mentions the mandate or who funds it.
 */
const MANDATE_FINDING_BASIS =
  "It does not change the graph, and you make no assessment, argument, or " +
  "merge: cite only assessments, arguments, and merges already recorded, by " +
  "id, and say nothing the records do not. Write it as the graph's finding, " +
  "never as your mandate's: no mention of the mandate, its funder, or what " +
  "the work cost. ";

const ADMIN_FINDING_BASIS =
  "It does not change the graph, so make the " +
  "assessment, argument, or merge it rests on with its own tool first, " +
  "and cite it here. ";

export function getFindingToolDefinitions(options: { mandate?: boolean } = {}): Tool[] {
  return [
    {
      name: NOTE_FINDING_TOOL_NAME,
      description:
        "Share something you came across in your work that people should " +
        "see: a common belief the evidence does not support, a question that " +
        "turns out to have a clear answer, an unexpected result, a pattern " +
        "across many claims. Any " +
        "field counts. It is published on the findings page as you write it, " +
        "in the graph's voice. " +
        (options.mandate ? MANDATE_FINDING_BASIS : ADMIN_FINDING_BASIS) +
        "Search the findings on record first " +
        "(search_findings); if yours is already there, pass its id as joins. " +
        "A finding is more than routine work done well: it is something you " +
        "would point out to a colleague who cares about the question. " +
        "Problems with the system go to raise_issue.",
      input_schema: {
        type: "object" as const,
        properties: {
          headline: {
            type: "string",
            description:
              "One sentence stating what you found, as a claim about the " +
              "world: what is so, not that something was done.",
          },
          account: {
            type: "string",
            description:
              "A few paragraphs: what people generally think, what the " +
              "graph's record shows, and why. Where a sentence names a " +
              "claim, question or quantity on the graph, link it inline as " +
              "[[claim:<uuid>|the phrase you would use anyway]]; an " +
              "argument or a source the same way, as [[argument:<uuid>|...]] " +
              "or [[source:<uuid>|...]]. Link what a reader would want to " +
              "follow, not every node, and keep bare ids out of the prose: " +
              "those go in refs. Published as written.",
          },
          claim_id: {
            type: "string",
            description:
              "The node the finding is mainly about. Cite any others in refs.",
          },
          refs: {
            type: "array",
            description:
              "The records the finding rests on, by id; at least one. Cite " +
              "the assessment itself (its id is `assessment.id` in " +
              "get_claim; on a question, a question_assessment, " +
              "`question.assessment.id`; on a quantity, a quantity_estimate, " +
              "`quantity.assessed.id`), not only its node, so the finding " +
              "still points at what it rested on after a reassessment. An id " +
              "that does not resolve is dropped and named in the reply.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...FINDING_REF_KINDS] },
                id: { type: "string" },
              },
              required: ["kind", "id"],
            },
          },
          importance: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "How much the finding matters, from 1 to 10; not the claim's " +
              "importance. Roughly: 1 to 3, a useful correction or an " +
              "unexpected result on a narrow point; 4 to 6, something many " +
              "people get wrong on a significant question; 7 to 9, a central " +
              "question widely answered wrongly, now settled on the record; " +
              "10, the resolution of a major open problem, published nowhere " +
              "else.",
          },
          joins: {
            type: "string",
            description:
              "The id of a finding on record that yours repeats. Your " +
              "account and refs are added to it; nothing new is published.",
          },
        },
        required: ["headline", "account", "claim_id", "refs", "importance"],
      },
    },
    {
      name: SEARCH_FINDINGS_TOOL_NAME,
      description:
        "Search the published findings by meaning, closest first, " +
        "optionally on one node.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "What the finding says, in your words." },
          claim_id: { type: "string", description: "Only findings on this node." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: FINDING_SEARCH_MAX_LIMIT,
            description: "How many to return (default 5).",
          },
        },
        required: ["query"],
      },
    },
  ];
}

function describeMatch(m: FindingMatch): string {
  const when = m.first_noted_at ? m.first_noted_at.slice(0, 10) : "earlier";
  const claim = `on claim ${m.claim_id}`;
  const seen = m.sighting_count > 1 ? `; seen ${m.sighting_count} times` : "";
  return `${m.id} (${when}, ${m.agent}, ${claim}, importance ${m.importance}${seen}): "${m.headline}"`;
}

function describeDropped(refs: { kind: string; id: string }[]): string {
  return refs.map((r) => `${r.kind} ${r.id}`).join(", ");
}

const CONTINUE = "Continue with your task.";

/** Build the tool handle. `model` is recorded on each finding. */
export function createFindingTools(
  options: {
    model?: string;
    /** A mandate's agent (the Grantmaker): cites records, makes none. */
    mandate?: boolean;
  } = {}
): FindingTools {
  const definitions = getFindingToolDefinitions({ mandate: options.mandate });

  const execute = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string | null> => {
    if (name === SEARCH_FINDINGS_TOOL_NAME) {
      try {
        const matches = await searchFindings({
          query: String(input.query ?? ""),
          claimId: typeof input.claim_id === "string" ? input.claim_id : null,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        });
        return JSON.stringify({
          findings: matches,
          message:
            matches.length === 0
              ? "No published findings match."
              : matches.map(describeMatch).join("\n"),
        });
      } catch (err) {
        return JSON.stringify({
          findings: [],
          message: `The search failed (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    }
    if (name !== NOTE_FINDING_TOOL_NAME) return null;
    try {
      const ctx = getUsageContext();
      const result = await noteFinding({
        headline: String(input.headline ?? ""),
        account: String(input.account ?? ""),
        claimId: String(input.claim_id ?? ""),
        refs: input.refs,
        importance: input.importance,
        joins: typeof input.joins === "string" ? input.joins : null,
        agent: ctx.agent ?? "unknown",
        model: options.model ?? null,
        runId: ctx.runId ?? null,
        jobId: ctx.jobId ?? null,
        skills: ctx.skills ?? null,
      });

      switch (result.outcome) {
        case "joined":
          return JSON.stringify({
            success: true,
            acknowledged: true,
            status: "joined",
            finding_id: result.findingId,
            sighting_count: result.sightingCount,
            ...(result.droppedRefs.length
              ? { dropped_refs: result.droppedRefs }
              : {}),
            message:
              `Added as a sighting of the finding on record, now seen ` +
              `${result.sightingCount} times; the published note carries the count and ` +
              `your account.` +
              (result.droppedRefs.length
                ? ` These refs were dropped because no such record exists: ${describeDropped(result.droppedRefs)}.`
                : "") +
              ` ${CONTINUE}`,
          });
        case "recorded":
          return JSON.stringify({
            success: true,
            acknowledged: true,
            status: "recorded",
            finding_id: result.findingId,
            ...(result.droppedRefs.length
              ? { dropped_refs: result.droppedRefs }
              : {}),
            message: result.droppedRefs.length
              ? `Recorded and published, with these refs dropped because no such record ` +
                `exists: ${describeDropped(result.droppedRefs)}. If the finding rests on ` +
                `them, record them through their own tools first and note again. ${CONTINUE}`
              : `Recorded and published on the findings page as written. ${CONTINUE} ` +
                `Noting a finding is not a substitute for the work it points at.`,
          });
        case "not_recorded":
        default:
          return JSON.stringify({
            success: false,
            acknowledged: true,
            status: "not_recorded",
            message: `Not recorded: ${result.problem}. ${CONTINUE}`,
          });
      }
    } catch (err) {
      // noteFinding already never throws; the channel must not be able to
      // fail the run under any circumstances.
      return JSON.stringify({
        success: false,
        acknowledged: true,
        status: "not_recorded",
        message: `Not recorded (${err instanceof Error ? err.message : String(err)}). ${CONTINUE}`,
      });
    }
  };

  return { definitions, execute };
}
