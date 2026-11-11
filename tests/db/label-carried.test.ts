/**
 * A run works at the label of the work that started it (src/labels.ts).
 *
 * For each row that stands for work waiting to be done (a ledger action, a
 * job, an order, a budget job, a contribution, an appeal, a paused session,
 * the claim pipeline's message), against real Postgres and the real workers:
 * work created inside a run takes the run's label; the worker that later
 * picks it up, from outside any run, opens its run at that label; what that
 * run enqueues carries it on; and work created outside any run is public.
 *
 * No model is called. Each agent's entry point is replaced by a stand-in
 * that opens a real run (withAgent), writes a source through the real write
 * seam, and does whatever the test asks of it. Everything between the
 * enqueue and the stand-in is the code that runs in production.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

interface Seen {
  agent: string;
  label: string;
  runId: string;
  sourceId: string;
  input: unknown;
}

const stage = vi.hoisted(() => {
  // Tracing is off under vitest by default; the run row is part of what is checked.
  process.env.TRACE_LEVEL = "full";
  process.env.RESEARCHER_ENABLED = "true";
  const stage = {
    seen: [] as Seen[],
    /** What the next stand-in run does while it is open: the child work of a test. */
    during: null as null | ((seen: Seen) => Promise<void>),
    /** What the Extractor stand-in returns. */
    extracted: [] as Array<Record<string, unknown>>,
    /** An agent run in place of the model: a real run row, a real source, then `during`. */
    async standIn(agent: string, input: unknown): Promise<void> {
      const { withAgent, getUsageContext, currentLabel } = await import("../../src/llm/usage-context.js");
      const { getOrCreateSource } = await import("../../src/services/source-service.js");
      const { randomUUID: uuid } = await import("node:crypto");
      await withAgent(agent, async () => {
        const trace = getUsageContext().trace!;
        await trace.ready;
        const source = await getOrCreateSource({ url: `https://dbtest.example/carried/${uuid()}` });
        const seen: Seen = { agent, label: currentLabel(), runId: trace.runId, sourceId: source.id, input };
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
vi.mock("../../src/llm/agents/researcher.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/agents/researcher.js")>()),
  runResearcher: vi.fn(async (input: unknown) => {
    await stage.standIn("researcher", input);
    return { status: "completed", report: { answer: "Both rest on the 2019 survey." }, turns: 1, stopReason: "report", servedModels: [], toolNames: [], error: null };
  }),
}));
vi.mock("../../src/llm/agents/curator.js", () => ({
  runCurator: vi.fn((input: unknown, resume?: unknown) => stage.standIn("curator", { input, resume })),
}));
vi.mock("../../src/llm/agents/extractor.js", () => ({
  extractClaims: vi.fn(async (input: unknown) => {
    await stage.standIn("extractor", input);
    return stage.extracted;
  }),
}));
vi.mock("../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () => ({
    outcome: "new", is_match: false, matched_claim_id: null, new_canonical_form: null, instance_stance: "affirms",
  })),
}));
vi.mock("../../src/llm/agents/contribution-reviewer.js", () => ({
  runContributionReview: vi.fn((input: unknown) => stage.standIn("contribution_reviewer", input)),
}));
vi.mock("../../src/llm/agents/dispute-arbitrator.js", () => ({
  runArbitration: vi.fn((input: unknown) => stage.standIn("dispute_arbitrator", input)),
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
import { MissingLabelError, PUBLIC_LABEL, UndefinedLabelError } from "../../src/labels.js";
import { currentLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { claimAction } from "../../src/services/action-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { createDeepDecompositionJob } from "../../src/services/budget-job-service.js";
import { createAppeal, createContribution } from "../../src/services/contribution-service.js";
import { createOrder } from "../../src/services/order-service.js";
import { publicIsTheOnlyLabel } from "../../src/services/label-service.js";
import {
  enqueueClaimPipeline,
  enqueueSteward,
  getLocalQueue,
  type ClaimPipelineMessage,
  type PreLabelClaimPipelineMessage,
} from "../../src/services/queue-service.js";
import { commissionResearch } from "../../src/services/research-commission-service.js";
import { deliverReply, suspendSession, takeReadySession } from "../../src/services/session-service.js";
import { submitSource } from "../../src/services/source-service.js";
import { startTextAnalysis, settleTextAnalyses } from "../../src/services/text-analysis-service.js";
import { handleArbitrationMessage } from "../../src/workers/arbitration-pipeline.js";
import { processNextBudgetJobTask } from "../../src/workers/budget-job-pipeline.js";
import { handleClaimPipeline } from "../../src/workers/claim-pipeline.js";
import { handleContributionMessage } from "../../src/workers/contribution-pipeline.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";
import { processNextOrderTask } from "../../src/workers/order-pipeline.js";
import { sweepStalledReviewWork } from "../../src/workers/recovery-sweep.js";
import { processNextStewardTask } from "../../src/workers/steward-pipeline.js";
import { handleUrlExtraction } from "../../src/workers/url-extraction.js";
import { OWL, creditOwls, seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const INTERNAL = "internal";
const FOREIGN_KEY_VIOLATION = "23503";

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Work done from inside a run at `label`, as an agent's tool call does it. */
function inRunAt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runWithUsageContext({ label }, () => withAgent("steward", fn));
}

async function labelOf(table: string, id: string): Promise<string | undefined> {
  const [row] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM ${table} WHERE id = $1`,
    [id]
  );
  return row?.sensitivity_label;
}

/** The labels on a claim's assess rows, one per variant. */
async function assessLabels(claimId: string): Promise<string[]> {
  const rows = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM actions WHERE exclusion_group = $1`,
    [`assess:${claimId}`]
  );
  return rows.map((r) => r.sensitivity_label);
}

/** What a stand-in run wrote, read back: the run row's label and its source's. */
async function written(seen: Seen) {
  return {
    inRun: seen.label,
    run: await labelOf("agent_runs", seen.runId),
    source: await labelOf("sources", seen.sourceId),
  };
}
const all = (label: string) => ({ inRun: label, run: label, source: label });

/** Take the queued claim pipeline message for a claim out of the in-memory queue. */
function takePipelineMessage(claimId: string): ClaimPipelineMessage | undefined {
  const queue = getLocalQueue("claimPipeline");
  const at = queue.findIndex((m) => m.claimId === claimId);
  return at < 0 ? undefined : queue.splice(at, 1)[0];
}

/** Cover a claim's assess group and run the Steward lane on it alone. */
async function runFundedPass(claimId: string) {
  const funder = await seedUser("carried-funder");
  await seedAllocation({ group: `assess:${claimId}`, claimId, userId: funder, amountMicroUsd: 500 * OWL });
  await rawQuery(
    `UPDATE actions SET status = 'cancelled'
      WHERE status = 'open' AND kind IN ('assess', 'reassess') AND exclusion_group <> $1`,
    [`assess:${claimId}`]
  );
  return processNextStewardTask();
}

/** Run only the open rows in this group, as the engine executor would pick them. */
async function runOnly(group: string) {
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND exclusion_group <> $1`, [group]);
  return processNextEngineAction();
}

async function mandate(): Promise<string> {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("carried-mandate"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', daily_budget_micro_usd = 0 WHERE id = $1`, [grantId]);
  return grantId;
}

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable inside the organization.')
     ON CONFLICT (name) DO NOTHING`,
    [INTERNAL]
  );
  // The lanes under test run what one payer commissioned; the platform's own
  // mandates, left active by other files, would fund and open rows of theirs.
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

beforeEach(() => {
  stage.seen = [];
  stage.during = null;
  stage.extracted = [];
});

describe("the columns", () => {
  it("are on every table that stands for work waiting, public by default, and point at labels", async () => {
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
      [["actions", "agent_sessions", "appeals", "assessment_orders", "assistant_held_actions", "budget_jobs", "contributions", "jobs"]]
    );
    expect(rows).toEqual(
      ["actions", "agent_sessions", "appeals", "assessment_orders", "assistant_held_actions", "budget_jobs", "contributions", "jobs"].map(
        (table_name) => ({ table_name, column_default: "'public'::text", is_nullable: "NO", fk: true })
      )
    );
  });

  it("are not in any view query_sql reads", async () => {
    // The public_read views name their columns, so a column added to a table
    // they read does not appear in them.
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND column_name = 'sensitivity_label'`
    );
    expect(exposed).toEqual([]);
    // The ledger's own `label` there is still the row's display name.
    const action = await seedAction({ group: `carried-view:${randomUUID()}`, costMicroUsd: 1 });
    const [row] = await rawQuery<{ label: string }>(`SELECT label FROM public_read.ledger WHERE action_id = $1`, [action]);
    expect(row!.label).toMatch(/^DB-test action/);
  });
});

