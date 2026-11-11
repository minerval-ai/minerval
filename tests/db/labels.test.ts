/**
 * Labels (src/labels.ts): the seed row, the label each write seam stamps
 * from the context it runs in, and the foreign key that keeps a row from
 * carrying a label no one defined. Nothing reads a label yet, so this is
 * about what is written, through the same functions the agents write with.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

// Tracing is off under vitest by default; the run row is part of what is checked.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

// No model is called: the provider answers from here. Everything after it is
// the real path, from the client's prompt step to the rows in Postgres.
vi.mock("../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/index.js")>()),
  getAdapter: () => ({
    complete: async (options: { model: string }) => ({
      content: "Done.",
      model: options.model,
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }),
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { complete } from "../../src/llm/client.js";
import { currentLabel, getUsageContext, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { addArgument, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
import { verifyRunLog, type RunLogCheck } from "../../src/services/run-view-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { seedClaim } from "./helpers.js";

const INTERNAL = "internal";
const FOREIGN_KEY_VIOLATION = "23503";

/** The SQLSTATE of a Postgres error, or of the one a query error wraps. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

async function labelOf(table: string, id: string): Promise<string | undefined> {
  const [row] = await rawQuery<{ sensitivity_label: string }>(
    `SELECT sensitivity_label FROM ${table} WHERE id = $1`,
    [id]
  );
  return row?.sensitivity_label;
}

/** One row in each labelled content table, written through its own write seam; returns their ids. */
async function writeOneOfEach() {
  const claim = await seedClaim("labels verdict");
  const verdict = JSON.parse(
    await executeStewardTool("update_claim_assessment", {
      claim_id: claim,
      status: "supported",
      confidence: 0.7,
      assessment: "Judged for the labels test.",
      reasoning_trace: "dbtest",
    })
  );
  expect(verdict.success).toBe(true);
  const [assessment] = await rawQuery<{ id: string }>(
    `SELECT id FROM assessments WHERE claim_id = $1 AND is_current = true`,
    [claim]
  );

  const argument = await addArgument({
    claimId: claim,
    stance: "for",
    name: `the labels argument ${randomUUID()}`,
    content: "It follows.",
    createdBy: "claim_steward",
  });
  const evaluation = await setArgumentEvaluation({
    argumentId: argument.id,
    verdict: "likely",
    content: "It goes through.",
    assessmentId: assessment!.id,
  });

  const quantity = await seedClaim("labels quantity");
  await defineQuantity({
    claimId: quantity,
    definition: { measures: "Rows written", population: "This test", unit: { kind: "count", noun: "rows", min: 0 } },
    createdBy: "dbtest",
  });
  const estimate = await recordEstimate({
    claimId: quantity,
    estimate: { form: "interval", low: 1, high: 5 },
    work: "counted",
  });

  const question = await seedClaim("labels question");
  await markQuestion(question);
  const standing = await recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "dbtest" });

  const source = await getOrCreateSource({ url: `https://dbtest.example/labels/${randomUUID()}`, title: "A document" });

  return {
    claim,
    assessment: assessment!.id,
    evaluation: evaluation.id,
    estimate: estimate.id,
    standing: standing.id,
    source: source.id,
  };
}

async function labelsOf(ids: Awaited<ReturnType<typeof writeOneOfEach>>) {
  return {
    assessment: await labelOf("assessments", ids.assessment),
    evaluation: await labelOf("argument_evaluations", ids.evaluation),
    estimate: await labelOf("quantity_estimates", ids.estimate),
    standing: await labelOf("question_assessments", ids.standing),
    source: await labelOf("sources", ids.source),
  };
}

