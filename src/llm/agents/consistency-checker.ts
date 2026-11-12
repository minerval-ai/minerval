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
 * load_skill, and its writes:
 *
 *  - flag_inconsistency: the tension goes to the primary node's inbox (a
 *    claim, a quantity or a question, #735), and the pass it asks for goes
 *    to the General mandate's officers with the checker's estimate that it
 *    would change something;
 *  - commission and petition_mandate: a pass it judges worth paying for
 *    now, from its own budget, and more budget when the sweep needs it;
 *  - escalate_to_curator: a structural defect (two nodes that are one, a
 *    conflation, a wrong kind, a mislabeled edge) goes to the Curator as a
 *    curation request, rather than through a Steward pass bought only to
 *    forward it (#742);
 *  - note_finding: a pattern across many claims, beyond the flags it
 *    warrants (Part VIII);
 *  - finish_sweep: the note that closes the sweep and briefs the next
 *    sweep of the same partition.
 *
 * What it cannot do is the point: it writes no assessment, edge or
 * importance. What it raises, others decide whether to pay for, unless it
 * pays from its own budget; its flags are recorded so operators can read
 * what they bought (consistency-service.ts).
 */
import { RUN_TURN_GUARD, turnBudgetLine } from "../prompts/turn-budget.js";
import { getSpendToolDefinitions, executeSpendTool } from "../tools/spend-tools.js";
import { executeSessionTool, getSessionToolDefinitions, openSession, type AgentSession, type SessionResume } from "../tools/session-tools.js";
import { getSqlToolDefinition, executeSqlTool } from "../tools/sql-tools.js";
import type Anthropic from "@anthropic-ai/sdk";
type Tool = Anthropic.Tool;
import { toolUseLoop } from "../client.js";
import { loadConfig } from "../../config.js";
import { getUsageContext, withAgent } from "../usage-context.js";
import { createReportTools } from "../tools/report-tools.js";
import { createFindingTools } from "../tools/finding-tools.js";
import { createSkillLoadTools } from "../tools/skill-load-tools.js";
import { requestCuration, CURATION_CONCERN_MAX_CHARS } from "../../services/curation-service.js";
import { getConsistencyCheckerSystemPromptBlocks } from "../prompts/consistency-checker.js";
import {
  executeGraphReadTool,
  getGraphReadToolDefinitions,
} from "../tools/graph-read-tools.js";
import {
  checkFlagInput,
  compareAssessments,
  CONSISTENCY_BOUNDS,
  CONSISTENCY_FLAG_KINDS,
  figureAndAnswerChecks,
  flagInconsistency,
  openFlagsInScope,
  OPEN_FLAG_RATIONALE_CHARS,
  partitionClaims,
  TRACE_EXCERPT_CHARS,
  type OpenFlag,
  type PartitionScope,
} from "../../services/consistency-service.js";

/** A flag as the agent proposed it (recorded in a dry run instead of written). */
export interface ProposedFlag {
  kind: string;
  primary_claim_id: string;
  claim_ids: string[];
  rationale: string;
  expected_gain: number;
}

export interface ConsistencyCheckerResult {
  note: string;
  flagsRaised: number;
  repeats: number;
  /** Structural concerns sent to the Curator (none in a dry run). */
  escalations: number;
  /** Every flag the agent asked for, written or (in a dry run) not. */
  proposed: ProposedFlag[];
  /** agent_runs.id when tracing is on. */
  runId: string | null;
}

/** A runaway guard: the sweep's budget is what bounds it. */
const MAX_ITERATIONS = RUN_TURN_GUARD;
/** Claims per list_partition_claims page. */
const PAGE = 15;

export function runConsistencyChecker(
  input: Parameters<typeof runConsistencyCheckerImpl>[0],
  /** A paused session to continue (engine-executor.ts, runResumeAction). */
  resume?: SessionResume
): ReturnType<typeof runConsistencyCheckerImpl> {
  // The run belongs to a session (session-service.ts): what it asks for and
  // waits on comes back into it, and it pauses at the end when answers are
  // outstanding, keeping its input to be rebuilt when it resumes.
  return withAgent("consistency_checker", () => {
    const sess = openSession("consistency_checker", null, input, resume);
    return sess.run(async () => {
      const result = await runConsistencyCheckerImpl(input, sess);
      await sess.close(input.model ?? "");
      return result;
    });
  });
}

async function runConsistencyCheckerImpl(input: {
  /** Null in a dry run. */
  sweepId: string | null;
  /** Human label of the partition, e.g. a tag slug or "residual". */
  partitionLabel: string;
  scope: PartitionScope;
  /** Assessed nodes in scope (claims, quantities and questions). */
  claimsInScope: number;
  /** The partition's last completed sweep, if any. */
  lastSweep: { started_at: Date; note: string | null } | null;
  model?: string;
  /**
   * How the sweep's budget was priced (the partition's size, #756), stated
   * beside the budget line so the checker knows why it has what it has.
   * Absent for a run without a priced budget (an eval, a one-off call).
   */
  budgetBasis?: string;
  /**
   * Read and judge, write nothing: flag_inconsistency records the proposal
   * and returns without touching the ledger or the Steward queue. The eval
   * harness uses this as a coherence measure of a graph (how much would a
   * fresh sweep flag?) that leaves the graph as it found it.
   */
  dryRun?: boolean;
}, sess: AgentSession): Promise<ConsistencyCheckerResult> {
  const config = loadConfig();
  const model = input.model ?? config.consistencyModel;
  const system = getConsistencyCheckerSystemPromptBlocks();
  const reportTools = createReportTools({ model });
  // ...and the finding channel (#394): a pattern across many claims is a
  // finding, and a sweep is where one is seen (#742).
  const findingTools = createFindingTools({ model });
  // Skills load on demand: their "Standards for judging" say what a
  // coherent assessment looks like in their domain. A partition has no
  // single claim's domains, so nothing is pointed to.
  const skillLoader = createSkillLoadTools("consistency-checker");
  const runId = getUsageContext().runId ?? null;
  const since = input.lastSweep?.started_at ?? null;
  const openFlags: OpenFlag[] = input.dryRun ? [] : await openFlagsInScope(input.scope);

  const kinds = [...CONSISTENCY_FLAG_KINDS];
  const { listingTextChars, listingSummaryChars, rationaleChars, noteChars } = CONSISTENCY_BOUNDS;
  const tools: Tool[] = [
    ...reportTools.definitions,
    ...findingTools.definitions,
    ...skillLoader.definitions,
    ...getGraphReadToolDefinitions(),
    ...getSpendToolDefinitions(),
    ...getSessionToolDefinitions(),
    getSqlToolDefinition(),
    {
      name: "list_partition_claims",
      description:
        `This sweep's nodes, ${PAGE} per page: every claim with a verdict, ` +
        `quantity with an estimate and question with a standing in the ` +
        `partition, those re-assessed since your last sweep of it first ` +
        `(changed: true), then by importance. Each carries its kind; a claim ` +
        `its verdict and credence, a quantity its estimate, a question its ` +
        `standing (as status) and favored answers; the summary; how many ` +
        `subclaims and dependents it has (and how many subclaims are recorded ` +
        `against it, or required by it); whether a consistency flag on it is ` +
        `still open; and whether its Steward is already queued ` +
        `(steward_pending: a pass is coming anyway; a flag on it adds your ` +
        `reading to that pass, and it is still context for its neighbors). ` +
        `Text is listed to its first ${listingTextChars} characters and the ` +
        `summary to its first ${listingSummaryChars} (text_truncated, ` +
        `summary_truncated say when); get_claim reads them whole. ` +
        `Paginate with offset.`,
      input_schema: {
        type: "object" as const,
        properties: { offset: { type: "number" } },
        required: [],
      },
    },
    {
      name: "list_figure_and_answer_checks",
      description:
        "Where figures and answers in this partition may disagree (§7a, §21): claims about which " +
        "side of a figure a quantity lies whose credence sits well away from the probability the " +
        "quantity's estimate implies, and questions whose standing or favored answer does not " +
        "agree with their answers' assessments. Candidates to read, not findings: compare the " +
        "pages before you flag (numeric_mismatch, answer_mismatch).",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "compare_assessments",
      description:
        `Up to ${CONSISTENCY_BOUNDS.maxClaims} nodes side by side: kind, text, ` +
        `importance, a claim's status, credence and confidence, a quantity's ` +
        `estimate, a question's standing and favored answers, when and by which ` +
        `model each was judged, the summary, the first ${TRACE_EXCERPT_CHARS} ` +
        `characters of the reasoning trace (a quantity's work), with ` +
        `trace_chars and trace_truncated saying how much was not shown ` +
        `(get_claim reads the rest), and every edge or link among them with its ` +
        `reasoning. The nodes need not be in this partition.`,
      input_schema: {
        type: "object" as const,
        properties: { claim_ids: { type: "array", items: { type: "string" } } },
        required: ["claim_ids"],
      },
    },
    {
      name: "flag_inconsistency",
      description:
        "Raise a tension you judged real, or a consideration established elsewhere " +
        "that the primary's assessment does not weigh. The primary may be anywhere in " +
        "the graph, in this partition or not. Its Steward is asked to " +
        "reconcile it: the flag goes to its inbox, and the reassessment it asks " +
        "for is put, with your expected_gain, to whoever funds such passes, who " +
        "decides whether to pay for it. If it matters enough to pay for now, commission " +
        "the pass yourself from your budget. The primary is " +
        "the node whose judgment looks wrong: a claim's verdict, a quantity's " +
        "estimate or a question's standing. A primary whose earlier flag is " +
        "still waiting is a repeat: your reading is added to the waiting pass " +
        "(raise one only for a different tension). Each flag asks for a funded " +
        "pass, so flag what is material.",
      input_schema: {
        type: "object" as const,
        properties: {
          kind: { type: "string", enum: kinds },
          primary_claim_id: { type: "string" },
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: `Every node in the tension, the primary included (at most ${CONSISTENCY_BOUNDS.maxClaims}).`,
          },
          rationale: {
            type: "string",
            description:
              "For the Steward: what each assessment says, where exactly they " +
              `conflict or what was overlooked, citing claim ids. At most ` +
              `${rationaleChars} characters; a longer one is refused, not cut.`,
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
      name: "escalate_to_curator",
      description:
        "Send a structural defect to the Curator: two nodes that are one " +
        "(a duplicate, or a claim and its negation held apart), a node that " +
        "conflates distinct propositions, a node of the wrong kind, or an " +
        "edge between claims that looks mislabeled. Individuation, kinds and " +
        "the connective tissue between claims are the Curator's, not a " +
        "Steward's, so this is the route for them rather than a flag. It is " +
        "recorded as a curation request: curation is funded work, and one " +
        "Curator run reads every concern waiting on the claim. Name the other " +
        "node when there is one. A verdict that does not fit its neighbors is " +
        "a flag, not this.",
      input_schema: {
        type: "object" as const,
        properties: {
          claim_id: { type: "string", description: "The node with the structural defect." },
          other_claim_id: {
            type: "string",
            description: "The suspected duplicate, counterpart, or other end of the edge, when there is one.",
          },
          concern: {
            type: "string",
            description:
              `What you saw and why it is structural, citing ids. At most ` +
              `${CURATION_CONCERN_MAX_CHARS} characters; a longer one is refused.`,
          },
        },
        required: ["claim_id", "concern"],
      },
    },
    {
      name: "finish_sweep",
      description:
        "Close the sweep with your note on this partition: what you read and " +
        "found sound, what you flagged, what deserves a look next time. The " +
        "next sweep of this partition is briefed with it. At most " +
        `${noteChars} characters (the next briefing carries it whole); a ` +
        "longer note is refused and the sweep stays open for a shorter one. " +
        "Call it last, alone, then end your turn.",
      input_schema: {
        type: "object" as const,
        properties: { note: { type: "string" } },
        required: ["note"],
      },
    },
  ];

  const openFlagLines = openFlags.map(
    (f) =>
      `- ${f.primary_claim_id} (${f.kind}, flagged ${f.created_at.slice(0, 10)}` +
      `${f.repeats > 0 ? `, ${f.repeats} repeat(s)` : ""}): ${f.rationale}` +
      `${f.rationale.length >= OPEN_FLAG_RATIONALE_CHARS ? "..." : ""}`
  );
  const briefing =
    `## Consistency sweep\n\n` +
    `Partition: ${input.partitionLabel}, ${input.claimsInScope} assessed node(s).\n\n` +
    (input.lastSweep
      ? `Your last sweep of it was on ${input.lastSweep.started_at.toISOString().slice(0, 10)}. ` +
        `Your note from it:\n\n${input.lastSweep.note?.trim() || "(none)"}\n\n`
      : `This partition has never been swept.\n\n`) +
    (openFlags.length > 0
      ? `Flags in this partition still waiting for their pass (the start of each ` +
        `rationale, at most ${OPEN_FLAG_RATIONALE_CHARS} characters):\n` +
        `${openFlagLines.join("\n")}\n\n`
      : input.dryRun
        ? ""
        : `No flag in this partition is still waiting for its pass.\n\n`) +
    `${turnBudgetLine(MAX_ITERATIONS, { canSpend: true })}\n\n` +
    (input.budgetBasis ? `${input.budgetBasis}\n\n` : "") +
    `Read the partition, compare what needs comparing, and flag what does not ` +
    `fit together, here or wherever in the graph what this partition ` +
    `establishes bears; then finish with your note. Nobody is watching this ` +
    `run; act with the judgment of a careful person paid to find real ` +
    `defects and to leave sound work alone.`;

  let flagsRaised = 0;
  let repeats = 0;
  let escalations = 0;
  const proposed: ProposedFlag[] = [];
  let note = "";
  let closed = false;

  const result = await toolUseLoop({
    initialMessages: sess.initialMessages([{ role: "user", content: briefing }]),
    ...sess.loop,
    tools,
    system,
    model,
    // The cheap tier reasons at length before it writes (the reasoning is
    // billed output), and a partition's comparison reads are long: at 4096 a
    // real sweep was cut off twice mid-thought and ended with nothing
    // recorded. The Steward's and Curator's limit.
    maxTokens: 16384,
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
      const finding = await findingTools.execute(name, toolInput);
      if (finding !== null) return finding;
      const loaded = await skillLoader.execute(name, toolInput);
      if (loaded !== null) return loaded;
      const graphRead = await executeGraphReadTool(name, toolInput);
      if (graphRead !== null) return graphRead;
      const sessionOut = await executeSessionTool(name, toolInput);
      if (sessionOut !== null) return sessionOut;
      const spend = await executeSpendTool(name, toolInput);
      if (spend !== null) return spend;
      const sql = await executeSqlTool(name, toolInput);
      if (sql !== null) return sql;

      if (name === "list_partition_claims") {
        const offset = Math.max(0, Math.floor(Number(toolInput.offset ?? 0)) || 0);
        const page = await partitionClaims(input.scope, { since, limit: PAGE, offset });
        return JSON.stringify({
          total: page.total,
          offset,
          claims: page.claims.map((c) => ({
            ...c,
            text: c.text.slice(0, listingTextChars),
            summary: c.summary ? c.summary.slice(0, listingSummaryChars) : null,
            ...(c.text.length > listingTextChars ? { text_truncated: true } : {}),
            ...((c.summary?.length ?? 0) > listingSummaryChars ? { summary_truncated: true } : {}),
          })),
          ...(offset + PAGE < page.total ? { next_offset: offset + PAGE } : {}),
        });
      }
      if (name === "compare_assessments") {
        return JSON.stringify(await compareAssessments(toolInput.claim_ids));
      }
      if (name === "list_figure_and_answer_checks") {
        return JSON.stringify(await figureAndAnswerChecks(input.scope));
      }
      if (name === "flag_inconsistency") {
        const proposal: ProposedFlag = {
          kind: String(toolInput.kind ?? ""),
          primary_claim_id: String(toolInput.primary_claim_id ?? ""),
          claim_ids: Array.isArray(toolInput.claim_ids) ? toolInput.claim_ids.map(String) : [],
          rationale: String(toolInput.rationale ?? ""),
          expected_gain: Number(toolInput.expected_gain ?? 0.5),
        };
        if (input.dryRun) {
          // Held to what a live flag would accept, and folded by primary
          // as a live flag is, so a dry run counts what a sweep could
          // actually have raised.
          const checked = await checkFlagInput({
            kind: proposal.kind,
            primaryClaimId: proposal.primary_claim_id,
            claimIds: proposal.claim_ids,
            rationale: proposal.rationale,
          });
          if (!checked.ok) return JSON.stringify(checked);
          if (proposed.some((p) => p.primary_claim_id === proposal.primary_claim_id)) {
            repeats++;
            return JSON.stringify({ ok: true, duplicate: true, note: "Already flagged this sweep." });
          }
          proposed.push({ ...proposal, claim_ids: checked.claimIds });
          flagsRaised++;
          return JSON.stringify({ ok: true, duplicate: false, note: "Recorded." });
        }
        proposed.push(proposal);
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
      if (name === "escalate_to_curator") {
        const claimId = String(toolInput.claim_id ?? "").trim();
        const concern = String(toolInput.concern ?? "");
        const otherClaimId =
          typeof toolInput.other_claim_id === "string" && toolInput.other_claim_id.trim()
            ? toolInput.other_claim_id.trim()
            : null;
        // A dry run writes nothing, so it records the concern only as a
        // count: the eval reads flags, and a request would open a curate row.
        if (input.dryRun) {
          if (!claimId || !concern.trim()) {
            return JSON.stringify({ ok: false, problem: "claim_id and concern are required." });
          }
          escalations++;
          return JSON.stringify({ ok: true, note: "Recorded (dry run: nothing sent)." });
        }
        const requested = await requestCuration({
          anchorClaimId: claimId,
          otherClaimId,
          source: "consistency_sweep",
          concern,
          requestedByRunId: runId,
        });
        if (!requested.ok) return JSON.stringify({ ok: false, problem: requested.problem });
        if (!requested.repeat) escalations++;
        return JSON.stringify({
          ok: true,
          note: requested.repeat
            ? `That concern about ${claimId} is already waiting for the Curator.`
            : `Recorded for the Curator; it runs when curation of ${claimId} is funded.`,
        });
      }
      // Handled as an ordinary tool, not a loop-ending final tool: a model
      // that calls flag_inconsistency and finish_sweep in one turn would
      // otherwise lose the flag, since a final tool ends the loop before its
      // siblings execute.
      if (name === "finish_sweep") {
        const text = String(toolInput.note ?? "").trim();
        // Refused, not cut: the note's tail is "what deserves a look next
        // time", the part a cut would lose.
        if (text.length > noteChars) {
          return JSON.stringify({
            ok: false,
            problem:
              `The note is ${text.length} characters; it may be at most ${noteChars}. ` +
              `The sweep is still open: call finish_sweep again with a shorter note.`,
          });
        }
        note = text;
        closed = true;
        return JSON.stringify({ ok: true, note: "Sweep closed. End your turn now; call no more tools." });
      }
      return JSON.stringify({ error: `unknown tool ${name}` });
    },
  });

  // A run that never called finish_sweep leaves its closing text as the
  // note; that text was not written as a note, so it is held to the bound
  // here (the agent's own note never reaches this slice).
  if (!note) note = (result.content ?? "").trim();
  return {
    note: note.slice(0, noteChars),
    flagsRaised,
    repeats,
    escalations,
    proposed,
    runId,
  };
}
