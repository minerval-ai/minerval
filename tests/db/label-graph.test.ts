/**
 * The graph's own content carries a label (src/labels.ts).
 *
 * Against real Postgres and the real write seams, three things:
 *
 *  - A row of the graph's content (a node, an edge, a link, an argument and
 *    its premises, passages and attached URLs, a tag and a tagging, a
 *    quantity's definition, readings and cuts, an answer relation, what a
 *    judgment rested on, a formal statement, a Lean check, a proof attempt,
 *    the Curator's record of its surgery) carries the label of the run that
 *    writes it, and is public when written outside any run. A write that
 *    lands on a row already there leaves that row's label alone. A node a
 *    worker mints (from a submitted document, from an accepted proposal)
 *    carries the label that document or proposal was submitted at.
 *  - Work that starts from a claim itself, with no row of its own to wait
 *    in, runs at the claim's label: the reconcile sweep, the Steward's
 *    fallback lane, the Tagger, a mandate's standing order placed by the
 *    scheduler, the reconcile-candidate scan, and a URL waiting in an
 *    argument's evidence backlog.
 *  - None of it reaches a reader: no view query_sql reads, no API response
 *    and no agent's graph read carries the column.
 *
 * No model is called. The Steward's and the Tagger's entry points are
 * replaced by a stand-in that opens a real run (withAgent) and does what the
 * test asks of it, the Extractor returns what the test hands it, and the
 * Matcher finds every wording new; everything around them is the code that
 * runs in production.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

interface Seen {
  agent: string;
  label: string;
  runId: string;
  input: unknown;
}

const stage = vi.hoisted(() => {
  // Tracing is off under vitest by default; the run row is part of what is checked.
  process.env.TRACE_LEVEL = "full";
  const stage = {
    seen: [] as Seen[],
    /** What the next stand-in run does while it is open. */
    during: null as null | ((seen: Seen) => Promise<void>),
    /** What the Tagger stand-in decides. */
    decision: { submitted: true, reasoning: "", tags: [] } as Record<string, unknown>,
    /** What the Extractor stand-in returns. */
    extracted: [] as Array<Record<string, unknown>>,
    /** An agent run in place of the model: a real run row, then `during`. */
    async standIn(agent: string, input: unknown): Promise<void> {
      const { withAgent, getUsageContext, currentLabel } = await import("../../src/llm/usage-context.js");
      await withAgent(agent, async () => {
        const trace = getUsageContext().trace!;
        await trace.ready;
        const seen: Seen = { agent, label: currentLabel(), runId: trace.runId, input };
        stage.seen.push(seen);
        const during = stage.during;
        stage.during = null;
        await during?.(seen);
      });
    },
  };
  return stage;
});

vi.mock("../../src/llm/agents/claim-steward.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/claim-steward.js")>()),
  runClaimSteward: vi.fn((input: unknown) => stage.standIn("steward", input)),
}));
vi.mock("../../src/llm/agents/tagger.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/tagger.js")>()),
  tagClaim: vi.fn(async (input: unknown) => {
    await stage.standIn("tagger", input);
    return stage.decision;
  }),
}));
vi.mock("../../src/llm/agents/extractor.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/extractor.js")>()),
  extractClaims: vi.fn(async () => stage.extracted),
}));
// The Matcher finds every wording new, so each one mints a node.
vi.mock("../../src/llm/agents/matcher.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/matcher.js")>()),
  matchClaim: vi.fn(async () => ({
    outcome: "new", is_match: false, matched_claim_id: null, new_canonical_form: null, instance_stance: "affirms",
  })),
}));
vi.mock("../../src/llm/agents/domain-prior.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/domain-prior.js")>()),
  inferDomainPrior: vi.fn(async () => []),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));
