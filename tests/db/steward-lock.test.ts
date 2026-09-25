/**
 * One Steward per claim at a time (#482).
 *
 * The incident: two Steward runs worked one claim at once and recorded the
 * same document twice. A message for a claim mid-run (a subclaim's
 * notification, an edge proposal) re-pended it, every lane treats 'pending'
 * as free to claim, and during a rolling deploy a second task's drain took
 * it while the first run was still writing. These tests drive the real SQL:
 * a second drain while a run is in flight, the message still getting its
 * pass after the run, the direct (money-trigger) lock, the heartbeat, and
 * the shutdown hand-back.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runClaimSteward: vi.fn(async (_input: { claimId: string; trigger: string; context: string }) => undefined),
}));
vi.mock("../../src/llm/agents/claim-steward.js", () => ({
  runClaimSteward: mocks.runClaimSteward,
}));
// Pin the drain to the fallback lane (direct budgeted runs, best priority
// first) so the claim under test is the one it takes: other files in the
// suite leave covered actions and mandates behind.
vi.mock("../../src/services/action-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/action-service.js")>()),
  nextRunnableAction: vi.fn(async () => null),
}));
vi.mock("../../src/services/allocation-policy-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/allocation-policy-service.js")>()),
  getGeneralMandate: vi.fn(async () => null),
}));

import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedClaim } from "./helpers.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { processNextStewardTask } from "../../src/workers/steward-pipeline.js";
import {
  StewardBusyError,
  abandonStewardLeases,
  acquireStewardLock,
  heldStewardLeaseCount,
  releaseStewardLock,
  withStewardLease,
} from "../../src/services/steward-lease.js";
import { isTransientApiError } from "../../src/llm/errors.js";

interface StewardRow {
  steward_state: string;
  steward_requeued: boolean;
  steward_trigger: string | null;
  steward_context: string | null;
  stewarded_at: Date | null;
}

async function stewardRow(id: string): Promise<StewardRow> {
  const [row] = await rawQuery<StewardRow>(
    `SELECT steward_state, steward_requeued, steward_trigger, steward_context,
            stewarded_at
       FROM claims WHERE id = $1`,
    [id]
  );
  return row!;
}

/** Put the claim at the head of the drain, so the next tick takes it first. */
async function toHead(id: string): Promise<void> {
  await rawQuery(
    `UPDATE claims
        SET queue_priority = (SELECT max(queue_priority) + 1 FROM claims)
      WHERE id = $1`,
    [id]
  );
}

async function seedHeadClaim(label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(
    `UPDATE claims SET steward_trigger = 'structure_and_assess',
            steward_context = 'first pass'
      WHERE id = $1`,
    [id]
  );
  await toHead(id);
  return id;
}

beforeAll(() => {
  process.env.BACKGROUND_FALLBACK_LANE_ENABLED = "true";
});

beforeEach(() => {
  mocks.runClaimSteward.mockReset();
  mocks.runClaimSteward.mockImplementation(async () => undefined);
});

describe("a message for a claim mid-run (#482)", () => {
  it("does not hand the claim to a second drain while the first run is live", async () => {
    const id = await seedHeadClaim("in-flight");
    const inFlight: string[] = [];
    const overlaps: string[] = [];
    let nested: Awaited<ReturnType<typeof processNextStewardTask>> | null = null;
    let nestedStarted = false;

    mocks.runClaimSteward.mockImplementation(async ({ claimId }) => {
      if (inFlight.includes(claimId)) overlaps.push(claimId);
      inFlight.push(claimId);
      try {
        if (claimId === id && !nestedStarted) {
          nestedStarted = true;
          // Mid-run, a subclaim's Steward notifies this claim...
          await enqueueSteward({
            claimId: id,
            trigger: "subclaim_change",
            context: "Subclaim X changed",
          });
          // ...(keep it at the head of the drain, as in the incident)...
          await toHead(id);
          // ...and a second task's drain ticks while this run is still live.
          nested = await processNextStewardTask();
        }
      } finally {
        inFlight.splice(inFlight.indexOf(claimId), 1);
      }
    });

    const first = await processNextStewardTask();
    expect(first).toMatchObject({ status: "processed", claimId: id, ok: true });
    expect(overlaps).toEqual([]);
    expect(nested).not.toBeNull();
    expect(nested!.claimId).not.toBe(id);
  });

  it("keeps the claim running while it waits, and gives the message its pass after the run", async () => {
    const id = await seedHeadClaim("requeued");
    let midRun: StewardRow | null = null;

    mocks.runClaimSteward.mockImplementationOnce(async () => {
      await enqueueSteward({ claimId: id, trigger: "subclaim_change", context: "Subclaim X changed" });
      await enqueueSteward({ claimId: id, trigger: "edge_proposal", context: "Adopt Y" });
      midRun = await stewardRow(id);
    });

    await processNextStewardTask();
    expect(midRun).toMatchObject({ steward_state: "running", steward_requeued: true });
    // The two mid-run messages coalesce into one slot, as into a pending one.
    expect(midRun!.steward_trigger).toBe("subclaim_change");
    expect(midRun!.steward_context).toBe(
      "[subclaim_change] Subclaim X changed\n\n[edge_proposal] Adopt Y"
    );

    const after = await stewardRow(id);
    expect(after).toMatchObject({ steward_state: "pending", steward_requeued: false });

    // The next pass runs with the messages that arrived during the first.
    await toHead(id);
    await processNextStewardTask();
    const second = mocks.runClaimSteward.mock.calls.at(-1)![0];
    expect(second).toMatchObject({ claimId: id, trigger: "subclaim_change" });
    expect(second.context).toContain("Adopt Y");
    expect(await stewardRow(id)).toMatchObject({ steward_state: "done", steward_requeued: false });
  });

  it("marks a claim that is not running pending, exactly as before", async () => {
    const id = await seedClaim("idle");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
    await enqueueSteward({ claimId: id, trigger: "subclaim_change", context: "c" });
    expect(await stewardRow(id)).toMatchObject({ steward_state: "pending", steward_requeued: false });
  });
});

