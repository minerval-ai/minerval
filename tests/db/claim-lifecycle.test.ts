/**
 * A node's lifecycle on record (#962), against real tables: every path that
 * changes `claims.state` leaves a claim_state_changes row with who, why and
 * the successors; the node's history, the changes stream, the `changes` view
 * and get_claim show it; a plan item for a retired node is refused with the
 * reason and the successors; nothing is delivered to a retired node's inbox,
 * and what is addressed to one with a live successor goes there; the inbox
 * clean-up script closes what sat on retired nodes before; and migration
 * 0134's backfill gives each live merge its record.
 *
 * The scratch DB is shared across files, so every assertion is about the
 * rows seeded here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import {
  activeSuccessors,
  changeClaimsState,
  getRetirement,
  listStateChanges,
  retiredNodeRefusal,
} from "../../src/services/claim-lifecycle-service.js";
import { mergeClaims, reverseReconciliation } from "../../src/services/reconciliation-service.js";
import { getClaimEvents } from "../../src/services/claim-events-service.js";
import { listGraphChanges } from "../../src/services/graph-change-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { postMessage } from "../../src/services/inbox-service.js";
import { materializePlanItems } from "../../src/services/action-service.js";
import { closeRetiredInboxes } from "../../scripts/close-retired-inboxes.js";

async function archive(ids: string[], successors?: Record<string, string[]>) {
  return changeClaimsState({
    ids,
    fromState: "active",
    toState: "archived",
    actor: "operator:dbtest",
    reason: "retired with a dbtest cohort",
    cohort: "dbtest-cohort",
    successors,
  });
}

async function unread(nodeId: string) {
  return rawQuery<{ trigger: string; body: string }>(
    `SELECT trigger, body FROM node_messages WHERE node_id = $1 AND read_at IS NULL ORDER BY created_at`,
    [nodeId]
  );
}

async function claimRow(id: string) {
  const [row] = await rawQuery<{ id: string; text: string; created_by: string; created_at: Date; state: string }>(
    `SELECT id, text, created_by, created_at, state FROM claims WHERE id = $1`,
    [id]
  );
  return row!;
}

describe("the record of an archive and a restore", () => {
  it("moves only nodes in the from-state, each with its record, and a restore records itself", async () => {
    const a = await seedClaim("archive a");
    const b = await seedClaim("archive b");
    const part = await seedClaim("a split part of b");
    const merged = await seedClaim("already merged");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [merged]);

    const moved = await archive([a, b, merged], { [b]: [part] });
    expect(moved.sort()).toEqual([a, b].sort());
    expect((await claimRow(merged)).state).toBe("merged");
    expect(await listStateChanges(merged)).toEqual([]);

    const [rec] = await listStateChanges(b);
    expect(rec).toMatchObject({
      from_state: "active",
      to_state: "archived",
      actor: "operator:dbtest",
      reason: "retired with a dbtest cohort",
      cohort: "dbtest-cohort",
      successor_ids: [part],
    });
    expect((await listStateChanges(a))[0]!.successor_ids).toEqual([]);

    const restored = await changeClaimsState({
      ids: [a],
      fromState: "archived",
      toState: "active",
      actor: "operator:dbtest",
      reason: "archived by mistake",
    });
    expect(restored).toEqual([a]);
    expect((await claimRow(a)).state).toBe("active");
    expect((await listStateChanges(a)).map((s) => `${s.from_state}>${s.to_state}`)).toEqual(["active>archived", "archived>active"]);
  });

  it("records an archive made before records were kept, once, dated when it happened, without moving anything", async () => {
    const old = await seedClaim("archived by a bare update");
    const recorded = await seedClaim("archived with a record");
    const live = await seedClaim("still live");
    await rawQuery(`UPDATE claims SET state = 'archived' WHERE id = $1`, [old]);
    await archive([recorded]);
    const at = new Date("2026-10-29T22:07:53.917Z");

    const opts = {
      ids: [old, recorded, live],
      fromState: "active",
      toState: "archived",
      actor: "operator:dbtest",
      reason: "the Oct 29 cohort",
      cohort: "dbtest-backfill",
      recordOnly: true,
      at,
    };
    expect(await changeClaimsState(opts)).toEqual([old]);
    expect(await changeClaimsState(opts)).toEqual([]);
    expect((await claimRow(live)).state).toBe("active");
    const [rec] = await listStateChanges(old);
    expect(new Date(rec!.created_at).toISOString()).toBe(at.toISOString());
    expect(rec!.cohort).toBe("dbtest-backfill");
  });

  it("shows in the node's history, the changes stream and the changes view", async () => {
    const node = await seedClaim("visible archive");
    const since = new Date(Date.now() - 1000).toISOString();
    await archive([node]);

    const { events } = await getClaimEvents(await claimRow(node).then((c) => ({ id: c.id, createdBy: c.created_by, createdAt: c.created_at })));
    const change = events.find((e) => e.kind === "state_change");
    expect(change).toMatchObject({
      kind: "state_change",
      actor: "operator:dbtest",
      from_state: "active",
      to_state: "archived",
      reason: "retired with a dbtest cohort",
      cohort: "dbtest-cohort",
    });

    expect((await listGraphChanges({ since, scope: { under: [node] } })).changes).toEqual([]);
    const page = await listGraphChanges({ since, scope: { under: [node] }, kinds: ["state_changed"] });
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]!.summary).toBe("active -> archived by operator:dbtest: retired with a dbtest cohort");

    const view = await rawQuery<{ kind: string; summary: string }>(
      `SELECT kind, summary FROM public_read.changes WHERE node_id = $1`,
      [node]
    );
    expect(view).toEqual([{ kind: "state_changed", summary: "active -> archived by operator:dbtest: retired with a dbtest cohort" }]);
  });
});

describe("the Curator's surgery on record", () => {
  it("records a merge on the absorbed node, naming the survivor, and its reversal", async () => {
    const survivor = await seedClaim("merge survivor");
    const loser = await seedClaim("merge loser");
    const { eventId } = await mergeClaims({ survivorId: survivor, loserId: loser, stanceRelation: "same", reasoning: "dbtest: same proposition" });

    const [rec] = await listStateChanges(loser);
    expect(rec).toMatchObject({
      from_state: "active",
      to_state: "merged",
      actor: "curator",
      reason: "dbtest: same proposition",
      successor_ids: [survivor],
      reconciliation_event_id: eventId,
    });

    expect((await reverseReconciliation(eventId!, { reasoning: "dbtest: they differ" })).reversed).toBe(true);
    const changes = await listStateChanges(loser);
    expect(changes.map((s) => `${s.from_state}>${s.to_state}`)).toEqual(["active>merged", "merged>active"]);
    expect(changes[1]!.reason).toBe("dbtest: they differ");
  });

  it("is backfilled for live merges by migration 0134, and only for those", async () => {
    const survivor = await seedClaim("backfill survivor");
    const loser = await seedClaim("backfill loser");
    const unmerged = await seedClaim("reversed loser");
    await rawQuery(`UPDATE claims SET state = 'merged', merged_into = $1 WHERE id = $2`, [survivor, loser]);
    await rawQuery(
      `INSERT INTO reconciliation_events (operation, reasoning, payload, created_at) VALUES
         ('merge', 'dbtest: backfilled merge', $1::jsonb, now() - interval '1 day'),
         ('merge', 'dbtest: reversed merge', $2::jsonb, now() - interval '1 day')`,
      [
        JSON.stringify({ survivor_id: survivor, loser_id: loser, loser_prev_state: "active" }),
        JSON.stringify({ survivor_id: survivor, loser_id: unmerged }),
      ]
    );
    const statements = readFileSync(
      fileURLToPath(new URL("../../src/db/migrations/0134_claim_state_changes.sql", import.meta.url)),
      "utf8"
    ).split("--> statement-breakpoint");
    const backfill = statements.find((s) => s.includes('INSERT INTO "claim_state_changes"'))!;
    await rawQuery(backfill);

    const [rec] = await listStateChanges(loser);
    expect(rec).toMatchObject({ from_state: "active", to_state: "merged", actor: "curator", reason: "dbtest: backfilled merge", successor_ids: [survivor] });
    expect(await listStateChanges(unmerged)).toEqual([]);
  });
});

describe("a retired node to a reader and a writer", () => {
  it("get_claim says when, by whom and why, and names the successors with their state", async () => {
    const node = await seedClaim("retired with a successor");
    const part = await seedClaim("its successor");
    await archive([node], { [node]: [part] });
    const view = await getClaimView(node);
    expect(view!.retired).toMatchObject({
      state: "archived",
      recorded: true,
      by: "operator:dbtest",
      reason: "retired with a dbtest cohort",
      cohort: "dbtest-cohort",
      successors: [{ id: part, state: "active" }],
    });

    const bare = await seedClaim("retired before records");
    await rawQuery(`UPDATE claims SET state = 'archived' WHERE id = $1`, [bare]);
    expect(await getRetirement(bare)).toMatchObject({ state: "archived", recorded: false, at: null, reason: null, successors: [] });

    const live = await seedClaim("live");
    expect((await getClaimView(live))!.retired).toBeUndefined();
  });

  it("refuses a plan item on a retired node with its reason and its successors", async () => {
    const funder = await seedUser("lifecycle funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL });
    const node = await seedClaim("plan target, retired");
    const part = await seedClaim("plan target's successor");
    const orphan = await seedClaim("plan target, retired alone");
    await archive([node], { [node]: [part] });
    await archive([orphan]);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({
        strategy: "dbtest",
        items: [
          { action: "reassess", claim_id: node, rationale: "look again" },
          { action: "reassess", claim_id: orphan, rationale: "look again" },
        ],
      }),
    ]);
    const [first, second] = await materializePlanItems(grantId);
    expect(first!.ledger.status).toBe("blocked");
    expect(first!.ledger.reason).toContain("is archived, not active");
    expect(first!.ledger.reason).toContain("by operator:dbtest: retired with a dbtest cohort");
    expect(first!.ledger.reason).toContain(`Its successor: ${part}`);
    expect(second!.ledger.reason).toContain("It has no active successor");
    expect(await retiredNodeRefusal(part)).toBeNull();
  });
});

describe("messages to a retired node", () => {
  it("are not kept on it, and go to its live successor instead", async () => {
    const parent = await seedClaim("retired parent");
    const successor = await seedClaim("parent's successor");
    const orphan = await seedClaim("retired parent with no successor");
    await archive([parent], { [parent]: [successor] });
    await archive([orphan]);

    expect(await postMessage({ nodeId: parent, trigger: "subclaim_change", body: "direct" })).toBeNull();
    await enqueueSteward({ claimId: parent, trigger: "subclaim_change", context: "Subclaim X changed" });
    await enqueueSteward({ claimId: parent, trigger: "structure_and_assess", context: "first pass" });
    await enqueueSteward({ claimId: orphan, trigger: "subclaim_change", context: "Subclaim Y changed" });

    expect(await unread(parent)).toEqual([]);
    expect(await unread(orphan)).toEqual([]);
    const forwarded = await unread(successor);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.trigger).toBe("subclaim_change");
    expect(forwarded[0]!.body).toContain(`Addressed to ${parent}`);
    expect(forwarded[0]!.body).toContain("Subclaim X changed");
    const [row] = await rawQuery<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [successor]);
    expect(row!.steward_state).toBe("pending");
  });

  it("go to a merged node's survivor", async () => {
    const survivor = await seedClaim("message survivor");
    const loser = await seedClaim("message loser");
    await mergeClaims({ survivorId: survivor, loserId: loser, stanceRelation: "same", reasoning: "dbtest" });
    expect(await activeSuccessors(loser)).toEqual([survivor]);
    await enqueueSteward({ claimId: loser, trigger: "steward_note", context: "a note for the loser" });
    expect(await unread(loser)).toEqual([]);
    expect((await unread(survivor)).map((m) => m.body).join(" ")).toContain("a note for the loser");
  });

  it("left from before are closed by the clean-up script, and forwarded where asked", async () => {
    const stale = await seedClaim("stale inbox");
    const successor = await seedClaim("stale inbox's successor");
    const live = await seedClaim("live inbox");
    for (const id of [stale, live]) {
      await rawQuery(
        `INSERT INTO node_messages (node_id, trigger, sender_kind, body) VALUES
           ($1, 'subclaim_change', 'system', 'carried over'), ($1, 'structure_and_assess', 'system', 'first pass')`,
        [id]
      );
    }
    await archive([stale], { [stale]: [successor] });

    const dry = await closeRetiredInboxes({ confirm: false, forward: true });
    const mine = dry.unread.filter((m) => m.node_id === stale);
    expect(mine).toHaveLength(2);
    expect(dry.unread.some((m) => m.node_id === live)).toBe(false);
    expect(dry.closed).toBe(0);
    expect(await unread(stale)).toHaveLength(2);

    const done = await closeRetiredInboxes({ confirm: true, forward: true });
    expect(done.closed).toBeGreaterThanOrEqual(2);
    expect(await unread(stale)).toEqual([]);
    expect(await unread(live)).toHaveLength(2);
    const notes = await rawQuery<{ trigger: string; outcome: string | null; outcome_note: string }>(
      `SELECT trigger, outcome, outcome_note FROM node_messages WHERE node_id = $1 ORDER BY trigger`,
      [stale]
    );
    expect(notes).toEqual([
      { trigger: "structure_and_assess", outcome: null, outcome_note: "Not weighed: the node is archived, so no Steward works it (#962)." },
      {
        trigger: "subclaim_change",
        outcome: null,
        outcome_note: "Not weighed: the node is archived, so no Steward works it (#962). Forwarded to its successor.",
      },
    ]);
    const forwarded = await unread(successor);
    expect(forwarded.map((m) => m.trigger)).toEqual(["subclaim_change"]);
    expect(forwarded[0]!.body).toContain("carried over");
  });
});
