/**
 * Petitions on sessions (session-service.ts, petition-service.ts), against
 * real Postgres: a Steward's petition doesn't block; its decision returns
 * into the session. Granted while the run works, the money is placed on the
 * running row and the run's ceiling rises when it reads the decision; granted
 * after the session paused, it funds the pass that resumes it. A run with
 * nothing else to do waits briefly with wait_for_answers.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.SESSION_WAIT_FOR_ANSWERS_SECONDS = "1";
});

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));
// No model decides here: the test decides as the officer would.
vi.mock("../../src/llm/agents/program-officer.js", () => ({
  workMandateInbox: vi.fn(async () => {}),
  workWaitingInboxes: vi.fn(async () => 0),
}));

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { runWithUsageContext, withPassBudget, getUsageContext } from "../../src/llm/usage-context.js";
import { executeSpendTool } from "../../src/llm/tools/spend-tools.js";
import { executeSessionTool, takeArrivals } from "../../src/llm/tools/session-tools.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { decidePetition } from "../../src/services/petition-service.js";
import { suspendSession } from "../../src/services/session-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";

beforeAll(async () => {
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

/** A Steward's pass, commissioned by a mandate and running. */
async function runningPass() {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("petition-funder"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', daily_budget_micro_usd = 0 WHERE id = $1`, [grantId]);
  const claimId = await seedClaim("petition node");
  const res = await commissionNodePass({
    payer: { kind: "grant", grantId },
    claimId,
    budgetMicroUsd: OWL,
    brief: "Assess it.",
    commissionedBy: "program_officer",
  });
  if (!res.ok || res.status !== "commissioned") throw new Error("not commissioned");
  await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [res.actionId]);
  return { grantId, claimId, actionId: res.actionId };
}

/** Run fn as the Steward's pass: its session and its budget. */
async function asPass<T>(pass: { claimId: string; actionId: string }, sessionId: string, fn: () => Promise<T>) {
  const metered = await runWithUsageContext({ agent: "steward", claimId: pass.claimId, session: { id: sessionId, role: "steward", nodeId: pass.claimId } }, () =>
    withPassBudget({ microUsd: OWL, source: "the mandate's commission", funding: { actionId: pass.actionId } }, async () => {
      const value = await fn();
      return { value, ceiling: getUsageContext().passBudget!.microUsd };
    })
  );
  return (metered as unknown as { value: { value: T; ceiling: number } }).value;
}

async function petition(pass: { claimId: string; actionId: string }, sessionId: string) {
  return asPass(pass, sessionId, async () =>
    JSON.parse(
      (await executeSpendTool("petition_mandate", {
        kind: "more_budget",
        owls: 2,
        plan: "Read the three replication attempts the claim's main source cites and compare their effect sizes.",
        why: "The budget covers one of the three.",
      }))!
    )
  );
}

describe("a petition from a session", () => {
  it("returns at once, and a grant decided while the run works raises its ceiling when it reads it", async () => {
    const pass = await runningPass();
    const sessionId = randomUUID();
    const sent = (await petition(pass, sessionId)).value;
    expect(sent).toMatchObject({ success: true });
    expect(sent.message).toContain("Carry on");

    const decided = await decidePetition({
      petitionId: sent.petition_id,
      decision: "grant",
      owlsMicroUsd: 2 * OWL,
      reason: "The replications are the crux.",
      decidedBy: "officer",
    });
    expect(decided).toMatchObject({ ok: true });
    // The grant is on the running row, from the mandate.
    const [row] = await rawQuery<{ total: string }>(
      `SELECT SUM(amount_micro_usd)::bigint AS total FROM action_allocations WHERE action_id = $1 AND released_at IS NULL`,
      [pass.actionId]
    );
    expect(Number(row!.total)).toBe(3 * OWL);

    const read = await asPass(pass, sessionId, () => takeArrivals(sessionId));
    expect(read.value).toContain("Granted by the mandate's program officer: 2 of 2 owls");
    expect(read.ceiling).toBe(3 * OWL);
    // Shown once.
    expect((await asPass(pass, sessionId, () => takeArrivals(sessionId))).value).toBeNull();
  });

  it("waits briefly with wait_for_answers, and says to end the turn when nothing comes", async () => {
    const pass = await runningPass();
    const sessionId = randomUUID();
    await petition(pass, sessionId);
    const started = Date.now();
    const out = JSON.parse((await asPass(pass, sessionId, () => executeSessionTool("wait_for_answers", {}))).value!);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(out.message).toContain("end your turn");
  });

  it("funds the resuming pass with a grant decided after the session paused", async () => {
    const pass = await runningPass();
    const sessionId = randomUUID();
    const sent = (await petition(pass, sessionId)).value;
    // The run ends its turn and its row settles; the session pauses with half an owl left.
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [pass.actionId]);
    await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE action_id = $1`, [pass.actionId]);
    await suspendSession({
      id: sessionId,
      transcript: [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: "Waiting." }] }] as never,
      model: "m",
      budgetLeftMicroUsd: OWL / 2,
      payer: { kind: "grant", grantId: pass.grantId },
    });

    await decidePetition({
      petitionId: sent.petition_id,
      decision: "grant",
      owlsMicroUsd: 2 * OWL,
      reason: "The replications are the crux.",
      decidedBy: "grantmaker",
    });
    const [p] = await rawQuery<{ status: string }>(`SELECT status FROM petitions WHERE id = $1`, [sent.petition_id]);
    expect(p!.status).toBe("granted");
    const [s] = await rawQuery<{ status: string; extra_funding: unknown[]; replies: Array<{ text: string }> }>(
      `SELECT status, extra_funding, replies FROM agent_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(s!.status).toBe("ready");
    expect(s!.replies[0]!.text).toContain("added to the budget of the pass that resumes you");
    expect(s!.extra_funding).toEqual([]);
    // The resuming pass carries what the run had left and the grant. Both
    // come from the same mandate, so the ledger holds them as one placement.
    const live = await rawQuery<{ amount: string; grant_id: string }>(
      `SELECT amount_micro_usd AS amount, grant_id FROM action_allocations
        WHERE claim_id = $1 AND released_at IS NULL`,
      [pass.claimId]
    );
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ grant_id: pass.grantId });
    expect(Number(live[0]!.amount)).toBe(OWL / 2 + 2 * OWL);
  });
});
