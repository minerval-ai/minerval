/**
 * Migration 0066 (#524), the data half: `contested` and `unsupported` leave
 * the status ladder. The global setup already applied the migration to an
 * empty database, so this file seeds rows in the retired vocabulary, runs
 * the migration's SQL again, and checks what it did: the provisional
 * relabel (contested to inconclusive, unsupported to unknown) on current and
 * historical rows alike, the original label kept in the reasoning trace, and
 * a fresh Steward pass queued through the same columns enqueueSteward writes
 * for every active claim whose CURRENT verdict was relabeled.
 *
 * The scratch DB is shared across files, so every assertion is about the
 * rows seeded here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rawQuery } from "../../src/db/client.js";

const MIGRATION = fileURLToPath(
  new URL("../../src/db/migrations/0066_evidential_status_ladder.sql", import.meta.url)
);

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) await rawQuery(sql);
}

async function claim(
  label: string,
  over: { state?: string; stewardState?: string; requeued?: boolean; trigger?: string | null; context?: string | null } = {}
): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text, state, steward_state, steward_requeued, steward_trigger, steward_context)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      `status ladder ${label} ${Math.random()}`,
      over.state ?? "active",
      over.stewardState ?? "done",
      over.requeued ?? false,
      over.trigger ?? null,
      over.context ?? null,
    ]
  );
  return row!.id;
}

async function assess(claimId: string, status: string, current = true, agoMinutes = 0): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, 0.7, 'original trace', $3, now() - make_interval(mins => $4)) RETURNING id`,
    [claimId, status, current, agoMinutes]
  );
  return row!.id;
}

async function assessment(id: string) {
  const [row] = await rawQuery<{ status: string; reasoning_trace: string }>(
    `SELECT status, reasoning_trace FROM assessments WHERE id = $1`,
    [id]
  );
  return row!;
}

async function queue(id: string) {
  const [row] = await rawQuery<{
    steward_state: string; steward_requeued: boolean; steward_trigger: string | null; steward_context: string | null;
  }>(
    `SELECT steward_state, steward_requeued, steward_trigger, steward_context FROM claims WHERE id = $1`,
    [id]
  );
  return row!;
}

describe("migration 0066: the evidential status ladder (#524)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // A done claim whose current verdict is contested, over a historical supported one.
    ids.contested = await claim("contested");
    ids.contestedOld = await assess(ids.contested, "supported", false, 60);
    ids.contestedCur = await assess(ids.contested, "contested");
    // A claim mid-run whose current verdict is unsupported.
    ids.running = await claim("running", { stewardState: "running" });
    ids.runningCur = await assess(ids.running, "unsupported");
    // A claim already queued for its first pass, with context of its own.
    ids.pending = await claim("pending", { stewardState: "pending", trigger: "structure_and_assess", context: "[structure_and_assess] earlier" });
    ids.pendingCur = await assess(ids.pending, "contested");
    // Contested only in history; the current verdict is untouched.
    ids.history = await claim("history");
    ids.historyOld = await assess(ids.history, "contested", false, 60);
    ids.historyCur = await assess(ids.history, "verified");
    // An inactive claim: relabeled, never queued.
    ids.inactive = await claim("inactive", { state: "deprecated" });
    ids.inactiveCur = await assess(ids.inactive, "unsupported");
    // Already on the new ladder: nothing to do.
    ids.fresh = await claim("fresh");
    ids.freshCur = await assess(ids.fresh, "doubtful");

    await runMigration();
  });

  it("relabels contested as inconclusive and unsupported as unknown, current and historical", async () => {
    expect((await assessment(ids.contestedCur)).status).toBe("inconclusive");
    expect((await assessment(ids.runningCur)).status).toBe("unknown");
    expect((await assessment(ids.pendingCur)).status).toBe("inconclusive");
    expect((await assessment(ids.historyOld)).status).toBe("inconclusive");
    expect((await assessment(ids.inactiveCur)).status).toBe("unknown");
    // Untouched rows keep their status and trace.
    expect(await assessment(ids.contestedOld)).toEqual({ status: "supported", reasoning_trace: "original trace" });
    expect(await assessment(ids.historyCur)).toEqual({ status: "verified", reasoning_trace: "original trace" });
    expect(await assessment(ids.freshCur)).toEqual({ status: "doubtful", reasoning_trace: "original trace" });
  });

  it("keeps the label each row was written under in its reasoning trace", async () => {
    const a = await assessment(ids.contestedCur);
    expect(a.reasoning_trace.startsWith("original trace")).toBe(true);
    expect(a.reasoning_trace).toContain("[Status relabeled from contested to inconclusive by migration 0066 (#524)");
    expect((await assessment(ids.runningCur)).reasoning_trace).toContain("relabeled from unsupported to unknown");
  });

  it("queues a done claim for a fresh pass with a context that names the change", async () => {
    const q = await queue(ids.contested);
    expect(q.steward_state).toBe("pending");
    expect(q.steward_requeued).toBe(false);
    expect(q.steward_trigger).toBe("staleness_check");
    expect(q.steward_context).toMatch(/^\[staleness_check\] Status vocabulary change \(#524\)/);
    expect(q.steward_context).toContain("recorded as contested");
    expect(q.steward_context).toContain("relabeled inconclusive provisionally");
  });

  it("leaves a running claim running, with a requeue waiting (#482)", async () => {
    const q = await queue(ids.running);
    expect(q.steward_state).toBe("running");
    expect(q.steward_requeued).toBe(true);
    expect(q.steward_context).toContain("recorded as unsupported");
    expect(q.steward_context).toContain("relabeled unknown provisionally");
  });

  it("coalesces into a pending slot: the first-pass trigger stays and the note is appended", async () => {
    const q = await queue(ids.pending);
    expect(q.steward_state).toBe("pending");
    expect(q.steward_trigger).toBe("structure_and_assess");
    expect(q.steward_context).toMatch(/^\[structure_and_assess\] earlier\n\n\[staleness_check\] Status vocabulary change/);
  });

  it("queues nothing for a claim whose current verdict was not relabeled, or that is inactive", async () => {
    expect((await queue(ids.history)).steward_state).toBe("done");
    expect((await queue(ids.fresh)).steward_state).toBe("done");
    expect((await queue(ids.inactive)).steward_state).toBe("done");
  });

  it("is a no-op when run again", async () => {
    const before = await Promise.all([queue(ids.contested), assessment(ids.contestedCur)]);
    await runMigration();
    const after = await Promise.all([queue(ids.contested), assessment(ids.contestedCur)]);
    expect(after).toEqual(before);
    const [{ n }] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM assessments WHERE status IN ('contested', 'unsupported')`
    );
    expect(n).toBe(0);
  });
});
