/**
 * The rows of work and governance carry a label (src/labels.ts).
 *
 * Against real Postgres and the real write seams, four things:
 *
 *  - A request, a message, a petition, a mandate, a mandate's decision, a
 *    lookout, a correspondent, a review, a ruling, an audit entry and the
 *    rest of the rows work is asked for and governed with carry the label of
 *    the run or request that writes them, and are public outside any run.
 *  - Work that belongs to one of them runs at its label, whichever sweep or
 *    run starts it: a mandate decides for its plan, its reviews, its events
 *    and its sittings; a lookout and a correspondent for theirs; a request
 *    for its ledger rows; a petition for its follow-up; a claim's waiting
 *    messages for the pass that reads them; a paused session for the
 *    answers it holds.
 *  - A sitting works only what waits at its mandate's label.
 *  - None of it reaches a reader: no view query_sql reads, no mandate,
 *    request, correspondent or prize route, no conversation or page as it
 *    is served, and no agent's read carries the column.
 *
 * No model is called and nothing reaches the network. The Steward, the
 * officers' tool loop and the two chat agents are stand-ins that open a real
 * run and do what the test asks; feeds and Crossref answer from this file.
 * Everything around them is the code that runs in production.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

interface Seen {
  agent: string;
  label: string;
  brief: string;
}

const stage = vi.hoisted(() => {
  // Tracing is off under vitest by default; a run in this file is a real run.
  process.env.TRACE_LEVEL = "full";
  // Enqueue telemetry is off under vitest by default; its row is one of the tables here.
  process.env.ENQUEUE_EVENTS = "on";
  process.env.API_KEYS = "label-governance-service-key";
  // The suite files more prize claims in a day than a live platform takes.
  process.env.PRIZE_CLAIMS_PER_DAY_PLATFORM = "1000";
  return {
    /** The network: what each URL answers with. A URL not here fails. */
    pages: new Map<string, string>(),
    /** What the retraction poll's window holds. */
    notices: [] as Array<Record<string, unknown>>,
    /** Every stand-in run, in order: its agent, the label it ran at, what it was briefed with. */
    seen: [] as Seen[],
    /** What the next officers' tool loop does with its tools. */
    sitting: null as null | ((execute: (name: string, input: Record<string, unknown>) => Promise<string>, brief: string) => Promise<void>),
    /** What the next Steward stand-in does while its run is open. */
    during: null as null | (() => Promise<void>),
  };
});

vi.mock("../../src/services/url-guard.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/url-guard.js")>()),
  assertPublicHttpUrl: async (raw: string) => new URL(raw),
  fetchPublicUrl: vi.fn(async (url: string) => {
    const body = stage.pages.get(url);
    if (body === undefined) throw new Error(`no network in tests: ${url}`);
    return body;
  }),
}));
vi.mock("../../src/services/source-watch-service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/source-watch-service.js")>()),
  retractionNoticesSince: vi.fn(async () => ({ notices: stage.notices, complete: true, readThrough: null })),
}));
vi.mock("../../src/llm/agents/claim-steward.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/claim-steward.js")>()),
  runClaimSteward: vi.fn(async () => {
    const { withAgent, currentLabel } = await import("../../src/llm/usage-context.js");
    await withAgent("steward", async () => {
      stage.seen.push({ agent: "steward", label: currentLabel(), brief: "" });
      const during = stage.during;
      stage.during = null;
      await during?.();
    });
  }),
}));
// The officers' sitting runs a tool loop. The stand-in keeps the run that
// was opened for it, notes the label it runs at and the brief it was given,
// and calls the sitting's own tools as the test asks.
vi.mock("../../src/llm/client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/client.js")>()),
  toolUseLoop: vi.fn(async (opts: {
    initialMessages: Array<{ content: unknown }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  }) => {
    const { currentLabel, getUsageContext } = await import("../../src/llm/usage-context.js");
    const brief = String(opts.initialMessages[0]?.content ?? "");
    stage.seen.push({ agent: getUsageContext().agent ?? "unknown", label: currentLabel(), brief });
    const sitting = stage.sitting;
    stage.sitting = null;
    await sitting?.(opts.executeTool, brief);
    return { content: "Done.", toolCalls: [], iterations: 1 };
  }),
}));
vi.mock("../../src/llm/agents/grantmaker.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/grantmaker.js")>()),
  runGrantmakerTurn: vi.fn(async () => ({ reply: "What is the question you want worked?" })),
}));
vi.mock("../../src/llm/agents/assistant.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/assistant.js")>()),
  runAssistantTurn: vi.fn(async () => ({ reply: "A reply.", stopped: null, toolUses: [], runId: null })),
}));
vi.mock("../../src/llm/agents/contribution-reviewer.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/contribution-reviewer.js")>()),
  runContributionReview: vi.fn(async () => {}),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { loadConfig } from "../../src/config.js";