beforeAll(async () => {
  // A second label, as a deployment would define one: a row, nothing else.
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable inside the organisation.')
     ON CONFLICT (name) DO NOTHING`,
    [INTERNAL]
  );
});

describe("the labels table", () => {
  it("holds the public label from the migration, and no reading pairs", async () => {
    const [row] = await rawQuery<{ name: string; description: string; created_at: Date }>(
      `SELECT name, description, created_at FROM labels WHERE name = $1`,
      [PUBLIC_LABEL]
    );
    expect(row).toMatchObject({ name: "public", description: "Readable by anyone." });
    expect(row!.created_at).toBeInstanceOf(Date);
    const [pairs] = await rawQuery<{ n: string }>(`SELECT count(*)::text AS n FROM label_reads`);
    expect(pairs!.n).toBe("0");
  });

  it("gives every labelled table a sensitivity_label that defaults to public and points here", async () => {
    // The column has its own name because `label` is already a display name
    // on tables that will need one (actions, source_segments).
    const rows = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string; fk: boolean }>(
      `SELECT c.table_name, c.column_default, c.is_nullable,
              EXISTS (
                SELECT 1 FROM pg_constraint k
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                 WHERE k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
                   AND k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
                   AND a.attname = c.column_name
              ) AS fk
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'sensitivity_label' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`
    );
    // The first six are what a run writes. The rest stand for work waiting
    // to be done, and hand their label to the run that takes it up
    // (label-carried.test.ts).
    expect(rows).toEqual(
      [
        "actions", "agent_runs", "agent_sessions", "appeals", "argument_evaluations", "assessment_orders",
        "assessments", "assistant_held_actions", "budget_jobs", "contributions", "jobs", "quantity_estimates",
        "question_assessments", "sources",
      ].map((table_name) => ({ table_name, column_default: "'public'::text", is_nullable: "NO", fk: true }))
    );
  });

  it("takes a reading pair between two labels, once, and none that names an undefined label", async () => {
    try {
      await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [INTERNAL, PUBLIC_LABEL]);
      await expect(
        rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [INTERNAL, PUBLIC_LABEL])
      ).rejects.toSatisfy((err) => sqlState(err) === "23505");
      for (const [label, reads] of [[INTERNAL, "undefined-label"], ["undefined-label", PUBLIC_LABEL]]) {
        await expect(
          rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, $2)`, [label, reads])
        ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
      }
    } finally {
      // The scratch database is shared with the files that run after this one.
      await rawQuery(`DELETE FROM label_reads WHERE label = $1`, [INTERNAL]);
    }
  });
});

describe("a write outside any run", () => {
  it("is public: each kind of judgment, and a source", async () => {
    expect(currentLabel()).toBe(PUBLIC_LABEL);
    const ids = await writeOneOfEach();
    expect(await labelsOf(ids)).toEqual({
      assessment: "public",
      evaluation: "public",
      estimate: "public",
      standing: "public",
      source: "public",
    });
    // The views of the judgment in force carry the column with the rest.
    const [inForce] = await rawQuery<{ sensitivity_label: string }>(
      `SELECT sensitivity_label FROM assessments_in_force WHERE claim_id = $1`,
      [ids.claim]
    );
    expect(inForce!.sensitivity_label).toBe("public");
  });

  it("is public on a row inserted without naming a label", async () => {
    const claim = await seedClaim("labels default");
    const [row] = await rawQuery<{ sensitivity_label: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
       VALUES ($1, 'supported', 0.7, 'dbtest') RETURNING sensitivity_label`,
      [claim]
    );
    expect(row!.sensitivity_label).toBe("public");
  });
});

describe("a write inside a run", () => {
  it("carries the run's label, and so does the run row", async () => {
    const { ids, runId } = await runWithUsageContext({ label: INTERNAL }, () =>
      withAgent("steward", async () => {
        const trace = getUsageContext().trace!;
        await trace.ready;
        return { ids: await writeOneOfEach(), runId: trace.runId };
      })
    );
    expect(await labelsOf(ids)).toEqual({
      assessment: INTERNAL,
      evaluation: INTERNAL,
      estimate: INTERNAL,
      standing: INTERNAL,
      source: INTERNAL,
    });
    expect(await labelOf("agent_runs", runId)).toBe(INTERNAL);
    // The verdict names its run, and the two agree.
    const [verdict] = await rawQuery<{ run_id: string }>(`SELECT run_id FROM assessments WHERE id = $1`, [ids.assessment]);
    expect(verdict!.run_id).toBe(runId);
  });

  it("is public when the run's context sets no label", async () => {
    const { source, runId } = await withAgent("steward", async () => {
      const trace = getUsageContext().trace!;
      await trace.ready;
      const row = await getOrCreateSource({ url: `https://dbtest.example/labels/${randomUUID()}` });
      return { source: row.id, runId: trace.runId };
    });
    expect(await labelOf("sources", source)).toBe("public");
    expect(await labelOf("agent_runs", runId)).toBe("public");
  });

  it("leaves a source already recorded at the label it was first recorded with", async () => {
    const url = `https://dbtest.example/labels/${randomUUID()}`;
    const first = await getOrCreateSource({ url });
    const again = await runWithUsageContext({ label: INTERNAL }, () => getOrCreateSource({ url, content: "The text." }));
    expect(again.id).toBe(first.id);
    expect(await labelOf("sources", first.id)).toBe("public");
  });
});

