/**
 * Every kind of judgment names the run that wrote it, so that a page of it
 * shown across a boundary carries that run's log seal
 * (services/showing-service.ts, runLogFacts). Quantities' estimates had no
 * run_id, and the first run with real models showed a quantity's page going
 * outside with "run_log": null in record mode.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { defineQuantity, recordEstimate } from "../../src/services/quantity-service.js";
import { markQuestion, recordQuestionAssessment } from "../../src/services/question-service.js";
import { seedClaim } from "./helpers.js";

describe("the run that wrote a judgment", () => {
  it("is recorded on a quantity's estimate and a question's assessment, from the run's context", async () => {
    const runId = randomUUID();
    const quantity = await seedClaim("judgment-run quantity");
    await defineQuantity({
      claimId: quantity,
      definition: { measures: "Tests run", population: "This suite", unit: { kind: "count", noun: "tests", min: 0 } },
      createdBy: "dbtest",
    });
    const question = await seedClaim("judgment-run question");
    await markQuestion(question);
    const estimate = await runWithUsageContext({ runId }, () =>
      recordEstimate({ claimId: quantity, estimate: { form: "interval", low: 1, high: 5 }, work: "counted" })
    );
    const assessed = await runWithUsageContext({ runId }, () => recordQuestionAssessment({ claimId: question, standing: "open", reasoningTrace: "t" }));
    const [e] = await rawQuery<{ run_id: string | null }>(`SELECT run_id FROM quantity_estimates WHERE id = $1`, [estimate.id]);
    expect(e!.run_id).toBe(runId);
    const [q] = await rawQuery<{ run_id: string | null }>(`SELECT run_id FROM question_assessments WHERE id = $1`, [(assessed as { id: string }).id]);
    expect(q!.run_id).toBe(runId);
    // And the views every reader goes through carry it.
    const [inForce] = await rawQuery<{ run_id: string | null }>(`SELECT run_id FROM quantity_estimates_in_force WHERE claim_id = $1`, [quantity]);
    expect(inForce!.run_id).toBe(runId);
  });
});