vi.mock("../../src/services/source-facts-service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/source-facts-service.js")>()),
  refreshSourceFactsOnce: vi.fn(async () => {}),
}));

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { currentLabel, runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { executeKindTool } from "../../src/llm/tools/kind-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { ASSESS_GROUP, CURATE_GROUP, materializePlanItems, reconcileActions } from "../../src/services/action-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { attachArgumentEvidence, sendArgumentEvidenceBacklog } from "../../src/services/argument-evidence-service.js";
import { insertArgumentInstance, insertUnplacedPassage } from "../../src/services/argument-instance-service.js";
import { addArgument } from "../../src/services/argument-service.js";
import { openAttempt, recordAttemptLeanCheck, type FormalizationRow } from "../../src/services/attempt-service.js";
import { linkClaims } from "../../src/services/claim-link-service.js";
import { proposeClaim } from "../../src/services/claim-service.js";
import { ARGUMENT_VIEW_INCLUDES } from "../../src/services/argument-view-service.js";
import { CLAIM_VIEW_INCLUDES, getClaimView } from "../../src/services/claim-view-service.js";
import { createClaimProposal, materializeAcceptedIntake } from "../../src/services/intake-service.js";
import { scanReconcileCandidates } from "../../src/services/curation-service.js";
import {
  nextFormalizationVersion,
  normalizeStatementSource,
  recordLeanCheck,
  storeElaboratedFormalization,
} from "../../src/services/formalization-service.js";
import { runAtClaimLabel } from "../../src/services/label-service.js";
import { FakeLeanCheckerClient } from "../../src/services/lean-checker-fake.js";
import { addReading, defineQuantity, recordCut, recordEstimate } from "../../src/services/quantity-service.js";
import {
  addAnswer,
  addSubquestion,
  markQuestion,
  recordQuestionAssessment,
  setAnswerRelation,
} from "../../src/services/question-service.js";
import { getLocalQueue } from "../../src/services/queue-service.js";
import {
  addRelationshipEdge,
  createClaim,
  mergeArguments,
  setQuantityDefinition,
  splitArgument,
} from "../../src/services/reconciliation-service.js";
import { attachEdgeToArgument, insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { tellStewardsOfSourceEvents } from "../../src/services/source-notice-service.js";
import { getOrCreateSource, submitSource } from "../../src/services/source-service.js";
import { placeStandingOrder } from "../../src/services/standing-order-service.js";
import { setSubjectTags } from "../../src/services/tag-service.js";
import { processNextStewardTask } from "../../src/workers/steward-pipeline.js";
import { processNextTaggingTask } from "../../src/workers/tagging-pipeline.js";
import { handleUrlExtraction } from "../../src/workers/url-extraction.js";
import { OWL, seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const INTERNAL = "internal";
const FOREIGN_KEY_VIOLATION = "23503";

/** The tables this file is about: the graph's content other than judgments and sources. */
const CONTENT_TABLES = [
  "answer_relations", "argument_evidence_backlog", "argument_instances", "argument_subclaims", "arguments",
  "claim_formalizations", "claim_links", "claim_relationships", "claims", "judgment_inputs", "lean_checks",
  "proof_attempts", "quantity_cuts", "quantity_definitions", "quantity_readings", "reconciliation_events",
  "taggings", "tags",
];

const DEFINITION = { measures: "Rows written", population: "This test", unit: { kind: "count", noun: "rows", min: 0 } };

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Work done from inside a run at `label`, as an agent's tool call does it. */
function inRunAt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runWithUsageContext({ label }, () => withAgent("steward", fn));
}

/** The labels on the rows of `table` that match, without repeats. */
async function labelsWhere(table: string, where: string, params: unknown[]): Promise<string[]> {
  const rows = await rawQuery<{ sensitivity_label: string }>(
    `SELECT DISTINCT sensitivity_label FROM ${table} WHERE ${where}`,
    params
  );
  // Sorted here: the database orders text by its locale, which differs between machines.
  return rows.map((r) => r.sensitivity_label).sort();
}
const labelOf = async (table: string, id: string) => (await labelsWhere(table, "id = $1", [id]))[0];

/** The labels on a claim's assess rows. */
const assessLabels = (claimId: string) => labelsWhere("actions", "exclusion_group = $1", [ASSESS_GROUP(claimId)]);

async function setLabel(claimId: string, label: string): Promise<void> {
  await rawQuery(`UPDATE claims SET sensitivity_label = $2 WHERE id = $1`, [claimId, label]);
}

/** A claim as it stands after its pass: not pending, so no sweep in this file picks it up. */
async function settledClaim(label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
  return id;
}

/** Drop what a write queued for the claim pipeline, and say what label it carried. */
function takePipelineLabel(claimId: string): string | undefined {
  const queue = getLocalQueue("claimPipeline");
  const at = queue.findIndex((m) => m.claimId === claimId);
  return at < 0 ? undefined : queue.splice(at, 1)[0]!.label;
}

async function instanceOn(claimId: string, sourceId: string): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'a passage')`,
    [claimId, sourceId]
  );
}

const fake = new FakeLeanCheckerClient();

/**
 * One row in every content table, each through the seam the agents and the
 * routes write it with. Returns, for each table, where its rows are.
 */
async function writeOneOfEach(): Promise<Record<string, { where: string; params: unknown[] }>> {
  const tag = randomUUID().slice(0, 8);
  const source = await getOrCreateSource({ url: `https://dbtest.example/graph/${randomUUID()}`, title: "A document" });

  // A node, proposed the way the service route proposes one.
  const { claim } = await proposeClaim({ claim: `The grid is fragile (${tag}).`, createdBy: "service" });
  const pipelineLabel = takePipelineLabel(claim.id);
  expect(pipelineLabel).toBe(currentLabel());

  // An argument, a subclaim the Steward mints under it (a quantity, so its
  // definition is written too), and a parent minted from below.
  const argument = await addArgument({
    claimId: claim.id, stance: "for", name: `From the outage record ${tag}`, content: "It follows.", createdBy: "claim_steward",
  });
  const down = JSON.parse(
    await executeStewardTool("add_decomposition_edge", {
      parent_id: claim.id, child_text: `Outages per year (${tag})`, relation: "requires", reasoning: "The count bears on it.",
      argument_id: argument.id, kind: "quantity", definition: DEFINITION,
    })
  );
  expect(down, JSON.stringify(down)).toMatchObject({ success: true });
  const up = JSON.parse(
    await executeStewardTool("add_parent_claim", {
      claim_id: claim.id, parent_text: `Infrastructure is fragile (${tag}).`, relation: "requires", reasoning: "One case of it.",
    })
  );
  expect(up, JSON.stringify(up)).toMatchObject({ success: true });
  takePipelineLabel(down.child_claim_id);
  takePipelineLabel(up.parent_claim_id);

  // An edge between two nodes that exist, grouped under the argument, and a lateral link.
  const other = await settledClaim("graph neighbor");
  const edge = await insertRelationshipEdge({
    parentId: claim.id, childId: other, relationType: "supports", reasoning: "It bears on it.", createdBy: "claim_steward",
  });
  await attachEdgeToArgument(argument.id, edge.id);
  const link = await linkClaims({ claimId: claim.id, otherClaimId: other, kind: "related", reasoning: "Near it.", createdBy: "curator" });

  // A passage that makes the argument, one waiting to be placed, and a URL attached with no passage.
  const placed = await insertArgumentInstance({
    argumentId: argument.id, sourceId: source.id, verbatimText: "Because of the outages.", stance: "advances",
    reading: "full", statedShows: null, createdBy: "claim_steward",
  });
  const unplaced = await insertUnplacedPassage({
    claimId: claim.id, sourceId: source.id, verbatimText: "Some say otherwise.", context: null, stance: "criticizes", direction: "against",
  });
  await attachArgumentEvidence(argument.id, [`https://dbtest.example/graph/evidence/${tag}`]);

  // A tag minted for the node, and its tagging.
  await setSubjectTags({
    kind: "claim", subjectId: claim.id, source: "steward",
    assignments: [{ name: `Grid fragility ${tag}`, description: "What makes a grid fail.", confidence: 0.8 }],
  });

  // A quantity: its definition, a reading of it, and a claim that cuts it.
  const quantity = await settledClaim("graph quantity");
  await defineQuantity({ claimId: quantity, definition: DEFINITION, createdBy: "claim_steward" });
  const reading = await addReading({
    claimId: quantity, sourceId: source.id, measured: "Outages logged", figure: "12", bearing: "Direct.", createdBy: "claim_steward",
  });
  await recordCut({ claimId: claim.id, quantityId: quantity, direction: "above", value: 10, createdBy: "claim_steward" });

  // A question the Steward's kind tools build: a minted answer, a minted
  // subquestion, a second answer, and how the two answers stand.
  const question = await settledClaim("graph question");
  await markQuestion(question);
  const qctx = { role: "question_steward" as const, claimId: question };
  const answer = JSON.parse(
    (await executeKindTool("add_answer", { question_id: question, new_text: `Because of age (${tag})`, basis: "quality", reasoning: "r" }, qctx))!
  );
  expect(answer, JSON.stringify(answer)).toMatchObject({ success: true });
  const sub = JSON.parse(
    (await executeKindTool("add_subquestion", { question_id: question, new_text: `How old is it? (${tag})`, reasoning: "r" }, qctx))!
  );
  expect(sub, JSON.stringify(sub)).toMatchObject({ success: true });
  takePipelineLabel(answer.answer_id);
  takePipelineLabel(sub.subquestion_id);
  await addAnswer({ questionId: question, answerId: other, basis: "prominence", reasoning: "Often given.", createdBy: "question_steward" });
  const relation = await setAnswerRelation({
    questionId: question, answerA: answer.answer_id, answerB: other, relation: "compatible", createdBy: "question_steward",
  });

  // Each kind of judgment, on a node with a premise and a source, so what it rested on is recorded.
  await instanceOn(claim.id, source.id);
  const verdict = JSON.parse(
    await executeStewardTool("update_claim_assessment", {
      claim_id: claim.id, status: "supported", confidence: 0.7, assessment: "Judged for the graph labels test.", reasoning_trace: "dbtest",
    })
  );
  expect(verdict, JSON.stringify(verdict)).toMatchObject({ success: true });
  const [assessment] = await rawQuery<{ id: string }>(`SELECT id FROM assessments_in_force WHERE claim_id = $1`, [claim.id]);
  await instanceOn(quantity, source.id);
  const estimate = await recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" });
  const standing = await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "dbtest" });
  const judgments = [assessment!.id, estimate.id, standing.id];
  const [inputs] = await rawQuery<{ n: number }>(
    `SELECT count(DISTINCT judgment_id)::int AS n FROM judgment_inputs WHERE judgment_id = ANY($1::uuid[])`,
    [judgments]
  );
  expect(inputs!.n).toBe(3);

  // A formal statement, a check against it, an attempt on it and the attempt's own check.
  const version = await nextFormalizationVersion(claim.id);
  const normalized = normalizeStatementSource("def Statement : Prop := True", { claimId: claim.id, version });
  if (!normalized.ok) throw new Error(normalized.error);
  const statement = await storeElaboratedFormalization({
    claimId: claim.id, version, statementSource: normalized.source,
    elaboration: await fake.elaborate({ statement_source: normalized.source }),
    correspondence: "The statement is the claim.", authoredBy: "claim_steward", status: "reviewed",
  });
  const proof = `theorem ${statement.namespace}.proof : ${statement.namespace}.Statement := by exact proof_${randomUUID()}`;
  fake.script(proof, { verdict: "rejected", failed_gate: "axioms" });
  const queued = await fake.submitCheck({
    mode: "steward", kind: "proof", statement_source: statement.statement_source, submission_source: proof, force: true,
  });
  const check = await recordLeanCheck({
    formalizationId: statement.id, record: await fake.getCheck(queued.check_id), submissionSource: proof, submittedBy: "claim_steward",
  });
  await rawQuery(`UPDATE claim_formalizations SET status = 'published', published_at = now() WHERE id = $1`, [statement.id]);
  const action = await seedAction({
    group: `attempt:${statement.id}:1`, variant: "max", kind: "attempt_proof", costMicroUsd: 150 * OWL, status: "running", claimId: claim.id,
  });
  const opened = await openAttempt({
    action: { id: action, variant: "max", cost_est_micro_usd: 150 * OWL },
    claimId: claim.id,
    formalization: { ...statement, status: "published" } as FormalizationRow,
  });
  if (!opened.ok) throw new Error(`${opened.code}: ${opened.message}`);
  const attemptCheck = await recordAttemptLeanCheck({
    attemptId: opened.attempt.id, formalizationId: statement.id, kind: "proof", submissionSha256: `sha-${randomUUID()}`,
    submissionSource: "theorem proof : Statement := trivial", verdict: "accepted", checks: { compile: { status: "pass" } },
    diagnostics: [], truncated: false, resource: { wall_ms: 30_000 }, pinId: statement.pin_id, imageDigest: "sha256:img",
    checkerVersion: "1.0.0", costMicroUsd: 21_667,
  });
  // The attempt is closed, so a second pass over this function can open one of its own.
  await rawQuery(`UPDATE proof_attempts SET status = 'failed', finished_at = now() WHERE id = $1`, [opened.attempt.id]);

  // The Curator's surgery: a node split off, an edge added, a definition
  // completed, and an argument split and merged back, each with its record.
  const split = await createClaim({ text: `Outage counts are reliable (${tag}).`, kind: "quantity", definition: DEFINITION });
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [split.id]);
  const curatorEdge = await addRelationshipEdge({
    parentId: other, childId: split.id, relationType: "requires", reasoning: "The neighbor rests on it.",
  });
  const redefined = await setQuantityDefinition({ claimId: quantity, definition: DEFINITION, reasoning: "Completed." });
  const parts = await splitArgument({
    argumentId: argument.id,
    parts: [{ name: `The premise alone ${tag}`, writtenForm: "The premise, taken alone.", relationshipIds: [edge.id], instanceIds: [] }],
    reasoning: "Two inferences in one.",
  });
  const merged = await mergeArguments({
    survivorId: argument.id, absorbedId: parts.partIds[0]!, writtenFormFrom: "survivor", reasoning: "One inference after all.",
  });
  const events = [split.eventId, curatorEdge.eventId, redefined.eventId, parts.eventId, merged.eventId];
  expect(events.every(Boolean)).toBe(true);

  const minted = [claim.id, down.child_claim_id, up.parent_claim_id, answer.answer_id, sub.subquestion_id, split.id];
  return {
    claims: { where: "id = ANY($1::uuid[])", params: [minted] },
    claim_relationships: {
      where: `(parent_claim_id = $1 AND child_claim_id = ANY($2::uuid[]))
              OR (parent_claim_id = $3 AND child_claim_id = $1)
              OR (parent_claim_id = $4 AND child_claim_id = ANY($5::uuid[]))
              OR (parent_claim_id = $6 AND child_claim_id = $7)`,
      params: [claim.id, [down.child_claim_id, other], up.parent_claim_id, question, [answer.answer_id, sub.subquestion_id, other], other, split.id],
    },
    claim_links: { where: "id = $1", params: [link.id] },
    arguments: { where: "id = ANY($1::uuid[])", params: [[argument.id, ...parts.partIds]] },
    argument_subclaims: { where: "argument_id = $1", params: [argument.id] },
    argument_instances: { where: "id = ANY($1::uuid[])", params: [[placed, unplaced]] },
    argument_evidence_backlog: { where: "argument_id = $1", params: [argument.id] },
    tags: { where: "name = $1", params: [`Grid fragility ${tag}`] },
    taggings: { where: "subject_kind = 'claim' AND subject_id = $1", params: [claim.id] },
    quantity_definitions: { where: "claim_id = ANY($1::uuid[])", params: [[quantity, down.child_claim_id, split.id]] },
    quantity_readings: { where: "id = $1", params: [reading.id] },
    quantity_cuts: { where: "claim_id = $1", params: [claim.id] },
    answer_relations: { where: "id = $1", params: [relation.id] },
    judgment_inputs: { where: "judgment_id = ANY($1::uuid[])", params: [judgments] },
    claim_formalizations: { where: "id = $1", params: [statement.id] },
    lean_checks: { where: "id = ANY($1::uuid[])", params: [[check.id, attemptCheck.id]] },
    proof_attempts: { where: "id = $1", params: [opened.attempt.id] },
    reconciliation_events: { where: "id = ANY($1::uuid[])", params: [events] },
  };
}

