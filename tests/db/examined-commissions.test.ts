/**
 * A Steward's commissioned research as an examination of a document (#865),
 * against real Postgres: the examination is opened before any money moves,
 * linked to the run, and handed to the Researcher when the engine runs it; a
 * document outside the node's map is refused with nothing recorded; and only
 * a Steward's research examines, since a review for the document's own sake
 * is a request.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const researcher = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { inputs: [] as Array<Record<string, unknown>> };
});

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

vi.mock("../../src/llm/agents/researcher.js", async (orig) => {
  const real = await orig<typeof import("../../src/llm/agents/researcher.js")>();
  return {
    ...real,
    runResearcher: vi.fn(async (input: Record<string, unknown>) => {
      researcher.inputs.push(input);
      return { status: "completed", report: { answer: "Checked." }, turns: 2, stopReason: "report", servedModels: [], toolNames: [], error: null };
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { commissionResearch } from "../../src/services/research-commission-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";

beforeAll(async () => {
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

async function mandate(): Promise<string> {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("exam-funder"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', pace = '{"kind":"as_needed"}'::jsonb WHERE id = $1`, [grantId]);
  return grantId;
}

async function seedSource(): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, 'Trial report', 'Methods\n\nThe primary outcome was HbA1c.') RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`]
  );
  return row!.id;
}

const BRIEF = "Check whether the reported primary outcome is the one the trial registered, and say where they differ.";

describe("commissioned research as an examination", () => {
  it("opens a claim-scoped examination, links it, and hands it to the Researcher", async () => {
    const grantId = await mandate();
    const claimId = await seedClaim("the trial met its primary outcome");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claimId]);
    const source = await seedSource();
    await rawQuery(`INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'met its primary outcome')`, [claimId, source]);

    const res = await commissionResearch({
      payer: { kind: "grant", grantId }, nodeId: claimId, task: BRIEF, budgetMicroUsd: 2 * OWL,
      tier: "standard", requestedBy: "claim_steward", wait: false,
      examine: { sourceId: source, facets: ["outcome", "Registration"] },
    });
    expect(res).toMatchObject({ ok: true });
    const runId = (res as { runId: string }).runId;
    const [exam] = await rawQuery<{ id: string; scope: string; trigger: string; claim_id: string; facets: string[] }>(
      `SELECT x.id, x.scope, x.trigger, x.claim_id, x.facets FROM examinations x
         JOIN research_runs r ON r.examination_id = x.id WHERE r.id = $1`,
      [runId]
    );
    expect(exam).toMatchObject({ scope: "claim", trigger: "claim", claim_id: claimId, facets: ["outcome", "registration"] });

    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND exclusion_group <> $1`, [`research:${runId}`]);
    expect(await processNextEngineAction()).toMatchObject({ status: "processed", kind: "research" });
    expect(researcher.inputs.at(-1)!.examination).toMatchObject({ id: exam!.id, source_id: source, scope: "claim" });
  });

  it("refuses a document outside the node's map, and research that is not a Steward's, recording nothing", async () => {
    const grantId = await mandate();
    const claimId = await seedClaim("another trial claim");
    const outside = await seedSource();
    const before = await rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM research_runs`);

    const off = await commissionResearch({
      payer: { kind: "grant", grantId }, nodeId: claimId, task: BRIEF, budgetMicroUsd: OWL,
      tier: "standard", requestedBy: "claim_steward", wait: false,
      examine: { sourceId: outside, facets: ["outcome"] },
    });
    expect(off).toMatchObject({ ok: false, message: expect.stringMatching(/not in this claim's map/) });

    const curator = await commissionResearch({
      payer: { kind: "grant", grantId }, nodeId: claimId, task: BRIEF, budgetMicroUsd: OWL,
      tier: "standard", requestedBy: "curator", wait: false,
      examine: { sourceId: outside, facets: ["outcome"] },
    });
    expect(curator).toMatchObject({ ok: false, message: expect.stringMatching(/file a request bearing on it/) });

    const after = await rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM research_runs`);
    expect(after[0]!.n).toBe(before[0]!.n);
    const exams = await rawQuery(`SELECT id FROM examinations WHERE source_id = $1`, [outside]);
    expect(exams).toEqual([]);
  });
});