import { rawQuery } from "../../src/db/client.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { executeOfficerTool, workMandateInbox, workWaitingInboxes } from "../../src/llm/agents/program-officer.js";
import { executeArbitratorTool } from "../../src/llm/tools/arbitrator-tools.js";
import { executeAuditTool } from "../../src/llm/tools/audit-tools.js";
import { executeGovernanceTool } from "../../src/llm/tools/governance-tools.js";
import { executeGraphReadTool } from "../../src/llm/tools/graph-read-tools.js";
import { createResearcherReadTools } from "../../src/llm/tools/researcher-read-tools.js";
import { executeReviewerTool } from "../../src/llm/tools/reviewer-tools.js";
import { currentLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import {
  ASSESS_GROUP,
  LOOKOUT_GROUP,
  CORRESPONDENT_GROUP,
  REVIEW_GROUP,
  ensureRequestActions,
  ensureRequestCurateAction,
  materializePlanItems,
  reconcileActions,
} from "../../src/services/action-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { getAssistantConversation, serializeAssistantConversation, settleAssistantTurns, startAssistantConversation } from "../../src/services/assistant-service.js";
import { PRIZE_RULES_VERSION, openBounty, requestBounty } from "../../src/services/bounty-service.js";
import { flagInconsistency, startSweep } from "../../src/services/consistency-service.js";
import { createContribution } from "../../src/services/contribution-service.js";
import {
  correspondentPublic,
  createCorrespondent,
  cursorAt,
  getCorrespondent,
  graphChangeScanTick,
  listCorrespondentUpdates,
  publishCorrespondentUpdate,
  queueCorrespondentEvent,
  updateCorrespondentPlan,
} from "../../src/services/correspondent-service.js";
import { requestCuration } from "../../src/services/curation-service.js";
import { addFeed } from "../../src/services/feed-service.js";
import {
  getConversation,
  resetGrantConversationRateLimiter,
  serializeConversation,
  serializeConversationSummary,
  settleGrantConversationTurns,
  startConversation,
} from "../../src/services/grant-conversation-service.js";
import { createGrant, getGrant, serializeGrant } from "../../src/services/grant-service.js";
import { openInbox } from "../../src/services/inbox-service.js";
import { recordIngestFocus } from "../../src/services/ingest-focus-service.js";
import { pendingPassLabel, runAtMandateLabel, runAtMandateLabelOutsideAnyRun } from "../../src/services/label-service.js";
import { createLookout, flagNote, getLookout, listLookoutFlags, queueLookoutEvent } from "../../src/services/lookout-service.js";
import { collectMandateEvents, pendingMandateEvents, wakeDueMandateReviews } from "../../src/services/mandate-event-service.js";
import { raiseToMandate } from "../../src/services/mandate-inbox-service.js";
import { amendObjective } from "../../src/services/mandate-terms-service.js";
import { writeOperatingPolicy } from "../../src/services/operating-policy-service.js";
import { getPage, savePage, serializePage } from "../../src/services/page-service.js";
import { PETITION_COLUMNS, decidePetition, filePetition, getPetition, sweepFollowUps } from "../../src/services/petition-service.js";
import { filePrizeClaim } from "../../src/services/prize-claim-service.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { adjustReputation } from "../../src/services/reputation-service.js";
import { fileRequest, getRequest, recordWork } from "../../src/services/request-service.js";
import { sweepSessions } from "../../src/services/session-service.js";
import { placeStandingOrder } from "../../src/services/standing-order-service.js";
import { feedPollTick, retractionPollTick } from "../../src/workers/lookout-triggers.js";
import { reclaimStalePrizeChecks } from "../../src/workers/prize-check-pipeline.js";
import { processNextStewardTask } from "../../src/workers/steward-pipeline.js";
import { OWL, creditOwls, seedAction, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

/** The second label: not a word any of these rows holds for another reason. */
const SECOND = "embargoed";
const FOREIGN_KEY_VIOLATION = "23503";
const SERVICE = { "x-api-key": "label-governance-service-key" };

/** The tables this file is about: the rows of work and governance. */
const GOVERNANCE_TABLES = [
  "arbitration_results", "assistant_conversations", "assistant_pages", "attachments", "audit_findings", "audit_log",
  "bounties", "claim_predictions", "consistency_flags", "consistency_sweeps", "contribution_reviews",
  "correspondent_events", "correspondent_plan_items", "correspondent_updates", "correspondents", "curation_requests",
  "enqueue_events", "grant_conversations", "grants", "ingest_focuses", "lookout_events", "lookout_feeds",
  "lookout_flags", "lookouts", "mandate_decisions", "mandate_events", "mandate_inbox", "mandate_policy_versions",
  "node_messages", "petitions", "prize_claims", "reputation_events", "request_targets", "request_work", "requests",
];
/** The one of them no code in src writes: a prediction is seeded by a script, outside any run. */
const SEEDED_BY_SCRIPT = ["claim_predictions"];

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
const setLabel = (table: string, id: string, label: string) =>
  rawQuery(`UPDATE ${table} SET sensitivity_label = $2 WHERE id = $1`, [id, label]);
const assessLabels = (claimId: string) => labelsWhere("actions", "exclusion_group = $1", [ASSESS_GROUP(claimId)]);

/** A claim as it stands after its pass, so no sweep picks it up until a test says. */
async function settledClaim(label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
  return id;
}

/** An active mandate at `label`, with escrow and a daily rate to place orders from. */
async function mandateAt(label: string): Promise<string> {
  const { grantId } = await seedGrantWithJob({
    funderId: await seedUser("governance-mandate"), budgetMicroUsd: 500 * OWL, dailyBudgetMicroUsd: 100 * OWL,
  });
  await setLabel("grants", grantId, label);
  return grantId;
}

const BRIEF = "Watch this author's posts for anything that bears on the claims in the territory.";
const rss = (site: string, ids: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed at ${site}</title><link>${site}</link>
    ${ids.map((id) => `<item><title>Post ${id}</title><link>${site}/p/${id}</link><guid>${site}/p/${id}</guid>
      <description>About ${id}</description></item>`).join("")}
  </channel></rss>`;

const ok = (out: string | null): Record<string, any> => {
  const parsed = JSON.parse(out!);
  expect(parsed, out!).toMatchObject({ success: true });
  return parsed;
};

/** A claim with a published formal statement a bounty can bind to. */
async function bindableClaim(): Promise<{ claimId: string; formalizationId: string; namespace: string }> {
  const claimId = await settledClaim("governance prize");
  const ns = `Minerval.S${randomUUID().slice(0, 8)}_v1`;
  const [f] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_formalizations
       (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
        namespace, statement_source, source_hash, expr_hash, pp_type,
        constants, definitions_axioms, witness_present, status, authored_by,
        published_at, review_period_ends_at)
     VALUES ($1, 1, 'mathlib-v4.33.0', 'leanprover/lean4:v4.33.0', $2, 'sha256:img', $3, $4,
             $5, $6, 'True', '[]', '[]', true, 'published', 'claim_steward',
             now() - interval '30 days', now() - interval '16 days')
     RETURNING id`,
    [
      claimId, randomUUID().replace(/-/g, ""), ns,
      `import Mathlib\nnamespace ${ns}\ndef Statement : Prop := True\nexample : True := trivial\nend ${ns}`,
      `src-${randomUUID()}`, `expr-${randomUUID()}`,
    ]
  );
  await rawQuery(
    `INSERT INTO proof_attempts (claim_id, formalization_id, model, variant, effort, status, outcome, ceiling_micro_usd, spent_micro_usd, finished_at)
     VALUES ($1, $2, 'solver', 'max', 'max', 'completed', 'partial', 100000000, 84000000, now() - interval '10 days')`,
    [claimId, f!.id]
  );
  return { claimId, formalizationId: f!.id, namespace: ns };
}

async function claimant() {
  const id = await seedUser("governance-claimant");
  await rawQuery(`UPDATE contributors SET reputation_score = 60, created_at = now() - interval '30 days' WHERE id = $1`, [id]);
  const [row] = await rawQuery<{ external_id: string; reputation_score: number; created_at: Date }>(
    `SELECT external_id, reputation_score, created_at FROM contributors WHERE id = $1`,
    [id]
  );
  return { id, externalId: row!.external_id, reputationScore: row!.reputation_score, createdAt: new Date(row!.created_at), prizeIneligible: false, isSuspended: false };
}

/**
 * One row in every table of work and governance that code writes, each
 * through the seam the agents, the workers and the routes write it with.
 * Returns, for each table, where its rows are, and the ids later checks use.
 */
async function writeOneOfEach() {
  const tag = randomUUID().slice(0, 8);
  const claim = await settledClaim("governance claim");
  const other = await settledClaim("governance neighbor");
  // A judgment on the claim, as a fixture: a sweep flags only what has been judged.
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace) VALUES ($1, 'supported', 0.7, 'dbtest')`,
    [claim]
  );

  // A mandate, funded the way a funder funds one, and what its Grantmaker
  // writes for it: its operating policy and an amended objective.
  const funder = await seedUser("governance-funder");
  await creditOwls(funder, 400 * OWL);
  const made = await createGrant({ funderUserId: funder, name: `Mandate ${tag}`, policy: "cover", budgetOwls: 300, scopeClaimId: claim });
  if (!made.ok) throw new Error(made.message);
  const grantId = made.grant.id;
  await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute', daily_budget_micro_usd = $2 WHERE id = $1`, [grantId, 100 * OWL]);
  expect(await writeOperatingPolicy({ grantId, content: `Commission what the plan names (${tag}).`, note: "A first policy.", author: "grantmaker" }))
    .toMatchObject({ ok: true });
  expect(await amendObjective({ grantId, objective: `Find what the claim turns on (${tag}).`, note: `Sharper (${tag}).`, author: "grantmaker" }))
    .toMatchObject({ ok: true });

  // A lookout and what it does: a feed, a queued input, a note for the review.
  const lookout = await createLookout({ grantId, title: `Watch ${tag}`, brief: BRIEF, heartbeatHours: 24, triggers: ["manual", "feed"], createdBy: "grantmaker:review" });
  if (!lookout.ok) throw new Error(JSON.stringify(lookout));
  const site = `https://blog-${tag}.example`;
  stage.pages.set(`${site}/feed`, rss(site, ["a"]));
  const feed = await addFeed({ grantId, lookoutId: lookout.lookoutId, url: `${site}/feed`, createdBy: "grantmaker:review" });
  if (!feed.ok) throw new Error(JSON.stringify(feed));
  expect(await queueLookoutEvent({ lookoutId: lookout.lookoutId, kind: "manual", payload: { note: `Look at this (${tag}).` } })).toEqual({ queued: true });
  const note = await flagNote({ lookoutId: lookout.lookoutId, text: `Nothing new this week (${tag}).`, claimId: claim });
  if (!note.ok) throw new Error(JSON.stringify(note));
  // The mandate's events are collected for it by a timer: here, the flag just raised.
  expect(await collectMandateEvents(grantId)).toBeGreaterThan(0);

  // A correspondent and what it does: a poke, a plan item, an update.
  const correspondent = await createCorrespondent({
    grantId, title: `Reporter ${tag}`, brief: "Tell the audience when the standing of the claims in scope changes materially.",
    audience: "People who follow this question.", scopeClaimIds: [claim], heartbeatHours: 24, triggers: ["manual"], createdBy: "grantmaker:review",
  });
  if (!correspondent.ok) throw new Error(JSON.stringify(correspondent));
  const cid = correspondent.correspondentId;
  expect(await queueCorrespondentEvent({ correspondentId: cid, kind: "manual", payload: { note: `A poke (${tag}).` } })).toEqual({ queued: true });
  expect(await updateCorrespondentPlan({ correspondentId: cid, add: [`Follow the replication until it reports (${tag}).`] })).toMatchObject({ ok: true });
  const update = await publishCorrespondentUpdate({
    correspondentId: cid, grantId, title: `What changed (${tag})`, body: `Nothing material (${tag}).`, items: [],
    notCovered: { changes: [], changes_total: 0, more_after_window: false } as never,
    changesFrom: cursorAt(new Date(Date.now() - 60_000)), changesTo: cursorAt(new Date()),
  });

  // A request, its targets and work recorded on it.
  const request = await fileRequest({
    ask: `Reproduce the central estimate from the released data (${tag}).`, why: "The claim rests on it.",
    satisfiedBy: "A table of the estimate under the paper's own specification.", claimIds: [claim],
    filer: { kind: "admin", agent: "claim_steward" },
  });
  const work = await recordWork({ requestId: request.id, byLabel: "Researcher", summary: `Taken up (${tag}).` });

  // A message to the node's Steward, which is also an enqueue.
  await enqueueSteward({ claimId: other, trigger: "steward_note", context: `A note for the neighbor (${tag}).` });
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [other]);
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [ASSESS_GROUP(other)]);
  await rawQuery(`UPDATE node_messages SET read_at = now() WHERE node_id = $1`, [other]);

  // A petition to the mandate and its decision, and something raised to its inbox.
  const petitionId = await filePetition({
    grantId, kind: "more_budget", askedMicroUsd: 2 * OWL, plan: `Read the three replications (${tag}).`,
    requesterAgent: "steward", requesterNodeId: claim, waiting: false,
  });
  expect(await decidePetition({ petitionId, decision: "refuse", reason: `Not this week (${tag}).`, decidedBy: "officer" })).toMatchObject({ ok: true });
  const raised = await raiseToMandate({ grantId, source: "a lookout", summary: `A source worth ingesting (${tag}).`, targetNodeId: claim });

  // A contribution reviewed and, on appeal, ruled on. A rejection changes the contributor's standing.
  const contributor = await seedUser("governance-contributor");
  const contribution = await createContribution({
    claimId: claim, contributorId: contributor, contributionType: "counter_evidence",
    content: `The 2019 survey found the opposite in three of five regions (${tag}).`,
  });
  ok(await executeReviewerTool("record_review_decision", {
    contribution_id: contribution.id, decision: "reject", reasoning: `It restates the claim (${tag}).`, confidence: 0.8, policy_citations: [],
  }));
  ok(await executeArbitratorTool("record_arbitration_decision", {
    contribution_id: contribution.id, outcome: "uphold_original", decision: "reject", reasoning: `The rejection stands (${tag}).`,
  }));
  await adjustReputation({ contributorId: contributor, delta: -1 });

  // The Curator asked to look, a sweep and what it flagged, an audit finding.
  const curation = await requestCuration({ anchorClaimId: claim, otherClaimId: other, source: "operator", concern: `These may be one node (${tag}).` });
  if (!curation.ok) throw new Error(curation.problem);
  const sweepId = await startSweep({ tagId: null, partition: "residual", label: "The rest", assessed: 1 } as never, "standard");
  // Closed at once, so no other file finds a sweep in progress.
  await rawQuery(`UPDATE consistency_sweeps SET status = 'done', finished_at = now() WHERE id = $1`, [sweepId]);
  const flagged = await flagInconsistency({
    sweepId, kind: "overlooked_evidence", primaryClaimId: claim, claimIds: [other],
    rationale: `The primary's reasoning never weighs the neighbor (${tag}).`, expectedGain: 0.6,
  });
  if (!flagged.ok) throw new Error(JSON.stringify(flagged));
  // The flag asked for a pass on the claim; this file leaves nothing pending behind it.
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1 AND status = 'open'`, [ASSESS_GROUP(claim)]);
  const finding = ok(await executeAuditTool("flag_issue", {
    severity: "low", category: "process", description: `A review cited no policy (${tag}).`, evidence: "The review row.",
    recommendation: "Re-review.", claim_id: claim,
  }));

  // A scoped ingest's focus, kept for the executor.
  const group = `ingest:https://dbtest.example/governance/${tag}#focus:${tag}`;
  await recordIngestFocus(group, `https://dbtest.example/governance/${tag}`, `the ${tag} estimate`);

  // A bounty the mandate posts, a prize claim filed against it (with its Lean
  // source as an attachment), and the audit trail both leave on the claim.
  const prize = await bindableClaim();
  const posting = await seedGrantWithJob({ funderId: await seedUser("governance-prize-funder"), budgetMicroUsd: 2500 * OWL, policy: "cover" });
  const bounty = await requestBounty({
    claimId: prize.claimId, owls: 500, rationale: `A live crux (${tag}).`, grantId: posting.grantId, passStartedAt: new Date(Date.now() - 60_000),
  });
  if (!bounty.ok) throw new Error(JSON.stringify(bounty));
  expect(await openBounty({ bountyId: bounty.bounty_id, passStartedAt: new Date() })).toMatchObject({ ok: true, status: "open" });
  const filed = await filePrizeClaim({
    claimId: prize.claimId, claimant: await claimant(), formalizationId: prize.formalizationId, direction: "proof",
    content: "A written account of the approach, long enough to pass the form's floor. ".repeat(5), links: [],
    leanSource: { filename: "proof.lean", body: Buffer.from(`theorem ${prize.namespace}.proof : ${prize.namespace}.Statement := trivial\n`) },
    documents: [], toolsDisclosure: "Lean 4 and Mathlib; no AI assistance.", residency: { country: "GB", us_person: false },
    creditName: "Ada", declarations: { eligibility: true, understanding: true, cc0: true }, rulesVersion: PRIZE_RULES_VERSION,
  } as Parameters<typeof filePrizeClaim>[0]);
  if (!("prize_claim_id" in filed)) throw new Error(JSON.stringify(filed));

  // A page kept for a user, and the two conversations a user holds.
  const user = await seedUser("governance-reader");
  await creditOwls(user, 20 * OWL);
  const page = await savePage({ userId: user, title: `Where it stands (${tag})`, body: `A brief (${tag}).` });
  if (!page.ok) throw new Error(page.message);
  resetGrantConversationRateLimiter();
  const granting = await startConversation({ userId: user, message: `I want the replication question worked (${tag}).` });
  if (!granting.ok) throw new Error(JSON.stringify(granting));
  await settleGrantConversationTurns();
  const assisting = await startAssistantConversation({ app: stageApp(), user: { id: user, externalId: null }, message: `Where does it stand (${tag})?` });
  if (!assisting.ok) throw new Error(assisting.message);
  await settleAssistantTurns();

  return {
    ids: {
      tag, claim, other, grantId, funder, user, lookoutId: lookout.lookoutId, correspondentId: cid, updateId: update.updateId,
      requestId: request.id, petitionId, contributionId: contribution.id, contributor, pageId: page.page.id,
      grantConversationId: granting.conversation.id, assistantConversationId: assisting.conversation.id,
      prizeClaim: prize.claimId, prizeClaimId: filed.prize_claim_id as string, bountyId: bounty.bounty_id,
    },
    tables: {
      grants: { where: "id = $1", params: [grantId] },
      mandate_policy_versions: { where: "grant_id = $1", params: [grantId] },
      mandate_decisions: { where: "grant_id = $1", params: [grantId] },
      mandate_events: { where: "grant_id = $1", params: [grantId] },
      mandate_inbox: { where: "id = $1", params: [raised!.id] },
      petitions: { where: "id = $1", params: [petitionId] },
      lookouts: { where: "id = $1", params: [lookout.lookoutId] },
      lookout_feeds: { where: "lookout_id = $1", params: [lookout.lookoutId] },
      lookout_events: { where: "lookout_id = $1", params: [lookout.lookoutId] },
      lookout_flags: { where: "lookout_id = $1", params: [lookout.lookoutId] },
      correspondents: { where: "id = $1", params: [cid] },
      correspondent_events: { where: "correspondent_id = $1", params: [cid] },
      correspondent_plan_items: { where: "correspondent_id = $1", params: [cid] },
      correspondent_updates: { where: "id = $1", params: [update.updateId] },
      requests: { where: "id = $1", params: [request.id] },
      request_targets: { where: "request_id = $1", params: [request.id] },
      request_work: { where: "id = $1", params: [work.id] },
      node_messages: { where: "node_id = $1", params: [other] },
      enqueue_events: { where: "claim_id = $1", params: [other] },
      contribution_reviews: { where: "contribution_id = $1", params: [contribution.id] },
      arbitration_results: { where: "contribution_id = $1", params: [contribution.id] },
      reputation_events: { where: "contributor_id = $1", params: [contributor] },
      curation_requests: { where: "anchor_claim_id = $1", params: [claim] },
      consistency_sweeps: { where: "id = $1", params: [sweepId] },
      consistency_flags: { where: "sweep_id = $1", params: [sweepId] },
      audit_findings: { where: "id = $1", params: [finding.finding_id] },
      ingest_focuses: { where: "exclusion_group = $1", params: [group] },
      bounties: { where: "id = $1", params: [bounty.bounty_id] },
      prize_claims: { where: "id = $1", params: [filed.prize_claim_id] },
      attachments: { where: "contribution_id = (SELECT contribution_id FROM prize_claims WHERE id = $1)", params: [filed.prize_claim_id] },
      audit_log: { where: "claim_id = $1", params: [prize.claimId] },
      assistant_pages: { where: "id = $1", params: [page.page.id] },
      grant_conversations: { where: "id = $1", params: [granting.conversation.id] },
      assistant_conversations: { where: "id = $1", params: [assisting.conversation.id] },
    } as Record<string, { where: string; params: unknown[] }>,
  };
}

