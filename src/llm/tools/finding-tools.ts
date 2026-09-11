/**
 * The note_finding tool (#394): the notable-finding channel, wired into every
 * administrator's toolbelt beside raise_issue.
 *
 * Same shape as report-tools.ts (a factory yielding the definition and a
 * null-delegate executor, so each agent wires it with one spread and one
 * early return) without the counter: there is no per-run cap. The restraint
 * is the bar in the NOTING_FINDINGS prompt block; a run that notes nothing is
 * the norm, and nothing here nudges toward noting.
 *
 * What the tool does that the prompt cannot: it checks the record before it
 * writes. The service embeds the finding and searches every finding on
 * record; on a near match nothing is written and the matches come back to
 * the agent, which answers on a second call with `joins` (a sighting of that
 * finding) or `distinct_from` (a new finding, saying what the earlier one
 * lacks). Attribution comes from the ambient usage context, as for reports.
 *
 * The tool is not given to the extension chat, the MCP surface, the
 * Extractor, the Matcher, or the solver: findings are the administrators'
 * to note, and an outside agent's discovery is a contribution.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import {
  FINDING_REF_KINDS,
  noteFinding,
  type FindingMatch,
} from "../../services/finding-service.js";
import { getUsageContext } from "../usage-context.js";

export const NOTE_FINDING_TOOL_NAME = "note_finding";

export interface FindingTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string | null>;
}

export function getFindingToolDefinitions(): Tool[] {
  return [
    {
      name: NOTE_FINDING_TOOL_NAME,
      description:
        "Record a notable finding: a result of your work that is correct on " +
        "the graph's record and that people who hold the question would be " +
        "better for knowing: what most of them believe is wrong, or missing, " +
        "or true for reasons the record now supplies. It is published on the " +
        "findings page as written, in the graph's voice, and changes nothing " +
        "on the graph: record the assessment, argument, or merge through its " +
        "own tool first, then point at it. Never a problem with the system, " +
        "which is what raise_issue is for. Always acknowledges and never " +
        "changes this run's outcome. Most runs have nothing to note; do not " +
        "note the ordinary work, a point the field already accepts, or " +
        "anything you cannot cite by id.",
      input_schema: {
        type: "object" as const,
        properties: {
          headline: {
            type: "string",
            description:
              "One sentence in the graph's voice stating the result as a " +
              "claim about the world. \"The conjecture has a machine-checked " +
              "proof\" says something; \"A proof was accepted\" does not.",
          },
          account: {
            type: "string",
            description:
              "One to three paragraphs in the graph's voice: what is " +
              "generally believed, what the graph's record shows, and what " +
              "decides it. Cite the graph's records by id wherever one " +
              "exists. Quote where the quotation is the point, briefly and " +
              "attributed. Published as written. If the point has been made " +
              "before, say where; that does not disqualify it.",
          },
          claim_id: {
            type: "string",
            description:
              "The claim the finding is chiefly about. A finding about " +
              "several claims names the one a reader would look up first " +
              "and cites the rest in refs.",
          },
          refs: {
            type: "array",
            description:
              "The records the finding rests on, by id; at least one. Every " +
              "id is checked; one that does not resolve is dropped and named " +
              "in the acknowledgment. Cite the assessment or the check " +
              "itself, not only its claim, so the note still says what it " +
              "rested on after a re-assessment.",
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
              "The importance of the finding, not of the claim. 10: a " +
              "verified, novel resolution of a first-rank problem, published " +
              "nowhere else. 7 to 9: a central question most of the " +
              "discourse answers wrongly, settled on the record, or a novel " +
              "resolution of an open problem the field knows by name. 4 to " +
              "6: a significant point the discourse generally gets wrong, " +
              "even if made before without reaching the people who hold the " +
              "question, or a common belief put on grounds it lacked. 1 to " +
              "3: a resolved question, an unexpected result, or a widely " +
              "held error on a minor claim; still a finding.",
          },
          joins: {
            type: "string",
            description:
              "The id of a finding the tool showed you, when yours is the " +
              "same finding. Your account and refs are added to it as a " +
              "sighting; nothing new is published.",
          },
          distinct_from: {
            type: "array",
            items: { type: "string" },
            description:
              "The ids of findings the tool showed you that yours is not, " +
              "when you are noting despite them. Say in the account what " +
              "they lack. Ignored on a first call.",
          },
        },
        required: ["headline", "account", "claim_id", "refs", "importance"],
      },
    },
  ];
}

function describeMatch(m: FindingMatch): string {
  const when = m.first_noted_at ? m.first_noted_at.slice(0, 10) : "earlier";
  const claim = m.same_claim ? "on this claim" : `on claim ${m.claim_id}`;
  const seen = m.sighting_count > 1 ? `; seen ${m.sighting_count} times` : "";
  return `${m.id} (${when}, ${m.agent}, ${claim}, importance ${m.importance}${seen}): "${m.headline}"`;
}

function describeDropped(refs: { kind: string; id: string }[]): string {
  return refs.map((r) => `${r.kind} ${r.id}`).join(", ");
}

const CONTINUE = "Continue with your task.";

/** Build the tool handle. `model` is recorded on each finding. */
export function createFindingTools(options: { model?: string } = {}): FindingTools {
  const definitions = getFindingToolDefinitions();

  const execute = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string | null> => {
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
        distinctFrom: input.distinct_from,
        agent: ctx.agent ?? "unknown",
        model: options.model ?? null,
        runId: ctx.runId ?? null,
        jobId: ctx.jobId ?? null,
        skills: ctx.skills ?? null,
      });

      switch (result.outcome) {
        case "possible_duplicate":
          return JSON.stringify({
            success: false,
            acknowledged: true,
            status: "possible_duplicate",
            matches: result.matches,
            message:
              `Not yet recorded: a finding already on record may be the same as yours. ` +
              result.matches.map(describeMatch).join(" ") +
              ` If yours is one of these, call again with joins set to its id and your ` +
              `account is added as a sighting. If it is not, call again with distinct_from ` +
              `listing these ids and say in the account what they lack.`,
          });
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
