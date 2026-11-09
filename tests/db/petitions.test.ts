/**
 * Petitions against real Postgres: routed to the mandate whose money a run
 * spends, decided while the run waits, a grant placed on the running row and
 * settled with it, a follow-up commissioned once the run has ended, and an
 * officer held to the limit its Grantmaker delegated.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { ASSESS_GROUP, completeAction } from "../../src/services/action-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import {
  awaitDecision,
  commissionFollowUps,
  decidePetition,
  filePetition,
  getPetition,
  routePetition,
} from "../../src/services/petition-service.js";
import { writeOperatingPolicy } from "../../src/services/operating-policy-service.js";
import { executeOfficerTool } from "../../src/llm/agents/program-officer.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function runningPass(grantId: string, label: string): Promise<{ claim: string; actionId: string }> {
  const claim = await seedClaim(label);
  await commissionNodePass({ payer: { kind: "grant", grantId }, claimId: claim, budgetMicroUsd: 3 * OWL, brief: label, commissionedBy: "program_officer" });
  const [a] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
    [ASSESS_GROUP(claim)]
  );
  await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [a!.id]);
  return { claim, actionId: a!.id };
}

async function liveMoney(actionId: string): Promise<number> {
  const [r] = await rawQuery<{ n: string }>(
    `SELECT COALESCE(SUM(al.amount_micro_usd - al.spent_micro_usd), 0) AS n
       FROM action_allocations al JOIN actions a ON a.id = $1
      WHERE al.exclusion_group = a.exclusion_group AND al.released_at IS NULL
        AND (al.action_id IS NULL OR al.action_id = a.id)`,
    [actionId]
  );
  return Number(r!.n);
}

describe("petitions", () => {
  it("routes to the mandate whose money the run spends, even down a chain of runs", async () => {
    const funder = await seedUser("petition router");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const parent = await runningPass(grantId, "router parent");
    const child = await seedClaim("router child");
    await commissionNodePass({ payer: { kind: "run", actionId: parent.actionId }, claimId: child, budgetMicroUsd: OWL, brief: "c", commissionedBy: "steward" });
    const [c] = await rawQuery<{ id: string }>(`SELECT id FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`, [ASSESS_GROUP(child)]);
    expect(await routePetition({ actionId: c!.id })).toBe(grantId);
    expect(await routePetition({ grantId })).toBe(grantId);
    expect(await routePetition(null)).toBeNull();
  });

  it("decides while the run waits, and puts a grant on the running row, settled with it", async () => {
    const funder = await seedUser("petition grant");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const { claim, actionId } = await runningPass(grantId, "petitioner");
    const id = await filePetition({
      grantId,
      kind: "more_budget",
      askedMicroUsd: 2 * OWL,
      plan: "Read the three replications the page doesn't cite.",
      requesterAgent: "steward",
      requesterActionId: actionId,
      requesterNodeId: claim,
      spentMicroUsd: 2.6 * OWL,
      waiting: true,
    });
    const p0 = await getPetition(id);
    expect(p0!.chain.at(-1)).toMatchObject({ action_id: actionId, spent_micro_usd: 2.6 * OWL });

    let worked = 0;
    const decided = await awaitDecision(
      id,
      async () => {
        worked++;
        const r = await decidePetition({ petitionId: id, decision: "grant", owlsMicroUsd: 2 * OWL, reason: "The replications decide it.", decidedBy: "officer" });
        expect(r.ok).toBe(true);
      },
      { deadlineMs: 5000, pollMs: 50 }
    );
    expect(worked).toBe(1);
    expect(decided).toMatchObject({ status: "granted", granted_micro_usd: String(2 * OWL), decided_by: "officer" });
    expect(await liveMoney(actionId)).toBe(5 * OWL);

    const [d] = await rawQuery<{ item_kind: string; decision: string; reason: string }>(
      `SELECT item_kind, decision, reason FROM mandate_decisions WHERE petition_id = $1`,
      [id]
    );
    expect(d).toEqual({ item_kind: "petition", decision: "granted", reason: "The replications decide it." });

    // The run settles everything it held: what it didn't spend goes back.
    await completeAction(actionId, 3.5 * OWL, { meteredJobId: jobId });
    expect(await liveMoney(actionId)).toBe(0);
  });

  it("commissions a follow-up once the petitioner's run has ended", async () => {
    const funder = await seedUser("petition follow-up");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const { claim, actionId } = await runningPass(grantId, "follow-up petitioner");
    const id = await filePetition({ grantId, kind: "follow_up", askedMicroUsd: 4 * OWL, plan: "Synthesize the trial literature.", requesterAgent: "steward", requesterActionId: actionId, requesterNodeId: claim, waiting: false });
    const r = await decidePetition({ petitionId: id, decision: "follow_up", owlsMicroUsd: 4 * OWL, reason: "Too large for this pass.", decidedBy: "officer" });
    expect(r.ok).toBe(true);
    // Not while the run is still running.
    expect(await commissionFollowUps(actionId)).toBe(0);
    await completeAction(actionId, OWL, { meteredJobId: jobId });
    expect(await commissionFollowUps(actionId)).toBe(1);
    const [m] = await rawQuery<{ body: string; paid: boolean }>(
      `SELECT body, paid FROM node_messages WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [claim]
    );
    expect(m!.paid).toBe(true);
    expect(m!.body).toContain("Synthesize the trial literature.");
  });

  it("holds an officer to the limit its Grantmaker delegated, and lets it escalate", async () => {
    const funder = await seedUser("petition limit");
    const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const policy = await writeOperatingPolicy({ grantId, section: "delegation", content: "Officers settle routine top-ups.", note: "Keep large asks with me.", author: "grantmaker", officerLimitOwls: 1 });
    expect(policy.ok).toBe(true);
    const { claim, actionId } = await runningPass(grantId, "limit petitioner");
    const id = await filePetition({ grantId, kind: "more_budget", askedMicroUsd: 3 * OWL, plan: "p", requesterActionId: actionId, requesterNodeId: claim, waiting: true });
    const petition = (await getPetition(id))!;
    const grant = { id: grantId, title: "t", objective: "o", budget_job_id: jobId, funder_user_id: funder, daily: 0, escrow: 50 * OWL };
    const ctx = { grant, role: "officer" as const, labels: new Map([["p1", { petition }]]), limitMicroUsd: OWL, decidedBy: "officer" as const };
    const over = JSON.parse(await executeOfficerTool("decide_petitions", { decisions: [{ petition: "p1", decision: "grant", owls: 3, reason: "worth it" }] }, ctx));
    expect(over.results[0]).toMatchObject({ ok: false });
    expect(over.results[0].message).toContain("Escalate it");
    const esc = JSON.parse(await executeOfficerTool("escalate", { item: "p1", note: "Bigger than my limit." }, ctx));
    expect(esc.success).toBe(true);
    expect((await getPetition(id))!.status).toBe("escalated");
  });
});