describe("the direct (money-trigger) lock", () => {
  it("refuses a claim another Steward holds, with a retryable error", async () => {
    const id = await seedClaim("held");
    await rawQuery(
      `UPDATE claims SET steward_state = 'running', stewarded_at = now() WHERE id = $1`,
      [id]
    );
    const err = await acquireStewardLock(id, { waitMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(StewardBusyError);
    expect(isTransientApiError(err)).toBe(true);
  });

  it("waits for the holder to finish, then runs and puts the claim back as found", async () => {
    const id = await seedClaim("waits");
    await rawQuery(
      `UPDATE claims SET steward_state = 'running', stewarded_at = now() WHERE id = $1`,
      [id]
    );
    const waiting = acquireStewardLock(id, { waitMs: 5_000, pollMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
    const restore = await waiting;
    expect(restore).toBe("done");
    expect((await stewardRow(id)).steward_state).toBe("running");

    await releaseStewardLock(id, restore);
    expect((await stewardRow(id)).steward_state).toBe("done");
  });

  it("takes a dead run's claim and leaves its pass owed", async () => {
    const id = await seedClaim("dead-holder");
    await rawQuery(
      `UPDATE claims SET steward_state = 'running',
              stewarded_at = now() - interval '16 minutes' WHERE id = $1`,
      [id]
    );
    const restore = await acquireStewardLock(id, { waitMs: 0 });
    expect(restore).toBe("pending");
  });
});

describe("the lease", () => {
  it("heartbeats while the run is live, so a long run is never taken as dead", async () => {
    const id = await seedClaim("heartbeat");
    await rawQuery(
      `UPDATE claims SET steward_state = 'running',
              stewarded_at = now() - interval '14 minutes' WHERE id = $1`,
      [id]
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let beat!: () => void;
      const done = new Promise<void>((r) => (beat = r));
      const run = withStewardLease({ claimId: id }, () => done);
      vi.advanceTimersByTime(60_000);
      // Let the heartbeat's UPDATE land.
      for (let i = 0; i < 50; i++) {
        const row = await stewardRow(id);
        if (Date.now() - row.stewarded_at!.getTime() < 60_000) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const row = await stewardRow(id);
      expect(Date.now() - row.stewarded_at!.getTime()).toBeLessThan(60_000);
      beat();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("on shutdown, hands the claim and its action back for the next task", async () => {
    const id = await seedClaim("abandoned");
    await rawQuery(
      `UPDATE claims SET steward_state = 'running', stewarded_at = now() WHERE id = $1`,
      [id]
    );
    const actionId = await seedAction({
      group: `assess:${id}`,
      costMicroUsd: 1_000_000,
      claimId: id,
      status: "running",
    });

    let finish!: () => void;
    const run = withStewardLease({ claimId: id, actionId }, () => new Promise<void>((r) => (finish = r)));
    expect(heldStewardLeaseCount()).toBe(1);

    expect(await abandonStewardLeases()).toBe(1);
    const row = await stewardRow(id);
    expect(row.steward_state).toBe("running");
    expect(Date.now() - row.stewarded_at!.getTime()).toBeGreaterThan(15 * 60_000);
    const [action] = await rawQuery<{ status: string }>(
      `SELECT status FROM actions WHERE id = $1`,
      [actionId]
    );
    expect(action!.status).toBe("open");

    finish();
    await run;
    expect(heldStewardLeaseCount()).toBe(0);
  });
});
