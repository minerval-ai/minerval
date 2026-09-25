/**
 * The Consistency Checker run: one sweep over one partition of the graph
 * (#330; docs/allocation.md, "Consistency sweeps").
 *
 * The mechanical pre-filter (coherence-service.ts) has already shortlisted
 * the pairs whose recorded verdicts look incompatible by their edge's own
 * logic; this agent does the part a rule cannot: it reads the verdicts and
 * the reasoning side by side and decides which tensions are real. Its
 * affordances are the graph reads, the shortlist, a side-by-side
 * comparison, and three ways to record a decision:
 *
 *  - flag_inconsistency: the primary claim becomes a candidate on the
 *    ledger (its Steward enqueued with the tension as context, its
 *    standard action valued on the General mandate within a ceiling);
 *  - dismiss_candidate: the pair was read and both verdicts stand, so it
 *    stays off later sweeps until one of its assessments changes;
 *  - finish_sweep: the note that closes the sweep.
 *
 * Like the Lookout, what it cannot do is the point: it writes no
 * assessment, edge or importance, and moves no money. Everything it raises
 * is a candidate the allocator funds or not, and its flags are recorded so
 * its precision can be read (consistency-service.ts).
 */
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { loadConfig } from "../../config.js";
import { getUsageContext, withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { getConsistencyCheckerSystemPromptBlocks } from "../prompts/consistency-checker.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import type { CoherenceCandidate } from "../../services/coherence-service.js";
import {
  compareAssessments,
  CONSISTENCY_BOUNDS,
  CONSISTENCY_FLAG_KINDS,
  dismissCandidate,
  flagInconsistency,
} from "../../services/consistency-service.js";

export interface ConsistencyCheckerResult {
  note: string;
  flagsRaised: number;
  repeats: number;
  dismissed: number;
  /** agent_runs.id when tracing is on. */
  runId: string | null;
}

/** Tool calls per sweep: a read of a shortlist, not a survey of the graph. */
const MAX_ITERATIONS = 24;
/** Candidates per list_candidates page. */
const PAGE = 10;

export function runConsistencyChecker(
  input: Parameters<typeof runConsistencyCheckerImpl>[0]
): ReturnType<typeof runConsistencyCheckerImpl> {
  return withAgent("consistency_checker", () => runConsistencyCheckerImpl(input));
}

/** One candidate as the agent reads it in a list page. */
export function renderCandidate(c: CoherenceCandidate, index: number): Record<string, unknown> {
  const side = (e: CoherenceCandidate["primary"]) => ({
    claim_id: e.claim_id,
    text: e.text.slice(0, 240),
    status: e.status,
    credence: e.credence,
    assessed_at: e.assessed_at.slice(0, 10),
  });
  return {
    index,
    kind: c.kind,
    relation: c.relation,
    importance: c.importance,
    claim_ids: c.claim_ids,
    primary: side(c.primary),
    other: side(c.other),
    ...(c.neighbor_status_then ? { other_status_when_primary_assessed: c.neighbor_status_then } : {}),
  };
}

async function runConsistencyCheckerImpl(input: {
  sweepId: string;
  /** Human label of the partition, e.g. a tag slug or "residual". */
  partitionLabel: string;
  candidates: CoherenceCandidate[];
  /** Candidates the pre-filter found but a live dismissal or open flag suppressed. */
  suppressed: number;
  maxFlags?: number;
  maxValue?: number;
  model?: string;
}): Promise<ConsistencyCheckerResult> {
  const config = loadConfig();
  const model = input.model ?? config.consistencyModel;
  const maxFlags = input.maxFlags ?? config.consistencyMaxFlagsPerSweep;
  const maxValue = input.maxValue ?? config.consistencyFlagMaxValue;
  const system = getConsistencyCheckerSystemPromptBlocks();
  const reportTools = createReportTools({ model });
  const runId = getUsageContext().runId ?? null;

  const kinds = [...CONSISTENCY_FLAG_KINDS];
  const tools: Tool[] = [
    ...reportTools.definitions,
    ...getGraphReadToolDefinitions(),
    {
      name: "list_candidates",
      description:
        `This sweep's shortlist from the mechanical pre-filter, most important ` +
        `first, ${PAGE} per page: each names the kind of check that fired, the ` +
        `edge or link it runs along, and both sides' current verdicts. A ` +
        `candidate is a place to look, never a finding. Paginate with offset.`,
      input_schema: {
        type: "object" as const,
        properties: { offset: { type: "number" } },
        required: [],
      },
    },
    {
      name: "compare_assessments",
      description:
        `Up to ${CONSISTENCY_BOUNDS.maxClaims} claims side by side: text, ` +
        `importance, current status, credence and confidence, when and by which ` +
        `model each was assessed, the summary and the head of the reasoning ` +
        `trace, and every edge or link among them with its reasoning. The read ` +
        `a coherence judgment needs.`,
      input_schema: {
        type: "object" as const,
        properties: { claim_ids: { type: "array", items: { type: "string" } } },
        required: ["claim_ids"],
      },
    },
    {
      name: "flag_inconsistency",
      description:
        "Raise a tension you judged real: the primary claim's Steward is asked " +
        "to reconcile it, and its reassessment becomes a candidate on the " +
        "ledger valued at your urgency (clamped to your ceiling); the " +
        "allocator decides whether it runs. The primary is the claim whose " +
        "assessment looks wrong. A primary already flagged and still waiting " +
        `counts as a repeat. At most ${maxFlags} new flag(s) this sweep.`,
      input_schema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: kinds },
          primary_claim_id: { type: "string" },
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Every claim in the tension, the primary included.",
          },
          rationale: {
            type: "string",
            description:
              "For the Steward: which verdicts, which edge, and what in the " +
              "reasoning makes them incompatible.",
          },
          urgency: {
            type: "number",
            description:
              "0–10: how much fixing this matters relative to everything else " +
              "the platform could fund (importance × how far a reader is misled).",
          },
        },
        required: ["kind", "primary_claim_id", "claim_ids", "rationale", "urgency"],
      },
    },
    {
      name: "dismiss_candidate",
      description:
        "Record that you read a candidate and both verdicts can stand, with " +
        "the reason. It stays off later sweeps until one of its assessments " +
        "changes. Dismiss only what you actually read.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: kinds },
          claim_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["kind", "claim_ids", "reason"],
      },
    },
    {
      name: "finish_sweep",
      description:
        "Close the sweep with a short note: what you read, flagged and " +
        "dismissed, and any pattern worth an operator's attention. Call it " +
        "last, alone, then end your turn.",
      input_schema: {
        type: "object" as const,
        properties: { note: { type: "string" } },
        required: ["note"],
      },
    },
  ];

  const briefing =
    `## Consistency sweep\n\n` +
    `Partition: ${input.partitionLabel}. The pre-filter shortlisted ` +
    `${input.candidates.length} candidate(s) here` +
    (input.suppressed > 0
      ? ` (and suppressed ${input.suppressed} already flagged or dismissed on the same assessments)`
      : "") +
    `.\n\n` +
    `Your bounds: at most ${maxFlags} new flag(s); a flag's value is clamped to ` +
    `${maxValue}/10; about ${MAX_ITERATIONS} tool turns.\n\n` +
    (input.candidates.length === 0
      ? `There is nothing on the shortlist. Finish the sweep with a one-line note.`
      : `Read the shortlist, compare what needs comparing, record a decision on ` +
        `each candidate you read, and finish the sweep with a note. Nobody is ` +
        `watching this run; act with the judgment of a careful person paid to ` +
        `find real defects and to leave sound work alone.`);

  let flagsRaised = 0;
  let repeats = 0;
  let dismissed = 0;
  let note = "";
  let closed = false;

  const result = await toolUseLoop({
    initialMessages: [{ role: "user", content: briefing }],
    tools,
    system,
    model,
    maxTokens: 2048,
    maxIterations: MAX_ITERATIONS,
    iterationBudgetNotice: {
      warnWithin: 3,
      message: (remaining) =>
        `You have ${remaining} tool turn${remaining === 1 ? "" : "s"} left. ` +
        `Record what you are sure of and call finish_sweep.`,
    },
    // A model that keeps calling tools after finish_sweep ends the loop at
    // once: by then every decision it made has already executed.
    onFinalTool: () => (closed ? { note } : null),
    executeTool: async (name, toolInput) => {
      if (closed) {
        return JSON.stringify({ ok: false, problem: "The sweep is closed. End your turn." });
      }
      const report = await reportTools.execute(name, toolInput);
      if (report !== null) return report;
      const graphRead = await executeGraphReadTool(name, toolInput);
      if (graphRead !== null) return graphRead;

      if (name === "list_candidates") {
        const offset = Math.max(0, Math.floor(Number(toolInput.offset ?? 0)) || 0);
        const page = input.candidates
          .slice(offset, offset + PAGE)
          .map((c, i) => renderCandidate(c, offset + i));
        return JSON.stringify({
          total: input.candidates.length,
          offset,
          candidates: page,
          ...(offset + PAGE < input.candidates.length ? { next_offset: offset + PAGE } : {}),
        });
      }
      if (name === "compare_assessments") {
        return JSON.stringify(await compareAssessments(toolInput.claim_ids));
      }
      if (name === "flag_inconsistency") {
        if (flagsRaised >= maxFlags) {
          return JSON.stringify({
            ok: false,
            code: "SWEEP_LIMIT",
            problem:
              `You have raised ${flagsRaised} flag(s) this sweep, the limit. ` +
              `Name any others in your finish_sweep note.`,
          });
        }
        const res = await flagInconsistency({
          sweepId: input.sweepId,
          kind: String(toolInput.kind ?? ""),
          primaryClaimId: String(toolInput.primary_claim_id ?? ""),
          claimIds: toolInput.claim_ids,
          rationale: String(toolInput.rationale ?? ""),
          urgency: Number(toolInput.urgency ?? 5),
          maxValue,
        });
        if (res.ok && res.duplicate) repeats++;
        else if (res.ok) flagsRaised++;
        return JSON.stringify(res);
      }
      // Handled as an ordinary tool, not a loop-ending final tool: a model
      // that calls flag_inconsistency and finish_sweep in one turn would
      // otherwise lose the flag, since a final tool ends the loop before its
      // siblings execute.
      if (name === "finish_sweep") {
        note = String(toolInput.note ?? "").trim();
        closed = true;
        return JSON.stringify({ ok: true, note: "Sweep closed. End your turn now; call no more tools." });
      }
      if (name === "dismiss_candidate") {
        const res = await dismissCandidate({
          sweepId: input.sweepId,
          kind: String(toolInput.kind ?? ""),
          claimIds: toolInput.claim_ids,
          reason: String(toolInput.reason ?? ""),
        });
        if (res.ok) dismissed++;
        return JSON.stringify(res);
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
  });

  if (!note) note = (result.content ?? "").trim();
  return {
    note: note.slice(0, CONSISTENCY_BOUNDS.noteChars),
    flagsRaised,
    repeats,
    dismissed,
    runId,
  };
}