async function labelsOf(tables: Record<string, { where: string; params: unknown[] }>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, { where, params }] of Object.entries(tables)) {
    // The telemetry row is written off the enqueue's path.
    if (table === "enqueue_events") {
      for (let i = 0; i < 100 && (await labelsWhere(table, where, params)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    }
    out[table] = await labelsWhere(table, where, params);
  }
  return out;
}
const WRITTEN = GOVERNANCE_TABLES.filter((t) => !SEEDED_BY_SCRIPT.includes(t));
const everyTableAt = (label: string) => Object.fromEntries(WRITTEN.map((t) => [t, [label]]));

let app: FastifyInstance;
const stageApp = () => app;

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable by the people it is about.')
     ON CONFLICT (name) DO NOTHING`,
    [SECOND]
  );
  // The platform's own mandates, left active by other files, would fund and
  // open rows of theirs beside the ones this file opens.
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  stage.pages.clear();
  stage.notices = [];
  stage.seen = [];
  stage.sitting = null;
  stage.during = null;
});

describe("the columns", () => {
  it("are on every table of work and governance, public by default, and point at labels", async () => {
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
      [GOVERNANCE_TABLES]
    );
    expect(rows).toEqual(
      GOVERNANCE_TABLES.map((table_name) => ({ table_name, column_default: "'public'::text", is_nullable: "NO", fk: true }))
    );
  });

  it("are on every table but the ones that are left without one on purpose", async () => {
    const rows = await rawQuery<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                             AND c.column_name = 'sensitivity_label')
        ORDER BY t.table_name`
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      // Money placed on the ledger. It also carries a commission's brief
      // and reason, so it is not settled that it should stay without one.
      "action_allocations",
      // Accounts and their keys.
      "api_keys",
      // A per-account allowance: a number.
      "assistant_allowances",
      "contributors",
      // Scorecards of the corpus harness, written by scripts into its own database.
      "eval_runs",
      // The labels themselves.
      "label_reads",
      "labels",
      // Nothing writes or reads it any more.
      "mandate_valuations",
      "oauth_authorization_requests",
      "oauth_clients",
      "oauth_tokens",
      // The owl ledger and what is paid out of it.
      "owl_ledger",
      // Switches and marks the platform keeps for itself.
      "platform_flags",
      "prize_payouts",
      // Counts of what waits, with no content.
      "queue_depth_snapshots",
      // Money moved between two mandates, with a note: as action_allocations.
      "regrants",
      // Database time used by query_sql, per account and day.
      "sql_usage",
    ]);
  });

  it("cannot carry a label no row defines", async () => {
    const grantId = await mandateAt(PUBLIC_LABEL);
    await expect(setLabel("grants", grantId, "undefined-label")).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // A run whose context names one records nothing.
    const summary = `Raised at a label no one defined (${randomUUID()}).`;
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () => raiseToMandate({ grantId, source: "a test", summary }))
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    expect(await labelsWhere("mandate_inbox", "summary = $1", [summary])).toEqual([]);
  });

  it("default to public on a row written without naming one, as a script seeds a prediction", async () => {
    const claim = await settledClaim("governance prediction");
    const [row] = await rawQuery<{ sensitivity_label: string }>(
      `INSERT INTO claim_predictions (claim_id, resolution_criterion, resolution_date, operationalization)
       VALUES ($1, 'It is announced.', '2027-01-01', 'The registry says so.') RETURNING sensitivity_label`,
      [claim]
    );
    expect(row!.sensitivity_label).toBe(PUBLIC_LABEL);
  });
});

