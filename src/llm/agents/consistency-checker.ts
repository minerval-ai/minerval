/**
 * The Consistency Checker run: one sweep over one partition of the graph
 * (#330; docs/allocation.md, "Consistency sweeps").
 *
 * Each Steward reads its own claim, its subclaims and its evidence; nobody
 * reads the neighbors' reasoning against each other. This agent does: it
 * reads a partition's assessments side by side and looks for reasoning in
 * one that conflicts with another's, evidence recorded under one claim
 * that another's assessment never weighed, verdicts that are not a
 * defensible function of what they rest on. Its affordances are the graph
 * reads (search reaches beyond the partition, which is how overlooked
 * evidence is found), the partition listing, a side-by-side comparison,
 * and two writes:
 *
 *  - flag_inconsistency: the primary claim becomes a candidate on the
 *    ledger (its Steward enqueued with the tension as context), and the
 *    checker's estimate that a pass would change something enters the
 *    formula's expected-gain term for it;
 *  - finish_sweep: the note that closes the sweep and briefs the next
 *    sweep of the same partition.
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
import {
  compareAssessments,
  CONSISTENCY_BOUNDS,
  CONSISTENCY_FLAG_KINDS,
  flagInconsistency,
  partitionClaims,
  type PartitionScope,
} from "../../services/consistency-service.js";

export interface ConsistencyCheckerResult {
  note: string;
  flagsRaised: number;
  repeats: number;
  /** agent_runs.id when tracing is on. */
  runId: string | null;
}

/** Tool calls per sweep: a careful read of one partition. */
const MAX_ITERATIONS = 30;
/** Claims per list_partition_claims page. */
const PAGE = 15;

export function runConsistencyChecker(
  input: Parameters<typeof runConsistencyCheckerImpl>[0]
): ReturnType<typeof runConsistencyCheckerImpl> {
  return withAgent("consistency_checker", () => runConsistencyCheckerImpl(input));
}

async function runConsistencyCheckerImpl(input: {
  sweepId: string;
  /** Human label of the partition, e.g. a tag slug or "residual". */
  partitionLabel: string;
  scope: PartitionScope;
  /** Assessed claims in scope. */
  claimsInScope: number;
  /** The partition's last completed sweep, if any. */
  lastSweep: { started_at: Date; note: string | null } | null;
  maxFlags?: number;
  model?: string;
}): Promise<ConsistencyCheckerResult> {
  const config = loadConfig();
  const model = input.model ?? config.consistencyModel;
  const maxFlags = input.maxFlags ?? config.consistencyMaxFlagsPerSweep;
  const system = getConsistencyCheckerSystemPromptBlocks();
  const reportTools = createReportTools({ model });
  const runId = getUsageContext().runId ?? null;
  const since = input.lastSweep?.started_at ?? null;

  const kinds = [...CONSISTENCY_FLAG_KINDS];
  const tools: Tool[] = [
    ...reportTools.definitions,
    ...getGraphReadToolDefinitions(),
    {
      name: "list_partition_claims",
      description:
        `This sweep's claims, ${PAGE} per page: every assessed claim in the ` +
        `partition, those re-assessed since your last sweep of it first ` +
        `(changed: true), then by importance. Each carries its verdict, ` +
        `credence, summary, how many subclaims and dependents it has, and ` +
        `whether a consistency flag on it is still open. Paginate with offset.`,
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
        `a coherence judgment needs; the claims need not be in this partition.`,
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
        "ledger, valued by the platform's formula (importance, contestation) " +
        "with your expected_gain; the allocator decides whether it runs. " +
        "The primary is the claim whose " +
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
              "For the Steward: what each assessment says, where exactly they " +
              "conflict or what was overlooked, citing claim ids.",
          },
          expected_gain: {
            type: "number",
            description:
              "0–1: how likely a fresh pass by the primary's Steward is to " +
              "change its verdict or reasoning materially, given what you read. " +
              "Calibrate: 0.8 for a plain overlooked defeater, 0.3 for a tension " +
              "the Steward may well defend. Importance is weighed separately.",
          },
        },
        required: ["kind", "primary_claim_id", "claim_ids", "rationale", "expected_gain"],
      },
    },
    {
      name: "finish_sweep",
      description:
        "Close the sweep with your note on this partition: what you read and " +
        "found sound, what you flagged, what deserves a look next time. The " +
        "next sweep of this partition is briefed with it. Call it last, alone, " +
        "then end your turn.",
      input_schema: {
        type: "object" as const,
        properties: { note: { type: "string" } },
        required: ["note"],
      },
    },
  ];

  const briefing =
    `## Consistency sweep\n\n` +
    `Partition: ${input.partitionLabel}, ${input.claimsInScope} assessed claim(s).\n\n` +
    (input.lastSweep
      ? `Your last sweep of it was on ${input.lastSweep.started_at.toISOString().slice(0, 10)}. ` +
        `Your note from it:\n\n${input.lastSweep.note?.trim() || "(none)"}\n\n`
      : `This partition has never been swept.\n\n`) +
    `Your bounds: at most ${maxFlags} new flag(s); about ${MAX_ITERATIONS} tool turns.\n\n` +
    `Read the partition, compare what needs comparing, flag what does not ` +
    `cohere, and finish with your note. Nobody is watching this run; act ` +
    `with the judgment of a careful person paid to find real defects and to ` +
    `leave sound work alone.`;

  let flagsRaised = 0;
  let repeats = 0;
  let note = "";
  let closed = false;

  const result = await toolUseLoop({
    initialMessages: [{ role: "user", content: briefing }],
    tools,
    system,
    model,
    maxTokens: 4096,
    maxIterations: MAX_ITERATIONS,
    iterationBudgetNotice: {
      warnWithin: 3,
      message: (remaining) =>
        `You have ${remaining} tool turn${remaining === 1 ? "" : "s"} left. ` +
        `Flag what you are sure of and call finish_sweep.`,
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

      if (name === "list_partition_claims") {
        const offset = Math.max(0, Math.floor(Number(toolInput.offset ?? 0)) || 0);
        const page = await partitionClaims(input.scope, { since, limit: PAGE, offset });
        return JSON.stringify({
          total: page.total,
          offset,
          claims: page.claims.map((c) => ({
            ...c,
            text: c.text.slice(0, 300),
            summary: c.summary ? c.summary.slice(0, 500) : null,
          })),
          ...(offset + PAGE < page.total ? { next_offset: offset + PAGE } : {}),
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
          expectedGain: Number(toolInput.expected_gain ?? 0.5),
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
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
  });

  if (!note) note = (result.content ?? "").trim();
  return {
    note: note.slice(0, CONSISTENCY_BOUNDS.noteChars),
    flagsRaised,
    repeats,
    runId,
  };
}
