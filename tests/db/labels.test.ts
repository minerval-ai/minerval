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

import { rawQuery } from "../../src/db/client.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import { currentLabel, getUsageContext, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { addArgument, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
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
  const [row] = await rawQuery<{ label: string }>(`SELECT label FROM ${table} WHERE id = $1`, [id]);
  return row?.label;
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

  it("gives every labelled table a column that defaults to public", async () => {
    // The tables whose `label` points at this table. Two older columns share
    // the name and mean something else (actions.label, source_segments.label).
    const rows = await rawQuery<{ table_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT c.table_name, c.column_default, c.is_nullable
         FROM information_schema.columns c
         JOIN pg_constraint k
           ON k.conrelid = format('%I.%I', c.table_schema, c.table_name)::regclass
          AND k.contype = 'f' AND k.confrelid = 'public.labels'::regclass
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] AND a.attname = c.column_name
        WHERE c.table_schema = 'public' AND c.column_name = 'label' AND c.table_name <> 'label_reads'
        ORDER BY c.table_name`
    );
    expect(rows).toEqual(
      ["agent_runs", "argument_evaluations", "assessments", "quantity_estimates", "question_assessments", "sources"].map(
        (table_name) => ({ table_name, column_default: "'public'::text", is_nullable: "NO" })
      )
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
    const [inForce] = await rawQuery<{ label: string }>(
      `SELECT label FROM assessments_in_force WHERE claim_id = $1`,
      [ids.claim]
    );
    expect(inForce!.label).toBe("public");
  });

  it("is public on a row inserted without naming a label", async () => {
    const claim = await seedClaim("labels default");
    const [row] = await rawQuery<{ label: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
       VALUES ($1, 'supported', 0.7, 'dbtest') RETURNING label`,
      [claim]
    );
    expect(row!.label).toBe("public");
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

describe("a label that no row defines", () => {
  it("is refused on every labelled table by its foreign key", async () => {
    const claim = await seedClaim("labels fk");
    const inserts: Array<[string, unknown[]]> = [
      [
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, label)
         VALUES ($1, 'supported', 0.7, 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO quantity_estimates (claim_id, estimate, work, is_current, label)
         VALUES ($1, '{"form":"none"}', 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, is_current, label)
         VALUES ($1, 'open', 'dbtest', false, 'undefined-label')`,
        [claim],
      ],
      [
        `INSERT INTO sources (url, title, label) VALUES ($1, 'DB-test source', 'undefined-label')`,
        [`https://dbtest.example/labels/${randomUUID()}`],
      ],
      [`INSERT INTO agent_runs (agent, label) VALUES ('steward', 'undefined-label')`, []],
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
        `INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, label)
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