describe("a row of work or governance", () => {
  it("written inside a run carries the run's label, in every table", async () => {
    const { tables } = await inRunAt(SECOND, writeOneOfEach);
    expect(Object.keys(tables).sort()).toEqual(WRITTEN);
    expect(await labelsOf(tables)).toEqual(everyTableAt(SECOND));
  });

  it("written outside any run is public, in every table", async () => {
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const { tables } = await writeOneOfEach();
    expect(await labelsOf(tables)).toEqual(everyTableAt(PUBLIC_LABEL));
  });

  it("already there keeps its label when work at another label writes it again", async () => {
    const { ids } = await writeOneOfEach();
    const group = `ingest:https://dbtest.example/governance/kept#focus:${ids.tag}`;
    await recordIngestFocus(group, "https://dbtest.example/governance/kept", "the first focus");
    const site = `https://blog-${ids.tag}.example`;
    stage.pages.set(`${site}/feed`, rss(site, ["a"]));
    await inRunAt(SECOND, async () => {
      // The same scoped ingest, the same feed, the same page saved again, a second message in the conversation.
      await recordIngestFocus(group, "https://dbtest.example/governance/kept", "another focus");
      expect(await addFeed({ grantId: ids.grantId, lookoutId: ids.lookoutId, url: `${site}/feed`, createdBy: "grantmaker:review" })).toMatchObject({ ok: true });
      expect(await savePage({ userId: ids.user, id: ids.pageId, title: "Where it stands now", body: "A later brief." })).toMatchObject({ ok: true });
    });
    expect(await labelsWhere("ingest_focuses", "exclusion_group = $1", [group])).toEqual([PUBLIC_LABEL]);
    expect(await labelsWhere("lookout_feeds", "lookout_id = $1", [ids.lookoutId])).toEqual([PUBLIC_LABEL]);
    expect(await labelOf("assistant_pages", ids.pageId)).toBe(PUBLIC_LABEL);
    const [page] = await rawQuery<{ title: string }>(`SELECT title FROM assistant_pages WHERE id = $1`, [ids.pageId]);
    expect(page!.title).toBe("Where it stands now");
  });
});

