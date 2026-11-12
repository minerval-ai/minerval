/**
 * What a run writes about itself carries a label (src/labels.ts).
 *
 * Against real Postgres and the real write seams, five things:
 *
 *  - Every row of run material (the steps of a transcript, the usage rows of
 *    its model calls, the parts of its setup, an investigation it launches, a
 *    report it files and each later sighting, a finding it notes and each
 *    later sighting, an audit it asks for) carries the label of the run that
 *    writes it, and is public when the run's context sets none.
 *  - A step carries the label of the run it belongs to, not the label in the
 *    air when its queued write lands.
 *  - The hash chain over a run's steps does not cover the column, and still
 *    covers the label in the prompt step's setup.
 *  - A write that lands on a row already there (a repeated report, a joined
 *    finding, a setup part stored before, an audit asked for twice) leaves
 *    that row's label alone.
 *  - None of it reaches a reader: no view query_sql reads, no run, report,
 *    finding, setup or usage route, and no agent's read carries the column.
 *
 * No model is called: the provider answers from this file, and meters the
 * call as every real adapter does. Everything after it is the real path,
 * from the client's prompt step to the rows in Postgres.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

vi.hoisted(() => {
  // Tracing is off under vitest by default; a run in this file is a real run.
  process.env.TRACE_LEVEL = "full";
  // An operator's key, for the routes only the service reads.
  process.env.API_KEYS = "label-runs-service-key";
});

vi.mock("../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/index.js")>()),
  getAdapter: () => ({
    complete: async (options: { model: string }) => {
      // What every real adapter does with the provider's answer: meter it.
      const { recordCallUsage } = await import("../../src/llm/providers/metering.js");
      recordCallUsage("anthropic", options.model, { inputTokens: 3, outputTokens: 2 });
      return { content: "Done.", model: options.model, usage: { inputTokens: 3, outputTokens: 2 }, stopReason: "end_turn" };
    },
  }),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));
vi.mock("../../src/services/github-issue-service.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/github-issue-service.js")>()),
  fileIssueForReport: vi.fn(async () => null),
  syncSightingToIssue: vi.fn(async () => undefined),
  syncTriageToIssue: vi.fn(async () => undefined),
}));

import { rawQuery } from "../../src/db/client.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { complete } from "../../src/llm/client.js";
import { createFindingTools } from "../../src/llm/tools/finding-tools.js";
import { createReportTools } from "../../src/llm/tools/report-tools.js";
import { readResearchRun } from "../../src/llm/tools/research-tools.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { currentLabel, getUsageContext, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { getClaimView, CLAIM_VIEW_INCLUDES } from "../../src/services/claim-view-service.js";
import { requestAudit } from "../../src/services/queue-service.js";
import { commissionResearch } from "../../src/services/research-commission-service.js";
import { listResearchRunsForClaim } from "../../src/services/research-run-service.js";
import { getRunStep, getRunSummary, listRunSteps, verifyRunLog, type RunLogCheck } from "../../src/services/run-view-service.js";
import { resetSetupRegistry } from "../../src/services/setup-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { recordAgentStep } from "../../src/services/trace-service.js";
import { meterExternalUsage } from "../../src/services/usage-service.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

/**
 * The second label. Not `internal`, the name the other label files use: a
 * report's origin is 'internal' or 'external', so a response that named
 * that label could not be told from one that named an origin.
 */
const SECOND = "embargoed";
const FOREIGN_KEY_VIOLATION = "23503";
const SERVICE = { "x-api-key": "label-runs-service-key" };

/** The tables this file is about: what a run writes about itself. */
const RUN_TABLES = [
  "agent_finding_sightings", "agent_findings", "agent_report_sightings", "agent_reports", "agent_steps",
  "audit_runs", "llm_usage", "research_runs", "setup_parts",
];

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
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

/** A matcher's run at `label`, or with no label set: an agent whose transcript is public. */
function runAt<T>(label: string | null, fn: () => Promise<T>): Promise<T> {
  return runWithUsageContext(label ? { label } : {}, () => withAgent("matcher", fn));
}

