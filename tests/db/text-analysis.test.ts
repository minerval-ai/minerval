/**
 * Background text analyses (MCP extract_claims / assess_text), against real
 * Postgres: the job comes back before the work runs, progress is readable
 * while it runs, the result is the asking account's alone, a failure is
 * recorded, and an analysis whose process died reads as failed.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  getTextAnalysis,
  settleTextAnalyses,
  startTextAnalysis,
} from "../../src/services/text-analysis-service.js";
import { seedUser } from "./helpers.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { open, promise };
}

describe("text analyses", () => {
  it("returns before the work runs, shows progress, then the result", async () => {
    const userId = await seedUser("analysis-basic");
    const owner = { userId, apiKeyId: null };
    const first = gate();
    const second = gate();
    const job = await startTextAnalysis("assess_text", { max_claims: 2 }, owner, async (progress) => {
      await first.promise;
      await progress({ claims_extracted: 2, judgments: [{ verdict: "supported" }] });
      await second.promise;
      return { claims_extracted: 2, judgments: [{ verdict: "supported" }, { verdict: "unknown" }] };
    });

    expect((await getTextAnalysis(job.id, owner))).toMatchObject({
      status: "processing",
      result: null,
    });

    first.open();
    await new Promise((r) => setTimeout(r, 50));
    expect(await getTextAnalysis(job.id, owner)).toMatchObject({
      status: "processing",
      result: { claims_extracted: 2, judgments: [{ verdict: "supported" }] },
    });

    second.open();
    await settleTextAnalyses();
    const done = await getTextAnalysis(job.id, owner);
    expect(done).toMatchObject({ status: "complete", error: null });
    expect((done!.result as { judgments: unknown[] }).judgments).toHaveLength(2);
    expect(done!.completed_at).not.toBeNull();
    // The text is never stored, only the parameters.
    const [row] = await rawQuery<{ input: unknown }>(`SELECT input FROM jobs WHERE id = $1`, [job.id]);
    expect(row!.input).toEqual({ max_claims: 2 });
  });

  it("is readable by the account that asked and no one else", async () => {
    const userId = await seedUser("analysis-owner");
    const other = await seedUser("analysis-other");
    const job = await startTextAnalysis("extract_claims", {}, { userId, apiKeyId: null }, async () => ({
      claims: [],
    }));
    await settleTextAnalyses();
    expect(await getTextAnalysis(job.id, { userId, apiKeyId: null })).not.toBeNull();
    expect(await getTextAnalysis(job.id, { userId: other, apiKeyId: null })).toBeNull();
    expect(await getTextAnalysis(job.id, { userId: null, apiKeyId: null })).toBeNull();
  });

  it("records why an analysis failed", async () => {
    const userId = await seedUser("analysis-fail");
    const owner = { userId, apiKeyId: null };
    const job = await startTextAnalysis("extract_claims", {}, owner, async () => {
      throw new Error("the extractor timed out");
    });
    await settleTextAnalyses();
    expect(await getTextAnalysis(job.id, owner)).toMatchObject({
      status: "failed",
      error: "the extractor timed out",
    });
  });

  it("reads an analysis whose process died as failed", async () => {
    const userId = await seedUser("analysis-lost");
    const owner = { userId, apiKeyId: null };
    const job = await startTextAnalysis("extract_claims", {}, owner, async () => ({ claims: [] }));
    await settleTextAnalyses();
    // An analysis that stopped beating while still processing.
    await rawQuery(
      `UPDATE jobs SET status = 'processing', completed_at = NULL,
              result = jsonb_build_object('heartbeat_at', to_jsonb(now() - interval '10 minutes'))
        WHERE id = $1`,
      [job.id]
    );
    expect(await getTextAnalysis(job.id, owner)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/interrupted/),
    });
  });
});
