/**
 * What a mandate's page reads about its work, against real Postgres: each
 * kind counted whole (claims, questions and quantities are all judgments), a
 * node judged twice listed once with its passes, the kinds paged and ordered,
 * its Grantmaker's notes kept as a history with a cap, where its Grantmaker
 * stands, and who may read a mandate that has not started.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  MANDATE_UPDATES_KEPT,
  grantmakerStanding,
  listMandateUpdates,
  listMandateWork,
  mandateFindings,
  mandateWorkCounts,
  recordMandateUpdate,
} from "../../src/services/mandate-work-service.js";
import { getPublicMandate, readableMandateRef } from "../../src/services/mandate-service.js";

async function mandate(grantStatus = "active") {
  const funder = await seedUser("work-funder");
  const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000, grantStatus });
  return { funder, grantId, jobId, ref: { id: grantId, budgetJobId: jobId } };
}

describe("a mandate's completed work", () => {
  it("counts claims, questions and quantities as judgments, and a node judged twice once", async () => {
    const { jobId, ref } = await mandate();
    const claim = await seedClaim("work claim");
    const question = await seedClaim("work question");
    const quantity = await seedClaim("work quantity");
    await rawQuery(`UPDATE claims SET importance = 9 WHERE id = $1`, [question]);
    await rawQuery(`UPDATE claims SET importance = 2 WHERE id = $1`, [claim]);
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id, assessed_at, is_current)
       VALUES ($1, 'doubtful', 0.5, 't', $2, now() - interval '2 hours', false),
              ($1, 'supported', 0.8, 't', $2, now() - interval '1 hour', true)`,
      [claim, jobId]
    );
    await rawQuery(
      `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, funded_by_job_id, assessed_at)
       VALUES ($1, 'open', 't', $2, now() - interval '3 hours')`,
      [question, jobId]
    );
    await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work, funded_by_job_id, assessed_at)
       VALUES ($1, '{}'::jsonb, 'w', $2, now())`,
      [quantity, jobId]
    );
    // Another payer's judgment is not this mandate's work.
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace) VALUES ($1, 'supported', 0.9, 't')`,
      [await seedClaim("someone else's")]
    );

    const counts = await mandateWorkCounts(ref);
    expect(counts.assessments).toEqual({ nodes: 3, claims: 1, questions: 1, quantities: 1, passes: 4 });

    const recent = await listMandateWork(ref, { kind: "assessments" });
    expect(recent.total).toBe(3);
    expect(recent.items.map((i) => i.claim_id)).toEqual([quantity, claim, question]);
    const judgedTwice = recent.items.find((i) => i.claim_id === claim)!;
    expect(judgedTwice).toMatchObject({ node_kind: "claim", verdict: "supported", passes: 2 });

    const important = await listMandateWork(ref, { kind: "assessments", order: "importance" });
    expect(important.items[0]!.claim_id).toBe(question);

    const questions = await listMandateWork(ref, { kind: "assessments", node: "question" });
    expect(questions.total).toBe(1);
    expect(questions.items[0]).toMatchObject({ claim_id: question, node_kind: "question", verdict: "open" });

    const second = await listMandateWork(ref, { kind: "assessments", limit: 1, offset: 1 });
    expect(second.total).toBe(3);
    expect(second.items.map((i) => i.claim_id)).toEqual([claim]);
  });

  it("lists research, proposals and findings, each with its whole count", async () => {
    const { funder, grantId, jobId, ref } = await mandate();
    const node = await seedClaim("work node");
    await rawQuery(
      `INSERT INTO research_runs (grant_id, claim_id, requested_by, task, model, model_tier, ceiling_micro_usd, status)
       VALUES ($1, $2, 'grantmaker', 'Find the trial registry entry', 'm', 'standard', 1000000, 'done')`,
      [grantId, node]
    );
    await rawQuery(
      `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, review_status, funded_by_job_id)
       VALUES ($1, $2, 'propose_claim', 'A proposed node', 'accepted', $3),
              ($1, $2, 'evidence', 'Not a proposal', 'accepted', $3)`,
      [node, funder, jobId]
    );
    await rawQuery(
      `INSERT INTO agent_findings (headline, account, claim_id, importance, agent, job_id, status)
       VALUES ('A finding', 'What was found.', $1, 6, 'grantmaker', $2, 'published'),
              ('A bigger finding', 'What was found.', $1, 9, 'grantmaker', $2, 'published')`,
      [node, jobId]
    );

    const counts = await mandateWorkCounts(ref);
    expect(counts).toMatchObject({ research: 1, proposals: 1, findings: 2, sources: 0, requests: 0 });

    const research = await listMandateWork(ref, { kind: "research" });
    expect(research.total).toBe(1);
    expect(research.items[0]).toMatchObject({ task: "Find the trial registry entry", claim_id: node });

    const proposals = await listMandateWork(ref, { kind: "proposals" });
    expect(proposals.items.map((i) => i.text)).toEqual(["A proposed node"]);

    expect((await mandateFindings(ref, 1)).map((f) => f.headline)).toEqual(["A bigger finding"]);
    expect((await listMandateWork(ref, { kind: "sources" })).total).toBe(0);
    expect((await listMandateWork(ref, { kind: "requests" })).total).toBe(0);
  });
});

describe("a Grantmaker's updates", () => {
  it("keeps each note, newest first, and the latest as last_review", async () => {
    const { grantId } = await mandate();
    await recordMandateUpdate(grantId, "First note.");
    await recordMandateUpdate(grantId, "Second note.");
    const page = await listMandateUpdates(grantId);
    expect(page.total).toBe(2);
    expect(page.updates.map((u) => u.note)).toEqual(["Second note.", "First note."]);
    const [row] = await rawQuery<{ note: string }>(
      `SELECT mandate->'last_review'->>'note' AS note FROM grants WHERE id = $1`,
      [grantId]
    );
    expect(row!.note).toBe("Second note.");
    expect((await listMandateUpdates(grantId, { limit: 1, offset: 1 })).updates[0]!.note).toBe("First note.");
  });

  it("keeps no more than its cap, dropping the oldest", async () => {
    const { grantId } = await mandate();
    const old = Array.from({ length: MANDATE_UPDATES_KEPT }, (_, i) => ({ at: new Date().toISOString(), note: `n${i}` }));
    await rawQuery(`UPDATE grants SET mandate = jsonb_build_object('updates', $2::jsonb) WHERE id = $1`, [
      grantId,
      JSON.stringify(old),
    ]);
    await recordMandateUpdate(grantId, "newest");
    const page = await listMandateUpdates(grantId, { limit: 50 });
    expect(page.total).toBe(MANDATE_UPDATES_KEPT);
    expect(page.updates[0]!.note).toBe("newest");
    const last = await listMandateUpdates(grantId, { limit: 1, offset: MANDATE_UPDATES_KEPT - 1 });
    expect(last.updates[0]!.note).toBe("n1");
  });

  it("shows the one note of a mandate written before notes were kept", async () => {
    const { grantId } = await mandate();
    await rawQuery(
      `UPDATE grants SET mandate = jsonb_build_object('last_review', jsonb_build_object('at', now(), 'note', 'Only one.')) WHERE id = $1`,
      [grantId]
    );
    const page = await listMandateUpdates(grantId);
    expect(page.updates.map((u) => u.note)).toEqual(["Only one."]);
  });
});

describe("where a mandate's Grantmaker stands", () => {
  it("is none without a live session", async () => {
    const { grantId } = await mandate();
    expect((await grantmakerStanding(grantId)).state).toBe("none");
  });

  it("is waiting with its check-in, the runs still open and the nodes watched", async () => {
    const { grantId } = await mandate();
    const session = randomUUID();
    await rawQuery(`INSERT INTO agent_sessions (id, role, status) VALUES ($1, 'grantmaker', 'waiting')`, [session]);
    await rawQuery(`UPDATE grants SET grantmaker_session_id = $2 WHERE id = $1`, [grantId, session]);
    const open = await seedAction({ group: `standing-${randomUUID()}`, costMicroUsd: 1000 });
    const node = await seedClaim("watched");
    const due = new Date(Date.now() + 3_600_000);
    await rawQuery(
      `INSERT INTO subscriptions (subscriber_kind, subscriber_ref, filter, due_at, reason, created_by)
       VALUES ('session', $1, $2::jsonb, NULL, 'r', 'dbtest'), ('session', $1, $3::jsonb, NULL, 'r', 'dbtest'), ('session', $1, '{}'::jsonb, $4, 'r', 'dbtest')`,
      [session, JSON.stringify({ action_ids: [open] }), JSON.stringify({ node_ids: [node] }), due]
    );
    const standing = await grantmakerStanding(grantId);
    expect(standing).toMatchObject({ state: "waiting", runs_awaited: 1, nodes_watched: 1, spend_threshold: false });
    expect(new Date(standing.check_in_at!).getTime()).toBe(due.getTime());
  });
});

describe("who may read a mandate", () => {
  it("shows one that has not started to its funder and to nobody else", async () => {
    const { funder, grantId, jobId } = await mandate("pending_approval");
    const stranger = await seedUser("work-stranger");
    expect(await readableMandateRef(grantId, null)).toBeNull();
    expect(await readableMandateRef(grantId, stranger)).toBeNull();
    expect(await readableMandateRef(grantId, funder)).toEqual({ id: grantId, budgetJobId: jobId });
    expect(await getPublicMandate(grantId, stranger)).toBeNull();
    const own = await getPublicMandate(grantId, funder);
    expect(own?.id).toBe(grantId);
  });

  it("shows a live one to anyone, with its counts, and funder notes only to its funder", async () => {
    const { funder, grantId, jobId } = await mandate();
    expect(await readableMandateRef(grantId, null)).toEqual({ id: grantId, budgetJobId: jobId });
    await rawQuery(
      `UPDATE grants SET mandate = jsonb_build_object('funder_notes', jsonb_build_array(jsonb_build_object('at', now(), 'note', 'Look at the registry.'))) WHERE id = $1`,
      [grantId]
    );
    const pub = await getPublicMandate(grantId, null);
    expect(pub?.work_counts.assessments.nodes).toBe(0);
    expect(pub?.grantmaker.state).toBe("none");
    expect(pub?.funder_notes ?? []).toEqual([]);
    const own = await getPublicMandate(grantId, funder);
    expect(own?.funder_notes?.length).toBe(1);
  });
});
