/**
 * A mandate's inbox against real Postgres: what its work produced since its
 * watermark becomes events (an assessment on a node it funded, with the
 * children waiting; a decision on its contribution; a source it ingested; a
 * lookout's flag), a rescan records nothing twice, pending events wake its
 * review once the last pass is old enough, and a review pass reads the
 * events in its briefing and consumes them.
 */
import { describe, it, expect, vi } from "vitest";

const seen = vi.hoisted(() => ({ briefing: "" }));
vi.mock("../../src/llm/client.js", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    toolUseLoop: vi.fn(async (opts: { initialMessages: Array<{ content: string }> }) => {
      seen.briefing = String(opts.initialMessages[0]?.content ?? "");
      return { content: "Read the inbox.", toolCalls: [], iterations: 1 };
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  collectMandateEvents,
  describeMandateEvent,
  pendingMandateEvents,
  openReviewsForEscalations,
} from "../../src/services/mandate-event-service.js";
import { runMandateReview } from "../../src/llm/agents/mandate-review.js";

async function mandate() {
  const funder = await seedUser("inbox-funder");
  const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000, dailyBudgetMicroUsd: 10_000_000 });
  // The first scan starts from now and replays nothing.
  expect(await collectMandateEvents(grantId)).toBe(0);
  await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
  return { funder, grantId, jobId };
}

describe("collecting a mandate's events", () => {
  it("records an assessment on a node it funded, with the children waiting, and nothing twice", async () => {
    const { grantId, jobId } = await mandate();
    const node = await seedClaim("inbox node");
    const waiting = await seedClaim("inbox child waiting");
    const deferred = await seedClaim("inbox child deferred");
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = $1`, [deferred]);
    for (const child of [waiting, deferred]) {
      await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'dbtest')`, [node, child]);
    }
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id) VALUES ($1, 'supported', 0.7, 't', $2)`,
      [node, jobId]
    );
    // Someone else's assessment on an unrelated node is not this mandate's news.
    await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, reasoning_trace) VALUES ($1, 'doubtful', 0.6, 't')`, [await seedClaim("not ours")]);

    expect(await collectMandateEvents(grantId)).toBe(1);
    const { events } = await pendingMandateEvents(grantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "assessed", claim_id: node });
    expect(events[0]!.payload).toMatchObject({ outcome: "supported", children: 2, children_unassessed: 2, children_deferred: 1 });

    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    expect(await collectMandateEvents(grantId)).toBe(0);
  });

  it("records a decision on its contribution, a source it ingested, and a lookout's flag", async () => {
    const { funder, grantId } = await mandate();
    const node = await seedClaim("inbox contribution node");
    const [ct] = await rawQuery<{ id: string }>(
      `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content, grant_id)
       VALUES ($1, $2, 'support', 'Table 3 gives the figure.', $3) RETURNING id`,
      [node, funder, grantId]
    );
    await rawQuery(
      `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence) VALUES ($1, 'accept', 'sound', 0.9)`,
      [ct!.id]
    );
    const [src] = await rawQuery<{ id: string }>(`INSERT INTO sources (title, url) VALUES ('A report', 'https://example.org/report') RETURNING id`);
    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO jobs (type, status, input, completed_at) VALUES ('url_extraction', 'completed', '{}', now()) RETURNING id`
    );
    await rawQuery(`INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, 'https://example.org/report', $3)`, [grantId, src!.id, job!.id]);
    const [lk] = await rawQuery<{ id: string }>(`INSERT INTO lookouts (grant_id, title, brief) VALUES ($1, 'watch', 'brief') RETURNING id`, [grantId]);
    await rawQuery(`INSERT INTO lookout_flags (lookout_id, kind, claim_id, rationale) VALUES ($1, 'note', $2, 'A new result bears on this.')`, [lk!.id, node]);

    expect(await collectMandateEvents(grantId)).toBe(3);
    const kinds = (await pendingMandateEvents(grantId)).events.map((e) => e.kind).sort();
    expect(kinds).toEqual(["contribution_reviewed", "lookout_flag", "source_ingested"]);
  });
  it("records a source once its extraction has finished, with the outcome and the nodes as of then (#898)", async () => {
    const { grantId } = await mandate();
    const [src] = await rawQuery<{ id: string }>(`INSERT INTO sources (title, url) VALUES ('Slow', 'https://example.org/slow') RETURNING id`);
    const [job] = await rawQuery<{ id: string }>(`INSERT INTO jobs (type, status, input) VALUES ('url_extraction', 'processing', '{}') RETURNING id`);
    // Submitted long before the scan's window: the extraction is what is news.
    await rawQuery(
      `INSERT INTO grant_sources (grant_id, source_id, url, job_id, created_at) VALUES ($1, $2, 'https://example.org/slow', $3, now() - interval '3 days')`,
      [grantId, src!.id, job!.id]
    );
    expect(await collectMandateEvents(grantId)).toBe(0);

    const node = await seedClaim("slow source node");
    await rawQuery(`INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'quoted')`, [node, src!.id]);
    await rawQuery(`UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1`, [job!.id]);
    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    expect(await collectMandateEvents(grantId)).toBe(1);
    const { events } = await pendingMandateEvents(grantId);
    expect(events[0]!.payload).toMatchObject({ outcome: "completed", nodes: 1, already_extracted: false });
    expect(describeMandateEvent(events[0]!)).toBe("Ingested https://example.org/slow: extraction completed, 1 node linked to it.");

    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    expect(await collectMandateEvents(grantId)).toBe(0);
  });

  it("says a failed extraction failed, and tells a mandate attributed to an extracted source so", async () => {
    const { grantId } = await mandate();
    const [bad] = await rawQuery<{ id: string }>(`INSERT INTO sources (title, url) VALUES ('Gone', 'https://example.org/gone') RETURNING id`);
    const [badJob] = await rawQuery<{ id: string }>(
      `INSERT INTO jobs (type, status, input, error, completed_at) VALUES ('url_extraction', 'failed', '{}', 'HTTP 404', now()) RETURNING id`
    );
    await rawQuery(`INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, 'https://example.org/gone', $3)`, [grantId, bad!.id, badJob!.id]);
    const [old] = await rawQuery<{ id: string }>(`INSERT INTO sources (title, url) VALUES ('Old', 'https://example.org/old') RETURNING id`);
    const [oldJob] = await rawQuery<{ id: string }>(
      `INSERT INTO jobs (type, status, input, completed_at) VALUES ('url_extraction', 'completed', '{}', now() - interval '20 days') RETURNING id`
    );
    await rawQuery(`INSERT INTO grant_sources (grant_id, source_id, url, job_id) VALUES ($1, $2, 'https://example.org/old', $3)`, [grantId, old!.id, oldJob!.id]);

    expect(await collectMandateEvents(grantId)).toBe(2);
    const lines = (await pendingMandateEvents(grantId)).events.map(describeMandateEvent).sort();
    expect(lines).toEqual([
      "Ingesting https://example.org/gone failed: HTTP 404. Nothing was extracted from it.",
      "https://example.org/old was already in the graph, extracted before your mandate asked for it: 0 nodes linked to it.",
    ]);
  });

  it("records a row committed after a scan that carries an earlier time", async () => {
    const { grantId, jobId } = await mandate();
    // The scan has moved past now; the row's transaction started before it.
    await rawQuery(`UPDATE grants SET events_scanned_at = now() WHERE id = $1`, [grantId]);
    const node = await seedClaim("late-commit node");
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id, assessed_at)
       VALUES ($1, 'supported', 0.7, 't', $2, now() - interval '30 seconds')`,
      [node, jobId]
    );
    expect(await collectMandateEvents(grantId)).toBe(1);
  });
});

