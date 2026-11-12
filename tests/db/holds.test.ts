/**
 * Holding a petition for perspective, against real Postgres: a hold may not
 * outlast the waiting run's session; the asker is told without being woken
 * and keeps waiting on the decision; the hold comes back when its runs
 * settle or its time comes, to whoever placed it, never refused by time.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { filePetition, getPetition, holdPetition, releaseHolds } from "../../src/services/petition-service.js";
import { outstanding } from "../../src/services/session-service.js";
import { OWL, seedAction, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

async function waitingAsker(petitionId: string): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, status, awaiting, transcript, model, suspended_at, deadline)
     VALUES ($1, 'steward', 'waiting', $2::jsonb, '[]'::jsonb, 'm', now(), now() + interval '24 hours')`,
    [id, JSON.stringify([{ kind: "petition", ref: petitionId }])]
  );
  await rawQuery(`UPDATE petitions SET reply_to_session = $2 WHERE id = $1`, [petitionId, id]);
  return id;
}

describe("holding a petition", () => {
  it("holds within the asker's wait, tells it without waking it, and releases when the runs it waits on settle", async () => {
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("hold funder"), budgetMicroUsd: 50 * OWL });
    const node = await seedClaim("held node");
    const petitionId = await filePetition({
      grantId,
      kind: "more_budget",
      askedMicroUsd: 2 * OWL,
      plan: "Read the second replication.",
      requesterNodeId: node,
      waiting: true,
      doneSoFar: "The first replication holds up; the second is unread.",
    });
    const session = await waitingAsker(petitionId);
    const sibling = await seedClaim("sibling under way");
    const run = await seedAction({ group: `assess:${sibling}`, claimId: sibling, costMicroUsd: OWL, status: "running" });

    // Past the asker's wait (its deadline less the margin): refused, with the time.
    const tooLate = await holdPetition({ petitionId, until: new Date(Date.now() + 30 * 3_600_000), refs: [], criteria: "x", decidedBy: "officer" });
    expect(tooLate.ok).toBe(false);
    expect(!tooLate.ok && tooLate.message).toMatch(/a hold must end by then/);

    const held = await holdPetition({
      petitionId,
      until: new Date(Date.now() + 6 * 3_600_000),
      refs: [run],
      criteria: "whether the sibling premise's pass finds the same flaw",
      decidedBy: "officer",
    });
    expect(held.ok).toBe(true);
    expect(await getPetition(petitionId)).toMatchObject({ status: "held", done_so_far: "The first replication holds up; the second is unread." });
    // The asker was told, not woken, and still waits on the decision itself.
    const [s] = await rawQuery<{ status: string; awaiting: Array<{ kind: "petition"; ref: string }>; replies: Array<{ kind: "petition"; ref: string; text: string; wake?: boolean; at: string; delivered: boolean }> }>(
      `SELECT status, awaiting, replies FROM agent_sessions WHERE id = $1`,
      [session]
    );
    expect(s!.status).toBe("waiting");
    expect(s!.replies.at(-1)).toMatchObject({ kind: "petition", ref: `${petitionId}:held`, wake: false });
    expect(s!.replies.at(-1)!.text).toContain("whether the sibling premise's pass finds the same flaw");
    expect(outstanding(s!)).toEqual([{ kind: "petition", ref: petitionId }]);

    // Not back while the run it waits on is still going.
    expect(await releaseHolds()).not.toContain(grantId);
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [run]);
    expect(await releaseHolds()).toContain(grantId);
    const back = await getPetition(petitionId);
    expect(back!.status).toBe("pending");
    expect(back!.reason).toContain("whether the sibling premise's pass finds the same flaw");
    await rawQuery(`UPDATE petitions SET status = 'refused' WHERE id = $1`, [petitionId]);
  });

  it("returns the Grantmaker's own hold to it, as an escalation, when its time comes", async () => {
    const { grantId } = await seedGrantWithJob({ funderId: await seedUser("gm hold"), budgetMicroUsd: 50 * OWL });
    const petitionId = await filePetition({ grantId, kind: "follow_up", askedMicroUsd: 3 * OWL, plan: "A literature synthesis.", waiting: false });
    await rawQuery(`UPDATE petitions SET status = 'escalated' WHERE id = $1`, [petitionId]);
    expect((await holdPetition({ petitionId, until: new Date(Date.now() + 3_600_000), refs: [], criteria: "wait for the survey", decidedBy: "grantmaker" })).ok).toBe(true);
    await rawQuery(`UPDATE petitions SET held_until = now() - interval '1 minute' WHERE id = $1`, [petitionId]);
    await releaseHolds();
    expect((await getPetition(petitionId))!.status).toBe("escalated");
    const [e] = await rawQuery<{ kind: string }>(
      `SELECT kind FROM events WHERE grant_id = $1 AND refs->>'petition' = $2 ORDER BY seq DESC LIMIT 1`,
      [grantId, petitionId]
    );
    expect(e!.kind).toBe("escalated");
    await rawQuery(`UPDATE petitions SET status = 'refused' WHERE id = $1`, [petitionId]);
  });
});
