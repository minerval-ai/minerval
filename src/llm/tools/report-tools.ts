/**
 * The issue tools (#366): raise_issue, update_issue, and search_issues, one
 * bundle wired into every agent's toolbelt.
 *
 * An agent is the densest user of this system's tools and hits their
 * failures first. This is where that goes: a tool that errored, a payload
 * missing the field the prompt says to reason over, a relation type that
 * does not exist, a concrete idea for the graph arrived at from having just
 * done the work. Not a substitute for acting — the policies say so — and
 * never a way to fail a run: every tool here acknowledges whatever happens.
 *
 * Three tools because an agent that has found a problem needs three
 * things: to say so (raise_issue, which checks the record first and shows
 * a near match with its status and the maintainers' note before writing
 * anything); to correct itself (update_issue: re-rate, add what it found
 * since, or withdraw a report that was its own mistake); and to look on
 * purpose (search_issues), since an agent has no memory across runs and
 * the tracker is the only place a known workaround lives. Every report
 * becomes a GitHub issue for the maintainers; the tools say so once.
 *
 * Shape differs from the other bundles on purpose. The per-run cap needs
 * state, and the executors are stateless functions, so this is a factory:
 * one createReportTools() per agent run yields the definitions and an
 * executor with its own counter (the same closure-counter idiom the Steward
 * uses for subclaims and instances). The executor follows graph-read-tools'
 * null-delegate convention — null means "not my tool" — so every agent
 * wires it with one spread and one early return at the top of executeTool.
 *
 * Attribution comes from the ambient usage context (agent name, run, job,
 * claim), so no agent signature changes to carry it. The same context
 * carries the privacy seam (#356): inside untraced() work — the extension's
 * page analysis and chat, the MCP's on-demand analysis — nothing derived
 * from the reader's content may be persisted, so a report or a note keeps
 * its kind, severity, title, surface, and id refs but the free-text body is
 * withheld. The title is the report there; the prompts say so.
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { loadConfig } from "../../config.js";
import {
  raiseIssue,
  searchReports,
  updateReport,
  REPORT_KINDS,
  REPORT_SEVERITIES,
  type ReportMatch,
} from "../../services/report-service.js";
import { getUsageContext } from "../usage-context.js";

export const RAISE_ISSUE_TOOL_NAME = "raise_issue";
export const UPDATE_ISSUE_TOOL_NAME = "update_issue";
export const SEARCH_ISSUES_TOOL_NAME = "search_issues";

/** What an untraced context's report carries in place of its body (#356). */
export const UNTRACED_BODY_NOTE =
  "(body withheld: raised from an untraced context, where nothing derived " +
  "from the reader's content is persisted — see the title and context_refs)";

export interface ReportTools {
  definitions: Tool[];
  /** Returns null for any tool name this bundle does not own. */
  execute: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string | null>;
  /** Writes recorded by this run so far (test and diagnostics aid). */
  readonly raisedCount: number;
}

const PROCEED =
  "Now proceed with the best available action; raising an issue is not a " +
  "substitute for acting.";

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
        "(improvement). The tool checks the record before it writes: if a " +
        "report on record may be the same problem, nothing is written and you " +
        "are shown it with its status and the maintainers' note, and you " +
        "answer with joins or distinct_from. Every new report is filed as an " +
        "issue for the maintainers. Fire-and-forget: it always acknowledges, " +
        "never blocks, and never changes this run's outcome. Raising an issue " +
        "is not a substitute for acting: report, then proceed with the best " +
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
          joins: {
            type: "string",
            description:
              "The id of a report the tool showed you, when yours is the " +
              "same problem. Your body is added to it as a sighting with " +
              "your account of this occurrence; nothing new is filed.",
          },
          distinct_from: {
            type: "array",
            items: { type: "string" },
            description:
              "The ids of reports the tool showed you that yours is not, " +
              "when you are raising despite them. Say in the body what " +
              "makes yours different. Ignored on a first call.",
          },
        },
        required: ["kind", "severity", "title", "body"],
      },
    },
    {
      name: UPDATE_ISSUE_TOOL_NAME,
      description:
        "Amend a report you raised or joined, when you have seen more than " +
        "you had when you raised it: re-rate its severity, add a note (the " +
        "cause you found, a workaround, the id of a clean reproduction), or " +
        "withdraw it because it was your own mistake, so nobody triages a " +
        "non-issue. The amendment follows the report to its issue. Always " +
        "acknowledges; never changes this run's outcome.",
      input_schema: {
        type: "object" as const,
        properties: {
          report_id: {
            type: "string",
            description: "The report's id, from raise_issue or search_issues.",
          },
          severity: {
            type: "string",
            enum: [...REPORT_SEVERITIES],
            description: "A new severity, when the first rating was wrong.",
          },
          note: {
            type: "string",
            description:
              "What you found since: the cause, a workaround, what a " +
              "maintainer should look at. Ids, not content. When " +
              "withdrawing, why the report does not hold.",
          },
          withdraw: {
            type: "boolean",
            description:
              "True when the report was your mistake (the tool worked once " +
              "called correctly; the state was not impossible after all). " +
              "Closes it as withdrawn by you.",
          },
        },
        required: ["report_id"],
      },
    },
    {
      name: SEARCH_ISSUES_TOOL_NAME,
      description:
        "Search the reports agents have raised about the system, by " +
        "meaning. Use it before working around a failure, to learn whether " +
        "it is known and what the maintainers said (a wontfix note is " +
        "guidance; an actioned one means the fix shipped), and to find a " +
        "report to update. Read-only; free.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "The problem in a sentence, as you would title a report.",
          },
          surface: {
            type: "string",
            description: "Narrow to reports about this tool or pipeline. Optional.",
          },
        },
        required: ["query"],
      },
    },
  ];
}

