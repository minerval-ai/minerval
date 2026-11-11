/**
 * Sessions for the agents whose work is not one node's pass (the Curator,
 * the Consistency Checker, the Audit Agent, Correspondents), against real
 * Postgres: an answer to a paused session commissions a `resume` row from the
 * same payer, and the engine executor rebuilds the agent from the input its
 * run was called with and continues its conversation with the answer.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const agents = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { calls: [] as Array<{ role: string; input: unknown; resume: { sessionId: string; messages: unknown[]; privateReasons?: string[] } | undefined }> };
});

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));
vi.mock("../../src/llm/agents/researcher.js", async (orig) => {
  const real = await orig<typeof import("../../src/llm/agents/researcher.js")>();
  const { getUsageContext } = await import("../../src/llm/usage-context.js");
  return {
    ...real,
    runResearcher: vi.fn(async () => {
      const meter = getUsageContext().meter;
      if (meter) meter.billedMicroUsd += 200_000;
      return { status: "completed", report: { answer: "Both nodes cite the same 2019 survey." }, turns: 2, stopReason: "report", servedModels: [], toolNames: [], error: null };
    }),
  };
});
// The agents stand in: the test checks what they are rebuilt with.
vi.mock("../../src/llm/agents/curator.js", () => ({
  runCurator: vi.fn(async (input: unknown, resume?: { sessionId: string; messages: unknown[] }) => {
    agents.calls.push({ role: "curator", input, resume });
  }),
}));
vi.mock("../../src/llm/agents/audit-agent.js", () => ({
  runAudit: vi.fn(async (input: unknown, resume?: { sessionId: string; messages: unknown[] }) => {
    agents.calls.push({ role: "audit", input, resume });
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { commissionResearch } from "../../src/services/research-commission-service.js";
import { suspendSession } from "../../src/services/session-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";

beforeAll(async () => {
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

async function mandate(): Promise<string> {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("agent-session-funder"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', daily_budget_micro_usd = 0 WHERE id = $1`, [grantId]);
  return grantId;
}

/** Run only the open rows in this group, as the executor would pick them. */
async function runOnly(group: string) {
  await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND exclusion_group <> $1`, [group]);
  return processNextEngineAction();
}

async function pauseOnResearch(role: string, nodeId: string | null, input: unknown, grantId: string) {
  const session = { id: randomUUID(), role, nodeId };
  const res = await runWithUsageContext({ session, agent: role }, () =>
    commissionResearch({
      payer: { kind: "grant", grantId },
      nodeId,
      task: "Find whether the two flagged nodes rest on the same underlying survey, and which edition.",
      budgetMicroUsd: OWL,
      tier: "standard",
      requestedBy: role,
      wait: true,
    })
  );
  if (!res.ok) throw new Error(res.message);
  await suspendSession({
    id: session.id,
    transcript: [
      { role: "user", content: "Curate these." },
      { role: "assistant", content: [{ type: "text", text: "I commissioned research and will wait." }] },
    ] as never,
    model: "m",
    budgetLeftMicroUsd: OWL,
    payer: { kind: "grant", grantId },
    context: { input },
  });
  return { sessionId: session.id, runId: res.runId };
}

describe("sessions for agents whose work is not one node's", () => {
  it("resumes a paused Curator through a resume row, rebuilt from its input, with the report", async () => {
    const grantId = await mandate();
    const anchor = await seedClaim("curator anchor");
    const input = { trigger: "curation_request", claimId: anchor, context: "Two nodes may be one." };
    const { sessionId, runId } = await pauseOnResearch("curator", anchor, input, grantId);

    expect(await runOnly(`research:${runId}`)).toMatchObject({ kind: "research" });
    // The answer commissioned a resume row from the same mandate, at what the run had left.
    const [row] = await rawQuery<{ exclusion_group: string; status: string; amount: string; grant_id: string }>(
      `SELECT a.exclusion_group, a.status, al.amount_micro_usd AS amount, al.grant_id
         FROM actions a JOIN action_allocations al ON al.action_id = a.id AND al.released_at IS NULL
        WHERE a.kind = 'resume' AND a.target_ref = $1`,
      [sessionId]
    );
    expect(row).toMatchObject({ status: "open", grant_id: grantId });
    expect(Number(row!.amount)).toBe(OWL);

    agents.calls.length = 0;
    expect(await runOnly(row!.exclusion_group)).toMatchObject({ status: "processed", kind: "resume" });
    expect(agents.calls).toHaveLength(1);
    const call = agents.calls[0]!;
    expect(call.role).toBe("curator");
    expect(call.input).toEqual(input);
    expect(call.resume?.sessionId).toBe(sessionId);
    const last = JSON.stringify(call.resume!.messages.at(-1));
    expect(last).toContain("Your session resumes");
    expect(last).toContain("Both nodes cite the same 2019 survey.");
    // A research report is not public, so the resumed run starts private.
    expect(call.resume?.privateReasons).toContain("input:research-report");
    // The resume row settled.
    const [done] = await rawQuery<{ status: string }>(`SELECT status FROM actions WHERE exclusion_group = $1`, [row!.exclusion_group]);
    expect(done!.status).toBe("done");
  });

  it("gives a session with no node its research back, and resumes it the same way", async () => {
    const grantId = await mandate();
    const input = { auditType: "decision_audit", context: "A run of overturns on one contributor." };
    const { sessionId, runId } = await pauseOnResearch("audit", null, input, grantId);
    await runOnly(`research:${runId}`);
    const [s] = await rawQuery<{ status: string }>(`SELECT status FROM agent_sessions WHERE id = $1`, [sessionId]);
    expect(s!.status).toBe("ready");
    const [row] = await rawQuery<{ exclusion_group: string }>(
      `SELECT exclusion_group FROM actions WHERE kind = 'resume' AND target_ref = $1`,
      [sessionId]
    );
    agents.calls.length = 0;
    await runOnly(row!.exclusion_group);
    expect(agents.calls.map((c) => c.role)).toEqual(["audit"]);
    expect(agents.calls[0]!.input).toEqual(input);
    // No node to read again: the resumed run is told the graph may have moved.
    expect(JSON.stringify(agents.calls[0]!.resume!.messages.at(-1))).toContain("the graph may have moved");
  });
});