/** Wait for the run to close, which in the default mode comes after it returns. */
async function closed(runId: string) {
  for (let i = 0; i < 250; i++) {
    const [row] = await rawQuery<{ sensitivity_label: string; log_hash: string | null; sealed_at: Date | null; steps: number }>(
      `SELECT sensitivity_label, log_hash, sealed_at, steps FROM agent_runs WHERE id = $1 AND finished_at IS NOT NULL`,
      [runId]
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the run did not close");
}

/** Wait for a setup part to be stored: the client stores parts off the step's path. */
async function storedPart(text: string) {
  for (let i = 0; i < 250; i++) {
    const rows = await rawQuery<{ kind: string; name: string; version: number; hash: string; sensitivity_label: string }>(
      `SELECT kind, name, version, hash, sensitivity_label FROM setup_parts WHERE kind = 'role' AND content = $1`,
      [text]
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the setup part was not stored");
}

/** Wait for a run's usage rows: a model call's row is written off the call's path. */
async function usageLabels(runId: string, rows: number): Promise<string[]> {
  for (let i = 0; i < 250; i++) {
    const found = await rawQuery<{ sensitivity_label: string }>(`SELECT sensitivity_label FROM llm_usage WHERE run_id = $1`, [runId]);
    if (found.length >= rows) return found.map((r) => r.sensitivity_label);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the usage rows were not written");
}

async function verify(runId: string): Promise<RunLogCheck> {
  const check = await verifyRunLog(runId);
  if (!check || "withheld" in check) throw new Error("expected a check");
  return check;
}

const ok = (out: string | null): Record<string, any> => {
  const parsed = JSON.parse(out!);
  expect(parsed.success ?? parsed.acknowledged, out!).toBe(true);
  return parsed;
};

/** One model call, as an agent's turn makes it: a prompt step, a completion step, a usage row, a setup part. */
function oneCall(system: string) {
  return complete({ model: "claude-sonnet-5-5", system, messages: [{ role: "user", content: "Say done." }] });
}

async function mandate(): Promise<string> {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("runs-mandate"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', daily_budget_micro_usd = 0 WHERE id = $1`, [grantId]);
  return grantId;
}

/**
 * One run that writes a row in every table of run material, each through the
 * seam the agents write it with. Called from inside the run. Returns, for
 * each table, where its rows are, and the ids the later checks read by.
 */
async function writeOneOfEach() {
  const tag = randomUUID().slice(0, 8);
  const trace = getUsageContext().trace!;
  await trace.ready;
  const runId = trace.runId;

  // A model call: its steps, its usage row, and the role part of its setup.
  const system = `You are a test of run material (${tag}).`;
  await oneCall(system);
  // Money the token meter does not see lands in the same table.
  await meterExternalUsage({ provider: "lean", model: `lean-checker/${tag}`, units: 1, unitKind: "call", costMicroUsd: 1000 });

  // A report about the machinery, the same failure seen again, and a note on it.
  const reports = createReportTools({ model: "dbtest-model" });
  const title = `The search tool returned nothing for a known id (${tag})`;
  const raised = ok(
    await reports.execute("raise_issue", { kind: "system_failure", severity: "degraded", title, body: `It happened once (${tag}).` })
  );
  const reportId = raised.report_id as string;
  ok(await reports.execute("raise_issue", { kind: "system_failure", severity: "degraded", title, body: `And again (${tag}).`, joins: reportId }));
  ok(await reports.execute("update_issue", { report_id: reportId, note: `It also fails on a second id (${tag}).` }));

  // A finding, noted on a judged claim, and met again.
  const claim = await seedClaim("runs finding");
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
  ok(
    await executeStewardTool("update_claim_assessment", {
      claim_id: claim, status: "contradicted", confidence: 0.8, assessment: "Judged for the run material test.", reasoning_trace: "dbtest",
    })
  );
  const [assessment] = await rawQuery<{ id: string }>(`SELECT id FROM assessments WHERE claim_id = $1 AND is_current = true`, [claim]);
  const findings = createFindingTools({ model: "dbtest-model" });
  const finding = {
    headline: `The received figure does not survive the corrected cohorts (${tag}).`,
    account: `What most people believe rests on cohorts counted twice (${tag}).`,
    claim_id: claim,
    refs: [{ kind: "assessment", id: assessment!.id }, { kind: "claim", id: claim }],
    importance: 5,
  };
  const noted = ok(await findings.execute("note_finding", finding));
  const findingId = noted.finding_id as string;
  ok(await findings.execute("note_finding", { ...finding, account: `Met again on a second pass (${tag}).`, joins: findingId }));

  // An audit asked for, and an investigation launched for a mandate.
  const auditRunId = await requestAudit({ auditType: "anomaly_investigation", context: `Look at this (${tag}).`, triggeredBy: "manual" });
  const grantId = await mandate();
  const research = await commissionResearch({
    payer: { kind: "grant", grantId }, nodeId: claim, task: `Find which edition of the survey both figures rest on (${tag}).`,
    budgetMicroUsd: OWL, tier: "standard", requestedBy: "claim_steward", wait: false,
  });
  if (!research.ok) throw new Error(research.message);

  return {
    ids: { tag, runId, claim, reportId, findingId, auditRunId: auditRunId!, researchRunId: research.runId, system, title },
    tables: {
      agent_steps: { where: "run_id = $1", params: [runId] },
      llm_usage: { where: "run_id = $1", params: [runId] },
      setup_parts: { where: "kind = 'role' AND content = $1", params: [system] },
      agent_reports: { where: "id = $1", params: [reportId] },
      agent_report_sightings: { where: "report_id = $1", params: [reportId] },
      agent_findings: { where: "id = $1", params: [findingId] },
      agent_finding_sightings: { where: "finding_id = $1", params: [findingId] },
      audit_runs: { where: "id = $1", params: [auditRunId] },
      research_runs: { where: "id = $1", params: [research.runId] },
    } as Record<string, { where: string; params: unknown[] }>,
  };
}

/** The run of writeOneOfEach, opened at `label` and waited on until its log and its setup part are written. */
async function oneRunAt(label: string | null) {
  const rows = await runAt(label, writeOneOfEach);
  await closed(rows.ids.runId);
  await storedPart(rows.ids.system);
  // The model call's and the checker's.
  await usageLabels(rows.ids.runId, 2);
  return rows;
}

async function labelsOf(tables: Record<string, { where: string; params: unknown[] }>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, { where, params }] of Object.entries(tables)) out[table] = await labelsWhere(table, where, params);
  return out;
}
const everyTableAt = (label: string) => Object.fromEntries(RUN_TABLES.map((t) => [t, [label]]));

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
});

describe("the columns", () => {
  it("are on every table of run material, public by default, and point at labels", async () => {
    const rows = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; fk: boolean; validated: boolean }>(
      `SELECT c.table_name, c.column_default, c.is_nullable, k.oid IS NOT NULL AS fk, COALESCE(k.convalidated, false) AS validated
         FROM information_schema.columns c
         LEFT JOIN pg_constraint k
           ON k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
          AND k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
          AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = k.conrelid AND a.attnum = k.conkey[1]) = c.column_name
        WHERE c.table_schema = 'public' AND c.column_name = 'sensitivity_label'
          AND c.table_name = ANY($1)
        ORDER BY c.table_name`,
      [RUN_TABLES]
    );
    expect(rows).toEqual(
      RUN_TABLES.map((table_name) => ({
        table_name, column_default: "'public'::text", is_nullable: "NO", fk: true,
        // The keys on agent_steps and llm_usage were added NOT VALID (the
        // label_columns migration): every live run appends to both, and
        // neither is scanned under the lock that adds the column. When a
        // later migration validates them, this flips
        // (label-columns.test.ts holds the same two by name).
        validated: table_name !== "agent_steps" && table_name !== "llm_usage",
      }))
    );
  });

  it("cannot carry a label no row defines, the steps' unvalidated key included", async () => {
    const { ids } = await oneRunAt(null);
    // A key that is not validated is still enforced on every row written or changed.
    await expect(
      rawQuery(`UPDATE agent_steps SET sensitivity_label = 'undefined-label' WHERE run_id = $1`, [ids.runId])
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    await expect(
      rawQuery(
        `INSERT INTO agent_steps (run_id, seq, kind, content, sensitivity_label) VALUES ($1, 99, 'assistant', '{}'::jsonb, 'undefined-label')`,
        [ids.runId]
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    await expect(
      rawQuery(`UPDATE llm_usage SET sensitivity_label = 'undefined-label' WHERE run_id = $1`, [ids.runId])
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    // Work whose context names one records nothing.
    const context = `An audit at a label no one defined (${randomUUID()}).`;
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () =>
        requestAudit({ auditType: "anomaly_investigation", context, triggeredBy: "manual" })
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    expect(await labelsWhere("audit_runs", "context = $1", [context])).toEqual([]);
  });
});

describe("a row a run writes about itself", () => {
  it("carries the run's label, in every table, when the run works at a second label", async () => {
    const { ids, tables } = await oneRunAt(SECOND);
    expect(Object.keys(tables).sort()).toEqual(RUN_TABLES);
    expect(await labelsOf(tables)).toEqual(everyTableAt(SECOND));
    expect(await labelOf("agent_runs", ids.runId)).toBe(SECOND);
    // The rows are all there: two steps, two usage rows, a sighting and a note.
    expect((await rawQuery(`SELECT 1 FROM agent_steps WHERE run_id = $1`, [ids.runId])).length).toBe(2);
    expect(await usageLabels(ids.runId, 2)).toEqual([SECOND, SECOND]);
    const sightings = await rawQuery<{ kind: string }>(
      `SELECT kind FROM agent_report_sightings WHERE report_id = $1`,
      [ids.reportId]
    );
    expect(sightings.map((s) => s.kind).sort()).toEqual(["note", "sighting"]);
    // The ledger row that will run the audit took the same label as the audit's record.
    const [audit] = await rawQuery<{ action: string }>(
      `SELECT a.sensitivity_label AS action FROM audit_runs r JOIN actions a ON a.id = r.action_id WHERE r.id = $1`,
      [ids.auditRunId]
    );
    expect(audit!.action).toBe(SECOND);
  });

  it("is public, in every table, when the run's context sets no label", async () => {
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const { ids, tables } = await oneRunAt(null);
    expect(await labelsOf(tables)).toEqual(everyTableAt(PUBLIC_LABEL));
    expect(await labelOf("agent_runs", ids.runId)).toBe(PUBLIC_LABEL);
  });

  it("is public when written outside any run: a usage row, a report, an audit", async () => {
    const tag = randomUUID().slice(0, 8);
    await meterExternalUsage({ provider: "elicit", model: `elicit/${tag}`, units: 1, unitKind: "call", costMicroUsd: 500 });
    expect(await labelsWhere("llm_usage", "model = $1", [`elicit/${tag}`])).toEqual([PUBLIC_LABEL]);
    const raised = ok(
      await createReportTools().execute("raise_issue", {
        kind: "tool_gap", severity: "annoyance", title: `No tool lists a run's parts (${tag})`, body: "Seen from a script.",
      })
    );
    expect(await labelOf("agent_reports", raised.report_id)).toBe(PUBLIC_LABEL);
    const audit = await requestAudit({ auditType: "anomaly_investigation", context: `From a route (${tag}).`, triggeredBy: "manual" });
    expect(await labelOf("audit_runs", audit!)).toBe(PUBLIC_LABEL);
  });

  it("is public on a row inserted without naming a label", async () => {
    const [run] = await rawQuery<{ id: string }>(`INSERT INTO agent_runs (agent) VALUES ('matcher') RETURNING id`);
    const [step] = await rawQuery<{ sensitivity_label: string }>(
      `INSERT INTO agent_steps (run_id, seq, kind, content) VALUES ($1, 0, 'assistant', '{}'::jsonb) RETURNING sensitivity_label`,
      [run!.id]
    );
    expect(step!.sensitivity_label).toBe(PUBLIC_LABEL);
  });
});

// A step is written from the run's queue, after it was claimed, and belongs
// to its run whatever is going on when the write lands.
describe("the steps of a run at a second label", () => {
  it("carry it when their writes land after the run returned and other work has started", async () => {
    let release!: (content: unknown) => void;
    const runId = await runAt(SECOND, async () => {
      const trace = getUsageContext().trace!;
      recordAgentStep(trace, "assistant", { stopReason: "tool_use", content: [{ type: "tool_use", name: "search", input: {} }] });
      // A step whose content takes a while: every step after it waits behind it.
      recordAgentStep(trace, "tool_results", new Promise((resolve) => (release = resolve)));
      // A step recorded from inside work that set another label, as a tool
      // that reads at a source's label would.
      runWithUsageContext({ label: PUBLIC_LABEL }, () => {
        expect(currentLabel()).toBe(PUBLIC_LABEL);
        recordAgentStep(trace, "assistant", { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] });
      });
      return trace.runId;
    });
    // The run has returned with only its first step written.
    for (let i = 0; i < 100 && (await rawQuery(`SELECT 1 FROM agent_steps WHERE run_id = $1`, [runId])).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await rawQuery(`SELECT 1 FROM agent_steps WHERE run_id = $1`, [runId])).length).toBe(1);

    // Other work starts, at public, and writes while the first run's steps are still queued.
    const other = await runAt(null, async () => {
      const trace = getUsageContext().trace!;
      await trace.ready;
      recordAgentStep(trace, "assistant", { stopReason: "end_turn", content: [] });
      const source = await getOrCreateSource({ url: `https://dbtest.example/runs/${randomUUID()}` });
      release([{ name: "search", input: {}, output: "found" }]);
      return { runId: trace.runId, source: source.id };
    });
    expect(await labelOf("sources", other.source)).toBe(PUBLIC_LABEL);

    const run = await closed(runId);
    await closed(other.runId);
    const steps = await rawQuery<{ seq: number; kind: string; sensitivity_label: string }>(
      `SELECT seq, kind, sensitivity_label FROM agent_steps WHERE run_id = $1 ORDER BY seq`,
      [runId]
    );
    expect(steps).toEqual([
      { seq: 0, kind: "assistant", sensitivity_label: SECOND },
      { seq: 1, kind: "tool_results", sensitivity_label: SECOND },
      { seq: 2, kind: "assistant", sensitivity_label: SECOND },
    ]);
    expect(await labelsWhere("agent_steps", "run_id = $1", [other.runId])).toEqual([PUBLIC_LABEL]);
    // The log is whole and sealed.
    expect(run.sealed_at).not.toBeNull();
    expect(await verify(runId)).toMatchObject({ sealed: true, intact: true, problem: null, steps_checked: 3 });
  });

  it("are outside the hash chain by this column, and inside it by the label in the prompt step's setup", async () => {
    const system = `You are a test of the chain (${randomUUID()}).`;
    const runId = await runAt(SECOND, async () => {
      await oneCall(system);
      return getUsageContext().trace!.runId;
    });
    const run = await closed(runId);
    const whole = { sealed: true, log_hash: run.log_hash, head: run.log_hash, intact: true, problem: null, steps_checked: 2 };
    expect(await verify(runId)).toMatchObject(whole);
    const [prompt] = await rawQuery<{ setup: { label?: string }; sensitivity_label: string }>(
      `SELECT content->'setup' AS setup, sensitivity_label FROM agent_steps WHERE run_id = $1 AND seq = 0`,
      [runId]
    );
    expect(prompt).toMatchObject({ setup: { label: SECOND }, sensitivity_label: SECOND });

    // The column is not what a step's hash is taken over: changing it leaves
    // the chain as it was. (Holding the column to the run is later work.)
    await rawQuery(`UPDATE agent_steps SET sensitivity_label = $2 WHERE run_id = $1`, [runId, PUBLIC_LABEL]);
    expect(await verify(runId)).toMatchObject(whole);
    await rawQuery(`UPDATE agent_steps SET sensitivity_label = $2 WHERE run_id = $1`, [runId, SECOND]);
    // The label in the setup is: changing it breaks the chain at that step.
    await rawQuery(
      `UPDATE agent_steps SET content = jsonb_set(content, '{setup,label}', '"public"') WHERE run_id = $1 AND seq = 0`,
      [runId]
    );
    expect(await verify(runId)).toMatchObject({ intact: false, problem: { seq: 0, reason: "hash_mismatch" } });
  });
});

describe("a write that lands on a row already there", () => {
  it("leaves a report's label alone and gives the sighting the label of the run that saw it again", async () => {
    const tag = randomUUID().slice(0, 8);
    const issue = { kind: "system_failure", severity: "degraded", title: `The outline came back empty (${tag})`, body: "First seen." };
    // Both runs are the same agent, so the second is an exact repeat of the first.
    const first = await runAt(null, async () => ok(await createReportTools().execute("raise_issue", issue)).report_id as string);
    const again = await runAt(SECOND, async () =>
      ok(await createReportTools().execute("raise_issue", { ...issue, body: "Seen again, at a second label." }))
    );
    expect(again.report_id).toBe(first);
    expect(await labelOf("agent_reports", first)).toBe(PUBLIC_LABEL);
    const [report] = await rawQuery<{ occurrence_count: number; body: string }>(
      `SELECT occurrence_count, body FROM agent_reports WHERE id = $1`,
      [first]
    );
    // The row was written: the count went up and the freshest account is on it.
    expect(report).toMatchObject({ occurrence_count: 2, body: "Seen again, at a second label." });
    expect(await labelsWhere("agent_report_sightings", "report_id = $1", [first])).toEqual([SECOND]);
  });

  it("leaves a finding's label alone and gives the sighting the label of the run that met it again", async () => {
    const { ids } = await oneRunAt(SECOND);
    const joined = await runAt(null, async () =>
      ok(
        await createFindingTools().execute("note_finding", {
          headline: "The same finding.", account: "Met a third time, from a public run.", claim_id: ids.claim,
          refs: [{ kind: "claim", id: ids.claim }], importance: 4, joins: ids.findingId,
        })
      )
    );
    expect(joined.finding_id).toBe(ids.findingId);
    expect(await labelOf("agent_findings", ids.findingId)).toBe(SECOND);
    const sightings = await rawQuery<{ sensitivity_label: string }>(
      `SELECT sensitivity_label FROM agent_finding_sightings WHERE finding_id = $1 ORDER BY noted_at`,
      [ids.findingId]
    );
    expect(sightings.map((s) => s.sensitivity_label)).toEqual([SECOND, PUBLIC_LABEL]);
  });

  it("leaves a setup part at the label of the run that first stored its text, whichever came first", async () => {
    // A part is stored once, by the hash of its text, and shared by every
    // run that used the same text. The first sighting's label stays.
    for (const [first, second] of [[null, SECOND], [SECOND, null]] as const) {
      const system = `You are a test of shared parts (${randomUUID()}).`;
      const one = await runAt(first, async () => {
        await oneCall(system);
        return getUsageContext().trace!.runId;
      });
      await closed(one);
      const stored = await storedPart(system);
      expect(stored.map((p) => p.sensitivity_label)).toEqual([first ?? PUBLIC_LABEL]);

      // Another process meets the text for the first time: nothing in memory
      // says it is stored, so the write is tried and lands on the row.
      resetSetupRegistry();
      const two = await runAt(second, async () => {
        await oneCall(system);
        return getUsageContext().trace!.runId;
      });
      await closed(two);
      // The second run's own rows are its own.
      expect(await labelsWhere("agent_steps", "run_id = $1", [two])).toEqual([second ?? PUBLIC_LABEL]);
      expect(await usageLabels(two, 1)).toEqual([second ?? PUBLIC_LABEL]);
      // Its setup names the same part, and the part is as it was: one row, one version.
      const [setup] = await rawQuery<{ parts: Array<{ kind: string; hash: string }> }>(
        `SELECT content->'setup'->'parts' AS parts FROM agent_steps WHERE run_id = $1 AND seq = 0`,
        [two]
      );
      expect(setup!.parts.map((p) => p.hash)).toContain(stored[0]!.hash);
      const after = await rawQuery<{ version: number; sensitivity_label: string }>(
        `SELECT version, sensitivity_label FROM setup_parts WHERE kind = 'role' AND content = $1`,
        [system]
      );
      expect(after).toEqual([{ version: stored[0]!.version, sensitivity_label: first ?? PUBLIC_LABEL }]);
    }
  });

  it("leaves an audit's label alone when the same audit is asked for again at another label", async () => {
    const dedupeKey = `label-runs:${randomUUID()}`;
    const ask = () => requestAudit({ auditType: "anomaly_investigation", context: "Once.", triggeredBy: "manual", dedupeKey });
    const first = await ask();
    expect(first).not.toBeNull();
    // The second request finds the audit already asked for and opens nothing.
    expect(await runWithUsageContext({ label: SECOND }, ask)).toBeNull();
    expect(await labelsWhere("audit_runs", "dedupe_key = $1", [dedupeKey])).toEqual([PUBLIC_LABEL]);
  });
});

describe("what a reader is shown", () => {
  let app: FastifyInstance;
  let rows: Awaited<ReturnType<typeof oneRunAt>>;
  let part: Awaited<ReturnType<typeof storedPart>>[number];

  beforeAll(async () => {
    const { buildApp } = await import("../../src/server/app.js");
    app = await buildApp();
    // Written at the second label, so a response that carried the column would carry a value to see.
    rows = await oneRunAt(SECOND);
    part = (await storedPart(rows.ids.system))[0]!;
  });

  afterAll(async () => {
    await app.close();
  });

  const carriesIt = (text: string) => /sensitivity[_ ]?label/i.test(text);
  /** The label's name as a JSON value. */
  const namesIt = (text: string) => text.includes(`"${SECOND}"`);
  /**
   * The one thing that names the label by design, as it did before this
   * column: the setup a run's prompt step records, which the hash chain
   * covers (docs/run-log.md) and which a run's summary repeats. Checks that
   * `setup` names it, and returns the rest for the check that nothing else does.
   */
  function withoutSetupLabel(body: string, setupOf: (parsed: any) => { label: string }): string {
    const parsed = JSON.parse(body);
    const setup = setupOf(parsed);
    expect(setup.label).toBe(SECOND);
    setup.label = "";
    return JSON.stringify(parsed);
  }

  it("has no view query_sql reads that exposes the column or reads one of these tables", async () => {
    const exposed = await rawQuery<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public_read' AND column_name = 'sensitivity_label'`
    );
    expect(exposed).toEqual([]);
    const readers = await rawQuery<{ viewname: string }>(
      `SELECT viewname FROM pg_views
        WHERE schemaname IN ('public', 'public_read')
          AND definition ~ ('\\m(' || array_to_string($1::text[], '|') || ')\\M')
        ORDER BY viewname`,
      [RUN_TABLES]
    );
    expect(readers).toEqual([]);
  });

  it("has no response of the run, setup, finding, report, usage or claim routes that carries it", async () => {
    const { ids } = rows;
    const urls: Array<[string, Record<string, string>?]> = [
      [`/runs/${ids.runId}/steps`],
      [`/runs/${ids.runId}/steps/1`],
      [`/runs/${ids.runId}/verify`],
      [`/runs/${ids.researchRunId}`],
      [`/setup/parts?hash=${part.hash}`],
      [`/setup/parts/role/${encodeURIComponent(part.name)}/${part.version}`],
      [`/setup/prompt-set`],
      [`/findings`],
      [`/findings/${ids.findingId}`],
      [`/findings?claim_id=${ids.claim}`],
      [`/reports`, SERVICE],
      [`/reports/${ids.reportId}`, SERVICE],
      [`/usage/system`, SERVICE],
      [`/queue`, SERVICE],
      ...["cursory", "standard", "deep"].map((d): [string] => [`/claims/${ids.claim}?information_depth=${d}`]),
      [`/claims/${ids.claim}/record`],
      [`/claims/${ids.claim}/events`],
      [`/changes`],
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
      `/runs/${ids.runId}/steps`,
      `/runs/${ids.runId}/steps/1`,
      `/runs/${ids.runId}/verify`,
      `/setup/parts?hash=${part.hash}`,
      `/findings/${ids.findingId}`,
      `/reports/${ids.reportId}`,
      `/usage/system`,
      `/claims/${ids.claim}?information_depth=deep`,
    ]));
    expect(answered.get(`/runs/${ids.runId}/steps/1`)).toContain("Done.");
    expect(answered.get(`/setup/parts?hash=${part.hash}`)).toContain(part.name);
    expect(answered.get(`/findings/${ids.findingId}`)).toContain(ids.tag);
    expect(answered.get(`/findings?claim_id=${ids.claim}`)).toContain(ids.findingId);
    expect(answered.get(`/reports/${ids.reportId}`)).toContain(ids.tag);
    expect(answered.get(`/reports`)).toContain(ids.reportId);

    // The run's summary and its prompt step serve the setup, label and all. Nothing else in them names it.
    const summary = await app.inject({ method: "GET", url: `/runs/${ids.runId}` });
    expect(summary.statusCode).toBe(200);
    expect(summary.body).toContain(part.hash);
    expect(carriesIt(summary.body)).toBe(false);
    expect(namesIt(withoutSetupLabel(summary.body, (run) => run.setup))).toBe(false);
    const step = await app.inject({ method: "GET", url: `/runs/${ids.runId}/steps/0` });
    expect(step.statusCode).toBe(200);
    expect(carriesIt(step.body)).toBe(false);
    expect(namesIt(withoutSetupLabel(step.body, (s) => s.content.setup))).toBe(false);
  });

  it("has no run read, and no agent's read of a report, a finding or a research run, that carries it", async () => {
    const { ids } = rows;
    const reports = createReportTools();
    const findings = createFindingTools();
    const reads: Array<[string, () => Promise<string | null>, string]> = [
      // What GET /runs/:id, get_run, list_run_steps and get_run_step serve.
      ["get_run", async () => withoutSetupLabel(JSON.stringify(await getRunSummary(ids.runId)), (run) => run.setup), part.hash],
      ["list_run_steps", async () => JSON.stringify(await listRunSteps(ids.runId)), "completion"],
      ["get_run_step", async () => JSON.stringify(await getRunStep(ids.runId, 1)), "Done."],
      ["verify_run_log", async () => JSON.stringify(await verifyRunLog(ids.runId)), "intact"],
      ["get_issue", () => reports.execute("get_issue", { report_id: ids.reportId }), ids.tag],
      ["search_issues", () => reports.execute("search_issues", { query: ids.title }), ids.reportId],
      ["search_findings", () => findings.execute("search_findings", { query: ids.tag, claim_id: ids.claim }), "findings"],
      ["get_research_run", () => readResearchRun({ research_run_id: ids.researchRunId }, { claimId: ids.claim, role: "claim_steward" } as never), ids.tag],
      ["the claim page's research runs", async () => JSON.stringify(await listResearchRunsForClaim(ids.claim)), ids.researchRunId],
    ];
    for (const [tool, read, shows] of reads) {
      const out = await read();
      expect(out, tool).not.toBeNull();
      // The check means something only if the read returned the rows.
      expect(out!, tool).toContain(shows);
      expect(carriesIt(out!), tool).toBe(false);
      expect(namesIt(out!), tool).toBe(false);
    }
    // The claim view the API and MCP serve, bare and with each section on its own.
    for (const include of [[], ...CLAIM_VIEW_INCLUDES.map((section) => [section])]) {
      const view = JSON.stringify(await getClaimView(ids.claim, { include }));
      expect(carriesIt(view), include.join()).toBe(false);
      expect(namesIt(view), include.join()).toBe(false);
    }
  });

  it("has no write tool's reply that carries it", async () => {
    const { ids } = rows;
    const replies = await runAt(SECOND, async () => [
      await createReportTools().execute("raise_issue", {
        kind: "improvement", severity: "idea", title: `A reply read whole (${randomUUID()})`, body: "An idea.",
      }),
      await createReportTools().execute("update_issue", { report_id: ids.reportId, note: "One more case." }),
      await createFindingTools().execute("note_finding", {
        headline: "The same finding.", account: "Met once more.", claim_id: ids.claim,
        refs: [{ kind: "claim", id: ids.claim }], importance: 4, joins: ids.findingId,
      }),
    ]);
    for (const reply of replies) {
      ok(reply);
      expect(carriesIt(reply!), reply!).toBe(false);
      expect(namesIt(reply!), reply!).toBe(false);
    }
  });
});