async function labelsOf(rows: Awaited<ReturnType<typeof writeOneOfEach>>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, { where, params }] of Object.entries(rows)) out[table] = await labelsWhere(table, where, params);
  return out;
}
const everyTableAt = (label: string) => Object.fromEntries(CONTENT_TABLES.map((t) => [t, [label]]));

/**
 * Cover a claim's assess group and run the Steward lane on it alone. Rows
 * other files left open are retired first; `alsoWaiting` are this test's
 * other claims, whose rows stay open (and uncovered) for their own turn.
 */
async function runFundedPass(claimId: string, alsoWaiting: string[] = []) {
  const funder = await seedUser("graph-funder");
  await seedAllocation({ group: ASSESS_GROUP(claimId), claimId, userId: funder, amountMicroUsd: 500 * OWL });
  await rawQuery(
    `UPDATE actions SET status = 'cancelled'
      WHERE status = 'open' AND kind IN ('assess', 'reassess') AND NOT (exclusion_group = ANY($1))`,
    [[claimId, ...alsoWaiting].map((id) => ASSESS_GROUP(id))]
  );
  return processNextStewardTask();
}

/** What a Steward does mid-pass, through its own tool: mint a subclaim under the node. */
function mintSubclaimDuring(parentId: string, minted: string[]): void {
  stage.during = async () => {
    const res = JSON.parse(
      await executeStewardTool("add_decomposition_edge", {
        parent_id: parentId, child_text: `A premise of it (${randomUUID()})`, relation: "requires", reasoning: "It rests on this.",
        importance: 0.01,
      })
    );
    expect(res, JSON.stringify(res)).toMatchObject({ success: true });
    takePipelineLabel(res.child_claim_id);
    minted.push(res.child_claim_id);
  };
}

