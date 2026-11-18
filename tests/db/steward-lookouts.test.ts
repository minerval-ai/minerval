/**
 * A Steward's own lookout over real SQL (lookout-fund.ts,
 * steward-lookout-tools.ts): the fund leaves the Steward's pass and keeps
 * its payer; each run is paid from it at the run's estimate and gives back
 * what it did not spend; a fund that cannot pay for a run pauses the
 * lookout and tells the node's inbox, and a top-up resumes it; what the
 * lookout raises and does not pay for goes to its Steward's inbox, and what
 * it commissions within its limit comes out of the fund; retiring it
 * returns what is left. Only the node's own Steward amends it.
 */
import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { rawQuery } from "../../src/db/client.js";
import { ASSESS_GROUP, completeAction, openDueAgentRuns } from "../../src/services/action-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { grantCommittedMicroUsd } from "../../src/services/regrant-service.js";
import {
  LOOKOUT_FUND_GROUP,
  fundStewardLookoutRuns,
  lookoutFundLeftMicroUsd,
  lookoutRunCostMicroUsd,
} from "../../src/services/lookout-fund.js";
import { flagNote, flagReassessment, getLookout } from "../../src/services/lookout-service.js";
import { executeStewardLookoutTool, stewardLookoutNote } from "../../src/llm/tools/steward-lookout-tools.js";
import { getUsageContext, runWithUsageContext, withPassBudget } from "../../src/llm/usage-context.js";
import { OWL, creditOwls, owlBalance, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

const BRIEF =
  "Watch the two trials this verdict rests on for retractions, corrections and failed replications.";

async function standardRow(claimId: string): Promise<string> {
  const [r] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE exclusion_group = $1 AND variant = 'standard'`,
    [ASSESS_GROUP(claimId)]
  );
  return r!.id;
}

/** A running Steward pass on a fresh node, paid by a person or a mandate, and a way to act inside it. */
async function stewardPass(payer: "user" | "grant", budgetOwls = 4) {
  const node = await seedClaim("watched");
  const user = await seedUser("steward-lookout funder");
  let grantId: string | null = null;
  if (payer === "user") {
    await creditOwls(user, 20 * OWL);
  } else {
    grantId = (await seedGrantWithJob({ funderId: user, budgetMicroUsd: 50 * OWL })).grantId;
  }
  const res = await commissionNodePass({
    payer: payer === "user" ? { kind: "user", userId: user } : { kind: "grant", grantId: grantId! },
    claimId: node,
    budgetMicroUsd: budgetOwls * OWL,
    brief: "Look at this node.",
    commissionedBy: payer === "user" ? "person" : "program_officer",
  });
  if (!res.ok) throw new Error(res.message);
  const actionId = await standardRow(node);
  await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [actionId]);
  const inPass = async <T>(fn: () => Promise<T>, onNode = node) =>
    runWithUsageContext({ claimId: onNode, agent: "steward" }, () =>
      withPassBudget({ microUsd: budgetOwls * OWL, source: "a commission", funding: { actionId } }, fn)
    ).then((r) => r.value);
  const call = (name: string, input: Record<string, unknown>, onNode = node) =>
    inPass(async () => JSON.parse((await executeStewardLookoutTool(name, input))!), onNode);
  return { node, user, grantId, actionId, inPass, call };
}

const fundRows = (lookoutId: string) =>
  rawQuery<{ user_id: string | null; grant_id: string | null; amount: string; released: boolean }>(
    `SELECT user_id, grant_id, amount_micro_usd::text AS amount, released_at IS NOT NULL AS released
       FROM action_allocations WHERE exclusion_group = $1 ORDER BY created_at`,
    [LOOKOUT_FUND_GROUP(lookoutId)]
  );

async function lookoutRun(lookoutId: string) {
  const [r] = await rawQuery<{ id: string; status: string }>(
    `SELECT id, status FROM actions WHERE exclusion_group = $1`,
    [`lookout:${lookoutId}`]
  );
  return r ?? null;
}

describe("a Steward's own lookout", () => {
  it("is funded from the Steward's pass, keeping its payer, and watches the node by default", async () => {
    const s = await stewardPass("user");
    const balanceBefore = await owlBalance(s.user);
    const out = await s.inPass(async () => {
      const r = JSON.parse(
        (await executeStewardLookoutTool("post_lookout", {
          title: "Trial watch",
          brief: BRIEF,
          budget_owls: 1,
          triggers: ["retraction", "graph"],
        }))!
      );
      return { r, ceiling: getUsageContext().passBudget!.microUsd };
    });
    expect(out.r.success).toBe(true);
    expect(out.ceiling).toBe(3 * OWL);
    const lookout = (await getLookout(out.r.lookout_id))!;
    expect(lookout).toMatchObject({ node_id: s.node, grant_id: null, status: "active", territory_claim_ids: [s.node] });
    expect(await fundRows(lookout.id)).toEqual([{ user_id: s.user, grant_id: null, amount: String(OWL), released: false }]);
    // The person paid once, for the pass; the fund is part of what they paid.
    expect(await owlBalance(s.user)).toBe(balanceBefore);
    expect(await lookoutFundLeftMicroUsd(lookout.id)).toBe(OWL);
    expect(await stewardLookoutNote(s.node)).toContain(`${lookout.id} "Trial watch" (active): fund 1 owls`);
  });

  it("pays each run from the fund at its estimate and takes back what the run did not spend", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 1 });
    await openDueAgentRuns();
    const row = (await lookoutRun(id))!;
    expect(row.status).toBe("open");
    expect(await fundStewardLookoutRuns()).toBeGreaterThanOrEqual(1);
    const cost = lookoutRunCostMicroUsd();
    expect(await lookoutFundLeftMicroUsd(id)).toBe(OWL - cost);
    const [onRun] = await rawQuery<{ user_id: string; commissioned_by: string; amount: string }>(
      `SELECT user_id, commissioned_by, amount_micro_usd::text AS amount FROM action_allocations
        WHERE exclusion_group = $1 AND released_at IS NULL`,
      [`lookout:${id}`]
    );
    expect(onRun).toEqual({ user_id: s.user, commissioned_by: "lookout_fund", amount: String(cost) });

    const balance = await owlBalance(s.user);
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row.id]);
    await completeAction(row.id, Math.round(cost / 5));
    // A fifth of the run's money was spent; the rest is back in the fund,
    // not on the person's balance.
    expect(await lookoutFundLeftMicroUsd(id)).toBe(OWL - Math.round(cost / 5));
    expect(await owlBalance(s.user)).toBe(balance);
  });

  it("pauses when the fund cannot pay for a run, tells the node, and resumes on a top-up", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 0.06 });
    // Spend all but a sliver of it.
    await rawQuery(
      `UPDATE action_allocations SET spent_micro_usd = amount_micro_usd - 1000 WHERE exclusion_group = $1`,
      [LOOKOUT_FUND_GROUP(id)]
    );
    await openDueAgentRuns();
    await fundStewardLookoutRuns();
    expect(await getLookout(id)).toMatchObject({ status: "paused", paused_for_fund: true });
    expect((await lookoutRun(id))!.status).toBe("cancelled");
    const [m] = await rawQuery<{ body: string; sender_kind: string }>(
      `SELECT body, sender_kind FROM node_messages WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [s.node]
    );
    expect(m!.sender_kind).toBe("lookout");
    expect(m!.body).toContain("has paused: its fund holds");

    const topped = await s.call("amend_lookout", { lookout_id: id, add_budget_owls: 0.5 });
    expect(topped.success).toBe(true);
    expect(await getLookout(id)).toMatchObject({ status: "active", paused_for_fund: false });
  });

  it("sends what it does not pay for to its Steward's inbox, and pays from its fund within its limit", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", {
      title: "Trial watch",
      brief: BRIEF,
      budget_owls: 2,
      commission_limit_owls: 0.5,
    });
    const other = await seedClaim("rests on the trial");

    const note = await flagNote({ lookoutId: id, text: "The second trial's registry entry changed its primary outcome." });
    expect(note).toMatchObject({ ok: true, note: "Sent to your Steward's inbox, for its next pass." });

    const raised = await flagReassessment({
      lookoutId: id,
      grantId: null,
      commissionLimitMicroUsd: 0.5 * OWL,
      claimId: other,
      rationale: "Its cited trial was retracted on Crossref this week.",
      budgetMicroUsd: 0,
    });
    expect(JSON.stringify(raised)).toContain("Sent to your Steward's inbox");
    const bodies = (
      await rawQuery<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1 ORDER BY created_at`, [s.node])
    ).map((r) => r.body);
    expect(bodies.some((b) => b.includes("registry entry changed"))).toBe(true);
    expect(bodies.some((b) => b.includes(`raises node ${other}`) && b.includes("retracted on Crossref"))).toBe(true);

    const third = await seedClaim("also rests on it");
    const paid = await flagReassessment({
      lookoutId: id,
      grantId: null,
      commissionLimitMicroUsd: 0.5 * OWL,
      claimId: third,
      rationale: "Its cited trial was retracted on Crossref this week.",
      budgetMicroUsd: 0.4 * OWL,
    });
    expect(JSON.stringify(paid)).toContain("from your fund, within your limit");
    expect(await lookoutFundLeftMicroUsd(id)).toBe(1_600_000);
    const [onPass] = await rawQuery<{ user_id: string; lookout_id: string }>(
      `SELECT user_id, lookout_id FROM action_allocations WHERE exclusion_group = $1 AND released_at IS NULL`,
      [ASSESS_GROUP(third)]
    );
    expect(onPass).toEqual({ user_id: s.user, lookout_id: id });
  });

  it("returns what is left to whoever put it up when retired, and only its own node's Steward may amend it", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 1 });
    const stranger = await seedClaim("another node");
    const refused = await s.call("amend_lookout", { lookout_id: id, status: "retired" }, stranger);
    expect(refused.success).toBe(false);

    const balance = await owlBalance(s.user);
    const retired = await s.call("amend_lookout", { lookout_id: id, status: "retired" });
    expect(retired.success).toBe(true);
    expect(retired.message).toContain("1 owls left in its fund went back");
    expect(await owlBalance(s.user)).toBe(balance + OWL);
    expect(await lookoutFundLeftMicroUsd(id)).toBe(0);
    expect(await stewardLookoutNote(s.node)).toBe("");
  });

  it("is retired, its fund returned, when its node leaves the graph", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 1 });
    const balance = await owlBalance(s.user);
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [s.node]);
    await fundStewardLookoutRuns();
    expect(await getLookout(id)).toMatchObject({ status: "retired" });
    expect(await owlBalance(s.user)).toBe(balance + OWL);
  });

  it("moves a mandate's money without counting it twice against the mandate", async () => {
    const s = await stewardPass("grant");
    const before = await grantCommittedMicroUsd(s.grantId!);
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 1 });
    expect(await fundRows(id)).toEqual([{ user_id: null, grant_id: s.grantId, amount: String(OWL), released: false }]);
    expect(await grantCommittedMicroUsd(s.grantId!)).toBe(before);
    await openDueAgentRuns();
    await fundStewardLookoutRuns();
    expect(await grantCommittedMicroUsd(s.grantId!)).toBe(before);

    // A mandate that closes takes its money out of the fund's reach.
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [s.grantId]);
    expect(await lookoutFundLeftMicroUsd(id)).toBe(0);
  });

  it("is on the record: GET /claims/:id/lookouts shows its brief, fund and flags, and not who paid", async () => {
    const s = await stewardPass("user");
    const { lookout_id: id } = await s.call("post_lookout", { title: "Trial watch", brief: BRIEF, budget_owls: 1 });
    await flagNote({ lookoutId: id, text: "The second trial's registry entry changed its primary outcome." });
    const { buildApp } = await import("../../src/server/app.js");
    const app: FastifyInstance = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: `/claims/${s.node}/lookouts` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.lookouts).toHaveLength(1);
      expect(body.lookouts[0]).toMatchObject({ id, title: "Trial watch", brief: BRIEF, status: "active", fund_owls: 1 });
      expect(body.lookouts[0].flags[0]).toMatchObject({ kind: "note" });
      expect(res.body).not.toContain(s.user);
      const missing = await app.inject({ method: "GET", url: `/claims/00000000-0000-4000-8000-000000000000/lookouts` });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