// A mandate decides for its work. Its plan, its review, its events and its
// sittings are started by sweeps that run outside any run, and they are
// opened at the mandate's label, whatever the label of a claim they name.
describe("a mandate's work", () => {
  /** Leave only these claims pending, so the Steward lane and the sweep see nothing else. */
  async function onlyPending(claims: string[]): Promise<void> {
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE steward_state = 'pending' AND NOT (id = ANY($1::uuid[]))`, [claims]);
  }

  it("is opened by the scheduler at the mandate's label: the plan's order on a public claim, its ingest, its review", async () => {
    const grantId = await mandateAt(SECOND);
    // A public claim with nothing waiting on it: the order is what asks for its pass.
    const claim = await settledClaim("governance plan item");
    const url = `https://dbtest.example/governance/plan/${randomUUID()}`;
    await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [
        { action: "assess", claim_id: claim, rationale: "first", budget_owls: 3 },
        { action: "ingest", url, rationale: "a source" },
      ] }),
    ]);
    await onlyPending([claim]);
    // The scheduler's sweep runs outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    await reconcileActions();
    expect(await labelOf("claims", claim)).toBe(PUBLIC_LABEL);
    expect(new Set(await assessLabels(claim))).toEqual(new Set([SECOND]));
    expect(await labelsWhere("actions", "exclusion_group = $1", [`ingest:${url}`])).toEqual([SECOND]);
    expect(await labelsWhere("actions", "exclusion_group = $1", [REVIEW_GROUP(grantId)])).toEqual([SECOND]);
    // The message the order left for the node's Steward is the mandate's too.
    expect(await labelsWhere("node_messages", "node_id = $1", [claim])).toEqual([SECOND]);

    // The pass the order pays for runs at it, picked up from outside any run.
    await rawQuery(
      `UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND kind IN ('assess', 'reassess') AND exclusion_group <> $1`,
      [ASSESS_GROUP(claim)]
    );
    expect(await processNextStewardTask()).toMatchObject({ status: "processed", claimId: claim, ok: true });
    expect(stage.seen).toEqual([{ agent: "steward", label: SECOND, brief: "" }]);
  });

  it("is opened at the mandate's label by each seam a sweep reaches, and at the run's when a run does", async () => {
    const grantId = await mandateAt(SECOND);
    const at = () => Promise.resolve(currentLabel());
    expect(await runAtMandateLabel(grantId, at)).toBe(SECOND);
    expect(await runAtMandateLabelOutsideAnyRun(grantId, at)).toBe(SECOND);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => runAtMandateLabel(grantId, at))).toBe(SECOND);
    expect(await runWithUsageContext({ label: PUBLIC_LABEL }, () => runAtMandateLabelOutsideAnyRun(grantId, at))).toBe(PUBLIC_LABEL);
    // A mandate that does not exist has nothing to run at.
    expect(await runAtMandateLabel(randomUUID(), at)).toBe(PUBLIC_LABEL);

    // A standing order placed by a sweep, and one placed from inside a run.
    const swept = await seedClaim("governance order, swept");
    await setLabel("claims", swept, PUBLIC_LABEL);
    expect((await placeStandingOrder({ grantId, claimId: swept, tier: "standard", budgetMicroUsd: 3 * OWL, brief: "A funded mandate scheduled a pass." })).state).toBe("placed");
    expect(new Set(await assessLabels(swept))).toEqual(new Set([SECOND]));
    const inRun = await seedClaim("governance order, in a run");
    await inRunAt(PUBLIC_LABEL, () => placeStandingOrder({ grantId, claimId: inRun, tier: "standard", budgetMicroUsd: 3 * OWL, brief: "A funded mandate scheduled a pass." }));
    expect(new Set(await assessLabels(inRun))).toEqual(new Set([PUBLIC_LABEL]));
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = ANY($1::uuid[])`, [[swept, inRun]]);

    // materializePlanItems, as a route or the retry sweep calls it.
    const formal = await settledClaim("governance formal item");
    await rawQuery(`UPDATE grants SET plan = $2::jsonb, plan_cursor = 0 WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "ingest", url: `https://dbtest.example/governance/plan/${formal}`, rationale: "a source" }] }),
    ]);
    await materializePlanItems(grantId);
    expect(await labelsWhere("actions", "exclusion_group = $1", [`ingest:https://dbtest.example/governance/plan/${formal}`])).toEqual([SECOND]);
  });

  it("has its events collected at its label, and its review woken at it whatever label the row had", async () => {
    const grantId = await mandateAt(SECOND);
    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    const [l] = await rawQuery<{ id: string }>(
      `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers) VALUES ($1, 'Watch', $2, 24, '["manual"]'::jsonb) RETURNING id`,
      [grantId, BRIEF]
    );
    // The flag is the lookout run's, at public here; the event that reports it is the mandate's.
    await flagNote({ lookoutId: l!.id, text: "A note for the review." });
    expect(await labelsWhere("lookout_flags", "lookout_id = $1", [l!.id])).toEqual([PUBLIC_LABEL]);
    expect(await collectMandateEvents(grantId)).toBe(1);
    expect(await labelsWhere("mandate_events", "grant_id = $1", [grantId])).toEqual([SECOND]);
    expect((await pendingMandateEvents(grantId)).total).toBe(1);

    // A review row from an earlier pass, finished, at public: the wake reopens it by UPDATE.
    const row = await seedAction({ group: REVIEW_GROUP(grantId), costMicroUsd: 1, status: "done" });
    await rawQuery(`UPDATE actions SET kind = 'mandate_review', target_ref = $2, updated_at = now() - interval '2 hours' WHERE id = $1`, [row, grantId]);
    expect(await labelOf("actions", row)).toBe(PUBLIC_LABEL);
    expect(await wakeDueMandateReviews()).toBeGreaterThanOrEqual(1);
    const [woken] = await rawQuery<{ status: string; sensitivity_label: string }>(`SELECT status, sensitivity_label FROM actions WHERE id = $1`, [row]);
    expect(woken).toEqual({ status: "open", sensitivity_label: SECOND });
  });
});

describe("an officers' sitting", () => {
  async function waiting(grantId: string, label: string, tag: string) {
    const node = await settledClaim("governance petitioner");
    const file = () => filePetition({ grantId, kind: "more_budget", askedMicroUsd: OWL, plan: `Read the ${tag} replications.`, requesterAgent: "steward", requesterNodeId: node, waiting: false });
    const raise = () => raiseToMandate({ grantId, source: "a lookout", summary: `A ${tag} source worth ingesting.`, targetNodeId: node });
    const petitionId = label === PUBLIC_LABEL ? await file() : await inRunAt(label, file);
    const item = label === PUBLIC_LABEL ? await raise() : await inRunAt(label, raise);
    return { petitionId, itemId: item!.id };
  }

  it("runs at its mandate's label and works only what waits at that label; the rest waits", async () => {
    const grantId = await mandateAt(SECOND);
    const own = await waiting(grantId, SECOND, "embargoed-label");
    const others = await waiting(grantId, PUBLIC_LABEL, "public-label");
    expect(await labelOf("petitions", own.petitionId)).toBe(SECOND);
    expect(await labelOf("petitions", others.petitionId)).toBe(PUBLIC_LABEL);

    stage.sitting = async (execute, brief) => {
      const label = /\[(p\d+)\]/.exec(brief)?.[1] ?? "p1";
      ok(await execute("decide_petitions", { decisions: [{ petition: label, decision: "refuse", reason: "Not this week." }] }));
    };
    // The sitting is held from outside any run, as the scheduler holds it.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    await workMandateInbox(grantId);

    const officer = stage.seen.find((s) => s.agent === "program_officer")!;
    expect(officer.label).toBe(SECOND);
    expect(officer.brief).toContain("embargoed-label replications");
    expect(officer.brief).toContain("embargoed-label source");
    expect(officer.brief).not.toContain("public-label");
    // What it decided, and the row that paid for it, are at the mandate's label.
    expect((await getPetition(own.petitionId))!.status).toBe("refused");
    expect(await labelsWhere("mandate_decisions", "petition_id = $1", [own.petitionId])).toEqual([SECOND]);
    expect(await labelsWhere("actions", "kind = 'officer_run' AND target_ref = $1", [grantId])).toEqual([SECOND]);
    // What was raised at another label is as it was: not decided, not escalated, not handled.
    expect((await getPetition(others.petitionId))!.status).toBe("pending");
    const [item] = await rawQuery<{ handled_at: Date | null; escalated_at: Date | null }>(
      `SELECT handled_at, escalated_at FROM mandate_inbox WHERE id = $1`,
      [others.itemId]
    );
    expect(item).toEqual({ handled_at: null, escalated_at: null });
  });

  it("is held at the mandate's label by a petitioner's run at another, and is not held for what waits at another label alone", async () => {
    const grantId = await mandateAt(PUBLIC_LABEL);
    await waiting(grantId, SECOND, "embargoed-label");
    // Only items of another label wait: the sweep finds nothing to sit for, and a sitting held anyway opens no run.
    await rawQuery(`UPDATE grants SET officer_lease_until = now() + interval '1 hour' WHERE id <> $1`, [grantId]);
    try {
      expect(await workWaitingInboxes()).toBe(0);
      await inRunAt(SECOND, () => workMandateInbox(grantId));
      expect(stage.seen).toEqual([]);
      // With something of its own label waiting, a sitting held from a run at another label runs at the mandate's.
      await waiting(grantId, PUBLIC_LABEL, "public-label");
      await inRunAt(SECOND, () => workMandateInbox(grantId));
      expect(stage.seen.map((s) => [s.agent, s.label])).toEqual([["program_officer", PUBLIC_LABEL]]);
      expect(stage.seen[0]!.brief).not.toContain("embargoed-label");
    } finally {
      await rawQuery(`UPDATE grants SET officer_lease_until = NULL`);
    }
  });

  it("names a petition's columns, so its label does not ride along", async () => {
    expect(PETITION_COLUMNS).not.toContain("sensitivity_label");
    const grantId = await mandateAt(PUBLIC_LABEL);
    const { petitionId } = await waiting(grantId, SECOND, "embargoed-label");
    expect(Object.keys((await getPetition(petitionId))!)).not.toContain("sensitivity_label");
  });

  it("reads a lookout and a correspondent by named columns too", async () => {
    // The agents' own reads of the two used to take every column (l.*, c.*).
    const grantId = await mandateAt(PUBLIC_LABEL);
    const lookout = await createLookout({ grantId, title: "Watch", brief: BRIEF, heartbeatHours: 24, triggers: ["manual"], createdBy: "grantmaker:review" });
    const correspondent = await createCorrespondent({
      grantId, title: "Reporter", brief: "Tell the audience when the standing of the claims in scope changes materially.",
      audience: "People who follow this question.", scopeClaimIds: [await settledClaim("governance named columns")],
      heartbeatHours: 24, triggers: ["manual"], createdBy: "grantmaker:review",
    });
    if (!lookout.ok || !correspondent.ok) throw new Error(JSON.stringify([lookout, correspondent]));
    expect(Object.keys((await getLookout(lookout.lookoutId))!)).not.toContain("sensitivity_label");
    expect(Object.keys((await getCorrespondent(correspondent.correspondentId))!)).not.toContain("sensitivity_label");
  });
});

