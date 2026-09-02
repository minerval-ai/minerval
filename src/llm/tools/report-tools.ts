/**
 * The raise_issue tool (#366): one shape, wired into every agent's toolbelt.
 *
 * An agent is the densest user of this system's tools and hits their
 * failures first. This is where that goes: a tool that errored, a payload
 * missing the field the prompt says to reason over, a relation type that
 * does not exist, a concrete idea for the graph arrived at from having just
 * done the work. Not a substitute for acting — the policies say so — and
 * never a way to fail a run: the tool acknowledges whatever happens.
 *
 * Shape differs from the other bundles on purpose. The per-run cap needs
 * state, and the executors are stateless functions, so this is a factory:
 * one createReportTools() per agent run yields the definition and an
 * executor with its own counter (the same closure-counter idiom the Steward
 * uses for subclaims and instances). The executor follows graph-read-tools'
 * null-delegate convention — null means "not my tool" — so every agent
 * wires it with one spread and one early return at the top of executeTool.
 *
 * Attribution comes from the ambient usage context (agent name, run, job,
 * claim), so no agent signature changes to carry it.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { loadConfig } from "../../config.js";
import {
  raiseIssue,
  REPORT_KINDS,
  REPORT_SEVERITIES,
} from "../../services/report-service.js";
import { getUsageContext } from "../usage-context.js";

export const RAISE_ISSUE_TOOL_NAME = "raise_issue";

export interface ReportTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string | null>;
  /** Reports recorded by this run so far (test and diagnostics aid). */
  readonly raisedCount: number;
}

export function getReportToolDefinitions(): Tool[] {
  return [
    {
      name: RAISE_ISSUE_TOOL_NAME,
      description:
        "Report a problem with the SYSTEM you are working in, or a concrete " +
        "idea for improving it — never a judgment about a claim. Use it when a " +
        "tool errored or returned something the prompt says is impossible " +
        "(system_failure); when the tool you need does not exist, cannot " +
        "express what you need to say, or its result omits what you were " +
        "told to reason over (tool_gap); or when doing this work showed you a " +
        "specific, actionable improvement to the graph or its machinery " +
        "(improvement). Fire-and-forget: it always acknowledges, never " +
        "blocks, and never changes this run's outcome. Raising an issue is " +
        "not a substitute for acting: report, then proceed with the best " +
        "action still available to you. Do not report when nothing is wrong; " +
        "a few per run at most.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            enum: [...REPORT_KINDS],
            description:
              "system_failure: something broke. tool_gap: a tool is missing, " +
              "misdescribed, or cannot express what you need. improvement: a " +
              "concrete proposal.",
          },
          severity: {
            type: "string",
            enum: [...REPORT_SEVERITIES],
            description:
              "blocking: you could not complete the task because of it. " +
              "degraded: you completed it, worse than you should have. " +
              "annoyance: friction without a worse outcome. idea: an " +
              "improvement, not a defect.",
          },
          title: {
            type: "string",
            description:
              "One line, written as a claim about what is wrong or what " +
              "should exist, e.g. 'add_relationship_edge has no relation " +
              "type for counterparts under different framings'. Reuse the " +
              "same wording for the same problem so repeats collapse.",
          },
          body: {
            type: "string",
            description:
              "What you were trying to do, what happened, what you expected, " +
              "and for an improvement the concrete proposal. Cite ids, not " +
              "content: do not paste source text or contribution bodies.",
          },
          surface: {
            type: "string",
            description:
              "The tool, prompt section, or pipeline the report is about, " +
              "when there is one (e.g. 'add_relationship_edge', " +
              "'steward-pipeline'). Optional.",
          },
          context_refs: {
            type: "object",
            description:
              "Optional pointers as ids only: claim_id, contribution_id, " +
              "source_url, job_id, tool_call, etc. Values must be short " +
              "strings or numbers.",
          },
        },
        required: ["kind", "severity", "title", "body"],
      },
    },
  ];
}

/**
 * Build the per-run tool handle. `model` is recorded on each report so a
 * triager can tell whether a gap is model-specific.
 */
export function createReportTools(options: { model?: string } = {}): ReportTools {
  const definitions = getReportToolDefinitions();
  let raised = 0;

  const execute = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string | null> => {
    if (name !== RAISE_ISSUE_TOOL_NAME) return null;
    try {
      const cap = loadConfig().agentReportsPerRun;
      if (cap > 0 && raised >= cap) {
        return JSON.stringify({
          success: false,
          acknowledged: true,
          message:
            `This run has already raised ${raised} issue(s), the per-run cap ` +
            `(${cap}). Nothing was recorded. Continue with your task; if this ` +
            `recurs it will be reported by a later run.`,
        });
      }

      const ctx = getUsageContext();
      const result = await raiseIssue({
        kind: String(input.kind ?? ""),
        severity: String(input.severity ?? ""),
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        surface: typeof input.surface === "string" ? input.surface : null,
        contextRefs:
          input.context_refs && typeof input.context_refs === "object"
            ? (input.context_refs as Record<string, unknown>)
            : null,
        origin: "internal",
        agent: ctx.agent ?? "unknown",
        model: options.model ?? null,
        runId: ctx.runId ?? null,
        jobId: ctx.jobId ?? null,
        claimId: ctx.claimId ?? null,
      });

      if (!result.reportId) {
        // Validation problems are the agent's to fix (legal values are in
        // the message); anything else is ours, and the agent just moves on.
        return JSON.stringify({
          success: false,
          acknowledged: true,
          message:
            `Not recorded: ${result.problem ?? "unknown problem"}. ` +
            `Continue with your task.`,
        });
      }

      raised++;
      return JSON.stringify({
        success: true,
        acknowledged: true,
        report_id: result.reportId,
        occurrence_count: result.occurrenceCount,
        message: result.deduplicated
          ? `Acknowledged: this issue has now been reported ` +
            `${result.occurrenceCount} time(s). Now proceed with the best ` +
            `available action; raising an issue is not a substitute for acting.`
          : `Acknowledged and recorded. Now proceed with the best available ` +
            `action; raising an issue is not a substitute for acting.`,
      });
    } catch (err) {
      // Belt and braces: raiseIssue already never throws, but the channel
      // must not be able to fail the run under any circumstances.
      return JSON.stringify({
        success: false,
        acknowledged: true,
        message:
          `Not recorded (${err instanceof Error ? err.message : String(err)}). ` +
          `Continue with your task.`,
      });
    }
  };

  return {
    definitions,
    execute,
    get raisedCount() {
      return raised;
    },
  };
}