function describeMatch(m: ReportMatch): string {
  const when = m.first_seen_at ? m.first_seen_at.slice(0, 10) : "earlier";
  const seen = m.occurrence_count > 1 ? `, seen ${m.occurrence_count} times` : "";
  const note = m.triage_note ? ` Maintainers' note: "${m.triage_note}"` : "";
  return `${m.id} (${when}, ${m.agent}, ${m.kind}/${m.severity}, status ${m.status}${seen}): "${m.title}".${note}`;
}

/**
 * What the record says about a report the agent's write collapsed onto:
 * the part an agent can act on in this run. A wontfix note is guidance; an
 * actioned report seen again is a regression the agent just reopened.
 */
function describeExisting(existing: {
  status: string;
  triageNote: string | null;
  reopened: boolean;
}): string {
  const note = existing.triageNote ? ` Maintainers' note: "${existing.triageNote}".` : "";
  switch (existing.status) {
    case "wontfix":
      return (
        ` This report is known and the maintainers declined it; treat their note as ` +
        `guidance for how to proceed.${note}`
      );
    case "duplicate":
      return ` This report is known and triaged as a duplicate of another.${note}`;
    case "triaged":
      return ` This report is known and triaged; the maintainers have it.${note}`;
    case "withdrawn":
      return (
        ` This report was withdrawn by its reporter as a mistake; if you are sure ` +
        `it is real, add a note with update_issue saying what the reporter missed.${note}`
      );
    case "new":
      return existing.reopened
        ? ` This report had been actioned; your sighting reopened it as a regression.${note}`
        : "";
    default:
      return note;
  }
}

/**
 * Build the per-run tool handle. `model` is recorded on each report so a
 * triager can tell whether a gap is model-specific.
 */