describe("events no longer wake a review; escalations reach a mandate with no live session", () => {
  it("leaves the review closed while events wait, and opens one for an escalation nobody can receive", async () => {
    const { grantId, jobId } = await mandate();
    const [review] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status, updated_at)
       VALUES ('mandate_review', $1, 'standard', $2, 'review', 500000, 'done', now() - interval '2 hours')
       RETURNING id`,
      [`review:${grantId}`, grantId]
    );
    const node = await seedClaim("wake node");
    await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id) VALUES ($1, 'supported', 0.7, 't', $2)`, [node, jobId]);
    await collectMandateEvents(grantId);
    // Events wait for the Grantmaker's next briefing; they open nothing.
    expect(await openReviewsForEscalations()).toBe(0);
    expect(await rawQuery(`SELECT status FROM actions WHERE id = $1`, [review!.id])).toEqual([{ status: "done" }]);

    // An escalated petition, and no Grantmaker session live to receive it.
    await rawQuery(
      `INSERT INTO petitions (grant_id, kind, asked_micro_usd, plan, status, waiting)
       VALUES ($1, 'more_budget', 1000000, 'read the replication', 'escalated', true)`,
      [grantId]
    );
    expect(await openReviewsForEscalations()).toBeGreaterThanOrEqual(1);
    expect(await rawQuery(`SELECT status FROM actions WHERE id = $1`, [review!.id])).toEqual([{ status: "open" }]);
    // Leave nothing escalated behind for later files' executor ticks.
    await rawQuery(`UPDATE petitions SET status = 'refused' WHERE grant_id = $1`, [grantId]);
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE id = $1`, [review!.id]);
  });
});

describe("a review pass and its inbox", () => {
  it("reads the events in its briefing and consumes them", async () => {
    const { grantId, jobId } = await mandate();
    const node = await seedClaim("briefed node");
    await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, funded_by_job_id) VALUES ($1, 'contradicted', 0.8, 't', $2)`, [node, jobId]);
    await collectMandateEvents(grantId);
    expect((await pendingMandateEvents(grantId)).total).toBe(1);

    await runMandateReview({ grantId });
    expect(seen.briefing).toContain("Since your last pass");
    expect(seen.briefing).toContain("contradicted");
    expect(seen.briefing).toContain("You work in one long session on this mandate");
    expect((await pendingMandateEvents(grantId)).total).toBe(0);
  });
});