/** What a stand-in run wrote: the label it saw, its run row's, and the rows it minted. */
async function written(seen: Seen, parentId: string, minted: string[]) {
  return {
    inRun: seen.label,
    run: await labelOf("agent_runs", seen.runId),
    subclaim: await labelsWhere("claims", "id = ANY($1::uuid[])", [minted]),
    edge: await labelsWhere("claim_relationships", "parent_claim_id = $1 AND child_claim_id = ANY($2::uuid[])", [parentId, minted]),
  };
}
const all = (label: string) => ({ inRun: label, run: label, subclaim: [label], edge: [label] });

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable inside the organization.')
     ON CONFLICT (name) DO NOTHING`,
    [INTERNAL]
  );
  // The lanes under test run what this file sets up; the platform's own
  // mandates, left active by other files, would fund and open rows of theirs.
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

beforeEach(() => {
  stage.seen = [];
  stage.during = null;
  stage.decision = { submitted: true, reasoning: "", tags: [] };
  stage.extracted = [];
});

describe("the columns", () => {
  it("are on every table of the graph's content, public by default, and point at labels", async () => {
    const rows = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; fk: boolean }>(
      `SELECT c.table_name, c.column_default, c.is_nullable,
              EXISTS (
                SELECT 1 FROM pg_constraint k
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                 WHERE k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                   AND k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
                   AND k.convalidated AND a.attname = c.column_name
              ) AS fk
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name = 'sensitivity_label'
          AND c.table_name = ANY($1)
        ORDER BY c.table_name`,
      [CONTENT_TABLES]
    );
    expect(rows).toEqual(
      CONTENT_TABLES.map((table_name) => ({ table_name, column_default: "'public'::text", is_nullable: "NO", fk: true }))
    );
  });

  it("cannot carry a label no row defines", async () => {
    const claim = await settledClaim("graph fk");
    await expect(
      rawQuery(`UPDATE claims SET sensitivity_label = 'undefined-label' WHERE id = $1`, [claim])
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // A run whose context names one mints nothing.
    const text = `Never minted (${randomUUID()}).`;
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () => proposeClaim({ claim: text, createdBy: "service" }))
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    expect(await rawQuery(`SELECT 1 FROM claims WHERE text = $1`, [text])).toEqual([]);
  });
});

describe("a row of the graph's content", () => {
  it("written inside a run carries the run's label, in every table", async () => {
    const rows = await inRunAt(INTERNAL, writeOneOfEach);
    expect(Object.keys(rows).sort()).toEqual(CONTENT_TABLES);
    expect(await labelsOf(rows)).toEqual(everyTableAt(INTERNAL));
  });

  it("written outside any run is public, in every table", async () => {
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const rows = await writeOneOfEach();
    expect(await labelsOf(rows)).toEqual(everyTableAt(PUBLIC_LABEL));
  });

  it("is the writer's whatever it hangs from: restricted on a public claim, public on a restricted one", async () => {
    const open = await settledClaim("graph public parent");
    const restricted = await settledClaim("graph restricted parent");
    await setLabel(restricted, INTERNAL);
    const write = async (claimId: string) => {
      const argument = await addArgument({
        claimId, stance: "for", name: `An argument ${randomUUID()}`, content: "It follows.", createdBy: "claim_steward",
      });
      const edge = await insertRelationshipEdge({
        parentId: claimId, childId: await settledClaim("graph premise"), relationType: "requires", reasoning: "r", createdBy: "claim_steward",
      });
      return { argument: argument.id, edge: edge.id };
    };
    const onOpen = await inRunAt(INTERNAL, () => write(open));
    expect(await labelOf("arguments", onOpen.argument)).toBe(INTERNAL);
    expect(await labelOf("claim_relationships", onOpen.edge)).toBe(INTERNAL);
    const onRestricted = await write(restricted);
    expect(await labelOf("arguments", onRestricted.argument)).toBe(PUBLIC_LABEL);
    expect(await labelOf("claim_relationships", onRestricted.edge)).toBe(PUBLIC_LABEL);
    // The claims keep the labels they had.
    expect(await labelOf("claims", open)).toBe(PUBLIC_LABEL);
    expect(await labelOf("claims", restricted)).toBe(INTERNAL);
  });

  it("already there keeps its label when a run at another label writes it again", async () => {
    const parent = await settledClaim("graph kept parent");
    const child = await settledClaim("graph kept child");
    const quantity = await settledClaim("graph kept quantity");
    const question = await settledClaim("graph kept question");
    await markQuestion(question);
    const name = `Kept vocabulary ${randomUUID().slice(0, 8)}`;
    const write = async () => {
      const edge = await insertRelationshipEdge({
        parentId: parent, childId: child, relationType: "requires", reasoning: "r", createdBy: "claim_steward",
      });
      const link = await linkClaims({ claimId: parent, otherClaimId: child, kind: "related", reasoning: "r", createdBy: "curator" });
      await defineQuantity({ claimId: quantity, definition: DEFINITION, createdBy: "claim_steward" });
      await recordCut({ claimId: parent, quantityId: quantity, direction: "below", value: 3, createdBy: "claim_steward" });
      const answer = await addAnswer({ questionId: question, answerId: child, basis: "quality", reasoning: "r", createdBy: "question_steward" });
      await setSubjectTags({ kind: "claim", subjectId: parent, source: "steward", assignments: [{ name }] });
      return { edge: edge.id, link: link.id, answer: answer.id };
    };
    const read = async (ids: Awaited<ReturnType<typeof write>>) => ({
      edge: await labelOf("claim_relationships", ids.edge),
      link: await labelOf("claim_links", ids.link),
      definition: await labelsWhere("quantity_definitions", "claim_id = $1", [quantity]),
      cut: await labelsWhere("quantity_cuts", "claim_id = $1", [parent]),
      answer: await labelOf("claim_relationships", ids.answer),
      tag: await labelsWhere("tags", "name = $1", [name]),
      tagging: await labelsWhere("taggings", "subject_kind = 'claim' AND subject_id = $1", [parent]),
    });
    const first = await write();
    const asWritten = await read(first);
    expect(new Set(Object.values(asWritten).flat())).toEqual(new Set([PUBLIC_LABEL]));
    // The same writes again, from a run at another label: each lands on the row already there.
    const again = await inRunAt(INTERNAL, write);
    expect(again).toEqual(first);
    expect(await read(again)).toEqual(asWritten);
  });
});

// The two ways a node is minted by a worker and not by a tool call: the
// extraction of a submitted document, and the review that accepts a
// proposal. Each runs at the label of the row its work waited in, so the
// node carries the label the document or the proposal was submitted at.
describe("a node minted by a worker", () => {
  async function ingested(label: string | null): Promise<string> {
    const url = `https://dbtest.example/graph/${randomUUID()}`;
    const submit = () => submitSource({ url, content: "<p>An essay about the grid.</p>" });
    const { jobId, sourceId } = label ? await inRunAt(label, submit) : await submit();
    const queue = getLocalQueue("urlExtraction");
    const message = queue.splice(queue.findIndex((m) => m.jobId === jobId), 1)[0]!;
    stage.extracted = [{
      verbatim_text: "the grid", context: null, proposed_canonical_form: `The grid is fragile (${randomUUID()}).`,
      claim_type: "empirical_verifiable", confidence: 0.9, importance: 0.5, contestation: 0.5,
      source_location: null, domains: [],
    }];
    // The worker gets the queued message and no context.
    await handleUrlExtraction(message);
    const [instance] = await rawQuery<{ claim_id: string }>(`SELECT claim_id FROM claim_instances WHERE source_id = $1`, [sourceId]);
    takePipelineLabel(instance!.claim_id);
    return instance!.claim_id;
  }

  async function proposed(label: string | null): Promise<string> {
    const contributor = await seedUser("graph-proposer");
    const propose = () => createClaimProposal({ claimText: `Outages are rising (${randomUUID()}).`, contributorId: contributor });
    const proposal = label ? await inRunAt(label, propose) : await propose();
    getLocalQueue("contribution").length = 0;
    // The review that accepts it runs at the contribution's label, as the worker opens it.
    const res = await runAtLabel(await labelOf("contributions", proposal.id), `contribution ${proposal.id}`, () =>
      materializeAcceptedIntake(proposal.id)
    );
    expect(res).toMatchObject({ action: "created_claim" });
    takePipelineLabel(res.claimId!);
    return res.claimId!;
  }

  it("from a document carries the label the document was submitted at", async () => {
    expect(await labelOf("claims", await ingested(INTERNAL))).toBe(INTERNAL);
    expect(await labelOf("claims", await ingested(null))).toBe(PUBLIC_LABEL);
  });

  it("from an accepted proposal carries the label the proposal was made at", async () => {
    expect(await labelOf("claims", await proposed(INTERNAL))).toBe(INTERNAL);
    expect(await labelOf("claims", await proposed(null))).toBe(PUBLIC_LABEL);
  });
});