export function createReportTools(options: { model?: string } = {}): ReportTools {
  const definitions = getReportToolDefinitions();
  let raised = 0;

  const capped = (): string | null => {
    const cap = loadConfig().agentReportsPerRun;
    if (cap > 0 && raised >= cap) {
      return JSON.stringify({
        success: false,
        acknowledged: true,
        message:
          `This run has already recorded ${raised} report(s) or note(s), the ` +
          `per-run cap (${cap}). Nothing was recorded. Continue with your task; ` +
          `if this recurs it will be reported by a later run.`,
      });
    }
    return null;
  };

  const executeRaise = async (input: Record<string, unknown>): Promise<string> => {
    const blocked = capped();
    if (blocked) return blocked;

    const ctx = getUsageContext();
    const body = ctx.untraced ? UNTRACED_BODY_NOTE : String(input.body ?? "");
    const result = await raiseIssue({
      kind: String(input.kind ?? ""),
      severity: String(input.severity ?? ""),
      title: String(input.title ?? ""),
      body,
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
      joins: typeof input.joins === "string" ? input.joins : null,
      distinctFrom: input.distinct_from,
    });

    if (result.matches) {
      // Nothing written: the agent answers on a second call. Not counted
      // against the cap, since nothing was recorded.
      return JSON.stringify({
        success: false,
        acknowledged: true,
        status: "possible_duplicate",
        matches: result.matches,
        message:
          `Not yet recorded: a report already on record may be the same problem. ` +
          result.matches.map(describeMatch).join(" ") +
          ` If yours is one of these, call again with joins set to its id and your ` +
          `body is added as a sighting. If it is not, call again with distinct_from ` +
          `listing these ids and say in the body what makes yours different. A ` +
          `maintainers' note on a known report is guidance for your current task.`,
      });
    }

    if (!result.reportId) {
      // Validation problems are the agent's to fix (legal values are in
      // the message); anything else is ours, and the agent just moves on.
      return JSON.stringify({
        success: false,
        acknowledged: true,
        status: "not_recorded",
        message:
          `Not recorded: ${result.problem ?? "unknown problem"}. ` +
          `Continue with your task.`,
      });
    }

    raised++;
    if (result.deduplicated) {
      return JSON.stringify({
        success: true,
        acknowledged: true,
        status: result.existing?.reopened ? "reopened" : "joined",
        report_id: result.reportId,
        occurrence_count: result.occurrenceCount,
        report_status: result.existing?.status ?? null,
        ...(result.existing?.githubIssueUrl
          ? { issue_url: result.existing.githubIssueUrl }
          : {}),
        message:
          `Acknowledged: this issue has now been reported ` +
          `${result.occurrenceCount} time(s); your account is on record as a ` +
          `sighting.` +
          (result.existing ? describeExisting(result.existing) : "") +
          ` ${PROCEED}`,
      });
    }
    return JSON.stringify({
      success: true,
      acknowledged: true,
      status: "recorded",
      report_id: result.reportId,
      occurrence_count: result.occurrenceCount,
      message:
        `Acknowledged and recorded; it is being filed as an issue for the ` +
        `maintainers. Use update_issue with this report_id if you learn more ` +
        `in this run. ${PROCEED}`,
    });
  };

  const executeUpdate = async (input: Record<string, unknown>): Promise<string> => {
    const withdraw = input.withdraw === true;
    // Withdrawing is a correction, never blocked by the cap: a run that
    // spent its reports must still be able to take one back.
    if (!withdraw) {
      const blocked = capped();
      if (blocked) return blocked;
    }
    const ctx = getUsageContext();
    const rawNote = typeof input.note === "string" ? input.note : "";
    const note = ctx.untraced && rawNote.trim() ? UNTRACED_BODY_NOTE : rawNote;
    const result = await updateReport(String(input.report_id ?? ""), {
      severity: typeof input.severity === "string" ? input.severity : null,
      note,
      withdraw,
      agent: ctx.agent ?? "unknown",
      model: options.model ?? null,
      runId: ctx.runId ?? null,
      jobId: ctx.jobId ?? null,
      claimId: ctx.claimId ?? null,
    });
    if (!result.reportId) {
      return JSON.stringify({
        success: false,
        acknowledged: true,
        status: "not_updated",
        message: `Not updated: ${result.problem ?? "unknown problem"}. Continue with your task.`,
      });
    }
    if (!withdraw) raised++;
    return JSON.stringify({
      success: true,
      acknowledged: true,
      status: withdraw ? "withdrawn" : "updated",
      report_id: result.reportId,
      report_status: result.status,
      ...(result.githubIssueUrl ? { issue_url: result.githubIssueUrl } : {}),
      message: withdraw
        ? `Withdrawn: the report is closed as your own reversal and its issue is ` +
          `closed with your note. Continue with your task.`
        : `Updated: your amendment is on the report and follows it to its issue. ` +
          `Continue with your task.`,
    });
  };

  const executeSearch = async (input: Record<string, unknown>): Promise<string> => {
    const result = await searchReports(String(input.query ?? ""), {
      origin: "internal",
      surface: typeof input.surface === "string" ? input.surface : null,
    });
    if (result.problem) {
      return JSON.stringify({
        success: false,
        matches: [],
        message: `Search unavailable: ${result.problem}. Continue with your task.`,
      });
    }
    return JSON.stringify({
      success: true,
      matches: result.matches,
      message: result.matches.length
        ? `${result.matches.length} report(s) on record may match. ` +
          result.matches.map(describeMatch).join(" ") +
          ` A wontfix note is the maintainers' guidance; an actioned report ` +
          `means the fix shipped, so seeing it again is a regression worth ` +
          `raising with joins.`
        : `No report on record matches. If this is a real problem, raise it.`,
    });
  };

  const execute = async (
    name: string,
    input: Record<string, unknown>
  ): Promise<string | null> => {
    try {
      switch (name) {
        case RAISE_ISSUE_TOOL_NAME:
          return await executeRaise(input);
        case UPDATE_ISSUE_TOOL_NAME:
          return await executeUpdate(input);
        case SEARCH_ISSUES_TOOL_NAME:
          return await executeSearch(input);
        default:
          return null;
      }
    } catch (err) {
      // Belt and braces: the services already never throw, but the channel
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