describe("a ledger action", () => {
  it("opened inside a run takes the run's label, its pass runs at that label, and so does what the pass enqueues", async () => {
    const claim = await seedClaim("carried assess");
    await inRunAt(INTERNAL, () =>
      enqueueSteward({ claimId: claim, trigger: "structure_and_assess", context: "Asked for at the internal label." })
    );
    const opened = await assessLabels(claim);
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened)).toEqual(new Set([INTERNAL]));

    // The executor picks the row up from outside any run.
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const child = await seedClaim("carried subclaim");
    const neighbor = await seedClaim("carried neighbor");
    let jobId = "";
    stage.during = async () => {
      // What a Steward does mid-pass: mints a subclaim and sends it to be
      // onboarded, writes to another node's Steward, submits a document.
      await enqueueClaimPipeline({ claimId: child, jobId: "steward" });
      await enqueueSteward({ claimId: neighbor, trigger: "steward_note", context: "A note from the pass." });
      jobId = (await submitSource({ url: `https://dbtest.example/carried/${randomUUID()}`, content: "A page." })).jobId;
    };
    expect(await runFundedPass(claim)).toMatchObject({ status: "processed", claimId: claim, ok: true });

    expect(stage.seen).toHaveLength(1);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    // The child work, each kind by its own carrier.
    expect(new Set(await assessLabels(neighbor))).toEqual(new Set([INTERNAL]));
    expect(await labelOf("jobs", jobId)).toBe(INTERNAL);
    const message = takePipelineMessage(child);
    expect(message).toMatchObject({ claimId: child, jobId: "steward", label: INTERNAL });

    // And the child of the child: the onboarding worker opens the subclaim's
    // first pass on the ledger at the message's label.
    expect(await assessLabels(child)).toEqual([]);
    await handleClaimPipeline(message!);
    expect(new Set(await assessLabels(child))).toEqual(new Set([INTERNAL]));
  });

  it("opened outside any run is public, and its pass writes public", async () => {
    const claim = await seedClaim("carried public assess");
    await enqueueSteward({ claimId: claim, trigger: "structure_and_assess", context: "Asked for by a plain request." });
    expect(new Set(await assessLabels(claim))).toEqual(new Set([PUBLIC_LABEL]));

    const child = await seedClaim("carried public subclaim");
    stage.during = async () => {
      await enqueueClaimPipeline({ claimId: child, jobId: "steward" });
    };
    expect(await runFundedPass(claim)).toMatchObject({ status: "processed", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
    expect(takePipelineMessage(child)).toMatchObject({ label: PUBLIC_LABEL });
  });

  it("keeps its label while it waits, and takes the label of the work that reopens it once finished", async () => {
    const claim = await seedClaim("carried reopen");
    await enqueueSteward({ claimId: claim, trigger: "structure_and_assess", context: "First, a public request." });
    // Work at another label arriving on the open row joins it; the row is
    // still the public request's.
    await inRunAt(INTERNAL, () => enqueueSteward({ claimId: claim, trigger: "steward_note", context: "A note at the internal label." }));
    expect(new Set(await assessLabels(claim))).toEqual(new Set([PUBLIC_LABEL]));

    expect(await runFundedPass(claim)).toMatchObject({ status: "processed", ok: true });
    expect(stage.seen[0]!.label).toBe(PUBLIC_LABEL);

    // The row is finished. The next piece of work on the claim reopens it,
    // and it is that work's row now.
    await inRunAt(INTERNAL, () => enqueueSteward({ claimId: claim, trigger: "steward_note", context: "Asked again, at the internal label." }));
    expect(new Set(await assessLabels(claim))).toEqual(new Set([INTERNAL]));
    stage.seen = [];
    expect(await runFundedPass(claim)).toMatchObject({ status: "processed", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
  });

  it("is not claimed at a label it no longer has", async () => {
    const action = await seedAction({ group: `carried-claim:${randomUUID()}`, costMicroUsd: 1 });
    expect(await labelOf("actions", action)).toBe(PUBLIC_LABEL);
    expect(await claimAction(action, INTERNAL)).toBe(false);
    expect(await claimAction(action, PUBLIC_LABEL)).toBe(true);
  });

  it("cannot carry a label no row defines", async () => {
    const action = await seedAction({ group: `carried-fk:${randomUUID()}`, costMicroUsd: 1 });
    await expect(
      rawQuery(`UPDATE actions SET sensitivity_label = 'undefined-label' WHERE id = $1`, [action])
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // A run whose context names one opens no row either.
    const claim = await seedClaim("carried undefined");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    const { ensureAssessActions } = await import("../../src/services/action-service.js");
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () => ensureAssessActions(claim))
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    expect(await assessLabels(claim)).toEqual([]);
  });
});

describe("the claim pipeline's message", () => {
  /** A message as the code before the label field wrote it: no `label` key at all. */
  const preLabel = (claimId: string): PreLabelClaimPipelineMessage => ({ claimId, jobId: "steward" });
  /** A message whose label is there but is not one: what JSON can carry in the field. */
  const withLabel = (claimId: string, label: unknown) =>
    ({ claimId, jobId: "steward", label }) as ClaimPipelineMessage;

  async function onboarding(claimId: string) {
    const [row] = await rawQuery<{ decomposition_status: string }>(
      `SELECT decomposition_status FROM claims WHERE id = $1`,
      [claimId]
    );
    return { status: row!.decomposition_status, labels: await assessLabels(claimId) };
  }
  const NOT_ONBOARDED = { status: "pending", labels: [] };

  /**
   * Run `fn` in a deployment whose only label is `public`, as the public
   * graph is.
   *
   * The scratch database is shared by every file in the suite, and by the
   * time this one runs it holds rows at `internal` (this file's and other
   * files'), so that label's row cannot be deleted to get there. Instead the
   * real table is set aside under another name and a stand-in with the one
   * row takes its place while `fn` runs. Foreign keys follow the real table
   * itself, not its name, so every write is still checked against the real
   * labels; only a read of `labels` by name sees the stand-in, and that
   * read is what is under test.
   *
   * `fn` is handed a way to define another label in the stand-in. Whatever
   * it defines goes when the stand-in is dropped, so no test's second label
   * reaches another test or another file.
   */
  async function whereOnlyPublicIsDefined<T>(
    fn: (defineLabel: (name: string) => Promise<void>) => Promise<T>
  ): Promise<T> {
    await rawQuery(`ALTER TABLE labels RENAME TO labels_set_aside`);
    try {
      await rawQuery(`CREATE TABLE labels (LIKE labels_set_aside INCLUDING DEFAULTS)`);
      await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Readable by anyone.')`, [PUBLIC_LABEL]);
      return await fn(async (name) => {
        await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Defined for one test.')`, [name]);
      });
    } finally {
      await rawQuery(`DROP TABLE IF EXISTS labels`);
      await rawQuery(`ALTER TABLE labels_set_aside RENAME TO labels`);
    }
  }

  it("says whether public is the only label by reading the labels table", async () => {
    // This file's own second label is in the shared table.
    expect(await publicIsTheOnlyLabel()).toBe(false);
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      expect(await publicIsTheOnlyLabel()).toBe(true);
      await defineLabel("restricted");
      expect(await publicIsTheOnlyLabel()).toBe(false);
    });
    // The stand-in is gone with the label defined in it, and the real table
    // is back under its name with the foreign keys still on it.
    const names = (await rawQuery<{ name: string }>(`SELECT name FROM labels`)).map((r) => r.name);
    expect(names).toContain(INTERNAL);
    expect(names).not.toContain("restricted");
    const [keys] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.labels'::regclass`
    );
    expect(keys!.n).toBeGreaterThan(0);
  });

  it("written before the label field is run at public where public is the only label", async () => {
    const claim = await seedClaim("carried pre-label message");
    await whereOnlyPublicIsDefined(async () => {
      // What the poller hands over: the stored body, parsed.
      const message = JSON.parse(JSON.stringify(preLabel(claim))) as PreLabelClaimPipelineMessage;
      expect("label" in message).toBe(false);
      await handleClaimPipeline(message);
    });
    const after = await onboarding(claim);
    expect(after.status).toBe("complete");
    expect(after.labels.length).toBeGreaterThan(0);
    expect(new Set(after.labels)).toEqual(new Set([PUBLIC_LABEL]));
  });

  it("written before the label field is refused once the deployment defines a second label", async () => {
    const first = await seedClaim("carried pre-label, then a second label");
    const second = await seedClaim("carried pre-label, after a second label");
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      // The same message is public work up to the moment another label
      // exists, and from then on it could be anything.
      await handleClaimPipeline(preLabel(first));
      await defineLabel("restricted");
      await expect(handleClaimPipeline(preLabel(second))).rejects.toBeInstanceOf(MissingLabelError);
    });
    expect((await onboarding(first)).status).toBe("complete");
    expect(await onboarding(second)).toEqual(NOT_ONBOARDED);

    // The shared table, where this file defined `internal`: refused as well,
    // and the claim is not onboarded as public.
    const third = await seedClaim("carried pre-label message, two labels");
    await expect(handleClaimPipeline(preLabel(third))).rejects.toBeInstanceOf(MissingLabelError);
    expect(await onboarding(third)).toEqual(NOT_ONBOARDED);
  });

  it("whose label is there but empty or null is refused, whatever labels the deployment has", async () => {
    // A key with nothing in it is not a message from before the field: the
    // code that wrote it knew about labels and lost this one.
    const refuseAll = async () => {
      for (const label of ["", null, undefined, 0, false]) {
        const claim = await seedClaim("carried empty label");
        await expect(handleClaimPipeline(withLabel(claim, label))).rejects.toBeInstanceOf(MissingLabelError);
        expect(await onboarding(claim)).toEqual(NOT_ONBOARDED);
      }
    };
    await whereOnlyPublicIsDefined(refuseAll);
    await refuseAll();
  });

  it("whose label names no row is refused, whatever labels the deployment has", async () => {
    // A row cannot carry such a label (its foreign key), so the message is
    // the one place it can arrive. Left to run, the claim would be marked
    // onboarded with no pass on the ledger, and the scheduler's sweep would
    // open that pass at public.
    const refuse = async () => {
      const claim = await seedClaim("carried unknown label");
      await expect(handleClaimPipeline(withLabel(claim, "undefined-label"))).rejects.toBeInstanceOf(UndefinedLabelError);
      expect(await onboarding(claim)).toEqual(NOT_ONBOARDED);
      const [row] = await rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [claim]);
      return row!.steward_state;
    };
    const untouched = await rawQuery<{ steward_state: string }>(
      `SELECT steward_state FROM claims WHERE id = $1`,
      [await seedClaim("carried never queued")]
    );
    expect(await whereOnlyPublicIsDefined(refuse)).toBe(untouched[0]!.steward_state);
    expect(await refuse()).toBe(untouched[0]!.steward_state);
  });
});

