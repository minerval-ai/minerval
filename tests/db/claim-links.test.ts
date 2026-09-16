/**
 * Lateral links (#436) against real Postgres: canonical pair ordering, the
 * reverse-direction duplicate the unique index must catch, the kind and
 * self-link checks, the symmetric read, and how a merge carries links onto
 * the survivor and a reversal puts them back.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, pgCode } from "./helpers.js";
import {
  linkClaims,
  listRelatedClaims,
  orderPair,
  unlinkClaims,
} from "../../src/services/claim-link-service.js";
import {
  linkClaims as curatorLink,
  unlinkClaims as curatorUnlink,
  mergeClaims,
  reverseReconciliation,
} from "../../src/services/reconciliation-service.js";

const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

async function linkIds(claimId: string): Promise<string[]> {
  return (await listRelatedClaims(claimId)).map((r) => r.id);
}

describe("claim_links (#436)", () => {
  it("stores one row per pair whichever side writes it, and reads from both", async () => {
    const x = await seedClaim("x");
    const y = await seedClaim("y");
    const first = await linkClaims({
      claimId: y,
      otherClaimId: x,
      kind: "rival_explanation",
      reasoning: "competing accounts",
      createdBy: "dbtest",
    });
    expect(first.created).toBe(true);
    // The same link from the other side is the same row.
    const again = await linkClaims({
      claimId: x,
      otherClaimId: y,
      kind: "rival_explanation",
      reasoning: "competing accounts, again",
      createdBy: "dbtest",
    });
    expect(again).toEqual({ id: first.id, created: false });
    const [row] = await rawQuery<{ claim_a_id: string; claim_b_id: string }>(
      `SELECT claim_a_id, claim_b_id FROM claim_links WHERE id = $1`,
      [first.id]
    );
    expect([row!.claim_a_id, row!.claim_b_id]).toEqual(orderPair(x, y));

    expect(await linkIds(x)).toEqual([y]);
    expect(await linkIds(y)).toEqual([x]);
    const [fromX] = await listRelatedClaims(x);
    expect(fromX).toMatchObject({ kind: "rival_explanation", reasoning: "competing accounts" });

    // A different kind between the same pair is a second row.
    const other = await linkClaims({
      claimId: x,
      otherClaimId: y,
      kind: "related",
      reasoning: "also related",
      createdBy: "dbtest",
    });
    expect(other.created).toBe(true);
    expect(await linkIds(x)).toEqual([y, y]);

    const removed = await unlinkClaims({ claimId: y, otherClaimId: x });
    expect(removed).toHaveLength(2);
    expect(await linkIds(x)).toEqual([]);
  });

  it("rejects self-links, unknown kinds, and missing claims at the database", async () => {
    const x = await seedClaim("x");
    const y = await seedClaim("y");
    await expect(
      linkClaims({ claimId: x, otherClaimId: x, kind: "related", reasoning: "", createdBy: "t" })
    ).rejects.toThrow(/itself/);
    // Straight to SQL, bypassing the service's ordering: the checks hold.
    await expect(
      rawQuery(
        `INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning) VALUES ($1, $1, 'related', '')`,
        [x]
      )
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    const [a, b] = orderPair(x, y);
    await expect(
      rawQuery(
        `INSERT INTO claim_links (claim_a_id, claim_b_id, kind, reasoning) VALUES ($1, $2, 'premise', '')`,
        [a, b]
      )
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      linkClaims({
        claimId: x,
        otherClaimId: randomUUID(),
        kind: "related",
        reasoning: "",
        createdBy: "t",
      })
    ).rejects.toMatchObject({ code: FK_VIOLATION });
    expect(pgCode).toBeDefined();
  });

  it("leaves merged and deprecated counterparts out of the read", async () => {
    const x = await seedClaim("x");
    const y = await seedClaim("y");
    await linkClaims({ claimId: x, otherClaimId: y, kind: "related", reasoning: "", createdBy: "t" });
    await rawQuery(`UPDATE claims SET state = 'deprecated' WHERE id = $1`, [y]);
    expect(await linkIds(x)).toEqual([]);
  });

  it("moves links onto the survivor in a merge and restores them on reversal", async () => {
    const S = await seedClaim("S");
    const L = await seedClaim("L");
    const A = await seedClaim("A");
    const B = await seedClaim("B");
    // L <-> A (moves to S <-> A), L <-> B where S <-> B already exists (drops
    // as a duplicate), and L <-> S itself (drops as a self-link).
    await linkClaims({ claimId: L, otherClaimId: A, kind: "related", reasoning: "la", createdBy: "t" });
    await linkClaims({ claimId: L, otherClaimId: B, kind: "related", reasoning: "lb", createdBy: "t" });
    const sb = await linkClaims({ claimId: S, otherClaimId: B, kind: "related", reasoning: "sb", createdBy: "t" });
    await linkClaims({ claimId: L, otherClaimId: S, kind: "counterpart_position", reasoning: "ls", createdBy: "t" });

    const { eventId } = await mergeClaims({
      survivorId: S,
      loserId: L,
      stanceRelation: "same",
      reasoning: "dbtest",
    });
    expect((await linkIds(S)).sort()).toEqual([A, B].sort());
    expect(await rawQuery(`SELECT 1 FROM claim_links WHERE claim_a_id = $1 OR claim_b_id = $1`, [L])).toEqual([]);
    const [sbRow] = await rawQuery<{ reasoning: string }>(`SELECT reasoning FROM claim_links WHERE id = $1`, [sb.id]);
    expect(sbRow!.reasoning).toBe("sb"); // the survivor's own link was untouched

    expect((await reverseReconciliation(eventId!)).reversed).toBe(true);
    // The merge's S <-> A is gone; S keeps its own S <-> B and, with L active
    // again, the restored L <-> S. L's links read back: A, B, and S.
    expect((await linkIds(S)).sort()).toEqual([B, L].sort());
    expect((await linkIds(L)).sort()).toEqual([A, B, S].sort());
  });

  it("logs the curator's link and unlink as reversible events", async () => {
    const x = await seedClaim("x");
    const y = await seedClaim("y");
    const linked = await curatorLink({
      claimId: x,
      otherClaimId: y,
      kind: "counterpart_position",
      reasoning: "two halves",
    });
    expect(linked.linked).toBe(true);
    expect(linked.eventId).toBeDefined();
    // A repeat is reported, not re-logged.
    const repeat = await curatorLink({
      claimId: y,
      otherClaimId: x,
      kind: "counterpart_position",
      reasoning: "two halves",
    });
    expect(repeat).toEqual({ linked: false, linkId: linked.linkId });

    expect((await reverseReconciliation(linked.eventId!)).reversed).toBe(true);
    expect(await linkIds(x)).toEqual([]);

    await curatorLink({ claimId: x, otherClaimId: y, kind: "related", reasoning: "r" });
    const unlinked = await curatorUnlink({ claimId: x, otherClaimId: y, reasoning: "no" });
    expect(unlinked.removed).toBe(1);
    expect(await linkIds(x)).toEqual([]);
    expect((await reverseReconciliation(unlinked.eventId!)).reversed).toBe(true);
    expect(await linkIds(x)).toEqual([y]);
  });
});