describe("work that starts from a claim", () => {
  /** Leave only these claims for the sweep to find: it takes at most 500, in no order. */
  async function onlyPending(claims: string[]): Promise<void> {
    await rawQuery(
      `UPDATE claims SET steward_state = 'done' WHERE steward_state = 'pending' AND NOT (id = ANY($1::uuid[]))`,
      [claims]
    );
  }

  it("is opened by the reconcile sweep at the claim's label, and the pass it pays for writes at that label", async () => {
    const restricted = await seedClaim("graph swept restricted");
    const open = await seedClaim("graph swept public");
    await setLabel(restricted, INTERNAL);
    await onlyPending([restricted, open]);
    expect(await assessLabels(restricted)).toEqual([]);

    // The sweep runs outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    await reconcileActions();
    expect(await assessLabels(restricted)).toEqual([INTERNAL]);
    expect(await assessLabels(open)).toEqual([PUBLIC_LABEL]);

    // The executor picks each row up, also outside any run, and the run it opens writes at the row's label.
    for (const [claim, label] of [[restricted, INTERNAL], [open, PUBLIC_LABEL]] as const) {
      const minted: string[] = [];
      mintSubclaimDuring(claim, minted);
      stage.seen = [];
      expect(await runFundedPass(claim, [restricted, open])).toMatchObject({ status: "processed", claimId: claim, ok: true });
      expect(stage.seen.map((s) => s.agent)).toEqual(["steward"]);
      expect(await written(stage.seen[0]!, claim, minted)).toEqual(all(label));
    }
  });

  it("is reopened by the sweep at the claim's label, whatever label its finished row had", async () => {
    const claim = await seedClaim("graph swept again");
    await setLabel(claim, INTERNAL);
    // A row from an earlier pass, finished, at public.
    await seedAction({ group: ASSESS_GROUP(claim), claimId: claim, costMicroUsd: 1, status: "done" });
    expect(await assessLabels(claim)).toEqual([PUBLIC_LABEL]);
    await onlyPending([claim]);
    await reconcileActions();
    const rows = await rawQuery<{ status: string; sensitivity_label: string }>(
      `SELECT status, sensitivity_label FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
      [ASSESS_GROUP(claim)]
    );
    expect(rows).toEqual([{ status: "open", sensitivity_label: INTERNAL }]);
  });

  it("is run by the Steward's fallback lane at the claim's label", async () => {
    const config = loadConfig();
    const before = {
      backgroundFallbackLaneEnabled: config.backgroundFallbackLaneEnabled,
      backgroundDailyBudgetOwls: config.backgroundDailyBudgetOwls,
    };
    // The lane as a deployment with no General mandate turns it on, with no daily budget to count against.
    Object.assign(config, { backgroundFallbackLaneEnabled: true, backgroundDailyBudgetOwls: 0 });
    try {
      // Nothing on the ledger is covered, so the lane falls through to its own pick.
      await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND kind IN ('assess', 'reassess')`);
      for (const label of [INTERNAL, PUBLIC_LABEL]) {
        const claim = await seedClaim(`graph fallback ${label}`);
        await setLabel(claim, label);
        // The lane takes the pending claim with the highest priority.
        await rawQuery(`UPDATE claims SET queue_priority = 99 WHERE id = $1`, [claim]);
        const minted: string[] = [];
        mintSubclaimDuring(claim, minted);
        stage.seen = [];
        expect(currentLabel()).toBe(PUBLIC_LABEL);
        expect(await processNextStewardTask()).toMatchObject({ status: "processed", claimId: claim, ok: true });
        expect(stage.seen.map((s) => s.agent)).toEqual(["steward"]);
        expect(await written(stage.seen[0]!, claim, minted)).toEqual(all(label));
        await rawQuery(`UPDATE claims SET queue_priority = 0.5 WHERE id = $1`, [claim]);
      }
    } finally {
      Object.assign(config, before);
    }
  });

  it("is tagged at the claim's label: the Tagger's run, the tag it mints and the tagging", async () => {
    // Only this test's claims wait for the Tagger.
    await rawQuery(`UPDATE claims SET tagged_at = now() WHERE tagged_at IS NULL`);
    const embedding = `[${Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0)).join(",")}]`;
    for (const label of [INTERNAL, PUBLIC_LABEL]) {
      const claim = await settledClaim(`graph tagged ${label}`);
      await setLabel(claim, label);
      await rawQuery(`UPDATE claims SET embedding = $2::vector, tagged_at = NULL WHERE id = $1`, [claim, embedding]);
      const name = `Tagged at ${label} ${randomUUID().slice(0, 8)}`;
      stage.decision = { submitted: true, reasoning: "About the grid.", tags: [{ name, description: "A topic.", confidence: 0.8 }] };
      stage.seen = [];
      expect(currentLabel()).toBe(PUBLIC_LABEL);
      expect(await processNextTaggingTask()).toMatchObject({ status: "processed", claimId: claim, ok: true });
      expect(stage.seen.map((s) => [s.agent, s.label])).toEqual([["tagger", label]]);
      expect(await labelOf("agent_runs", stage.seen[0]!.runId)).toBe(label);
      expect(await labelsWhere("tags", "name = $1", [name])).toEqual([label]);
      expect(await labelsWhere("taggings", "subject_kind = 'claim' AND subject_id = $1", [claim])).toEqual([label]);
    }
    expect(await processNextTaggingTask()).toEqual({ status: "empty" });
  });

  // A mandate's plan is the mandate's work, not the claim's: since mandates
  // carry a label of their own, the order takes it (label-governance.test.ts
  // has the mandate at a second label). The claim's label no longer stands in.
  it("is ordered for a mandate's plan at the mandate's label when the scheduler places the order, and at the run's when a run does", async () => {
    const funder = await seedUser("graph-plan");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500 * OWL, dailyBudgetMicroUsd: 100 * OWL });
    const swept = await seedClaim("graph plan item, swept");
    await setLabel(swept, INTERNAL);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "assess", claim_id: swept, rationale: "first", budget_owls: 3 }] }),
    ]);
    // The scheduler materializes the plan outside any run. The mandate is public.
    await materializePlanItems(grantId);
    expect(await assessLabels(swept)).toEqual([PUBLIC_LABEL]);

    // An order placed from inside a run is that run's work, like everything a run opens.
    const inRun = await seedClaim("graph plan item, in a run");
    await setLabel(inRun, INTERNAL);
    const placed = await inRunAt(PUBLIC_LABEL, () =>
      placeStandingOrder({ grantId, claimId: inRun, tier: "standard", budgetMicroUsd: 3 * OWL, brief: "A funded mandate scheduled a pass." })
    );
    expect(placed.state).toBe("placed");
    expect(await assessLabels(inRun)).toEqual([PUBLIC_LABEL]);
  });

  it("is raised by the reconcile-candidate scan at the anchor claim's label", async () => {
    const twin = async (label: string, axis: number) => {
      const id = await settledClaim(`graph twin ${label}`);
      await setLabel(id, label);
      const v = Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0));
      await rawQuery(`UPDATE claims SET embedding = $2::vector WHERE id = $1`, [id, `[${v.join(",")}]`]);
      return id;
    };
    await rawQuery(`UPDATE claims SET embedding = NULL`);
    const restricted = [await twin(INTERNAL, 40), await twin(INTERNAL, 40)];
    const open = [await twin(PUBLIC_LABEL, 900), await twin(PUBLIC_LABEL, 900)];
    expect(
      await scanReconcileCandidates({ reconcile_candidates_max_per_sweep: 5, reconcile_candidate_min_similarity: 0.92 })
    ).toBe(2);
    const curateLabels = (pair: string[]) =>
      labelsWhere("actions", "kind = 'curate' AND exclusion_group = ANY($1)", [pair.map((id) => CURATE_GROUP(id))]);
    expect(await curateLabels(restricted)).toEqual([INTERNAL]);
    expect(await curateLabels(open)).toEqual([PUBLIC_LABEL]);
    await rawQuery(`UPDATE claims SET embedding = NULL`);
  });

  it("is asked of the Steward at the label of the URL waiting in the argument's backlog", async () => {
    const claim = await settledClaim("graph backlog");
    const argument = await addArgument({ claimId: claim, stance: "for", name: `Backlog ${randomUUID()}`, content: "c", createdBy: "user" });
    const url = `https://dbtest.example/graph/backlog/${randomUUID()}`;
    await inRunAt(INTERNAL, () => attachArgumentEvidence(argument.id, [url]));
    expect(await labelsWhere("argument_evidence_backlog", "argument_id = $1", [argument.id])).toEqual([INTERNAL]);
    // A script sends the backlog later, outside any run.
    const sent = await sendArgumentEvidenceBacklog({ argumentId: argument.id });
    expect(sent).toEqual([{ claimId: claim, argumentId: argument.id, urls: [url] }]);
    expect(await assessLabels(claim)).toEqual([INTERNAL]);
  });

  it("is asked of the Steward at the claim's label when a notice is found against a source it rests on, whoever found it", async () => {
    const restricted = await settledClaim("graph notice restricted");
    const open = await settledClaim("graph notice public");
    await setLabel(restricted, INTERNAL);
    const letters = (doi: string) =>
      tellStewardsOfSourceEvents(
        [
          {
            source: { source_id: randomUUID(), url: `https://doi.org/${doi}`, title: "A paper", claim_ids: [restricted, open] },
            notice: { type: "retraction", title: null, updated: "2026-09-10T00:00:00Z", notice_doi: `${doi}.n1` },
          },
        ],
        []
      );
    // The Crossref poll finds the notice outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await letters(`10.5555/${randomUUID()}`)).toBe(2);
    expect(await assessLabels(restricted)).toEqual([INTERNAL]);
    expect(await assessLabels(open)).toEqual([PUBLIC_LABEL]);
    // The letter itself, waiting in each node's inbox, is at the node's label too.
    expect(await labelsWhere("node_messages", "node_id = $1", [restricted])).toEqual([INTERNAL]);
    expect(await labelsWhere("node_messages", "node_id = $1", [open])).toEqual([PUBLIC_LABEL]);

    // A run's first fetch of the document finds it: each letter is still at
    // its node's label and not at the label of the run that fetched.
    const restrictedAgain = await settledClaim("graph notice restricted, found in a run");
    const openAgain = await settledClaim("graph notice public, found in a run");
    await setLabel(restrictedAgain, INTERNAL);
    for (const finder of [INTERNAL, PUBLIC_LABEL]) {
      const doi = `10.5555/${randomUUID()}`;
      const told = await inRunAt(finder, () =>
        tellStewardsOfSourceEvents(
          [
            {
              source: { source_id: randomUUID(), url: `https://doi.org/${doi}`, title: "A paper", claim_ids: [restrictedAgain, openAgain] },
              notice: { type: "correction", title: null, updated: "2026-09-10T00:00:00Z", notice_doi: `${doi}.n1` },
            },
          ],
          []
        )
      );
      expect(told).toBe(2);
      expect(await assessLabels(restrictedAgain)).toEqual([INTERNAL]);
      expect(await assessLabels(openAgain)).toEqual([PUBLIC_LABEL]);
      expect(await labelsWhere("node_messages", "node_id = $1", [restrictedAgain])).toEqual([INTERNAL]);
      expect(await labelsWhere("node_messages", "node_id = $1", [openAgain])).toEqual([PUBLIC_LABEL]);
    }
  });

  it("takes the claim's label over the one in the air", async () => {
    const claim = await settledClaim("graph helper");
    await setLabel(claim, INTERNAL);
    const at = () => Promise.resolve(currentLabel());
    expect(await runAtClaimLabel(claim, at)).toBe(INTERNAL);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => runAtClaimLabel(claim, at))).toBe(INTERNAL);
    // A claim that does not exist has nothing to run at: the work runs as it would have.
    expect(await runAtClaimLabel(randomUUID(), at)).toBe(PUBLIC_LABEL);
  });
});

