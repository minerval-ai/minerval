/**
 * Migration 0112 (#848): statuses migration 0066 relabeled (#524) and no
 * Steward has re-judged carry the retired label in assessments.relabeled_from.
 * The global setup applied the whole chain to an empty database, so this file
 * seeds rows in the retired vocabulary, runs 0066 and then 0112's backfill
 * again, and checks: both relabels are backfilled, current and historical
 * rows alike; a row whose trace only quotes the note is not; the claim view
 * and public_read carry the field; and a Steward's re-judgment writes a
 * current row without it.
 *
 * The scratch DB is shared across files, so every assertion is about the
 * rows seeded here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rawQuery } from "../../src/db/client.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";

function statements(file: string): string[] {
  return readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${file}`, import.meta.url)), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigrations(): Promise<void> {
  for (const sql of statements("0066_evidential_status_ladder.sql")) await rawQuery(sql);
  // The column already exists (the chain ran in global setup); the rest of
  // 0112 is the backfill and the view, both safe to run again.
  for (const sql of statements("0112_assessment_relabeled_from.sql")) {
    await rawQuery(sql.replace('ADD COLUMN "relabeled_from"', 'ADD COLUMN IF NOT EXISTS "relabeled_from"'));
  }
}

async function claim(label: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claims (text, state, steward_state) VALUES ($1, 'active', 'done') RETURNING id`,
    [`relabeled_from ${label} ${Math.random()}`]
  );
  return row!.id;
}

async function assess(
  claimId: string,
  status: string,
  current = true,
  trace = "original trace",
  agoMinutes = 0
): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, $2, 0.7, $3, $4, now() - make_interval(mins => $5)) RETURNING id`,
    [claimId, status, trace, current, agoMinutes]
  );
  return row!.id;
}

async function relabeledFrom(id: string): Promise<string | null> {
  const [row] = await rawQuery<{ relabeled_from: string | null }>(
    `SELECT relabeled_from FROM assessments WHERE id = $1`,
    [id]
  );
  return row!.relabeled_from;
}

describe("migration 0112: relabeled_from (#848)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids.contested = await claim("contested");
    ids.contestedCur = await assess(ids.contested, "contested");
    ids.unsupported = await claim("unsupported");
    ids.unsupportedCur = await assess(ids.unsupported, "unsupported");
    // Relabeled only in history; the current verdict is a later judgment.
    ids.history = await claim("history");
    ids.historyOld = await assess(ids.history, "contested", false, "original trace", 60);
    ids.historyCur = await assess(ids.history, "supported");
    // A judgment on the new ladder whose trace quotes 0066's note mid-text.
    ids.quoting = await claim("quoting");
    ids.quotingCur = await assess(
      ids.quoting,
      "inconclusive",
      true,
      "The prior row read [Status relabeled from contested to inconclusive by migration 0066 (#524), " +
        "when the contested status was retired.] I re-weighed it and it stays inconclusive."
    );
    ids.fresh = await claim("fresh");
    ids.freshCur = await assess(ids.fresh, "doubtful");

    await runMigrations();
  });

  it("backfills both retired labels, on current and historical rows", async () => {
    expect(await relabeledFrom(ids.contestedCur)).toBe("contested");
    expect(await relabeledFrom(ids.unsupportedCur)).toBe("unsupported");
    expect(await relabeledFrom(ids.historyOld)).toBe("contested");
  });

  it("leaves rows 0066 did not relabel null, including a trace that only quotes the note", async () => {
    expect(await relabeledFrom(ids.historyCur)).toBeNull();
    expect(await relabeledFrom(ids.quotingCur)).toBeNull();
    expect(await relabeledFrom(ids.freshCur)).toBeNull();
  });

  it("is served by the claim view and by public_read.assessments", async () => {
    const view = (await getClaimView(ids.unsupported)) as { assessment: { status: string; relabeled_from: string | null } };
    expect(view.assessment.status).toBe("unknown");
    expect(view.assessment.relabeled_from).toBe("unsupported");
    const fresh = (await getClaimView(ids.fresh)) as { assessment: { relabeled_from: string | null } };
    expect(fresh.assessment.relabeled_from).toBeNull();

    const rows = await rawQuery<{ node_id: string; relabeled_from: string | null }>(
      `SELECT node_id, relabeled_from FROM public_read.assessments WHERE node_id = ANY($1::uuid[]) AND is_current`,
      [[ids.contested, ids.fresh]]
    );
    expect(Object.fromEntries(rows.map((r) => [r.node_id, r.relabeled_from]))).toEqual({
      [ids.contested]: "contested",
      [ids.fresh]: null,
    });
  });

  it("clears once a Steward re-judges the node, and keeps the history honest", async () => {
    const out = JSON.parse(
      await executeStewardTool("update_claim_assessment", {
        claim_id: ids.contested,
        status: "supported",
        confidence: 0.75,
        assessment: "Re-judged on the evidence.",
        reasoning_trace: "Re-weighed every argument.",
      })
    );
    expect(out.success).toBe(true);
    const rows = await rawQuery<{ id: string; status: string; is_current: boolean; relabeled_from: string | null }>(
      `SELECT id, status, is_current, relabeled_from FROM assessments WHERE claim_id = $1`,
      [ids.contested]
    );
    const current = rows.filter((r) => r.is_current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ status: "supported", relabeled_from: null });
    expect(rows.find((r) => r.id === ids.contestedCur)).toMatchObject({ is_current: false, relabeled_from: "contested" });
    const view = (await getClaimView(ids.contested)) as { assessment: { relabeled_from: string | null } };
    expect(view.assessment.relabeled_from).toBeNull();
  });
});
