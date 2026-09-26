/**
 * The research_runs table (#298) against a database migrated from zero: the
 * row a delegation opens and closes, the money CHECKs, the notebook written
 * by section, cascade under the claim, the per-claim listing the claim page
 * discloses, and the daily cap read from the durable meter.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, pgCode } from "./helpers.js";
import {
  checkResearcherBudget,
  closeResearchRun,
  getResearchRun,
  listResearchRunsForClaim,
  openResearchRun,
  readResearcherPaused,
  stampResearchRun,
  updateResearchProgress,
  writeResearchNotebookSection,
} from "../../src/services/research-run-service.js";
import { LlmBudgetExceededError } from "../../src/llm/errors.js";

const CHECK_VIOLATION = "23514";

describe("research_runs", () => {
  it("opens, stamps, progresses, and closes a run, keeping its notebook by section", async () => {
    const claimId = await seedClaim("research");
    const run = await openResearchRun({
      claimId,
      grantId: null,
      requestedBy: "claim_steward",
      requesterRunId: null,
      jobId: null,
      task: "Trace the figure to its origin.",
      model: "claude-sonnet-5",
      modelTier: "standard",
      effort: null,
      includeConstitution: true,
      ceilingMicroUsd: 1_500_000,
    });
    expect(run.status).toBe("running");
    expect(run.ceiling_micro_usd).toBe(1_500_000);
    expect(run.notebook).toEqual({});

    await stampResearchRun(run.id, { runId: null, tools: ["search_claims", "report"] });
    await writeResearchNotebookSection(run.id, "thread 1", "started");
    await writeResearchNotebookSection(run.id, "thread 1", "finished");
    await writeResearchNotebookSection(run.id, "dead end", "the table is not there");
    await updateResearchProgress(run.id, { turns: 4, spentMicroUsd: 400_000, servedModels: ["claude-sonnet-5"] });

    const mid = await getResearchRun(run.id);
    expect(mid?.tools).toEqual(["search_claims", "report"]);
    expect(mid?.notebook).toEqual({ "thread 1": "finished", "dead end": "the table is not there" });
    expect(mid?.turns).toBe(4);
    expect(mid?.spent_micro_usd).toBe(400_000);

    const closed = await closeResearchRun(run.id, {
      status: "completed",
      report: { answer: "one study" },
      spentMicroUsd: 912_345,
      turns: 6,
      servedModels: ["claude-sonnet-5"],
      error: null,
    });
    expect(closed?.status).toBe("completed");
    expect(closed?.report).toEqual({ answer: "one study" });
    expect(closed?.spent_micro_usd).toBe(912_345);
    expect(closed?.finished_at).not.toBeNull();

    const listed = await listResearchRunsForClaim(claimId);
    expect(listed.map((r) => r.id)).toEqual([run.id]);

    // The record dies with the claim.
    await rawQuery(`DELETE FROM claims WHERE id = $1`, [claimId]);
    expect(await getResearchRun(run.id)).toBeNull();
  });

  it("holds the money CHECKs", async () => {
    const claimId = await seedClaim("research-ck");
    await expect(
      rawQuery(
        `INSERT INTO research_runs (claim_id, requested_by, task, model, model_tier, ceiling_micro_usd)
         VALUES ($1, 'claim_steward', 't', 'm', 'cheap', 0)`,
        [claimId]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
    await expect(
      rawQuery(
        `INSERT INTO research_runs (claim_id, requested_by, task, model, model_tier, ceiling_micro_usd, spent_micro_usd)
         VALUES ($1, 'claim_steward', 't', 'm', 'cheap', 10, -1)`,
        [claimId]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);
  });

  it("reads the pause flag and the daily cap from the durable rows", async () => {
    await rawQuery(`DELETE FROM platform_flags WHERE key = 'researcher_paused'`);
    expect(await readResearcherPaused()).toBe(false);
    await rawQuery(`INSERT INTO platform_flags (key, value) VALUES ('researcher_paused', 'true'::jsonb)`);
    expect(await readResearcherPaused()).toBe(true);
    await rawQuery(`DELETE FROM platform_flags WHERE key = 'researcher_paused'`);

    // Nothing spent today: a run within the cap passes, one past it does not
    // (the default cap is 50 owls of metered work).
    await expect(checkResearcherBudget(1_000_000)).resolves.toBeUndefined();
    await expect(checkResearcherBudget(60_000_000_000)).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});