describe("a job", () => {
  const extractedClaim = () => ({
    verbatim_text: "the grid", context: null, proposed_canonical_form: `The grid is fragile (${randomUUID()}).`,
    claim_type: "empirical_verifiable", confidence: 0.9, importance: 0.5, contestation: 0.5,
    source_location: null, domains: [],
  });

  /** Submit a document, then run the extraction the way the worker gets it: the queued message, no context. */
  async function submitAndExtract(label: string | null) {
    const url = `https://dbtest.example/carried/${randomUUID()}`;
    const submit = () => submitSource({ url, content: "<p>An essay about the grid.</p>" });
    const { jobId, sourceId } = label ? await inRunAt(label, submit) : await submit();
    const queue = getLocalQueue("urlExtraction");
    const message = queue.splice(queue.findIndex((m) => m.jobId === jobId), 1)[0]!;
    stage.extracted = [extractedClaim()];
    await handleUrlExtraction(message);
    const [instance] = await rawQuery<{ claim_id: string }>(
      `SELECT claim_id FROM claim_instances WHERE source_id = $1`,
      [sourceId]
    );
    return { jobId, sourceId, claimId: instance!.claim_id };
  }

  it("created inside a run takes the run's label, the extraction runs at it, and the claims it mints are onboarded at it", async () => {
    const { jobId, sourceId, claimId } = await submitAndExtract(INTERNAL);
    expect(await labelOf("jobs", jobId)).toBe(INTERNAL);
    expect(await labelOf("sources", sourceId)).toBe(INTERNAL);
    expect(stage.seen.map((s) => s.agent)).toEqual(["extractor"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    // The claim the extraction minted goes to be onboarded at the job's label.
    const message = takePipelineMessage(claimId);
    expect(message).toMatchObject({ jobId, label: INTERNAL });
    await handleClaimPipeline(message!);
    expect(new Set(await assessLabels(claimId))).toEqual(new Set([INTERNAL]));
  });

  it("created outside any run is public, and so is everything after it", async () => {
    const { jobId, sourceId, claimId } = await submitAndExtract(null);
    expect(await labelOf("jobs", jobId)).toBe(PUBLIC_LABEL);
    expect(await labelOf("sources", sourceId)).toBe(PUBLIC_LABEL);
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
    const message = takePipelineMessage(claimId);
    expect(message).toMatchObject({ label: PUBLIC_LABEL });
    await handleClaimPipeline(message!);
    expect(new Set(await assessLabels(claimId))).toEqual(new Set([PUBLIC_LABEL]));
  });

  it("that cannot be found fails the extraction instead of running it as public", async () => {
    const sourceId = (await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, raw_content) VALUES ($1, 'A page', 'Text.') RETURNING id`,
      [`https://dbtest.example/carried/${randomUUID()}`]
    ))[0]!.id;
    await expect(
      handleUrlExtraction({ sourceId, jobId: randomUUID(), url: "https://dbtest.example/carried/none" })
    ).rejects.toBeInstanceOf(MissingLabelError);
    expect(stage.seen).toEqual([]);
  });

  it("for a text analysis records the label the analysis ran at", async () => {
    let ranAt = "";
    const job = await runWithUsageContext({ label: INTERNAL }, () =>
      startTextAnalysis("extract_claims", {}, { userId: null, apiKeyId: null }, async () => {
        ranAt = currentLabel();
        return {};
      })
    );
    await settleTextAnalyses();
    expect(await labelOf("jobs", job.id)).toBe(INTERNAL);
    expect(ranAt).toBe(INTERNAL);
  });
});