// The label a run worked at is in its log, on the prompt step's setup, where
// the hash chain covers it (docs/run-log.md).
describe("the label in a run's log", () => {
  /** A run that makes one model call, so the client records its prompt step; returns the run's id. */
  async function runWithOneCall(): Promise<string> {
    return withAgent("matcher", async () => {
      await complete({
        model: "claude-sonnet-5-5",
        system: "You are a test.",
        messages: [{ role: "user", content: "Say done." }],
      });
      return getUsageContext().trace!.runId;
    });
  }

  /** Wait for the run to close with its seal, which in the default mode comes after it returns. */
  async function sealed(runId: string) {
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

  async function promptStep(runId: string) {
    const [step] = await rawQuery<{ seq: number; kind: string; setup: { label?: string; model?: string; featuresOff?: string[] } | null }>(
      `SELECT seq, kind, content->'setup' AS setup FROM agent_steps WHERE run_id = $1 ORDER BY seq LIMIT 1`,
      [runId]
    );
    return step!;
  }

  async function verify(runId: string): Promise<RunLogCheck> {
    const check = await verifyRunLog(runId);
    if (!check || "withheld" in check) throw new Error("expected a check");
    return check;
  }

  it("is on the prompt step's setup and under the run's seal", async () => {
    const runId = await runWithUsageContext({ label: INTERNAL }, runWithOneCall);
    const run = await sealed(runId);
    expect(run.sensitivity_label).toBe(INTERNAL);
    expect(run.sealed_at).not.toBeNull();

    // The first step is the prompt step the client recorded, and its setup names the label.
    const step = await promptStep(runId);
    expect(step).toMatchObject({ seq: 0, kind: "prompt", setup: { label: INTERNAL, model: "claude-sonnet-5-5" } });

    // The chain, prompt step included, reaches the seal.
    expect(await verify(runId)).toMatchObject({
      sealed: true, log_hash: run.log_hash, head: run.log_hash, intact: true, problem: null,
      steps_counted: 2, steps_recorded: 2, steps_checked: 2,
    });

    // So the label cannot be changed afterwards without the log showing it.
    await rawQuery(
      `UPDATE agent_steps SET content = jsonb_set(content, '{setup,label}', '"public"') WHERE run_id = $1 AND seq = 0`,
      [runId]
    );
    expect(await verify(runId)).toMatchObject({ intact: false, problem: { seq: 0, reason: "hash_mismatch" } });
  });

  it("says public for a run whose context sets no label", async () => {
    const runId = await runWithOneCall();
    const run = await sealed(runId);
    expect(run.sensitivity_label).toBe("public");
    // The setup also lists the features that were off for the run
    // (src/features.ts): none here, recorded as an empty list.
    expect(await promptStep(runId)).toMatchObject({
      seq: 0, kind: "prompt", setup: { label: "public", featuresOff: [] },
    });
    expect(await verify(runId)).toMatchObject({ sealed: true, head: run.log_hash, intact: true, problem: null, steps_checked: 2 });
  });
});

describe("a label that no row defines", () => {
  it("is refused on every labelled table by its foreign key", async () => {
    const claim = await seedClaim("labels fk");
    const inserts: Array<[string, unknown[]]> = [
      [
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'supported', 0.7, 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO quantity_estimates (claim_id, estimate, work, is_current, sensitivity_label)
         VALUES ($1, '{"form":"none"}', 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, is_current, sensitivity_label)
         VALUES ($1, 'open', 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'DB-test source', 'undefined-label')`,
        [`https://dbtest.example/labels/${randomUUID()}`],
      ],
      [`INSERT INTO agent_runs (agent, sensitivity_label) VALUES ('steward', 'undefined-label')`, []],
    ];
    for (const [sql, params] of inserts) {
      await expect(rawQuery(sql, params), sql).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    }

    const argument = await addArgument({
      claimId: claim,
      stance: "for",
      name: `the labels fk argument ${randomUUID()}`,
      content: "It follows.",
      createdBy: "claim_steward",
    });
    await expect(
      rawQuery(
        `INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, sensitivity_label)
         VALUES ($1, 'likely', 'dbtest', false, 'undefined-label')`,
        [argument.id]
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
  });

  it("fails the write of a run whose context names it", async () => {
    const url = `https://dbtest.example/labels/${randomUUID()}`;
    await expect(
      runWithUsageContext({ label: "undefined-label" }, () => getOrCreateSource({ url }))
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
    const rows = await rawQuery(`SELECT 1 FROM sources WHERE url = $1`, [url]);
    expect(rows).toHaveLength(0);
  });

  it("cannot be made by deleting a label that rows still carry", async () => {
    await expect(rawQuery(`DELETE FROM labels WHERE name = $1`, [PUBLIC_LABEL])).rejects.toSatisfy(
      (err) => sqlState(err) === FOREIGN_KEY_VIOLATION
    );
  });
});