describe("a lookout's and a correspondent's work", () => {
  async function lookoutAt(label: string, triggers: string[]) {
    const grantId = await mandateAt(PUBLIC_LABEL);
    const [l] = await rawQuery<{ id: string }>(
      `INSERT INTO lookouts (grant_id, title, brief, heartbeat_hours, triggers, sensitivity_label)
       VALUES ($1, 'Feed watch', $2, 24, $3::jsonb, $4) RETURNING id`,
      [grantId, BRIEF, JSON.stringify(triggers), label]
    );
    return { grantId, lookoutId: l!.id };
  }

  it("is done by the feed poller at the lookout's label: the items it records and the wake it queues", async () => {
    const { grantId, lookoutId } = await lookoutAt(SECOND, ["feed"]);
    const site = `https://blog-${randomUUID().slice(0, 8)}.example`;
    stage.pages.set(`${site}/feed`, rss(site, ["a"]));
    // The Grantmaker adds the feed in a public run: the feed, and what it held then, are that run's.
    const feed = await inRunAt(PUBLIC_LABEL, () => addFeed({ grantId, lookoutId, url: `${site}/feed`, rule: { wake: "each" }, createdBy: "grantmaker:chat" }));
    if (!feed.ok) throw new Error(JSON.stringify(feed));
    await rawQuery(`UPDATE lookout_feeds SET next_poll_at = now() - interval '1 minute' WHERE id = $1`, [feed.feed_id]);
    await rawQuery(`UPDATE lookout_feeds SET next_poll_at = now() + interval '1 day' WHERE id <> $1`, [feed.feed_id]);

    // The poller's tick runs outside any run.
    stage.pages.set(`${site}/feed`, rss(site, ["a", "b"]));
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await feedPollTick()).toMatchObject({ polled: 1, failed: 0, newItems: 1, woke: 1 });
    const items = (
      await rawQuery<{ url: string; sensitivity_label: string }>(
        `SELECT url, sensitivity_label FROM lookout_feed_items WHERE lookout_id = $1`,
        [lookoutId]
      )
    ).sort((a, b) => (a.url < b.url ? -1 : 1));
    expect(items).toEqual([
      { url: `${site}/p/a`, sensitivity_label: PUBLIC_LABEL },
      { url: `${site}/p/b`, sensitivity_label: SECOND },
    ]);
    expect(await labelsWhere("lookout_events", "lookout_id = $1 AND kind = 'feed'", [lookoutId])).toEqual([SECOND]);

    // The event makes the lookout due, and its run is opened at its label by the sweep.
    await reconcileActions();
    expect(await labelsWhere("actions", "exclusion_group = $1", [LOOKOUT_GROUP(lookoutId)])).toEqual([SECOND]);
  });

  it("is queued by the retraction poll at each lookout's label", async () => {
    const restricted = await lookoutAt(SECOND, ["retraction"]);
    const open = await lookoutAt(PUBLIC_LABEL, ["retraction"]);
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, doi) VALUES ($1, 'A paper', $2) RETURNING id`,
      [`https://doi.org/${doi}`, doi]
    );
    const claim = await settledClaim("governance retraction");
    await rawQuery(`INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'It found the effect.')`, [claim, source!.id]);
    stage.notices = [{
      notice_doi: `${doi}.n1`, retracted_dois: [doi], type: "retraction", title: `Retraction of ${doi}`,
      updated: "2026-09-10T00:00:00Z", source: "publisher",
    }];
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const r = await retractionPollTick({ force: true });
    expect(r.eventsQueued).toBeGreaterThanOrEqual(2);
    expect(await labelsWhere("lookout_events", "lookout_id = $1 AND kind = 'retraction'", [restricted.lookoutId])).toEqual([SECOND]);
    expect(await labelsWhere("lookout_events", "lookout_id = $1 AND kind = 'retraction'", [open.lookoutId])).toEqual([PUBLIC_LABEL]);
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  });

  it("is queued and opened for a correspondent at the correspondent's label", async () => {
    const grantId = await mandateAt(PUBLIC_LABEL);
    const claim = await settledClaim("governance correspondent scope");
    const made = await createCorrespondent({
      grantId, title: "Reporter", brief: "Tell the audience when the standing of the claims in scope changes materially.",
      audience: "People who follow this question.", scopeClaimIds: [claim], heartbeatHours: 0, triggers: ["graph_change"], createdBy: "grantmaker:review",
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const id = made.correspondentId;
    await setLabel("correspondents", id, SECOND);
    await rawQuery(`UPDATE correspondents SET changes_cursor = NULL, created_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    // Something material changes in its scope: a judgment on the claim.
    ok(await (await import("../../src/llm/tools/steward-tools.js")).executeStewardTool("update_claim_assessment", {
      claim_id: claim, status: "supported", confidence: 0.7, assessment: "Judged for the change scan.", reasoning_trace: "dbtest",
    }));
    // The scan is a timer, outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect((await graphChangeScanTick()).queued).toBeGreaterThanOrEqual(1);
    expect(await labelsWhere("correspondent_events", "correspondent_id = $1", [id])).toEqual([SECOND]);
    // The wake makes it due, and the sweep opens its run at its label.
    await reconcileActions();
    expect(await labelsWhere("actions", "exclusion_group = $1", [CORRESPONDENT_GROUP(id)])).toEqual([SECOND]);
  });
});

// A claim has one pending slot, and no row says what label the pass it waits
// for was asked at. The messages waiting on it do, when they agree.
describe("a claim left pending by the messages waiting on it", () => {
  /** A public claim, mid-pass, that a message at `labels` reaches; the pass then ends and the claim is pending. */
  async function repended(labels: string[]): Promise<string> {
    const claim = await seedClaim("governance repended");
    const row = await seedAction({ group: ASSESS_GROUP(claim), claimId: claim, costMicroUsd: 1, status: "running" });
    await rawQuery(`UPDATE claims SET steward_state = 'running', stewarded_at = now() WHERE id = $1`, [claim]);
    for (const label of labels) {
      const send = () => enqueueSteward({ claimId: claim, trigger: "steward_note", context: `A note at ${label}.` });
      await (label === PUBLIC_LABEL ? send() : inRunAt(label, send));
    }
    // The message joined the running pass's slot: the claim is still running, the row still the pass's.
    expect(await labelOf("actions", row)).toBe(PUBLIC_LABEL);
    // The pass ends without having read it, and the claim goes back to pending.
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [row]);
    await rawQuery(`UPDATE claims SET steward_state = 'pending', steward_requeued = false WHERE id = $1`, [claim]);
    return claim;
  }
  const sweepOnly = async (claims: string[]) => {
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE steward_state = 'pending' AND NOT (id = ANY($1::uuid[]))`, [claims]);
    await reconcileActions();
  };

  it("is taken up at the label of those messages, not the claim's", async () => {
    const claim = await repended([SECOND]);
    expect(await labelOf("claims", claim)).toBe(PUBLIC_LABEL);
    expect(await pendingPassLabel(claim, PUBLIC_LABEL)).toBe(SECOND);
    await sweepOnly([claim]);
    expect(new Set(await assessLabels(claim))).toEqual(new Set([SECOND]));
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  });

  it("is taken up at the claim's label when messages of two labels wait, and that pass reads them all", async () => {
    const claim = await repended([SECOND, PUBLIC_LABEL]);
    expect(await labelsWhere("node_messages", "node_id = $1 AND read_at IS NULL", [claim])).toEqual([SECOND, PUBLIC_LABEL].sort());
    expect(await pendingPassLabel(claim, PUBLIC_LABEL)).toBe(PUBLIC_LABEL);
    await sweepOnly([claim]);
    expect(new Set(await assessLabels(claim))).toEqual(new Set([PUBLIC_LABEL]));
    // What that pass is shown: every unread message, whatever its label. One
    // slot per claim cannot keep them apart; that is later work.
    const inbox = await openInbox(claim);
    expect(inbox.ids).toHaveLength(2);
    expect(inbox.brief).toContain(`A note at ${SECOND}.`);
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  });

  it("is run by the Steward's fallback lane at the label of those messages", async () => {
    const config = loadConfig();
    const before = {
      backgroundFallbackLaneEnabled: config.backgroundFallbackLaneEnabled,
      backgroundDailyBudgetOwls: config.backgroundDailyBudgetOwls,
    };
    // The lane as a deployment with no General mandate turns it on, with no daily budget to count against.
    Object.assign(config, { backgroundFallbackLaneEnabled: true, backgroundDailyBudgetOwls: 0 });
    try {
      const claim = await repended([SECOND]);
      // Nothing on the ledger is covered, so the lane falls through to its own pick: the pending claim with the highest priority.
      await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND kind IN ('assess', 'reassess')`);
      await rawQuery(`UPDATE claims SET queue_priority = 99 WHERE id = $1`, [claim]);
      expect(currentLabel()).toBe(PUBLIC_LABEL);
      expect(await processNextStewardTask()).toMatchObject({ status: "processed", claimId: claim, ok: true });
      expect(stage.seen).toEqual([{ agent: "steward", label: SECOND, brief: "" }]);
      await rawQuery(`UPDATE claims SET queue_priority = 0.5 WHERE id = $1`, [claim]);
    } finally {
      Object.assign(config, before);
    }
  });

  it("is taken up at the claim's label when no message waits", async () => {
    const claim = await seedClaim("governance pending, no message");
    await setLabel("claims", claim, SECOND);
    expect(await pendingPassLabel(claim, SECOND)).toBe(SECOND);
    await sweepOnly([claim]);
    expect(new Set(await assessLabels(claim))).toEqual(new Set([SECOND]));
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  });
});

describe("work a timer or another run starts for a row", () => {
  it("is a petition's follow-up, commissioned by the sweep at the petition's label", async () => {
    const grantId = await mandateAt(PUBLIC_LABEL);
    const node = await settledClaim("governance follow-up");
    const asked = await seedAction({ group: `governance-asked:${randomUUID()}`, claimId: node, costMicroUsd: 1, status: "done" });
    const petitionId = await inRunAt(SECOND, () =>
      filePetition({ grantId, kind: "follow_up", askedMicroUsd: 2 * OWL, plan: "Read the three replications.", requesterAgent: "steward", requesterActionId: asked, requesterNodeId: node, waiting: false })
    );
    await rawQuery(`UPDATE petitions SET status = 'follow_up', granted_micro_usd = $2, decided_by = 'officer' WHERE id = $1`, [petitionId, 2 * OWL]);
    // The scheduler's sweep, outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await sweepFollowUps()).toBeGreaterThanOrEqual(1);
    expect(new Set(await assessLabels(node))).toEqual(new Set([SECOND]));
    expect(await labelsWhere("node_messages", "node_id = $1", [node])).toEqual([SECOND]);
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [node]);
  });

  it("is a request's next row, reopened at the request's label by whoever reopens it", async () => {
    const claim = await settledClaim("governance request");
    const request = await inRunAt(SECOND, () =>
      fileRequest({
        ask: `Reproduce the estimate (${randomUUID()}).`, why: "The claim rests on it.", satisfiedBy: "A table of the estimate.",
        claimIds: [claim], filer: { kind: "admin", agent: "claim_steward" },
      })
    );
    const group = `request:${request.id}`;
    expect(await labelsWhere("actions", "exclusion_group = $1", [group])).toEqual([SECOND]);
    // The row finishes; a route, outside any run, asks for the request's next piece of work.
    await rawQuery(`UPDATE actions SET status = 'done' WHERE exclusion_group = $1`, [group]);
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await ensureRequestActions(request.id)).not.toBeNull();
    const rows = await rawQuery<{ status: string; sensitivity_label: string }>(
      `SELECT status, sensitivity_label FROM actions WHERE exclusion_group = $1 AND status = 'open'`,
      [group]
    );
    expect(rows).toEqual([{ status: "open", sensitivity_label: SECOND }]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE exclusion_group = $1`, [group]);
  });

  it("is the Curator's row for a request it keeps, opened at the request's label", async () => {
    const a = await settledClaim("governance kept request, one");
    const b = await settledClaim("governance kept request, two");
    // A request bearing on two nodes is the Curator's to keep.
    const request = await inRunAt(SECOND, () =>
      fileRequest({
        ask: `Say which of the two the survey supports (${randomUUID()}).`, why: "They disagree.", satisfiedBy: "A reading of the survey.",
        claimIds: [a, b], filer: { kind: "admin", agent: "curator" },
      })
    );
    // Work comes back and the keeper is told, from outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const row = await ensureRequestCurateAction(request.id);
    expect(row).not.toBeNull();
    expect(await labelOf("actions", row!)).toBe(SECOND);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE target_ref = $1`, [request.id]);
  });

  it("is the reclaim sweep's entry on a prize claim's record, at the prize claim's label", async () => {
    const { ids } = await inRunAt(SECOND, writeOneOfEach);
    await rawQuery(`UPDATE prize_claims SET status = 'checking', updated_at = now() - interval '2 days' WHERE id = $1`, [ids.prizeClaimId]);
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await reclaimStalePrizeChecks()).toBeGreaterThanOrEqual(1);
    expect(await labelsWhere("audit_log", "claim_id = $1 AND created_by = 'prize_check_pipeline'", [ids.prizeClaim])).toEqual([SECOND]);
  });

  it("is an expired session's unshown answer, sent to its node's inbox at the session's label", async () => {
    const node = await settledClaim("governance expired session");
    const id = randomUUID();
    await rawQuery(
      `INSERT INTO agent_sessions (id, role, node_id, status, replies, deadline, sensitivity_label)
       VALUES ($1, 'curator', $2, 'waiting', $3::jsonb, now() - interval '1 minute', $4)`,
      [id, node, JSON.stringify([{ kind: "research", ref: randomUUID(), text: "The 2019 edition.", at: new Date().toISOString(), delivered: false }]), SECOND]
    );
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    expect(await sweepSessions()).toBeGreaterThanOrEqual(1);
    const messages = await rawQuery<{ trigger: string; body: string; sensitivity_label: string }>(
      `SELECT trigger, body, sensitivity_label FROM node_messages WHERE node_id = $1`,
      [node]
    );
    expect(messages).toEqual([{ trigger: "research_report", body: "The 2019 edition.", sensitivity_label: SECOND }]);
  });
});

describe("what a reader is shown", () => {
  let rows: Awaited<ReturnType<typeof writeOneOfEach>>;

  beforeAll(async () => {
    // Written at the second label, so a response that carried the column would carry a value to see.
    rows = await inRunAt(SECOND, writeOneOfEach);
  });

  const carriesIt = (text: string) => /sensitivity[_ ]?label/i.test(text);
  /** The label's name as a JSON value, which no response has another reason to hold. */
  const namesIt = (text: string) => text.includes(`"${SECOND}"`);

  it("has no view query_sql reads that exposes the column", async () => {
    // The public_read views name their columns, and Postgres stores a view
    // with its columns spelled out, so a column added to a table a view
    // reads does not appear in it.
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND column_name = 'sensitivity_label'`
    );
    expect(exposed).toEqual([]);
    // The views that read a table altered here still read their rows, without it.
    const readers = await rawQuery<{ viewname: string }>(
      `SELECT viewname FROM pg_views
        WHERE schemaname = 'public_read'
          AND definition ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\M')
        ORDER BY viewname`,
      [GOVERNANCE_TABLES]
    );
    expect(readers.map((r) => r.viewname)).toEqual(["changes", "mandate_decisions", "mandates", "messages", "petitions", "plan_items", "requests"]);
    const { ids } = rows;
    const reads: Array<[string, string, unknown[]]> = [
      ["mandates", "mandate_id = $1", [ids.grantId]],
      ["mandate_decisions", "mandate_id = $1", [ids.grantId]],
      ["petitions", "petition_id = $1", [ids.petitionId]],
      ["requests", "request_id = $1", [ids.requestId]],
      ["messages", "node_id = $1", [ids.other]],
    ];
    for (const [view, where, params] of reads) {
      const found = await rawQuery<Record<string, unknown>>(`SELECT * FROM public_read.${view} WHERE ${where}`, params);
      expect(found.length, view).toBeGreaterThan(0);
      expect(carriesIt(JSON.stringify(found)), view).toBe(false);
      expect(namesIt(JSON.stringify(found)), view).toBe(false);
    }
  });

  it("has no response of the mandate, request, correspondent, prize, contribution or claim routes that carries it", async () => {
    const { ids } = rows;
    const urls: Array<[string, Record<string, string>?]> = [
      [`/mandates`],
      [`/mandates/${ids.grantId}`],
      [`/mandates/${ids.grantId}/allocation`],
      [`/mandates/${ids.grantId}/lookouts/${ids.lookoutId}`],
      [`/grants`, SERVICE],
      [`/grants/${ids.grantId}`, SERVICE],
      [`/requests`],
      [`/requests/${ids.requestId}`],
      [`/correspondents`],
      [`/correspondents/${ids.correspondentId}`],
      [`/correspondents/${ids.correspondentId}/updates`],
      [`/correspondents/${ids.correspondentId}/updates/${ids.updateId}`],
      [`/correspondents/${ids.correspondentId}/feed`],
      [`/contributions/${ids.contributionId}`],
      [`/contributions?claim_id=${ids.claim}`],
      [`/prizes`],
      [`/claims/${ids.prizeClaim}/bounty`],
      [`/claims/${ids.prizeClaim}/prize-claims`],
      [`/prize-claims/${ids.prizeClaimId}`, SERVICE],
      [`/operator/prizes`, SERVICE],
      [`/consistency`],
      [`/queue`, SERVICE],
      [`/changes`],
      ...["cursory", "standard", "deep"].map((d): [string] => [`/claims/${ids.claim}?information_depth=${d}`]),
      [`/claims/${ids.other}?information_depth=deep`],
      [`/claims/${ids.claim}/events`],
      [`/claims/${ids.prizeClaim}/events`],
      [`/claims/${ids.claim}/record`],
    ];
    const answered = new Map<string, string>();
    for (const [url, headers] of urls) {
      const res = await app.inject({ method: "GET", url, headers });
      // A route that needs a key or finds nothing has shown nothing either way.
      if (res.statusCode === 200) answered.set(url, res.body);
      expect(carriesIt(res.body), `${url} (${res.statusCode})`).toBe(false);
      expect(namesIt(res.body), `${url} (${res.statusCode})`).toBe(false);
    }
    // The check means something only if the routes answered with the rows.
    expect([...answered.keys()]).toEqual(expect.arrayContaining([
      `/mandates/${ids.grantId}`,
      `/mandates/${ids.grantId}/lookouts/${ids.lookoutId}`,
      `/requests/${ids.requestId}`,
      `/correspondents/${ids.correspondentId}`,
      `/correspondents/${ids.correspondentId}/updates`,
      `/contributions/${ids.contributionId}`,
      `/claims/${ids.prizeClaim}/bounty`,
      `/claims/${ids.claim}?information_depth=deep`,
      `/claims/${ids.claim}/events`,
    ]));
    expect(answered.get(`/mandates/${ids.grantId}`)).toContain(ids.tag);
    expect(answered.get(`/mandates/${ids.grantId}/lookouts/${ids.lookoutId}`)).toContain(`Watch ${ids.tag}`);
    expect(answered.get(`/requests/${ids.requestId}`)).toContain(ids.tag);
    expect(answered.get(`/correspondents/${ids.correspondentId}/updates`)).toContain(ids.tag);
    expect(answered.get(`/contributions/${ids.contributionId}`)).toContain(ids.tag);
    expect(answered.get(`/claims/${ids.prizeClaim}/bounty`)).toContain(ids.bountyId);
  });

  it("has no conversation, page, mandate or agent's read that carries it", async () => {
    const { ids } = rows;
    const reads: Array<[string, () => Promise<string | null>, string]> = [
      // What the Assistant's and the Grantmaker's chats, and a user's pages, serve.
      ["the Assistant's conversation", async () => JSON.stringify(await serializeAssistantConversation((await getAssistantConversation(ids.assistantConversationId, ids.user))!)), ids.tag],
      ["the granting conversation", async () => JSON.stringify(serializeConversation((await getConversation(ids.grantConversationId, ids.user))!, {})), ids.tag],
      ["the granting conversation, listed", async () => JSON.stringify(serializeConversationSummary((await getConversation(ids.grantConversationId, ids.user))!)), ids.grantConversationId],
      ["the mandate, to its funder", async () => JSON.stringify(await serializeGrant((await getGrant(ids.grantId, ids.funder))!)), ids.tag],
      ["a page", async () => JSON.stringify(await serializePage((await getPage(ids.pageId, ids.user))!)), ids.tag],
      ["a correspondent", async () => JSON.stringify(correspondentPublic((await getCorrespondent(ids.correspondentId))!)), ids.tag],
      ["a correspondent's updates", async () => JSON.stringify(await listCorrespondentUpdates(ids.correspondentId)), ids.tag],
      ["a lookout", async () => JSON.stringify(await getLookout(ids.lookoutId)), ids.tag],
      ["a lookout's flags", async () => JSON.stringify(await listLookoutFlags(ids.lookoutId)), ids.tag],
      ["a mandate's pending events", async () => JSON.stringify(await pendingMandateEvents(ids.grantId)), "lookout_flag"],
      ["a request", async () => JSON.stringify(await getRequest(ids.requestId)), ids.tag],
      ["a petition", async () => JSON.stringify(await getPetition(ids.petitionId)), ids.tag],
      // What the agents read with their tools.
      ["get_request", () => createResearcherReadTools({ requests: true }).execute("get_request", { request_id: ids.requestId }), ids.tag],
      ["get_claim", () => executeGraphReadTool("get_claim", { claim_id: ids.other }), ids.other],
      ["get_contribution_details", () => executeGovernanceTool("get_contribution_details", { contribution_id: ids.contributionId }), ids.tag],
      ["get_review_history", () => executeGovernanceTool("get_review_history", { contribution_id: ids.contributionId, include_pending: true }), "filed_by"],
      ["get_recent_decisions", () => executeGovernanceTool("get_recent_decisions", { limit: 50 }), "decision"],
      ["get_recent_arbitrations", () => executeAuditTool("get_recent_arbitrations", { limit: 50 }), "outcome"],
      ["get_audit_findings", () => executeAuditTool("get_audit_findings", { limit: 50 }), ids.tag],
      ["a node's inbox", async () => (await openInbox(ids.claim)).brief + "inbox", "inbox"],
    ];
    for (const [tool, read, shows] of reads) {
      const out = await read();
      expect(out, tool).not.toBeNull();
      // The check means something only if the read returned the rows.
      expect(out!, tool).toContain(shows);
      expect(carriesIt(out!), tool).toBe(false);
      expect(namesIt(out!), tool).toBe(false);
    }
  });

  it("has no officers' brief, and no write tool's reply, that carries it", async () => {
    const grantId = await mandateAt(SECOND);
    const node = await settledClaim("governance brief");
    await inRunAt(SECOND, async () => {
      await filePetition({ grantId, kind: "more_budget", askedMicroUsd: OWL, plan: "Read the replications.", requesterAgent: "steward", requesterNodeId: node, waiting: false });
      await raiseToMandate({ grantId, source: "a lookout", summary: "A source worth ingesting.", targetNodeId: node });
    });
    const replies: string[] = [];
    stage.sitting = async (execute, brief) => {
      const label = /\[(p\d+)\]/.exec(brief)?.[1] ?? "p1";
      replies.push(await execute("decide_petitions", { decisions: [{ petition: label, decision: "refuse", reason: "Not this week." }] }));
      replies.push(await execute("log_note", { note: "Nothing else to decide." }));
    };
    await workMandateInbox(grantId);
    const sitting = stage.seen.find((s) => s.agent === "program_officer")!;
    expect(sitting.brief).toContain("Read the replications.");
    // Both of the sitting's decisions, the petition's and the note the officer logged, are at its label.
    const decisions = await rawQuery<{ item_kind: string; sensitivity_label: string }>(
      `SELECT item_kind, sensitivity_label FROM mandate_decisions WHERE grant_id = $1 ORDER BY item_kind`,
      [grantId]
    );
    expect(decisions.map((d) => d.sensitivity_label)).toEqual([SECOND, SECOND]);
    for (const text of [sitting.brief, ...replies]) {
      expect(carriesIt(text), text.slice(0, 200)).toBe(false);
      expect(namesIt(text), text.slice(0, 200)).toBe(false);
    }
    // And the tool the Grantmaker's review uses on the same rows, called directly.
    const reply = await executeOfficerTool("log_note", { note: "A note." }, {
      grant: { id: grantId, title: "t", objective: "o", budget_job_id: "", funder_user_id: "", daily: 0, escrow: 0 },
      role: "officer", labels: new Map(), limitMicroUsd: 0, decidedBy: "officer",
    } as never);
    expect(carriesIt(reply)).toBe(false);
  });
});