describe("an assessment order", () => {
  async function orderAndDispatch(label: string | null) {
    const buyer = await seedUser("carried-buyer");
    await creditOwls(buyer, 500 * OWL);
    const claim = await seedClaim("carried order");
    const place = () => createOrder({ userId: buyer, claimId: claim });
    const placed = label ? await inRunAt(label, place) : await place();
    if (!placed.ok) throw new Error(placed.message);
    await rawQuery(`UPDATE assessment_orders SET status = 'cancelled' WHERE status = 'pending' AND id <> $1`, [placed.order.id]);
    const child = await seedClaim("carried order subclaim");
    stage.during = async () => {
      await enqueueClaimPipeline({ claimId: child, jobId: "steward" });
    };
    const result = await processNextOrderTask();
    return { orderId: placed.order.id, result, message: takePipelineMessage(child) };
  }

  it("placed inside a run takes the run's label, and the pass it buys runs at it", async () => {
    const { orderId, result, message } = await orderAndDispatch(INTERNAL);
    expect(await labelOf("assessment_orders", orderId)).toBe(INTERNAL);
    expect(result).toMatchObject({ status: "processed", orderId, ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    expect(message).toMatchObject({ label: INTERNAL });
  });

  it("placed outside any run is public", async () => {
    const { orderId, result, message } = await orderAndDispatch(null);
    expect(await labelOf("assessment_orders", orderId)).toBe(PUBLIC_LABEL);
    expect(result).toMatchObject({ status: "processed", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
    expect(message).toMatchObject({ label: PUBLIC_LABEL });
  });
});

describe("a budget job", () => {
  async function fundAndAdvance(label: string | null) {
    const funder = await seedUser("carried-deep");
    await creditOwls(funder, 500 * OWL);
    const claim = await seedClaim("carried deep decomposition");
    const fund = () => createDeepDecompositionJob({ userId: funder, claimId: claim, budgetOwls: 20 });
    const funded = label ? await inRunAt(label, fund) : await fund();
    if (!funded.ok) throw new Error(funded.message);
    await rawQuery(
      `UPDATE budget_jobs SET status = 'cancelled'
        WHERE status = 'running' AND kind = 'deep_decomposition' AND id <> $1`,
      [funded.job.id]
    );
    const child = await seedClaim("carried deep subclaim");
    stage.during = async () => {
      await enqueueClaimPipeline({ claimId: child, jobId: "steward" });
    };
    const result = await processNextBudgetJobTask();
    return { jobId: funded.job.id, claim, result, message: takePipelineMessage(child) };
  }

  it("funded inside a run takes the run's label, and each pass it pays for runs at it", async () => {
    const { jobId, claim, result, message } = await fundAndAdvance(INTERNAL);
    expect(await labelOf("budget_jobs", jobId)).toBe(INTERNAL);
    expect(result).toMatchObject({ status: "processed", jobId, claimId: claim, ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    expect(message).toMatchObject({ label: INTERNAL });
  });

  it("funded outside any run is public", async () => {
    const { jobId, result, message } = await fundAndAdvance(null);
    expect(await labelOf("budget_jobs", jobId)).toBe(PUBLIC_LABEL);
    expect(result).toMatchObject({ status: "processed", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
    expect(message).toMatchObject({ label: PUBLIC_LABEL });
  });
});

describe("a contribution and an appeal", () => {
  async function contribute(label: string | null) {
    const contributor = await seedUser("carried-contributor");
    const claim = await seedClaim("carried contribution");
    const submit = () =>
      createContribution({
        claimId: claim,
        contributorId: contributor,
        contributionType: "counter_evidence",
        content: "The 2019 survey found the opposite in three of five regions.",
      });
    const row = label ? await inRunAt(label, submit) : await submit();
    return { id: row.id, contributor, claim };
  }

  it("submitted inside a run takes the run's label; its review and its escalated arbitration run at it", async () => {
    const { id } = await contribute(INTERNAL);
    expect(await labelOf("contributions", id)).toBe(INTERNAL);

    const neighbor = await seedClaim("carried review neighbor");
    stage.during = async () => {
      await enqueueSteward({ claimId: neighbor, trigger: "contribution_accepted", context: "Accepted in review." });
    };
    // The message names the contribution and nothing else.
    await handleContributionMessage({ contributionId: id });
    expect(stage.seen.map((s) => s.agent)).toEqual(["contribution_reviewer"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    expect(new Set(await assessLabels(neighbor))).toEqual(new Set([INTERNAL]));

    // The reviewer escalates; the arbitration has no appeal, so it runs at
    // the contribution's label.
    await rawQuery(
      `UPDATE contributions SET review_status = 'escalated', review_claimed_at = NULL, review_attempts = 0 WHERE id = $1`,
      [id]
    );
    stage.seen = [];
    await handleArbitrationMessage({ contributionId: id, trigger: "escalated_review" });
    expect(stage.seen.map((s) => s.agent)).toEqual(["dispute_arbitrator"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
  });

  it("is reviewed at its own label when the recovery sweep, outside any run, is what enqueues it", async () => {
    const { id } = await contribute(INTERNAL);
    await rawQuery(`UPDATE contributions SET submitted_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    const queue = getLocalQueue("contribution");
    queue.length = 0;
    await sweepStalledReviewWork();
    const message = queue.find((m) => m.contributionId === id);
    queue.length = 0;
    getLocalQueue("arbitration").length = 0;
    expect(message).toEqual({ contributionId: id });
    await handleContributionMessage(message!);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
  });

  it("submitted outside any run is public, and an appeal of it runs at the appeal's label", async () => {
    const { id, contributor } = await contribute(null);
    expect(await labelOf("contributions", id)).toBe(PUBLIC_LABEL);
    await handleContributionMessage({ contributionId: id });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));

    const [review] = await rawQuery<{ id: string }>(
      `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence)
       VALUES ($1, 'reject', 'Not followable.', 0.8) RETURNING id`,
      [id]
    );
    await rawQuery(`UPDATE contributions SET review_status = 'rejected' WHERE id = $1`, [id]);
    const appeal = await inRunAt(INTERNAL, () =>
      createAppeal({ contributionId: id, originalReviewId: review!.id, appellantId: contributor, appealReasoning: "The survey is cited in full." })
    );
    expect(await labelOf("appeals", appeal.id)).toBe(INTERNAL);
    stage.seen = [];
    await handleArbitrationMessage({ contributionId: id, trigger: "appeal", appealId: appeal.id });
    expect(stage.seen.map((s) => s.agent)).toEqual(["dispute_arbitrator"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));

    // An appeal filed by a plain request is public.
    const second = await createAppeal({ contributionId: id, originalReviewId: review!.id, appellantId: contributor, appealReasoning: "Again." });
    expect(await labelOf("appeals", second.id)).toBe(PUBLIC_LABEL);
    stage.seen = [];
    await handleArbitrationMessage({ contributionId: id, trigger: "appeal", appealId: second.id });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
  });
});

describe("a research commission and a paused session", () => {
  const TRANSCRIPT = [
    { role: "user", content: "Curate these." },
    { role: "assistant", content: [{ type: "text", text: "I commissioned research and will wait." }] },
  ] as never;

  /** A Curator's run commissions research, waits on it, and pauses. */
  async function pauseOnResearch(label: string | null, grantId: string, anchor: string) {
    const session = { id: randomUUID(), role: "curator", nodeId: anchor };
    const commission = () =>
      commissionResearch({
        payer: { kind: "grant", grantId },
        nodeId: anchor,
        task: "Find whether the two flagged nodes rest on the same underlying survey, and which edition.",
        budgetMicroUsd: OWL,
        tier: "standard",
        requestedBy: "curator",
        wait: true,
      });
    const res = await runWithUsageContext({ session, agent: "curator", ...(label ? { label } : {}) }, commission);
    if (!res.ok) throw new Error(res.message);
    await suspendSession({
      id: session.id,
      transcript: TRANSCRIPT,
      model: "m",
      budgetLeftMicroUsd: OWL,
      payer: { kind: "grant", grantId },
      context: { input: { trigger: "curation_request", claimId: anchor, context: "Two nodes may be one." } },
    });
    return { sessionId: session.id, researchGroup: `research:${res.runId}`, actionId: res.actionId };
  }

  async function resumeRow(sessionId: string) {
    const [row] = await rawQuery<{ exclusion_group: string; status: string; sensitivity_label: string }>(
      `SELECT exclusion_group, status, sensitivity_label FROM actions WHERE kind = 'resume' AND target_ref = $1`,
      [sessionId]
    );
    return row!;
  }

  it("carry the commissioning run's label through the research, the answer, and the resumed run", async () => {
    const grantId = await mandate();
    const anchor = await seedClaim("carried curator anchor");
    const { sessionId, researchGroup, actionId } = await pauseOnResearch(INTERNAL, grantId, anchor);
    expect(await labelOf("actions", actionId)).toBe(INTERNAL);
    expect(await labelOf("agent_sessions", sessionId)).toBe(INTERNAL);

    // The research runs at the label it was commissioned at.
    expect(await runOnly(researchGroup)).toMatchObject({ status: "processed", kind: "research" });
    expect(stage.seen.map((s) => s.agent)).toEqual(["researcher"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));

    // Its answer commissioned the resumption, at the session's label.
    const row = await resumeRow(sessionId);
    expect(row).toMatchObject({ status: "open", sensitivity_label: INTERNAL });

    // The resumed run works at it, and what it asks for next carries it.
    const neighbor = await seedClaim("carried resumed neighbor");
    stage.seen = [];
    stage.during = async () => {
      await enqueueSteward({ claimId: neighbor, trigger: "curator_change", context: "Merged; please reconcile." });
    };
    expect(await runOnly(row.exclusion_group)).toMatchObject({ status: "processed", kind: "resume", ok: true });
    expect(stage.seen.map((s) => s.agent)).toEqual(["curator"]);
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
    expect(new Set(await assessLabels(neighbor))).toEqual(new Set([INTERNAL]));
  });

  // An answer is written by whoever delivers it, at their label, and a
  // session shows what it holds to a run at the session's own. So a session
  // takes only an answer of its own label (deliverReply). This test used to
  // show the session resuming, at its own label, on an answer from work at
  // another: the answer no longer goes in.
  it("are not answered by work at another label: the answer goes to the node's inbox at its own label, and the session waits", async () => {
    const grantId = await mandate();
    const anchor = await seedClaim("carried cross-label anchor");
    const { sessionId, researchGroup, actionId } = await pauseOnResearch(INTERNAL, grantId, anchor);
    // The research row is moved to public, standing in for an answer that
    // comes from other work: a different run, or the sweep.
    await rawQuery(`UPDATE actions SET sensitivity_label = 'public' WHERE id = $1`, [actionId]);
    expect(await runOnly(researchGroup)).toMatchObject({ status: "processed", kind: "research" });
    expect(stage.seen[0]!.label).toBe(PUBLIC_LABEL);

    // The session holds no answer and no pass is commissioned to resume it.
    const [session] = await rawQuery<{ status: string; replies: unknown[]; sensitivity_label: string }>(
      `SELECT status, replies, sensitivity_label FROM agent_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(session).toEqual({ status: "waiting", replies: [], sensitivity_label: INTERNAL });
    expect(await rawQuery(`SELECT 1 FROM actions WHERE kind = 'resume' AND target_ref = $1`, [sessionId])).toEqual([]);
    // The report went where an answer goes when its session cannot take it,
    // as a message at the label of the run that wrote it.
    const messages = await rawQuery<{ trigger: string; sender_kind: string; sensitivity_label: string }>(
      `SELECT trigger, sender_kind, sensitivity_label FROM node_messages WHERE node_id = $1`,
      [anchor]
    );
    expect(messages).toEqual([{ trigger: "research_report", sender_kind: "researcher", sensitivity_label: PUBLIC_LABEL }]);

    // An answer at the session's own label is taken, and resumes it there.
    const routed = await runWithUsageContext({ label: INTERNAL }, () =>
      deliverReply({ sessionId, kind: "research", ref: researchGroup.slice("research:".length), text: "The 2019 edition.", fallback: null })
    );
    expect(routed).toBe("session");
    const row = await resumeRow(sessionId);
    expect(row.sensitivity_label).toBe(INTERNAL);
    stage.seen = [];
    expect(await runOnly(row.exclusion_group)).toMatchObject({ status: "processed", kind: "resume", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(INTERNAL));
  });

  it("are public when commissioned outside any label", async () => {
    const grantId = await mandate();
    const anchor = await seedClaim("carried public anchor");
    const { sessionId, researchGroup, actionId } = await pauseOnResearch(null, grantId, anchor);
    expect(await labelOf("actions", actionId)).toBe(PUBLIC_LABEL);
    expect(await labelOf("agent_sessions", sessionId)).toBe(PUBLIC_LABEL);
    expect(await runOnly(researchGroup)).toMatchObject({ status: "processed", kind: "research" });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
    const row = await resumeRow(sessionId);
    expect(row.sensitivity_label).toBe(PUBLIC_LABEL);
    stage.seen = [];
    expect(await runOnly(row.exclusion_group)).toMatchObject({ status: "processed", kind: "resume", ok: true });
    expect(await written(stage.seen[0]!)).toEqual(all(PUBLIC_LABEL));
  });

  it("a Steward's pass resumes only a session of the label the pass runs at", async () => {
    const node = await seedClaim("carried steward session");
    const id = randomUUID();
    await rawQuery(
      `INSERT INTO agent_sessions (id, role, node_id, status, transcript, suspended_at, sensitivity_label)
       VALUES ($1, 'steward', $2, 'ready', $3::jsonb, now(), $4)`,
      [id, node, JSON.stringify(TRANSCRIPT), INTERNAL]
    );
    // A public pass leaves it where it is.
    expect(await takeReadySession(node, "steward")).toBeNull();
    const [waiting] = await rawQuery<{ status: string }>(`SELECT status FROM agent_sessions WHERE id = $1`, [id]);
    expect(waiting!.status).toBe("ready");
    // A pass at the session's label takes it.
    const taken = await runWithUsageContext({ label: INTERNAL }, () => takeReadySession(node, "steward"));
    expect(taken?.session).toMatchObject({ id, sensitivity_label: INTERNAL });
  });
});