describe("what a reader is shown", () => {
  let app: FastifyInstance;
  let rows: Awaited<ReturnType<typeof writeOneOfEach>>;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();
    rows = await writeOneOfEach();
  });

  afterAll(async () => {
    await app.close();
  });

  const carriesIt = (text: string) => /sensitivity[_ ]?label/i.test(text);

  it("has no view query_sql reads that exposes the column", async () => {
    // The public_read views name their columns, and Postgres stores a view
    // with its columns spelled out, so a column added to a table a view
    // reads does not appear in it.
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND column_name = 'sensitivity_label'`
    );
    expect(exposed).toEqual([]);
    // The four views over the altered tables still read their rows.
    const [claimId] = rows.claims!.params[0] as string[];
    const [node] = await rawQuery<Record<string, unknown>>(`SELECT * FROM public_read.nodes WHERE id = $1`, [claimId]);
    expect(node).toBeDefined();
    expect(Object.keys(node!)).not.toContain("sensitivity_label");
    for (const view of ["edges", "arguments", "tags"]) {
      const [row] = await rawQuery<Record<string, unknown>>(`SELECT * FROM public_read.${view} LIMIT 1`);
      expect(row, view).toBeDefined();
      expect(Object.keys(row!), view).not.toContain("sensitivity_label");
    }
  });

  it("has no response of the claim, argument, tag, formalization, attempt or change routes that carries it", async () => {
    const [claimId, quantityChild] = rows.claims!.params[0] as string[];
    const [argumentId] = rows.arguments!.params[0] as string[];
    const [question] = await rawQuery<{ id: string }>(`SELECT question_id AS id FROM answer_relations WHERE id = $1`, rows.answer_relations!.params);
    const [tag] = await rawQuery<{ slug: string }>(`SELECT slug FROM tags WHERE name = $1`, rows.tags!.params);
    const [check] = rows.lean_checks!.params[0] as string[];
    const attempt = rows.proof_attempts!.params[0] as string;
    const urls = [
      `/claims?limit=5`,
      `/claims/cards?ids=${claimId}`,
      `/claims/${claimId}/card`,
      ...["cursory", "standard", "deep"].map((d) => `/claims/${claimId}?information_depth=${d}`),
      `/claims/${quantityChild}?information_depth=deep`,
      `/claims/${question!.id}?information_depth=deep`,
      `/claims/${claimId}/citation`,
      `/claims/${claimId}/provenance`,
      `/claims/${claimId}/dependents`,
      `/claims/${claimId}/record`,
      `/claims/${claimId}/judgment-inputs`,
      `/claims/${claimId}/assessments`,
      `/claims/${claimId}/assessments/trajectory`,
      `/claims/${claimId}/events`,
      `/claims/${claimId}/formalization`,
      `/claims/${claimId}/formalizations`,
      `/claims/${claimId}/attempts`,
      `/attempts/${attempt}`,
      `/lean-checks/${check}`,
      `/arguments/${argumentId}`,
      `/tags`,
      `/tags/${tag!.slug}`,
      `/changes`,
    ];
    const answered: string[] = [];
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url });
      // A route that needs a key or finds nothing has shown nothing either way.
      if (res.statusCode === 200) answered.push(url);
      expect(carriesIt(res.body), `${url} (${res.statusCode})`).toBe(false);
    }
    // The check means something only if the routes answered with the rows.
    expect(answered).toEqual(expect.arrayContaining([
      `/claims/${claimId}?information_depth=deep`,
      `/claims/${question!.id}?information_depth=deep`,
      `/claims/${claimId}/record`,
      `/claims/${claimId}/events`,
      `/claims/${claimId}/formalizations`,
      `/arguments/${argumentId}`,
      `/tags/${tag!.slug}`,
    ]));
  });

  it("has no agent's graph read, and no section of the claim view, that carries it", async () => {
    const [claimId] = rows.claims!.params[0] as string[];
    const [argumentId] = rows.arguments!.params[0] as string[];
    // A claim and an argument are read in sections, and a read that asks
    // for none returns the head alone. Every section is asked for, so the
    // arguments, the subclaims and what the judgment rested on are read.
    const reads: Array<[string, Record<string, unknown>, string]> = [
      ["get_claim", { claim_id: claimId, include: [...CLAIM_VIEW_INCLUDES] }, argumentId!],
      ["get_decomposition", { claim_id: claimId }, claimId!],
      ["get_dependents", { claim_id: claimId }, claimId!],
      ["get_argument", { argument_id: argumentId, include: [...ARGUMENT_VIEW_INCLUDES] }, claimId!],
    ];
    for (const [tool, input, shows] of reads) {
      const out = await executeGraphReadTool(tool, input);
      expect(out, tool).not.toBeNull();
      // The check means something only if the read returned the rows.
      expect(out!, tool).toContain(shows);
      expect(carriesIt(out!), tool).toBe(false);
    }
    // The view the API and MCP serve, bare and with each section on its own.
    for (const include of [[], ...CLAIM_VIEW_INCLUDES.map((section) => [section])]) {
      const view = await getClaimView(claimId!, { include });
      expect(carriesIt(JSON.stringify(view)), include.join()).toBe(false);
    }
  });
});
